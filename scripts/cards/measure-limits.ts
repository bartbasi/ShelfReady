// Measures practical copy length limits for the shelf cards.
// Usage: node scripts/cards/measure-limits.ts [imported.json]
//
// Method:
// 1. Field lengths of the imported reference cards (what Claude has written).
// 2. Stress cards built from real card wording at growing lengths, one field
//    per card with everything else blank, rendered once through LibreOffice
//    with the real fonts. pdftotext -bbox gives each word's position; the
//    rows a field's words land on are its rendered line count. The copy
//    cards also go through the skill's clip check.
// Needs Fraunces and Space Grotesk installed, or the numbers mean nothing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BLANK, buildCards } from '../../src/cards/build.ts';
import { loadCardConfig } from '../../src/cards/config.ts';
import { docxToPdf, minCardPitchPt, pdfFonts, pdfPageCount, pdfWords, textLines, wordsByCard, type WordBox } from '../../src/cards/render.ts';
import { checkSheetPdf, maxCopyLines, words } from '../../src/cards/verify.ts';
import type { CardRecord } from '../../src/cards/types.ts';

const root = resolve(import.meta.dirname, '../..');
const imported = JSON.parse(readFileSync(resolve(process.argv[2] ?? join(root, 'data/cards/imported.json')), 'utf8')) as {
  cards: CardRecord[];
};
const cards = imported.cards;
const cfg = loadCardConfig();

// ---- 1. Reference field lengths ----
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};
const name = (c: CardRecord) => c.n1 + c.n2;
const reference = {
  cards: cards.length,
  copyChars: stats(cards.map((c) => c.copy.join(' ').length)),
  copyParagraphs: stats(cards.map((c) => c.copy.length)),
  nameChars: stats(cards.map((c) => name(c).length)),
  producerChars: stats(cards.map((c) => c.producer.length)),
  specLabelChars: stats(cards.flatMap((c) => c.specs.map((s) => s[0].length))),
  specValueChars: stats(cards.flatMap((c) => c.specs.map((s) => s[1].length))),
};

// ---- 2. Stress cards ----
const pool = (texts: string[]) => texts.join(' ').split(/\s+/).filter(Boolean);
const copyPool = pool(cards.flatMap((c) => c.copy));
const namePool = pool(cards.map(name));
const producerPool = pool(cards.map((c) => c.producer.replace(/·/g, ' ')));
const specValuePool = pool(cards.flatMap((c) => c.specs.map((s) => s[1])));
const specLabelPool = pool(cards.flatMap((c) => c.specs.map((s) => s[0])));

/** Words from the pool, starting at `seed`, until the text reaches `len` characters. */
function grow(p: string[], seed: number, len: number): string {
  let out = '';
  for (let i = seed; out.length < len; i++) out += (out ? ' ' : '') + p[i % p.length];
  return out;
}

interface Probe {
  kind: 'copy' | 'name' | 'producer' | 'spec' | 'label';
  chars: number;
  text: string;
}
// probes[i] describes layout[i]; null marks a blank slot.
const probes: Array<Probe | null> = [];
const layout: CardRecord[] = [];
const blank = (): CardRecord => structuredClone(BLANK) as CardRecord;
const padSheet = () => {
  while (layout.length % 4) {
    layout.push(blank());
    probes.push(null);
  }
};
const SEEDS = [0, 211, 437, 659, 883, 1097];

for (let len = 250; len <= 520; len += 10) {
  for (const seed of SEEDS) {
    const p1 = grow(copyPool, seed, Math.round(len * 0.55)).replace(/[.,;:]?$/, '.');
    const p2 = grow(copyPool, seed + 97, len - p1.length - 1).replace(/[.,;:]?$/, '.');
    layout.push({ ...blank(), copy: [p1, p2] });
    probes.push({ kind: 'copy', chars: p1.length + 1 + p2.length, text: `${p1} ${p2}` });
  }
}
for (let len = 10; len <= 60; len += 2) {
  for (const seed of SEEDS) {
    const t = grow(namePool, seed % namePool.length, len);
    const sp = t.indexOf(' ');
    layout.push({ ...blank(), n1: sp > 0 ? t.slice(0, sp + 1) : '', n2: sp > 0 ? t.slice(sp + 1) : t });
    probes.push({ kind: 'name', chars: t.length, text: t });
    // Names go in the top pair only: a three-line name in both pairs pushes
    // the sheet onto a second page, which would misalign every later card.
    if (layout.length % 4 === 2) padSheet();
  }
}
padSheet();
for (let len = 30; len <= 110; len += 5) {
  for (const seed of SEEDS.slice(0, 4)) {
    const t = grow(producerPool, seed % producerPool.length, len);
    layout.push({ ...blank(), producer: t });
    probes.push({ kind: 'producer', chars: t.length, text: t });
  }
}
for (let len = 4; len <= 22; len += 1) {
  for (const seed of SEEDS.slice(0, 4)) {
    const t = grow(specValuePool, seed % specValuePool.length, len).slice(0, len).trim();
    // Only the middle spec is set, so its width can be measured on its own.
    layout.push({ ...blank(), specs: [['', ''], ['', t], ['', '']] });
    probes.push({ kind: 'spec', chars: t.length, text: t });
  }
}
for (let len = 4; len <= 16; len += 1) {
  for (const seed of SEEDS.slice(0, 4)) {
    const t = grow(specLabelPool, seed % specLabelPool.length, len).slice(0, len).trim();
    layout.push({ ...blank(), specs: [['', ''], [t, ''], ['', '']] });
    probes.push({ kind: 'label', chars: t.length, text: t });
  }
}
padSheet();

