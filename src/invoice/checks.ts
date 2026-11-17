// Code checks on a model's reading of an invoice. Pure functions, money in integer cents.
//
// A blocking check that fails sends the invoice to the fallback model, and if that reading
// fails too, to the review screen with every failed check listed. Non-blocking checks are
// shown in review but do not stop anything.
//
// Everything the model returns is untrusted. Before any other check, the reading is bounded
// (text lengths, list sizes, number sizes) and its structure is checked (image numbers unique
// and sent, repeats pointing backwards). No loop runs to a number the model chose.
//
// Matching to Square items plugs in through the knownItem hook (src/matching/known-item.ts).
// When given, every line is passed to it and two checks are added. "misread_codes" blocks: an
// unmatched line whose printed code looks misread, which a second reading can fix. "known_items"
// lists every unmatched line for review; it does not block unless knownItemsBlocking is set,
// because no second reading can add an item to Square (store/docs/DECISIONS.md, November 7).

import { compareDecimal, formatCents, formatDecimal, isZero, mulToCents, NumberTooLargeError, parseCents, parseDecimal, subtract, type Decimal } from './money.ts';
import { parsePack } from './pack.ts';
import type { InvoiceReadingSettings } from './settings.ts';
import type {
  CheckedLine,
  CheckedReading,
  CheckId,
  CheckResult,
  ModelAnnotation,
  ModelCharge,
  ModelImage,
  ModelInvoice,
  ModelLine,
  Notice,
  Received,
} from './types.ts';

/** The answer from the matching step for one line. */
export interface KnownItemAnswer {
  /** Matched to a Square item, or marked not for resale. */
  known: boolean;
  /**
   * For a line that is not known: its printed code looks misread (it fails its check digit, or
   * it is one character from a code the store knows). Only these lines block the reading.
   */
  possibleMisread?: boolean;
  /** Plain words, for example "matched Test Cheese 9999". */
  note?: string;
}

/** Hook for the matching step: does this line match a known Square item? */
export type KnownItemLookup = (line: CheckedLine, invoice: ModelInvoice) => KnownItemAnswer;

export interface CheckOptions {
  settings: InvoiceReadingSettings;
  /** Today's date, for the invoice date check. */
  today: Date;
  /** How many images were sent. Image numbers must be 1 to this. */
  imagesSent?: number;
  knownItem?: KnownItemLookup;
  /**
   * Whether every unknown line blocks, as the brief first said. Default false: only a line whose
   * code looks misread blocks, through misread_codes (store/docs/DECISIONS.md, November 7).
   */
  knownItemsBlocking?: boolean;
}

/** Highest believable page number or page count. */
export const MAX_PAGES = 50;

/** Size limits on a reading. Anything over them fails the schema check and is cut down. */
export const READING_LIMITS = {
  text: 300,
  description: 600,
  images: MAX_PAGES,
  lines: 1000,
  charges: 50,
  annotations: 10,
  invoiceAnnotations: 20,
  problems: 30,
};

