// The catalog index: scale codes, sold by weight, UPCs, variations and data notes. Invented catalog.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalogIndex } from '../src/matching/catalog.ts';
import { upcKey } from '../src/matching/upc.ts';
import { CAT_CHEESE, CAT_FISH, CAT_WINE, codeUpc, item, LOCATION, testIndex, testObjects, upcA, UPC_CHIP_SALT, UPC_SHARED } from './matching-fixtures.ts';

test('the per-pound unit is read from the catalog, never assumed', () => {
  const index = testIndex();
  assert.deepEqual([...index.perPoundUnitIds], ['UNIT_POUND_TEST']);
  const custom = buildCatalogIndex({
    objects: [{ type: 'MEASUREMENT_UNIT', id: 'U_LB', measurement_unit_data: { measurement_unit: { custom_unit: { name: 'Pound', abbreviation: 'lb' }, type: 'TYPE_CUSTOM' } } }],
  });
  assert.deepEqual([...custom.perPoundUnitIds], [], 'a custom unit named lb is not the pound unit');
});

test('a trailing number is a scale code only for products sold by weight', () => {
  const index = testIndex();
  const get = (id: string) => index.itemById.get(id)!;
  assert.equal(get('I_GOUDA').scaleCode, '7101');
  assert.match(get('I_GOUDA').codeEvidence.join(' '), /per-pound unit/);
  assert.equal(get('I_SALMON').scaleCode, '4101', 'priced at the register, UPC built from the code');
  // No unit and no code-built UPC, but most numbered cheeses are sold by weight.
  assert.equal(get('I_BRIE').scaleCode, '7103');
  assert.match(get('I_BRIE').codeEvidence.join(' '), /most numbered items in the Cheese category/);
  // A wine named for its year.
  assert.equal(get('I_WINE').trailingNumber, '2021');
  assert.equal(get('I_WINE').scaleCode, null);
  assert.ok(index.notes.some((n) => n.kind === 'number_not_code' && n.itemIds.includes('I_WINE')));
  assert.equal(index.byScaleCode.has('2021'), false);
  assert.deepEqual(index.byScaleCode.get('1201')!.map((i) => i.id), ['I_HAM']);
});

test('every item with a scale code must be fixed price per pound with the pound unit', () => {
  const index = testIndex();
  const get = (id: string) => index.itemById.get(id)!;
  assert.deepEqual(get('I_GOUDA').byWeight, { required: true, ok: true, problems: [] });
  assert.equal(get('I_BRIE').byWeight.ok, false);
  assert.match(get('I_BRIE').byWeight.problems.join(' '), /no per-pound unit/);
  assert.equal(get('I_SALMON').byWeight.ok, false);
  assert.match(get('I_SALMON').byWeight.problems.join(' '), /taken at the register.*fixed price per pound/);
  assert.match(get('I_SALMON').byWeight.problems.join(' '), /no per-pound unit/);
  assert.equal(get('I_CRACKER').byWeight.required, false);
  assert.ok(index.notes.some((n) => n.kind === 'not_sold_by_weight' && n.itemIds.includes('I_SALMON')));
  // Sold by the pound with no code in the name: noted, with the code its UPC was built from.
  const crab = index.notes.find((n) => n.kind === 'per_pound_without_code' && n.itemIds.includes('I_CRAB'));
  assert.match(crab!.message, /built from 4103/);
  assert.equal(get('I_CRAB').scaleCode, null, 'the code comes from the name, never the UPC');
});

test('a wrong price type or another unit is a problem too', () => {
  const index = buildCatalogIndex({
    objects: [
      ...testObjects(),
      { type: 'MEASUREMENT_UNIT', id: 'U_OZ', measurement_unit_data: { measurement_unit: { weight_unit: 'IMPERIAL_WEIGHT_OUNCE' } } },
      item({ id: 'I_OZ', name: 'Ounce Cheese 7110', category: CAT_CHEESE, variations: [{ id: 'V_OZ', cents: 199, unit: 'U_OZ' }] }),
      item({ id: 'I_NOPRICE', name: 'Priceless Cheese 7111', category: CAT_CHEESE, variations: [{ id: 'V_NP', cents: null, unit: 'UNIT_POUND_TEST' }] }),
    ],
    locationId: LOCATION,
  });
  assert.match(index.itemById.get('I_OZ')!.byWeight.problems.join(' '), /not per pound/);
  assert.match(index.itemById.get('I_NOPRICE')!.byWeight.problems.join(' '), /no price/);
});

