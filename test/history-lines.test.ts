// Old invoices: how a reading becomes purchase history lines, and which lines need a check.
// Invented invoices only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkReading } from '../src/invoice/checks.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../src/invoice/settings.ts';
import type { ModelInvoice } from '../src/invoice/types.ts';
import { DATE_FUTURE, DATE_TOO_OLD, DATE_UNREAD, filePositions, HISTORY_MAX_AGE_DAYS, historyFromReading, invoiceDate, packText, MATH_CHECKED, PRICE_PER_GUESSED, productName, type HistoryReading } from '../src/history/lines.ts';
import { checkReading as checkNew } from '../src/invoice/checks.ts';
import { image, invoice, line, TODAY } from './invoice-fixtures.ts';

const S = DEFAULT_INVOICE_SETTINGS;

function history(inv: ModelInvoice, extra: string[] = []): HistoryReading {
  const reading = checkReading(inv, { settings: S, today: TODAY, imagesSent: inv.images.length });
  return historyFromReading(reading, S, filePositions('images', inv.images.length, []), { today: TODAY, extraNotes: extra });
}

const cheddar = line({ item_number: 'K1', description: '2 Year Old Cheddar', qty_shipped: '5', unit: 'LB', unit_price: '6.00', price_unit: 'LB', extension: '30.00' });
const wasabi = line({ item_number: 'W2', description: 'Wasabi Paste', units_per_pack: '12', qty_shipped: '2', unit: 'CS', unit_price: '36.00', price_unit: 'CS', extension: '72.00' });

test('a clean invoice maps to rows like the examples, with nothing to check', () => {
  const h = history(invoice({ supplier_name: 'Hollow Creek Dairy', invoice_number: 'HC-1001', invoice_date_iso: '2026-03-14', invoice_date: '03/14/26', images: [image({ invoice_number: 'HC-1001' })], lines: [cheddar, wasabi], total: '102.00' }));
  assert.equal(h.vendor, 'Hollow Creek Dairy');
  assert.equal(h.invoiceNumber, 'HC-1001');
  assert.equal(h.invoiceDateIso, '2026-03-14');
  assert.deepEqual(h.invoiceFlags, []);
  assert.deepEqual(h.invoiceNotes, []);
  const [a, b] = h.lines;
  assert.deepEqual([a!.product, a!.pack, a!.qty, a!.qtyUnit, a!.unitPrice, a!.pricePer, a!.extensionCents], ['2 Year Old Cheddar', '', '5', 'LB', '6.00', 'LB', 3000]);
  assert.deepEqual([b!.product, b!.pack, b!.qty, b!.qtyUnit, b!.unitPrice, b!.pricePer, b!.extensionCents], ['Wasabi Paste', '12 units/case', '2', 'CS', '36.00', 'CS', 7200]);
  for (const l of h.lines) {
    assert.equal(l.needsCheck, false, l.product);
    assert.deepEqual(l.reasons, []);
  }
});

test('qty times price must match the line within a cent', () => {
  const near = line({ qty_shipped: '3', unit_price: '3.335', extension: '10.01' }); // 10.005 rounds to 10.01
  const offByOne = line({ item_number: 'B', qty_shipped: '2', unit_price: '10.00', extension: '20.01' });
  const offByTwo = line({ item_number: 'C', qty_shipped: '2', unit_price: '10.00', extension: '20.02' });
  const h = history(invoice({ lines: [near, offByOne, offByTwo], total: '50.04' }));
  assert.equal(h.lines[0]!.needsCheck, false);
  assert.equal(h.lines[1]!.needsCheck, false, 'one cent off is within the tolerance');
  assert.equal(h.lines[2]!.needsCheck, true);
  assert.deepEqual(h.lines[2]!.reasons, ['Qty x price is 20.00, but the line reads 20.02.']);
});

test('missing numbers are named plainly', () => {
  const noPrice = line({ item_number: 'A', unit_price: '', extension: '20.00' });
  const noAmount = line({ item_number: 'B', extension: '' });
  const noQty = line({ item_number: 'C', qty_shipped: '', weight: '', extension: '20.00' });
  const h = history(invoice({ lines: [noPrice, noAmount, noQty], total: '40.00' }));
  assert.ok(h.lines[0]!.reasons.includes('No unit price was read.'));
  assert.ok(h.lines[1]!.reasons.includes('No line amount was read.'));
  assert.ok(h.lines[2]!.reasons.includes('No quantity or weight was read.'));
});

