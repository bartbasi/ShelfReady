import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildCards, sortCards } from '../src/cards/build.ts';
import { loadCardConfig } from '../src/cards/config.ts';
import { parseCardsDocx } from '../src/cards/import.ts';
import type { CardRecord } from '../src/cards/types.ts';
import { editCard } from '../src/copy/store.ts';
import type { ChangePreview } from '../src/runs/preview.ts';
import { judge, missingTools, renderSheetCheck, type SheetCheckFn, type SheetCheckOutcome } from '../src/runs/sheet-check.ts';
import { checkRendered, checkSheetPdf } from '../src/cards/verify.ts';
import { buildRunSheet } from '../src/runs/card-sheets.ts';
import { RunError } from '../src/runs/store.ts';
import type { PageWords } from '../src/cards/render.ts';
import { decide } from './runs-fixtures.ts';
import { get } from './server-helpers.ts';
import { approvedRun, pressSend, type SendApp } from './send-fixtures.ts';

// Shelf card sheets for a run (Phase 1 step 8). Most tests use a fake check, so they need no
// LibreOffice. The last test renders for real and skips, saying so, when LibreOffice, poppler or
// the real fonts are missing. Invented cards and items only. Sends go to FRONT alone, the test
// scale, which the default server config allows.

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const passing: SheetCheckFn = async (_docx, slots) => ({
  state: 'passed',
  result: { pages: slots.length / 4, expectedPages: slots.length / 4, pageCountOk: true, failures: [], mostCopyLines: 3, maxCopyLines: 10, missingFonts: [] },
  message: 'Every card is whole.',
});

function preview(s: SendApp, id = 1): ChangePreview {
  return JSON.parse((s.app.shelf.db.prepare('SELECT dry_run FROM runs WHERE id = ?').get(id) as { dry_run: string }).dry_run) as ChangePreview;
}

function sheetRows(s: SendApp): Array<{ id: number; kind: string; stored_name: string; sha256: string; file_name: string; check_state: string; cards: string }> {
  return s.app.shelf.db.prepare('SELECT id, kind, stored_name, sha256, file_name, check_state, cards FROM card_sheets ORDER BY id').all() as never;
}

function sheetDir(s: SendApp): string {
  return join(s.dir, 'data', 'card-sheets');
}

/** The cards in a stored sheet, read back from the file, blanks as null. */
function fileSlots(s: SendApp, storedName: string): Array<CardRecord | null> {
  return parseCardsDocx(readFileSync(join(sheetDir(s), storedName))).slots;
}

async function makeSheet(s: SendApp, check = true) {
  const res = await decide(s, s.mgr, '/runs/1/card-sheet');
  if (check) await s.app.shelf.sheetChecker.drain();
  return res;
}

test('the run sheet holds exactly the approved cards, sorted and padded to four, with the preview prices and codes', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  const p = preview(s);
  assert.equal(p.cards.cards.length, 3, 'gouda, crackers and salmon each have a card');

  const page = await get(s, '/runs/1', s.mgr.cookie);
  assert.match(page.body, /Make the card sheet \(3 cards\)/);
  assert.equal((await makeSheet(s)).statusCode, 303);
  const [row] = sheetRows(s);
  assert.ok(row);
  assert.equal(row.kind, 'run');
  assert.equal(row.check_state, 'passed');
  assert.match(row.file_name, /^cards-hilltop-provisions-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.docx$/);

  // The file: private, and its hash is the one stored.
  const path = join(sheetDir(s), row.stored_name);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(sheetDir(s)).mode & 0o777, 0o700);
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), row.sha256);

  // Exactly the approved records, in the builder's order, then one blank slot.
  const slots = fileSlots(s, row.stored_name);
  assert.equal(slots.length, 4);
  assert.equal(slots[3], null);
  const want = sortCards(p.cards.cards.map((c) => c.record));
  for (let i = 0; i < 3; i++) {
    const got = slots[i]!;
    assert.equal(got.n1 + got.n2, want[i]!.n1 + want[i]!.n2);
    assert.equal(got.eyebrow, want[i]!.eyebrow);
    assert.equal(got.price, want[i]!.price, 'the price comes from the preview');
    assert.equal(got.code, want[i]!.code, 'the code comes from the preview');
    assert.equal(got.unit, want[i]!.unit);
    assert.deepEqual(got.copy, want[i]!.copy);
  }
  // The preview prices are the ones going to Square: the gouda drops to $13.99 a pound, code 7101.
  const gouda = p.cards.cards.find((c) => c.variationId === 'V_GOUDA')!;
  assert.equal(gouda.record.price, '$13.99');
  assert.equal(gouda.record.code, '7101');
  assert.equal(p.square.find((x) => x.variationId === 'V_GOUDA')!.price!.toCents, 1399);

  const audit = s.app.shelf.db.prepare("SELECT username, details FROM audit_log WHERE action = 'cards.sheet.build'").get() as { username: string; details: string };
  assert.equal(audit.username, 'mgr');
  assert.equal(JSON.parse(audit.details).sha256, row.sha256);
  // A second run sheet is refused: the cards are settled.
  const again = await makeSheet(s, false);
  assert.equal(again.statusCode, 409);
  assert.equal(sheetRows(s).length, 1);
});

