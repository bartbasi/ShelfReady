// Going live: brings the card copy, supplier names and item matches from testing into the live
// ShelfReady database, each rechecked against the live Square catalog. Anything that does not line
// up is not carried over; it goes on a list for Bart instead (docs/GO-LIVE.md, step 5).
//
//   nice -n 19 node scripts/golive/import-testing-data.ts          dry run: writes nothing to the database
//   nice -n 19 node scripts/golive/import-testing-data.ts apply    writes, after a backup copy
//
// Options, as name=value: db=FILE catalog=FILE cards=FILE labels=FILE expected=DIR fish=FILE
// report=FILE maxAgeHours=N (for apply; default 24). Two leading dashes also work.
//
// What it reads, all store data kept out of git:
// - the live catalog: data/square/live-catalog.json, the read-only copy that
//   scripts/square/snapshot-live.ts saves (it only reads live Square). This script makes no call to
//   Square at all. For apply the copy must be fresh (24 hours by default): take a new one first.
// - card copy: data/cards/imported.json (scripts/cards/import-reference.ts, from reference/cards/).
// - supplier names and item matches: test-invoices/expected/*.json (the invoice lines) and
//   test-invoices/matching-labels.json (the Square item each line is, as confirmed in testing).
// - the fish email matches: data/mailchimp/fish-matches.json, checked only, never changed.
//
// What it writes:
// - a report for Bart in data/golive/ (mode 600), both in a dry run and with apply.
// - with apply only: suppliers, saved item matches and cards with their links, into the
//   database, through the same code the app uses (confirmMapping, importCards), each in the audit
//   log as "go-live import". First a backup copy of the database beside it.
//
// The dry run works on a copy of the database in a private folder in the data folder, removed
// afterwards (and on Ctrl-C), so it shows exactly what apply would do without touching the real
// one. apply refuses while ShelfReady is running (its pid file, a src/server/main.ts process, or
// any other connection holding the database), and holds the database alone while it writes. Stop
// ShelfReady first: scripts/net/service.sh stop.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ImportedCard } from '../../src/cards/import.ts';
import type { AuditActor } from '../../src/db/audit.ts';
import { openDatabase, type Db } from '../../src/db/db.ts';
import { importCards, type CardLinkProblem, type ImportReport } from '../../src/copy/import.ts';
import type { ExpectedInvoice } from '../../src/invoice/expected.ts';
import { buildCatalogIndex, itemOf, type CatalogIndex } from '../../src/matching/catalog.ts';
import { confirmMapping, lineKeys, MappingError, type LineIdentity, type MappingTarget } from '../../src/matching/mapping.ts';
import { addSupplierAlias, createSupplier, findSupplier } from '../../src/matching/suppliers.ts';
import { fileCatalogSource } from '../../src/square/catalog-source.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const ACTOR: AuditActor = { userId: null, username: 'go-live import' };

// ---- Inputs

export interface LineLabel {
  line: number;
  itemNumber: string;
  label: 'match' | 'not_for_resale' | 'new';
  variationId?: string;
  squareName?: string;
  sure: boolean;
  note?: string;
}

export interface LabelFile {
  catalogTakenAt?: string;
  suppliers?: { name: string; aliases: string[] }[];
  invoices: Record<string, LineLabel[]>;
}

export interface FishMatchRow {
  row: string;
  status: string;
  itemId?: string;
  variationId?: string;
}

export interface ImportInputs {
  catalog: { objects: unknown[]; locationId: string; takenAt: string };
  cards: ImportedCard[];
  labels: LabelFile;
  invoices: Pick<ExpectedInvoice, 'name' | 'supplier' | 'lines'>[];
  fish: FishMatchRow[] | null;
}

// ---- The report

export interface NotCarried {
  invoice: string;
  line: number;
  itemNumber: string;
  invoiceName: string;
  squareThen: string;
  squareNow: string;
  why: string;
}

export interface GoLiveReport {
  catalogLocation: string;
  catalogTakenAt: string;
  suppliers: { created: string[]; existing: string[] };
  matches: {
    carriedSquare: number;
    carriedNotForResale: number;
    alreadySaved: number;
    newItems: number;
    notCarried: NotCarried[];
    /** Carried, but the live item is not sold by weight as rule 12 needs: the next run fixes it. */
    byWeightToFix: Array<{ item: string; problems: string[] }>;
  };
  cards: ImportReport | null;
  fish: { checked: number; ok: number; problems: Array<{ row: string; why: string }> } | null;
}

