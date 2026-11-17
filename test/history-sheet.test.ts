// The purchase history spreadsheet: the .xlsx opens (a valid zip of well-formed parts, no
// formula anywhere), and the .csv is escaped and guarded against formula injection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import { buildCsv, buildXlsx, columnName, date, excelDate, guardFormula, num, text, xmlSafe, type Sheet } from '../src/history/sheet.ts';
import { COLUMNS, purchaseSheet } from '../src/history/export.ts';
import type { ExportRow } from '../src/history/store.ts';

const chr = (n: number) => String.fromCharCode(n);

/** A small check that XML is well formed: tags balance, no stray & or <, attributes quoted. */
function assertWellFormed(xml: string, name: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(body))) {
    assert.equal(m.index, consumed, `${name}: something not XML at ${consumed}: ${body.slice(consumed, consumed + 40)}`);
    consumed = re.lastIndex;
    if (m[5] !== undefined) {
      assert.doesNotMatch(m[5], /&(?!(amp|lt|gt|quot|apos);)/, `${name}: a bare & in text`);
      continue;
    }
    const [, close, tag, , self] = m;
    if (self) continue;
    if (close) assert.equal(stack.pop(), tag, `${name}: </${tag}> does not close the open tag`);
    else stack.push(tag!);
  }
  assert.equal(consumed, body.length, `${name}: unparsed tail`);
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

function row(fields: Partial<ExportRow['line']> & { vendor?: string; date?: string; number?: string }): ExportRow {
  return {
    source: 'old',
    sourceId: 4,
    stopped: false,
    invoiceId: 4,
    recordedAt: 0,
    vendorKey: 'hollow creek dairy',
    vendor: fields.vendor ?? 'Hollow Creek Dairy',
    invoiceDateIso: fields.date ?? '2026-03-14',
    invoiceDate: '03/14/26',
    invoiceNumber: fields.number ?? 'HC-1001',
    line: {
      id: 1,
      n: 1,
      page: 1,
      filePosition: 1,
      itemNumber: '',
      upc: '',
      description: '',
      brand: '',
      product: '2 Year Old Cheddar',
      packSize: '',
      unitsPerPack: '',
      pack: '',
      qtyShipped: '5',
      unit: 'LB',
      weight: '',
      unitPrice: '6.00',
      priceUnit: 'LB',
      allowance: '',
      extension: '30.00',
      qty: '5',
      qtyUnit: 'LB',
      pricePer: 'LB',
      extensionCents: 3000,
      printedStatus: 'shipped',
      confidence: 'high',
      confidenceNote: '',
      needsCheck: false,
      reasons: [],
      notes: [],
      ...fields,
    },
  };
}

function unzipXlsx(bytes: Uint8Array): Record<string, string> {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

test('the xlsx is a zip with every part a spreadsheet needs, all well formed', () => {
  const rows = [row({}), row({ product: 'Wasabi Paste', pack: '12 units/case', qty: '2', qtyUnit: 'CS', unitPrice: '36.00', pricePer: 'CS', extensionCents: 7200, vendor: 'Kaito Trading' })];
  const bytes = buildXlsx(purchaseSheet(rows));
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'a zip file');
  const parts = unzipXlsx(bytes);
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(parts[name], `has ${name}`);
    assertWellFormed(parts[name]!, name);
  }
  // Every part the workbook points at exists, and every part has its content type.
  assert.match(parts['xl/_rels/workbook.xml.rels']!, /Target="worksheets\/sheet1\.xml"/);
  assert.match(parts['[Content_Types].xml']!, /PartName="\/xl\/worksheets\/sheet1\.xml"/);
  assert.match(parts['[Content_Types].xml']!, /PartName="\/xl\/styles\.xml"/);
  assert.match(parts['xl/workbook.xml']!, /<sheet name="All lines" sheetId="1" r:id="rId1"\/>/);
});

