// Saves a read-only copy of the live Square catalog and stock counts to
// data/square/live-catalog.json (store data, out of git, mode 600).
//
//   node scripts/square/snapshot-live.ts
//
// Reads only, through scripts/square/live-readonly.ts. Writes nothing to Square.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogPage, checkLiveToken, countsPage, listLocations } from './live-readonly.ts';

process.umask(0o077);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DIR = join(ROOT, 'data/square');
const OUT = join(DIR, 'live-catalog.json');
const TYPES = 'ITEM,CATEGORY,TAX,MEASUREMENT_UNIT,MODIFIER_LIST'; // variations come nested in each ITEM
const MAX_PAGES = 400; // a runaway cursor stops here

checkLiveToken();

const active = (await listLocations()).filter((l: any) => l.status === 'ACTIVE');
if (active.length !== 1) throw new Error(`Expected one active location, found ${active.length}. Stopping.`);
const location = { id: String(active[0].id), name: String(active[0].name), timezone: String(active[0].timezone) };

const objects: any[] = [];
let cursor = '';
let pages = 0;
do {
  if (++pages > MAX_PAGES) throw new Error('Too many catalog pages. Stopping.');
  const p = await catalogPage(TYPES, cursor);
  objects.push(...p.objects);
  cursor = p.cursor;
} while (cursor);

const variationIds: string[] = objects
  .filter((o) => o.type === 'ITEM')
  .flatMap((o) => (o.item_data?.variations ?? []).map((v: any) => String(v.id)));
const counts: any[] = [];
for (let i = 0; i < variationIds.length; i += 500) {
  let c = '';
  let n = 0;
  do {
    if (++n > MAX_PAGES) throw new Error('Too many count pages. Stopping.');
    const p = await countsPage(variationIds.slice(i, i + 500), location.id, c);
    counts.push(...p.counts);
    c = p.cursor;
  } while (c);
}

const snapshot = {
  note: 'Read-only copy of the live Square catalog. Store data: stays out of git.',
  takenAt: new Date().toISOString(),
  location,
  objects,
  counts,
};

mkdirSync(DIR, { recursive: true, mode: 0o700 });
const tmp = join(DIR, `.live-catalog.${randomBytes(8).toString('hex')}.tmp`);
const fd = openSync(tmp, 'wx', 0o600);
try {
  writeFileSync(fd, JSON.stringify(snapshot)); // retries short writes
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, OUT);
} catch (e) {
  try { closeSync(fd); } catch { /* already closed */ }
  rmSync(tmp, { force: true });
  throw e;
}

const byType = (t: string) => objects.filter((o) => o.type === t).length;
console.log(
  `Saved data/square/live-catalog.json: ${byType('ITEM')} items, ${byType('CATEGORY')} categories, ` +
    `${byType('TAX')} taxes, ${counts.length} stock counts, location ${location.name}.`,
);