test('a line priced by weight shows pounds as the quantity, and keeps the piece count with the pack', () => {
  const ham = line({ description: 'Smoked Ham', pack_size: '2/5 LB', qty_shipped: '2', unit: 'PC', weight: '10.5', unit_price: '6.00', price_unit: '', extension: '63.00' });
  const h = history(invoice({ lines: [ham], total: '63.00' }));
  const l = h.lines[0]!;
  assert.equal(l.qty, '10.5');
  assert.equal(l.qtyUnit, 'LB');
  assert.equal(l.pricePer, 'LB', 'no price unit printed: a weight line is priced per pound');
  assert.equal(l.pack, '2/5 LB, 2 PC');
  assert.equal(l.needsCheck, false);
});

test('a reader that is not sure flags the line, with its own note', () => {
  const h = history(
    invoice({
      lines: [line({ confidence: 'medium', confidence_note: 'faded price' }), line({ item_number: 'B', confidence: 'low', confidence_note: '' })],
      total: '40.00',
    }),
  );
  assert.deepEqual(h.lines[0]!.reasons, ['The reader was not fully sure: faded price.']);
  assert.deepEqual(h.lines[1]!.reasons, ['The reader was unsure.']);
});

test('a reader that only doubted the math is not flagged when the math adds up', () => {
  // Bart, November 16: 5.57 lb x 4.76 = 26.5132, printed 26.51. The reader said it did not equal.
  const gouda = line({ item_number: 'A', qty_shipped: '1', unit: 'EA', weight: '5.57', unit_price: '4.76', price_unit: '', extension: '26.51', confidence: 'medium', confidence_note: 'Printed price 4.76 times weight 5.57 does not equal 26.51.' });
  // The same doubt, but the math really is off: still flagged, with ShelfReady's own reason.
  const off = line({ item_number: 'B', qty_shipped: '1', unit: 'EA', weight: '5.57', unit_price: '4.76', price_unit: '', extension: '27.51', confidence: 'medium', confidence_note: 'Printed price 4.76 times weight 5.57 does not equal 27.51.' });
  // A doubt about reading the page stays a flag even when the math adds up.
  const rotated = line({ item_number: 'C', qty_shipped: '1', unit: 'EA', weight: '5.57', unit_price: '4.76', price_unit: '', extension: '26.51', confidence: 'medium', confidence_note: 'rotated photo; weight times price does not match' });
  // Low confidence is never cleared this way.
  const low = line({ item_number: 'D', qty_shipped: '1', unit: 'EA', weight: '5.57', unit_price: '4.76', price_unit: '', extension: '26.51', confidence: 'low', confidence_note: 'does not equal' });
  // Notes that look like math but hide a reading doubt keep the flag (code review, November 16).
  const keep = [
    'Extension not visible; computed from weight times price.',
    'Description does not match the item number.',
    'Item number may be 4053 or 4058; extension matches.',
    'Weight partly hidden by a fold; times price equals 26.51.',
    'Unit price times weight does not equal 26.51.',
  ].map((note, i) => line({ item_number: `K${i}`, qty_shipped: '1', unit: 'EA', weight: '5.57', unit_price: '4.76', price_unit: '', extension: '26.51', confidence: 'medium', confidence_note: note }));
  const h = history(invoice({ lines: [gouda, off, rotated, low, ...keep], total: '239.59' }));
  const [g, o, r, w, ...k] = h.lines;
  for (const x of k) assert.equal(x.needsCheck, true, x.reasons.join(' '));
  assert.deepEqual(g!.reasons, []);
  assert.equal(g!.needsCheck, false);
  assert.ok(g!.notes.includes(MATH_CHECKED));
  assert.equal(o!.needsCheck, true);
  assert.ok(o!.reasons.some((x) => x.startsWith('The reader was not fully sure')));
  assert.ok(o!.reasons.some((x) => x.includes('but the line reads 27.51')));
  assert.equal(r!.needsCheck, true);
  assert.ok(!r!.notes.includes(MATH_CHECKED));
  assert.equal(w!.needsCheck, true);
});