function oneLine(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function supplierFor(db: Db, name: string, labels: LabelFile, report: GoLiveReport): number {
  const found = findSupplier(db, name);
  if (found) {
    if (!report.suppliers.existing.includes(found.name) && !report.suppliers.created.includes(found.name)) report.suppliers.existing.push(found.name);
    return found.id;
  }
  const group = labels.suppliers?.find((g) => [g.name, ...g.aliases].includes(name));
  const s = createSupplier(db, ACTOR, group?.name ?? name);
  report.suppliers.created.push(s.name);
  for (const alias of group?.aliases ?? []) if (!findSupplier(db, alias)) addSupplierAlias(db, ACTOR, s.id, alias);
  return findSupplier(db, name)?.id ?? s.id;
}

/** Why a confirmed match does not line up with the live catalog, or null when it does. */
export function matchProblem(index: CatalogIndex, l: LineLabel): { why: string; now: string } | null {
  const v = l.variationId ? index.variationById.get(l.variationId) : undefined;
  if (!v) return { why: 'The Square item is not in the live catalog.', now: '' };
  const item = index.itemById.get(v.itemId);
  if (!item) return { why: 'The Square item is not in the live catalog.', now: v.label };
  if (item.archived) return { why: 'The Square item is archived.', now: v.label };
  if (!item.availableHere || !v.availableHere) return { why: 'The Square item is not offered at the store location.', now: v.label };
  if (l.squareName && oneLine(v.label) !== oneLine(l.squareName)) return { why: 'Square now calls it something else. Check it is the same product.', now: v.label };
  return null;
}

/** Brings everything over, into db. Returns what happened and what did not line up. */
export function importInto(db: Db, inputs: ImportInputs, now: number): GoLiveReport {
  const index = buildCatalogIndex({ objects: inputs.catalog.objects, locationId: inputs.catalog.locationId });
  const report: GoLiveReport = {
    catalogLocation: inputs.catalog.locationId,
    catalogTakenAt: inputs.catalog.takenAt,
    suppliers: { created: [], existing: [] },
    matches: { carriedSquare: 0, carriedNotForResale: 0, alreadySaved: 0, newItems: 0, notCarried: [], byWeightToFix: [] },
    cards: null,
    fish: null,
  };
  const before = (db.prepare('SELECT count(*) AS n FROM item_mappings').get() as { n: number }).n;
  // A supplier line key carried once, with the target it got, so two labels that disagree are both held back.
  const seen = new Map<string, { target: string; at: string }>();
  const plans: Array<{ supplierId: number; identity: LineIdentity; target: MappingTarget; key: string; nc: NotCarried; byWeight?: { item: string; problems: string[] } }> = [];
  const conflicted = new Set<string>();

  for (const e of inputs.invoices) {
    const labels = inputs.labels.invoices[e.name];
    if (!labels) continue;
    const supplierId = supplierFor(db, e.supplier, inputs.labels, report);
    for (const l of labels) {
      const line = e.lines[l.line - 1];
      const nc: NotCarried = { invoice: e.name, line: l.line, itemNumber: l.itemNumber, invoiceName: oneLine([line?.description, line?.descriptionMore].filter(Boolean).join(' ')), squareThen: l.squareName ?? '', squareNow: '', why: '' };
      if (!line || line.itemNumber !== l.itemNumber) {
        report.matches.notCarried.push({ ...nc, why: `The label is for item ${l.itemNumber}, but the line is ${line?.itemNumber || 'missing'}.` });
        continue;
      }
      if (l.label === 'new') {
        report.matches.newItems++;
        continue;
      }
      if (!l.sure) {
        report.matches.notCarried.push({ ...nc, why: `Not confirmed in testing${l.note ? `: ${oneLine(l.note)}` : ''}.` });
        continue;
      }
      const identity: LineIdentity = { itemNumber: line.itemNumber, upc: line.upc, description: [line.description, line.descriptionMore].filter(Boolean).join(' | '), brand: line.brand };
      const keys = lineKeys(identity);
      if (!keys) {
        report.matches.notCarried.push({ ...nc, why: 'The line has no item number, UPC or description to save the match under.' });
        continue;
      }
      let target: MappingTarget;
      let byWeight: { item: string; problems: string[] } | undefined;
      if (l.label === 'not_for_resale') {
        target = { kind: 'not_for_resale' };
      } else {
        const p = matchProblem(index, l);
        if (p) {
          report.matches.notCarried.push({ ...nc, squareNow: p.now, why: p.why });
          continue;
        }
        const v = index.variationById.get(l.variationId!)!;
        nc.squareNow = v.label;
        target = { kind: 'square', variationId: v.id };
        const item = itemOf(index, v);
        if (item.byWeight.required && !item.byWeight.ok) byWeight = { item: v.label, problems: item.byWeight.problems };
      }
      const key = `${supplierId}|${keys.lineKey}`;
      const t = target.kind === 'square' ? target.variationId : 'not_for_resale';
      const prior = seen.get(key);
      if (prior && prior.target !== t) {
        conflicted.add(key);
        report.matches.notCarried.push({ ...nc, why: `Another test invoice (${prior.at}) matched the same supplier item to something else. Neither is carried. Pick it in the first live run.` });
        continue;
      }
      seen.set(key, { target: t, at: `${e.name} line ${l.line}` });
      plans.push({ supplierId, identity, target, key, nc, byWeight });
    }
  }
  const counted = new Set<string>();
  for (const p of plans) {
    if (conflicted.has(p.key)) {
      report.matches.notCarried.push({ ...p.nc, why: 'Another test invoice matched the same supplier item to something else. Neither is carried. Pick it in the first live run.' });
      continue;
    }
    try {
      // The same item on two test invoices is one saved match, with each wording kept.
      confirmMapping(db, ACTOR, { supplierId: p.supplierId, line: p.identity, target: p.target, catalog: index }, now);
      if (counted.has(p.key)) continue;
      counted.add(p.key);
      if (p.target.kind === 'square') report.matches.carriedSquare++;
      else report.matches.carriedNotForResale++;
      if (p.byWeight && !report.matches.byWeightToFix.some((b) => b.item === p.byWeight!.item)) report.matches.byWeightToFix.push(p.byWeight);
    } catch (err) {
      if (!(err instanceof MappingError)) throw err;
      report.matches.notCarried.push({ ...p.nc, why: err.message });
    }
  }
  const after = (db.prepare('SELECT count(*) AS n FROM item_mappings').get() as { n: number }).n;
  report.matches.alreadySaved = report.matches.carriedSquare + report.matches.carriedNotForResale - (after - before);

  // Cards, linked in the live catalog: sure links only; everything else is listed.
  if (inputs.cards.length) report.cards = importCards(db, ACTOR, { index, source: 'square_production' }, { cards: inputs.cards }, now);

  // The fish email matches: checked against the live catalog, never changed.
  if (inputs.fish) {
    const problems: Array<{ row: string; why: string }> = [];
    let checked = 0;
    for (const r of inputs.fish.filter((x) => x.status === 'confirmed')) {
      checked++;
      const item = r.itemId ? index.itemById.get(r.itemId) : undefined;
      if (!item) problems.push({ row: r.row, why: 'Its Square item is not in the live catalog.' });
      else if (item.archived) problems.push({ row: r.row, why: 'Its Square item is archived.' });
      else if (r.variationId && !index.variationById.get(r.variationId)) problems.push({ row: r.row, why: 'Its Square variation is not in the live catalog.' });
    }
    report.fish = { checked, ok: checked - problems.length, problems };
  }
  return report;
}

// ---- Words for Bart

/** One plain sentence: a capital first and a full stop last. */
function sentence(s: string): string {
  const t = oneLine(s);
  if (!t) return '';
  return `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}`;
}

function cardLines(title: string, list: readonly CardLinkProblem[]): string[] {
  if (!list.length) return [];
  const out = [``, `### ${title} (${list.length})`, ``];
  for (const p of list) {
    out.push(`- ${oneLine(p.name)}${p.producer ? `, ${oneLine(p.producer)}` : ''}${p.unit ? `, ${oneLine(p.unit)}` : ''}${p.printedCode ? `, printed code ${p.printedCode}` : ''}.`);
    for (const c of p.candidates.slice(0, 2)) out.push(`  - Maybe: ${oneLine(c.label)} (by ${c.method === 'scale_code' ? 'code' : 'name'}).`);
  }
  return out;
}

export function reportText(r: GoLiveReport, o: { mode: 'dry run' | 'applied'; at: string; dbPath: string; catalogPath: string }): string {
  const m = r.matches;
  const c = r.cards;
  const out: string[] = [
    `# Go-live import: ${o.mode === 'dry run' ? 'dry run, nothing was written' : 'applied'}`,
    ``,
    `- Made ${o.at}.`,
    `- Database: ${o.dbPath}.`,
    `- Live catalog: ${o.catalogPath}, taken ${r.catalogTakenAt}, location ${r.catalogLocation}. The Square location id in Settings must be this one, or the card links will not be used.`,
    ``,
    `## Suppliers`,
    ``,
    `- New: ${r.suppliers.created.length ? r.suppliers.created.join('; ') : 'none'}.`,
    `- Already there: ${r.suppliers.existing.length ? r.suppliers.existing.join('; ') : 'none'}.`,
    ``,
    `## Item matches`,
    ``,
    `- Carried over: ${m.carriedSquare} to a Square item, ${m.carriedNotForResale} not for resale.${m.alreadySaved > 0 ? ` ${m.alreadySaved} of them were already saved.` : ''}`,
    `- New items in testing, nothing to carry: ${m.newItems}.`,
    `- Not carried over: ${m.notCarried.length}. Each one asks a person again in its first live run.`,
  ];
  if (m.notCarried.length) {
    out.push(``, `### Not carried over, for Bart`, ``);
    for (const n of m.notCarried) {
      out.push(`- ${n.invoice}, line ${n.line}, item ${n.itemNumber || 'no number'}: ${n.invoiceName || 'no description'}.`);
      out.push(`  - Why: ${n.why}`);
      if (n.squareThen) out.push(`  - Square then: ${oneLine(n.squareThen)}.${n.squareNow && n.squareNow !== n.squareThen ? ` Square now: ${oneLine(n.squareNow)}.` : ''}`);
    }
  }
  if (m.byWeightToFix.length) {
    out.push(``, `### Carried over, but not sold by weight in Square yet (rule 12)`, ``, `The next run that touches each one switches it to sold by weight at the scale price, shown in review first.`, ``);
    for (const b of m.byWeightToFix) out.push(`- ${oneLine(b.item)}: ${b.problems.map(sentence).join(' ')}`);
  }
  out.push(``, `## Card copy`, ``);
  if (!c) {
    out.push(`- No cards to import.`);
  } else {
    const linked = c.linkedByCarry + c.linkedByCode + c.linkedByName;
    out.push(
      `- Cards: ${c.cards}. New ${c.created}, newer printing ${c.reimported}, unchanged ${c.unchanged}, edited and kept ${c.editedKept}, retired and kept ${c.retiredKept}.`,
      `- Linked to a live Square item: ${linked} (by scale code ${c.linkedByCode}, by name ${c.linkedByName}, carried ${c.linkedByCarry}), already linked ${c.alreadyLinked}.`,
      `- Not linked: ${c.toConfirm.length} to confirm, ${c.noCandidate.length} with nothing alike in Square, ${c.conflicts.length} in conflict, ${c.refused.length} refused. Their text is kept. A run links each one when its item comes up, with a person's yes.`,
    );
    out.push(...cardLines('To confirm', c.toConfirm), ...cardLines('Nothing alike in live Square', c.noCandidate), ...cardLines('In conflict with a card that holds the item', c.conflicts));
    if (c.refused.length) {
      out.push(``, `### Refused (${c.refused.length})`, ``);
      for (const x of c.refused) out.push(`- ${oneLine(x.name)}: ${oneLine(x.why)}`);
    }
  }
  out.push(``, `## Fish email matches (checked only, not changed)`, ``);
  if (!r.fish) out.push(`- No fish matches file was found.`);
  else {
    out.push(`- Confirmed rows checked: ${r.fish.checked}. In the live catalog: ${r.fish.ok}.`);
    for (const p of r.fish.problems) out.push(`- ${oneLine(p.row)}: ${p.why}`);
  }
  out.push(``);
  return out.join('\n');
}

// ---- The command

/** The arguments: words (apply) and name=value pairs. Two leading dashes are allowed and dropped. */
export function parseArgs(argv: readonly string[]): { words: Set<string>; values: Map<string, string> } {
  const words = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!.replace(/^--/, '');
    const eq = a.indexOf('=');
    if (eq > 0) values.set(a.slice(0, eq), a.slice(eq + 1));
    else if (argv[i]!.startsWith('--') && a !== 'apply' && i + 1 < argv.length) values.set(a, argv[++i]!);
    else words.add(a);
  }
  const known = new Set(['db', 'catalog', 'cards', 'labels', 'expected', 'fish', 'report', 'maxAgeHours', 'max-age-hours']);
  for (const k of values.keys()) if (!known.has(k)) throw new Error(`Unknown option ${k}. Use db, catalog, cards, labels, expected, fish, report or maxAgeHours.`);
  for (const w of words) if (w !== 'apply') throw new Error(`Unknown word ${w}. Use apply to write, or nothing for a dry run.`);
  return { words, values };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The ShelfReady server's own process, from the run folder's pid file or a scan of /proc. */
function serverProcess(dbPath: string): boolean {
  const pidFile = join(dirname(dbPath), 'run', 'server.pid');
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // Gone: a pid file left behind.
      }
    }
  }
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n) && Number(n) !== process.pid);
  } catch {
    return false;
  }
  for (const pid of pids) {
    let cmd = '';
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
    } catch {
      continue;
    }
    if (/(^|\/|\s)src\/server\/main\.ts(\s|$)/.test(cmd)) return true;
  }
  return false;
}

