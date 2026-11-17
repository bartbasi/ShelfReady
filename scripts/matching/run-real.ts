// Runs the matcher over the hand-made readings of the real test invoices, against the saved
// copy of the live Square catalog, and scores it against hand-made labels. No API calls.
//
// Everything it reads is store data kept out of git: the catalog under data/, the readings and
// the labels under test-invoices/. It writes nothing. The database is in memory.
//
// Modes:
//   empty   no saved mapping: what a first invoice from each supplier looks like
//   others  each invoice with the labels of the other invoices saved: the mapping growing
//   labels  every label saved as a mapping: the saved mapping alone
// Then three misread tests, with the labels of every invoice from the same supplier saved:
//   last character   each saved line read with the last character of its item number changed
//   collisions       each saved line read with every other saved item number one character away
//                    (or the same with O as 0), as a misread that lands on another saved item
//   any other number each saved line read with every other saved item number of the supplier
// Each such line should be flagged as a possible misread (so the fallback model reads the
// invoice again) and never matched to another item. The target is 0 wrong.
//
// Usage: node scripts/matching/run-real.ts [--verbose] [--catalog FILE] [--labels FILE]

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditActor } from '../../src/db/audit.ts';
import { openDatabase, type Db } from '../../src/db/db.ts';
import { checkReading } from '../../src/invoice/checks.ts';
import { expectedAsModelInvoice, validateExpected, type ExpectedInvoice } from '../../src/invoice/expected.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../../src/invoice/settings.ts';
import type { CheckedReading } from '../../src/invoice/types.ts';
import { buildCatalogIndex, type CatalogIndex } from '../../src/matching/catalog.ts';
import { knownItemLookup } from '../../src/matching/known-item.ts';
import { confirmMapping } from '../../src/matching/mapping.ts';
import { matchReading, type LineMatch } from '../../src/matching/matcher.ts';
import { addSupplierAlias, createSupplier, findSupplier, supplierKey } from '../../src/matching/suppliers.ts';
import { withinOneEdit } from '../../src/matching/text.ts';
import { normalizeItemNumber } from '../../src/invoice/item-number.ts';
import { loadExpected } from '../invoice/validate-expected.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export interface LineLabel {
  /** 1-based line number in the expected reading. */
  line: number;
  /** The item number as printed, to catch a label that drifted from its line. */
  itemNumber: string;
  label: 'match' | 'not_for_resale' | 'new';
  variationId?: string;
  /** The Square label when this was decided, to spot a catalog that changed since. */
  squareName?: string;
  /** False when Bart must confirm the label. */
  sure: boolean;
  note?: string;
}

export interface LabelFile {
  about: string;
  catalogTakenAt: string;
  /** Names one supplier prints, when the readings spell it more than one way. */
  suppliers?: { name: string; aliases: string[] }[];
  invoices: Record<string, LineLabel[]>;
}

const ACTOR: AuditActor = { userId: null, username: 'labels' };

function ensureSupplier(db: Db, name: string, labels: LabelFile): number {
  const found = findSupplier(db, name);
  if (found) return found.id;
  const group = labels.suppliers?.find((g) => [g.name, ...g.aliases].some((n) => n === name));
  const s = createSupplier(db, ACTOR, group?.name ?? name);
  for (const alias of group?.aliases ?? []) if (!findSupplier(db, alias)) addSupplierAlias(db, ACTOR, s.id, alias);
  return findSupplier(db, name)?.id ?? s.id;
}

/** Saves the labels of these invoices as confirmed mappings. */
function saveLabels(db: Db, index: CatalogIndex, labels: LabelFile, invoices: ExpectedInvoice[]): void {
  for (const e of invoices) {
    const supplierId = ensureSupplier(db, e.supplier, labels);
    for (const l of labels.invoices[e.name] ?? []) {
      const line = e.lines[l.line - 1];
      if (!line || l.label === 'new') continue;
      const identity = { itemNumber: line.itemNumber, upc: line.upc, description: [line.description, line.descriptionMore].filter(Boolean).join(' | '), brand: line.brand };
      const target = l.label === 'match' ? { kind: 'square' as const, variationId: l.variationId ?? '' } : { kind: 'not_for_resale' as const };
      confirmMapping(db, ACTOR, { supplierId, line: identity, target, catalog: index });
    }
  }
}

