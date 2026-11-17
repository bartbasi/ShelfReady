// The vendor tabs of the purchase history .xlsx: grouping, the same-product keys, the latest
// purchase and what is skipped, flagged lines, previous price and change, tab names, a valid
// workbook with many sheets, a date range, the tab cap, and never a formula. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';
import type { ExportRow } from '../src/history/store.ts';
import { STOPPED_REASON } from '../src/history/store.ts';
import { purchaseXlsx } from '../src/history/export.ts';
import { tabName, uniqueTabNames, MAX_TAB_NAME } from '../src/history/sheet.ts';
import { changeFraction, productKey, summarizeVendors, VENDOR_COLUMNS, vendorSheets } from '../src/history/vendors.ts';
import { parseDecimal } from '../src/invoice/money.ts';
import { fakeClient, image, invoice, line, testImage } from './invoice-fixtures.ts';
import { makeRunApp, multipart, signIn } from './runs-fixtures.ts';
import { ORIGIN } from './server-helpers.ts';

let nextId = 1;

/** One invented export row. Fields of the line go in line; the rest on the row. */
function row(o: Partial<Omit<ExportRow, 'line'>> & { line?: Partial<ExportRow['line']> } = {}): ExportRow {
  const id = o.invoiceId ?? nextId++;
  return {
    source: 'old',
    sourceId: id,
    stopped: false,
    invoiceId: id,
    recordedAt: id,
    vendorKey: 'hollow creek dairy',
    vendor: 'Hollow Creek Dairy',
    invoiceDateIso: '2026-03-14',
    invoiceDate: '03/14/26',
    invoiceNumber: `HC-${id}`,
    ...o,
    line: {
      id,
      n: 1,
      page: 1,
      filePosition: 1,
      itemNumber: 'K1',
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
      ...o.line,
    },
  };
}

function only(rows: ExportRow[]) {
  const vendors = summarizeVendors(rows);
  assert.equal(vendors.length, 1);
  return vendors[0]!;
}

function unzip(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
}

/** Tags balance, no stray & or <, attributes quoted. */
function assertWellFormed(xml: string, name: string): void {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let at = 0;
  while ((m = re.exec(body))) {
    assert.equal(m.index, at, `${name}: not XML at ${at}`);
    at = re.lastIndex;
    if (m[5] !== undefined) {
      assert.doesNotMatch(m[5], /&(?!(amp|lt|gt|quot|apos);)/, `${name}: a bare &`);
      continue;
    }
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `${name}: </${m[2]}> closes the wrong tag`);
    else stack.push(m[2]!);
  }
  assert.equal(at, body.length, `${name}: unparsed tail`);
  assert.deepEqual(stack, [], `${name}: unclosed tags`);
}

test('vendors group by their folded name, named from the most recent spelling, A to Z', () => {
  const rows = [
    row({ vendorKey: 'harbor imports', vendor: 'HARBOR IMPORTS INC.', invoiceDateIso: '2026-01-10' }),
    row({ vendorKey: 'harbor imports', vendor: 'Harbor Imports', invoiceDateIso: '2026-05-02' }),
    row({ vendorKey: 'acme foods', vendor: 'Acme Foods', invoiceDateIso: '2026-02-01' }),
    row({ vendorKey: '', vendor: '', invoiceDateIso: '2026-02-01' }),
  ];
  const vendors = summarizeVendors(rows);
  assert.deepEqual(vendors.map((v) => v.name), ['Acme Foods', 'Harbor Imports', 'Vendor not read']);
  assert.equal(vendors[1]!.products[0]!.times, 2, 'both spellings are one vendor');
});

