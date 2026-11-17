// Card engine tests that need no store data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCards, padToFour, sortCards, BLANK } from '../src/cards/build.ts';
import { loadCardConfig } from '../src/cards/config.ts';
import { readDocxParts } from '../src/cards/docx-zip.ts';
import { cardKey, mergeImports, parseCardsDocx, templateWarnings } from '../src/cards/import.ts';
import { acquireLock, parseBboxHtml, wordsByCard } from '../src/cards/render.ts';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countCopyLines } from '../src/cards/verify.ts';
import type { CardRecord } from '../src/cards/types.ts';

const cfg = loadCardConfig();

const card = (over: Partial<CardRecord>): CardRecord => ({
  code: '',
  price: '$9.99',
  unit: '500 GRAMS',
  origin: 'PRODUCT OF NOWHERE',
  eyebrow: '03 / PASTA',
  n1: 'Test ',
  n2: 'Shape',
  producer: 'Maker · Town',
  specs: [['DIE', 'Bronze'], ['CUT', 'Long'], ['COOK', '9 Min']],
  copy: ['First paragraph & more.', 'Second paragraph.'],
  ...over,
});

test('config loads with six rows and the copy row exact', () => {
  assert.equal(cfg.geometry.rowHeights.length, 6);
  assert.equal(cfg.geometry.rowHeights[1], 0);
  assert.equal(cfg.geometry.exactRow, 3);
  assert.equal(cfg.mark, 'C&C');
});

test('sort is eyebrow then name, in natural order', () => {
  const cards = [
    card({ eyebrow: '04 / PANTRY', n1: '', n2: 'Honey' }),
    card({ n1: 'Aged ', n2: '10 Year' }),
    card({ n1: 'Aged ', n2: '8 Year' }),
  ];
  assert.deepEqual(
    sortCards(cards).map((c) => c.n1 + c.n2),
    ['Aged 8 Year', 'Aged 10 Year', 'Honey'],
  );
});

test('pads to a multiple of four with blank slots', () => {
  assert.equal(padToFour([card({})]).length, 4);
  assert.equal(padToFour([card({}), card({}), card({}), card({})]).length, 4);
  assert.equal(padToFour([card({})])[3], BLANK);
});

test('build then import round trips, skipping blank slots', async () => {
  const cards = [card({ n1: '', n2: 'Solo', code: '7001', unit: 'PER POUND' }), card({ copy: ['One paragraph only.'] })];
  const out = await buildCards(cards, cfg);
  assert.equal(out.slots, 4);
  assert.equal(out.sheets, 1);
  const back = parseCardsDocx(out.buffer);
  assert.equal(back.slots.length, 4);
  assert.deepEqual(back.cards, sortCards(cards));
  const xml = readDocxParts(out.buffer).get('word/document.xml') ?? '';
  assert.match(xml, /<w:trHeight w:val="3134" w:hRule="exact"\/>/);
  assert.match(xml, /Real food, really good\./);
});

test('rejects newlines and the wrong number of specs', async () => {
  await assert.rejects(buildCards([card({ copy: ['a\nb'] })], cfg), /newlines/);
  await assert.rejects(buildCards([card({ specs: [['A', 'b'], ['C', 'd']] as unknown as CardRecord['specs'] })], cfg), /three specs/);
});

test('merge keeps the newest version and keeps different makers apart', async () => {
  const older = parseCardsDocx((await buildCards([card({ price: '$9.99' }), card({ producer: 'Other · Place' })], cfg)).buffer);
  const newer = parseCardsDocx((await buildCards([card({ price: '$10.99' })], cfg)).buffer);
  older.created = '2026-10-01T00:00:00Z';
  newer.created = '2026-10-02T00:00:00Z';
  const r = mergeImports([{ file: 'new.docx', parsed: newer }, { file: 'old.docx', parsed: older }]);
  assert.equal(r.cards.length, 2);
  assert.equal(r.duplicates.length, 1);
  const kept = r.cards.find((c) => c.producer === 'Maker · Town');
  assert.equal(kept?.price, '$10.99');
  assert.equal(kept?.source.file, 'new.docx');
  assert.equal(r.sharedNames.length, 1);
  assert.equal(cardKey(card({ code: '7002' })), 'code:7002');
});

// ---- Rendered-check helpers, with synthetic pdftotext output ----

const box = (x0: number, y0: number, h: number, text: string) =>
  `<word xMin="${x0}" yMin="${y0}" xMax="${x0 + 30}" yMax="${y0 + h}">${text}</word>`;
const page = (words: string[]) => `<doc><page width="612.000000" height="792.000000">${words.join('')}</page></doc>`;
const COPY_H = 21.84;
const MARK_H = 25.26;