test('the sheet has a bold frozen header, numbers as numbers, a real date, and never a formula', () => {
  const parts = unzipXlsx(buildXlsx(purchaseSheet([row({}), row({ needsCheck: true, reasons: ['Short shipped.'], extensionCents: -1250, qty: '-1', number: '00123' })])));
  const sheet = parts['xl/worksheets/sheet1.xml']!;
  const styles = parts['xl/styles.xml']!;
  // No formula element, no shared formula, nothing a spreadsheet would calculate.
  assert.doesNotMatch(sheet, /<f[\s>/]/);
  assert.doesNotMatch(sheet, /t="str"|t="e"/);
  // Header: inline strings in style 1, whose font is bold.
  for (const [i, name] of COLUMNS.entries()) assert.ok(sheet.includes(`<c r="${columnName(i)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${name}</t></is></c>`), name);
  assert.match(styles, /<cellXfs count="6"><xf [^>]*\/><xf numFmtId="0" fontId="1"/);
  assert.match(styles, /<fonts count="2"><font>.*?<\/font><font><b\/>/);
  // The top row is frozen.
  assert.match(sheet, /<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"\/>/);
  // Numbers are numbers: no type attribute, the value as written.
  assert.ok(sheet.includes('<c r="F2"><v>5</v></c>'), 'qty');
  assert.ok(sheet.includes('<c r="H2" s="4"><v>6</v></c>'), 'unit price');
  assert.ok(sheet.includes('<c r="J2" s="3"><v>30</v></c>'), 'extended');
  assert.ok(sheet.includes('<c r="J3" s="3"><v>-12.5</v></c>'), 'a credit is a negative number, not guarded text');
  assert.ok(sheet.includes('<c r="F3"><v>-1</v></c>'));
  // The invoice date is a date number with a date format.
  assert.ok(sheet.includes(`<c r="B2" s="2"><v>${excelDate('2026-03-14')}</v></c>`));
  assert.equal(excelDate('2026-03-14'), 46095);
  assert.match(styles, /numFmtId="164" formatCode="yyyy-mm-dd"/);
  // An invoice number stays text, leading zeros and all.
  assert.ok(sheet.includes('<c r="C3" t="inlineStr"><is><t xml:space="preserve">00123</t></is></c>'));
  assert.ok(sheet.includes('<t xml:space="preserve">Yes</t>') && sheet.includes('<t xml:space="preserve">Short shipped.</t>'));
});

test('text cells in the xlsx are guarded, escaped and cleaned of characters XML cannot hold', () => {
  const evil = '=HYPERLINK("http://x.example","click")';
  const sheet: Sheet = {
    name: 'T',
    header: ['A', 'B', 'C', 'D', 'E', 'F'],
    rows: [[text(evil), text('+1'), text('@SUM(A1)'), text(`${chr(9)}tab`), text(`Tom & <Jerry> "x" 'y'`), text(`bell${chr(7)}nul${chr(0)}ok`)]],
  };
  const xml = unzipXlsx(buildXlsx(sheet))['xl/worksheets/sheet1.xml']!;
  assertWellFormed(xml, 'sheet');
  assert.ok(xml.includes(`<t xml:space="preserve">&apos;=HYPERLINK(&quot;http://x.example&quot;,&quot;click&quot;)</t>`));
  assert.ok(xml.includes(`<t xml:space="preserve">&apos;+1</t>`));
  assert.ok(xml.includes(`<t xml:space="preserve">&apos;@SUM(A1)</t>`));
  assert.ok(xml.includes(`<t xml:space="preserve">&apos;${chr(9)}tab</t>`));
  assert.ok(xml.includes('<t xml:space="preserve">Tom &amp; &lt;Jerry&gt; &quot;x&quot; &apos;y&apos;</t>'));
  assert.ok(xml.includes('<t xml:space="preserve">bellnulok</t>'), 'control characters dropped');
  assert.doesNotMatch(xml, /<f[\s>/]/);
});

test('the guard and the XML cleaner', () => {
  for (const c of ['=', '+', '-', '@', chr(9), chr(13)]) assert.equal(guardFormula(`${c}x`), `'${c}x`, JSON.stringify(c));
  for (const s of ['x=1', ' =1', 'Cheddar', '', "'already"]) assert.equal(guardFormula(s), s);
  assert.equal(xmlSafe(`a${chr(0x1f)}b${chr(0xfffe)}c${chr(0xd800)}d`), 'abcd');
  assert.equal(xmlSafe('Gruyère 🧀 Türkiye'), 'Gruyère 🧀 Türkiye');
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702].map(columnName), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
});

