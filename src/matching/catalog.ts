// An in-memory index of a Square catalog for matching invoice lines.
//
// Input is the catalog as Square returns it (ITEM objects with their variations nested, plus
// CATEGORY and MEASUREMENT_UNIT objects): a saved copy of the live catalog now, the Square API
// (sandbox or live) later. Nothing store-specific is written here. The per-pound unit, the
// categories and which kinds of products are sold by weight are all read from the catalog.
//
// Scale codes (CLAUDE.md rule 12, store/docs/SQUARE-NOTES.md):
// - A scale code is the 4-digit number at the very end of an item's name, never one taken from
//   the UPC.
// - The number counts only when the item is the kind of product sold by weight, since a wine
//   named for its year ends in 4 digits too. Proof on the item itself: a per-pound unit, or a
//   UPC built from that same code. Without that, the number still counts when the item is in a
//   category where most numbered items have such proof (a cheese whose unit was never set is
//   still a cheese). A price taken at the register is not proof on its own, and having no
//   category is not a category. Otherwise the number is not a code, and a note says so.
// - Every item with a scale code must be sold by weight: fixed price per pound with the
//   per-pound unit. Anything else is listed in byWeight.problems, to be fixed in the same run.

import { splitTrailingCode } from '../lib/scale-code.ts';
import { splitMaker, words } from './text.ts';
import { readUpc, scaleCodeInUpc } from './upc.ts';

/** Longest name or id read from the catalog. Longer text is cut. */
const MAX_FIELD = 512;

export type Pricing = 'fixed' | 'variable' | 'other';

export interface CatalogVariation {
  id: string;
  itemId: string;
  name: string;
  /** What the manager sees: the item name, plus the variation name when it tells them apart. */
  label: string;
  upc: string;
  /** 14-digit key when the UPC is valid. */
  upcKey: string | null;
  /** The UPC is built from a scale code (seven zeros, code, check digit), not a maker's code. */
  upcFromScaleCode: string | null;
  sku: string;
  pricing: Pricing;
  /** Price in the smallest currency unit, when one is set. */
  priceCents: number | null;
  currency: string;
  measurementUnitId: string;
  perPound: boolean;
  /** Present at the store location (or the catalog names no location). */
  availableHere: boolean;
  version: number | null;
}

export interface ByWeightStatus {
  /** The item has a scale code, so it must be sold by weight. */
  required: boolean;
  /** Required and every variation is fixed price per pound with a price. */
  ok: boolean;
  /** Plain words, one per problem. */
  problems: string[];
}

export interface CatalogItem {
  id: string;
  name: string;
  /** The name without the trailing 4-digit number. */
  baseName: string;
  maker: string;
  product: string;
  /** The 4-digit number the name ends with, code or not. */
  trailingNumber: string | null;
  /** The trailing number when it counts as a scale code. */
  scaleCode: string | null;
  /** Why the trailing number counts as a scale code, or why not. */
  codeEvidence: string[];
  categoryIds: string[];
  categoryNames: string[];
  archived: boolean;
  /** Present at the store location (or the catalog names no location). */
  availableHere: boolean;
  variations: CatalogVariation[];
  byWeight: ByWeightStatus;
  version: number | null;
}

export type CatalogNoteKind =
  | 'number_not_code'
  | 'code_shared'
  | 'upc_shared'
  | 'upc_invalid'
  | 'upc_code_differs'
  | 'per_pound_without_code'
  | 'not_sold_by_weight';

export interface CatalogNote {
  kind: CatalogNoteKind;
  itemIds: string[];
  /** Plain words for the review screen. */
  message: string;
}

/** Words of one variation, for name matching. Maker words are kept apart: invoices often leave the maker out. */
export interface NameDoc {
  variation: CatalogVariation;
  item: CatalogItem;
  makerWords: string[];
  productWords: string[];
}

export interface CatalogIndex {
  locationId: string;
  items: CatalogItem[];
  variations: CatalogVariation[];
  itemById: Map<string, CatalogItem>;
  variationById: Map<string, CatalogVariation>;
  /** Valid UPC key to the variations that carry it. More than one is a data problem. */
  byUpc: Map<string, CatalogVariation[]>;
  /** Scale code to the items whose names end in it. More than one is a data problem. */
  byScaleCode: Map<string, CatalogItem[]>;
  /** Every UPC as stored, digits only, for spotting a misread code one digit away. */
  upcDigits: string[];
  perPoundUnitIds: Set<string>;
  categoryNames: Map<string, string>;
  /** Category ids where most numbered items are sold by weight. */
  byWeightCategories: Set<string>;
  docs: NameDoc[];
  docByVariation: Map<string, NameDoc>;
  /** How many items use each word, for weighting rare words above common ones. */
  wordItemCount: Map<string, number>;
  itemCount: number;
  notes: CatalogNote[];
}