test('UPCs: one key for any form, shared and invalid codes noted, code-built UPCs marked', () => {
  const index = testIndex([item({ id: 'I_BADUPC', name: 'Bad Code Cheese 7120', category: CAT_CHEESE, variations: [{ id: 'V_BADUPC', upc: '000000071201', unit: 'UNIT_POUND_TEST' }] })]);
  assert.equal(index.byUpc.get(upcKey(`0${UPC_CHIP_SALT}`)!)![0]!.id, 'V_CHIPS_SALT');
  assert.equal(index.byUpc.get(upcKey(UPC_SHARED)!)!.length, 2);
  assert.ok(index.notes.some((n) => n.kind === 'upc_shared'));
  assert.equal(index.variationById.get('V_GOUDA')!.upcFromScaleCode, '7101');
  assert.equal(index.variationById.get('V_CRACKER')!.upcFromScaleCode, null);
  assert.equal(index.variationById.get('V_BADUPC')!.upcKey, null);
  assert.ok(index.notes.some((n) => n.kind === 'upc_invalid' && n.itemIds.includes('I_BADUPC')));
});

test('two items ending in one code are noted for a person', () => {
  const index = testIndex([item({ id: 'I_TWIN', name: 'Smoked Gouda Twin 7101', category: CAT_CHEESE, variations: [{ id: 'V_TWIN', unit: 'UNIT_POUND_TEST' }] })]);
  assert.equal(index.byScaleCode.get('7101')!.length, 2);
  assert.ok(index.notes.some((n) => n.kind === 'code_shared' && n.message.includes('7101')));
});

test('multi-variation items are matched by variation, labelled with the variation name', () => {
  const index = testIndex();
  assert.equal(index.variationById.get('V_CHIPS_TRUFFLE')!.label, 'Ridgeway Chips: Black Truffle');
  assert.equal(index.variationById.get('V_GOUDA')!.label, 'Gouda Smoked 7101', 'a lone Regular variation takes the item name');
  const doc = index.docs.find((d) => d.variation.id === 'V_CHIPS_TRUFFLE')!;
  assert.deepEqual(doc.productWords, ['ridgeway', 'chip', 'black', 'truffle']);
});

test('archived items and items absent at the store location are kept and marked', () => {
  const index = testIndex();
  assert.equal(index.itemById.get('I_OLD')!.archived, true);
  assert.equal(index.itemById.get('I_AWAY')!.availableHere, false);
  assert.equal(index.itemById.get('I_GOUDA')!.availableHere, true);
});

test('deleted objects, loose variations and odd shapes are handled', () => {
  const index = buildCatalogIndex({
    objects: [
      null,
      'nonsense',
      { type: 'ITEM', id: 'I_DEL', is_deleted: true, item_data: { name: 'Gone 7001', variations: [] } },
      { type: 'ITEM', id: 'I_LOOSE', item_data: { name: 'Loose Item', variations: [] } },
      { type: 'ITEM_VARIATION', id: 'V_LOOSE', item_variation_data: { item_id: 'I_LOOSE', name: 'Regular', pricing_type: 'FIXED_PRICING', price_money: { amount: 100, currency: 'USD' } } },
      { type: 'ITEM', id: '', item_data: { name: 'No id' } },
      { type: 'CATEGORY', id: CAT_WINE, category_data: { name: 'Wine' } },
    ],
  });
  assert.deepEqual(index.items.map((i) => i.id), ['I_LOOSE']);
  assert.equal(index.variationById.get('V_LOOSE')!.priceCents, 100);
});

test('the code-built UPC of a code is recognised even when the name ends in another code', () => {
  const index = testIndex([item({ id: 'I_MIX', name: 'Mixed Up Cheese 7130', category: CAT_CHEESE, variations: [{ id: 'V_MIX', upc: codeUpc('7131'), unit: 'UNIT_POUND_TEST' }] })]);
  assert.ok(index.notes.some((n) => n.kind === 'upc_code_differs' && n.itemIds.includes('I_MIX')));
});

