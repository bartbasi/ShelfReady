// Code checks on a reading, with small synthetic invoices. Invented values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundReading, checkLine, checkReading, gtinCheckDigitValid, parseInvoiceDate, poundsIn, receivedFrom } from '../src/invoice/checks.ts';
import { parseDecimal } from '../src/invoice/money.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../src/invoice/settings.ts';
import type { CheckId, CheckedReading, ModelImage } from '../src/invoice/types.ts';
import { image, invoice, line, TODAY } from './invoice-fixtures.ts';

const opts = { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY };

function check(r: CheckedReading, id: CheckId) {
  const c = r.checks.find((x) => x.id === id);
  assert.ok(c, `check ${id} missing`);
  return c;
}

test('a clean reading passes every blocking check', () => {
  const r = checkReading(invoice(), opts);
  assert.deepEqual(r.failed, []);
  assert.equal(r.linesTotalCents, 2000);
  assert.equal(r.totalCents, 2000);
});

test('line math: quantity x price, catch weight x price, allowance, quantity in pounds', () => {
  assert.equal(checkLine(1, line({ qty_shipped: '7', unit_price: '2.35', extension: '16.45' }), 1).mathProblem, null);
  const cw = checkLine(1, line({ qty_shipped: '3', weight: '9.87', unit_price: '6.10', extension: '60.21' }), 1);
  assert.equal(cw.mathProblem, null);
  assert.equal(cw.checked.basis, 'weight');
  const allowance = checkLine(1, line({ qty_shipped: '1', unit: 'CS', unit_price: '20.00', allowance: '2.50', extension: '17.50' }), 1);
  assert.equal(allowance.mathProblem, null);
  assert.equal(checkLine(1, line({ qty_shipped: '3.21', unit: 'LB', unit_price: '4.56', extension: '14.64' }), 1).mathProblem, null);
  // A weight column of .00 is no weight: the quantity is used.
  assert.equal(checkLine(1, line({ qty_shipped: '2', weight: '.00', unit_price: '13.37', extension: '26.74' }), 1).mathProblem, null);
});

test('line math: a misread digit is caught and described in plain words', () => {
  const r = checkLine(3, line({ description: 'SMOKED HAM', qty_shipped: '3', weight: '9.87', unit_price: '6.10', extension: '62.01' }), 1);
  assert.match(r.mathProblem!, /line 3 \(item A100, SMOKED HAM\): weight 9.87 x 6.10 = 60.21, but the line amount reads 62.01/);
});

test('line math: numbers too large to multiply fail the check instead of throwing', () => {
  const r = checkLine(1, line({ qty_shipped: '999999999999', unit_price: '99999.99', extension: '1.00' }), 1);
  assert.match(r.mathProblem!, /too large to check/);
  const whole = checkReading(invoice({ lines: [line({ qty_shipped: '999999999999', unit_price: '99999.99', extension: '1.00' })], total: '1.00' }), opts);
  assert.equal(check(whole, 'line_math').passed, false);
});

test('line math: out of stock lines and credits', () => {
  assert.equal(checkLine(1, line({ qty_shipped: '0', unit_price: '18.20', extension: '.00', printed_status: 'out_of_stock' }), 1).mathProblem, null);
  assert.match(checkLine(1, line({ qty_shipped: '0', unit_price: '18.20', extension: '18.20' }), 1).mathProblem!, /nothing shipped/);
  assert.equal(checkLine(1, line({ qty_shipped: '-1', unit_price: '12.00', extension: '-12.00', printed_status: 'credit' }), 1).mathProblem, null);
  assert.equal(checkLine(1, line({ qty_shipped: '1', unit_price: '12.00', extension: '-12.00', printed_status: 'credit' }), 1).mathProblem, null);
});

