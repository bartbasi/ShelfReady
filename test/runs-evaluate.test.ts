// Every state that blocks approval, worked out by evaluate() on invented data. Approval and the
// dry run both refuse while evaluate() returns any blocker (src/runs/actions.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Db } from '../src/db/db.ts';
import { SYSTEM_ACTOR } from '../src/db/audit.ts';
import { checkReading } from '../src/invoice/checks.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../src/invoice/settings.ts';
import type { ModelInvoice } from '../src/invoice/types.ts';
import { buildCatalogIndex } from '../src/matching/catalog.ts';
import { createSupplier } from '../src/matching/suppliers.ts';
import { memoryOverrideStore, type PriceOverride } from '../src/pricing/overrides.ts';
import { defaultSettings, type PricingSettings } from '../src/settings/schema.ts';
import { rawVariations } from '../src/square/variation-state.ts';
import { evaluate, type BlockerId, type Evaluation } from '../src/runs/evaluate.ts';
import type { RunCatalog } from '../src/runs/catalog-cache.ts';
import type { Decision, DecisionKind } from '../src/runs/store.ts';
import { claimTerms, creditFor, arrivalOf } from '../src/runs/inventory.ts';
import { buildPreview, renamedItem } from '../src/runs/preview.ts';
import { image, invoice, line, TODAY } from './invoice-fixtures.ts';
import { item, LOCATION, POUND, testObjects, UPC_CRACKER, CAT_CHEESE } from './matching-fixtures.ts';
import { testInvoice } from './runs-fixtures.ts';

function catalogOf(extra: Record<string, unknown>[] = []): RunCatalog {
  const objects = [...testObjects(), ...extra];
  return {
    snapshot: { id: 1, sha256: 'x'.repeat(64), source: 'square_sandbox', locationId: LOCATION, takenAt: '2026-11-06T00:00:00.000Z' },
    index: buildCatalogIndex({ objects, locationId: LOCATION }),
    raw: rawVariations(objects),
  };
}

function freshDb(supplier = true): Db {
  const db = openDatabase(':memory:');
  if (supplier) createSupplier(db, SYSTEM_ACTOR, 'Hilltop Provisions');
  return db;
}

const d = (kind: DecisionKind, target: string | number, value: Record<string, unknown> = {}): Decision => ({ kind, target: String(target), value, decidedBy: 1, decidedByName: 'mgr', decidedAt: 0 });

/** The usual picks, so only the state under test blocks. */
const PICKS = [d('pick', 1, { variationId: 'V_GOUDA' }), d('pick', 3, { variationId: 'V_SALMON' })];

function run(o: { inv?: ModelInvoice; db?: Db; decisions?: Decision[]; extra?: Record<string, unknown>[]; overrides?: PriceOverride[]; pricing?: PricingSettings; noReading?: boolean } = {}): Evaluation {
  const inv = o.inv ?? testInvoice();
  const reading = checkReading(inv, { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY, imagesSent: inv.images.length });
  return evaluate({
    db: o.db ?? freshDb(),
    read: o.noReading ? null : { status: reading.failed.length ? 'review' : 'ok', reading, reviewReasons: [], notices: [], images: [], audit: {} as never },
    catalog: catalogOf(o.extra),
    decisions: o.decisions ?? PICKS,
    pricing: o.pricing ?? defaultSettings().pricing,
    overrides: memoryOverrideStore(o.overrides ?? []),
    bigChangePercent: 30,
  });
}

const ids = (ev: Evaluation): BlockerId[] => ev.blockers.map((b) => b.id);

test('the test invoice with its picks has nothing blocking', () => {
  const ev = run();
  assert.deepEqual(ev.blockers, []);
  assert.deepEqual(ev.lines.map((l) => l.outcome), ['send', 'send', 'send']);
  assert.equal(ev.lines[2]!.priced!.switchToWeight, true);
});

test('blocks: no reading', () => {
  assert.deepEqual(ids(run({ noReading: true })), ['no_reading']);
});