test('out of stock, short shipped, credits and notes are flagged', () => {
  const out = line({ item_number: 'A', printed_status: 'out_of_stock', qty_shipped: '0', extension: '0.00' });
  const zero = line({ item_number: 'B', qty_shipped: '0', extension: '0.00' });
  const short = line({ item_number: 'C', printed_status: 'short_shipped' });
  const credit = line({ item_number: 'D', printed_status: 'credit', qty_shipped: '-1', unit_price: '10.00', extension: '-10.00' });
  const note = line({ item_number: 'E', annotations: [{ kind: 'handwritten', text: 'never came', meaning: 'not_received' }] });
  const price = line({ item_number: 'F', annotations: [{ kind: 'handwritten', text: '9.50?', meaning: 'price_note' }] });
  const tick = line({ item_number: 'G', annotations: [{ kind: 'check_mark', text: 'check mark', meaning: 'received' }] });
  const h = history(invoice({ lines: [out, zero, short, credit, note, price, tick], total: '70.00' }));
  const r = h.lines.map((l) => l.reasons);
  assert.deepEqual(r[0], ['Out of stock.']);
  assert.deepEqual(r[1], ['Out of stock.']);
  assert.deepEqual(r[2], ['Short shipped.']);
  assert.deepEqual(r[3], ['A credit.']);
  assert.deepEqual(r[4], ['A note says "never came".']);
  assert.deepEqual(r[5], ['A price is written on it: "9.50?".']);
  assert.deepEqual(r[6], [], 'a check mark that says it arrived is not a problem');
  // Still saved, every one.
  assert.equal(h.lines.length, 7);
});

test('an invoice problem that touches line values flags every line; invoice-only facts go in Reason without a flag', () => {
  const h = history(invoice({ invoice_number: '', invoice_date_iso: '', invoice_date: 'smudged', overall_confidence: 'medium', images: [image({ invoice_number: '' })], lines: [cheddar, wasabi], total: '110.00' }));
  assert.deepEqual(h.invoiceFlags, ['The lines do not add up to the invoice total.']);
  assert.deepEqual(h.invoiceNotes, ['No invoice number was read.', DATE_UNREAD, 'The reader was not sure of the whole invoice.']);
  for (const l of h.lines) {
    assert.equal(l.needsCheck, true);
    assert.deepEqual(l.reasons, ['The lines do not add up to the invoice total.']);
    assert.deepEqual(l.notes, ['Invoice: No invoice number was read.', 'Invoice: The date could not be read.', 'Invoice: The reader was not sure of the whole invoice.']);
  }
  assert.equal(h.invoiceDateIso, '');
  // With the total right, the same facts flag nothing.
  const quiet = history(invoice({ invoice_number: '', invoice_date_iso: '', invoice_date: 'smudged', overall_confidence: 'low', images: [image({ invoice_number: '' })], lines: [cheddar, wasabi], total: '102.00' }));
  assert.deepEqual(quiet.invoiceFlags, []);
  for (const l of quiet.lines) assert.equal(l.needsCheck, false, l.product);
});

test('a missing page or a page from another invoice flags every line', () => {
  const h = history(invoice({ images: [image({ page_number: '2', page_count: '2' })], lines: [cheddar], total: '30.00' }));
  assert.ok(h.invoiceFlags.includes('A page may be missing.'));
  assert.ok(h.lines[0]!.needsCheck);
  const other = history(invoice({ images: [image({ invoice_number: 'OTHER-9' })], lines: [cheddar], total: '30.00' }));
  assert.ok(other.invoiceFlags.includes('A page may belong to another invoice.'));
  assert.ok(other.lines[0]!.reasons.includes('A page may belong to another invoice.'));
});