test('totals: lines plus charges plus tax must equal the printed total', () => {
  const ok = checkReading(invoice({ charges: [{ image_index: 1, description: 'Fuel', amount: '5.00', kind: 'fuel_surcharge' }], tax: '1.00', total: '26.00' }), opts);
  assert.equal(check(ok, 'totals').passed, true);
  const off = checkReading(invoice({ total: '20.02' }), opts);
  assert.equal(check(off, 'totals').passed, false);
  assert.match(check(off, 'totals').details[0]!, /lines 20.00 = 20.00, but the invoice total reads 20.02/);
  const within = checkReading(invoice({ total: '20.01' }), opts);
  assert.equal(check(within, 'totals').passed, true);
});

test('totals: a previous balance added to the total is spotted', () => {
  const r = checkReading(invoice({ total: '31.00', previous_balance: '11.00' }), opts);
  assert.equal(check(r, 'totals').passed, false);
  assert.match(check(r, 'totals').details[0]!, /previous balance/);
  const kept = checkReading(invoice({ previous_balance: '432.10' }), opts);
  assert.equal(check(kept, 'totals').passed, true);
  assert.ok(kept.notices.some((n) => /previous balance of 432.10/.test(n.message)));
});

test('totals: a missing total fails', () => {
  const r = checkReading(invoice({ total: '' }), opts);
  assert.equal(check(r, 'totals').passed, false);
  assert.ok(r.failed.some((c) => c.id === 'totals'));
});

test('subtotal may or may not include charges, anything else fails', () => {
  const fuel = [{ image_index: 1, description: 'Delivery Fee', amount: '2.50', kind: 'delivery_fee' as const }];
  assert.equal(check(checkReading(invoice({ charges: fuel, subtotal: '22.50', total: '22.50' }), opts), 'subtotal').passed, true);
  assert.equal(check(checkReading(invoice({ charges: fuel, subtotal: '20.00', total: '22.50' }), opts), 'subtotal').passed, true);
  assert.equal(check(checkReading(invoice({ subtotal: '21.00' }), opts), 'subtotal').passed, false);
  assert.equal(checkReading(invoice(), opts).checks.some((c) => c.id === 'subtotal'), false);
});

test('a printed total quantity is checked only when printed', () => {
  assert.equal(check(checkReading(invoice({ printed_total_quantity: '2' }), opts), 'total_quantity').passed, true);
  assert.equal(check(checkReading(invoice({ printed_total_quantity: '3' }), opts), 'total_quantity').passed, false);
  assert.equal(checkReading(invoice(), opts).checks.some((c) => c.id === 'total_quantity'), false);
});

test('pages: a page that says it continues, with no next page, fails', () => {
  const r = checkReading(invoice({ images: [image({ continued_marker: true, has_totals: false })], total: '' }), opts);
  const pages = check(r, 'pages_complete');
  assert.equal(pages.passed, false);
  assert.ok(pages.details.some((d) => /continues, but no later page/.test(d)));
  assert.ok(pages.details.some((d) => /No page shows the invoice total/.test(d)));
});

test('pages: gaps and printed page counts', () => {
  const gap = checkReading(invoice({ images: [image(), image({ image_index: 2, page_number: '3' })] }), { ...opts, imagesSent: 2 });
  assert.ok(check(gap, 'pages_complete').details.some((d) => /Page 2 of 3 is missing/.test(d)));
  const count = checkReading(invoice({ images: [image({ page_count: '2' })] }), opts);
  assert.ok(check(count, 'pages_complete').details.some((d) => /Page 2 of 2 is missing/.test(d)));
  const unreported = checkReading(invoice(), { ...opts, imagesSent: 2 });
  assert.ok(check(unreported, 'pages_complete').details.some((d) => /Image 2 was sent but is missing/.test(d)));
});

