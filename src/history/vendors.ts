// One tab per vendor in the purchase history .xlsx: every product bought from that vendor once, at
// its most recent purchase, with how many times it was bought and the price movement since the
// purchase before. Pure functions over the same rows as the All lines tab, so the same invoices
// count and one invoice is never there twice (src/history/store.ts exportRows).
//
// - Vendors group by their folded name (vendor_key), so two spellings are one vendor. The tab is
//   named from the most recent spelling, and tabs are sorted A to Z.
// - The same product: the item number when one was read, else the UPC, else the product name
//   folded (case, spaces, punctuation).
// - A purchase is a line where something arrived: not out of stock, quantity not zero or less, not
//   a credit, amount not negative. Lines of a stopped run are used only when a product has no other
//   purchase. A flagged line is a purchase like any other, and keeps its Needs check and Reason.
// - The latest purchase: the latest invoice date, then the later-recorded invoice, then line order.
// - Times bought counts invoices, not lines: a product twice on one invoice was bought once. When
//   one invoice has it on several lines, the row uses that invoice's last counted line and its
//   Reason says "On this invoice N times."
// - Previous: the latest purchase on an earlier invoice, never the latest's own invoice, that has
//   a unit price with the same Price per.
// - On the "Vendor not read" tab nothing is compared: those invoices may be from different
//   vendors, so Times bought, Previous and Change % stay blank.
//   Change % is a number with a percent format, rounded to 0.1 percent. Never a formula.

import { parseDecimal, type Decimal } from '../invoice/money.ts';
import type { ExportRow } from './store.ts';
import { extendedCell, needsCheckText, numberCell, reasonText, sourceText } from './cells.ts';
import { date, num, text, uniqueTabNames, type Cell, type Sheet } from './sheet.ts';

export const VENDOR_COLUMNS = [
  'Product',
  'Item #',
  'UPC',
  'Pack size',
  'Last bought',
  'Qty',
  'Unit',
  'Unit price',
  'Price per',
  'Extended',
  'Invoice #',
  'Source',
  'Times bought',
  'Previous unit price',
  'Previous date',
  'Change %',
  'Needs check',
  'Reason',
] as const;

const VENDOR_WIDTHS = [40, 12, 16, 16, 12, 9, 7, 11, 9, 11, 14, 16, 8, 12, 12, 9, 11, 60];

/** The first tab. */
export const ALL_LINES_TAB = 'All lines';

/** Most vendor tabs in one file. Vendors past it share one tab. */
export const MAX_VENDOR_TABS = 500;

export const OTHER_VENDORS_TAB = 'Other vendors';

/** Shown when a vendor's name was not read. */
export const NO_VENDOR_NAME = 'Vendor not read';

/** Text folded for comparing: no accents, lower case, punctuation and runs of spaces as one space. */
export function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Which product a line is: the item number, else the UPC, else the folded product name. */
export function productKey(r: Pick<ExportRow, 'invoiceId' | 'line'>): string {
  const item = r.line.itemNumber.replace(/\s+/g, '').toUpperCase();
  if (item) return `n:${item}`;
  const upc = r.line.upc.replace(/\D/g, '');
  if (upc) return `u:${upc}`;
  const name = fold(r.line.product);
  if (name) return `d:${name}`;
  // Nothing to tell it by: it stands alone rather than merging with other unnamed lines.
  return `x:${r.invoiceId}:${r.line.n}`;
}

/** Something arrived on the line: not out of stock, a quantity above zero, not a credit. */
export function isPurchase(r: ExportRow): boolean {
  const l = r.line;
  if (l.printedStatus === 'out_of_stock' || l.printedStatus === 'credit') return false;
  if (l.extensionCents !== null && l.extensionCents < 0) return false;
  const q = parseDecimal(l.qty);
  if (q !== null && q.units <= 0) return false;
  return true;
}