test('the csv is UTF-8 with a byte order mark, quoted where needed, CRLF lines', () => {
  const sheet: Sheet = {
    name: 'T',
    header: ['Vendor', 'Product', 'Qty', 'Date'],
    rows: [
      [text('Kaito Trading, Ltd.'), text('Gruyère "AOP" 12mo'), num(2.5), date('2026-03-14')],
      [text('Line\nbreak'), text('plain'), num(-12.5), { kind: 'empty' }],
    ],
  };
  const buf = buildCsv(sheet);
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the byte order mark');
  const body = buf.subarray(3).toString('utf8');
  assert.equal(body, 'Vendor,Product,Qty,Date\r\n"Kaito Trading, Ltd.","Gruyère ""AOP"" 12mo",2.5,2026-03-14\r\n"Line\nbreak",plain,-12.5,\r\n');
});

test('csv cells that could run as formulas get an apostrophe, numbers do not', () => {
  const sheet: Sheet = {
    name: 'T',
    header: ['A'],
    rows: [[text('=1+2')], [text('+SUM(A1:A2)')], [text('-2+3')], [text('@cmd')], [text(`${chr(9)}=1`)], [text(`${chr(13)}=1`)], [text('=x,"y"')], [num(-3)]],
  };
  const lines = buildCsv(sheet).subarray(3).toString('utf8').split('\r\n');
  assert.deepEqual(lines.slice(1, -1), ["'=1+2", "'+SUM(A1:A2)", "'-2+3", "'@cmd", `'${chr(9)}=1`, `"'${chr(13)}=1"`, `"'=x,""y"""`, '-3']);
});

test('the purchase sheet has the columns Bart asked for, in order', () => {
  assert.deepEqual(COLUMNS, ['Vendor', 'Invoice date', 'Invoice #', 'Product', 'Pack size', 'Qty bought', 'Unit', 'Unit price', 'Price per', 'Extended', 'Needs check', 'Reason', 'Source', 'Item #', 'UPC']);
  const csv = buildCsv(purchaseSheet([row({ itemNumber: '00412', upc: '012345678905', product: 'Wasabi Paste', pack: '12 units/case', qty: '2', qtyUnit: 'CS', unitPrice: '36.00', pricePer: 'CS', extensionCents: 7200, vendor: 'Kaito Trading', needsCheck: true, reasons: ['Short shipped.'], notes: ['Allowance of 0.50 off each unit price.'] })]));
  const lines = csv.subarray(3).toString('utf8').split('\r\n');
  assert.equal(lines[1], 'Kaito Trading,2026-03-14,HC-1001,Wasabi Paste,12 units/case,2,CS,36,CS,72,Yes,Short shipped. Allowance of 0.50 off each unit price.,Old invoice 4,00412,012345678905');
  // Item # and UPC are text in the xlsx, so leading zeros stay; Source names a run too.
  const xml = strFromU8(unzipSync(buildXlsx(purchaseSheet([{ ...row({ itemNumber: '00412', upc: '012345678905' }), source: 'run', sourceId: 9 }])))['xl/worksheets/sheet1.xml']!);
  assert.ok(xml.includes('<c r="M2" t="inlineStr"><is><t xml:space="preserve">Invoice run 9</t></is></c>'));
  assert.ok(xml.includes('<c r="N2" t="inlineStr"><is><t xml:space="preserve">00412</t></is></c>'));
  assert.ok(xml.includes('<c r="O2" t="inlineStr"><is><t xml:space="preserve">012345678905</t></is></c>'));
});
