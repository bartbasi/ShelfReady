// The purchase history spreadsheet: one row per invoice line, old invoices and invoice runs
// together, one copy of each invoice, in the columns Bart asked for. The .xlsx adds one tab per
// vendor after it (src/history/vendors.ts). The .csv is the All lines tab only.

import type { ExportRow } from './store.ts';
import { extendedCell, needsCheckText, numberCell, reasonText, sourceText } from './cells.ts';
import { buildCsv, buildWorkbook, date, text, type Cell, type Sheet } from './sheet.ts';
import { ALL_LINES_TAB, vendorSheets } from './vendors.ts';

export { sourceText } from './cells.ts';

export const COLUMNS = ['Vendor', 'Invoice date', 'Invoice #', 'Product', 'Pack size', 'Qty bought', 'Unit', 'Unit price', 'Price per', 'Extended', 'Needs check', 'Reason', 'Source', 'Item #', 'UPC'] as const;

const WIDTHS = [22, 12, 14, 40, 16, 10, 7, 11, 9, 11, 11, 60, 16, 12, 16];

export function rowCells(r: ExportRow): Cell[] {
  const l = r.line;
  return [
    text(r.vendor),
    r.invoiceDateIso ? date(r.invoiceDateIso) : text(r.invoiceDate),
    text(r.invoiceNumber),
    text(l.product),
    text(l.pack),
    numberCell(l.qty),
    text(l.qtyUnit),
    numberCell(l.unitPrice, 'price'),
    text(l.pricePer),
    extendedCell(r),
    text(needsCheckText(r)),
    text(reasonText(r)),
    text(sourceText(r)),
    // Text, never numbers: item numbers and UPCs keep their leading zeros.
    text(l.itemNumber),
    text(l.upc),
  ];
}

/** The All lines tab, also the whole of the .csv. */
export function purchaseSheet(rows: readonly ExportRow[]): Sheet {
  return { name: ALL_LINES_TAB, header: [...COLUMNS], rows: rows.map(rowCells), widths: WIDTHS };
}

/** All lines, then one tab per vendor. range is only for the note on each vendor tab. */
export function purchaseXlsx(rows: readonly ExportRow[], range: { from?: string; to?: string } = {}): Uint8Array {
  return buildWorkbook([purchaseSheet(rows), ...vendorSheets(rows, range)]);
}

export function purchaseCsv(rows: readonly ExportRow[]): Buffer {
  return buildCsv(purchaseSheet(rows));
}

/** The download's file name, from the dates chosen. */
export function exportFileName(range: { from?: string; to?: string }, ext: 'xlsx' | 'csv'): string {
  const part = range.from && range.to ? `${range.from}-to-${range.to}` : range.from ? `from-${range.from}` : range.to ? `to-${range.to}` : 'all';
  return `purchase-history-${part}.${ext}`;
}