/**
 * True when another connection has the database open. In WAL mode an idle connection is enough to
 * stop an exclusive lock, so this sees a running server even between requests (tested).
 */
export function databaseInUse(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = new DatabaseSync(dbPath, { timeout: 0 });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
    return false;
  } catch {
    return true;
  } finally {
    db.close();
  }
}

/** True when ShelfReady, or anything else, may be using the database. */
export function serverRunning(dbPath: string): boolean {
  return serverProcess(dbPath) || databaseInUse(dbPath);
}

/** Holds the database for this connection alone until it closes, so the server cannot start meanwhile. */
function holdExclusive(db: Db): void {
  db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.exec('BEGIN EXCLUSIVE');
  db.exec('COMMIT');
}

const DRY_RUN_PREFIX = '.golive-dry-run-';

/** Removes dry run copies a hard kill left behind, more than an hour old. */
export function removeOldCopies(dataDir: string, now: number): void {
  let names: string[] = [];
  try {
    names = readdirSync(dataDir).filter((n) => n.startsWith(DRY_RUN_PREFIX));
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dataDir, n);
    try {
      if (now - statSync(p).mtimeMs > 3600_000) rmSync(p, { recursive: true, force: true });
    } catch {
      // Gone already.
    }
  }
}

/** A consistent copy of the database, read only from the original. */
function copyDatabase(from: string, to: string): void {
  const src = new DatabaseSync(from, { readOnly: true });
  try {
    src.prepare('VACUUM INTO ?').run(to);
  } finally {
    src.close();
  }
  chmodSync(to, 0o600);
}