test('pages: an absurd page count fails at once, without looping to it', () => {
  const started = Date.now();
  const r = checkReading(invoice({ images: [image({ page_count: '2000000', page_number: '1' })] }), opts);
  const pages = check(r, 'pages_complete');
  assert.equal(pages.passed, false);
  assert.ok(pages.details.some((d) => /page count of 2000000, which is not believable/.test(d)));
  const big = checkReading(invoice({ images: [image({ page_number: '999999999' })] }), opts);
  assert.ok(check(big, 'pages_complete').details.some((d) => /page number 999999999, which is not believable/.test(d)));
  assert.ok(Date.now() - started < 1000);
});

test('structure: repeated image entries cannot hang the checks and fail the schema check', () => {
  // Two entries for image 1 with the same invoice and page used to point image 1 at itself.
  const twice = invoice({ images: [image(), image()] });
  const r = checkReading(twice, { ...opts, imagesSent: 1 });
  assert.equal(check(r, 'schema').passed, false);
  assert.ok(check(r, 'schema').details.some((d) => /Image 1 is listed more than once/.test(d)));
  assert.deepEqual(r.duplicateImages, []);
});

test('structure: image numbers must be sent, repeats must point back, lines must sit on sent images', () => {
  const r = checkReading(
    invoice({
      images: [image(), image({ image_index: 2, page_number: '2', same_page_as_image: 2 }), image({ image_index: 7 })],
      lines: [line(), line({ image_index: 5, item_number: 'B200' })],
      total: '40.00',
    }),
    { ...opts, imagesSent: 2 },
  );
  const details = check(r, 'schema').details.join(' ');
  assert.match(details, /numbered 7, but only images 1 to 2 were sent/);
  assert.match(details, /Image 2 is said to repeat image 2, which is not an earlier image/);
  assert.match(details, /1 line is on an image that was not sent or not reported/);
});

test('bounds: very long text is cut and fails the schema check, quickly', () => {
  const started = Date.now();
  const huge = '9'.repeat(40_000);
  const r = checkReading(invoice({ lines: [line({ pack_size: huge, description: 'X'.repeat(5000), extension: huge })] }), opts);
  assert.equal(check(r, 'schema').passed, false);
  assert.ok(Date.now() - started < 1000, 'bounded input keeps every pattern fast');
  const bounded = boundReading(invoice({ problems: Array.from({ length: 500 }, () => 'p') }));
  assert.equal(bounded.invoice.problems.length, 30);
});

test('pages: a second photo of a page is found and counted once', () => {
  const p1 = image({ image_index: 1, page_number: '1', continued_marker: true, has_totals: false });
  const p2 = image({ image_index: 2, page_number: '2' });
  const p2again = image({ image_index: 3, page_number: '2' }); // the model did not say so: page numbers catch it
  const lines = [line({ image_index: 1 }), line({ image_index: 2, item_number: 'B200' }), line({ image_index: 3, item_number: 'B200' })];
  const r = checkReading(invoice({ images: [p1, p2, p2again], lines, total: '40.00' }), { ...opts, imagesSent: 3 });
  assert.deepEqual(r.duplicateImages, [3]);
  assert.equal(r.lines.length, 2);
  assert.deepEqual(r.failed, []);
  assert.ok(r.notices.some((n) => /Image 3 is another photo of the same page as image 2/.test(n.message)));
});

test('pages: two photos of one page read differently fail', () => {
  const imgs = [image({ image_index: 1 }), image({ image_index: 2, same_page_as_image: 1 })];
  const lines = [line({ image_index: 1 }), line({ image_index: 2, extension: '21.00', unit_price: '10.50' })];
  const r = checkReading(invoice({ images: imgs, lines }), { ...opts, imagesSent: 2 });
  assert.equal(check(r, 'duplicate_pages_agree').passed, false);
});

test('pages: a repeat claimed by the model is refused when the page numbers differ', () => {
  const imgs = [image({ image_index: 1, continued_marker: true, has_totals: false }), image({ image_index: 2, page_number: '2', same_page_as_image: 1 })];
  const lines = [line({ image_index: 1 }), line({ image_index: 2, item_number: 'B200' })];
  const r = checkReading(invoice({ images: imgs, lines, total: '40.00' }), { ...opts, imagesSent: 2 });
  assert.deepEqual(r.duplicateImages, []);
  assert.equal(r.lines.length, 2);
  assert.equal(check(r, 'duplicate_pages_agree').passed, false);
  assert.match(check(r, 'duplicate_pages_agree').details[0]!, /said image 2 repeats image 1, but they show different/);
});

