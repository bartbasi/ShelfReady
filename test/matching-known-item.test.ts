// Matching wired into the invoice checks: a misread code sends the invoice to the fallback
// model; a new or unmatched item goes to review without a second reading. Invented values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/db.ts';
import { checkReading } from '../src/invoice/checks.ts';
import { readInvoice } from '../src/invoice/pipeline.ts';
import { buildInvoiceSettings, DEFAULT_INVOICE_SETTINGS } from '../src/invoice/settings.ts';
import type { ModelLine } from '../src/invoice/types.ts';
import { knownItemLookup } from '../src/matching/known-item.ts';
import { confirmMapping } from '../src/matching/mapping.ts';
import { createSupplier, findSupplier } from '../src/matching/suppliers.ts';
import { fakeClient, invoice, line, testImage, TODAY } from './invoice-fixtures.ts';
import { testIndex, UPC_CRACKER } from './matching-fixtures.ts';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const ACTOR = { userId: null, username: 'manager1' };

function ctx(t: { after(fn: () => void): void }) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const index = testIndex();
  const s = createSupplier(db, ACTOR, 'Test Supplier', Date.parse('2026-11-07T15:00:00Z'));
  confirmMapping(db, ACTOR, { supplierId: s.id, line: { itemNumber: 'B200', upc: '', description: 'UNSALTED BUTTER 30/1LB' }, target: { kind: 'not_for_resale' }, catalog: index });
  return { db, index };
}

/** Two lines of 10.00 each, so the totals check passes whatever the lines say. */
function twoLines(a: Partial<ModelLine>, b: Partial<ModelLine>) {
  return invoice({ lines: [line({ ...a, qty_shipped: '1', extension: '10.00' }), line({ ...b, qty_shipped: '1', extension: '10.00' })], total: '20.00' });
}

const matched = { item_number: 'A1', upc: UPC_CRACKER, description: 'SEA SALT CRACKERS' };
const notForResale = { item_number: 'B200', description: 'UNSALTED BUTTER 30/1LB' };
const brandNew = { item_number: 'Z9', description: 'QUANTUM WIDGET' };
/** The cracker's UPC with its last digit misread. */
const misread = { item_number: 'Z8', upc: `${UPC_CRACKER.slice(0, 11)}${(Number(UPC_CRACKER[11]) + 1) % 10}`, description: 'QUANTUM WIDGET' };

test('matched and not-for-resale lines are known; a new item is listed for review but does not block', (t) => {
  const knownItem = knownItemLookup(ctx(t));
  const opts = { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY, knownItem };
  const ok = checkReading(twoLines(matched, notForResale), opts);
  assert.equal(ok.checks.find((c) => c.id === 'known_items')!.passed, true);
  assert.deepEqual(ok.failed, []);
  const fresh = checkReading(twoLines(matched, brandNew), opts);
  const known = fresh.checks.find((c) => c.id === 'known_items')!;
  assert.equal(known.passed, false);
  assert.equal(known.blocking, false);
  assert.match(known.details.join(' '), /line 2 \(item Z9, QUANTUM WIDGET\): no Square item looks like it/);
  assert.deepEqual(fresh.failed, [], 'a second reading cannot add an item to Square');
});

test('an unmatched line with a code that fails its check digit blocks the reading', (t) => {
  const knownItem = knownItemLookup(ctx(t));
  // The upc check alone is set not to block here, so the block comes from matching.
  const settings = { ...DEFAULT_INVOICE_SETTINGS, upcCheckDigitsBlocking: false };
  const r = checkReading(twoLines(matched, misread), { settings, today: TODAY, knownItem });
  assert.deepEqual(r.failed.map((c) => c.id), ['misread_codes']);
  assert.match(r.checks.find((c) => c.id === 'misread_codes')!.details.join(' '), /fails its check digit/);
});

test('the pipeline: a misread code runs the fallback model; a new item does not', async (t) => {
  const c = ctx(t);
  const settings = buildInvoiceSettings({ upcCheckDigitsBlocking: false });
  const files = [{ name: 'page1.jpg', bytes: await testImage(1) }];
  const now = () => TODAY;

  const reread = fakeClient({ [SONNET]: [{ json: twoLines(matched, misread) }], [OPUS]: [{ json: twoLines(matched, notForResale) }] });
  const r1 = await readInvoice(files, { client: reread, settings, now, knownItem: knownItemLookup(c) });
  assert.deepEqual(reread.calls.map((x) => x.model), [SONNET, OPUS]);
  assert.equal(r1.status, 'ok', 'the second reading read the code right and every line is known');

  const newOnly = fakeClient({ [SONNET]: [{ json: twoLines(matched, brandNew) }] });
  const r2 = await readInvoice(files, { client: newOnly, settings, now, knownItem: knownItemLookup(c) });
  assert.deepEqual(newOnly.calls.map((x) => x.model), [SONNET], 'no second reading for an item that is simply not in Square');
  assert.equal(r2.status, 'ok');
  assert.match(r2.reading!.checks.find((x) => x.id === 'known_items')!.details.join(' '), /QUANTUM WIDGET/);
});

test('the pipeline: a saved item worded differently goes to review without a second reading', async (t) => {
  const c = ctx(t);
  const s = findSupplier(c.db, 'Test Supplier')!;
  confirmMapping(c.db, ACTOR, { supplierId: s.id, line: { itemNumber: 'R100', upc: '', description: 'HILLTOP AGED CHEDDAR WHEEL' }, target: { kind: 'square', variationId: 'V_CHEDDAR' }, catalog: c.index });
  const files = [{ name: 'page1.jpg', bytes: await testImage(1) }];
  const client = fakeClient({ [SONNET]: [{ json: twoLines(matched, { item_number: 'R100', description: 'HILLTOP CHEDDAR' }) }] });
  const r = await readInvoice(files, { client, settings: buildInvoiceSettings(), now: () => TODAY, knownItem: knownItemLookup(c) });
  assert.deepEqual(client.calls.map((x) => x.model), [SONNET]);
  assert.equal(r.status, 'ok');
  assert.match(r.reading!.checks.find((x) => x.id === 'known_items')!.details.join(' '), /R100/);
});

