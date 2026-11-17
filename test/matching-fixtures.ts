// A small invented Square catalog for the matching tests. Invented names, ids and codes only,
// never store data: automated tests must not read data/ or test-invoices/.

import { buildCatalogIndex, type CatalogIndex } from '../src/matching/catalog.ts';
import { checkDigitFor } from '../src/matching/upc.ts';

/** A valid UPC-A from 11 digits. */
export function upcA(body11: string): string {
  return `${body11}${checkDigitFor(body11)}`;
}

/** The UPC Square builds from a scale code. */
export function codeUpc(code: string): string {
  return upcA(`0000000${code}`);
}

export const POUND = 'UNIT_POUND_TEST';
export const LOCATION = 'LOC_TEST';

export interface VarSpec {
  id: string;
  name?: string;
  upc?: string;
  pricing?: 'FIXED_PRICING' | 'VARIABLE_PRICING';
  cents?: number | null;
  unit?: string;
}

export interface ItemSpec {
  id: string;
  name: string;
  category?: string;
  archived?: boolean;
  absentHere?: boolean;
  variations: VarSpec[];
}

export function item(spec: ItemSpec): Record<string, unknown> {
  return {
    type: 'ITEM',
    id: spec.id,
    version: 1,
    is_deleted: false,
    present_at_all_locations: true,
    ...(spec.absentHere ? { absent_at_location_ids: [LOCATION] } : {}),
    item_data: {
      name: spec.name,
      is_archived: spec.archived ?? false,
      ...(spec.category ? { categories: [{ id: spec.category }], reporting_category: { id: spec.category } } : {}),
      variations: spec.variations.map((v, i) => ({
        type: 'ITEM_VARIATION',
        id: v.id,
        version: 1,
        is_deleted: false,
        item_variation_data: {
          item_id: spec.id,
          name: v.name ?? 'Regular',
          ordinal: i,
          pricing_type: v.pricing ?? 'FIXED_PRICING',
          ...(v.upc ? { upc: v.upc } : {}),
          ...(v.cents === null || (v.pricing ?? 'FIXED_PRICING') === 'VARIABLE_PRICING' ? {} : { price_money: { amount: v.cents ?? 999, currency: 'USD' } }),
          ...(v.unit ? { measurement_unit_id: v.unit } : {}),
        },
      })),
    },
  };
}

export const CAT_CHEESE = 'CAT_CHEESE';
export const CAT_MEAT = 'CAT_MEAT';
export const CAT_FISH = 'CAT_FISH';
export const CAT_WINE = 'CAT_WINE';
export const CAT_CRACKERS = 'CAT_CRACKERS';
export const CAT_CHIPS = 'CAT_CHIPS';

export const UPC_CRACKER = upcA('00011122233');
export const UPC_CRACKER_ROSE = upcA('00011122234');
export const UPC_SHARED = upcA('00011199999');
export const UPC_ARCHIVED = upcA('00011177777');
/** A Bluecrest importer UPC: prefix 000333, then the importer's item number 45678 in digits 7 to 11. */
export const UPC_IMPORTER = upcA('00033345678');
export const UPC_IMPORTER_2 = upcA('00033345679');
export const UPC_CHIP_SALT = upcA('00044455566');