test('a page from a different invoice fails', () => {
  const imgs = [image({ image_index: 1, continued_marker: true, has_totals: false }), image({ image_index: 2, invoice_number: 'INV-9', page_number: '2' })];
  const r = checkReading(invoice({ images: imgs }), { ...opts, imagesSent: 2 });
  const same = check(r, 'same_invoice');
  assert.equal(same.passed, false);
  assert.match(same.details[0]!, /Image 2 shows invoice INV-9, not INV-1/);
});

test('a page with no invoice number is tied by its page number when it fits the other pages', () => {
  const first = image({ image_index: 1, page_count: '2', continued_marker: true, has_totals: false });
  const r = checkReading(invoice({ images: [first, image({ image_index: 2, invoice_number: '', page_number: '2', page_count: '2' })] }), { ...opts, imagesSent: 2 });
  assert.equal(check(r, 'same_invoice').passed, true);
  assert.ok(r.notices.some((n) => /Image 2 shows no invoice number. It was taken as page 2 of invoice INV-1/.test(n.message)));
  const noCount = checkReading(invoice({ images: [image({ continued_marker: true, has_totals: false }), image({ image_index: 2, invoice_number: '', page_number: '2' })] }), { ...opts, imagesSent: 2 });
  assert.equal(check(noCount, 'same_invoice').passed, true);
  const single = checkReading(invoice({ images: [image({ invoice_number: '' })] }), opts);
  assert.equal(check(single, 'same_invoice').passed, true);
});

test('a page with no invoice number fails when nothing ties it to the invoice', () => {
  const first = image({ image_index: 1, page_count: '2', continued_marker: true, has_totals: false });
  const tie = (blank: Partial<ModelImage>, others = [first]) =>
    check(checkReading(invoice({ images: [...others, image({ image_index: others.length + 1, invoice_number: '', ...blank })] }), { ...opts, imagesSent: others.length + 1 }), 'same_invoice');
  const neither = tie({ page_number: '' });
  assert.equal(neither.passed, false);
  assert.match(neither.details[0]!, /shows neither an invoice number nor a page number/);
  const taken = tie({ page_number: '1' });
  assert.match(taken.details[0]!, /page 1 does not fit the other pages/);
  const tooFar = tie({ page_number: '3' });
  assert.match(tooFar.details[0]!, /page 3 does not fit/);
  const otherCount = tie({ page_number: '2', page_count: '3' });
  assert.match(otherCount.details[0]!, /page 2 of 3 does not fit/);
  const nobody = tie({ page_number: '2' }, [image({ image_index: 1, invoice_number: '', continued_marker: true, has_totals: false })]);
  assert.match(nobody.details.join(' '), /no other page shows INV-1 to tie it to/);
});

test('another photo of a numbered page is tied through that page even without a number', () => {
  const imgs = [image({ image_index: 1 }), image({ image_index: 2, invoice_number: '', page_number: '', same_page_as_image: 1 })];
  const r = checkReading(invoice({ images: imgs }), { ...opts, imagesSent: 2 });
  assert.deepEqual(r.duplicateImages, [2]);
  assert.equal(check(r, 'same_invoice').passed, true);
});

test('product codes must pass their check digit', () => {
  assert.equal(gtinCheckDigitValid('036000291452'), true);
  assert.equal(gtinCheckDigitValid('036000291453'), false);
  assert.equal(gtinCheckDigitValid('4006381333931'), true);
  assert.equal(gtinCheckDigitValid('96385074'), true);
  const bad = checkReading(invoice({ lines: [line({ upc: '036000291453' })] }), opts);
  assert.equal(check(bad, 'upc_check_digits').passed, false);
  const short = checkReading(invoice({ lines: [line({ upc: '12345' })] }), opts);
  assert.equal(check(short, 'upc_check_digits').passed, true);
});