/** base + ext, or base-2 + ext and so on: never an existing file. */
function freePath(base: string, ext: string): string {
  for (let i = 1; ; i++) {
    const p = `${base}${i === 1 ? '' : `-${i}`}${ext}`;
    if (!existsSync(p)) return p;
  }
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

export interface RunOptions {
  apply: boolean;
  dbPath: string;
  catalogPath: string;
  cardsPath: string;
  labelsPath: string;
  expectedDir: string;
  fishPath: string;
  reportPath?: string;
  maxAgeHours?: number;
  now?: () => number;
  /** Tests: say the server is not running. */
  serverRunning?: (dbPath: string) => boolean;
  /** Tests: called with the dry run's private folder once the copy is in it. */
  onCopy?: (dir: string) => void;
}

export interface RunResult {
  report: GoLiveReport;
  reportPath: string;
  backupPath: string | null;
}

export async function runImport(o: RunOptions): Promise<RunResult> {
  const now = (o.now ?? Date.now)();
  process.umask(0o077);
  if (!existsSync(o.catalogPath)) throw new Error(`No live catalog at ${o.catalogPath}. Take one first: node scripts/square/snapshot-live.ts`);
  // Read only, through the same checks the app's file source uses.
  const catalog: ImportInputs['catalog'] = await fileCatalogSource(o.catalogPath).load();
  const ageHours = (now - Date.parse(catalog.takenAt)) / 3600_000;
  const maxAge = o.maxAgeHours ?? 24;
  if (o.apply && !(ageHours <= maxAge)) {
    throw new Error(`The live catalog was taken ${catalog.takenAt}, more than ${maxAge} hours ago. Take a fresh one first: node scripts/square/snapshot-live.ts`);
  }
  const cards = existsSync(o.cardsPath) ? (readJson<{ cards: ImportedCard[] }>(o.cardsPath).cards ?? []) : [];
  const labels = existsSync(o.labelsPath) ? readJson<LabelFile>(o.labelsPath) : { invoices: {} };
  const invoices = existsSync(o.expectedDir)
    ? readdirSync(o.expectedDir).filter((n) => n.endsWith('.json')).sort().map((n) => readJson<ExpectedInvoice>(join(o.expectedDir, n)))
    : [];
  const fish = existsSync(o.fishPath) ? (readJson<{ rows?: FishMatchRow[] }>(o.fishPath).rows ?? []) : null;
  const inputs: ImportInputs = { catalog, cards, labels, invoices, fish };

  let report: GoLiveReport;
  let backupPath: string | null = null;
  if (o.apply) {
    if ((o.serverRunning ?? serverRunning)(o.dbPath)) throw new Error('ShelfReady is running. Stop it first (scripts/net/service.sh stop), then run this again.');
    if (existsSync(o.dbPath)) {
      backupPath = freePath(join(dirname(o.dbPath), `shelfready-before-golive-import-${stamp(now)}`), '.sqlite3');
      copyDatabase(o.dbPath, backupPath);
    }
    const db = openDatabase(o.dbPath);
    try {
      // From here to the end the database is ours alone: a server started meanwhile cannot open it.
      holdExclusive(db);
      report = importInto(db, inputs, now);
    } finally {
      db.close();
    }
  } else {
    // The dry run: the same work on a private copy, in a mode 700 folder in the data folder (store
    // data, out of git), removed afterwards, and on Ctrl-C or a stop signal too.
    const dataDir = dirname(o.dbPath);
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    removeOldCopies(dataDir, now);
    const tmp = mkdtempSync(join(dataDir, DRY_RUN_PREFIX));
    chmodSync(tmp, 0o700);
    const cleanup = (): void => rmSync(tmp, { recursive: true, force: true });
    const onSignal = (signal: NodeJS.Signals): void => {
      cleanup();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    try {
      const copy = join(tmp, 'copy.sqlite3');
      if (existsSync(o.dbPath)) copyDatabase(o.dbPath, copy);
      o.onCopy?.(tmp);
      const db = openDatabase(copy);
      try {
        report = importInto(db, inputs, now);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
  const reportPath = o.reportPath ?? freePath(join(dirname(o.dbPath), 'golive', `import-report-${o.apply ? 'applied' : 'dry-run'}-${stamp(now)}`), '.md');
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, reportText(report, { mode: o.apply ? 'applied' : 'dry run', at: new Date(now).toISOString(), dbPath: o.dbPath, catalogPath: o.catalogPath }), { mode: 0o600 });
  return { report, reportPath, backupPath };
}

async function main(argv: readonly string[]): Promise<void> {
  const { words, values } = parseArgs(argv);
  const { loadConfig } = await import('../../src/server/config.ts');
  const dbPath = resolve(values.get('db') ?? loadConfig().dbPath);
  const apply = words.has('apply');
  const maxAge = values.get('maxAgeHours') ?? values.get('max-age-hours');
  const r = await runImport({
    apply,
    dbPath,
    catalogPath: resolve(values.get('catalog') ?? join(REPO, 'data/square/live-catalog.json')),
    cardsPath: resolve(values.get('cards') ?? join(REPO, 'data/cards/imported.json')),
    labelsPath: resolve(values.get('labels') ?? join(REPO, 'test-invoices/matching-labels.json')),
    expectedDir: resolve(values.get('expected') ?? join(REPO, 'test-invoices/expected')),
    fishPath: resolve(values.get('fish') ?? join(REPO, 'data/mailchimp/fish-matches.json')),
    reportPath: values.has('report') ? resolve(values.get('report')!) : undefined,
    maxAgeHours: maxAge === undefined ? undefined : Number(maxAge),
  });
  const m = r.report.matches;
  const c = r.report.cards;
  console.log(apply ? 'Applied.' : 'Dry run: nothing was written to the database.');
  if (r.backupPath) console.log(`Backup first: ${r.backupPath}`);
  console.log(`Suppliers: ${r.report.suppliers.created.length} new, ${r.report.suppliers.existing.length} already there.`);
  console.log(`Item matches: ${m.carriedSquare + m.carriedNotForResale} carried, ${m.notCarried.length} not carried, ${m.newItems} new in testing.`);
  if (c) console.log(`Cards: ${c.cards}, linked ${c.linkedByCarry + c.linkedByCode + c.linkedByName}, not linked ${c.toConfirm.length + c.noCandidate.length + c.conflicts.length}.`);
  if (r.report.fish) console.log(`Fish email matches: ${r.report.fish.ok} of ${r.report.fish.checked} in the live catalog.`);
  console.log(`Report: ${r.reportPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'The import failed.');
    process.exit(1);
  });
}
