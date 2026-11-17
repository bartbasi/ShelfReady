// Imports the existing cards (data/cards/imported.json, from scripts/cards/import-reference.ts)
// into the card store and links each to a Square item, in the catalog the runs use: carried
// links first, then scale code, then name. Prints what it linked and every link it could not
// make. Safe to run again: a retired card stays retired.
//
// Usage: node scripts/copy/import-cards.ts [--memory] [--db FILE] [--cards FILE] [--catalog FILE] [--verbose]
//   --memory   use a database in memory: a dry run that writes nothing
//   --db       the database to import into (default: the app's, from the server config)
//   --catalog  a saved Square catalog file (source "file"). Without it, the catalog the runs use:
//              the newest catalog a run saved in the app database, else the server config's
//              devCatalogFile.
//
// Links hold only in the catalog they were made in, because variation ids differ between the
// sandbox and live accounts. Everything it reads and prints is store data. It writes only to
// the database, and never to the app database on --memory.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ImportedCard } from '../../src/cards/import.ts';
import { openDatabase } from '../../src/db/db.ts';
import { importCards, type CardLinkProblem } from '../../src/copy/import.ts';
import type { CopyCatalog } from '../../src/copy/types.ts';
import { buildCatalogIndex } from '../../src/matching/catalog.ts';
import { loadCatalogSnapshot } from '../../src/runs/store.ts';
import { loadConfig } from '../../src/server/config.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function show(title: string, list: CardLinkProblem[], verbose: boolean): void {
  if (list.length === 0) return;
  console.log(`\n${title} (${list.length}):`);
  for (const p of list) {
    console.log(`  card ${p.cardId}: ${p.name} | ${p.producer} | ${p.unit}${p.printedCode ? ` | printed code ${p.printedCode}` : ''}`);
    for (const c of p.candidates.slice(0, verbose ? 5 : 2)) console.log(`      ${c.score.toFixed(2)} ${c.method === 'scale_code' ? 'code' : 'name'}: ${c.label}`);
  }
}

function fileCatalog(path: string): CopyCatalog & { label: string } {
  if (!existsSync(path)) throw new Error(`No catalog at ${path}.`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { objects: unknown[]; location?: { id?: string }; locationId?: string };
  const locationId = raw.location?.id ?? raw.locationId ?? '';
  if (locationId.trim() === '') throw new Error(`The catalog file ${path} names no Square location id, so card links could not be kept for it.`);
  return { index: buildCatalogIndex({ objects: raw.objects, locationId }), source: 'file', label: `the file ${path}` };
}

/** The catalog the runs use: the newest one a run saved, read without changing the database. */
function runCatalog(dbPath: string): (CopyCatalog & { label: string }) | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'catalog_snapshots'").get();
    if (!hasTable) return null;
    const row = db.prepare('SELECT id FROM catalog_snapshots ORDER BY created_at DESC, id DESC LIMIT 1').get() as { id: number } | undefined;
    if (!row) return null;
    const s = loadCatalogSnapshot(db, row.id);
    return { index: buildCatalogIndex({ objects: s.objects, locationId: s.locationId }), source: s.source, label: `the ${s.source} catalog a run saved at ${s.takenAt}` };
  } finally {
    db.close();
  }
}

function main(): void {
  const cardsPath = arg('--cards') ?? join(repo, 'data/cards/imported.json');
  const verbose = process.argv.includes('--verbose');
  if (!existsSync(cardsPath)) throw new Error(`No imported cards at ${cardsPath}. Run scripts/cards/import-reference.ts first.`);
  const config = loadConfig();
  const catalogFile = arg('--catalog');
  const catalog = catalogFile ? fileCatalog(catalogFile) : (runCatalog(config.dbPath) ?? (config.devCatalogFile ? fileCatalog(config.devCatalogFile) : null));
  if (!catalog) throw new Error('No catalog to link against: no run has saved one yet and no devCatalogFile is set. Run an invoice first, or pass --catalog FILE.');
  const file = JSON.parse(readFileSync(cardsPath, 'utf8')) as { cards: ImportedCard[] };
  const dbPath = process.argv.includes('--memory') ? ':memory:' : (arg('--db') ?? config.dbPath);
  process.umask(0o077);
  const db = openDatabase(dbPath);
  try {
    const r = importCards(db, { userId: null, username: 'cli' }, catalog, file);
    console.log(`Catalog: ${catalog.label} (location ${r.catalog}).`);
    console.log(`Cards: ${r.cards}. Added ${r.created}, replaced by a newer printing ${r.reimported}, unchanged ${r.unchanged}, edited and kept ${r.editedKept}, retired and kept ${r.retiredKept}, refused ${r.refused.length}.`);
    console.log(`Linked here by carrying a link from another catalog ${r.linkedByCarry}, by scale code ${r.linkedByCode}, by name ${r.linkedByName}, already linked ${r.alreadyLinked}. Generated cards replaced: ${r.replacedGenerated}.`);
    console.log(`Not linked: ${r.toConfirm.length} for a person to confirm, ${r.noCandidate.length} with nothing alike in Square, ${r.conflicts.length} in conflict.`);
    for (const x of r.refused) console.log(`  refused: ${x.name}: ${x.why}`);
    show('For a person to confirm', r.toConfirm, verbose);
    show('Nothing alike in Square', r.noCandidate, verbose);
    show('In conflict with a card that holds the item', r.conflicts, verbose);
    console.log(dbPath === ':memory:' ? '\nDry run: nothing was written.' : `\nWritten to ${dbPath}.`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : 'The import failed.');
  process.exit(1);
}
