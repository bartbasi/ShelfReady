// The go-live import (scripts/golive/import-testing-data.ts): a dry run writes nothing to the
// database and reports what would carry over; --apply writes the same, after a backup, and refuses
// an old catalog or a running server. Matches that do not line up with the live catalog are never
// carried; they go on the report. Invented data only: the test catalog, cards and invoice lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/db/db.ts';
import { databaseInUse, parseArgs, removeOldCopies, runImport, type LabelFile } from '../scripts/golive/import-testing-data.ts';
import { imported } from './copy-fixtures.ts';
import { LOCATION, testObjects, UPC_CRACKER } from './matching-fixtures.ts';
import { tempDir } from './server-helpers.ts';

const TAKEN = '2026-11-16T12:00:00.000Z';
const NOW = Date.parse('2026-11-16T15:00:00.000Z');

function setup() {
  const dir = tempDir();
  const objects = testObjects();
  // One item archived in live Square since testing.
  const wafer = objects.find((o) => o.id === 'I_WAFER') as { is_archived?: boolean; item_data: { is_archived?: boolean } };
  wafer.item_data.is_archived = true;
  const catalogPath = join(dir, 'live-catalog.json');
  writeFileSync(catalogPath, JSON.stringify({ takenAt: TAKEN, location: { id: LOCATION }, objects, counts: [] }));
  const expectedDir = join(dir, 'expected');
  mkdirSync(expectedDir);
  const line = (itemNumber: string, description: string, upc = '') => ({ itemNumber, upc, description, descriptionMore: '', brand: '' });
  writeFileSync(
    join(expectedDir, 'example-1.json'),
    JSON.stringify({
      name: 'example-1',
      supplier: 'Example Foods Inc.',
      lines: [
        line('G100', 'GOUDA SMOKED WHEEL'),
        line('C200', 'SEA SALT CRACKER 12CT', UPC_CRACKER),
        line('B300', 'MEADOW BRIE WHEEL'),
        line('W400', 'WAFER PEPPER'),
        line('X500', 'GONE ITEM'),
        line('N600', 'NEW THING'),
        line('S700', 'KITCHEN GLOVES'),
        line('U800', 'UNSURE ITEM'),
        line('R900', 'RENAMED CHEDDAR'),
      ],
    }),
  );
  writeFileSync(
    join(expectedDir, 'example-2.json'),
    JSON.stringify({ name: 'example-2', supplier: 'EXAMPLE FOODS', lines: [line('G100', 'GOUDA SMOKED WHEEL 2'), line('B300', 'MEADOW BRIE WHEEL')] }),
  );
  const labels: LabelFile = {
    suppliers: [{ name: 'Example Foods Inc.', aliases: ['EXAMPLE FOODS'] }],
    invoices: {
      'example-1': [
        { line: 1, itemNumber: 'G100', label: 'match', variationId: 'V_GOUDA', squareName: 'Gouda Smoked 7101', sure: true },
        { line: 2, itemNumber: 'C200', label: 'match', variationId: 'V_CRACKER', squareName: 'Bluecrest - Crackers, Sea Salt', sure: true },
        { line: 3, itemNumber: 'B300', label: 'match', variationId: 'V_BRIE', squareName: 'Meadow Brie 7103', sure: true },
        { line: 4, itemNumber: 'W400', label: 'match', variationId: 'V_WAFER', squareName: 'Northfield - Wafer Crackers, Pepper', sure: true },
        { line: 5, itemNumber: 'X500', label: 'match', variationId: 'V_GONE', squareName: 'Gone Item', sure: true },
        { line: 6, itemNumber: 'N600', label: 'new', sure: true },
        { line: 7, itemNumber: 'S700', label: 'not_for_resale', sure: true },
        { line: 8, itemNumber: 'U800', label: 'match', variationId: 'V_CHEDDAR', squareName: 'Hilltop Aged Cheddar 7102', sure: false, note: 'two cheddars look alike' },
        { line: 9, itemNumber: 'R900', label: 'match', variationId: 'V_CHEDDAR', squareName: 'Old Cheddar Name 7102', sure: true },
      ],
      // The same gouda again (one saved match), and the brie matched to something else (a conflict).
      'example-2': [
        { line: 1, itemNumber: 'G100', label: 'match', variationId: 'V_GOUDA', squareName: 'Gouda Smoked 7101', sure: true },
        { line: 2, itemNumber: 'B300', label: 'match', variationId: 'V_CHEDDAR', squareName: 'Hilltop Aged Cheddar 7102', sure: true },
      ],
    },
  };
  const labelsPath = join(dir, 'labels.json');
  writeFileSync(labelsPath, JSON.stringify(labels));
  const cardsPath = join(dir, 'cards.json');
  writeFileSync(cardsPath, JSON.stringify({ cards: [imported({ n1: 'Smoked ', n2: 'Gouda', code: '7101' }), imported({ n1: 'Imaginary ', n2: 'Blue', code: '' })] }));
  const fishPath = join(dir, 'fish.json');
  writeFileSync(fishPath, JSON.stringify({ version: 1, rows: [{ row: 'Coho Salmon', status: 'confirmed', itemId: 'I_SALMON' }, { row: 'Lost Fish', status: 'confirmed', itemId: 'I_NOT_THERE' }, { row: 'Clams', status: 'none' }] }));
  const dbPath = join(dir, 'data', 'shelfready.sqlite3');
  mkdirSync(join(dir, 'data'));
  openDatabase(dbPath).close();
  const opts = { dbPath, catalogPath, cardsPath, labelsPath, expectedDir, fishPath, now: () => NOW, serverRunning: () => false };
  return { dir, dbPath, opts };
}