test('blocks: a failed check a person cannot accept (the total does not add up)', () => {
  const ev = run({ inv: testInvoice({ total: '1.00' }) });
  assert.ok(ids(ev).includes('check_failed'));
  // Accepting it by hand is not allowed.
  assert.ok(ids(run({ inv: testInvoice({ total: '1.00' }), decisions: [...PICKS, d('accept_check', 'totals')] })).includes('check_failed'));
});

test('blocks: a failed check a person may accept after checking the paper, until accepted', () => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, confidence: 'low', confidence_note: 'smudged' };
  assert.ok(ids(run({ inv })).includes('check_to_accept'));
  assert.deepEqual(ids(run({ inv, decisions: [...PICKS, d('accept_check', 'model_confidence')] })), []);
});

test('blocks: an unknown supplier', () => {
  assert.ok(ids(run({ db: freshDb(false) })).includes('supplier_unknown'));
});

test('blocks: a supplier whose names fit two vendor formulas, and nothing is priced for it', () => {
  const f = { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' as const };
  const ev = run({ pricing: { default: f, vendors: [{ vendor: 'Hilltop Provisions', formula: f }, { vendor: 'Hilltop Provisions Inc.', formula: f }] } });
  assert.ok(ids(ev).includes('vendor_ambiguous'));
  assert.ok(ev.lines.every((l) => l.priced === null));
});

test('blocks: a line to match, and a new item, until picked, marked or left out', () => {
  assert.deepEqual(ids(run({ decisions: [PICKS[1]!] })), ['line_unmatched']);
  const inv = testInvoice();
  inv.lines.push(line({ item_number: 'Z9', description: 'QUANTUM FROBNICATOR DELUXE', qty_shipped: '1', unit: 'EA', unit_price: '5.00', extension: '5.00' }));
  inv.total = '200.00';
  assert.deepEqual(ids(run({ inv })), ['line_new']);
  assert.deepEqual(ids(run({ inv, decisions: [...PICKS, d('skip_line', 4)] })), []);
  assert.deepEqual(ids(run({ inv, decisions: [...PICKS, d('not_for_resale', 4)] })), []);
});

test('blocks: a short-shipped line until someone says what arrived', () => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, printed_status: 'short_shipped' };
  assert.deepEqual(ids(run({ inv })), ['arrival_to_confirm', 'stock_unknown'].slice(0, 1));
  const none = run({ inv, decisions: [...PICKS, d('received', 2, { arrived: 'none' })] });
  assert.deepEqual(ids(none), []);
  assert.equal(none.lines[1]!.outcome, 'nothing_arrived');
  assert.deepEqual(none.credits, [{ n: 2, cents: 6000, reason: 'Charged but not delivered.' }]);
  const some = run({ inv, decisions: [...PICKS, d('received', 2, { arrived: 'some', pieces: '12' })] });
  assert.deepEqual(ids(some), []);
  assert.equal(some.lines[1]!.stock!.ok && some.lines[1]!.stock!.text, '12');
  assert.equal(some.credits[0]!.cents, 3000);
});

test('blocks: a by-weight line with no weight, so the stock cannot be set', () => {
  const inv = testInvoice();
  inv.lines[0] = { ...inv.lines[0]!, unit: 'EA', price_unit: 'LB', weight: '', qty_shipped: '2', unit_price: '6.00', extension: '12.00' };
  inv.total = '144.00';
  assert.ok(ids(run({ inv })).includes('stock_unknown'));
});

test('blocks: an override below the new formula price, until the manager picks', () => {
  const over: PriceOverride = { variationId: 'V_CRACKER', priceCents: 600, setBy: 'bart', setAt: '2026-11-01T00:00:00Z', note: '' };
  const ev = run({ overrides: [over] });
  assert.deepEqual(ids(ev), ['price_needs_decision']);
  const decided = run({ overrides: [over], decisions: [...PICKS, d('override', 'V_CRACKER', { choice: 'keep_override', enteredCents: null, formulaCents: 699, overrideCents: 600 })] });
  assert.deepEqual(ids(decided), []);
  assert.equal(decided.lines[1]!.priced!.newCents, 600);
});

