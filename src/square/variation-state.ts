// What the dry run needs from Square's raw catalog objects that the matching index does not keep:
// stock tracking, the sold-out flag and whether a location override carries its own pricing.
//
// Tracking is set per location on some items and on the variation on others, and the two can
// disagree (store/docs/SQUARE-NOTES.md). The location override decides first, then the variation.

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

export interface RawVariation {
  item: Json;
  variation: Json;
}

/** Variation id to its raw item and variation objects. Deleted objects are left out. */
export function rawVariations(objects: readonly unknown[]): Map<string, RawVariation> {
  const out = new Map<string, RawVariation>();
  for (const o of objects) {
    const item = obj(o);
    if (!item || item.type !== 'ITEM' || item.is_deleted === true) continue;
    const vars = obj(item.item_data)?.variations;
    if (!Array.isArray(vars)) continue;
    for (const v of vars) {
      const variation = obj(v);
      if (!variation || variation.is_deleted === true || typeof variation.id !== 'string') continue;
      out.set(variation.id, { item, variation });
    }
  }
  return out;
}

export interface VariationSquareState {
  tracked: boolean;
  /** Where the tracking answer came from. */
  trackedBy: 'location' | 'variation' | 'default';
  soldOut: boolean;
  /** A location override carries a price or pricing type, so a price change must change it too. */
  locationPricing: boolean;
  /** The location override says to take the price at the register. */
  locationVariable: boolean;
  itemVersion: number | null;
  variationVersion: number | null;
}

function version(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^\d{1,19}$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function variationSquareState(raw: RawVariation | undefined, locationId: string): VariationSquareState {
  const d = obj(raw?.variation.item_variation_data) ?? {};
  const overrides = Array.isArray(d.location_overrides) ? d.location_overrides.map(obj) : [];
  const local = overrides.find((o) => o !== null && o.location_id === locationId) ?? null;
  let tracked = false;
  let trackedBy: VariationSquareState['trackedBy'] = 'default';
  if (local && typeof local.track_inventory === 'boolean') {
    tracked = local.track_inventory;
    trackedBy = 'location';
  } else if (typeof d.track_inventory === 'boolean') {
    tracked = d.track_inventory;
    trackedBy = 'variation';
  }
  return {
    tracked,
    trackedBy,
    soldOut: local?.sold_out === true,
    locationPricing: local !== null && (local.pricing_type !== undefined || local.price_money !== undefined),
    locationVariable: local?.pricing_type === 'VARIABLE_PRICING',
    itemVersion: version(raw?.item.version),
    variationVersion: version(raw?.variation.version),
  };
}