/** Oldest first: invoice date (none read counts as oldest), then when recorded, then the line. */
export function purchaseOrder(a: ExportRow, b: ExportRow): number {
  if (a.invoiceDateIso !== b.invoiceDateIso) return a.invoiceDateIso < b.invoiceDateIso ? -1 : 1;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt - b.recordedAt;
  if (a.invoiceId !== b.invoiceId) return a.invoiceId - b.invoiceId;
  return a.line.n - b.line.n;
}

const pricePerKey = (r: ExportRow) => r.line.pricePer.trim().toUpperCase();

function price(r: ExportRow): Decimal | null {
  return parseDecimal(r.line.unitPrice);
}

/**
 * (latest - previous) / previous, rounded to 0.1 percent (0.001 as a fraction), worked out from
 * the exact decimals. Null when either price is missing or the previous one is zero.
 */
export function changeFraction(latest: Decimal | null, previous: Decimal | null): number | null {
  if (!latest || !previous || previous.units === 0) return null;
  const scale = Math.max(latest.scale, previous.scale);
  const l = latest.units * 10 ** (scale - latest.scale);
  const p = previous.units * 10 ** (scale - previous.scale);
  if (!Number.isSafeInteger(l) || !Number.isSafeInteger((l - p) * 1000)) return null;
  // Thousandths, half away from zero, in whole numbers before the one division.
  const n = (l - p) * 1000;
  const q = Math.floor(Math.abs(n) / Math.abs(p));
  const rem = Math.abs(n) - q * Math.abs(p);
  const rounded = (rem * 2 >= Math.abs(p) ? q + 1 : q) * Math.sign(n) * Math.sign(p);
  return rounded / 1000 || 0;
}

export interface ProductSummary {
  key: string;
  /** The latest invoice's last counted line for this product. */
  latest: ExportRow;
  /** Counted invoices with this product: one invoice counts once, however many lines. */
  times: number;
  /** Counted lines for this product on the latest invoice. */
  onInvoice: number;
  /** From an earlier invoice, never the latest's own. Null when not compared. */
  previous: ExportRow | null;
  /** As a fraction: 0.125 is 12.5 percent. */
  change: number | null;
}

/**
 * One product's purchases, already of one vendor and one product key. Null when none counts.
 * compare false (the vendor was not read): no previous price and no change.
 */
export function summarizeProduct(key: string, lines: readonly ExportRow[], compare = true): ProductSummary | null {
  const bought = lines.filter(isPurchase);
  const live = bought.filter((r) => !r.stopped);
  // A stopped run's lines are used only when nothing else was bought.
  const set = (live.length ? live : bought).slice().sort(purchaseOrder).reverse();
  // Newest first, and within an invoice the last line first: so this is the latest invoice's last line.
  const latest = set[0];
  if (!latest) return null;
  const times = new Set(set.map((r) => r.invoiceId)).size;
  const onInvoice = set.filter((r) => r.invoiceId === latest.invoiceId).length;
  const previous = compare ? (set.find((r) => r.invoiceId !== latest.invoiceId && price(r) !== null && pricePerKey(r) === pricePerKey(latest)) ?? null) : null;
  return { key, latest, times, onInvoice, previous, change: previous ? changeFraction(price(latest), price(previous)) : null };
}

/** Said in row 1 of the tab for invoices whose vendor was not read. */
export const NOT_COMPARED_NOTE = 'The vendor was not read on these invoices, so no prices are compared.';

export interface VendorSummary {
  key: string;
  /** The most recent spelling. */
  name: string;
  /** False when the vendor was not read: the invoices may be from different vendors. */
  compared: boolean;
  products: ProductSummary[];
}

