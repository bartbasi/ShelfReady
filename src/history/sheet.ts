// The purchase history as a spreadsheet: a minimal .xlsx built with fflate, and a .csv.
//
// The .xlsx has one or more tabs, inline strings, numbers as numbers, dates as real dates, a bold
// header row frozen at the top (below an optional title row), and never a formula. The .csv is UTF-8 with a byte order
// mark, so Excel reads accents right.
//
// Text from an invoice is untrusted. A text cell that starts with = + - @, a tab or a carriage
// return gets an apostrophe in front, in both files, so no spreadsheet runs it as a formula.
// Number cells are written only from numbers this code parsed, never from raw text. Characters
// XML cannot hold are dropped from the .xlsx.

import { strToU8, zipSync } from 'fflate';

export type NumberFormat = 'money' | 'price' | 'percent';

export type Cell = { kind: 'text'; value: string } | { kind: 'number'; value: number; format?: NumberFormat } | { kind: 'date'; iso: string } | { kind: 'empty' };

export interface Sheet {
  name: string;
  header: string[];
  rows: Cell[][];
  /** Column widths in characters, one per header cell. */
  widths?: number[];
  /** A row above the header, for example a vendor's full name. The header is frozen below it. */
  title?: Cell[];
}

export const text = (value: string): Cell => (value === '' ? { kind: 'empty' } : { kind: 'text', value });
export const num = (value: number | null, format?: NumberFormat): Cell => (value === null || !Number.isFinite(value) ? { kind: 'empty' } : { kind: 'number', value, format });
export const date = (iso: string): Cell => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? { kind: 'date', iso } : { kind: 'empty' });

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_START = new Set(['=', '+', '-', '@', String.fromCharCode(9), String.fromCharCode(13)]);

/** Puts an apostrophe in front of text a spreadsheet could take as a formula. */
export function guardFormula(value: string): string {
  return value !== '' && FORMULA_START.has(value[0]!) ? `'${value}` : value;
}

/** Drops characters XML 1.0 cannot hold: most control characters, lone surrogates, U+FFFE and U+FFFF. */
export function xmlSafe(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    const ok = c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff);
    if (ok) out += ch;
  }
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&apos;'));
}

