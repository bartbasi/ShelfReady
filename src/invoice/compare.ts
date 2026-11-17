// Compares a model's checked reading with the hand-made ground truth, field by field, for the
// test-invoice scorecard. Lines are paired by item number, amount and description, not by
// position, so one missed line does not make every later line look wrong. Item numbers pair
// by the matching key (letter O as zero), but are scored on their exact text: a letter read as
// a digit counts as wrong.

import { lineLabel, parseInvoiceDate } from './checks.ts';
import { normalizeItemNumber } from './item-number.ts';
import { compareDecimal, parseCents, parseDecimal, formatCents } from './money.ts';
import type { ExpectedInvoice, ExpectedLine } from './expected.ts';
import type { CheckedLine, CheckedReading } from './types.ts';

export interface FieldDiff {
  where: string;
  field: string;
  expected: string;
  got: string;
}

export interface Scorecard {
  name: string;
  linesExpected: number;
  linesFound: number;
  linesMatched: number;
  missingLines: string[];
  extraLines: string[];
  fieldsCompared: number;
  wrong: FieldDiff[];
  duplicatePagesExpected: number[];
  duplicatePagesFound: number[];
}

/** Item numbers as printed: exact, apart from spaces and letter case. */
function exactItem(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

function words(s: string): string[] {
  return s.toUpperCase().replace(/[^A-Z0-9%#]+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Share of the expected words found in the reading. */
export function wordCoverage(expected: string, got: string): number {
  const want = words(expected);
  if (want.length === 0) return 1;
  const have = new Set(words(got));
  return want.filter((w) => have.has(w)).length / want.length;
}

function sameNumber(a: string, b: string, emptyIsZero: boolean): boolean {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  const za = da === null || (emptyIsZero && da.units === 0);
  const zb = db === null || (emptyIsZero && db.units === 0);
  if (emptyIsZero && za && zb) return true;
  if (da === null || db === null) return da === db && a.trim() === b.trim();
  return compareDecimal(da, db) === 0;
}

function pairScore(e: ExpectedLine, g: CheckedLine): number {
  let score = 0;
  if (e.itemNumber && normalizeItemNumber(e.itemNumber) === normalizeItemNumber(g.line.item_number)) score += 4;
  const ec = parseCents(e.extension);
  if (ec !== null && ec === g.extensionCents) score += 3;
  if (e.unitPrice && sameNumber(e.unitPrice, g.line.unit_price, false)) score += 1;
  score += 2 * wordCoverage(e.description, g.line.description);
  return score;
}

export function compareReading(expected: ExpectedInvoice, reading: CheckedReading): Scorecard {
  const got = reading.lines;
  const pairs: Array<{ e: number; g: number; score: number }> = [];
  expected.lines.forEach((e, ei) =>
    got.forEach((g, gi) => {
      const score = pairScore(e, g);
      if (score >= 3) pairs.push({ e: ei, g: gi, score });
    }),
  );
  pairs.sort((a, b) => b.score - a.score || a.e - b.e);
  const eUsed = new Map<number, number>();
  const gUsed = new Set<number>();
  for (const p of pairs) {
    if (eUsed.has(p.e) || gUsed.has(p.g)) continue;
    eUsed.set(p.e, p.g);
    gUsed.add(p.g);
  }

  const wrong: FieldDiff[] = [];
  let compared = 0;
  const cmp = (where: string, field: string, exp: string, g: string, ok: boolean) => {
    compared++;
    if (!ok) wrong.push({ where, field, expected: exp, got: g });
  };

  expected.lines.forEach((e, ei) => {
    const gi = eUsed.get(ei);
    if (gi === undefined) return;
    const g = got[gi]!;
    const l = g.line;
    const where = `line ${ei + 1} ${e.itemNumber || e.description}`.trim();
    cmp(where, 'item number', e.itemNumber, l.item_number, exactItem(e.itemNumber) === exactItem(l.item_number));
    if (e.upc || l.upc) cmp(where, 'upc', e.upc, l.upc, e.upc.replace(/\D/g, '') === l.upc.replace(/\D/g, ''));
    cmp(where, 'description', e.description, l.description, wordCoverage(e.description, l.description) >= 0.8);
    cmp(where, 'qty shipped', e.qtyShipped, l.qty_shipped, sameNumber(e.qtyShipped, l.qty_shipped, false));
    cmp(where, 'unit', e.unit, l.unit, e.unit.trim().toUpperCase() === l.unit.trim().toUpperCase());
    cmp(where, 'weight', e.weight, l.weight, sameNumber(e.weight, l.weight, true));
    cmp(where, 'unit price', e.unitPrice, l.unit_price, sameNumber(e.unitPrice, l.unit_price, false));
    cmp(where, 'allowance', e.allowance, l.allowance, sameNumber(e.allowance, l.allowance, true));
    cmp(where, 'amount', e.extension, l.extension, sameNumber(e.extension, l.extension, false));
    cmp(where, 'received', e.received, g.received, e.received === g.received);
    if (e.brand) cmp(where, 'brand', e.brand, l.brand, wordCoverage(e.brand, l.brand) >= 0.5 || wordCoverage(e.brand, l.description) >= 1);
    if (e.packSize) cmp(where, 'pack size', e.packSize, l.pack_size, words(e.packSize).join('') === words(l.pack_size).join(''));
    if (e.unitsPerPack) cmp(where, 'units per pack', e.unitsPerPack, l.units_per_pack, sameNumber(e.unitsPerPack, l.units_per_pack, false));
  });

  const inv = reading.invoice;
  const head = 'invoice';
  cmp(head, 'invoice number', expected.invoiceNumber, inv.invoice_number, expected.invoiceNumber.replace(/\s/g, '') === inv.invoice_number.replace(/\s/g, ''));
  const d = parseInvoiceDate(inv.invoice_date_iso, inv.invoice_date);
  cmp(head, 'date', expected.invoiceDate, d ? d.toISOString().slice(0, 10) : inv.invoice_date, d?.toISOString().slice(0, 10) === expected.invoiceDate);
  cmp(head, 'total', expected.total, inv.total, sameNumber(expected.total, inv.total, false));
  cmp(head, 'previous balance', expected.previousBalance, inv.previous_balance, sameNumber(expected.previousBalance, inv.previous_balance, true));
  cmp(head, 'subtotal', expected.subtotal, inv.subtotal, sameNumber(expected.subtotal, inv.subtotal, true));
  cmp(head, 'tax', expected.tax, inv.tax, sameNumber(expected.tax, inv.tax, true));
  const expCharges = expected.charges.reduce((s, c) => s + (parseCents(c.amount) ?? 0), 0);
  cmp(head, 'charges total', formatCents(expCharges), formatCents(reading.chargesTotalCents ?? 0), expCharges === (reading.chargesTotalCents ?? 0));
  cmp(head, 'printed total quantity', expected.printedTotalQuantity, inv.printed_total_quantity, sameNumber(expected.printedTotalQuantity, inv.printed_total_quantity, true));

  const dupExpected = expected.pages.filter((p) => p.samePageAs > 0).map((p) => p.image);
  cmp(head, 'repeated page photos', dupExpected.join(',') || 'none', reading.duplicateImages.join(',') || 'none', dupExpected.join(',') === reading.duplicateImages.join(','));

  return {
    name: expected.name,
    linesExpected: expected.lines.length,
    linesFound: got.length,
    linesMatched: eUsed.size,
    missingLines: expected.lines.flatMap((e, i) => (eUsed.has(i) ? [] : [`line ${i + 1} ${e.itemNumber} ${e.description} ${e.extension}`])),
    extraLines: got.flatMap((g, i) => (gUsed.has(i) ? [] : [`${lineLabel(g.n, g.line)} ${g.line.extension}`])),
    fieldsCompared: compared,
    wrong,
    duplicatePagesExpected: dupExpected,
    duplicatePagesFound: reading.duplicateImages,
  };
}