const outDir = join(root, 'data/cards/render/limits');
mkdirSync(outDir, { recursive: true });
const docx = join(outDir, 'limits-probe.docx');
writeFileSync(docx, (await buildCards(layout, cfg, { sort: false })).buffer);
const pdf = await docxToPdf(docx, outDir);
const pageCount = pdfPageCount(pdf);
if (pageCount !== layout.length / 4) throw new Error(`Probe sheet overflowed: ${pageCount} pages for ${layout.length / 4} sheets`);
const fonts = pdfFonts(pdf).join(' ');
if (!/Fraunces/.test(fonts) || !/SpaceGrotesk/.test(fonts)) throw new Error(`Real fonts not used: ${fonts}`);

// Word boxes per card. In a probe card only one field is set, so every word
// that is not the store mark or the tagline belongs to that field.
const fixed = new Set(words(`${cfg.mark} ${cfg.tagline}`));
const perCard: WordBox[][] = pdfWords(pdf).flatMap((page) =>
  wordsByCard(page, minCardPitchPt(cfg.geometry.rowHeights, cfg.geometry.gutter)).map((ws) => ws.filter((w) => !words(w.text).every((x) => fixed.has(x)))),
);
const extent = (bs: WordBox[]) => (bs.length ? Math.max(...bs.map((b) => b.x1)) - Math.min(...bs.map((b) => b.x0)) : 0);

const clip = checkSheetPdf(pdf, layout.map((c, i) => (probes[i] ? c : null)), cfg);
const clipBySlot = new Map(clip.cards.map((c) => [(c.page - 1) * 4 + c.slot - 1, c]));

const rows = probes.flatMap((pr, i) => {
  if (!pr) return [];
  const bs = perCard[i];
  const c = clipBySlot.get(i);
  const copyFails = Boolean(c && (c.missingTail.length || c.shortWords.length || c.copyLines > c.maxCopyLines));
  return [
    {
      ...pr,
      lines: pr.kind === 'copy' ? (c?.copyLines ?? 0) : textLines(bs).length,
      widthPt: Math.round(extent(bs) * 10) / 10,
      clipped: pr.kind === 'copy' ? copyFails : false,
    },
  ];
});

/** Largest length where every probe met `ok`, and smallest length where one did not. */
function threshold(kind: Probe['kind'], ok: (r: (typeof rows)[number]) => boolean) {
  const rs = rows.filter((r) => r.kind === kind);
  const bad = rs.filter((r) => !ok(r)).map((r) => r.chars);
  const firstBad = bad.length ? Math.min(...bad) : null;
  const good = rs.filter((r) => ok(r) && (firstBad === null || r.chars < firstBad)).map((r) => r.chars);
  return { allFitUpTo: good.length ? Math.max(...good) : null, firstFailureAt: firstBad, lastSuccessAt: Math.max(...rs.filter(ok).map((r) => r.chars)) };
}

const INNER_PT = (cfg.geometry.labelWidth - 2 * cfg.geometry.padX) / 20;
const result = {
  measuredAt: new Date().toISOString(),
  fonts: [...new Set(pdfFonts(pdf))],
  reference,
  copy: {
    maxLinesHeld: maxCopyLines(cfg, 2),
    fits: threshold('copy', (r) => !r.clipped),
    tenLines: threshold('copy', (r) => r.lines <= 10),
    nineLines: threshold('copy', (r) => r.lines <= 9),
  },
  name: { oneLine: threshold('name', (r) => r.lines <= 1), twoLines: threshold('name', (r) => r.lines <= 2) },
  producer: { oneLine: threshold('producer', (r) => r.lines <= 1) },
  spec: {
    columnPt: Math.round((INNER_PT / 3) * 10) / 10,
    fitsColumn: threshold('spec', (r) => r.lines <= 1 && r.widthPt <= INNER_PT / 3 - 6),
    labelFitsColumn: threshold('label', (r) => r.lines <= 1 && r.widthPt <= INNER_PT / 3 - 6),
  },
  probes: rows,
};
writeFileSync(join(outDir, 'limits.json'), JSON.stringify(result, null, 2) + '\n');
const { probes: _omit, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
console.log(`Full probe list: ${join(outDir, 'limits.json')}`);