test('bbox parsing decodes every XML entity', () => {
  const [p] = parseBboxHtml(page([box(37, 10, MARK_H, 'C&amp;C'), box(80, 10, 10, 'Cow&apos;s'), box(120, 10, 10, '&quot;a&lt;b&gt;&#39;&#x41;')]));
  assert.deepEqual(p.words.map((w) => w.text), ['C&C', "Cow's", '"a<b>\'A']);
});

test('copy lines with straight apostrophes and ampersands are counted', () => {
  const c = card({ copy: ["Cow's milk & honey,", "Joe's way & more."] });
  const html = page([
    box(37, 14, MARK_H, 'C&amp;C'),
    box(37, 60, 41, 'Test'), // name, another size
    box(37, 150, COPY_H, 'Cow&apos;s'), box(80, 150, COPY_H, 'milk'), box(120, 150, COPY_H, '&amp;'), box(140, 150, COPY_H, 'honey,'),
    box(37, 163.2, COPY_H, 'Joe&apos;s'), box(80, 163.2, COPY_H, 'way'),
    box(37, 176.4, COPY_H, '&amp;'), box(80, 176.4, COPY_H, 'more.'),
  ]);
  const [p] = parseBboxHtml(html);
  assert.equal(countCopyLines(c, wordsByCard(p, 307)[0]), 3);
});

test('a "C&C" inside the copy does not start a new card', () => {
  const html = page([
    box(37, 14, MARK_H, 'C&amp;C'),
    box(37, 200, COPY_H, 'C&amp;C'), // copy line starting with the mark text, at the left edge
    box(37, 330, COPY_H, 'C&amp;C'), // lower than the minimum pitch, still copy size
    box(37, 378.6, MARK_H, 'C&amp;C'), // the bottom card's header
    box(37, 450, COPY_H, 'bottom'),
  ]);
  const [p] = parseBboxHtml(html);
  const [top, , bottom] = wordsByCard(p, 307);
  assert.deepEqual(top.map((w) => w.y0), [14, 200, 330]);
  assert.deepEqual(bottom.map((w) => w.y0), [378.6, 450]);
});

test('import reads the mark and tagline and warns when they differ from the config', async () => {
  const parsed = parseCardsDocx((await buildCards([card({})], cfg)).buffer);
  assert.deepEqual(parsed.marks, ['C&C']);
  assert.deepEqual(parsed.taglines, [cfg.tagline]);
  assert.deepEqual(templateWarnings(parsed, cfg), []);
  const other = parseCardsDocx((await buildCards([card({})], { ...cfg, mark: 'X&Y', tagline: 'Another line.' })).buffer);
  assert.deepEqual(templateWarnings(other, cfg), [
    `mark is "X&Y", config has "C&C"`,
    `tagline is "Another line.", config has "${cfg.tagline}"`,
  ]);
  const merged = mergeImports([{ file: 'x.docx', parsed: other }]);
  assert.equal(merged.cards[0].source.mark, 'X&Y');
});

test('LibreOffice lock: one holder at a time, dead holders are cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-lock-'));
  const lock = join(dir, '.soffice.lock');
  try {
    writeFileSync(lock, '2147483646'); // a pid that is not running
    const release = await acquireLock(lock, 0);
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
    await assert.rejects(acquireLock(lock, 0, 10), /holds/);
    release();
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LibreOffice lock: an old lock is cleared even with a live or invalid pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-lock-'));
  const lock = join(dir, '.soffice.lock');
  try {
    for (const content of [String(process.ppid), 'not a pid', '']) {
      writeFileSync(lock, content);
      await assert.rejects(acquireLock(lock, 0, 10, 60_000), /holds/, `fresh lock "${content}" must hold`);
      const old = (Date.now() - 120_000) / 1000;
      utimesSync(lock, old, old);
      const release = await acquireLock(lock, 0, 10, 60_000);
      assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
      release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SIGTERM during a conversion kills the process group and removes the profile and lock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-sig-'));
  try {
    const pidFile = join(dir, 'child.pid');
    const script = join(dir, 'run.ts');
    const render = pathToFileURL(join(import.meta.dirname, '../src/cards/render.ts')).href;
    writeFileSync(
      script,
      `import { docxToPdf } from ${JSON.stringify(render)};\n` +
        `await docxToPdf('x.docx', ${JSON.stringify(dir)}, { workRoot: ${JSON.stringify(dir)}, ` +
        `command: ['sh', '-c', 'echo $$ > ${pidFile}; exec sleep 30'] });\n`,
    );
    const node = spawn(process.execPath, [script], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((r) => node.on('exit', (_code, sig) => r(sig)));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(50);
    const fakePid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(readdirSync(dir).some((f) => f.startsWith('.lo-profile-')), 'profile exists while running');
    node.kill('SIGTERM');
    assert.equal(await exited, 'SIGTERM');
    await sleep(100);
    assert.throws(() => process.kill(fakePid, 0), /ESRCH/, 'the converter process is gone');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('.lo-profile-') || f.startsWith('.soffice.lock')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