test('low confidence fails; medium is shown but passes', () => {
  const low = checkReading(invoice({ lines: [line({ confidence: 'low', confidence_note: 'amount smudged' })] }), opts);
  assert.equal(check(low, 'model_confidence').passed, false);
  assert.match(check(low, 'model_confidence').details[0]!, /amount smudged/);
  const overall = checkReading(invoice({ overall_confidence: 'low' }), opts);
  assert.equal(check(overall, 'model_confidence').passed, false);
  const medium = checkReading(invoice({ lines: [line({ confidence: 'medium' })] }), opts);
  assert.equal(check(medium, 'model_confidence').passed, true);
  assert.ok(medium.notices.some((n) => /medium confidence/.test(n.message)));
});

test('notes that mean not received flag the line, which stays in the total', () => {
  const missing = line({
    qty_shipped: '1',
    weight: '3.30',
    unit_price: '9.10',
    extension: '30.03',
    annotations: [
      { kind: 'highlight', text: 'line highlighted', meaning: 'other' },
      { kind: 'handwritten', text: 'never arrived', meaning: 'not_received' },
    ],
  });
  const r = checkReading(invoice({ lines: [missing], total: '30.03' }), opts);
  assert.deepEqual(r.failed, []);
  assert.equal(r.lines[0]!.received, 'no');
  assert.match(r.lines[0]!.flags[0]!, /Marked not received: "never arrived"\. It is still charged 30.03/);
  assert.ok(r.notices.some((n) => /never arrived/.test(n.message)));
});

test('received: words alone count, partial shorts ask for a check, check marks mean received', () => {
  const words = receivedFrom(line({ annotations: [{ kind: 'handwritten', text: 'missing', meaning: 'other' }] }), parseDecimal('1'), 2000);
  assert.equal(words.received, 'no');
  const two = receivedFrom(line({ annotations: [{ kind: 'handwritten', text: 'short 1', meaning: 'short' }] }), parseDecimal('2'), 2000);
  assert.equal(two.received, 'check');
  const tick = receivedFrom(line({ annotations: [{ kind: 'check_mark', text: 'check mark', meaning: 'received' }] }), parseDecimal('2'), 2000);
  assert.equal(tick.received, 'yes');
  assert.deepEqual(tick.flags, []);
  const out = receivedFrom(line({ qty_shipped: '0', printed_status: 'out_of_stock' }), parseDecimal('0'), 0);
  assert.equal(out.received, 'no');
});

test('catch weight: a misread piece count is caught', () => {
  const ok = line({ qty_shipped: '1', unit: 'EA', units_per_pack: '1', pack_size: '5 LB', weight: '4.80', unit_price: '5.00', extension: '24.00' });
  assert.equal(check(checkReading(invoice({ lines: [ok], total: '24.00' }), opts), 'catch_weight').passed, true);
  // Three pieces of a 5 lb item cannot weigh 4.80 lb in all.
  const misread = { ...ok, qty_shipped: '3' };
  const r = checkReading(invoice({ lines: [misread], total: '24.00' }), opts);
  assert.equal(check(r, 'catch_weight').passed, false);
  assert.match(check(r, 'catch_weight').details[0]!, /1.60 lb each, but the pack says 5 lb each/);
  const fraction = checkReading(invoice({ lines: [{ ...ok, qty_shipped: '1.5' }], total: '24.00' }), opts);
  assert.match(check(fraction, 'catch_weight').details[0]!, /not a whole number/);
  const none = checkReading(invoice({ lines: [{ ...ok, qty_shipped: '' }], total: '24.00' }), opts);
  assert.match(check(none, 'catch_weight').details[0]!, /must show how many pieces/);
  const absurd = checkReading(invoice({ lines: [line({ qty_shipped: '90', weight: '2.70', unit_price: '2.00', extension: '5.40' })], total: '5.40' }), opts);
  assert.match(check(absurd, 'catch_weight').details[0]!, /0.03 lb each, which is not believable/);
  const pounds = checkReading(invoice({ lines: [line({ qty_shipped: '4.50', unit: 'LB', weight: '4.50', unit_price: '2.00', extension: '9.00' })], total: '9.00' }), opts);
  assert.equal(check(pounds, 'catch_weight').passed, true);
});

