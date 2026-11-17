// Renders a reference sheet and our rebuild of it (from its own imported
// records, original order) and compares them: PDF text per page and a pixel
// diff of every page. Saves page 1 of each as PNG.
// Usage: node scripts/cards/compare-render.ts name [--unpinned] [--out dir]
//   name: a file in reference/cards, with or without .docx
//   --unpinned: also rebuild without the pinned styles.xml and settings.xml,
//               to see whether the docx library's newer defaults change the render.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCards } from '../../src/cards/build.ts';
import { loadCardConfig, withLegacyNameBlock } from '../../src/cards/config.ts';
import { parseCardsDocx } from '../../src/cards/import.ts';
import { docxToPdf, pdfPageCount, pdfPageRaster, pdfPageText, pdfPageToPng, rasterDiff } from '../../src/cards/render.ts';

const args = process.argv.slice(2);
const root = resolve(import.meta.dirname, '../..');
let outDir = join(root, 'data/cards/render');
let name = '';
let unpinned = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = resolve(args[++i] ?? '.');
  else if (args[i] === '--unpinned') unpinned = true;
  else name = args[i].replace(/\.docx$/, '');
}

if (!name) {
  console.error('Usage: node scripts/cards/compare-render.ts name [--unpinned] [--out dir]');
  process.exit(2);
}
const refPath = join(root, 'reference/cards', `${name}.docx`);
const parsed = parseCardsDocx(readFileSync(refPath));
const base = loadCardConfig();
const legacy = base.geometry.history?.untilOct28?.nameRowHeight;
const cfg = legacy !== undefined && parsed.nameRowHeight === legacy ? withLegacyNameBlock(base) : base;

const work = join(outDir, 'compare');
mkdirSync(work, { recursive: true });
const refCopy = join(work, `${name}-reference.docx`);
copyFileSync(refPath, refCopy);
const variants: Array<[string, string]> = [['reference', refCopy]];
const rebuilt = join(work, `${name}-rebuilt.docx`);
writeFileSync(rebuilt, (await buildCards(parsed.cards, cfg, { sort: false })).buffer);
variants.push(['rebuilt', rebuilt]);
if (unpinned) {
  const p = join(work, `${name}-unpinned.docx`);
  writeFileSync(p, (await buildCards(parsed.cards, cfg, { sort: false, pinParts: false })).buffer);
  variants.push(['unpinned', p]);
}

// One LibreOffice conversion at a time.
const pdfs: Array<readonly [string, string]> = [];
for (const [label, docx] of variants) pdfs.push([label, await docxToPdf(docx, work)] as const);
const [, refPdf] = pdfs[0];
const pages = pdfPageCount(refPdf);
console.log(`${name}: reference has ${pages} pages`);

for (const [label, pdf] of pdfs) {
  const png = pdfPageToPng(pdf, 1, join(outDir, `${name}-${label}-p1`));
  console.log(`  ${label} page 1 png: ${png}`);
}

for (const [label, pdf] of pdfs.slice(1)) {
  const n = pdfPageCount(pdf);
  let textSame = n === pages;
  let differing = 0;
  let total = 0;
  for (let p = 1; p <= Math.min(n, pages); p++) {
    if (pdfPageText(pdf, p) !== pdfPageText(refPdf, p)) textSame = false;
    const d = rasterDiff(pdfPageRaster(refPdf, p), pdfPageRaster(pdf, p));
    differing += d.differing;
    total += d.total;
  }
  console.log(`  ${label} vs reference: ${n} pages, PDF text ${textSame ? 'identical' : 'DIFFERS'}, ${differing} of ${total} pixels differ`);
}