test('the same product: item number, else UPC, else the folded name', () => {
  assert.equal(productKey(row({ line: { itemNumber: ' k 1 ', upc: '012345678905' } })), 'n:K1');
  assert.equal(productKey(row({ line: { itemNumber: '', upc: '0123-4567-8905' } })), 'u:012345678905');
  assert.equal(productKey(row({ line: { itemNumber: '', upc: '', product: 'Gruyère, AOP  (12 mo)' } })), 'd:gruyere aop 12 mo');
  const vendor = only([
    row({ line: { itemNumber: 'K1', product: 'Cheddar 2yr' } }),
    row({ line: { itemNumber: 'K1', product: '2 YEAR OLD CHEDDAR' } }),
    row({ line: { itemNumber: '', upc: '', product: 'GRUYERE AOP' } }),
    row({ line: { itemNumber: '', upc: '', product: 'Gruyère, AOP' } }),
    row({ line: { itemNumber: '', upc: '', product: '' } }),
    row({ line: { itemNumber: '', upc: '', product: '' } }),
  ]);
  assert.equal(vendor.products.length, 4, 'K1 once, Gruyere once, and the two unnamed lines apart');
  assert.deepEqual(vendor.products.map((p) => p.times).sort(), [1, 1, 2, 2]);
});

test('the latest purchase: newest date, then later recorded, then line order; nothing-arrived lines skipped', () => {
  const base = { invoiceDateIso: '2026-03-14' };
  const vendor = only([
    row({ ...base, invoiceId: 101, recordedAt: 5, line: { unitPrice: '6.00' } }),
    row({ ...base, invoiceId: 102, recordedAt: 9, line: { unitPrice: '6.10' } }),
    row({ ...base, invoiceId: 103, recordedAt: 9, line: { unitPrice: '6.20', n: 1 } }),
    row({ ...base, invoiceId: 103, recordedAt: 9, line: { unitPrice: '6.30', n: 2 } }),
    // Newer, but nothing arrived: none of these count.
    row({ invoiceDateIso: '2026-06-01', line: { unitPrice: '9.00', printedStatus: 'out_of_stock' } }),
    row({ invoiceDateIso: '2026-06-02', line: { unitPrice: '9.00', qty: '0' } }),
    row({ invoiceDateIso: '2026-06-03', line: { unitPrice: '9.00', printedStatus: 'credit' } }),
    row({ invoiceDateIso: '2026-06-04', line: { unitPrice: '9.00', extensionCents: -900 } }),
    row({ invoiceDateIso: '2026-06-05', line: { unitPrice: '9.00', qty: '-1' } }),
  ]);
  const p = vendor.products[0]!;
  assert.equal(p.latest.line.unitPrice, '6.30', 'same date and record: the later line');
  assert.equal(p.times, 3, 'only purchases are counted, one per invoice');
  assert.equal(p.onInvoice, 2);
  assert.equal(p.previous!.line.unitPrice, '6.10', 'previous comes from an earlier invoice');
});

test('a stopped run is used only when nothing else was bought, and says so', () => {
  const mixed = only([row({ invoiceDateIso: '2026-03-01', line: { unitPrice: '6.00' } }), row({ invoiceDateIso: '2026-09-01', stopped: true, source: 'run', line: { unitPrice: '7.00' } })]);
  assert.equal(mixed.products[0]!.latest.line.unitPrice, '6.00');
  assert.equal(mixed.products[0]!.times, 1);
  const stoppedOnly = vendorSheets([row({ stopped: true, source: 'run', sourceId: 7 })])[0]!;
  const cells = stoppedOnly.rows[0]!;
  assert.deepEqual(cells[11], { kind: 'text', value: 'Invoice run 7' });
  assert.deepEqual(cells[16], { kind: 'text', value: 'Yes' });
  assert.ok((cells[17] as { value: string }).value.startsWith(STOPPED_REASON));
});

test('a flagged line can be the latest, with its Needs check and Reason', () => {
  const sheet = vendorSheets([row({ invoiceDateIso: '2026-01-01' }), row({ invoiceDateIso: '2026-07-01', line: { unitPrice: '6.50', needsCheck: true, reasons: ['Short shipped.'], notes: ['Allowance of 0.50 off each unit price.'] } })])[0]!;
  const cells = sheet.rows[0]!;
  assert.deepEqual(cells[7], { kind: 'number', value: 6.5, format: 'price' });
  assert.deepEqual(cells[16], { kind: 'text', value: 'Yes' });
  assert.deepEqual(cells[17], { kind: 'text', value: 'Short shipped. Allowance of 0.50 off each unit price.' });
});