interface Tally {
  lines: number;
  matchRight: number;
  matchWrong: number;
  pickRight1: number;
  pickRightLower: number;
  pickWithoutRight: number;
  newForMatch: number;
  nfrRight: number;
  nfrOther: number;
  newRight: number;
  newOffered: number;
  newMatched: number;
  misreadFlags: number;
  blockingFailures: number;
}

function emptyTally(): Tally {
  return { lines: 0, matchRight: 0, matchWrong: 0, pickRight1: 0, pickRightLower: 0, pickWithoutRight: 0, newForMatch: 0, nfrRight: 0, nfrOther: 0, newRight: 0, newOffered: 0, newMatched: 0, misreadFlags: 0, blockingFailures: 0 };
}

function score(t: Tally, m: LineMatch, l: LineLabel): string {
  t.lines++;
  if ((m.status === 'candidates' || m.status === 'new_item') && m.possibleMisread) t.misreadFlags++;
  if (l.label === 'match') {
    if (m.status === 'matched') return m.match.variationId === l.variationId ? (t.matchRight++, 'right') : (t.matchWrong++, 'WRONG');
    if (m.status === 'candidates') {
      const at = m.candidates.findIndex((c) => c.variationId === l.variationId);
      if (at === 0) return (t.pickRight1++, 'pick, right one first');
      if (at > 0) return (t.pickRightLower++, `pick, right one at ${at + 1}`);
      return (t.pickWithoutRight++, 'pick, right one MISSING');
    }
    if (m.status === 'new_item') return (t.newForMatch++, 'new, but it is in Square');
    return (t.matchWrong++, 'WRONG: not for resale');
  }
  if (l.label === 'not_for_resale') return m.status === 'not_for_resale' ? (t.nfrRight++, 'right') : (t.nfrOther++, `needs a person (${m.status})`);
  if (m.status === 'new_item') return (t.newRight++, 'right');
  if (m.status === 'candidates') return (t.newOffered++, 'offered candidates for a new item');
  return (t.newMatched++, `WRONG: ${m.status}`);
}

function describe(m: LineMatch): string {
  if (m.status === 'matched') return `matched (${m.method}) ${m.match.label}`;
  if (m.status === 'not_for_resale') return 'not for resale';
  if (m.status === 'new_item') return `new item${m.possibleMisread ? ' MISREAD?' : ''}`;
  return `candidates${m.possibleMisread ? ' MISREAD?' : ''}: ${m.candidates.map((c) => `${c.label} [${c.method} ${c.score}]`).join(' | ')}`;
}

function printTally(mode: string, t: Tally): void {
  const pct = (n: number, d: number) => (d ? ` (${Math.round((100 * n) / d)}%)` : '');
  const toMatch = t.matchRight + t.matchWrong + t.pickRight1 + t.pickRightLower + t.pickWithoutRight + t.newForMatch;
  console.log(`\n== ${mode}: ${t.lines} lines`);
  console.log(`  In Square (${toMatch}): matched right ${t.matchRight}${pct(t.matchRight, toMatch)}, matched WRONG ${t.matchWrong},`);
  console.log(`    to pick with the right one first ${t.pickRight1}, lower in the list ${t.pickRightLower}, missing from the list ${t.pickWithoutRight}, called new ${t.newForMatch}`);
  console.log(`  Not for resale (${t.nfrRight + t.nfrOther}): marked ${t.nfrRight}, left for a person ${t.nfrOther}`);
  console.log(`  New (${t.newRight + t.newOffered + t.newMatched}): called new ${t.newRight}, offered candidates ${t.newOffered}, matched WRONG ${t.newMatched}`);
  console.log(`  Misread flags on clean readings: ${t.misreadFlags}. Readings blocked by the misread check: ${t.blockingFailures}.`);
}

