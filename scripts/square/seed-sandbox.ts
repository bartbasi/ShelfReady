// Copies the items in data/square/live-snapshot.json into the Square SANDBOX.
//
//   node scripts/square/seed-sandbox.ts --dry-run   show what would be created
//   node scripts/square/seed-sandbox.ts             create what is missing
//   node scripts/square/seed-sandbox.ts --reset-counts   also reset every seeded count
//
// Safe to run again: taxes, categories, the pound unit and items that already
// exist in the sandbox (matched by name) are reused, not duplicated. Counts are
// set only for items created in this run, unless --reset-counts is given.
//
// Only ever talks to connect.squareupsandbox.com. The token is read from
// ~/.config/shelfready/dev.env by key name and never printed.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxFetch, sandboxSettings } from './sandbox-env.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SNAPSHOT = join(ROOT, 'data/square/live-snapshot.json');
const IDS_OUT = join(ROOT, 'data/square/sandbox-ids.json');

/** Seed counts: by-weight items in pounds, packaged items in units. */
const SEED_POUNDS = '4.5';
const SEED_UNITS = '6';

interface Snapshot {
  taxes: Array<{ liveId: string; name: string; percentage: string; appliesToCustomAmounts: boolean }>;
  units: Array<{ liveId: string; weightUnit: string; precision: number }>;
  categories: Array<{ liveId: string; name: string }>;
  items: Array<{
    liveId: string;
    name: string;
    category: string | null;
    taxes: string[];
    upc: string | null;
    /** Cents per unit or per pound. null: price taken at the register (variable pricing). */
    price: number | null;
    unit: string | null;
    track: boolean;
    soldOut: boolean;
  }>;
}

interface CatalogObject {
  type: string;
  id: string;
  item_data?: { name?: string; variations?: CatalogObject[] };
  tax_data?: { name?: string };
  category_data?: { name?: string };
  measurement_unit_data?: { measurement_unit?: { weight_unit?: string } };
}

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const RESET = args.has('--reset-counts');
for (const a of args) {
  if (!['--dry-run', '--reset-counts'].includes(a)) throw new Error(`Unknown option ${a}`);
}


const { token, locationId } = sandboxSettings();

const square = (method: 'GET' | 'POST', path: string, body?: unknown) => sandboxFetch(token, method, path, body);

async function listAll(types: string): Promise<CatalogObject[]> {
  const out: CatalogObject[] = [];
  let cursor = '';
  do {
    const q = new URLSearchParams({ types });
    if (cursor) q.set('cursor', cursor);
    const r = await square('GET', `/v2/catalog/list?${q}`);
    out.push(...(r.objects ?? []));
    cursor = r.cursor ?? '';
  } while (cursor);
  return out;
}

const snap: Snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));

// What the sandbox already holds.
const existing = await listAll('TAX,CATEGORY,MEASUREMENT_UNIT,ITEM');
const byName = (type: string, name: (o: CatalogObject) => string | undefined) =>
  new Map(existing.filter((o) => o.type === type).map((o) => [name(o) ?? '', o]));
const haveTax = byName('TAX', (o) => o.tax_data?.name);
const haveCat = byName('CATEGORY', (o) => o.category_data?.name);
const haveItem = byName('ITEM', (o) => o.item_data?.name);
{
  const wanted = new Set(snap.items.map((it) => it.name));
  const seen = new Set<string>();
  for (const o of existing) {
    const n = o.type === 'ITEM' ? o.item_data?.name ?? '' : '';
    if (!wanted.has(n)) continue;
    if (seen.has(n)) throw new Error(`The sandbox has two items named "${n}". Remove one, then run again.`);
    seen.add(n);
  }
}
const haveUnit = byName('MEASUREMENT_UNIT', (o) => o.measurement_unit_data?.measurement_unit?.weight_unit);

// liveId -> sandbox id (or a #temp id for objects created in this run)
const ref = new Map<string, string>();
const objects: unknown[] = [];

for (const t of snap.taxes) {
  const have = haveTax.get(t.name);
  if (have) { ref.set(t.liveId, have.id); continue; }
  const id = `#tax-${t.liveId}`;
  ref.set(t.liveId, id);
  objects.push({
    type: 'TAX', id, present_at_all_locations: true,
    tax_data: {
      name: t.name, calculation_phase: 'TAX_SUBTOTAL_PHASE', inclusion_type: 'ADDITIVE',
      percentage: t.percentage, applies_to_custom_amounts: t.appliesToCustomAmounts, enabled: true,
    },
  });
}
for (const u of snap.units) {
  const have = haveUnit.get(u.weightUnit);
  if (have) { ref.set(u.liveId, have.id); continue; }
  const id = `#unit-${u.liveId}`;
  ref.set(u.liveId, id);
  objects.push({
    type: 'MEASUREMENT_UNIT', id, present_at_all_locations: true,
    measurement_unit_data: { measurement_unit: { weight_unit: u.weightUnit, type: 'TYPE_WEIGHT' }, precision: u.precision },
  });
}
for (const c of snap.categories) {
  const have = haveCat.get(c.name);
  if (have) { ref.set(c.liveId, have.id); continue; }
  const id = `#cat-${c.liveId}`;
  ref.set(c.liveId, id);
  objects.push({ type: 'CATEGORY', id, present_at_all_locations: true, category_data: { name: c.name } });
}