export function testObjects(): Record<string, unknown>[] {
  return [
    { type: 'MEASUREMENT_UNIT', id: POUND, measurement_unit_data: { measurement_unit: { weight_unit: 'IMPERIAL_POUND', type: 'TYPE_WEIGHT' }, precision: 3 } },
    { type: 'CATEGORY', id: CAT_CHEESE, category_data: { name: 'Cheese' } },
    { type: 'CATEGORY', id: CAT_MEAT, category_data: { name: 'Deli Meat' } },
    { type: 'CATEGORY', id: CAT_FISH, category_data: { name: 'Fish Counter' } },
    { type: 'CATEGORY', id: CAT_WINE, category_data: { name: 'Wine' } },
    { type: 'CATEGORY', id: CAT_CRACKERS, category_data: { name: 'Crackers' } },
    { type: 'CATEGORY', id: CAT_CHIPS, category_data: { name: 'Chips' } },
    // By weight, done right: fixed price per pound with the pound unit.
    item({ id: 'I_GOUDA', name: 'Gouda Smoked 7101', category: CAT_CHEESE, variations: [{ id: 'V_GOUDA', upc: codeUpc('7101'), cents: 1899, unit: POUND }] }),
    item({ id: 'I_CHEDDAR', name: 'Hilltop Aged Cheddar 7102', category: CAT_CHEESE, variations: [{ id: 'V_CHEDDAR', cents: 2199, unit: POUND }] }),
    // A cheese whose unit was never set: still a code, because it is a cheese, and flagged.
    item({ id: 'I_BRIE', name: 'Meadow Brie 7103', category: CAT_CHEESE, variations: [{ id: 'V_BRIE', cents: 1499 }] }),
    item({ id: 'I_HAM', name: 'Oakvale - Tavern Ham 1201', category: CAT_MEAT, variations: [{ id: 'V_HAM', upc: codeUpc('1201'), cents: 1499, unit: POUND }] }),
    item({ id: 'I_TURKEY', name: 'Oakvale - Roasted Turkey 1202', category: CAT_MEAT, variations: [{ id: 'V_TURKEY', upc: codeUpc('1202'), cents: 1799, unit: POUND }] }),
    item({ id: 'I_SALAMI', name: 'Fennel Salami 2301', category: CAT_MEAT, variations: [{ id: 'V_SALAMI', cents: 2299, unit: POUND }] }),
    // Fish priced at the register, with a code-built UPC: a code, flagged as not sold by weight.
    item({ id: 'I_SALMON', name: 'Coho Salmon 4101', category: CAT_FISH, variations: [{ id: 'V_SALMON', upc: codeUpc('4101'), pricing: 'VARIABLE_PRICING' }] }),
    item({ id: 'I_TROUT', name: 'Lake Trout 4102', category: CAT_FISH, variations: [{ id: 'V_TROUT', upc: codeUpc('4102'), pricing: 'VARIABLE_PRICING' }] }),
    // Sold by the pound but no code in the name; the UPC is built from 4103.
    item({ id: 'I_CRAB', name: 'Crab Claws', category: CAT_FISH, variations: [{ id: 'V_CRAB', upc: codeUpc('4103'), cents: 3999, unit: POUND }] }),
    // A wine named for its year: not a scale code.
    item({ id: 'I_WINE', name: 'Valley Red 2021', category: CAT_WINE, variations: [{ id: 'V_WINE', upc: upcA('00055566677'), cents: 1899 }] }),
    // Packaged goods: "Maker - Product" with maker UPCs.
    item({ id: 'I_CRACKER', name: 'Bluecrest - Crackers, Sea Salt', category: CAT_CRACKERS, variations: [{ id: 'V_CRACKER', upc: UPC_CRACKER, cents: 599 }] }),
    item({ id: 'I_CRACKER_ROSE', name: 'Bluecrest - Crackers, Rosemary', category: CAT_CRACKERS, variations: [{ id: 'V_CRACKER_ROSE', upc: UPC_CRACKER_ROSE, cents: 599 }] }),
    item({ id: 'I_WAFER', name: 'Northfield - Wafer Crackers, Pepper', category: CAT_CRACKERS, variations: [{ id: 'V_WAFER', cents: 699 }] }),
    item({ id: 'I_IMPORT', name: 'Bluecrest - Torchio Pasta', category: CAT_CRACKERS, variations: [{ id: 'V_IMPORT', upc: UPC_IMPORTER, cents: 799 }] }),
    item({ id: 'I_IMPORT2', name: 'Bluecrest - Trenne Pasta', category: CAT_CRACKERS, variations: [{ id: 'V_IMPORT2', upc: UPC_IMPORTER_2, cents: 799 }] }),
    // One item with many flavours: match the line to the variation.
    item({
      id: 'I_CHIPS',
      name: 'Ridgeway Chips',
      category: CAT_CHIPS,
      variations: [
        { id: 'V_CHIPS_SALT', name: 'Sea Salt', upc: UPC_CHIP_SALT, cents: 299 },
        { id: 'V_CHIPS_TRUFFLE', name: 'Black Truffle', cents: 299 },
        { id: 'V_CHIPS_PAPRIKA', name: 'Smoked Paprika', cents: 299 },
      ],
    }),
    // Two items carrying one UPC, an archived item and an item not offered here.
    item({ id: 'I_DUP_A', name: 'Harbor Sardines', variations: [{ id: 'V_DUP_A', upc: UPC_SHARED, cents: 499 }] }),
    item({ id: 'I_DUP_B', name: 'Harbor Mackerel', variations: [{ id: 'V_DUP_B', upc: UPC_SHARED, cents: 499 }] }),
    item({ id: 'I_OLD', name: 'Retired Biscuit', archived: true, variations: [{ id: 'V_OLD', upc: UPC_ARCHIVED, cents: 399 }] }),
    item({ id: 'I_AWAY', name: 'Faraway Jam', absentHere: true, variations: [{ id: 'V_AWAY', upc: upcA('00011166666'), cents: 699 }] }),
  ];
}

export function testIndex(extra: Record<string, unknown>[] = []): CatalogIndex {
  return buildCatalogIndex({ objects: [...testObjects(), ...extra], locationId: LOCATION });
}