test('lines where nothing arrived and cards left out are not on the sheet', async (t) => {
  const s = await approvedRun({
    deps: { cardSheetCheck: passing },
    before: async (r, mgr) => {
      await decide(r, mgr, '/runs/1/lines/2/arrived', { arrived: 'none' });
      await decide(r, mgr, '/runs/1/cards/leave-out', { variationId: 'V_SALMON', leaveOut: '1' });
    },
  });
  t.after(() => s.close());
  const p = preview(s);
  assert.deepEqual(p.cards.cards.map((c) => c.variationId), ['V_GOUDA']);
  await makeSheet(s);
  const [row] = sheetRows(s);
  const slots = fileSlots(s, row!.stored_name);
  assert.equal(slots.filter(Boolean).length, 1);
  assert.equal(slots[0]!.code, '7101');
  assert.equal(slots.length, 4);
});

test('the download waits for Square, needs a signed-in user and this run, sends the docx and is audited', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  await makeSheet(s);
  const [row] = sheetRows(s);
  const url = `/runs/1/card-sheets/${row!.id}`;

  // Approved but not sent: the register does not have these prices yet.
  let res = await get(s, url, s.mgr.cookie);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /once Square has this invoice&#39;s prices|once Square has this invoice's prices/);
  assert.doesNotMatch(String(res.headers['content-type']), /wordprocessingml/);

  await pressSend(s, ['FRONT']);
  // Not signed in: sent to the sign in page, never the file.
  res = await s.app.inject({ method: 'GET', url });
  assert.notEqual(res.statusCode, 200);
  assert.doesNotMatch(String(res.headers['content-type'] ?? ''), /wordprocessingml/);
  // Another run's path: no such sheet.
  res = await get(s, `/runs/2/card-sheets/${row!.id}`, s.mgr.cookie);
  assert.equal(res.statusCode, 404);

  res = await get(s, url, s.mgr.cookie);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], DOCX);
  assert.equal(res.headers['content-disposition'], `attachment; filename="${row!.file_name}"`);
  assert.equal(createHash('sha256').update(res.rawPayload).digest('hex'), row!.sha256);
  const audit = s.app.shelf.db.prepare("SELECT username, run_id, details FROM audit_log WHERE action = 'cards.sheet.download'").all() as Array<{ username: string; run_id: number; details: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.username, 'mgr');
  assert.equal(audit[0]!.run_id, 1);
  assert.equal(JSON.parse(audit[0]!.details).sha256, row!.sha256);

  // The pages link the download and the send page, not the old next step lines.
  const page = await get(s, '/runs/1', s.mgr.cookie);
  assert.match(page.body, new RegExp(`href="${url}"`));
  assert.match(page.body, /href="\/runs\/1\/send"/);
  assert.doesNotMatch(page.body, /next step/);
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.match(dry.body, /href="\/runs\/1\/send"/);
  assert.match(dry.body, /id="sheet-h"/);
  assert.doesNotMatch(dry.body, /next step/);
  for (const body of [page.body, dry.body]) assert.doesNotMatch(body, /\sstyle=|<script(?![^>]*\ssrc="\/static\/js\/)/i);
});

