// What arrived, the stock it gives, and the credit to claim (store/docs/DECISIONS.md, "What arrived").
//
// - Every line has What arrived: all (the default), none, or some. Some is entered as pieces for
//   packaged goods and as pounds for by-weight goods, never one compared with the other.
// - A zero quantity or "Out" on the invoice starts as none. A note starts as the note says, for
//   a person to confirm. A line printed as short starts unclear.
// - Only what arrived goes to stock, set as the figure replacing what Square shows (cc-case-cards
//   skill). Sold by weight: pounds, never the piece count. Sold by the unit: pieces.
// - What was charged but not delivered is a credit to claim, worked out in the same unit as what
//   arrived: pounds against pounds shipped, pieces against pieces shipped.

import type { CheckedLine, ModelInvoice } from '../invoice/types.ts';
import { parseInvoiceDate } from '../invoice/checks.ts';
import { add, cmp, div, floor, fromInt, isInteger, mul, parseRat, rat, sub, toDecimalText, ZERO, type Rat } from '../pricing/rational.ts';

/** A person's answer. pieces for packaged goods, pounds for by-weight goods. */
export type Arrived = { arrived: 'all' } | { arrived: 'none' } | { arrived: 'some'; pieces?: string; pounds?: string };

export interface Arrival {
  arrived: 'all' | 'none' | 'some' | 'unclear';
  pieces: Rat | null;
  pounds: Rat | null;
  /** default: nothing printed; invoice: a zero quantity or Out; note: a note on the line; person: decided in review. */
  source: 'default' | 'invoice' | 'note' | 'person';
  /** A note set it, and a person has not confirmed it yet. */
  toConfirm: boolean;
}

const POUND_UNITS = new Set(['LB', 'LBS', '#']);

function zero(r: Rat | null): boolean {
  return r !== null && cmp(r, ZERO) === 0;
}

function positive(r: Rat | null): r is Rat {
  return r !== null && cmp(r, ZERO) > 0;
}

export function arrivalOf(cl: CheckedLine, decision: Arrived | null): Arrival {
  if (decision) {
    if (decision.arrived === 'some') {
      return { arrived: 'some', pieces: parseRat(decision.pieces ?? ''), pounds: parseRat(decision.pounds ?? ''), source: 'person', toConfirm: false };
    }
    return { arrived: decision.arrived, pieces: null, pounds: null, source: 'person', toConfirm: false };
  }
  const qty = parseRat(cl.line.qty_shipped);
  const weight = parseRat(cl.line.weight);
  if (cl.line.printed_status === 'out_of_stock' || (zero(qty) && !positive(weight))) {
    return { arrived: 'none', pieces: null, pounds: null, source: 'invoice', toConfirm: false };
  }
  if (cl.received === 'no') return { arrived: 'none', pieces: null, pounds: null, source: 'note', toConfirm: true };
  if (cl.received === 'check') return { arrived: 'unclear', pieces: null, pounds: null, source: 'note', toConfirm: true };
  return { arrived: 'all', pieces: null, pounds: null, source: 'default', toConfirm: false };
}

/** Pounds the invoice shipped: the weight, or the quantity when it is counted in pounds. */
export function shippedPounds(cl: CheckedLine): Rat | null {
  const w = parseRat(cl.line.weight);
  if (positive(w)) return w;
  if (POUND_UNITS.has(cl.line.unit.trim().toUpperCase())) return parseRat(cl.line.qty_shipped);
  return null;
}

/** Sellable pieces the invoice shipped, when they can be counted. */
export function shippedPieces(cl: CheckedLine, poundsPerUnit: Rat | null): Rat | null {
  const qty = parseRat(cl.line.qty_shipped);
  switch (cl.pack.pricePer) {
    case 'case':
      return qty !== null && cl.pack.unitsPerCase !== null && cl.pack.sure ? mul(qty, fromInt(cl.pack.unitsPerCase)) : null;
    case 'unit':
      return qty;
    case 'lb': {
      const lb = shippedPounds(cl);
      return lb !== null && positive(poundsPerUnit) ? div(lb, poundsPerUnit) : null;
    }
    case 'unclear':
      return null;
  }
}

export type StockResult = { ok: true; quantity: Rat; text: string; unit: 'lb' | 'unit'; how: string } | { ok: false; problem: string };