/** Column letters: 0 is A, 25 is Z, 26 is AA. */
export function columnName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Days since 1899-12-30, the date number spreadsheets use. */
export function excelDate(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** A number as text a spreadsheet reads exactly: no exponent, no locale. */
function numberText(n: number): string {
  if (Object.is(n, -0)) return '0';
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(10).replace(/\.?0+$/, '');
}

// Styles, by index in cellXfs below.
const STYLE = { plain: 0, header: 1, date: 2, money: 3, price: 4, percent: 5 } as const;

function cellXml(cell: Cell, ref: string, bold: boolean): string {
  if (cell.kind === 'empty') return bold ? `<c r="${ref}" s="${STYLE.header}"/>` : '';
  if (cell.kind === 'number') {
    const s = cell.format ? STYLE[cell.format] : STYLE.plain;
    return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${numberText(cell.value)}</v></c>`;
  }
  if (cell.kind === 'date') return `<c r="${ref}" s="${STYLE.date}"><v>${excelDate(cell.iso)}</v></c>`;
  const v = escapeXml(xmlSafe(guardFormula(cell.value)));
  return `<c r="${ref}" t="inlineStr"${bold ? ` s="${STYLE.header}"` : ''}><is><t xml:space="preserve">${v}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.min(80, w))}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const rows: string[] = [];
  // An optional title row (a vendor's full name), then the bold header, then the data.
  const top: Cell[][] = sheet.title ? [sheet.title] : [];
  const all: Cell[][] = [...top, sheet.header.map((h) => text(h)), ...sheet.rows];
  const bold = top.length + 1;
  all.forEach((row, r) => {
    const cells = row.map((c, i) => cellXml(c, `${columnName(i)}${r + 1}`, r < bold)).join('');
    rows.push(`<row r="${r + 1}">${cells}</row>`);
  });
  const width = Math.max(sheet.header.length, ...all.map((r) => r.length));
  const lastCol = columnName(Math.max(0, width - 1));
  // Frozen below the header, so it stays in view while scrolling.
  const first = `A${bold + 1}`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:${lastCol}${all.length}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${bold}" topLeftCell="${first}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="${first}" sqref="${first}"/></sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    `<sheetData>${rows.join('')}</sheetData>` +
    '<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="0.00##"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="6">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const ROOT_RELS_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

function contentTypesXml(count: number): string {
  const sheets = Array.from({ length: count }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    sheets +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>'
  );
}

/** Sheets are rId1 to rIdN; the styles part is rId(N+1). */
function workbookRelsXml(count: number): string {
  const sheets = Array.from({ length: count }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets +
    `<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>'
  );
}

/** Excel's limit on a tab name, in UTF-16 units. */
export const MAX_TAB_NAME = 31;

/** Names Excel keeps for itself. */
const RESERVED_TAB_NAMES = new Set(['history']);

/** Cuts text to at most max UTF-16 units without splitting a character. */
function cut(value: string, max: number): string {
  let out = '';
  for (const ch of value) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/** Drops apostrophes and spaces from both ends. Excel refuses a name that starts or ends with an apostrophe. */
function trimEnds(value: string): string {
  return value.replace(/^['\s]+|['\s]+$/g, '');
}

/**
 * A tab name Excel accepts: no [ ] : * ? / \, no control characters, no apostrophe at either
 * end, at most 31 characters, and never a name Excel keeps for itself ("History").
 */
export function tabName(raw: string, fallback = 'Sheet'): string {
  let name = trimEnds(xmlSafe(raw).replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' '));
  name = trimEnds(cut(name, MAX_TAB_NAME));
  if (name === '') name = fallback;
  if (RESERVED_TAB_NAMES.has(name.toLowerCase())) name = `${name} (vendor)`;
  return name;
}

/**
 * Tab names for these raw names, in order: each made safe by tabName and unique ignoring case, by
 * adding " (2)", " (3)" and so on, cutting the name to keep within 31 characters. taken holds names
 * already used, such as the first tab.
 */
export function uniqueTabNames(raws: readonly string[], taken: readonly string[] = []): string[] {
  const used = new Set(taken.map((t) => t.toLowerCase()));
  return raws.map((raw) => {
    const base = tabName(raw);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const tail = ` (${n})`;
      name = `${trimEnds(cut(base, MAX_TAB_NAME - tail.length))}${tail}`;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function workbookXml(names: readonly string[]): string {
  const sheets = names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheets}</sheets>` +
    '</workbook>'
  );
}

/**
 * The .xlsx file with these tabs, in order. Names are made safe and unique here too, so a caller
 * can never produce a file Excel refuses. mtime fixes the time stored in the zip, so the same rows
 * give the same bytes.
 */
export function buildWorkbook(sheets: readonly Sheet[], mtime: Date = new Date(Date.UTC(2026, 0, 1))): Uint8Array {
  if (sheets.length === 0) throw new Error('A workbook needs at least one sheet.');
  const names = uniqueTabNames(sheets.map((s) => s.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypesXml(sheets.length)),
    '_rels/.rels': strToU8(ROOT_RELS_XML),
    'xl/workbook.xml': strToU8(workbookXml(names)),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRelsXml(sheets.length)),
    'xl/styles.xml': strToU8(STYLES_XML),
  };
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s));
  });
  return zipSync(files, { level: 6, mtime });
}

/** The .xlsx file with one tab. */
export function buildXlsx(sheet: Sheet, mtime?: Date): Uint8Array {
  return buildWorkbook([sheet], mtime);
}

function csvField(cell: Cell): string {
  let v: string;
  if (cell.kind === 'empty') return '';
  if (cell.kind === 'number') v = numberText(cell.value);
  else if (cell.kind === 'date') v = cell.iso;
  else v = guardFormula(cell.value);
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const BOM = String.fromCharCode(0xfeff);

/** The .csv file: UTF-8 with a byte order mark, lines ending CRLF. */
export function buildCsv(sheet: Sheet): Buffer {
  const lines = [sheet.header.map((h) => csvField(text(h))), ...sheet.rows.map((r) => r.map(csvField))].map((f) => f.join(','));
  return Buffer.from(BOM + lines.join('\r\n') + '\r\n', 'utf8');
}