test('a card that fails the check blocks the download, by name', async (t) => {
  // Fails the first real card on the sheet, as the real check words it.
  const failing: SheetCheckFn = async (_docx, slots) => {
    const first = slots.find(Boolean)!;
    const name = first.n1 + first.n2;
    const raw = {
      slots: slots.length,
      expectedPages: slots.length / 4,
      pages: slots.length / 4,
      pageCountOk: true,
      clipOk: false,
      copyLinesOk: false,
      fullTextOk: true,
      cards: [{ page: 1, slot: 1, name, tail: ['the', 'last', 'four', 'words'], missingTail: ['words'], shortWords: [], copyLines: 11, maxCopyLines: 10 }],
    } as ReturnType<typeof checkSheetPdf>;
    return judge(raw, []);
  };
  const s = await approvedRun({ deps: { cardSheetCheck: failing } });
  t.after(() => s.close());
  await makeSheet(s);
  await pressSend(s, ['FRONT']);
  const [row] = sheetRows(s);
  assert.equal(row!.check_state, 'failed');
  const name = fileSlots(s, row!.stored_name).find(Boolean)!;
  const cardName = name.n1 + name.n2;
  const res = await get(s, `/runs/1/card-sheets/${row!.id}`, s.mgr.cookie);
  assert.equal(res.statusCode, 409);
  assert.ok(res.body.includes(`The check failed for ${cardName}`), 'the refusal names the card');
  const page = await get(s, '/runs/1', s.mgr.cookie);
  assert.match(page.body, /Check failed/);
  assert.match(page.body, /The copy runs 11 lines\. The panel holds 10\./);
  assert.doesNotMatch(page.body, new RegExp(`href="/runs/1/card-sheets/${row!.id}"`));
  assert.equal(s.app.shelf.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'cards.sheet.download'").get()!.n, 0);
});

test('when LibreOffice is missing the sheet is offered with a warning', async (t) => {
  const missing: SheetCheckFn = async (): Promise<SheetCheckOutcome> => ({ state: 'unchecked', result: null, message: 'LibreOffice is not installed on this PC, so the sheet was not checked. Look over the printed pages before cutting.' });
  const s = await approvedRun({ deps: { cardSheetCheck: missing } });
  t.after(() => s.close());
  await makeSheet(s);
  await pressSend(s, ['FRONT']);
  const [row] = sheetRows(s);
  assert.equal(row!.check_state, 'unchecked');
  const page = await get(s, '/runs/1', s.mgr.cookie);
  assert.match(page.body, /LibreOffice is not installed on this PC/);
  assert.match(page.body, /Download anyway/);
  assert.match(page.body, /Check again/);
  const res = await get(s, `/runs/1/card-sheets/${row!.id}`, s.mgr.cookie);
  assert.equal(res.statusCode, 200);
  // Check again queues it once more.
  assert.equal((await decide(s, s.mgr, `/runs/1/card-sheets/${row!.id}/check`)).statusCode, 303);
  assert.equal(sheetRows(s)[0]!.check_state, 'queued');
});

test('a reprint builds the chosen cards with their text now; the run sheet refuses a card changed since approval', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  const p = preview(s);
  const salmonAt = p.cards.cards.findIndex((c) => c.variationId === 'V_SALMON');
  const goudaAt = p.cards.cards.findIndex((c) => c.variationId === 'V_GOUDA');
  const salmon = p.cards.cards[salmonAt]!;
  // Someone edits the salmon card after approval.
  editCard(s.app.shelf.db, { userId: null, username: 'test' }, salmon.cardId, salmon.version, { copy: ['A newer first paragraph.', 'A newer second paragraph.'] });

  const refused = await makeSheet(s, false);
  assert.equal(refused.statusCode, 409);
  assert.ok(refused.body.includes(`The card for ${salmon.title} changed after this invoice was approved`));
  assert.equal(sheetRows(s).length, 0);

  const res = await decide(s, s.mgr, '/runs/1/card-sheet/reprint', { [`card_${salmonAt}`]: '1', [`card_${goudaAt}`]: '1', card_99: '1' });
  assert.equal(res.statusCode, 303);
  await s.app.shelf.sheetChecker.drain();
  const [row] = sheetRows(s);
  assert.equal(row!.kind, 'reprint');
  assert.match(row!.file_name, /-reprint-1\.docx$/);
  const slots = fileSlots(s, row!.stored_name);
  const cards = slots.filter(Boolean) as CardRecord[];
  assert.equal(cards.length, 2, 'only the chosen cards');
  const salmonCard = cards.find((c) => c.code === salmon.record.code)!;
  assert.deepEqual(salmonCard.copy, ['A newer first paragraph.', 'A newer second paragraph.']);
  assert.equal(salmonCard.price, salmon.record.price, 'the price is the one this invoice sent');
  assert.equal(cards.find((c) => c.code === '7101')!.price, '$13.99');
  assert.deepEqual(JSON.parse(row!.cards).map((c: { variationId: string }) => c.variationId).sort(), ['V_GOUDA', 'V_SALMON']);

  // Nothing picked: refused.
  assert.equal((await decide(s, s.mgr, '/runs/1/card-sheet/reprint', {})).statusCode, 400);
});

