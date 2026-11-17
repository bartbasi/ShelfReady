// Old invoices: turning a checked reading into purchase history lines, and deciding which lines
// a person should check against the photo. Pure functions, no database, no network.
//
// A line is always kept. When the reader may be wrong about it, it is flagged "needs check" with
// short plain reasons. Nothing waits for review.
//
// A line needs a check when:
// - the reader's confidence in it is not high;
// - quantity (or weight) times unit price, less any allowance, is more than a cent from the
//   line amount, or one of those numbers was not read;
// - the invoice marks it out of stock, short shipped, a credit, or something else unusual, or a
//   note on it says it did not arrive, was damaged or returned, or has a price written on it;
// - a catch-weight line has a piece count or weight that does not fit;
// - a value is outside normal ranges;
// - or a check on the whole invoice failed that can make line values wrong: the lines do not add
//   up to the total or subtotal, the quantities do not add up to the printed count, a page may be
//   missing or from another invoice, or the reading was damaged. Those flag every line.
//
// Facts about the whole invoice that do not change a line (the date, no invoice number or vendor,
// the reader not sure of the whole invoice) are shown on the invoice page and put in each line's
// Reason as "Invoice: ...", without flagging the line. So is a price unit that was guessed.
//
// Old invoices have their own date window, three years, apart from new invoice runs.

import { checkCatchWeights, checkLine, parseInvoiceDate } from '../invoice/checks.ts';
import { formatCents, formatDecimal, isZero, parseDecimal } from '../invoice/money.ts';
import type { InvoiceReadingSettings } from '../invoice/settings.ts';
import type { CheckedLine, CheckedReading, CheckId, ModelLine } from '../invoice/types.ts';

/** Within a cent, as Bart asked. */
export const LINE_TOLERANCE_CENTS = 1;

/** Longest reason text kept for one line. */
const MAX_REASON = 400;

export interface HistoryLine {
  n: number;
  /** The image number the reader gave (the PDF page for a PDF). */
  page: number;
  /** Which uploaded file the line is on, 1-based, or 0 when not known. */
  filePosition: number;
  itemNumber: string;
  upc: string;
  description: string;
  brand: string;
  /** The product as the spreadsheet shows it. */
  product: string;
  packSize: string;
  unitsPerPack: string;
  /** The pack size as the spreadsheet shows it. */
  pack: string;
  qtyShipped: string;
  unit: string;
  weight: string;
  unitPrice: string;
  priceUnit: string;
  allowance: string;
  extension: string;
  /** Quantity bought, as decimal text. The weight in pounds for a line priced by weight. */
  qty: string;
  qtyUnit: string;
  pricePer: string;
  extensionCents: number | null;
  printedStatus: string;
  confidence: string;
  confidenceNote: string;
  needsCheck: boolean;
  reasons: string[];
  notes: string[];
}

export interface HistoryReading {
  vendor: string;
  invoiceNumber: string;
  invoiceDate: string;
  /** YYYY-MM-DD, or '' when not sure. */
  invoiceDateIso: string;
  totalCents: number | null;
  /** Problems with the whole invoice that can make line values wrong. Each one flags every line. */
  invoiceFlags: string[];
  /** Facts about the whole invoice that do not change a line. In each line's notes, not flags. */
  invoiceNotes: string[];
  lines: HistoryLine[];
}

