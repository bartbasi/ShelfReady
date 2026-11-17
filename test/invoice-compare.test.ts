// Ground truth validation, the scorecard comparison and the item number key, with a synthetic
// invoice. Invented values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReading } from '../src/invoice/checks.ts';
import { compareReading, wordCoverage } from '../src/invoice/compare.ts';
import { expectedAsModelInvoice, validateExpected, type ExpectedInvoice, type ExpectedLine } from '../src/invoice/expected.ts';
import { normalizeItemNumber, sameItemNumber } from '../src/invoice/item-number.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../src/invoice/settings.ts';
import { TODAY } from './invoice-fixtures.ts';

function eline(fields: Partial<ExpectedLine>): ExpectedLine {
  return {
    image: 1, lineRef: '', categoryHeader: '', itemNumber: 'A1', upc: '', description: 'TEST GOUDA', descriptionMore: '',
    brand: '', packSize: '', unitsPerPack: '', origin: '', qtyShipped: '1', unit: 'EA', weight: '', unitPrice: '5.00',
    priceUnit: '', allowance: '', extension: '5.00', printedStatus: 'shipped', received: 'yes', annotations: [], ...fields,
  };
}

const expected: ExpectedInvoice = {
  name: 'synthetic', supplier: 'Test Supplier', images: ['a.jpg'], invoiceNumber: 'T-1', invoiceDatePrinted: '11/01/26',
  invoiceDate: '2026-11-01', pages: [{ image: 1, invoiceNumber: 'T-1', pageNumber: '1', pageCount: '', samePageAs: 0, continued: false, hasTotals: true }],
  lines: [
    eline({ itemNumber: 'O100', description: 'TEST GOUDA', weight: '2.50', unitPrice: '8.00', extension: '20.00' }),
    eline({ itemNumber: 'B200', description: 'TEST CRACKERS', qtyShipped: '2', unitPrice: '3.00', extension: '6.00' }),
    eline({ itemNumber: 'C300', description: 'TEST SALAMI', extension: '5.00', received: 'no', annotations: [{ kind: 'handwritten', text: 'never came', meaning: 'not_received' }] }),
  ],
  charges: [{ image: 1, description: 'Fuel', amount: '1.00', kind: 'fuel_surcharge' }],
  subtotal: '', tax: '', total: '32.00', previousBalance: '', printedTotalQuantity: '', invoiceAnnotations: [], uncertain: [], notes: [],
};

test('a correct ground truth validates, a typo in it is caught', () => {
  assert.deepEqual(validateExpected(expected, TODAY).problems, []);
  const typo = { ...expected, lines: [{ ...expected.lines[0]!, extension: '20.50' }, ...expected.lines.slice(1)] };
  assert.ok(validateExpected(typo, TODAY).problems.some((p) => p.startsWith('line_math')));
  const wrongFlag = { ...expected, lines: [...expected.lines.slice(0, 2), { ...expected.lines[2]!, received: 'yes' as const }] };
  assert.ok(validateExpected(wrongFlag, TODAY).problems.some((p) => /received is "yes"/.test(p)));
});

test('a perfect reading scores no wrong fields', () => {
  const reading = checkReading(expectedAsModelInvoice(expected), { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY });
  const sc = compareReading(expected, reading);
  assert.equal(sc.linesMatched, 3);
  assert.deepEqual(sc.wrong, []);
  assert.ok(sc.fieldsCompared > 30);
});

test('lines pair by content; wrong values, missing lines and a letter O read as zero count as wrong', () => {
  const model = expectedAsModelInvoice(expected);
  const [gouda, crackers] = model.lines;
  model.lines = [{ ...crackers!, unit_price: '3.50', extension: '7.00' }, { ...gouda!, item_number: '0100' }];
  const sc = compareReading(expected, checkReading(model, { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY }));
  assert.equal(sc.linesMatched, 2, 'the O and 0 item numbers still pair up');
  assert.ok(sc.wrong.some((w) => w.field === 'amount' && w.expected === '6.00' && w.got === '7.00'));
  assert.ok(sc.wrong.some((w) => w.field === 'item number' && w.expected === 'O100' && w.got === '0100'));
  assert.equal(sc.missingLines.length, 1);
  assert.match(sc.missingLines[0]!, /C300/);
});

test('item numbers as matching keys: letter O as zero, letter I as one', () => {
  assert.equal(normalizeItemNumber(' o12i4 '), '01214');
  assert.equal(normalizeItemNumber('AB-10'), 'AB-10');
  assert.equal(normalizeItemNumber('q 123 456 o'), 'Q1234560');
  assert.equal(sameItemNumber('O5500I2', '0550012'), true);
  assert.equal(sameItemNumber('A100', 'A101'), false);
  assert.equal(sameItemNumber('', ''), false);
});

test('word coverage ignores punctuation', () => {
  assert.equal(wordCoverage('GARDEN HERB CRISPS', 'GARDEN HERB,CRISPS'), 1);
  assert.equal(wordCoverage('XB SPICED SAUSAGE', 'YB SPICED SAUSAGE'), 2 / 3);
});
