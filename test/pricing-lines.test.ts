// Pricing whole lines: overrides and the cost increase check, flags for review, and reading
// Square catalog objects. Invented numbers and ids only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePack, type PackFields } from '../src/invoice/pack.ts';
import type { PricingSettings } from '../src/settings/schema.ts';
import { memoryOverrideStore, resolveOverride, type OverrideDecision, type PriceOverride } from '../src/pricing/overrides.ts';
import { priceLine, priceLines, saleModeOf, type PriceLineInput, type PricingContext, type SquareItemState } from '../src/pricing/price.ts';
import { perPoundUnitIds, squareItemState, trailingScaleCode } from '../src/pricing/square-state.ts';

const SETTINGS: PricingSettings = {
  default: { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' },
  vendors: [{ vendor: 'Example Dairy', formula: { addBefore: '2.25', multiplier: '2', addAfter: '0.00', rounding: 'up-to-99' } }],
};

function ov(variationId: string, priceCents: number): PriceOverride {
  return { variationId, priceCents, setBy: 'u1', setAt: '2026-01-01T00:00:00.000Z', note: '' };
}

function decision(choice: OverrideDecision['choice'], formulaCents: number, overrideCents: number, enteredCents: number | null = null): OverrideDecision {
  return { variationId: 'V1', choice, enteredCents, formulaCents, overrideCents, decidedBy: 'u2' };
}

function ctx(overrides: PriceOverride[] = [], decisions: OverrideDecision[] = []): PricingContext {
  return { settings: SETTINGS, overrides: memoryOverrideStore(overrides), decisions };
}

function sq(over: Partial<SquareItemState> = {}): SquareItemState {
  return { variationId: 'V1', priceCents: 1099, pricingType: 'FIXED_PRICING', perPound: false, scaleCode: null, ...over };
}

function input(unitPrice: string, pack: Partial<PackFields>, square: SquareItemState | null, extra: Partial<PriceLineInput> = {}): PriceLineInput {
  return {
    n: 1,
    basis: { unitPrice, allowance: '', pack: parsePack({ packSize: '', unitsPerPack: '', unit: 'EA', priceUnit: '', catchWeight: false, ...pack }) },
    square,
    vendor: null,
    ...extra,
  };
}

const ids = (flags: { id: string }[]) => flags.map((f) => f.id).sort();

test('overrides: none, kept when at or above the formula, a decision when the formula is higher', () => {
  assert.deepEqual(resolveOverride(1299, null, null), { state: { kind: 'none' }, sendCents: 1299, action: { kind: 'none' } });
  assert.equal(resolveOverride(1299, ov('V1', 1499), null).sendCents, 1499);
  assert.equal(resolveOverride(1499, ov('V1', 1499), null).state.kind, 'override', 'equal keeps the override');
  const pending = resolveOverride(1599, ov('V1', 1499), null);
  assert.equal(pending.state.kind, 'needs_decision');
  assert.equal(pending.sendCents, null, 'nothing is sent until someone picks');
  assert.deepEqual(resolveOverride(null, ov('V1', 1499), null), { state: { kind: 'unchecked', overrideCents: 1499 }, sendCents: null, action: { kind: 'keep' } });
});

test('overrides: each decision sends its price and says what happens to the stored override', () => {
  const keep = resolveOverride(1599, ov('V1', 1499), decision('keep_override', 1599, 1499));
  assert.deepEqual([keep.sendCents, keep.action], [1499, { kind: 'keep' }]);
  const formula = resolveOverride(1599, ov('V1', 1499), decision('use_formula', 1599, 1499));
  assert.deepEqual([formula.sendCents, formula.action], [1599, { kind: 'remove' }]);
  const entered = resolveOverride(1599, ov('V1', 1499), decision('enter_price', 1599, 1499, 1549));
  assert.deepEqual([entered.sendCents, entered.action], [1549, { kind: 'set', priceCents: 1549 }]);
  assert.equal(entered.state.kind, 'decided');
});

test('overrides: a decision made on other prices, or with a bad typed price, is asked again, saying why', () => {
  const pendingWhy = (o: ReturnType<typeof resolveOverride>) => (o.state.kind === 'needs_decision' ? o.state.askAgain : 'not pending');
  const formulaMoved = resolveOverride(1699, ov('V1', 1499), decision('keep_override', 1599, 1499));
  assert.deepEqual(formulaMoved.state, { kind: 'needs_decision', overrideCents: 1499, formulaCents: 1699, askAgain: 'formula_changed' });
  assert.equal(formulaMoved.sendCents, null);
  const overrideMoved = resolveOverride(1599, ov('V1', 1399), decision('keep_override', 1599, 1499));
  assert.equal(overrideMoved.sendCents, null);
  assert.equal(pendingWhy(overrideMoved), 'override_changed');
  const otherItem = { ...decision('keep_override', 1599, 1499), variationId: 'V2' };
  assert.equal(pendingWhy(resolveOverride(1599, ov('V1', 1499), otherItem)), null, 'a decision for another item is no decision');
  assert.equal(pendingWhy(resolveOverride(1599, ov('V1', 1499), null)), null);
  for (const bad of [null, 0, -5, 12.5]) {
    const o = resolveOverride(1599, ov('V1', 1499), decision('enter_price', 1599, 1499, bad));
    assert.equal(o.sendCents, null, String(bad));
    assert.equal(pendingWhy(o), 'bad_price', String(bad));
  }
});

test('the review message says why a decision is asked again, and never blames the cost wrongly', () => {
  const line = () => input('9.00', {}, sq({ priceCents: 1099 }));
  const message = (d: OverrideDecision, overridePrice = 1299) =>
    priceLine(line(), ctx([ov('V1', overridePrice)], [d])).flags.find((f) => f.id === 'needs_decision')!.message;
  assert.match(message(decision('enter_price', 1999, 1299, 0)), /price entered could not be used/);
  assert.doesNotMatch(message(decision('enter_price', 1999, 1299, 0)), /changed/);
  assert.match(message(decision('keep_override', 1999, 1199)), /override changed since the last choice/);
  assert.doesNotMatch(message(decision('keep_override', 1999, 1199)), /formula price changed/);
  assert.match(message(decision('keep_override', 1899, 1299)), /formula price changed since the last choice/);
});

test('a plain line: cost, formula, price, change and no flags', () => {
  const p = priceLine(input('4.80', {}, sq({ priceCents: 1099 })), ctx());
  assert.equal(p.status, 'priced');
  assert.equal(p.formula.source, 'default');
  assert.equal(p.formulaValueText, '10.60');
  assert.equal(p.formulaCents, 1099);
  assert.equal(p.newCents, 1099);
  assert.equal(p.changeCents, 0);
  assert.deepEqual(p.flags, []);
  assert.equal(p.reason, null);
});

test('the vendor formula is used when the line names a vendor in settings', () => {
  const p = priceLine(input('10.00', {}, sq({ priceCents: 2499 }), { vendor: 'example dairy' }), ctx());
  assert.equal(p.formula.source, 'vendor');
  assert.equal(p.newCents, 2499);
});

test('flags a price drop and a jump over 50%, but not exactly 50%', () => {
  assert.deepEqual(ids(priceLine(input('4.00', {}, sq({ priceCents: 1099 })), ctx()).flags), ['price_drop'], '9.99 is below 10.99');
  assert.deepEqual(ids(priceLine(input('9.00', {}, sq({ priceCents: 1099 })), ctx()).flags), ['big_jump'], '19.99 is 82% up');
  assert.deepEqual(ids(priceLine(input('4.49', {}, sq({ priceCents: 665 })), ctx()).flags), ['big_jump'], 'a cent past 50%');
  const atHalf = priceLine(input('4.49', {}, sq({ priceCents: 666 })), ctx()); // 9.99 against 6.66 is exactly 50% up
  assert.equal(atHalf.newCents, 999);
  assert.deepEqual(ids(atHalf.flags), []);
});

test('a needs-decision line sends nothing but still shows the jump against Square', () => {
  const p = priceLine(input('9.00', {}, sq({ priceCents: 1099 })), ctx([ov('V1', 1299)]));
  assert.equal(p.status, 'needs_decision');
  assert.equal(p.newCents, null);
  assert.equal(p.changeCents, null);
  assert.equal(p.formulaCents, 1999);
  assert.deepEqual(ids(p.flags), ['big_jump', 'needs_decision']);
  const decided = priceLine(input('9.00', {}, sq({ priceCents: 1099 })), ctx([ov('V1', 1299)], [decision('keep_override', 1999, 1299)]));
  assert.equal(decided.status, 'priced');
  assert.equal(decided.newCents, 1299);
  assert.equal(decided.changeCents, 200);
  assert.deepEqual(decided.overrideAction, { kind: 'keep' });
});

test('an override above the formula is used, and both prices are shown', () => {
  const p = priceLine(input('3.90', {}, sq({ priceCents: 1299 })), ctx([ov('V1', 1299)]));
  assert.equal(p.formulaCents, 899);
  assert.equal(p.newCents, 1299);
  assert.deepEqual(p.override, { kind: 'override', overrideCents: 1299, formulaCents: 899 });
});

test('a scale item not sold by weight in Square is flagged and marked for the switch', () => {
  const weight = { unit: 'LB' };
  const atRegister = priceLine(input('7.00', weight, sq({ scaleCode: '1234', pricingType: 'VARIABLE_PRICING', priceCents: null })), ctx());
  assert.equal(atRegister.newCents, 1599);
  assert.equal(atRegister.switchToWeight, true);
  assert.deepEqual(ids(atRegister.flags), ['no_current_price', 'not_sold_by_weight']);
  const noUnit = priceLine(input('7.00', weight, sq({ scaleCode: '1234', priceCents: 1599 })), ctx());
  assert.equal(noUnit.switchToWeight, true);
  const right = priceLine(input('7.00', weight, sq({ scaleCode: '1234', perPound: true, priceCents: 1599 })), ctx());
  assert.equal(right.switchToWeight, false);
  assert.deepEqual(right.flags, []);
});

test('a scale item priced per case on the invoice gets no price, never a guess', () => {
  const p = priceLine(input('60.00', { packSize: '1/CS', unit: 'CS' }, sq({ scaleCode: '1234', perPound: true })), ctx());
  assert.equal(p.status, 'no_price');
  assert.equal(p.newCents, null);
  assert.match(p.reason ?? '', /cost per pound is needed/);
  assert.deepEqual(ids(p.flags), ['price_unclear']);
});

test('an override with no formula price to check sends nothing and says why', () => {
  const p = priceLine(input('10.00', { unit: '' }, sq()), ctx([ov('V1', 1299)]));
  assert.equal(p.status, 'no_price');
  assert.equal(p.override.kind, 'unchecked');
  assert.equal(p.flags.length, 1);
  assert.match(p.flags[0]!.message, /override of \$12\.99 could not be checked/);
});

test('an unmatched line is priced from the invoice alone, on the regular cost, and an allowance is noted', () => {
  const withAllowance = (): PriceLineInput => {
    const i = input('20.50', { packSize: '1/CS', unit: 'CS' }, null);
    return { ...i, basis: { ...i.basis, allowance: '3.50' } };
  };
  const p = priceLine(withAllowance(), ctx());
  assert.equal(saleModeOf(null), 'unknown');
  assert.equal(p.newCents, 4299, '2 x 20.50 + 1 = 42.00, so 42.99; the allowance does not lower it');
  assert.equal(p.squareCents, null);
  assert.deepEqual(ids(p.flags), ['allowance']);
  assert.match(p.flags[0]!.message, /allowance is on this line\. The price uses the regular cost before it/);
  const net = priceLine(withAllowance(), { ...ctx(), allowanceBasis: 'net' });
  assert.equal(net.newCents, 3599, 'only when asked: 2 x 17.00 + 1 = 35.00, so 35.99');
});

test('each line carries its variation and scale code', () => {
  const p = priceLine(input('7.00', { unit: 'LB' }, sq({ scaleCode: '1234', perPound: true })), ctx());
  assert.deepEqual([p.variationId, p.scaleCode], ['V1', '1234']);
  const none = priceLine(input('7.00', { unit: 'LB' }, null), ctx());
  assert.deepEqual([none.variationId, none.scaleCode], [null, null]);
});

test('two lines for one variation with different prices are both blocked until a pick', () => {
  const lines = () => [
    input('4.80', {}, sq({ priceCents: 1099 }), { n: 1 }), // 10.99
    input('5.20', {}, sq({ priceCents: 1099 }), { n: 2 }), // 11.99
    input('3.00', {}, sq({ variationId: 'V2', priceCents: 699 }), { n: 3 }),
  ];
  const [a, b, c] = priceLines(lines(), ctx());
  for (const l of [a!, b!]) {
    assert.equal(l.status, 'conflict');
    assert.equal(l.newCents, null);
    assert.equal(l.changeCents, null);
    assert.ok(l.flags.some((f) => f.id === 'conflict' && /\$10\.99, \$11\.99/.test(f.message)));
  }
  assert.match(a!.flags.find((f) => f.id === 'conflict')!.message, /This line and line 2/);
  assert.equal(c!.status, 'priced', 'another variation is not affected');

  const picked = priceLines(lines(), { ...ctx(), conflictPicks: [{ variationId: 'V1', priceCents: 1199, shownCents: [1199, 1099], decidedBy: 'u2' }] });
  for (const l of picked.slice(0, 2)) {
    assert.equal(l.status, 'priced');
    assert.equal(l.newCents, 1199);
    assert.equal(l.changeCents, 100);
    assert.match(l.flags.find((f) => f.id === 'conflict')!.message, /\$11\.99 was picked/);
  }
  const stalePick = priceLines(lines(), { ...ctx(), conflictPicks: [{ variationId: 'V1', priceCents: 1199, shownCents: [1099, 1299], decidedBy: 'u2' }] });
  assert.equal(stalePick[0]!.status, 'conflict');
  assert.match(stalePick[0]!.flags.find((f) => f.id === 'conflict')!.message, /asked again/);
  const badPick = priceLines(lines(), { ...ctx(), conflictPicks: [{ variationId: 'V1', priceCents: 0, shownCents: [1099, 1199], decidedBy: 'u2' }] });
  assert.equal(badPick[1]!.status, 'conflict');
});

test('lines for one variation that agree on the price, or that have no price, are not a conflict', () => {
  const same = priceLines([input('4.80', {}, sq(), { n: 1 }), input('4.75', {}, sq(), { n: 2 })], ctx()); // both 10.99
  assert.deepEqual(same.map((l) => l.status), ['priced', 'priced']);
  const oneUnclear = priceLines([input('4.80', {}, sq(), { n: 1 }), input('4.80', { unit: '' }, sq(), { n: 2 })], ctx());
  assert.deepEqual(oneUnclear.map((l) => l.status), ['priced', 'no_price']);
});

test('a conflict that involves a pending override decision keeps that question visible', () => {
  const ls = priceLines([input('9.00', {}, sq(), { n: 1 }), input('4.00', {}, sq(), { n: 2 })], ctx([ov('V1', 1299)]));
  assert.deepEqual(ls.map((l) => l.status), ['conflict', 'conflict'], '19.99 pending against the override, 12.99 override');
  assert.deepEqual(ids(ls[0]!.flags), ['big_jump', 'conflict', 'needs_decision']);
});

test('a price too large to hold is refused', () => {
  const p = priceLine(input('900000000000000', {}, null), ctx());
  assert.equal(p.status, 'no_price');
  assert.match(p.reason ?? '', /too large/);
});

test('a location override decides pricing at that location; a register price there means not sold by weight', () => {
  const pounds = new Set(['LB1']);
  const item = { item_data: { name: 'Example Ham 1234' } };
  const variation = (override: Record<string, unknown>) => ({
    id: 'VAR1',
    item_variation_data: {
      pricing_type: 'FIXED_PRICING',
      price_money: { amount: 1499, currency: 'USD' },
      measurement_unit_id: 'LB1',
      location_overrides: [{ location_id: 'LOC1', ...override }],
    },
  });
  const atRegister = squareItemState(item, variation({ pricing_type: 'VARIABLE_PRICING', track_inventory: true }), 'LOC1', pounds);
  assert.deepEqual([atRegister.pricingType, atRegister.priceCents, atRegister.perPound], ['VARIABLE_PRICING', null, true]);
  const p = priceLine(input('7.00', { unit: 'LB' }, atRegister), ctx());
  assert.equal(p.switchToWeight, true, 'rule 12: a register price at the store is not sold by weight');
  assert.deepEqual(ids(p.flags), ['no_current_price', 'not_sold_by_weight']);
  assert.equal(squareItemState(item, variation({ pricing_type: 'VARIABLE_PRICING' }), 'LOC2', pounds).pricingType, 'FIXED_PRICING', 'other locations keep the variation values');
  const noPricingFields = squareItemState(item, variation({ track_inventory: true, sold_out: false }), 'LOC1', pounds);
  assert.deepEqual([noPricingFields.pricingType, noPricingFields.priceCents], ['FIXED_PRICING', 1499], 'no pricing fields: the variation values');
  const fixedNoPrice = squareItemState(item, variation({ pricing_type: 'FIXED_PRICING' }), 'LOC1', pounds);
  assert.deepEqual([fixedNoPrice.pricingType, fixedNoPrice.priceCents], ['FIXED_PRICING', null], 'the override decides; its missing price is not filled from the variation');
  const fixedHere = squareItemState(item, variation({ pricing_type: 'FIXED_PRICING', price_money: { amount: 1299, currency: 'USD' } }), 'LOC1', pounds);
  assert.equal(fixedHere.priceCents, 1299);
  const variableVariation = { id: 'VAR2', item_variation_data: { pricing_type: 'VARIABLE_PRICING', measurement_unit_id: 'LB1', location_overrides: [{ location_id: 'LOC1', price_money: { amount: 1599, currency: 'USD' } }] } };
  const fixedByOverride = squareItemState(item, variableVariation, 'LOC1', pounds);
  assert.deepEqual([fixedByOverride.pricingType, fixedByOverride.priceCents], ['FIXED_PRICING', 1599], 'a location price alone means a fixed price there');
});

test('reads price, pricing type, per-pound unit and scale code from catalog objects', () => {
  assert.equal(trailingScaleCode('Smoked Gouda 1234'), '1234');
  assert.equal(trailingScaleCode('Brie - 8oz - 7001 '), '7001');
  assert.equal(trailingScaleCode('Crackers 12345'), null);
  assert.equal(trailingScaleCode('ABC1234'), null);
  assert.equal(trailingScaleCode('Olive Oil'), null);
  const objects = [
    { type: 'MEASUREMENT_UNIT', id: 'LB1', measurement_unit_data: { measurement_unit: { type: 'TYPE_WEIGHT', weight_unit: 'IMPERIAL_POUND' } } },
    { type: 'MEASUREMENT_UNIT', id: 'OZ1', measurement_unit_data: { measurement_unit: { type: 'TYPE_WEIGHT', weight_unit: 'IMPERIAL_WEIGHT_OUNCE' } } },
    { type: 'MEASUREMENT_UNIT', id: 'LB2', is_deleted: true, measurement_unit_data: { measurement_unit: { type: 'TYPE_WEIGHT', weight_unit: 'IMPERIAL_POUND' } } },
  ];
  const pounds = perPoundUnitIds(objects);
  assert.deepEqual([...pounds], ['LB1']);
  const item = { item_data: { name: 'Example Ham 1234' } };
  const v = {
    id: 'VAR1',
    item_variation_data: {
      pricing_type: 'FIXED_PRICING',
      price_money: { amount: 1499, currency: 'USD' },
      measurement_unit_id: 'LB1',
      location_overrides: [{ location_id: 'LOC1', price_money: { amount: 1399, currency: 'USD' } }],
    },
  };
  assert.deepEqual(squareItemState(item, v, 'LOC1', pounds), { variationId: 'VAR1', priceCents: 1399, pricingType: 'FIXED_PRICING', perPound: true, scaleCode: '1234' });
  assert.equal(squareItemState(item, v, 'LOC2', pounds).priceCents, 1499, 'another location uses the general price');
  assert.equal(squareItemState(item, v, 'LOC1', pounds, null).scaleCode, null, 'matching can say a number is not a scale code');
  assert.equal(squareItemState(item, v, 'LOC1', pounds, '1234').scaleCode, '1234', 'the item\'s own code from matching');
  assert.equal(squareItemState(item, v, 'LOC1', pounds, '9999').scaleCode, null, 'a code that is not this name\'s is refused');
  const variable = { id: 'VAR2', item_variation_data: { pricing_type: 'VARIABLE_PRICING' } };
  assert.deepEqual(squareItemState(item, variable, 'LOC1', pounds), { variationId: 'VAR2', priceCents: null, pricingType: 'VARIABLE_PRICING', perPound: false, scaleCode: '1234' });
  const otherCurrency = { id: 'VAR3', item_variation_data: { pricing_type: 'FIXED_PRICING', price_money: { amount: 500, currency: 'CAD' } } };
  assert.equal(squareItemState(item, otherCurrency, 'LOC1', pounds).priceCents, null);
});