test('a product a later invoice changed is not printed from the older one', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  const p = preview(s);
  const later: ChangePreview = { ...p, runId: 2, cards: { cards: p.cards.cards.filter((c) => c.variationId === 'V_GOUDA'), leftOut: [] } };
  const user = s.app.shelf.db.prepare("SELECT id FROM users WHERE username = 'mgr'").get() as { id: number };
  s.app.shelf.db.prepare("INSERT INTO runs (state, created_by, created_by_name, created_at, updated_at, dry_run, dry_run_hash) VALUES ('done', ?, 'mgr', 0, 0, ?, 'x')").run(user.id, JSON.stringify(later));
  const res = await makeSheet(s, false);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /A later invoice changed Gouda Smoked \(invoice 2\)/);
});

test('a product a later invoice repriced after the sheet was made blocks the download', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  await makeSheet(s);
  await pressSend(s, ['FRONT']);
  const [row] = sheetRows(s);
  assert.equal((await get(s, `/runs/1/card-sheets/${row!.id}`, s.mgr.cookie)).statusCode, 200);
  // Days later another invoice reprices the gouda and is sent.
  const p = preview(s);
  const later: ChangePreview = { ...p, runId: 2, cards: { cards: [], leftOut: [] }, square: p.square.filter((x) => x.variationId === 'V_GOUDA') };
  const user = s.app.shelf.db.prepare("SELECT id FROM users WHERE username = 'mgr'").get() as { id: number };
  s.app.shelf.db.prepare("INSERT INTO runs (state, created_by, created_by_name, created_at, updated_at, dry_run, dry_run_hash) VALUES ('done', ?, 'mgr', 0, 0, ?, 'x')").run(user.id, JSON.stringify(later));
  const res = await get(s, `/runs/1/card-sheets/${row!.id}`, s.mgr.cookie);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /A later invoice changed Gouda Smoked \(invoice 2\) since this sheet was made/);
  assert.equal(s.app.shelf.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'cards.sheet.download'").get()!.n, 1, 'only the first download');
});