// Square's JSON, read loosely: every field is checked before use.

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_FIELD) : '';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, MAX_FIELD)) : [];
}

function intOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v)) return Number(v);
  return null;
}

/** Square's own pound unit. A custom unit named "lb" is not it, the same as pricing reads it. */
function isPoundUnit(o: Json): boolean {
  const mu = obj(obj(o.measurement_unit_data)?.measurement_unit);
  return mu !== null && str(mu.type) === 'TYPE_WEIGHT' && str(mu.weight_unit) === 'IMPERIAL_POUND';
}

/** Square's rule: present everywhere unless present_at_all_locations is false, minus the absent list. */
function presentAt(o: Json, locationId: string): boolean {
  if (locationId === '') return true;
  if (strList(o.absent_at_location_ids).includes(locationId)) return false;
  if (o.present_at_all_locations === false) return strList(o.present_at_location_ids).includes(locationId);
  return true;
}

/**
 * A location override that carries a pricing field (pricing_type or price_money) decides the
 * pricing type and price at that location, as pricing reads it (src/pricing/square-state.ts).
 */
function pricingSource(d: Json, locationId: string): Json {
  if (locationId === '' || !Array.isArray(d.location_overrides)) return d;
  const local = d.location_overrides.map(obj).find((o) => o !== null && str(o.location_id) === locationId);
  return local && (local.pricing_type !== undefined || local.price_money !== undefined) ? local : d;
}

function readVariation(v: Json, itemId: string, perPoundUnitIds: Set<string>, locationId: string): CatalogVariation | null {
  const d = obj(v.item_variation_data);
  const id = str(v.id);
  if (!d || id === '' || v.is_deleted === true) return null;
  const upc = str(d.upc).trim();
  const reading = readUpc(upc);
  const src = pricingSource(d, locationId);
  const pt = str(src.pricing_type);
  const money = obj(src.price_money);
  const unit = str(d.measurement_unit_id);
  return {
    id,
    itemId,
    name: str(d.name),
    label: '',
    upc,
    upcKey: reading.key,
    upcFromScaleCode: reading.key ? scaleCodeInUpc(reading.key) : null,
    sku: str(d.sku),
    pricing: pt === 'VARIABLE_PRICING' ? 'variable' : pt === 'FIXED_PRICING' || src !== d ? 'fixed' : 'other',
    priceCents: money && pt !== 'VARIABLE_PRICING' ? intOrNull(money.amount) : null,
    currency: money ? str(money.currency) : '',
    measurementUnitId: unit,
    perPound: unit !== '' && perPoundUnitIds.has(unit),
    availableHere: presentAt(v, locationId),
    version: intOrNull(v.version),
  };
}

function labelFor(itemName: string, v: CatalogVariation, count: number): string {
  const vn = v.name.trim();
  if (vn === '' || (count === 1 && /^regular$/i.test(vn))) return itemName.trim();
  return `${itemName.trim()}: ${vn}`;
}

function byWeightStatus(item: CatalogItem): ByWeightStatus {
  if (!item.scaleCode) return { required: false, ok: false, problems: [] };
  const problems: string[] = [];
  const many = item.variations.length > 1;
  for (const v of item.variations) {
    const who = many ? `${v.name}: ` : '';
    if (v.pricing === 'variable') problems.push(`${who}the price is taken at the register. It must be a fixed price per pound.`);
    else if (v.pricing !== 'fixed') problems.push(`${who}the pricing type is not fixed. It must be a fixed price per pound.`);
    else if (v.priceCents === null) problems.push(`${who}no price is set.`);
    if (v.measurementUnitId === '') problems.push(`${who}no per-pound unit is set.`);
    else if (!v.perPound) problems.push(`${who}the unit is not per pound.`);
  }
  if (item.variations.length === 0) problems.push('the item has no variation to price.');
  return { required: true, ok: problems.length === 0, problems };
}

/** Proof on the item itself that its trailing number is a scale code: the pound unit, or a UPC built from it. */
function ownEvidence(item: CatalogItem): string[] {
  const n = item.trailingNumber;
  if (!n) return [];
  const out: string[] = [];
  if (item.variations.some((v) => v.perPound)) out.push('it has the per-pound unit');
  if (item.variations.some((v) => v.upcFromScaleCode === n)) out.push(`its UPC is built from ${n}`);
  return out;
}