test('a location override with a pricing field decides the price at the store, as pricing reads it', () => {
  const withOverride = (override: Record<string, unknown>) => {
    const o = item({ id: 'I_LOC', name: 'Local Cheese 7140', category: CAT_CHEESE, variations: [{ id: 'V_LOC', cents: 1999, unit: 'UNIT_POUND_TEST' }] }) as { item_data: { variations: { item_variation_data: Record<string, unknown> }[] } };
    o.item_data.variations[0]!.item_variation_data.location_overrides = [{ location_id: LOCATION, ...override }];
    return testIndex([o]).variationById.get('V_LOC')!;
  };
  const atRegister = withOverride({ pricing_type: 'VARIABLE_PRICING' });
  assert.equal(atRegister.pricing, 'variable');
  assert.equal(atRegister.priceCents, null);
  assert.equal(withOverride({ price_money: { amount: 2499, currency: 'USD' } }).priceCents, 2499);
  assert.equal(withOverride({ track_inventory: true }).priceCents, 1999, 'an override without pricing fields leaves the price alone');
});

test('a price taken at the register is not proof of a scale code on its own, and having no category teaches nothing', () => {
  const index = testIndex([
    // Priced at the register, no unit, no code-built UPC, no category: not a code.
    item({ id: 'I_PLATTER', name: 'Party Platter 1990', variations: [{ id: 'V_PLATTER', pricing: 'VARIABLE_PRICING' }] }),
    // With no category, a per-pound neighbour does not make another numbered item a code.
    item({ id: 'I_LOOSE_LB', name: 'Loose Olives 5101', variations: [{ id: 'V_LOOSE_LB', cents: 999, unit: 'UNIT_POUND_TEST' }] }),
    item({ id: 'I_GIFT', name: 'Gift Box 2024', variations: [{ id: 'V_GIFT', cents: 4999 }] }),
    // Priced at the register in a category sold by weight: a code.
    item({ id: 'I_FISH2', name: 'Rock Bass 4105', category: CAT_FISH, variations: [{ id: 'V_FISH2', pricing: 'VARIABLE_PRICING' }] }),
  ]);
  assert.equal(index.itemById.get('I_PLATTER')!.scaleCode, null);
  assert.match(index.notes.find((n) => n.itemIds.includes('I_PLATTER'))!.message, /price taken at the register is not enough/);
  assert.equal(index.itemById.get('I_LOOSE_LB')!.scaleCode, '5101', 'the pound unit is proof on the item itself');
  assert.equal(index.itemById.get('I_GIFT')!.scaleCode, null);
  assert.equal(index.byWeightCategories.has(''), false);
  assert.equal(index.itemById.get('I_FISH2')!.scaleCode, '4105');
});

test('presence at the store is read at item and variation level, the way Square means it', () => {
  const absentVariation = item({ id: 'I_PART', name: 'Partial Jam', variations: [{ id: 'V_PART_HERE', upc: upcA('00012121212'), cents: 599 }, { id: 'V_PART_GONE', upc: upcA('00012121213'), cents: 599 }] }) as {
    item_data: { variations: Record<string, unknown>[] };
  };
  absentVariation.item_data.variations[1]!.absent_at_location_ids = [LOCATION];
  const onlyElsewhere = item({ id: 'I_ELSE', name: 'Elsewhere Jam', variations: [{ id: 'V_ELSE', cents: 599 }] }) as Record<string, unknown>;
  onlyElsewhere.present_at_all_locations = false;
  onlyElsewhere.present_at_location_ids = ['LOC_OTHER'];
  const index = testIndex([absentVariation, onlyElsewhere]);
  assert.equal(index.variationById.get('V_PART_HERE')!.availableHere, true, 'no presence fields means present everywhere');
  assert.equal(index.variationById.get('V_PART_GONE')!.availableHere, false);
  assert.equal(index.itemById.get('I_ELSE')!.availableHere, false);
});

