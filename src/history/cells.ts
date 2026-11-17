// Cells shared by every tab of the purchase history spreadsheet, so a line reads the same on the
// All lines tab and on its vendor's tab.

import { parseDecimal } from '../invoice/money.ts';
import { STOPPED_REASON, type ExportRow } from './store.ts';
import { num, text, type Cell, type NumberFormat } from './sheet.ts';

/** A decimal text as a number cell, or the text itself when it is not a number. */
export function numberCell(value: string, format?: NumberFormat): Cell {
  if (value.trim() === '') return { kind: 'empty' };
  const d = parseDecimal(value);
  if (d === null) return text(value);
  return num(d.units / 10 ** d.scale, format);
}

/** Where a row comes from: "Old invoice 12" or "Invoice run 7". */
export function sourceText(r: Pick<ExportRow, 'source' | 'sourceId'>): string {
  return r.source === 'run' ? `Invoice run ${r.sourceId}` : `Old invoice ${r.sourceId}`;
}

/** The Reason column. A stopped run still counts, but every line needs a person to check it arrived. */
export function reasonText(r: ExportRow): string {
  return [...(r.stopped ? [STOPPED_REASON] : []), ...r.line.reasons, ...r.line.notes].join(' ');
}

/** The Needs check column. */
export function needsCheckText(r: ExportRow): string {
  return r.line.needsCheck || r.stopped ? 'Yes' : 'No';
}

/** The Extended column: the amount as ShelfReady parsed it, else the printed text. */
export function extendedCell(r: ExportRow): Cell {
  return r.line.extensionCents === null ? numberCell(r.line.extension, 'money') : num(r.line.extensionCents / 100, 'money');
}