export interface CatalogInput {
  objects: unknown[];
  /** The store's Square location. Items absent there are kept but marked. */
  locationId?: string;
}

/** Builds the index. Deleted objects are skipped; archived items are kept and marked. */
export function buildCatalogIndex(input: CatalogInput): CatalogIndex {
  const locationId = input.locationId ?? '';
  const objects = input.objects.map(obj).filter((o): o is Json => o !== null && o.is_deleted !== true);

  const perPoundUnitIds = new Set<string>();
  const categoryNames = new Map<string, string>();
  const looseVariations = new Map<string, Json[]>();
  for (const o of objects) {
    const type = str(o.type);
    if (type === 'MEASUREMENT_UNIT' && isPoundUnit(o)) perPoundUnitIds.add(str(o.id));
    else if (type === 'CATEGORY') categoryNames.set(str(o.id), str(obj(o.category_data)?.name));
    else if (type === 'ITEM_VARIATION') {
      const itemId = str(obj(o.item_variation_data)?.item_id);
      if (itemId) looseVariations.set(itemId, [...(looseVariations.get(itemId) ?? []), o]);
    }
  }

  const items: CatalogItem[] = [];
  for (const o of objects) {
    if (str(o.type) !== 'ITEM') continue;
    const d = obj(o.item_data);
    const id = str(o.id);
    if (!d || id === '') continue;
    const name = str(d.name);
    const { base, trailing } = splitTrailingCode(name);
    const { maker, product } = splitMaker(base);
    const nested = Array.isArray(d.variations) ? d.variations.map(obj).filter((v): v is Json => v !== null) : [];
    const seen = new Set<string>();
    const variations: CatalogVariation[] = [];
    for (const v of [...nested, ...(looseVariations.get(id) ?? [])]) {
      const cv = readVariation(v, id, perPoundUnitIds, locationId);
      if (cv && !seen.has(cv.id)) {
        seen.add(cv.id);
        variations.push(cv);
      }
    }
    for (const v of variations) v.label = labelFor(name, v, variations.length);
    const categoryIds = [
      ...new Set([
        ...(Array.isArray(d.categories) ? d.categories.map((c) => str(obj(c)?.id)) : []),
        str(obj(d.reporting_category)?.id),
        str(d.category_id),
      ]),
    ].filter((c) => c !== '');
    items.push({
      id,
      name,
      baseName: base,
      maker,
      product,
      trailingNumber: trailing,
      scaleCode: null,
      codeEvidence: [],
      categoryIds,
      categoryNames: categoryIds.map((c) => categoryNames.get(c) ?? '').filter((c) => c !== ''),
      archived: d.is_archived === true,
      availableHere: presentAt(o, locationId),
      variations,
      byWeight: { required: false, ok: false, problems: [] },
      version: intOrNull(o.version),
    });
  }

  // Which categories are sold by weight: most of their numbered items carry proof on the item
  // itself. Items with no category teach nothing.
  const tally = new Map<string, { proof: number; all: number }>();
  for (const item of items) {
    if (!item.trailingNumber) continue;
    const proof = ownEvidence(item).length > 0;
    for (const k of item.categoryIds) {
      const t = tally.get(k) ?? { proof: 0, all: 0 };
      t.all++;
      if (proof) t.proof++;
      tally.set(k, t);
    }
  }
  const byWeightCategories = new Set<string>();
  for (const [k, t] of tally) if (t.proof > 0 && t.proof * 2 >= t.all) byWeightCategories.add(k);

  const notes: CatalogNote[] = [];
  const byScaleCode = new Map<string, CatalogItem[]>();
  for (const item of items) {
    const n = item.trailingNumber;
    if (n) {
      const own = ownEvidence(item);
      const cat = item.categoryIds.find((k) => byWeightCategories.has(k));
      const atRegister = item.variations.some((v) => v.pricing === 'variable');
      if (own.length) {
        item.scaleCode = n;
        item.codeEvidence = own;
      } else if (cat !== undefined) {
        item.scaleCode = n;
        item.codeEvidence = [`most numbered items in the ${categoryNames.get(cat) || 'same'} category are sold by weight`];
        if (atRegister) item.codeEvidence.push('its price is taken at the register, as for goods weighed at the counter');
      } else {
        item.codeEvidence = ['nothing shows this item is sold by weight, so the number is not a scale code'];
        notes.push({
          kind: 'number_not_code',
          itemIds: [item.id],
          message: `${item.name}: the name ends in ${n}, but nothing shows it is sold by weight (a year, perhaps)${atRegister ? '; a price taken at the register is not enough' : ''}. It is not treated as a scale code.`,
        });
      }
    }
    if (item.scaleCode) byScaleCode.set(item.scaleCode, [...(byScaleCode.get(item.scaleCode) ?? []), item]);
    item.byWeight = byWeightStatus(item);
    if (item.byWeight.required && !item.byWeight.ok) {
      notes.push({ kind: 'not_sold_by_weight', itemIds: [item.id], message: `${item.name}: has scale code ${item.scaleCode} but is not sold by weight: ${item.byWeight.problems.join(' ')}` });
    }
    for (const v of item.variations) {
      if (v.upcFromScaleCode && item.trailingNumber && v.upcFromScaleCode !== item.trailingNumber) {
        notes.push({ kind: 'upc_code_differs', itemIds: [item.id], message: `${v.label}: the UPC is built from ${v.upcFromScaleCode}, but the name ends in ${item.trailingNumber}.` });
      }
      if (v.upc !== '' && !v.upcKey && readUpc(v.upc).problem !== null) {
        notes.push({ kind: 'upc_invalid', itemIds: [item.id], message: `${v.label}: the UPC in Square is not a valid code, so it is not used for matching.` });
      }
    }
    if (!item.trailingNumber && item.variations.some((v) => v.perPound)) {
      const fromUpc = item.variations.map((v) => v.upcFromScaleCode).find((c) => c !== null);
      notes.push({
        kind: 'per_pound_without_code',
        itemIds: [item.id],
        message: `${item.name}: sold by the pound, but the name does not end in a scale code${fromUpc ? ` (its UPC is built from ${fromUpc})` : ''}.`,
      });
    }
  }
  for (const [code, list] of byScaleCode) {
    if (list.length > 1) notes.push({ kind: 'code_shared', itemIds: list.map((i) => i.id), message: `Scale code ${code} ends ${list.length} item names: ${list.map((i) => i.name).join('; ')}.` });
  }

  const variations = items.flatMap((i) => i.variations);
  const byUpc = new Map<string, CatalogVariation[]>();
  for (const v of variations) if (v.upcKey) byUpc.set(v.upcKey, [...(byUpc.get(v.upcKey) ?? []), v]);
  for (const [, list] of byUpc) {
    if (list.length > 1) notes.push({ kind: 'upc_shared', itemIds: [...new Set(list.map((v) => v.itemId))], message: `One UPC is on ${list.length} variations: ${list.map((v) => v.label).join('; ')}.` });
  }

  const itemById = new Map(items.map((i) => [i.id, i]));
  const docs: NameDoc[] = [];
  const wordItemCount = new Map<string, number>();
  for (const item of items) {
    const makerWords = words(item.maker);
    const productWords = words(item.product);
    const itemWords = new Set([...makerWords, ...productWords]);
    for (const v of item.variations) {
      const extra = v.label === item.name.trim() ? [] : words(v.name);
      for (const w of extra) itemWords.add(w);
      docs.push({ variation: v, item, makerWords, productWords: [...productWords, ...extra] });
    }
    for (const w of itemWords) wordItemCount.set(w, (wordItemCount.get(w) ?? 0) + 1);
  }

  return {
    locationId,
    items,
    variations,
    itemById,
    variationById: new Map(variations.map((v) => [v.id, v])),
    byUpc,
    byScaleCode,
    upcDigits: variations.map((v) => v.upc.replace(/[\s-]/g, '')).filter((u) => /^\d{6,14}$/.test(u)),
    perPoundUnitIds,
    categoryNames,
    byWeightCategories,
    docs,
    docByVariation: new Map(docs.map((d) => [d.variation.id, d])),
    wordItemCount,
    itemCount: items.length,
    notes,
  };
}

/** Whether an item is the kind sold by weight: a scale code, the per-pound unit or a price taken at the register. */
export function soldByWeightKind(item: CatalogItem): boolean {
  return item.scaleCode !== null || item.variations.some((v) => v.perPound || v.pricing === 'variable');
}

/** The item a variation belongs to. */
export function itemOf(index: CatalogIndex, v: CatalogVariation): CatalogItem {
  const item = index.itemById.get(v.itemId);
  if (!item) throw new Error('catalog index is inconsistent: a variation has no item');
  return item;
}