/** The stock count to set for one line, in pounds (by weight) or pieces. */
export function stockFromLine(cl: CheckedLine, byWeight: boolean, arrival: Arrival, poundsPerUnit: Rat | null = null): StockResult {
  if (arrival.arrived === 'none') return { ok: true, quantity: ZERO, text: '0', unit: byWeight ? 'lb' : 'unit', how: 'Nothing arrived.' };
  if (arrival.arrived === 'unclear') return { ok: false, problem: 'It is not clear how much of this line arrived.' };
  if (byWeight) {
    let pounds: Rat | null;
    let how: string;
    if (arrival.arrived === 'some') {
      pounds = arrival.pounds;
      how = 'Pounds that arrived, entered in review.';
      if (pounds === null || cmp(pounds, ZERO) <= 0) return { ok: false, problem: 'This item is sold by weight: enter the pounds that arrived.' };
    } else {
      pounds = shippedPounds(cl);
      how = `Pounds on the invoice, ${pounds ? toDecimalText(pounds, 3).text : ''} lb.`;
      if (pounds === null || cmp(pounds, ZERO) < 0) return { ok: false, problem: 'This item is sold by weight, but no weight is printed on the line, so the stock cannot be set from it.' };
    }
    return { ok: true, quantity: pounds, text: toDecimalText(pounds, 3).text, unit: 'lb', how };
  }
  let pieces: Rat | null;
  let how: string;
  if (arrival.arrived === 'some') {
    pieces = arrival.pieces;
    how = 'Pieces that arrived, entered in review.';
    if (pieces === null || cmp(pieces, ZERO) <= 0) return { ok: false, problem: 'This item is sold by the piece: enter the pieces that arrived.' };
  } else {
    pieces = shippedPieces(cl, poundsPerUnit);
    if (pieces === null) {
      if (cl.pack.pricePer === 'case') return { ok: false, problem: 'The units per case are not certain, so the unit count is not known.' };
      if (cl.pack.pricePer === 'lb') return { ok: false, problem: 'The invoice sells this by the pound, but Square sells it by the unit, so the weight of one unit is needed.' };
      if (cl.pack.pricePer === 'unclear') return { ok: false, problem: 'It is not clear whether this line counts cases or units.' };
      return { ok: false, problem: 'No quantity shipped was read for this line.' };
    }
    how =
      cl.pack.pricePer === 'case'
        ? `${cl.line.qty_shipped} cases of ${cl.pack.unitsPerCase}.`
        : cl.pack.pricePer === 'lb'
          ? `${toDecimalText(shippedPounds(cl)!, 3).text} lb at ${toDecimalText(poundsPerUnit!, 4).text} lb per unit.`
          : `${cl.line.qty_shipped} units shipped.`;
  }
  if (cmp(pieces, ZERO) < 0) return { ok: false, problem: 'No quantity shipped was read for this line.' };
  if (!isInteger(pieces)) return { ok: false, problem: `The unit count works out to ${toDecimalText(pieces, 3).text}, not a whole number.` };
  return { ok: true, quantity: pieces, text: toDecimalText(pieces, 0).text, unit: 'unit', how };
}

export function addStock(a: Rat, b: Rat): Rat {
  return add(a, b);
}

/** Whole cents, half up. */
function roundCents(r: Rat): number {
  return Number(floor(add(r, rat(1n, 2n))));
}

export interface Credit {
  n: number;
  /** Cents to claim. Null when it cannot be worked out yet. */
  cents: number | null;
  reason: string;
}

/**
 * The credit for one line, or null when nothing is owed. byWeight says which unit "some" is in:
 * pounds against the pounds shipped, or pieces against the pieces shipped.
 */
export function creditFor(cl: CheckedLine, arrival: Arrival, byWeight: boolean, poundsPerUnit: Rat | null = null): Credit | null {
  const ext = cl.extensionCents;
  if (ext === null || ext <= 0) return null;
  if (arrival.arrived === 'all') return null;
  if (arrival.arrived === 'unclear') return { n: cl.n, cents: null, reason: 'Charged, but it is not clear how much arrived. Say what arrived to work out the credit.' };
  if (arrival.arrived === 'none') return { n: cl.n, cents: ext, reason: 'Charged but not delivered.' };
  const got = byWeight ? arrival.pounds : arrival.pieces;
  const shipped = byWeight ? shippedPounds(cl) : shippedPieces(cl, poundsPerUnit);
  const unit = byWeight ? 'lb' : 'pieces';
  if (got === null || !positive(shipped)) return { n: cl.n, cents: null, reason: `Part of this line arrived, but the ${unit} shipped are not known, so the credit cannot be worked out.` };
  if (cmp(got, shipped) >= 0) return null;
  const owed = mul(fromInt(ext), sub(fromInt(1), div(got, shipped)));
  return { n: cl.n, cents: roundCents(owed), reason: `Charged for ${toDecimalText(shipped, 3).text} ${unit}, ${toDecimalText(got, 3).text} arrived.` };
}

export interface ClaimTerms {
  text: string;
  deadline: string | null;
}

const CLAIM_WORDS = /\b(claims?|shortages?|discrepanc(y|ies)|credits?|returns?)\b/i;
const WINDOW = /\b(?:within|in)\s{1,3}(\d{1,3})\s{0,3}(hours?|hrs?|days?)\b/i;

/**
 * The supplier's claim deadline, when the invoice prints one (for example "Shortages must be
 * reported within 24 hours"). Only text the invoice printed is used; nothing is guessed.
 */
export function claimTerms(invoice: ModelInvoice): ClaimTerms | null {
  const texts = [...invoice.invoice_annotations.map((a) => a.text), ...invoice.images.map((i) => i.notes), ...invoice.problems].map((t) => String(t).slice(0, 300));
  for (const t of texts) {
    if (!CLAIM_WORDS.test(t)) continue;
    const m = WINDOW.exec(t);
    if (!m) continue;
    const n = Number(m[1]);
    const days = /^h/i.test(m[2]!) ? Math.ceil(n / 24) : n;
    const date = parseInvoiceDate(invoice.invoice_date_iso, invoice.invoice_date);
    const deadline = date ? new Date(date.getTime() + days * 24 * 3600 * 1000).toISOString().slice(0, 10) : null;
    return { text: t.trim(), deadline };
  }
  return null;
}