test('a line marked not arrived after approval prints no card', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  assert.equal((await decide(s, s.mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' })).statusCode, 303);
  const page = await get(s, '/runs/1', s.mgr.cookie);
  assert.match(page.body, /Make the card sheet \(2 cards\)/);
  assert.match(page.body, /line 2\): marked as not arrived after approval, so it is left off the sheet/);
  await makeSheet(s);
  const [row] = sheetRows(s);
  assert.deepEqual(JSON.parse(row!.cards).map((c: { variationId: string }) => c.variationId).sort(), ['V_GOUDA', 'V_SALMON']);
  assert.equal(fileSlots(s, row!.stored_name).filter(Boolean).length, 2);
  // A reprint cannot pick it either.
  const at = preview(s).cards.cards.findIndex((c) => c.variationId === 'V_CRACKER');
  assert.equal((await decide(s, s.mgr, '/runs/1/card-sheet/reprint', { [`card_${at}`]: '1' })).statusCode, 409);
});

test('a sheet made before a line was marked not arrived is not offered', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  await makeSheet(s);
  assert.equal((await decide(s, s.mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' })).statusCode, 303);
  await pressSend(s, ['FRONT']);
  const [row] = sheetRows(s);
  const res = await get(s, `/runs/1/card-sheets/${row!.id}`, s.mgr.cookie);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /marked as not arrived after this sheet was made/);
});

test('judge puts words a clipped card lost down to that card, not its neighbours', () => {
  const card = (slot: number, name: string, over: Partial<ReturnType<typeof checkSheetPdf>['cards'][number]> = {}) => ({
    page: 1, slot, name, tail: ['ends', 'here'], missingTail: [], shortWords: [], copyLines: 6, maxCopyLines: 10, ...over,
  });
  const raw = (cards: ReturnType<typeof checkSheetPdf>['cards']) =>
    ({ slots: 4, expectedPages: 1, pages: 1, pageCountOk: true, clipOk: false, copyLinesOk: false, fullTextOk: false, cards }) as ReturnType<typeof checkSheetPdf>;
  // The clipped card lost "aged" and "cheese"; its neighbours use those words too.
  let out = judge(raw([
    card(1, 'Long One', { missingTail: ['here'], copyLines: 11, shortWords: ['aged', 'cheese', 'here'] }),
    card(2, 'Short Two', { shortWords: ['aged', 'cheese'] }),
    card(3, 'Short Three', { shortWords: ['cheese'] }),
  ]), []);
  assert.equal(out.state, 'failed');
  assert.deepEqual(out.result!.failures.map((f) => f.name), ['Long One']);
  assert.match(out.message, /Cut off: Long One\. Shorten that card/);
  // A word only a neighbour uses is still its own failure.
  out = judge(raw([card(1, 'Long One', { missingTail: ['here'], shortWords: ['aged'] }), card(2, 'Short Two', { shortWords: ['aged', '7101'] })]), []);
  assert.deepEqual(out.result!.failures.map((f) => [f.name, f.problems.at(-1)]), [['Long One', 'Words missing from the page: aged.'], ['Short Two', 'Words missing from the page: 7101.']]);
  // With nothing clipped, every card short of a word fails.
  out = judge(raw([card(1, 'One', { shortWords: ['99'] }), card(2, 'Two')]), []);
  assert.deepEqual(out.result!.failures.map((f) => f.name), ['One']);
  // Fonts missing: not trusted, so not checked rather than failed.
  assert.equal(judge(raw([card(1, 'One', { missingTail: ['here'] })]), ['Fraunces']).state, 'unchecked');
  // All whole: passed.
  assert.equal(judge(raw([card(1, 'One')]), []).state, 'passed');
});

test('reprints and rechecks are capped per run per hour, one check waits at a time, and a full disk refuses a sheet', async (t) => {
  const unchecked: SheetCheckFn = async () => ({ state: 'unchecked', result: null, message: 'Not checked.' });
  const s = await approvedRun({ deps: { cardSheetCheck: unchecked } });
  t.after(() => s.close());
  // A full disk: refused before anything is written.
  await assert.rejects(
    buildRunSheet({ db: s.app.shelf.db, dir: sheetDir(s), cardConfig: () => loadCardConfig(), now: () => Date.now(), limits: { minFreeBytes: Number.MAX_SAFE_INTEGER } }, 1, { userId: null, username: 'test' }),
    (e: unknown) => e instanceof RunError && e.status === 507,
  );
  assert.equal(sheetRows(s).length, 0);
  // While the run sheet's check waits, a reprint is refused.
  await makeSheet(s, false);
  assert.equal((await decide(s, s.mgr, '/runs/1/card-sheet/reprint', { card_0: '1' })).statusCode, 409);
  await s.app.shelf.sheetChecker.drain();
  for (let i = 0; i < 10; i++) {
    assert.equal((await decide(s, s.mgr, '/runs/1/card-sheet/reprint', { card_0: '1' })).statusCode, 303, `reprint ${i + 1}`);
    await s.app.shelf.sheetChecker.drain();
  }
  assert.equal((await decide(s, s.mgr, '/runs/1/card-sheet/reprint', { card_0: '1' })).statusCode, 429);
  const id = sheetRows(s)[0]!.id;
  for (let i = 0; i < 10; i++) {
    assert.equal((await decide(s, s.mgr, `/runs/1/card-sheets/${id}/check`)).statusCode, 303, `recheck ${i + 1}`);
    await s.app.shelf.sheetChecker.drain();
  }
  assert.equal((await decide(s, s.mgr, `/runs/1/card-sheets/${id}/check`)).statusCode, 429);
  // An hour later both work again.
  s.advance(3600_000 + 1);
  assert.equal((await decide(s, s.mgr, `/runs/1/card-sheets/${id}/check`)).statusCode, 303);
  await s.app.shelf.sheetChecker.drain();
  assert.equal((await decide(s, s.mgr, '/runs/1/card-sheet/reprint', { card_0: '1' })).statusCode, 303);
});

test('a HEAD request is not served or audited as a download', async (t) => {
  const s = await approvedRun({ deps: { cardSheetCheck: passing } });
  t.after(() => s.close());
  await makeSheet(s);
  await pressSend(s, ['FRONT']);
  const [row] = sheetRows(s);
  const res = await s.app.inject({ method: 'HEAD', url: `/runs/1/card-sheets/${row!.id}`, headers: { cookie: s.mgr.cookie } });
  assert.notEqual(res.statusCode, 200);
  assert.doesNotMatch(String(res.headers['content-type'] ?? ''), /wordprocessingml/);
  assert.equal(s.app.shelf.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'cards.sheet.download'").get()!.n, 0);
});

test('the full text check fails a card whose price is missing from the page, by name', () => {
  const cfg = loadCardConfig();
  const c: CardRecord = {
    code: '7101', price: '$13.99', unit: 'PER POUND', origin: 'PRODUCT OF TESTLAND', eyebrow: '01 / CHEESE', n1: 'Test ', n2: 'Gouda',
    producer: 'Test Maker · Testville', specs: [['MILK', 'Cow'], ['AGE', 'Young'], ['CUT', 'Whole']], copy: ['A short first paragraph.', 'And a closing line.'],
  };
  // One card, top left. Every word is on the page except the price.
  const printed = [c.origin, c.eyebrow, c.n1 + c.n2, c.producer, ...c.specs.flat(), ...c.copy, c.unit, c.code].join(' ');
  const ws = printed.split(/\s+/).filter(Boolean);
  const page: PageWords = { width: 612, height: 792, words: ws.map((w, i) => ({ x0: 20, x1: 60, y0: 20 + i * 12, y1: 30 + i * 12, text: w })) };
  const r = checkRendered({ pages: 1, boxes: [page], text: [printed] }, [c, null, null, null], cfg);
  assert.equal(r.fullTextOk, false);
  assert.deepEqual(r.cards[0]!.shortWords.sort(), ['13', '99']);
  const out = judge(r, []);
  assert.equal(out.state, 'failed');
  assert.deepEqual(out.result!.failures.map((f) => f.name), ['Test Gouda']);
  assert.match(out.message, /Cut off: Test Gouda/);
});

const noLibreOffice = await missingTools();

test('the real check renders with LibreOffice and names a card whose copy is cut off', { skip: noLibreOffice.length ? `skipped: ${noLibreOffice.join(', ')} not installed` : false }, async (t) => {
  const cfg = loadCardConfig();
  const card = (n: string, copy: string[]): CardRecord => ({
    code: '',
    price: '$9.99',
    unit: '4 OZ',
    origin: 'PRODUCT OF TESTLAND',
    eyebrow: '09 / PANTRY',
    n1: 'Test ',
    n2: n,
    producer: 'Test Maker · Testville',
    specs: [['STYLE', 'Plain'], ['SIZE', 'Small'], ['USE', 'Snack']],
    copy,
  });
  const long = Array.from({ length: 40 }, (_, i) => `Sentence ${i + 1} says a little more about this invented product.`).join(' ');
  const cards = [card('Alpha', ['A short first paragraph.', 'A short second one.']), card('Overlong', [long, 'And then the closing line ends here.']), card('Gamma', ['Another short paragraph.', 'Closing words.'])];
  const built = await buildCards(cards, cfg);
  const slots = built.layout.map((c, i) => (i < cards.length ? c : null));
  const out = await renderSheetCheck()(built.buffer, slots, cfg);
  if (out.state === 'unchecked' && out.result?.missingFonts.length) {
    t.skip(`skipped: the real fonts are not installed (${out.result.missingFonts.join(', ')})`);
    return;
  }
  assert.equal(out.state, 'failed', out.message);
  assert.deepEqual(out.result!.failures.map((f) => f.name), ['Test Overlong']);
  assert.match(out.message, /Cut off: Test Overlong/);
});