const created: Snapshot['items'] = [];
const reused: Snapshot['items'] = [];
const need = (liveId: string): string => {
  const id = ref.get(liveId);
  if (!id) throw new Error(`Snapshot refers to ${liveId}, which it does not define`);
  return id;
};
for (const it of snap.items) {
  const have = haveItem.get(it.name);
  if (have) {
    reused.push(it);
    ref.set(it.liveId, have.id);
    const vs = have.item_data?.variations ?? [];
    if (vs.length !== 1) throw new Error(`Sandbox item "${it.name}" has ${vs.length} variations, expected 1. Fix it in the sandbox, then run again.`);
    ref.set(`var:${it.liveId}`, vs[0].id);
    continue;
  }
  created.push(it);
  const itemId = `#item-${it.liveId}`;
  ref.set(it.liveId, itemId);
  ref.set(`var:${it.liveId}`, `#var-${it.liveId}`);
  const variation: Record<string, unknown> = {
    name: 'Regular',
    pricing_type: it.price === null ? 'VARIABLE_PRICING' : 'FIXED_PRICING',
    track_inventory: it.track,
    sellable: true,
    stockable: true,
  };
  if (it.price !== null) variation.price_money = { amount: it.price, currency: 'USD' };
  if (it.upc) variation.upc = it.upc;
  if (it.unit) variation.measurement_unit_id = need(it.unit);
  const itemData: Record<string, unknown> = {
    name: it.name,
    is_taxable: true,
    tax_ids: it.taxes.map(need),
    product_type: 'FOOD_AND_BEV',
    skip_modifier_screen: true,
    variations: [{ type: 'ITEM_VARIATION', id: `#var-${it.liveId}`, present_at_all_locations: true, item_variation_data: variation }],
  };
  if (it.category) {
    itemData.categories = [{ id: need(it.category) }];
    itemData.reporting_category = { id: need(it.category) };
  }
  objects.push({ type: 'ITEM', id: itemId, present_at_all_locations: true, item_data: itemData });
}

const countFor = (it: Snapshot['items'][number]): string => (it.soldOut ? '0' : it.unit ? SEED_POUNDS : SEED_UNITS);
// Reused items that have no count yet (an earlier run stopped after the
// catalog write) are counted too, so a plain rerun finishes the job.
let uncounted: Snapshot['items'] = [];
if (!RESET && reused.length) {
  const tracked = reused.filter((it) => it.track);
  const have = new Set<string>();
  for (let i = 0; i < tracked.length; i += 100) {
    const r = await square('POST', '/v2/inventory/counts/batch-retrieve', {
      catalog_object_ids: tracked.slice(i, i + 100).map((it) => need(`var:${it.liveId}`)),
      location_ids: [locationId],
    });
    for (const c of r.counts ?? []) if (c.state === 'IN_STOCK') have.add(c.catalog_object_id);
  }
  uncounted = tracked.filter((it) => !have.has(need(`var:${it.liveId}`)));
}
const toCount = (RESET ? [...created, ...reused] : [...created, ...uncounted]).filter((it) => it.track);

console.log(`Sandbox location ${locationId}. ${DRY ? 'DRY RUN: nothing will be written.' : ''}`);
console.log(`Catalog objects to create: ${objects.length} (${created.length} items; ${reused.length} items already there).`);
const priceText = (it: Snapshot['items'][number]): string =>
  it.price === null ? 'price at register' : `$${(it.price / 100).toFixed(2)}${it.unit ? ' per lb' : ''}`;
for (const it of created) console.log(`  + ${it.name}  ${priceText(it)}${it.upc ? `  UPC ${it.upc}` : ''}`);
console.log(`Counts to set: ${toCount.length}.`);
if (DRY) process.exit(0);

if (objects.length) {
  const r = await square('POST', '/v2/catalog/batch-upsert', { idempotency_key: randomUUID(), batches: [{ objects }] });
  const map = new Map<string, string>((r.id_mappings ?? []).map((m: any) => [m.client_object_id, m.object_id]));
  for (const [k, v] of ref) if (v.startsWith('#')) {
    const real = map.get(v);
    if (!real) throw new Error(`Square did not return an id for ${v}`);
    ref.set(k, real);
  }
}

// Write the id map before counts, so a failure below still leaves it on disk.
const ids = {
  note: 'Live Square id -> sandbox id, written by scripts/square/seed-sandbox.ts. Store data: stays out of git.',
  locationId,
  taxes: Object.fromEntries(snap.taxes.map((t) => [t.liveId, need(t.liveId)])),
  units: Object.fromEntries(snap.units.map((u) => [u.liveId, need(u.liveId)])),
  categories: Object.fromEntries(snap.categories.map((c) => [c.liveId, need(c.liveId)])),
  items: Object.fromEntries(snap.items.map((it) => [it.liveId, { name: it.name, item: need(it.liveId), variation: need(`var:${it.liveId}`) }])),
};
mkdirSync(join(ROOT, 'data/square'), { recursive: true });
writeFileSync(IDS_OUT, JSON.stringify(ids, null, 2) + '\n');

const occurredAt = new Date(Date.now() - 5_000).toISOString();
for (let i = 0; i < toCount.length; i += 25) {
  const changes = toCount.slice(i, i + 25).map((it) => ({
    type: 'PHYSICAL_COUNT',
    physical_count: {
      catalog_object_id: need(`var:${it.liveId}`),
      state: 'IN_STOCK',
      location_id: locationId,
      quantity: countFor(it),
      occurred_at: occurredAt,
    },
  }));
  await square('POST', '/v2/inventory/changes/batch-create', { idempotency_key: randomUUID(), changes, ignore_unchanged_counts: false });
}

console.log(`Done. Created ${objects.length} catalog objects, set ${toCount.length} counts. Ids in data/square/sandbox-ids.json.`);
