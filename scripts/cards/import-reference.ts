// Imports the card copy from the reference .docx files into data/cards/imported.json.
// Usage: node scripts/cards/import-reference.ts [reference dir] [output file]
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadCardConfig } from '../../src/cards/config.ts';
import { mergeImports, parseCardsDocx, templateWarnings, type ImportFile } from '../../src/cards/import.ts';

const root = resolve(import.meta.dirname, '../..');
const refDir = resolve(process.argv[2] ?? join(root, 'reference/cards'));
const outFile = resolve(process.argv[3] ?? join(root, 'data/cards/imported.json'));

const names = readdirSync(refDir).filter((f) => f.endsWith('.docx')).sort();
if (names.length === 0) {
  console.error(`No .docx files in ${refDir}`);
  process.exit(1);
}

const files: ImportFile[] = names.map((name) => {
  const path = join(refDir, name);
  return { file: name, parsed: parseCardsDocx(readFileSync(path)), fallbackTime: statSync(path).mtime.toISOString() };
});
const cfg = loadCardConfig();
const { cards, duplicates, sharedNames } = mergeImports(files);

const out = {
  importedAt: new Date().toISOString(),
  from: refDir,
  rule: 'One card per scale code. With no code, one card per name plus producer plus pack size. The newest file wins (docProps created time).',
  files: files.map((f) => ({
    file: f.file,
    created: f.parsed.created,
    sheets: f.parsed.sheets,
    cards: f.parsed.cards.length,
    blankSlots: f.parsed.slots.length - f.parsed.cards.length,
    nameRowHeight: f.parsed.nameRowHeight,
    marks: f.parsed.marks,
    taglines: f.parsed.taglines,
    warnings: templateWarnings(f.parsed, cfg),
  })),
  duplicates,
  sharedNames,
  cards,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n');

for (const f of out.files) {
  console.log(`${f.file}: ${f.cards} cards, ${f.blankSlots} blank slots, ${f.sheets} sheets, created ${f.created}`);
  for (const w of f.warnings) console.log(`  WARNING: ${w}`);
}
const total = out.files.reduce((n, f) => n + f.cards, 0);
console.log(`${total} cards read, ${duplicates.length} duplicates resolved, ${cards.length} unique cards`);
for (const d of duplicates) {
  console.log(`  ${d.name}: kept ${d.kept}, dropped ${d.dropped.join('; ')}${d.identical ? ' (same text)' : ' (text differed)'}`);
}
for (const n of sharedNames) console.log(`  kept apart, same name: ${n.name}: ${n.cards.join('; ')}`);
console.log(`Wrote ${basename(outFile)} to ${dirname(outFile)}`);
