// Reads what pricing needs from Square catalog objects (the JSON shape Square's catalog API
// returns). No network here: the caller has already fetched the objects.

import { trailingScaleCode } from '../lib/scale-code.ts';
import type { SquareItemState } from './price.ts';

/**
 * The 4-digit scale code at the very end of a Square item name, as its own word
 * ("Smoked Swiss 1234"). One function with matching: src/lib/scale-code.ts.
 */
export { trailingScaleCode };

/** Ids of the per-pound measurement units among catalog objects. Found by kind, never by a stored id. */
export function perPoundUnitIds(objects: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const o of objects) {
    if (o?.type !== 'MEASUREMENT_UNIT' || o.is_deleted) continue;
    const mu = o.measurement_unit_data?.measurement_unit;
    if (mu?.type === 'TYPE_WEIGHT' && mu.weight_unit === 'IMPERIAL_POUND') ids.add(String(o.id));
  }
  return ids;
}

function centsOf(money: any): number | null {
  if (!money || money.currency !== 'USD') return null;
  const a = money.amount;
  const n = typeof a === 'bigint' ? Number(a) : typeof a === 'string' && /^\d{1,12}$/.test(a) ? Number(a) : a;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Pricing's view of one variation at one location: how it is priced and its price there,
 * whether it uses the per-pound unit, and the scale code from the item name.
 *
 * A location override that carries any pricing field (pricing_type or price_money) decides both
 * the pricing type and the price at that location. An override set to VARIABLE_PRICING means
 * "price at the register" there, so a scale item is not sold by weight at that store even when
 * the variation itself is. The variation's own values are used only when the override has no
 * pricing fields.
 *
 * A name can end in 4 digits that are not a scale code (a wine named for its year), and the
 * same 4 digits can be a real code on another item. So the caller passes this item's own
 * scale code as the matching step decided it (ItemFacts.scaleCode, or null for none), never a
 * lookup of the number across the catalog. Left out, any trailing 4 digits count, which errs
 * toward the sold-by-weight checks.
 */
export function squareItemState(
  item: any,
  variation: any,
  locationId: string,
  poundUnits: ReadonlySet<string>,
  itemScaleCode?: string | null,
): SquareItemState {
  const v = variation?.item_variation_data ?? {};
  const local = Array.isArray(v.location_overrides) ? v.location_overrides.find((o: any) => o?.location_id === locationId) : undefined;
  const localPricing = local !== undefined && (local.pricing_type !== undefined || local.price_money !== undefined);
  const src = localPricing ? local : v;
  const pricingType = src.pricing_type === 'VARIABLE_PRICING' ? 'VARIABLE_PRICING' : 'FIXED_PRICING';
  const code = trailingScaleCode(String(item?.item_data?.name ?? ''));
  const priceCents = pricingType === 'FIXED_PRICING' ? centsOf(src.price_money) : null;
  return {
    variationId: String(variation?.id ?? ''),
    priceCents,
    pricingType,
    perPound: typeof v.measurement_unit_id === 'string' && poundUnits.has(v.measurement_unit_id),
    scaleCode: itemScaleCode === undefined ? code : itemScaleCode !== null && itemScaleCode === code ? code : null,
  };
}