test('previous price and change: same price per only, rounded to 0.1 percent', () => {
  const d = (s: string) => parseDecimal(s);
  assert.equal(changeFraction(d('6.60'), d('6.00')), 0.1);
  assert.equal(changeFraction(d('3.10'), d('3.00')), 0.033);
  assert.equal(changeFraction(d('9.99'), d('10')), -0.001);
  assert.equal(changeFraction(d('8.004'), d('8')), 0.001, 'half a tenth of a percent rounds away from zero');
  assert.equal(changeFraction(d('7.996'), d('8')), -0.001);
  assert.equal(changeFraction(d('5.00'), d('5.00')), 0);
  assert.equal(changeFraction(d('5.00'), d('0')), null);
  assert.equal(changeFraction(null, d('5')), null);
  // The purchase before the latest is per case: skipped for a per pound one before it.
  const p = only([
    row({ invoiceDateIso: '2026-01-01', line: { unitPrice: '5.00', pricePer: 'LB' } }),
    row({ invoiceDateIso: '2026-02-01', line: { unitPrice: '60.00', pricePer: 'CS' } }),
    row({ invoiceDateIso: '2026-03-01', line: { unitPrice: '', pricePer: 'LB' } }),
    row({ invoiceDateIso: '2026-04-01', line: { unitPrice: '5.50', pricePer: 'lb' } }),
  ]).products[0]!;
  assert.equal(p.previous!.invoiceDateIso, '2026-01-01');
  assert.equal(p.change, 0.1);
  // Only a purchase in other units before it: no previous, no change.
  const q = only([row({ invoiceDateIso: '2026-01-01', line: { unitPrice: '60.00', pricePer: 'CS' } }), row({ invoiceDateIso: '2026-04-01', line: { unitPrice: '5.50', pricePer: 'LB' } })]).products[0]!;
  assert.equal(q.previous, null);
  assert.equal(q.change, null);
  assert.equal(q.times, 2);
  // On the tab: previous price, previous date, and the change as a percent number.
  const cells = vendorSheets([row({ invoiceDateIso: '2026-01-01', line: { unitPrice: '6.00' } }), row({ invoiceDateIso: '2026-04-01', line: { unitPrice: '6.60' } })])[0]!.rows[0]!;
  assert.deepEqual(cells.slice(12, 16), [
    { kind: 'number', value: 2, format: undefined },
    { kind: 'number', value: 6, format: 'price' },
    { kind: 'date', iso: '2026-01-01' },
    { kind: 'number', value: 0.1, format: 'percent' },
  ]);
  const none = vendorSheets([row({ line: { unitPrice: '6.00' } })])[0]!.rows[0]!;
  assert.deepEqual(none.slice(13, 16), [{ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }]);
});

test('tab names: safe characters, no apostrophe at either end, 31 at most, never History, unique ignoring case', () => {
  assert.equal(tabName('Fish/Shellfish: [Fresh]*?'), 'Fish Shellfish Fresh');
  assert.equal(tabName("'Smith's'"), "Smith's", 'only the ends lose their apostrophes');
  assert.equal(tabName("''"), 'Sheet');
  assert.equal(tabName('History'), 'History (vendor)');
  assert.equal(tabName('HISTORY'), 'HISTORY (vendor)');
  const long = tabName('The Very Long Name Of A Specialty Food Importer Incorporated');
  assert.equal(long.length, MAX_TAB_NAME);
  assert.equal(tabName("Acme Fine Foods and Provisions'Extra"), "Acme Fine Foods and Provisions");
  assert.equal(tabName('🧀'.repeat(20)).length, 30, 'a character is never cut in half');
  const names = uniqueTabNames(['Harbor Imports', 'HARBOR IMPORTS', 'harbor imports', 'All lines', 'The Very Long Name Of A Specialty Food Importer', 'The Very Long Name Of A Specialty Food Importer, East'], ['All lines']);
  assert.deepEqual(names.slice(0, 4), ['Harbor Imports', 'HARBOR IMPORTS (2)', 'harbor imports (3)', 'All lines (2)']);
  assert.equal(names[4]!.length, 31);
  assert.equal(names[5], `${names[4]!.slice(0, 27)} (2)`);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
  for (const n of names) assert.ok(n.length <= 31 && !/[\\/?*[\]:]/.test(n) && !/^'|'$/.test(n), n);
});

