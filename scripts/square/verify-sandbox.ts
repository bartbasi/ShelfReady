// Reads every seeded item back from the Square SANDBOX and compares it with
// data/square/live-snapshot.json: name, price, UPC, per-pound unit, taxes,
// category, tracking and count. Exits 1 on any difference.
//
//   node scripts/square/verify-sandbox.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandboxFetch, sandboxSettings } from './sandbox-env.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const { token } = sandboxSettings();

const post = (path: string, body: unknown) => sandboxFetch(token, 'POST', path, body);

const snap = JSON.parse(readFileSync(join(ROOT, 'data/square/live-snapshot.json'), 'utf8'));
const ids = JSON.parse(readFileSync(join(ROOT, 'data/square/sandbox-ids.json'), 'utf8'));

const unseeded = snap.items.filter((it: any) => !ids.items[it.liveId]);
if (unseeded.length) {
  for (const it of unseeded) console.log(`FAIL ${it.name}  (not seeded yet: run scripts/square/seed-sandbox.ts)`);
  process.exit(1);
}
const itemIds: string[] = snap.items.map((it: any) => ids.items[it.liveId].item);
const got = new Map<string, any>();
for (let i = 0; i < itemIds.length; i += 100) {
  const r = await post('/v2/catalog/batch-retrieve', { object_ids: itemIds.slice(i, i + 100) });
  for (const o of r.objects ?? []) got.set(o.id, o);
}
const varIds: string[] = snap.items.map((it: any) => ids.items[it.liveId].variation);
const counts = new Map<string, string>();
const r = await post('/v2/inventory/counts/batch-retrieve', { catalog_object_ids: varIds, location_ids: [ids.locationId] });
for (const c of r.counts ?? []) if (c.state === 'IN_STOCK') counts.set(c.catalog_object_id, c.quantity);

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
let bad = 0;
for (const it of snap.items) {
  const want = ids.items[it.liveId];
  const o = got.get(want.item);
  const problems: string[] = [];
  if (!o) problems.push('missing');
  else {
    const d = o.item_data;
    const v = d.variations?.[0]?.item_variation_data ?? {};
    if (d.name !== it.name) problems.push(`name ${d.name}`);
    if ((v.price_money?.amount ?? null) !== it.price) problems.push(`price ${v.price_money?.amount}`);
    if (v.pricing_type !== (it.price === null ? 'VARIABLE_PRICING' : 'FIXED_PRICING')) problems.push(`pricing ${v.pricing_type}`);
    if ((v.upc ?? null) !== it.upc) problems.push(`upc ${v.upc}`);
    if ((v.measurement_unit_id ?? null) !== (it.unit ? ids.units[it.unit] : null)) problems.push('unit');
    if (!sameSet(d.tax_ids ?? [], it.taxes.map((t: string) => ids.taxes[t]))) problems.push('taxes');
    const cat = d.categories?.[0]?.id ?? null;
    if (cat !== (it.category ? ids.categories[it.category] : null)) problems.push('category');
    if (Boolean(v.track_inventory) !== it.track) problems.push('tracking');
    if (it.track && !counts.has(want.variation)) problems.push('no count');
  }
  if (problems.length) bad++;
  const count = counts.get(want.variation);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${it.name}${count !== undefined ? `  count ${count}` : ''}${problems.length ? `  (${problems.join(', ')})` : ''}`);
}
console.log(bad ? `${bad} of ${snap.items.length} items differ.` : `All ${snap.items.length} items read back as seeded.`);
process.exit(bad ? 1 : 0);