/** Two labels that point at the same thing, so reading one line as the other is no mistake. */
function sameTarget(a: LineLabel, b: LineLabel): boolean {
  return a.label === b.label && (a.label === 'not_for_resale' || a.variationId === b.variationId);
}

/** The item number with its last character changed, as a misread would. */
function misreadLast(itemNumber: string): string {
  const last = itemNumber.slice(-1);
  const next = /\d/.test(last) ? String((Number(last) + 1) % 10) : last.toUpperCase() === 'Z' ? 'A' : String.fromCharCode(last.toUpperCase().charCodeAt(0) + 1);
  return `${itemNumber.slice(0, -1)}${next}`;
}

async function main(): Promise<void> {
  const catalogPath = arg('--catalog') ?? join(repo, 'data/square/live-catalog.json');
  const labelsPath = arg('--labels') ?? join(repo, 'test-invoices/matching-labels.json');
  const verbose = process.argv.includes('--verbose');
  if (!existsSync(catalogPath)) throw new Error(`No catalog at ${catalogPath}. Run scripts/square/snapshot-live.ts first.`);
  const raw = JSON.parse(await readFile(catalogPath, 'utf8')) as { objects: unknown[]; location?: { id?: string }; takenAt?: string };
  const index = buildCatalogIndex({ objects: raw.objects, locationId: raw.location?.id ?? '' });
  const labels: LabelFile = existsSync(labelsPath) ? (JSON.parse(await readFile(labelsPath, 'utf8')) as LabelFile) : { about: '', catalogTakenAt: '', invoices: {} };
  const invoices = await loadExpected();
  const today = new Date();

  console.log(`Catalog: ${index.items.length} items, ${index.variations.length} variations, ${index.byScaleCode.size} scale codes, ${index.notes.length} data notes.`);
  if (labels.catalogTakenAt && raw.takenAt && labels.catalogTakenAt !== raw.takenAt) console.log(`Note: the labels were made against the catalog of ${labels.catalogTakenAt}; this one is from ${raw.takenAt}.`);

  // Labels that no longer fit their line or the catalog are reported, not scored.
  const problems: string[] = [];
  for (const e of invoices) {
    const ls = labels.invoices[e.name] ?? [];
    if (ls.length !== e.lines.length) problems.push(`${e.name}: ${ls.length} labels for ${e.lines.length} lines`);
    for (const l of ls) {
      const line = e.lines[l.line - 1];
      if (!line || line.itemNumber !== l.itemNumber) problems.push(`${e.name} line ${l.line}: the label is for item ${l.itemNumber}, the line is ${line?.itemNumber ?? 'missing'}`);
      if (l.label === 'match') {
        const v = l.variationId ? index.variationById.get(l.variationId) : undefined;
        if (!v) problems.push(`${e.name} line ${l.line}: the labelled Square variation is not in the catalog`);
        else if (l.squareName && v.label !== l.squareName) problems.push(`${e.name} line ${l.line}: Square now calls it ${v.label}`);
      }
    }
  }
  for (const p of problems) console.log(`LABEL PROBLEM: ${p}`);

  const readings = new Map<string, CheckedReading>(invoices.map((e) => [e.name, validateExpected(e, today).reading]));
  for (const mode of ['empty', 'others', 'labels'] as const) {
    const t = emptyTally();
    for (const e of invoices) {
      const db = openDatabase(':memory:');
      try {
        if (mode === 'labels') saveLabels(db, index, labels, [e]);
        if (mode === 'others') saveLabels(db, index, labels, invoices.filter((x) => x.name !== e.name));
        const reading = readings.get(e.name)!;
        const result = matchReading({ db, index }, reading);
        const checked = checkReading(expectedAsModelInvoice(e), { settings: DEFAULT_INVOICE_SETTINGS, today, imagesSent: e.images.length, knownItem: knownItemLookup({ db, index }) });
        if (checked.failed.some((c) => c.id === 'misread_codes')) t.blockingFailures++;
        if (verbose) console.log(`\n-- ${mode} / ${e.name} (supplier ${result.supplier.status})`);
        for (const m of result.lines) {
          const l = labels.invoices[e.name]?.find((x) => x.line === m.n);
          const verdict = l ? score(t, m, l) : 'no label';
          if (verbose) console.log(`  ${String(m.n).padStart(2)} ${verdict.padEnd(26)} ${describe(m)}`);
        }
      } finally {
        db.close();
      }
    }
    printTally(mode, t);
  }
  // Misread tests, with every label from the same supplier saved.
  const bySupplier = new Map<string, ExpectedInvoice[]>();
  for (const e of invoices) {
    const key = supplierKey(labels.suppliers?.find((g) => [g.name, ...g.aliases].includes(e.supplier))?.name ?? e.supplier);
    bySupplier.set(key, [...(bySupplier.get(key) ?? []), e]);
  }
  const misreadTally = { last: { tried: 0, flagged: 0, wrong: 0 }, collision: { tried: 0, flagged: 0, wrong: 0 }, any: { tried: 0, flagged: 0, wrong: 0 } };
  for (const group of bySupplier.values()) {
    const db = openDatabase(':memory:');
    try {
      saveLabels(db, index, labels, group);
      const savedNumbers = group.flatMap((e) =>
        (labels.invoices[e.name] ?? []).filter((l) => l.label !== 'new' && e.lines[l.line - 1]!.itemNumber !== '').map((l) => ({ number: e.lines[l.line - 1]!.itemNumber, label: l })),
      );
      for (const e of group) {
        for (const l of labels.invoices[e.name] ?? []) {
          const own = e.lines[l.line - 1]!.itemNumber;
          if (l.label === 'new' || own === '') continue;
          const asRead: { kind: 'last' | 'collision' | 'any'; number: string }[] = [{ kind: 'last', number: misreadLast(own) }];
          for (const other of savedNumbers) {
            const a = normalizeItemNumber(other.number);
            const b = normalizeItemNumber(own);
            if (other.number === own || sameTarget(other.label, l) || asRead.some((x) => x.number === other.number)) continue;
            asRead.push({ kind: a === b || withinOneEdit(a, b) ? 'collision' : 'any', number: other.number });
          }
          for (const read of asRead) {
            const changed: ExpectedInvoice = { ...e, lines: e.lines.map((x, i) => (i === l.line - 1 ? { ...x, itemNumber: read.number } : x)) };
            const m = matchReading({ db, index }, validateExpected(changed, today).reading).lines[l.line - 1]!;
            const t = misreadTally[read.kind];
            t.tried++;
            const flaggedNow = (m.status === 'candidates' || m.status === 'new_item') && m.possibleMisread;
            const wrongNow = (m.status === 'matched' && (l.label !== 'match' || m.match.variationId !== l.variationId)) || (m.status === 'not_for_resale' && l.label !== 'not_for_resale');
            if (flaggedNow) t.flagged++;
            if (wrongNow) t.wrong++;
            if (verbose && !flaggedNow) console.log(`  ${read.kind} test ${e.name} line ${l.line} read as ${read.number}: ${wrongNow ? 'WRONG ' : ''}${describe(m)}`);
          }
        }
      }
    } finally {
      db.close();
    }
  }
  const titles = {
    last: ['last character', 'saved item numbers with the last character changed'],
    collision: ['collisions', 'saved lines read with another saved number one character away'],
    any: ['any other number', 'saved lines read with a saved number further away'],
  } as const;
  for (const [kind, t] of Object.entries(misreadTally) as [keyof typeof titles, { tried: number; flagged: number; wrong: number }][]) {
    console.log(`\n== misread test, ${titles[kind][0]}: ${t.tried} ${titles[kind][1]}: ${t.flagged} flagged as a possible misread, ${t.wrong} matched WRONG, ${t.tried - t.flagged - t.wrong} left for a person without the flag.`);
  }

  const unsure = Object.entries(labels.invoices).flatMap(([name, ls]) => ls.filter((l) => !l.sure).map((l) => `${name} line ${l.line}: ${l.note ?? ''}`));
  if (unsure.length) {
    console.log(`\nLabels for Bart to confirm (${unsure.length}):`);
    for (const u of unsure) console.log(`  ${u}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