/** Words in a handwritten note that mean the goods did not arrive. */
const NOT_RECEIVED_WORDS =
  /\b(short(ed)?|not on (the )?truck|not received|never (came|arrived)|did ?n[o']?t (come|arrive)|missing|no show|back ?order(ed)?|refused|n\/r)\b/i;

function result(id: CheckId, blocking: boolean, passMessage: string, failMessage: string, details: string[]): CheckResult {
  const passed = details.length === 0;
  return { id, passed, blocking, message: passed ? passMessage : failMessage, details };
}

/** Invoice numbers compare without spaces and without case. */
export function normalizeInvoiceNumber(s: string): string {
  return s.replace(/\s+/g, '').toUpperCase();
}

/** A page number as printed, when it is a believable whole number. */
function pageValue(text: string): { value: number | null; tooBig: boolean } {
  const n = parseDecimal(text);
  if (n === null || n.scale !== 0 || n.units <= 0) return { value: null, tooBig: false };
  if (n.units > MAX_PAGES) return { value: null, tooBig: true };
  return { value: n.units, tooBig: false };
}

function pageNumberOf(img: ModelImage): number | null {
  return pageValue(img.page_number).value;
}

/** A short name for a line in messages, for example "line 3 (item A100, SMOKED HAM)". */
export function lineLabel(n: number, line: ModelLine): string {
  const desc = line.description.split('|')[0]!.trim().slice(0, 40);
  const id = line.item_number ? `item ${line.item_number.slice(0, 30)}` : '';
  return `line ${n}${desc || id ? ` (${[id, desc].filter(Boolean).join(', ')})` : ''}`;
}

/** GTIN check digit, valid for EAN-8, UPC-A, EAN-13 and GTIN-14. */
export function gtinCheckDigitValid(code: string): boolean {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const digits = code.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10 === check;
}

// Bounds and structure

function listProblems(found: string[], max = 8): string[] {
  return found.length > max ? [...found.slice(0, max), `and ${found.length - max} more like these.`] : found;
}

/**
 * Cuts a reading down to the size limits. Returns the bounded copy and what was over a limit.
 * Every later check runs on the copy, so no long text reaches a regular expression.
 */
export function boundReading(inv: ModelInvoice): { invoice: ModelInvoice; problems: string[] } {
  const over: string[] = [];
  const L = READING_LIMITS;
  const cut = (path: string, text: string, max: number): string => {
    if (text.length <= max) return text;
    over.push(`${path} is longer than ${max} characters.`);
    return text.slice(0, max);
  };
  const list = <T>(path: string, items: T[], max: number): T[] => {
    if (items.length <= max) return items;
    over.push(`${path} has ${items.length} entries, more than ${max}.`);
    return items.slice(0, max);
  };
  const ann = (path: string, a: ModelAnnotation): ModelAnnotation => ({ ...a, text: cut(`${path}.text`, a.text, L.text) });
  const t = (path: string, text: string) => cut(path, text, L.text);
  const invoice: ModelInvoice = {
    ...inv,
    supplier_name: t('supplier_name', inv.supplier_name),
    invoice_number: t('invoice_number', inv.invoice_number),
    invoice_date: t('invoice_date', inv.invoice_date),
    invoice_date_iso: t('invoice_date_iso', inv.invoice_date_iso),
    images: list('images', inv.images, L.images).map((img, i) => ({
      ...img,
      invoice_number: t(`images[${i}].invoice_number`, img.invoice_number),
      page_number: t(`images[${i}].page_number`, img.page_number),
      page_count: t(`images[${i}].page_count`, img.page_count),
      notes: t(`images[${i}].notes`, img.notes),
    })),
    lines: list('lines', inv.lines, L.lines).map((l, i) => {
      const p = `lines[${i}]`;
      const out: ModelLine = { ...l };
      for (const k of Object.keys(l) as Array<keyof ModelLine>) {
        const v = l[k];
        if (typeof v === 'string') (out as unknown as Record<string, unknown>)[k] = cut(`${p}.${k}`, v, k === 'description' ? L.description : L.text);
      }
      out.annotations = list(`${p}.annotations`, l.annotations, L.annotations).map((a, j) => ann(`${p}.annotations[${j}]`, a));
      return out;
    }),
    charges: list('charges', inv.charges, L.charges).map((c, i) => ({
      ...c,
      description: t(`charges[${i}].description`, c.description),
      amount: t(`charges[${i}].amount`, c.amount),
    })),
    subtotal: t('subtotal', inv.subtotal),
    tax: t('tax', inv.tax),
    total: t('total', inv.total),
    previous_balance: t('previous_balance', inv.previous_balance),
    printed_total_quantity: t('printed_total_quantity', inv.printed_total_quantity),
    invoice_annotations: list('invoice_annotations', inv.invoice_annotations, L.invoiceAnnotations).map((a, i) => ann(`invoice_annotations[${i}]`, a)),
    problems: list('problems', inv.problems, L.problems).map((p, i) => t(`problems[${i}]`, p)),
  };
  return { invoice, problems: listProblems(over) };
}

/**
 * Checks the reading's structure: image numbers unique and among those sent, repeats pointing
 * at an earlier image, and lines and charges on images that exist. Returns the problems and a
 * copy with only usable image entries, so later checks never follow a bad reference.
 */
export function checkStructure(inv: ModelInvoice, imagesSent: number | undefined): { invoice: ModelInvoice; problems: string[] } {
  const found: string[] = [];
  const maxIndex = imagesSent ?? MAX_PAGES;
  const seen = new Set<number>();
  const images: ModelImage[] = [];
  for (const img of inv.images) {
    const i = img.image_index;
    if (!Number.isInteger(i) || i < 1 || i > maxIndex) {
      found.push(`An image entry is numbered ${i}, but only images 1 to ${maxIndex} were sent.`);
      continue;
    }
    if (seen.has(i)) {
      found.push(`Image ${i} is listed more than once.`);
      continue;
    }
    seen.add(i);
    images.push(img);
  }
  const cleaned = images.map((img) => {
    const s = img.same_page_as_image;
    if (s === 0) return img;
    if (!Number.isInteger(s) || s < 1 || s >= img.image_index || !seen.has(s)) {
      found.push(`Image ${img.image_index} is said to repeat image ${s}, which is not an earlier image.`);
      return { ...img, same_page_as_image: 0 };
    }
    return img;
  });
  const badLines = inv.lines.filter((l) => !seen.has(l.image_index)).length;
  if (badLines) found.push(`${badLines} line${badLines === 1 ? ' is' : 's are'} on an image that was not sent or not reported.`);
  const badCharges = inv.charges.filter((c) => !seen.has(c.image_index)).length;
  if (badCharges) found.push(`${badCharges} charge${badCharges === 1 ? ' is' : 's are'} on an image that was not sent or not reported.`);
  return { invoice: { ...inv, images: cleaned }, problems: listProblems(found) };
}

// Duplicate pages

export interface DuplicatePages {
  /** duplicate image -> the earlier image it repeats */
  sameAs: Map<number, number>;
  notices: Notice[];
  /** The model said two images repeat a page, but what is printed on them disagrees. */
  conflicts: string[];
}

/**
 * Finds images that repeat an earlier page: the model said so and the printed invoice and page
 * numbers do not contradict it, or both images show the same invoice number and page number.
 * Expects image entries already checked by checkStructure. Following a chain of repeats stops
 * at anything seen before, so a loop cannot hang it.
 */
export function findDuplicatePages(invoice: ModelInvoice): DuplicatePages {
  const direct = new Map<number, number>();
  const notices: Notice[] = [];
  const conflicts: string[] = [];
  const byIndex = new Map<number, ModelImage>();
  for (const img of invoice.images) if (!byIndex.has(img.image_index)) byIndex.set(img.image_index, img);
  for (const img of byIndex.values()) {
    const earlier = img.same_page_as_image;
    const other = byIndex.get(earlier);
    if (!other || earlier <= 0 || earlier >= img.image_index) continue;
    const pa = pageNumberOf(img);
    const pb = pageNumberOf(other);
    const ia = normalizeInvoiceNumber(img.invoice_number);
    const ib = normalizeInvoiceNumber(other.invoice_number);
    if ((pa !== null && pb !== null && pa !== pb) || (ia !== '' && ib !== '' && ia !== ib)) {
      conflicts.push(`The model said image ${img.image_index} repeats image ${earlier}, but they show different invoice or page numbers. Both were kept.`);
      continue;
    }
    direct.set(img.image_index, earlier);
  }
  const firstWith = new Map<string, number>();
  for (const img of [...byIndex.values()].sort((a, b) => a.image_index - b.image_index)) {
    const page = pageNumberOf(img);
    const inv = normalizeInvoiceNumber(img.invoice_number);
    if (page === null || inv === '') continue;
    const key = `${inv}#${page}`;
    const first = firstWith.get(key);
    if (first === undefined) firstWith.set(key, img.image_index);
    else if (first !== img.image_index && !direct.has(img.image_index)) direct.set(img.image_index, first);
  }
  // Point every repeat at the first photo of its page. A loop is reported, never followed.
  const sameAs = new Map<number, number>();
  for (const [dup, orig] of direct) {
    const visited = new Set<number>([dup]);
    let o = orig;
    while (direct.has(o) && !visited.has(o)) {
      visited.add(o);
      o = direct.get(o)!;
    }
    if (visited.has(o)) {
      conflicts.push(`Images ${[...visited].sort((a, b) => a - b).join(', ')} are said to repeat each other in a loop. They were all kept.`);
      continue;
    }
    sameAs.set(dup, o);
  }
  for (const [dup, orig] of [...sameAs].sort((a, b) => a[0] - b[0])) {
    notices.push({ message: `Image ${dup} is another photo of the same page as image ${orig}. It was counted once.` });
  }
  return { sameAs, notices, conflicts };
}

function lineKey(l: ModelLine): string {
  return `${l.item_number.trim().toUpperCase()}|${parseCents(l.extension) ?? ''}`;
}

/**
 * Drops lines and charges printed on a duplicate image when the original image has its own.
 * If both photos were read and they disagree, that is reported, because one reading is wrong.
 */
export function dropDuplicateContent(
  invoice: ModelInvoice,
  dups: DuplicatePages,
): { lines: ModelLine[]; charges: ModelCharge[]; disagreements: string[] } {
  const disagreements: string[] = [];
  const linesBy = new Map<number, ModelLine[]>();
  for (const l of invoice.lines) linesBy.set(l.image_index, [...(linesBy.get(l.image_index) ?? []), l]);
  const dropImagesForLines = new Set<number>();
  for (const [dup, orig] of dups.sameAs) {
    const a = linesBy.get(orig) ?? [];
    const b = linesBy.get(dup) ?? [];
    if (b.length === 0) continue;
    if (a.length === 0) continue; // the duplicate is the only copy that was read: keep it
    dropImagesForLines.add(dup);
    const ka = a.map(lineKey).sort().join(';');
    const kb = b.map(lineKey).sort().join(';');
    if (ka !== kb) {
      disagreements.push(`Images ${orig} and ${dup} show the same page but were read differently (${a.length} and ${b.length} lines).`);
    }
  }
  const chargesBy = new Map<number, ModelCharge[]>();
  for (const c of invoice.charges) chargesBy.set(c.image_index, [...(chargesBy.get(c.image_index) ?? []), c]);
  const dropImagesForCharges = new Set<number>();
  for (const [dup, orig] of dups.sameAs) {
    if ((chargesBy.get(dup) ?? []).length && (chargesBy.get(orig) ?? []).length) dropImagesForCharges.add(dup);
  }
  return {
    lines: invoice.lines.filter((l) => !dropImagesForLines.has(l.image_index)),
    charges: invoice.charges.filter((c) => !dropImagesForCharges.has(c.image_index)),
    disagreements,
  };
}

// Lines

function absDec(d: Decimal): Decimal {
  return { units: Math.abs(d.units), scale: d.scale };
}

/** Works out a line's expected amount and whether its goods arrived. Never throws on a number. */
export function checkLine(n: number, line: ModelLine, toleranceCents: number): { checked: CheckedLine; mathProblem: string | null } {
  const ext = parseCents(line.extension);
  const qty = parseDecimal(line.qty_shipped);
  const weightRaw = parseDecimal(line.weight);
  const weight = weightRaw && !isZero(weightRaw) ? weightRaw : null;
  const price = parseDecimal(line.unit_price);
  const allowance = parseDecimal(line.allowance);
  const net = price && allowance && !isZero(allowance) ? subtract(price, absDec(allowance)) : price;
  const label = lineLabel(n, line);
  let computed: number | null = null;
  let basis: CheckedLine['basis'] = 'none';
  let mathProblem: string | null = null;

  try {
    const nothingShipped = (qty !== null && isZero(qty) && weight === null) || line.printed_status === 'out_of_stock';
    if (nothingShipped) {
      computed = 0;
      basis = 'quantity';
      if (ext !== null && ext !== 0) mathProblem = `${label}: nothing shipped, but the amount is ${formatCents(ext)}.`;
    } else if (net === null) {
      mathProblem = `${label}: no unit price was read.`;
    } else if (ext === null) {
      mathProblem = `${label}: no line amount was read.`;
    } else {
      const tries: Array<{ basis: 'weight' | 'quantity'; value: Decimal }> = [];
      if (weight) tries.push({ basis: 'weight', value: weight });
      if (qty) tries.push({ basis: 'quantity', value: qty });
      if (tries.length === 0) {
        mathProblem = `${label}: no quantity or weight was read.`;
      } else {
        const credit = ext < 0 || line.printed_status === 'credit';
        for (const t of tries) {
          const c = mulToCents(t.value, net);
          const cmp = credit ? Math.abs(c) : c;
          const target = credit ? Math.abs(ext) : ext;
          if (Math.abs(cmp - target) <= toleranceCents) {
            computed = credit ? -Math.abs(c) : c;
            basis = t.basis;
            break;
          }
        }
        if (computed === null) {
          const first = tries[0]!;
          const c = mulToCents(first.value, net);
          const what = first.basis === 'weight' ? `weight ${line.weight}` : `quantity ${line.qty_shipped}`;
          const priceText = allowance && !isZero(allowance) ? `(${line.unit_price} less ${line.allowance})` : line.unit_price;
          mathProblem = `${label}: ${what} x ${priceText} = ${formatCents(c)}, but the line amount reads ${formatCents(ext)}.`;
          computed = c;
          basis = first.basis;
        }
      }
    }
  } catch (err) {
    if (!(err instanceof NumberTooLargeError)) throw err;
    computed = null;
    basis = 'none';
    mathProblem = `${label}: the numbers are too large to check.`;
  }

  const { received, flags } = receivedFrom(line, qty, ext);
  const pack = parsePack({ packSize: line.pack_size, unitsPerPack: line.units_per_pack, unit: line.unit, priceUnit: line.price_unit, catchWeight: basis === 'weight' });
  if (!pack.sure && pack.note) flags.push(pack.note);
  return {
    checked: { n, line, computedCents: computed, extensionCents: ext, basis, received, flags, pack },
    mathProblem,
  };
}

function meansNotReceived(a: ModelAnnotation): boolean {
  return a.meaning === 'not_received' || a.meaning === 'short' || NOT_RECEIVED_WORDS.test(a.text);
}

/** Whether the goods arrived, from the printed status and any notes on the line. */
export function receivedFrom(line: ModelLine, qty: Decimal | null, extCents: number | null): { received: Received; flags: string[] } {
  const flags: string[] = [];
  let received: Received = 'yes';
  const charged = extCents !== null && extCents !== 0 ? ` It is still charged ${formatCents(extCents)}.` : '';
  if (line.printed_status === 'out_of_stock' || (qty !== null && isZero(qty) && !parseDecimal(line.weight)?.units)) {
    received = 'no';
    flags.push(extCents ? `Out of stock, but charged ${formatCents(extCents)}.` : 'Out of stock, not charged.');
  } else if (line.printed_status === 'short_shipped') {
    received = 'check';
    flags.push('The invoice says this line was short shipped. Check what arrived.');
  }
  // Words written by a person say more than a highlight, so they lead the flag.
  const rank = (a: ModelAnnotation) => (a.kind === 'handwritten' ? 0 : a.kind === 'stamp' ? 1 : a.kind === 'printed_note' ? 2 : 3);
  const notReceived = line.annotations.filter(meansNotReceived).sort((a, b) => rank(a) - rank(b));
  if (notReceived.length) {
    const partial = qty !== null && compareDecimal(absDec(qty), { units: 1, scale: 0 }) > 0;
    received = partial ? 'check' : 'no';
    const words = notReceived.map((a) => `"${a.text}"`).join(', ');
    flags.unshift(partial ? `Note says ${words}. Check how much arrived.${charged}` : `Marked not received: ${words}.${charged}`);
  }
  for (const a of line.annotations) {
    if (meansNotReceived(a)) {
      continue;
    } else if (a.meaning === 'damaged' || a.meaning === 'returned') {
      if (received === 'yes') received = 'check';
      flags.push(`Note says "${a.text}" (${a.meaning}).`);
    } else if (a.meaning === 'price_note') {
      flags.push(`Price note: "${a.text}".`);
    } else if (a.meaning === 'other' && a.kind === 'handwritten') {
      flags.push(`Handwritten note: "${a.text}".`);
    }
  }
  return { received, flags };
}

const POUNDS_PER = { LB: 1, LBS: 1, '#': 1, OZ: 1 / 16, KG: 2.20462, G: 0.00220462 } as const;

/** A printed size in pounds, for example "6 LB" is 6 and "8 OZ" is 0.5. Null when it is no weight. */
export function poundsIn(packSize: string): number | null {
  if (packSize.length > 20) return null;
  const m = /^(\d{1,4}(?:\.\d{1,3})?) {0,2}(LBS|LB|#|OZ|KG|G)\.?$/i.exec(packSize.trim());
  if (!m) return null;
  const v = Number(m[1]) * POUNDS_PER[m[2]!.toUpperCase() as keyof typeof POUNDS_PER];
  return v > 0 ? v : null;
}

/**
 * Catch-weight lines: the amount comes from the weight, so a misread piece count would pass
 * the line math. The count must be a whole number of pieces, each piece must weigh a
 * believable amount, and when a size is printed ("6 LB") each piece must be near it.
 * These are plausibility limits, not money, so the per-piece weight may be a float.
 */
export function checkCatchWeights(lines: CheckedLine[], s: InvoiceReadingSettings): string[] {
  const r = s.ranges;
  const details: string[] = [];
  for (const cl of lines) {
    if (cl.basis !== 'weight') continue;
    const l = cl.line;
    const label = lineLabel(cl.n, l);
    const unit = l.unit.trim().toUpperCase().replace(/[^A-Z#]/g, '');
    if (['LB', 'LBS', '#', 'KG'].includes(unit)) continue; // the quantity is itself a weight
    const qty = parseDecimal(l.qty_shipped);
    const weight = parseDecimal(l.weight);
    if (!weight) continue;
    if (!qty || qty.units <= 0) {
      details.push(`${label}: a catch-weight line must show how many pieces shipped.`);
      continue;
    }
    const whole = qty.scale === 0 ? qty.units : qty.units % 10 ** qty.scale === 0 ? qty.units / 10 ** qty.scale : null;
    if (whole === null) {
      details.push(`${label}: ${l.qty_shipped} pieces is not a whole number, but a catch-weight line ships whole pieces.`);
      continue;
    }
    if (whole > r.maxPiecesPerWeightLine) {
      details.push(`${label}: ${whole} pieces on one catch-weight line is more than ${r.maxPiecesPerWeightLine}.`);
      continue;
    }
    const perPiece = weight.units / 10 ** weight.scale / whole;
    if (perPiece < r.minLbPerPiece || perPiece > r.maxLbPerPiece) {
      details.push(`${label}: ${whole} pieces weighing ${l.weight} lb is ${perPiece.toFixed(2)} lb each, which is not believable. The piece count may be misread.`);
      continue;
    }
    const size = poundsIn(l.pack_size);
    if (size !== null) {
      const perPack = parseDecimal(l.units_per_pack);
      const count = perPack && perPack.scale === 0 && perPack.units >= 1 && perPack.units <= 100 ? perPack.units : 1;
      const nominal = size * count;
      if (Math.abs(perPiece - nominal) / nominal > r.nominalWeightTolerance) {
        details.push(
          `${label}: ${whole} piece${whole === 1 ? '' : 's'} weighing ${l.weight} lb is ${perPiece.toFixed(2)} lb each, but the pack says ${nominal} lb each. The piece count or weight may be misread.`,
        );
      }
    }
  }
  return details;
}

// Whole reading

function checkPages(invoice: ModelInvoice, dups: DuplicatePages, imagesSent: number | undefined): { details: string[]; notices: Notice[] } {
  const details: string[] = [];
  const notices: Notice[] = [];
  const images = [...invoice.images].sort((a, b) => a.image_index - b.image_index);
  if (images.length === 0) return { details: ['The reading has no page information.'], notices };
  if (imagesSent !== undefined) {
    const reported = new Set(images.map((i) => i.image_index));
    for (let i = 1; i <= Math.min(imagesSent, MAX_PAGES); i++) {
      if (!reported.has(i)) details.push(`Image ${i} was sent but is missing from the reading.`);
    }
  }
  for (const img of images) {
    if (pageValue(img.page_number).tooBig) details.push(`Image ${img.image_index} shows page number ${img.page_number}, which is not believable.`);
    if (pageValue(img.page_count).tooBig) details.push(`Image ${img.image_index} shows a page count of ${img.page_count}, which is not believable.`);
  }
  const pages = images.filter((i) => !dups.sameAs.has(i.image_index));
  const numbered = pages.map((i) => ({ img: i, page: pageNumberOf(i) }));
  const withNumbers = numbered.filter((p) => p.page !== null) as Array<{ img: ModelImage; page: number }>;
  if (withNumbers.length < numbered.length && numbered.length > 1) {
    const missing = numbered.filter((p) => p.page === null).map((p) => p.img.image_index);
    notices.push({ message: `No page number was read on image ${missing.join(', ')}, so page order could not be checked there.` });
  }
  const counts = new Map<number, number>();
  for (const p of withNumbers) counts.set(p.page, (counts.get(p.page) ?? 0) + 1);
  for (const [n, c] of counts) if (c > 1) details.push(`Page ${n} appears ${c} times as different pages.`);
  // Every number here is at most MAX_PAGES, so the loop below is bounded by a constant.
  const max = withNumbers.length ? Math.max(...withNumbers.map((p) => p.page)) : pages.length;
  const printedCounts = pages.map((p) => pageValue(p.page_count).value).filter((v): v is number => v !== null);
  const expectedPages = Math.min(MAX_PAGES, printedCounts.length ? Math.max(max, ...printedCounts) : max);
  if (withNumbers.length) {
    for (let p = 1; p <= expectedPages; p++) if (!counts.has(p)) details.push(`Page ${p} of ${expectedPages} is missing.`);
  }
  const last = withNumbers.length ? withNumbers.reduce((a, b) => (b.page > a.page ? b : a)).img : pages[pages.length - 1];
  if (last?.continued_marker) {
    details.push(`Page ${pageNumberOf(last) ?? last.image_index} says the invoice continues, but no later page was sent.`);
  }
  if (!pages.some((p) => p.has_totals)) details.push('No page shows the invoice total, so a page may be missing.');
  return { details: listProblems(details), notices };
}

/**
 * Every page must belong to this invoice. A page that shows the invoice number must show this
 * one. Some suppliers print the number on page 1 only, so a page with no number is tied by its
 * page number instead: the other pages must all show this invoice's number, and the page's
 * "n of m" must fit them (n not already taken, n no more than m, and the same m). A page with
 * neither an invoice number nor a page number cannot be tied, and fails.
 */
function checkSameInvoice(invoice: ModelInvoice, dups: DuplicatePages): { details: string[]; notices: Notice[] } {
  const main = normalizeInvoiceNumber(invoice.invoice_number);
  if (main === '') return { details: ['No invoice number was read.'], notices: [] };
  const details: string[] = [];
  const notices: Notice[] = [];
  const images = invoice.images;
  const shown = (img: ModelImage) => normalizeInvoiceNumber(img.invoice_number);
  for (const img of images) {
    if (shown(img) !== '' && shown(img) !== main) {
      details.push(`Image ${img.image_index} shows invoice ${img.invoice_number}, not ${invoice.invoice_number}. It may belong to a different invoice.`);
    }
  }
  if (images.length === 1) {
    if (shown(images[0]!) === '') notices.push({ message: 'No invoice number was read on the page itself.' });
    return { details: listProblems(details), notices };
  }
  const byIndex = new Map(images.map((img) => [img.image_index, img]));
  const numbered = images.filter((img) => shown(img) !== '');
  const othersAgree = numbered.length > 0 && numbered.every((img) => shown(img) === main);
  const taken = new Set(numbered.map(pageNumberOf).filter((n): n is number => n !== null));
  const counts = new Set(numbered.map((img) => pageValue(img.page_count).value).filter((n): n is number => n !== null));
  const maxCount = counts.size ? Math.max(...counts) : null;
  for (const img of images) {
    if (shown(img) !== '') continue;
    const label = `Image ${img.image_index}`;
    // Another photo of a page that shows this invoice's number is tied through that page.
    const original = byIndex.get(dups.sameAs.get(img.image_index) ?? -1);
    if (original && shown(original) === main) continue;
    const page = pageNumberOf(img);
    if (page === null) {
      details.push(`${label} shows neither an invoice number nor a page number, so it cannot be tied to invoice ${invoice.invoice_number}.`);
      continue;
    }
    if (!othersAgree) {
      details.push(`${label} shows no invoice number, and no other page shows ${invoice.invoice_number} to tie it to.`);
      continue;
    }
    const own = pageValue(img.page_count).value;
    const fits = !taken.has(page) && (maxCount === null || page <= maxCount) && (own === null || (page <= own && (counts.size === 0 || counts.has(own))));
    if (!fits) {
      details.push(`${label} shows no invoice number, and its page ${page}${own ? ` of ${own}` : ''} does not fit the other pages of invoice ${invoice.invoice_number}.`);
      continue;
    }
    taken.add(page);
    notices.push({ message: `${label} shows no invoice number. It was taken as page ${page} of invoice ${invoice.invoice_number}, from its page number.` });
  }
  return { details: listProblems(details), notices };
}

function checkRanges(lines: CheckedLine[], invoice: ModelInvoice, s: InvoiceReadingSettings): string[] {
  const r = s.ranges;
  const details: string[] = [];
  if (lines.length === 0) details.push('No product lines were read.');
  if (lines.length > r.maxLines) details.push(`${lines.length} lines is more than the limit of ${r.maxLines}.`);
  // Compared as scaled integers: |units| > max x 10^scale.
  const over = (d: Decimal | null, max: number) => d !== null && Math.abs(d.units) > max * 10 ** d.scale;
  for (const cl of lines) {
    const l = cl.line;
    const label = lineLabel(cl.n, l);
    for (const [field, text] of [
      ['quantity', l.qty_shipped],
      ['weight', l.weight],
      ['unit price', l.unit_price],
      ['allowance', l.allowance],
      ['line amount', l.extension],
    ] as const) {
      if (text.trim() !== '' && parseDecimal(text) === null) details.push(`${label}: the ${field} "${text.slice(0, 30)}" is not a number this app can check.`);
    }
    const qty = parseDecimal(l.qty_shipped);
    const weight = parseDecimal(l.weight);
    const price = parseDecimal(l.unit_price);
    if (over(qty, r.maxQuantity)) details.push(`${label}: quantity ${l.qty_shipped} is over ${r.maxQuantity}.`);
    if (weight && weight.units < 0) details.push(`${label}: weight ${l.weight} is negative.`);
    if (over(weight, r.maxWeightLb)) details.push(`${label}: weight ${l.weight} is over ${r.maxWeightLb} lb.`);
    if (price && price.units < 0) details.push(`${label}: unit price ${l.unit_price} is negative.`);
    if (over(price, r.maxUnitPrice)) details.push(`${label}: unit price ${l.unit_price} is over ${r.maxUnitPrice}.`);
    if (cl.extensionCents !== null && Math.abs(cl.extensionCents) > r.maxLineAmount * 100) {
      details.push(`${label}: amount ${l.extension} is over ${r.maxLineAmount}.`);
    }
    if (l.description.trim() === '' && l.item_number.trim() === '') details.push(`Line ${cl.n} has no description and no item number.`);
  }
  for (const c of invoice.charges) {
    if (c.amount.trim() !== '' && parseDecimal(c.amount) === null) details.push(`Charge "${c.description.slice(0, 40)}": "${c.amount.slice(0, 30)}" is not a number this app can check.`);
  }
  const total = parseCents(invoice.total);
  if (total !== null && Math.abs(total) > r.maxTotal * 100) details.push(`Total ${invoice.total} is over ${r.maxTotal}.`);
  if (invoice.total.trim() !== '' && total === null) details.push(`The total "${invoice.total.slice(0, 30)}" is not a number this app can check.`);
  return listProblems(details);
}

/** Parses the invoice date: the ISO form first, then the printed M/D/Y form. */
export function parseInvoiceDate(iso: string, printed: string): Date | null {
  const m1 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (m1) {
    const d = new Date(Date.UTC(+m1[1]!, +m1[2]! - 1, +m1[3]!));
    if (d.getUTCMonth() === +m1[2]! - 1) return d;
  }
  const m2 = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(printed.trim());
  if (m2) {
    let y = +m2[3]!;
    if (y < 100) y += 2000;
    const d = new Date(Date.UTC(y, +m2[1]! - 1, +m2[2]!));
    if (d.getUTCMonth() === +m2[1]! - 1) return d;
  }
  return null;
}

function checkDate(invoice: ModelInvoice, s: InvoiceReadingSettings, today: Date): string[] {
  const d = parseInvoiceDate(invoice.invoice_date_iso, invoice.invoice_date);
  if (!d) return [`The invoice date "${invoice.invoice_date.slice(0, 30)}" could not be read as a date.`];
  const day = 24 * 3600 * 1000;
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const age = Math.round((t - d.getTime()) / day);
  if (age > s.ranges.maxInvoiceAgeDays) return [`The invoice is dated ${invoice.invoice_date}, more than ${s.ranges.maxInvoiceAgeDays} days ago.`];
  if (-age > s.ranges.maxFutureDays) return [`The invoice is dated ${invoice.invoice_date}, which is in the future.`];
  return [];
}

function checkTotals(
  invoice: ModelInvoice,
  lines: CheckedLine[],
  charges: ModelCharge[],
  s: InvoiceReadingSettings,
): { totals: string[]; subtotal: string[] | null; linesTotal: number; chargesTotal: number; total: number | null } {
  const linesTotal = lines.reduce((sum, l) => sum + (l.extensionCents ?? 0), 0);
  const chargesTotal = charges.reduce((sum, c) => sum + (parseCents(c.amount) ?? 0), 0);
  const tax = parseCents(invoice.tax) ?? 0;
  const total = parseCents(invoice.total);
  const totals: string[] = [];
  if (total === null) {
    totals.push('No invoice total was read.');
  } else {
    const sum = linesTotal + chargesTotal + tax;
    if (!Number.isSafeInteger(sum)) {
      totals.push('The amounts are too large to add up exactly.');
    } else if (Math.abs(sum - total) > s.totalToleranceCents) {
      const parts = [`lines ${formatCents(linesTotal)}`];
      if (chargesTotal) parts.push(`charges ${formatCents(chargesTotal)}`);
      if (tax) parts.push(`tax ${formatCents(tax)}`);
      let msg = `${parts.join(' + ')} = ${formatCents(sum)}, but the invoice total reads ${formatCents(total)} (off by ${formatCents(total - sum)}).`;
      const diff = total - sum;
      const prev = parseCents(invoice.previous_balance);
      const hints: string[] = [];
      if (prev !== null && prev !== 0 && Math.abs(Math.abs(diff) - prev) <= s.totalToleranceCents) hints.push('the total may include the previous balance');
      const sameLine = lines.find((l) => l.extensionCents !== null && Math.abs(Math.abs(diff) - Math.abs(l.extensionCents)) <= s.totalToleranceCents);
      if (sameLine) hints.push(`a line like ${lineLabel(sameLine.n, sameLine.line)} may be missing or counted twice`);
      const sameCharge = charges.find((c) => Math.abs(Math.abs(diff) - Math.abs(parseCents(c.amount) ?? 0)) <= s.totalToleranceCents);
      if (sameCharge) hints.push(`the charge "${sameCharge.description.slice(0, 40)}" may be missing or counted twice`);
      if (hints.length) msg += ` Possibly ${hints.join('; or ')}.`;
      totals.push(msg);
    }
  }
  let subtotal: string[] | null = null;
  const printedSubtotal = parseCents(invoice.subtotal);
  if (printedSubtotal !== null) {
    const ok = [linesTotal, linesTotal + chargesTotal].some((v) => Math.abs(v - printedSubtotal) <= s.totalToleranceCents);
    subtotal = ok ? [] : [`The lines add up to ${formatCents(linesTotal)}, but the subtotal reads ${formatCents(printedSubtotal)}.`];
  }
  return { totals, subtotal, linesTotal, chargesTotal, total };
}

function checkTotalQuantity(invoice: ModelInvoice, lines: CheckedLine[]): string[] | null {
  const printed = parseDecimal(invoice.printed_total_quantity);
  if (printed === null) return null;
  let sum: Decimal = { units: 0, scale: 0 };
  for (const l of lines) {
    const q = parseDecimal(l.line.qty_shipped);
    if (q && q.units > 0) sum = subtract(sum, { units: -q.units, scale: q.scale });
  }
  return compareDecimal(sum, printed) === 0
    ? []
    : [`The shipped quantities add up to ${formatDecimal(sum)}, but the invoice prints a total quantity of ${invoice.printed_total_quantity}.`];
}

function checkUpcs(lines: CheckedLine[]): string[] {
  const details: string[] = [];
  for (const cl of lines) {
    const code = cl.line.upc.replace(/[\s-]/g, '');
    if (code === '' || ![8, 12, 13, 14].includes(code.length) || !/^\d+$/.test(code)) continue;
    if (!gtinCheckDigitValid(code)) {
      details.push(`${lineLabel(cl.n, cl.line)}: code ${code} fails its check digit, so a digit was probably misread.`);
    }
  }
  return listProblems(details);
}

function checkConfidence(invoice: ModelInvoice, lines: CheckedLine[]): { details: string[]; notices: Notice[] } {
  const details: string[] = [];
  const notices: Notice[] = [];
  if (invoice.overall_confidence === 'low') details.push('The model rated its own reading low confidence.');
  for (const cl of lines) {
    const note = cl.line.confidence_note.trim();
    if (cl.line.confidence === 'low') details.push(`${lineLabel(cl.n, cl.line)}: the model was unsure${note ? `: ${note}` : '.'}`);
    else if (cl.line.confidence === 'medium') notices.push({ message: `${lineLabel(cl.n, cl.line)}: medium confidence${note ? `: ${note}` : '.'}` });
  }
  for (const img of invoice.images) {
    if (img.readability === 'poor') notices.push({ message: `Image ${img.image_index} is hard to read.` });
  }
  for (const p of invoice.problems) if (p.trim()) notices.push({ message: `The model noted: ${p.trim()}` });
  return { details: listProblems(details, 20), notices };
}

/** Runs every check on a reading that already matches the schema. */
export function checkReading(raw: ModelInvoice, opts: CheckOptions): CheckedReading {
  const s = opts.settings;
  const bounded = boundReading(raw);
  const structure = checkStructure(bounded.invoice, opts.imagesSent);
  const invoice = structure.invoice;
  const checks: CheckResult[] = [];
  checks.push(result('schema', true, 'The reading has the expected shape and size.', 'The reading is malformed.', [...structure.problems, ...bounded.problems]));

  const dups = findDuplicatePages(invoice);
  const { lines: keptLines, charges, disagreements } = dropDuplicateContent(invoice, dups);
  const notices: Notice[] = [...dups.notices];

  const mathDetails: string[] = [];
  const lines: CheckedLine[] = keptLines.map((l, i) => {
    const { checked, mathProblem } = checkLine(i + 1, l, s.lineToleranceCents);
    if (mathProblem) mathDetails.push(mathProblem);
    return checked;
  });

  const pages = checkPages(invoice, dups, opts.imagesSent);
  notices.push(...pages.notices);
  checks.push(result('pages_complete', true, 'All pages are here, with no gaps.', 'Pages are missing or out of order.', pages.details));
  const same = checkSameInvoice(invoice, dups);
  notices.push(...same.notices);
  checks.push(result('same_invoice', true, 'Every page shows the same invoice number.', 'A page may belong to a different invoice.', same.details));
  checks.push(
    result('duplicate_pages_agree', true, 'Repeated photos of a page agree.', 'Repeated photos of a page do not agree.', [...dups.conflicts, ...disagreements]),
  );
  checks.push(result('line_math', true, 'Every line amount matches quantity or weight times price.', 'Some line amounts do not match quantity or weight times price.', listProblems(mathDetails, 20)));
  const t = checkTotals(invoice, lines, charges, s);
  checks.push(result('totals', true, 'The lines and charges add up to the printed total.', 'The lines and charges do not add up to the printed total.', t.totals));
  if (t.subtotal !== null) checks.push(result('subtotal', true, 'The lines add up to the printed subtotal.', 'The lines do not add up to the printed subtotal.', t.subtotal));
  const tq = checkTotalQuantity(invoice, lines);
  if (tq !== null) checks.push(result('total_quantity', true, 'The quantities add up to the printed total quantity.', 'The quantities do not add up to the printed total quantity.', tq));
  checks.push(result('ranges', true, 'Quantities, prices and amounts are in normal ranges.', 'Some values are outside normal ranges.', checkRanges(lines, invoice, s)));
  checks.push(result('catch_weight', true, 'Every catch-weight line has a believable piece count.', 'A catch-weight line has a piece count or weight that does not fit.', listProblems(checkCatchWeights(lines, s))));
  checks.push(result('invoice_date', false, 'The invoice date is recent.', 'The invoice date looks wrong.', checkDate(invoice, s, opts.today)));
  checks.push(result('upc_check_digits', s.upcCheckDigitsBlocking, 'Every printed product code passes its check digit.', 'A printed product code fails its check digit.', checkUpcs(lines)));
  const conf = checkConfidence(invoice, lines);
  notices.push(...conf.notices);
  checks.push(result('model_confidence', true, 'The model was confident in every line.', 'The model was unsure about part of the invoice.', conf.details));
  if (opts.knownItem) {
    const unknown: string[] = [];
    const misread: string[] = [];
    for (const cl of lines) {
      const a = opts.knownItem(cl, invoice);
      if (a.known) continue;
      const text = `${lineLabel(cl.n, cl.line)}: ${a.note ?? 'no matching Square item'}.`;
      unknown.push(text);
      if (a.possibleMisread) misread.push(text);
    }
    checks.push(result('misread_codes', true, 'No unmatched line has a code that looks misread.', 'An unmatched line has a code that looks misread.', listProblems(misread, 20)));
    checks.push(
      result(
        'known_items',
        opts.knownItemsBlocking ?? false,
        'Every line matches a known Square item or is marked not for resale.',
        'Some lines need a person: pick the Square item, or mark them new or not for resale.',
        listProblems(unknown, 20),
      ),
    );
  }
  for (const cl of lines) if (cl.received !== 'yes' && cl.flags.length) notices.push({ message: `${lineLabel(cl.n, cl.line)}: ${cl.flags[0]}` });

  const prev = parseCents(invoice.previous_balance);
  if (prev !== null && prev !== 0) notices.push({ message: `A previous balance of ${formatCents(prev)} is printed. It is not part of this invoice.` });

  return {
    invoice,
    lines,
    checks,
    failed: checks.filter((c) => c.blocking && !c.passed),
    notices,
    duplicateImages: [...dups.sameAs.keys()].sort((a, b) => a - b),
    linesTotalCents: t.linesTotal,
    chargesTotalCents: t.chargesTotal,
    totalCents: t.total,
  };
}