function counts(dbPath: string): Record<string, number> {
  const db = openDatabase(dbPath);
  try {
    const n = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { suppliers: n('suppliers'), aliases: n('supplier_aliases'), mappings: n('item_mappings'), cards: n('cards'), links: n('card_links'), audit: n('audit_log') };
  } finally {
    db.close();
  }
}

test('the dry run writes nothing to the database, and its report lists what would not carry over', async (t) => {
  const { dir, dbPath, opts } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = counts(dbPath);
  const bytes = readFileSync(dbPath);
  const r = await runImport({ ...opts, apply: false });
  assert.deepEqual(counts(dbPath), before, 'the database is unchanged');
  assert.ok(readFileSync(dbPath).equals(bytes), 'not a byte changed');
  assert.equal(r.backupPath, null);
  // The report sits in data/golive, mode 600.
  assert.ok(r.reportPath.startsWith(join(dir, 'data', 'golive')));
  assert.equal(statSync(r.reportPath).mode & 0o777, 0o600);
  const text = readFileSync(r.reportPath, 'utf8');
  assert.match(text, /# Go-live import: dry run, nothing was written/);

  const m = r.report.matches;
  // Carried: gouda, cracker, brie? No: the brie is in conflict. Gouda, cracker; kitchen gloves not for resale.
  assert.equal(m.carriedSquare, 2);
  assert.equal(m.carriedNotForResale, 1);
  assert.equal(m.newItems, 1);
  const why = (item: string) => m.notCarried.filter((n) => n.itemNumber === item).map((n) => n.why).join(' | ');
  assert.match(why('W400'), /archived/);
  assert.match(why('X500'), /not in the live catalog/);
  assert.match(why('U800'), /Not confirmed in testing: two cheddars look alike/);
  assert.match(why('R900'), /Square now calls it something else/);
  assert.match(why('B300'), /matched the same supplier item to something else/);
  assert.equal(m.notCarried.filter((n) => n.itemNumber === 'B300').length, 2, 'both sides of the conflict are listed');
  // The brie has a scale code but no per-pound price in Square: not carried here (conflict), so not listed for rule 12.
  assert.deepEqual(r.report.suppliers.created, ['Example Foods Inc.']);
  // Cards: the gouda card links by its code; the invented blue has nothing alike.
  assert.equal(r.report.cards!.created, 2);
  assert.equal(r.report.cards!.linkedByCode, 1);
  assert.equal(r.report.cards!.noCandidate.length, 1);
  // Fish matches: checked, one row not in the live catalog.
  assert.deepEqual(r.report.fish, { checked: 2, ok: 1, problems: [{ row: 'Lost Fish', why: 'Its Square item is not in the live catalog.' }] });
  for (const words of ['archived', 'Not confirmed in testing', 'Lost Fish', 'Imaginary Blue', `location ${LOCATION}`]) assert.ok(text.includes(words), words);
  // Plain writing: no em dashes, no double hyphens.
  assert.doesNotMatch(text, /\u2014|--/);
});

test('apply writes the same, after a backup copy, and running it again changes nothing more', async (t) => {
  const { dir, dbPath, opts } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dry = await runImport({ ...opts, apply: false });
  const r = await runImport({ ...opts, apply: true });
  assert.ok(r.backupPath && existsSync(r.backupPath));
  assert.equal(statSync(r.backupPath).mode & 0o777, 0o600);
  assert.match(readFileSync(r.reportPath, 'utf8'), /# Go-live import: applied/);
  // The dry run said exactly what apply did.
  assert.deepEqual(r.report.matches, dry.report.matches);
  const after = counts(dbPath);
  assert.equal(after.suppliers, 1, 'both spellings are one supplier');
  assert.ok(after.aliases >= 1);
  assert.equal(after.mappings, 3);
  assert.equal(after.cards, 2);
  assert.equal(after.links, 1);
  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare('SELECT kind, square_variation_id AS v, confirmed_by_name AS who FROM item_mappings ORDER BY id').all() as Array<{ kind: string; v: string | null; who: string }>;
    assert.deepEqual(rows.map((x) => [x.kind, x.v]), [['square', 'V_GOUDA'], ['square', 'V_CRACKER'], ['not_for_resale', null]]);
    assert.ok(rows.every((x) => x.who === 'go-live import'));
    const link = db.prepare('SELECT catalog, catalog_source FROM card_links').get() as { catalog: string; catalog_source: string };
    assert.deepEqual({ ...link }, { catalog: LOCATION, catalog_source: 'square_production' });
    assert.ok((db.prepare("SELECT count(*) AS n FROM audit_log WHERE username = 'go-live import'").get() as { n: number }).n > 0);
  } finally {
    db.close();
  }
  // Again: nothing new.
  await runImport({ ...opts, apply: true });
  const again = counts(dbPath);
  assert.deepEqual({ ...again, audit: 0 }, { ...after, audit: 0 });
});

test('apply refuses an old live catalog and a running server, and changes nothing then', async (t) => {
  const { dir, dbPath, opts } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = counts(dbPath);
  await assert.rejects(runImport({ ...opts, apply: true, now: () => NOW + 30 * 3600_000 }), /more than 24 hours ago\. Take a fresh one first/);
  await assert.rejects(runImport({ ...opts, apply: true, serverRunning: () => true }), /ShelfReady is running\. Stop it first/);
  assert.deepEqual(counts(dbPath), before);
  // A dry run on an old catalog is fine: it only reports.
  const r = await runImport({ ...opts, apply: false, now: () => NOW + 30 * 3600_000 });
  assert.equal(r.report.matches.carriedSquare, 2);
  await assert.rejects(runImport({ ...opts, apply: false, catalogPath: join(dir, 'missing.json') }), /No live catalog/);
});

test('the command takes plain words, so the guide needs no dashes: a dry run unless apply is given', () => {
  assert.deepEqual([...parseArgs([]).words], []);
  assert.deepEqual([...parseArgs(['apply']).words], ['apply']);
  assert.deepEqual([...parseArgs(['--apply']).words], ['apply']);
  assert.equal(parseArgs(['db=/tmp/x.sqlite3']).values.get('db'), '/tmp/x.sqlite3');
  assert.equal(parseArgs(['--db', '/tmp/x.sqlite3']).values.get('db'), '/tmp/x.sqlite3');
  assert.equal(parseArgs(['--maxAgeHours=6']).values.get('maxAgeHours'), '6');
  assert.throws(() => parseArgs(['aply']), /Unknown word aply/);
  assert.throws(() => parseArgs(['dbb=x']), /Unknown option dbb/);
});

test('the dry run copy sits in a mode 700 folder in the data folder, is removed afterwards, and Ctrl-C would remove it too', async (t) => {
  const { dir, opts } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'data');
  let seen = '';
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
  await runImport({
    ...opts,
    apply: false,
    onCopy: (folder) => {
      seen = folder;
      assert.equal(join(folder, '..'), dataDir);
      assert.equal(statSync(folder).mode & 0o777, 0o700);
      assert.ok(existsSync(join(folder, 'copy.sqlite3')));
      assert.equal(process.listenerCount('SIGINT'), before.int + 1, 'a Ctrl-C handler removes the copy');
      assert.equal(process.listenerCount('SIGTERM'), before.term + 1);
    },
  });
  assert.ok(seen);
  assert.ok(!existsSync(seen), 'removed afterwards');
  assert.deepEqual({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }, before);
  // A copy a hard kill left behind is removed by the next run once it is an hour old.
  const old = join(dataDir, '.golive-dry-run-left');
  mkdirSync(old);
  const fresh = join(dataDir, '.golive-dry-run-new');
  mkdirSync(fresh);
  utimesSync(old, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  removeOldCopies(dataDir, Date.now());
  assert.ok(!existsSync(old));
  assert.ok(existsSync(fresh), 'one that may still be in use stays');
});

test('a database another connection holds open is seen as in use, even while that connection is idle', (t) => {
  const { dir, dbPath } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(databaseInUse(dbPath), false);
  const other = openDatabase(dbPath);
  other.prepare('SELECT count(*) FROM users').get();
  assert.equal(databaseInUse(dbPath), true);
  other.close();
  assert.equal(databaseInUse(dbPath), false);
  assert.equal(databaseInUse(join(dir, 'none.sqlite3')), false);
});