test('blocks: a line with no price (the case size is unknown)', () => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, pack_size: '' };
  assert.ok(ids(run({ inv })).includes('price_none'));
});

test('blocks: two lines giving one item different prices, until one is picked', () => {
  const inv = testInvoice();
  inv.lines.push(line({ item_number: 'C201', upc: UPC_CRACKER, description: 'BLUECREST SEA SALT CRACKERS', pack_size: '12/4.4Z', unit: 'CS', qty_shipped: '1', unit_price: '36.00', extension: '36.00' }));
  inv.total = '231.00';
  const ev = run({ inv });
  assert.ok(ids(ev).includes('price_conflict'));
  assert.deepEqual(ev.conflictPrices.get('V_CRACKER'), [699, 799]);
  const pick = d('conflict', 'V_CRACKER', { priceCents: 799, shownCents: [699, 799] });
  // 5.99 to 7.99 is a rise of 33%, so it also needs its own tick.
  assert.deepEqual(ids(run({ inv, decisions: [...PICKS, pick] })), ['big_change', 'big_change']);
  const picked = run({ inv, decisions: [...PICKS, pick, d('accept_big_change', 'V_CRACKER', { fromCents: 599, toCents: 799 })] });
  assert.deepEqual(ids(picked), []);
  // Stock from both lines adds up.
  const prev = buildPreview({ runId: 1, evaluation: picked, catalog: catalogOf(), catalogLabel: 'x', decisions: [], counts: new Map(), scaleNames: [], now: 0 });
  assert.equal(prev.square.find((s) => s.variationId === 'V_CRACKER')!.stock!.to, '36');
});

test('blocks: a switch to sold by weight when the catalog has more than one per-pound unit', () => {
  const second = { type: 'MEASUREMENT_UNIT', id: 'UNIT_POUND_2', measurement_unit_data: { measurement_unit: { weight_unit: 'IMPERIAL_POUND', type: 'TYPE_WEIGHT' } } };
  assert.deepEqual(ids(run({ extra: [second] })), ['per_pound_unit']);
});

test('blocks: a scale code that ends two Square names', () => {
  const twin = item({ id: 'I_TWIN', name: 'Other Gouda 7101', category: CAT_CHEESE, variations: [{ id: 'V_TWIN', cents: 1999, unit: POUND }] });
  assert.ok(ids(run({ extra: [twin] })).includes('code_shared'));
});

test('credits and claim deadlines come only from what the invoice prints', () => {
  const inv = invoice({
    images: [image()],
    invoice_annotations: [{ kind: 'printed_note', text: 'Shortages must be reported within 48 hours of delivery', meaning: 'other' }],
  });
  assert.deepEqual(claimTerms(inv), { text: 'Shortages must be reported within 48 hours of delivery', deadline: '2026-11-03' });
  assert.equal(claimTerms(invoice()), null);
  const reading = checkReading(invoice({ lines: [line({ printed_status: 'out_of_stock', qty_shipped: '0', extension: '20.00' })] }), { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY });
  const cl = reading.lines[0]!;
  assert.deepEqual(creditFor(cl, arrivalOf(cl, null), false), { n: 1, cents: 2000, reason: 'Charged but not delivered.' });
});

test('an edited name keeps the scale code at the end, once', () => {
  assert.equal(renamedItem('Gouda Smoked 7101', '7101', 'Smoked Gouda'), 'Smoked Gouda 7101');
  assert.equal(renamedItem('Gouda Smoked 7101', '7101', 'Smoked Gouda 7101'), 'Smoked Gouda 7101');
  assert.equal(renamedItem('Bluecrest - Crackers', null, '  Sea  Salt Crackers '), 'Sea Salt Crackers');
});