test('a valid workbook: All lines then one tab per vendor, each part listed, well formed, never a formula', () => {
  const rows = [
    row({ vendorKey: 'zeta', vendor: 'Zeta Imports', line: { product: '=HYPERLINK("x")', itemNumber: 'Z1' } }),
    row({ vendorKey: 'acme', vendor: 'Acme', invoiceDateIso: '2026-01-01', line: { unitPrice: '4.00' } }),
    row({ vendorKey: 'acme', vendor: 'Acme', invoiceDateIso: '2026-05-01', line: { unitPrice: '4.50' } }),
    row({ vendorKey: 'history', vendor: 'History', line: { itemNumber: 'H1' } }),
  ];
  const parts = unzip(purchaseXlsx(rows));
  const names = ['All lines', 'Acme', 'History (vendor)', 'Zeta Imports'];
  assert.match(parts['xl/workbook.xml']!, new RegExp(`<sheets>${names.map((n, i) => `<sheet name="${n.replace(/[()]/g, '\\$&')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`));
  const rels = parts['xl/_rels/workbook.xml.rels']!;
  const types = parts['[Content_Types].xml']!;
  for (let i = 1; i <= names.length; i++) {
    assert.ok(rels.includes(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`), `rel ${i}`);
    assert.ok(types.includes(`<Override PartName="/xl/worksheets/sheet${i}.xml" `), `type ${i}`);
    const sheet = parts[`xl/worksheets/sheet${i}.xml`]!;
    assert.ok(sheet, `sheet ${i}`);
    assertWellFormed(sheet, `sheet ${i}`);
    assert.doesNotMatch(sheet, /<f[\s>/]/, `no formula on sheet ${i}`);
  }
  assert.ok(rels.includes(`<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`));
  assert.equal(parts[`xl/worksheets/sheet${names.length + 1}.xml`], undefined);
  for (const p of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml']) assertWellFormed(parts[p]!, p);
  assert.match(parts['xl/styles.xml']!, /numFmtId="166" formatCode="0\.0%"/);
  // A vendor tab: its full name in row 1, the header in row 2, frozen below it.
  const acme = parts['xl/worksheets/sheet2.xml']!;
  assert.ok(acme.includes('<row r="1"><c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Acme</t></is></c><c r="B1" s="1"/></row>'));
  for (const [i, h] of VENDOR_COLUMNS.entries()) assert.ok(acme.includes(`<t xml:space="preserve">${h}</t>`), h);
  assert.match(acme, /<row r="2"><c r="A2" t="inlineStr" s="1"><is><t xml:space="preserve">Product<\/t>/);
  assert.match(acme, /<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"\/>/);
  assert.ok(acme.includes('<c r="P3" s="5"><v>0.125</v></c>'), 'change % is a number with the percent style');
  // The text guard holds on vendor tabs too.
  assert.ok(parts['xl/worksheets/sheet4.xml']!.includes('&apos;=HYPERLINK(&quot;x&quot;)'));
  // All lines is still first and frozen at row 1.
  assert.match(parts['xl/worksheets/sheet1.xml']!, /<pane ySplit="1" topLeftCell="A2"/);
});

test('times bought counts invoices, not lines; previous is from an earlier invoice; the row says how many times on its invoice', () => {
  // Invoice 201 in March: one line. Invoice 202 in June: the same product on three lines, the
  // second out of stock, so two lines count there.
  const rows = [
    row({ invoiceId: 201, invoiceDateIso: '2026-03-01', line: { unitPrice: '6.00', n: 1 } }),
    row({ invoiceId: 202, invoiceDateIso: '2026-06-01', line: { unitPrice: '6.40', n: 1 } }),
    row({ invoiceId: 202, invoiceDateIso: '2026-06-01', line: { unitPrice: '9.99', n: 2, printedStatus: 'out_of_stock' } }),
    row({ invoiceId: 202, invoiceDateIso: '2026-06-01', line: { unitPrice: '6.60', n: 3, reasons: ['Short shipped.'], needsCheck: true } }),
  ];
  const p = only(rows).products[0]!;
  assert.equal(p.times, 2, 'two invoices');
  assert.equal(p.onInvoice, 2, 'two counted lines on the latest invoice');
  assert.equal(p.latest.line.n, 3, "the latest invoice's last counted line");
  assert.equal(p.previous!.invoiceId, 201, 'never the same invoice');
  assert.equal(p.change, 0.1);
  const cells = vendorSheets(rows)[0]!.rows[0]!;
  assert.deepEqual(cells[7], { kind: 'number', value: 6.6, format: 'price' });
  assert.deepEqual(cells[12], { kind: 'number', value: 2, format: undefined });
  assert.deepEqual(cells[17], { kind: 'text', value: 'Short shipped. On this invoice 2 times.' });
  // Only one invoice, on two lines: bought once, no previous, no change.
  const one = only([row({ invoiceId: 301, line: { unitPrice: '5.00', n: 1 } }), row({ invoiceId: 301, line: { unitPrice: '5.50', n: 2 } })]).products[0]!;
  assert.equal(one.times, 1);
  assert.equal(one.previous, null);
  assert.equal(one.change, null);
  // Once on its invoice: nothing added to Reason.
  const single = vendorSheets([row({ line: { reasons: [], notes: [] } })])[0]!.rows[0]!;
  assert.deepEqual(single[17], { kind: 'empty' });
});

test('on the Vendor not read tab nothing is compared, and row 1 says why', () => {
  const rows = [
    row({ vendorKey: '', vendor: '', invoiceId: 401, invoiceDateIso: '2026-02-01', line: { unitPrice: '4.00' } }),
    row({ vendorKey: '', vendor: '', invoiceId: 402, invoiceDateIso: '2026-05-01', line: { unitPrice: '5.00' } }),
    row({ vendorKey: 'meadow farm', vendor: 'Meadow Farm', invoiceId: 403, invoiceDateIso: '2026-02-01', line: { unitPrice: '4.00' } }),
    row({ vendorKey: 'meadow farm', vendor: 'Meadow Farm', invoiceId: 404, invoiceDateIso: '2026-05-01', line: { unitPrice: '5.00' } }),
  ];
  const sheets = vendorSheets(rows, { from: '2026-01-01' });
  const notRead = sheets.find((s) => s.name === 'Vendor not read')!;
  assert.deepEqual(notRead.title, [{ kind: 'text', value: 'Vendor not read' }, { kind: 'text', value: 'The vendor was not read on these invoices, so no prices are compared. Only purchases dated from 2026-01-01 on. Previous prices come from those dates too.' }]);
  const cells = notRead.rows[0]!;
  assert.deepEqual(cells[7], { kind: 'number', value: 5, format: 'price' }, 'the latest is still shown');
  assert.deepEqual(cells.slice(12, 16), [{ kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }, { kind: 'empty' }]);
  // A vendor that was read compares as usual.
  const meadow = sheets.find((s) => s.name === 'Meadow Farm')!;
  assert.deepEqual(meadow.rows[0]!.slice(12, 16), [
    { kind: 'number', value: 2, format: undefined },
    { kind: 'number', value: 4, format: 'price' },
    { kind: 'date', iso: '2026-02-01' },
    { kind: 'number', value: 0.25, format: 'percent' },
  ]);
  assert.doesNotMatch(JSON.stringify(meadow.title), /not read/);
  // In the xlsx: the blank cells are left out, and the note is in B1.
  const xml = unzip(purchaseXlsx(rows))['xl/worksheets/sheet3.xml']!;
  assert.match(unzip(purchaseXlsx(rows))['xl/workbook.xml']!, /<sheet name="Vendor not read" sheetId="3"/);
  assert.ok(xml.includes('The vendor was not read on these invoices, so no prices are compared.'));
  for (const c of ['M3', 'N3', 'O3', 'P3']) assert.doesNotMatch(xml, new RegExp(`<c r="${c}"`), c);
});

test('past the tab cap, the rest of the vendors share one Other vendors tab', () => {
  const rows = ['Delta', 'Alpha', 'Charlie', 'Bravo'].map((v) => row({ vendorKey: v.toLowerCase(), vendor: v }));
  const sheets = vendorSheets(rows, {}, 2);
  assert.deepEqual(sheets.map((s) => s.name), ['Alpha', 'Bravo', 'Other vendors']);
  const other = sheets[2]!;
  assert.equal(other.header[0], 'Vendor');
  assert.deepEqual(other.rows.map((r) => (r[0] as { value: string }).value), ['Charlie', 'Delta']);
  assert.match((other.title![1] as { value: string }).value, /^2 more vendors, past the limit of 2 tabs\./);
});

test('with dates, vendor tabs use only purchases in the range, previous prices too, and say so', async (t) => {
  const make = (number: string, iso: string, price: string) =>
    invoice({
      supplier_name: 'Hollow Creek Dairy',
      invoice_number: number,
      invoice_date_iso: iso,
      invoice_date: iso,
      images: [image({ invoice_number: number })],
      lines: [line({ item_number: 'K1', description: '2 Year Old Cheddar', qty_shipped: '5', unit: 'LB', unit_price: price, price_unit: 'LB', extension: (Number(price) * 5).toFixed(2) })],
      total: (Number(price) * 5).toFixed(2),
    });
  const answers = [make('HC-1', '2026-03-01', '6.00'), make('HC-2', '2026-06-01', '6.60'), make('HC-3', '2026-09-01', '7.26')];
  const s = await makeRunApp({ model: fakeClient({ 'claude-sonnet-5-5': answers.map((json) => ({ json })), 'claude-opus-5-5': [] }), cards: false });
  t.after(() => s.close());
  const mgr = await signIn(s);
  for (const seed of [1, 2, 3]) {
    const { payload, contentType } = multipart([{ name: '_csrf', value: mgr.csrf }, { name: 'files', filename: `old${seed}.jpg`, type: 'image/jpeg', data: await testImage(seed) }]);
    assert.equal((await s.app.inject({ method: 'POST', url: '/history', headers: { cookie: mgr.cookie, origin: ORIGIN, 'content-type': contentType }, payload })).statusCode, 303);
  }
  await s.app.shelf.history.drain();
  const tab = async (q: string) => {
    const res = await s.app.inject({ method: 'GET', url: `/history/download.xlsx${q}`, headers: { cookie: mgr.cookie } });
    assert.equal(res.statusCode, 200);
    return unzip(res.rawPayload)['xl/worksheets/sheet2.xml']!;
  };
  const all = await tab('');
  assert.ok(all.includes('<c r="M3"><v>3</v></c>'), 'bought three times');
  assert.ok(all.includes('<c r="N3" s="4"><v>6.6</v></c>'), 'previous is the June price');
  assert.ok(all.includes('<c r="P3" s="5"><v>0.1</v></c>'));
  assert.ok(all.includes('<c r="B1" s="1"/>'), 'no note without dates');
  const range = await tab('?from=2026-01-01&to=2026-07-31');
  assert.ok(range.includes('<c r="H3" s="4"><v>6.6</v></c>'), 'the latest in the range is June');
  assert.ok(range.includes('<c r="M3"><v>2</v></c>'));
  assert.ok(range.includes('<c r="N3" s="4"><v>6</v></c>'), 'previous comes from the range too');
  assert.ok(range.includes('Only purchases dated from 2026-01-01 to 2026-07-31. Previous prices come from those dates too.'));
  const late = await tab('?from=2026-08-01');
  assert.ok(late.includes('<c r="M3"><v>1</v></c>'));
  assert.doesNotMatch(late, /<c r="N3"/, 'no previous inside the range');
  assert.doesNotMatch(late, /<c r="P3"/);
  // The csv is the All lines tab only, as before.
  const csv = await s.app.inject({ method: 'GET', url: '/history/download.csv', headers: { cookie: mgr.cookie } });
  assert.equal(csv.rawPayload.subarray(3).toString('utf8').trim().split('\r\n').length, 4);
});
