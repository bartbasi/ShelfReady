// Runs the skill's required checks on card sheets and renders page 1 to PNG.
// Usage: node scripts/cards/verify.ts [--out dir] [--all-pages] file.docx [more.docx ...]
// LibreOffice runs with nice -n 19, one file at a time.
import { readFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseCardsDocx } from '../../src/cards/import.ts';
import { docxToPdf, pdfFonts, pdfPageToPng } from '../../src/cards/render.ts';
import { loadCardConfig } from '../../src/cards/config.ts';
import { checkSheetPdf } from '../../src/cards/verify.ts';

const args = process.argv.slice(2);
let outDir = resolve(import.meta.dirname, '../../data/cards/render');
let allPages = false;
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = resolve(args[++i] ?? '.');
  else if (args[i] === '--all-pages') allPages = true;
  else files.push(resolve(args[i]));
}
if (files.length === 0) {
  console.error('Usage: node scripts/cards/verify.ts [--out dir] [--all-pages] file.docx [more.docx ...]');
  process.exit(2);
}

const cfg = loadCardConfig();
let failed = false;
for (const file of files) {
  const { slots } = parseCardsDocx(readFileSync(file));
  const pdf = await docxToPdf(file, outDir);
  const r = checkSheetPdf(pdf, slots, cfg);
  const fonts = [...new Set(pdfFonts(pdf))];
  const missingFonts = ['Fraunces', 'SpaceGrotesk'].filter((f) => !fonts.some((n) => n.replace(/\s/g, '').startsWith(f)));

  console.log(`\n${basename(file)}`);
  console.log(`  page count: ${r.pages} of ${r.expectedPages} expected (${r.slots} slots) ${r.pageCountOk ? 'OK' : 'FAIL'}`);
  const clipped = r.cards.filter((c) => c.missingTail.length);
  console.log(`  clip check: ${r.cards.length - clipped.length} of ${r.cards.length} cards end on their page ${r.clipOk ? 'OK' : 'FAIL'}`);
  for (const c of clipped) console.log(`    page ${c.page} slot ${c.slot} ${c.name}: missing ${c.missingTail.join(' ')}`);
  const over = r.cards.filter((c) => c.copyLines > c.maxCopyLines);
  const most = Math.max(...r.cards.map((c) => c.copyLines));
  console.log(`  copy lines: most ${most}, panel holds ${r.cards[0]?.maxCopyLines ?? '?'} ${r.copyLinesOk ? 'OK' : 'FAIL'}`);
  for (const c of over) console.log(`    page ${c.page} slot ${c.slot} ${c.name}: ${c.copyLines} lines, holds ${c.maxCopyLines}`);
  const short = r.cards.filter((c) => c.shortWords.length);
  console.log(`  full text:  ${r.cards.length - short.length} of ${r.cards.length} cards have every word on the page ${r.fullTextOk ? 'OK' : 'FAIL'}`);
  for (const c of short) console.log(`    page ${c.page} slot ${c.slot} ${c.name}: short ${c.shortWords.join(' ')}`);
  console.log(`  fonts in PDF: ${fonts.join(', ')}${missingFonts.length ? `  WARNING: ${missingFonts.join(', ')} not embedded, a fallback font was used` : ''}`);

  const stem = basename(file, extname(file));
  const pages = allPages ? Array.from({ length: r.pages }, (_, i) => i + 1) : [1];
  for (const p of pages) console.log(`  png: ${pdfPageToPng(pdf, p, join(outDir, `${stem}-p${p}`))}`);
  console.log(`  pdf: ${pdf}`);
  if (!r.pageCountOk || !r.clipOk || !r.copyLinesOk || !r.fullTextOk || missingFonts.length) failed = true;
}
process.exit(failed ? 1 : 0);