test('printed sizes in pounds', () => {
  assert.equal(poundsIn('5 LB'), 5);
  assert.equal(poundsIn('8 OZ'), 0.5);
  assert.equal(poundsIn('2.25#'), 2.25);
  assert.equal(poundsIn('12/5.3Z'), null);
  assert.equal(poundsIn(''), null);
});

test('ranges: absurd or non-numeric values fail', () => {
  const huge = checkReading(invoice({ lines: [line({ qty_shipped: '5000', unit_price: '0.004', extension: '20.00' })] }), opts);
  assert.equal(check(huge, 'ranges').passed, false);
  const text = checkReading(invoice({ lines: [line({ weight: 'n/a' })] }), opts);
  assert.ok(check(text, 'ranges').details.some((d) => /"n\/a" is not a number/.test(d)));
  const none = checkReading(invoice({ lines: [], total: '0.00' }), opts);
  assert.ok(check(none, 'ranges').details.some((d) => /No product lines/.test(d)));
});

test('invoice date: parsed from either form, odd dates flagged without blocking', () => {
  assert.equal(parseInvoiceDate('', '10/21/26')?.toISOString().slice(0, 10), '2026-10-21');
  assert.equal(parseInvoiceDate('2026-11-02', '')?.toISOString().slice(0, 10), '2026-11-02');
  assert.equal(parseInvoiceDate('2026-02-30', '13/45/26'), null);
  const future = checkReading(invoice({ invoice_date_iso: '2027-03-01' }), opts);
  assert.equal(check(future, 'invoice_date').passed, false);
  assert.equal(check(future, 'invoice_date').blocking, false);
  assert.deepEqual(future.failed, []);
});

test('the matching hook: an unknown line goes to review, a misread code blocks', () => {
  // Not in Square, or not matched yet: listed for review, but a second reading cannot help.
  const unknown = checkReading(invoice(), { ...opts, knownItem: () => ({ known: false, note: 'no Square item with this name' }) });
  assert.equal(check(unknown, 'known_items').passed, false);
  assert.equal(check(unknown, 'known_items').blocking, false);
  assert.match(check(unknown, 'known_items').details[0]!, /no Square item with this name/);
  assert.equal(check(unknown, 'misread_codes').passed, true);
  assert.deepEqual(unknown.failed, []);
  // A code that looks misread blocks, so the fallback model reads the invoice again.
  const misread = checkReading(invoice(), { ...opts, knownItem: () => ({ known: false, possibleMisread: true, note: 'the code fails its check digit' }) });
  assert.deepEqual(misread.failed.map((c) => c.id), ['misread_codes']);
  assert.match(check(misread, 'misread_codes').details[0]!, /fails its check digit/);
  // Known lines pass both.
  const known = checkReading(invoice(), { ...opts, knownItem: () => ({ known: true }) });
  assert.equal(check(known, 'known_items').passed, true);
  assert.equal(check(known, 'misread_codes').passed, true);
  // The brief's first rule, every unknown line blocks, is still available.
  const strict = checkReading(invoice(), { ...opts, knownItem: () => ({ known: false }), knownItemsBlocking: true });
  assert.deepEqual(strict.failed.map((c) => c.id), ['known_items']);
  // Without the hook, neither check runs.
  assert.equal(checkReading(invoice(), opts).checks.some((c) => c.id === 'known_items' || c.id === 'misread_codes'), false);
});