test('old invoices have their own date window of three years, with plain reasons', () => {
  const day = (iso: string) => invoiceDate(iso, '', TODAY, S.ranges.maxFutureDays);
  assert.equal(HISTORY_MAX_AGE_DAYS, 1096);
  assert.deepEqual(day('2026-02-30'), { iso: '', problem: DATE_UNREAD });
  assert.deepEqual(day(''), { iso: '', problem: DATE_UNREAD });
  assert.deepEqual(invoiceDate('', '3/14/26', TODAY, 7), { iso: '2026-03-14', problem: null }, 'the printed date when the reader gave no ISO date');
  assert.deepEqual(day('2026-12-01'), { iso: '2026-12-01', problem: DATE_FUTURE });
  assert.deepEqual(day('2026-11-12'), { iso: '2026-11-12', problem: null }, 'a few days ahead is allowed, as for new invoices');
  // 500 days back: too old for a new invoice run, fine for an old invoice.
  assert.deepEqual(day('2025-06-24'), { iso: '2025-06-24', problem: null });
  assert.deepEqual(day('2023-11-06'), { iso: '2023-11-06', problem: null }, '1096 days back is inside the window');
  assert.deepEqual(day('2023-11-05'), { iso: '2023-11-05', problem: DATE_TOO_OLD });
  assert.deepEqual(history(invoice({ invoice_date_iso: '2025-06-24', invoice_date: '' })).invoiceNotes, []);
  assert.deepEqual(history(invoice({ invoice_date_iso: '2022-01-01', invoice_date: '' })).invoiceNotes, [DATE_TOO_OLD]);
  assert.deepEqual(history(invoice({ invoice_date_iso: '2027-01-01', invoice_date: '' })).invoiceNotes, [DATE_FUTURE]);
  // The rule for new invoice runs is unchanged: 500 days back still fails its date check.
  const run = checkNew(invoice({ invoice_date_iso: '2025-06-24', invoice_date: '06/24/25' }), { settings: S, today: TODAY, imagesSent: 1 });
  assert.equal(run.checks.find((c) => c.id === 'invoice_date')!.passed, false);
});

test('an allowance is noted on the line but is not a problem', () => {
  const h = history(invoice({ lines: [line({ qty_shipped: '2', unit_price: '10.00', price_unit: 'EA', allowance: '0.50', extension: '19.00' })], total: '19.00' }));
  const l = h.lines[0]!;
  assert.equal(l.needsCheck, false);
  assert.deepEqual(l.notes, ['Allowance of 0.50 off each unit price.']);
  assert.equal(l.unitPrice, '10.00');
});

test('a price unit that was not printed is guessed from the unit and said so, without a flag', () => {
  const h = history(invoice({ lines: [line({ unit: 'EA', price_unit: '' })] }));
  const l = h.lines[0]!;
  assert.equal(l.pricePer, 'EA');
  assert.deepEqual(l.notes, [PRICE_PER_GUESSED]);
  assert.equal(PRICE_PER_GUESSED, 'Price per was not printed; guessed from the unit.');
  assert.equal(l.needsCheck, false);
});

test('notes from the reader go on every line without flagging it', () => {
  const h = history(invoice({ lines: [line({ price_unit: 'EA' })] }), ['Only the first reading was made.']);
  assert.deepEqual(h.lines[0]!.reasons, []);
  assert.deepEqual(h.lines[0]!.notes, ['Invoice: Only the first reading was made.']);
});

test('product and pack text', () => {
  assert.equal(productName({ description: 'Sea Salt Crackers', brand: 'Bluecrest' }), 'Bluecrest Sea Salt Crackers');
  assert.equal(productName({ description: 'BLUECREST Sea Salt Crackers', brand: 'Bluecrest' }), 'BLUECREST Sea Salt Crackers');
  assert.equal(packText({ pack_size: '12/5.3Z', units_per_pack: '12' }), '12/5.3Z');
  assert.equal(packText({ pack_size: '5.3 OZ', units_per_pack: '12' }), '12 x 5.3 OZ');
  assert.equal(packText({ pack_size: '', units_per_pack: '1' }), '1 unit/case');
  assert.equal(packText({ pack_size: '120Z', units_per_pack: '12' }), '12 x 120Z', 'a size that only starts with the count digits is not the count');
});

test('lines point at the photo they were read from, past a repeated photo', () => {
  // Uploads 1, 2, 3; upload 2 repeated upload 1, so the reader saw images 1 and 2 = uploads 1 and 3.
  const at = filePositions('images', 3, [2]);
  assert.equal(at(1), 1);
  assert.equal(at(2), 3);
  assert.equal(at(3), 0);
  assert.equal(filePositions('pdf', 1, [])(7), 1);
});