/** One line of plain text: no line breaks, no runs of spaces, cut to a length. */
export function oneLine(text: string, max = 300): string {
  return String(text).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A printed number as plain decimal text ("1,234.50" gives "1234.50"), or '' when it is not one. */
export function decimalText(text: string): string {
  const d = parseDecimal(text);
  return d === null ? '' : formatDecimal(d);
}

/** Checks on the whole invoice that can make line values wrong, and their short reasons. */
const INVOICE_FLAGS: Partial<Record<CheckId, string>> = {
  schema: 'The reading came back damaged or cut short.',
  pages_complete: 'A page may be missing.',
  same_invoice: 'A page may belong to another invoice.',
  duplicate_pages_agree: 'Two photos of one page were read differently.',
  totals: 'The lines do not add up to the invoice total.',
  subtotal: 'The lines do not add up to the subtotal.',
  total_quantity: 'The quantities do not add up to the printed count.',
};

/** Old invoices go back up to three years. New invoice runs keep their own, shorter window. */
export const HISTORY_MAX_AGE_DAYS = 1096;

export const DATE_UNREAD = 'The date could not be read.';
export const DATE_FUTURE = 'The date is in the future.';
export const DATE_TOO_OLD = 'The date is more than 3 years ago.';

const DAY_MS = 24 * 3600_000;

/** The invoice date as YYYY-MM-DD, and what is wrong with it, if anything. */
export function invoiceDate(iso: string, printed: string, today: Date, maxFutureDays: number): { iso: string; problem: string | null } {
  const d = parseInvoiceDate(iso, printed);
  if (!d) return { iso: '', problem: DATE_UNREAD };
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const age = Math.round((t - d.getTime()) / DAY_MS);
  const out = d.toISOString().slice(0, 10);
  if (-age > maxFutureDays) return { iso: out, problem: DATE_FUTURE };
  if (age > HISTORY_MAX_AGE_DAYS) return { iso: out, problem: DATE_TOO_OLD };
  return { iso: out, problem: null };
}

/** Problems with the whole invoice: flags that touch every line, and notes that do not. Each once. */
export function invoiceProblems(reading: CheckedReading, today: Date, s: InvoiceReadingSettings): { flags: string[]; notes: string[]; dateIso: string } {
  const flags: string[] = [];
  const notes: string[] = [];
  const add = (list: string[], r: string) => {
    if (!list.includes(r)) list.push(r);
  };
  const inv = reading.invoice;
  const noNumber = oneLine(inv.invoice_number) === '';
  for (const c of reading.checks) {
    if (c.passed) continue;
    // With no invoice number, that check fails for that reason alone, noted below.
    if (c.id === 'same_invoice' && noNumber) continue;
    const r = INVOICE_FLAGS[c.id];
    if (r) add(flags, r);
  }
  if (oneLine(inv.supplier_name) === '') add(notes, 'No vendor name was read.');
  if (noNumber) add(notes, 'No invoice number was read.');
  // The new-invoice date rule (checks.ts, invoice_date) is not used: old invoices have their own.
  const date = invoiceDate(inv.invoice_date_iso, inv.invoice_date, today, s.ranges.maxFutureDays);
  if (date.problem) add(notes, date.problem);
  if (inv.overall_confidence !== 'high') add(notes, 'The reader was not sure of the whole invoice.');
  if (reading.lines.length === 0) add(notes, 'No product lines were read.');
  return { flags, notes, dateIso: date.iso };
}

/** The product name: the description, with the brand in front when it is not already in it. */
export function productName(l: Pick<ModelLine, 'description' | 'brand'>): string {
  const desc = oneLine(l.description, 600);
  const brand = oneLine(l.brand, 100);
  if (brand && !desc.toLowerCase().includes(brand.toLowerCase())) return oneLine(`${brand} ${desc}`, 600);
  return desc;
}

/** The pack size: as printed, or "12 units/case" when only a count per case is printed. */
export function packText(l: Pick<ModelLine, 'pack_size' | 'units_per_pack'>): string {
  const size = oneLine(l.pack_size, 100);
  const count = parseDecimal(l.units_per_pack);
  const n = count && count.scale === 0 && count.units > 0 ? count.units : null;
  if (n === null) return size;
  if (size === '') return `${n} ${n === 1 ? 'unit' : 'units'}/case`;
  // "12/5.3Z" already says 12 to a case.
  if (new RegExp(`^${n}(?![0-9.])`).test(size)) return size;
  return `${n} x ${size}`;
}

const LB_UNITS = new Set(['LB', 'LBS', '#']);

function upper(s: string): string {
  return oneLine(s, 20).toUpperCase();
}

/** Short reason when the line's math does not check, else null. */
function mathReason(cl: CheckedLine): string | null {
  const { mathProblem, checked } = checkLine(cl.n, cl.line, LINE_TOLERANCE_CENTS);
  if (mathProblem === null) return null;
  // The same order as checkLine, so the reason names the problem it found.
  const l = cl.line;
  const qty = parseDecimal(l.qty_shipped);
  const weightRaw = parseDecimal(l.weight);
  const weight = weightRaw && !isZero(weightRaw) ? weightRaw : null;
  if ((qty !== null && isZero(qty) && weight === null) || l.printed_status === 'out_of_stock') return 'Nothing shipped, but an amount is charged.';
  if (parseDecimal(l.unit_price) === null) return 'No unit price was read.';
  if (checked.extensionCents === null) return 'No line amount was read.';
  if (qty === null && weight === null) return 'No quantity or weight was read.';
  if (checked.computedCents === null) return 'The numbers are too large to check.';
  const what = checked.basis === 'weight' ? 'Weight' : 'Qty';
  return `${what} x price is ${formatCents(checked.computedCents)}, but the line reads ${formatCents(checked.extensionCents)}.`;
}

/** Short reasons from what the invoice and its notes say about the line. */
function statusReasons(cl: CheckedLine): string[] {
  const out: string[] = [];
  const l = cl.line;
  const qty = parseDecimal(l.qty_shipped);
  const weight = parseDecimal(l.weight);
  const ext = cl.extensionCents;
  if (l.printed_status === 'out_of_stock' || (qty !== null && isZero(qty) && (weight === null || isZero(weight)))) out.push('Out of stock.');
  else if (l.printed_status === 'short_shipped') out.push('Short shipped.');
  if (l.printed_status === 'credit' || (ext !== null && ext < 0)) out.push('A credit.');
  if (l.printed_status === 'other') out.push('The invoice marks this line in an unusual way.');
  for (const a of l.annotations) {
    const text = oneLine(a.text, 60);
    if (a.meaning === 'not_received' || a.meaning === 'short' || a.meaning === 'damaged' || a.meaning === 'returned') out.push(text ? `A note says "${text}".` : 'A note says it did not all arrive.');
    else if (a.meaning === 'price_note') out.push(text ? `A price is written on it: "${text}".` : 'A price is written on it.');
  }
  return out;
}

/** Short reasons for values outside normal ranges or not readable as numbers. */
function rangeReasons(cl: CheckedLine, s: InvoiceReadingSettings): string[] {
  const l = cl.line;
  const r = s.ranges;
  const out: string[] = [];
  for (const text of [l.qty_shipped, l.weight, l.unit_price, l.allowance, l.extension]) {
    if (text.trim() !== '' && parseDecimal(text) === null) {
      out.push('A number on the line could not be read.');
      break;
    }
  }
  const over = (text: string, max: number) => {
    const d = parseDecimal(text);
    return d !== null && Math.abs(d.units) > max * 10 ** d.scale;
  };
  const neg = (text: string) => {
    const d = parseDecimal(text);
    return d !== null && d.units < 0;
  };
  if (over(l.qty_shipped, r.maxQuantity) || over(l.weight, r.maxWeightLb) || over(l.unit_price, r.maxUnitPrice) || (cl.extensionCents !== null && Math.abs(cl.extensionCents) > r.maxLineAmount * 100)) {
    out.push('A value is larger than normal.');
  }
  if (neg(l.weight) || neg(l.unit_price)) out.push('A weight or price is negative.');
  if (oneLine(l.description) === '' && oneLine(l.item_number) === '') out.push('No product name was read.');
  return out;
}

/**
 * A narrow allowlist: the note says a product (times, x, multiplied) does not equal, match or add
 * up. Anything else keeps the flag.
 */
const MATH_DOUBT = /\b(does ?n[o']?t|not)\s+(equal|match|add up)\b/i;
const MATH_WORDS = /(\btimes\b|\bmultipl\w*|\s[x\u00d7]\s)/i;
/**
 * Words that say the reader had trouble reading the page, filled a number in itself, hedged, or
 * doubted something other than the arithmetic. Any of them keeps the flag.
 */
const READ_DOUBT =
  /\b(rotat\w*|blur\w*|faint|fade\w*|cut\w*|illegible|unclear|smudg\w*|glare|shadow\w*|crease\w*|fold\w*|handwrit\w*|letters?|digits?|partial\w*|partly|obscur\w*|torn|hard|could|looks|misread\w*|may|might|either|or|unsure|uncertain|ambiguous|probabl\w*|possibl\w*|visible|hidden|missing|covered|assum\w*|infer\w*|estimat\w*|comput\w*|calculat\w*|derived?|guess\w*|crop\w*|unreadable|dark\w*|stain\w*|crossed|overwrit\w*|correct\w*|sticker\w*|stamp\w*|skew\w*|angle\w*|description|item|upc|pack\w*|unit|product|name|brand)\b/i;

/** Said in Reason when the reader doubted the math but ShelfReady's own check found it adds up. */
export const MATH_CHECKED = 'The reader doubted the math, but ShelfReady checked it and it adds up.';

/**
 * True when the reader was only fairly sure, its note is only about the arithmetic, and ShelfReady's
 * own exact check of that arithmetic passed. The reader is not always right at sums; the code is.
 */
function onlyMathDoubt(l: ModelLine, mathOk: boolean): boolean {
  if (!mathOk || l.confidence !== 'medium') return false;
  const note = oneLine(l.confidence_note, 300);
  return MATH_DOUBT.test(note) && MATH_WORDS.test(note) && !READ_DOUBT.test(note);
}

function confidenceReason(l: ModelLine): string | null {
  if (l.confidence === 'high') return null;
  const note = oneLine(l.confidence_note, 120);
  const head = l.confidence === 'low' ? 'The reader was unsure' : 'The reader was not fully sure';
  return note ? `${head}: ${note.replace(/[.\s]+$/, '')}.` : `${head}.`;
}

/** Said in Reason when the invoice did not print what its price is per. */
export const PRICE_PER_GUESSED = 'Price per was not printed; guessed from the unit.';

/**
 * Maps one checked line to a purchase history line. invoiceFlags are problems with the whole
 * invoice that flag every line; invoiceNotes go in the line's notes, prefixed "Invoice: ", without
 * flagging it. filePosition maps the image number to a file.
 */
export function historyLine(
  cl: CheckedLine,
  invoiceFlags: readonly string[],
  invoiceNotes: readonly string[],
  s: InvoiceReadingSettings,
  filePosition: (page: number) => number,
): HistoryLine {
  const l = cl.line;
  const reasons: string[] = [];
  const add = (r: string | null) => {
    if (r && !reasons.includes(r)) reasons.push(r);
  };
  const math = mathReason(cl);
  const mathDoubtOnly = onlyMathDoubt(l, math === null);
  if (!mathDoubtOnly) add(confidenceReason(l));
  add(math);
  statusReasons(cl).forEach(add);
  if (checkCatchWeights([cl], s).length) add('The piece count or weight may be misread.');
  rangeReasons(cl, s).forEach(add);
  invoiceFlags.forEach(add);

  const notes: string[] = [];
  if (mathDoubtOnly) notes.push(MATH_CHECKED);
  const allowance = parseDecimal(l.allowance);
  if (allowance && !isZero(allowance)) notes.push(`Allowance of ${decimalText(l.allowance).replace(/^-/, '')} off each unit price.`);

  const unit = upper(l.unit);
  const byWeight = cl.basis === 'weight';
  let qty: string;
  let qtyUnit: string;
  let pack = packText(l);
  if (byWeight) {
    qty = decimalText(l.weight);
    qtyUnit = 'LB';
    // The piece count goes with the pack, so the quantity column stays in pounds.
    const pieces = decimalText(l.qty_shipped);
    if (pieces && !LB_UNITS.has(unit)) pack = [pack, `${pieces} ${unit || 'pieces'}`].filter(Boolean).join(', ');
  } else {
    qty = decimalText(l.qty_shipped);
    qtyUnit = unit;
  }
  const priceUnit = upper(l.price_unit);
  const pricePer = priceUnit || (byWeight ? 'LB' : unit);
  if (!priceUnit && pricePer) notes.push(PRICE_PER_GUESSED);
  for (const n of invoiceNotes) notes.push(`Invoice: ${n}`);

  const cut = reasons.join(' ').length > MAX_REASON ? reasons.slice(0, Math.max(1, reasons.length - 1)) : reasons;
  return {
    n: cl.n,
    page: l.image_index,
    filePosition: filePosition(l.image_index),
    itemNumber: oneLine(l.item_number, 60),
    upc: oneLine(l.upc, 30),
    description: oneLine(l.description, 600),
    brand: oneLine(l.brand, 100),
    product: productName(l),
    packSize: oneLine(l.pack_size, 100),
    unitsPerPack: oneLine(l.units_per_pack, 30),
    pack,
    qtyShipped: oneLine(l.qty_shipped, 30),
    unit,
    weight: oneLine(l.weight, 30),
    unitPrice: oneLine(l.unit_price, 30),
    priceUnit,
    allowance: oneLine(l.allowance, 30),
    extension: oneLine(l.extension, 30),
    qty,
    qtyUnit,
    pricePer,
    extensionCents: cl.extensionCents,
    printedStatus: l.printed_status,
    confidence: l.confidence,
    confidenceNote: oneLine(l.confidence_note, 300),
    needsCheck: cut.length > 0,
    reasons: cut,
    notes,
  };
}

/**
 * Which uploaded file each image number is on. The reader drops a photo that repeats an earlier
 * one and numbers the rest 1, 2, 3 in upload order, so image k is the k-th file not dropped.
 * A PDF is one file: every page is on file 1.
 */
export function filePositions(kind: 'images' | 'pdf', uploaded: number, dropped: readonly number[]): (page: number) => number {
  if (kind === 'pdf') return () => (uploaded >= 1 ? 1 : 0);
  const skip = new Set(dropped);
  const kept: number[] = [];
  for (let p = 1; p <= uploaded; p++) if (!skip.has(p)) kept.push(p);
  return (page) => (Number.isInteger(page) && page >= 1 && page <= kept.length ? kept[page - 1]! : 0);
}

/** The whole reading as purchase history. today is for the date window. extraNotes are about the reading itself. */
export function historyFromReading(
  reading: CheckedReading,
  s: InvoiceReadingSettings,
  filePosition: (page: number) => number,
  opts: { today: Date; extraNotes?: readonly string[] },
): HistoryReading {
  const inv = reading.invoice;
  const p = invoiceProblems(reading, opts.today, s);
  const notes = [...p.notes, ...(opts.extraNotes ?? []).filter((r) => r !== '' && !p.notes.includes(r))];
  return {
    vendor: oneLine(inv.supplier_name, 200),
    invoiceNumber: oneLine(inv.invoice_number, 60),
    invoiceDate: oneLine(inv.invoice_date, 60),
    invoiceDateIso: p.dateIso,
    totalCents: reading.totalCents,
    invoiceFlags: p.flags,
    invoiceNotes: notes,
    lines: reading.lines.map((cl) => historyLine(cl, p.flags, notes, s, filePosition)),
  };
}