/** Every vendor with at least one purchase, sorted A to Z by name, products A to Z within. */
export function summarizeVendors(rows: readonly ExportRow[]): VendorSummary[] {
  const byVendor = new Map<string, ExportRow[]>();
  for (const r of rows) byVendor.set(r.vendorKey, [...(byVendor.get(r.vendorKey) ?? []), r]);
  const out: VendorSummary[] = [];
  for (const [key, list] of byVendor) {
    const newest = list.slice().sort(purchaseOrder).at(-1)!;
    const name = newest.vendor.trim() || NO_VENDOR_NAME;
    const compared = key !== '';
    const byProduct = new Map<string, ExportRow[]>();
    for (const r of list) {
      const k = productKey(r);
      byProduct.set(k, [...(byProduct.get(k) ?? []), r]);
    }
    const products = [...byProduct]
      .map(([k, l]) => summarizeProduct(k, l, compared))
      .filter((p): p is ProductSummary => p !== null)
      .sort((a, b) => a.latest.line.product.localeCompare(b.latest.line.product, 'en', { sensitivity: 'base' }) || a.key.localeCompare(b.key));
    if (products.length) out.push({ key, name, compared, products });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.key.localeCompare(b.key));
}

function productCells(p: ProductSummary, compared: boolean): Cell[] {
  const r = p.latest;
  const l = r.line;
  const empty: Cell = { kind: 'empty' };
  const reason = [reasonText(r), p.onInvoice > 1 ? `On this invoice ${p.onInvoice} times.` : ''].filter(Boolean).join(' ');
  return [
    text(l.product),
    text(l.itemNumber),
    text(l.upc),
    text(l.pack),
    r.invoiceDateIso ? date(r.invoiceDateIso) : text(r.invoiceDate),
    numberCell(l.qty),
    text(l.qtyUnit),
    numberCell(l.unitPrice, 'price'),
    text(l.pricePer),
    extendedCell(r),
    text(r.invoiceNumber),
    text(sourceText(r)),
    // The vendor not read: the invoices may be from different vendors, so nothing is counted across them.
    compared ? num(p.times) : empty,
    p.previous ? numberCell(p.previous.line.unitPrice, 'price') : empty,
    p.previous ? (p.previous.invoiceDateIso ? date(p.previous.invoiceDateIso) : text(p.previous.invoiceDate)) : empty,
    num(p.change, 'percent'),
    text(needsCheckText(r)),
    text(reason),
  ];
}

/** The note in row 1 when dates were chosen. */
export function rangeNote(range: { from?: string; to?: string }): string {
  const span = range.from && range.to ? `from ${range.from} to ${range.to}` : range.from ? `from ${range.from} on` : range.to ? `up to ${range.to}` : '';
  return span ? `Only purchases dated ${span}. Previous prices come from those dates too.` : '';
}

/**
 * The vendor tabs, after the All lines tab. Past MAX_VENDOR_TABS vendors, the rest share one
 * "Other vendors" tab with a Vendor column.
 */
export function vendorSheets(rows: readonly ExportRow[], range: { from?: string; to?: string } = {}, maxTabs = MAX_VENDOR_TABS): Sheet[] {
  const vendors = summarizeVendors(rows);
  const own = vendors.slice(0, maxTabs);
  const rest = vendors.slice(maxTabs);
  const note = rangeNote(range);
  const names = uniqueTabNames(
    own.map((v) => v.name),
    rest.length ? [ALL_LINES_TAB, OTHER_VENDORS_TAB] : [ALL_LINES_TAB],
  );
  const sheets: Sheet[] = own.map((v, i) => ({
    name: names[i]!,
    title: [text(v.name), text([v.compared ? '' : NOT_COMPARED_NOTE, note].filter(Boolean).join(' '))],
    header: [...VENDOR_COLUMNS],
    rows: v.products.map((p) => productCells(p, v.compared)),
    widths: VENDOR_WIDTHS,
  }));
  if (rest.length) {
    sheets.push({
      name: OTHER_VENDORS_TAB,
      title: [text(OTHER_VENDORS_TAB), text([`${rest.length} more ${rest.length === 1 ? 'vendor' : 'vendors'}, past the limit of ${maxTabs} tabs.`, note].filter(Boolean).join(' '))],
      header: ['Vendor', ...VENDOR_COLUMNS],
      rows: rest.flatMap((v) => v.products.map((p) => [text(v.name), ...productCells(p, v.compared)])),
      widths: [22, ...VENDOR_WIDTHS],
    });
  }
  return sheets;
}
