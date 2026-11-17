// Development only: one invoice run from upload to SENT, against the Square SANDBOX and the DEV
// ScaleConnect harness (three fake scales on this PC). Never the live Square account, never the
// store's ScaleConnect or scales.
//
//   scripts/dev-scaleconnect/dev-sc.sh start
//   nice -n 19 node scripts/runs/send-local.ts [--keep]
//
// What it does:
// 1. Sets up three dev items in the sandbox, named for dev harness PLUs (8203, 8704, 8740, which
//    no store item uses), and resets them to their starting state: two sold by weight, one taking
//    its price at the register with a store override (so the run switches it to sold by weight).
//    The seeded sandbox items (data/square/sandbox-ids.json) are used as they are.
// 2. A synthetic invoice: two seeded packaged items (Rustichella, Matiz), the three dev items,
//    and a seeded Widmer cheddar where nothing arrived (nothing may be sent for it).
// 3. Through the app's own routes and jobs, with the app's own Square writer and ScaleConnect
//    connection (and their guards): read, review, dry run, approve, Send. KITCHEN is unplugged
//    first, so the run ends partial; then KITCHEN is plugged back, a person confirms it was looked
//    at, and the resend finishes it. Then a correction (one line did not arrive after all).
// 4. Reads the sandbox and the harness back and prints what they hold.
//
// The invoice reading is a stand-in that answers with the synthetic invoice: no model call, no
// cost. The Square sandbox token is read from ~/.config/shelfready/dev.env by key name and never
// printed. Everything else lives in a temporary folder (mode 700), deleted at the end. With --keep
// the database stays for a look, and its master key is deleted, so the token in it is unreadable.

import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUser } from '../../src/auth/users.ts';
import { SYSTEM_ACTOR } from '../../src/db/audit.ts';
import { buildApp } from '../../src/server/app.ts';
import { makeConfig } from '../../src/server/config.ts';
import { connectScaleConnect } from '../../src/scaleconnect/connection.ts';
import { DEV_MCP_URL, readDevConnection } from '../../src/scaleconnect/dev-connection.ts';
import { fakeClient, image, invoice, line, testImage } from '../../test/invoice-fixtures.ts';
import { checkDigitFor } from '../../src/matching/upc.ts';
import { SANDBOX, SQUARE_VERSION, sandboxFetch, sandboxSettings } from '../square/sandbox-env.ts';

process.umask(0o077);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const DEV_SC = join(repo, 'scripts/dev-scaleconnect/dev-sc.sh');
type J = Record<string, any>;

const { token, locationId } = sandboxSettings();
const sq = (method: 'GET' | 'POST', path: string, body?: unknown) => sandboxFetch(token, method, path, body);
const conn = await readDevConnection();
if (!conn || conn.url !== DEV_MCP_URL) throw new Error('The dev ScaleConnect harness is not running. Start it: scripts/dev-scaleconnect/dev-sc.sh start');
const harness = (...args: string[]) => execFileSync(DEV_SC, args, { stdio: 'ignore', timeout: 60_000 });
const cents = (p: string): number => {
  const [w, f = '00'] = p.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
};
const dollars = (c: number | null | undefined): string => (typeof c === 'number' ? `$${(c / 100).toFixed(2)}` : 'none');

// ---- 1. The sandbox: the per-pound unit, the seeded items, the dev items
const all: J[] = [];
for (let cursor = ''; ; ) {
  const q = new URLSearchParams({ types: 'ITEM,MEASUREMENT_UNIT' });
  if (cursor) q.set('cursor', cursor);
  const r = await sq('GET', `/v2/catalog/list?${q}`);
  all.push(...(r.objects ?? []));
  if (!r.cursor) break;
  cursor = r.cursor;
}
const pounds = all.filter((o) => o.type === 'MEASUREMENT_UNIT' && o.measurement_unit_data?.measurement_unit?.weight_unit === 'IMPERIAL_POUND');
if (pounds.length !== 1) throw new Error(`The sandbox has ${pounds.length} per-pound units; expected exactly one.`);
const POUND = pounds[0]!.id as string;
const ids = JSON.parse(readFileSync(join(repo, 'data/square/sandbox-ids.json'), 'utf8')) as { items: Record<string, { name: string; item: string; variation: string }> };
const seeded = (name: string) => {
  const it = Object.values(ids.items).find((x) => x.name === name);
  if (!it) throw new Error(`The sandbox seed has no item named ${name}.`);
  const obj = all.find((o) => o.id === it.item);
  if (!obj) throw new Error(`${name} is not in the sandbox. Run scripts/square/seed-sandbox.ts.`);
  return { ...it, obj, v: obj.item_data.variations[0] as J };
};

const DEV = [
  { plu: '8203', name: 'ShelfReady Dev Salami 8203', variable: false },
  { plu: '8704', name: 'ShelfReady Dev Comte 8704', variable: false },
  { plu: '8740', name: 'ShelfReady Dev Stilton 8740', variable: true },
];
const scaleApi = () => connectScaleConnect({ url: conn.url, token: conn.token, allowLive: false, clientName: 'shelfready-send-local' });
const sc = await scaleApi();
const harnessCents: Record<string, number> = {};
for (const d of DEV) harnessCents[d.plu] = cents(String(((await sc.getItem({ plu: d.plu })).data.item as J).price));
await sc.close();

/** A dollar up or down from a price, by the parity of its dollars, so repeated runs go back and forth. */
const nextWhole = (priceCents: number): number => {
  const whole = Math.floor(priceCents / 100);
  return whole % 2 === 0 || whole < 4 ? whole + 1 : whole - 1;
};
// The new price for each dev item: a dollar from the harness's price, so the scales really change.
const target: Record<string, number> = {};
for (const d of DEV) target[d.plu] = nextWhole(harnessCents[d.plu]!) * 100 + 99;
// Each dev item is found by its code (an earlier run may have renamed it). Extra copies, which an
// earlier version of this script could leave, are removed: they are this script's own dev items.
const devFound = DEV.map((d) => all.filter((o) => o.type === 'ITEM' && !o.is_deleted && String(o.item_data?.name ?? '').startsWith('ShelfReady Dev ') && String(o.item_data?.name).endsWith(` ${d.plu}`)));
for (const extra of devFound.flatMap((list) => list.slice(1))) {
  const res = await fetch(new URL(`/v2/catalog/object/${extra.id}`, SANDBOX), { method: 'DELETE', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION } });
  if (!res.ok) throw new Error(`Could not remove an extra dev item from the sandbox (HTTP ${res.status}).`);
}
const devObjects = DEV.map((d, i) => {
  const have = devFound[i]![0];
  const startCents = target[d.plu]! - 100;
  const variation: J = {
    type: 'ITEM_VARIATION',
    id: have ? have.item_data.variations[0].id : `#v${d.plu}`,
    ...(have ? { version: have.item_data.variations[0].version } : {}),
    present_at_all_locations: true,
    item_variation_data: {
      ...(have ? { item_id: have.id } : {}),
      name: 'Regular',
      track_inventory: true,
      sellable: true,
      stockable: true,
      ...(d.variable
        ? // A UPC built from the code, as many store items carry: it shows the item is weighed.
          { upc: `0000000${d.plu}${checkDigitFor(`0000000${d.plu}`)}`, pricing_type: 'VARIABLE_PRICING', location_overrides: [{ location_id: locationId, pricing_type: 'VARIABLE_PRICING', track_inventory: true }] }
        : { pricing_type: 'FIXED_PRICING', price_money: { amount: startCents, currency: 'USD' }, measurement_unit_id: POUND }),
    },
  };
  return {
    type: 'ITEM',
    id: have ? have.id : `#i${d.plu}`,
    ...(have ? { version: have.version } : {}),
    present_at_all_locations: true,
    item_data: { name: d.name, product_type: 'FOOD_AND_BEV', variations: [variation] },
  };
});
// Setup only, not part of what is tested: create or reset the dev items as one sandbox write.
const setup = await sq('POST', '/v2/catalog/batch-upsert', { idempotency_key: randomUUID(), batches: [{ objects: devObjects }] });
const devIds = DEV.map((d, i) => {
  const o = (setup.objects as J[]).find((x) => x.item_data?.name === d.name)!;
  return { ...d, item: o.id as string, variation: o.item_data.variations[0].id as string, startCents: target[d.plu]! - 100, i };
});
console.log(`Sandbox location ${locationId}. Dev items ready: ${devIds.map((d) => `${d.name} (${d.variable ? 'price at the register' : dollars(d.startCents) + '/lb'})`).join('; ')}.`);

// ---- 2. The synthetic invoice
const pasta = seeded('Rustichella - Bucatini');
const tuna = seeded('Matiz - Mackerel');
const cheddar = seeded('Widmer 2 Year Cheddar 7024');
// 2 x cost + 1 lands at whole + 0.50, which rounds up to whole.99.
const unitCost = (priceCents: number) => ((nextWhole(priceCents) - 1) / 2 + 0.25).toFixed(2);
const packLine = (n: string, s: ReturnType<typeof seeded>) => {
  const c = unitCost(s.v.item_variation_data.price_money?.amount ?? 599);
  const casePrice = (Number(c) * 12).toFixed(2);
  return line({ item_number: n, upc: s.v.item_variation_data.upc, description: s.name.toUpperCase(), pack_size: '12/500G', unit: 'CS', qty_shipped: '1', unit_price: casePrice, extension: casePrice });
};
const weightLine = (n: string, desc: string, lb: string, cost: string) => line({ item_number: n, description: desc, unit: 'LB', qty_shipped: '1', weight: lb, unit_price: cost, extension: (Number(cost) * Number(lb)).toFixed(2) });
// 2 x cost + 1 lands at whole + 0.50, which rounds up to whole.99.
const costFor = (plu: string) => ((Math.floor(target[plu]! / 100) - 1) / 2 + 0.25).toFixed(2);
const lines = [
  packLine('L1', pasta),
  packLine('L2', tuna),
  weightLine('L3', 'DEV SALAMI', '4.25', costFor('8203')),
  weightLine('L4', 'DEV COMTE', '6.5', costFor('8704')),
  weightLine('L5', 'DEV STILTON', '3.75', costFor('8740')),
  weightLine('L6', 'WIDMER 2 YEAR CHEDDAR', '5', '6.10'),
];
const total = lines.reduce((a, l) => a + Number(l.extension), 0).toFixed(2);
const inv = invoice({ supplier_name: 'ShelfReady Dev Supplier', images: [image()], lines, total });

// ---- 3. The app, with the sandbox and the dev harness in its own settings
const dir = mkdtempSync(join(tmpdir(), 'shelfready-send-'));
const config = makeConfig({ dbPath: join(dir, 'data', 'shelfready.sqlite3'), masterKeyPath: join(dir, 'keys', 'master.key'), scaleNames: ['FRONT', 'KITCHEN', 'COUNTER'], writeScales: ['FRONT', 'KITCHEN', 'COUNTER'], logLevel: 'silent' });
// The three scales are the dev harness's fakes, so all three may get writes here (CLAUDE.md rule 3
// is about the store's real scales; the app's default is FRONT only).
const model = fakeClient({ 'claude-sonnet-5-5': [{ json: inv }], 'claude-opus-5-5': [{ json: inv }] });
const app = await buildApp(config, { modelClient: model, startRunner: false, cardCopy: async () => ({ status: 'skipped', message: 'Card copy is skipped in the local send test.' }) });
let ok = false;
try {
  app.shelf.settings.update(
    { values: { squareEnvironment: 'sandbox', squareLocationId: locationId, scaleConnectUrl: DEV_MCP_URL }, secrets: { squareAccessToken: token, scaleConnectToken: conn.token } },
    SYSTEM_ACTOR,
  );
  const password = randomBytes(18).toString('base64url');
  await createUser(app.shelf.db, { username: 'local', role: 'manager', password, mustChangePassword: false }, { scrypt: config.scrypt, minLength: 12, actor: SYSTEM_ACTOR });
  const origin = config.publicOrigins[0]!;
  const loginPage = await app.inject({ method: 'GET', url: '/login' });
  const loginCookie = loginPage.cookies.find((c) => c.name === 'sr_login')!.value;
  const loginCsrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!;
  const signedIn = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin, cookie: `sr_login=${loginCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ _csrf: loginCsrf, username: 'local', password }).toString(),
  });
  const cookie = `sr_session=${signedIn.cookies.find((c) => c.name === 'sr_session')!.value}`;
  const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).body)![1]!;
  const post = async (url: string, fields: Record<string, string> = {}) => {
    const r = await app.inject({ method: 'POST', url, headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ _csrf: csrf, ...fields }).toString() });
    if (r.statusCode !== 303) throw new Error(`${url} refused (HTTP ${r.statusCode}): ${/<p class="error"[^>]*>([^<]*)/.exec(r.body)?.[1] ?? ''}`);
    await app.shelf.runner.drain();
    return r;
  };
  const page = async (url: string) => (await app.inject({ method: 'GET', url, headers: { cookie } })).body;
  const run = () => app.shelf.db.prepare('SELECT state, message, dry_run_hash FROM runs WHERE id = 1').get() as { state: string; message: string; dry_run_hash: string };
  const send = () => app.shelf.db.prepare('SELECT phase, message FROM run_sends WHERE run_id = 1').get() as { phase: string; message: string };
  const step = () => {
    const r = app.shelf.db.prepare("SELECT id, state, preview FROM scale_steps WHERE run_id = 1 AND kind = 'push' ORDER BY id DESC LIMIT 1").get() as { id: number; state: string; preview: string };
    return { id: r.id, state: r.state, p: JSON.parse(r.preview) as J };
  };

  const boundary = '----shelfreadysend';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="page1.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    await testImage(7),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({ method: 'POST', url: '/runs', headers: { cookie, origin, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  if (up.statusCode !== 303) throw new Error(`Upload refused (HTTP ${up.statusCode}).`);
  await app.shelf.runner.drain();
  await post('/runs/1/supplier', { create: '1' });
  for (const [n, v] of [['3', devIds[0]!.variation], ['4', devIds[1]!.variation], ['5', devIds[2]!.variation], ['6', cheddar.variation]] as const) await post(`/runs/1/lines/${n}/pick`, { variationId: v });
  await post('/runs/1/lines/6/arrived', { arrived: 'none' });
  // A new store name for one dev item: the rename goes first, as the whole item with its variation.
  await post('/runs/1/rename', { itemId: devIds[1]!.item, name: 'ShelfReady Dev Comte Aged' });
  for (const v of [pasta.variation, tuna.variation, ...devIds.map((d) => d.variation)]) await post('/runs/1/cards/leave-out', { variationId: v, leaveOut: '1' });
  if (run().state !== 'ready') {
    const ev = JSON.parse((app.shelf.db.prepare('SELECT evaluation FROM runs WHERE id = 1').get() as { evaluation: string }).evaluation) as J;
    throw new Error(`The run still needs a person: ${(ev.blockers as J[]).map((b) => b.message).join(' | ')}`);
  }
  await post('/runs/1/dry-run');
  await post('/runs/1/approve', { hash: run().dry_run_hash });
  console.log(`Run 1 approved. ${run().message}`);

  // KITCHEN stops answering before the send.
  harness('plug', 'KITCHEN');
  harness('unplug', 'KITCHEN');
  try {
    await post('/runs/1/send/start', { hash: run().dry_run_hash, scale_FRONT: '1', scale_KITCHEN: '1', scale_COUNTER: '1' });
    console.log(`After Send: ${send().phase}. ${send().message}`);
    if (send().phase !== 'scale_preview') throw new Error('Square did not finish; see above.');
    let st = step();
    console.log(`Scale preview 1: ${st.state}. ${st.p.blockedWhy}`);
    if (st.state === 'blocked') {
      await post('/runs/1/send/scale-preview');
      st = step();
      console.log(`Scale preview 2: ${st.state}. Left out: ${(st.p.leftOut as string[]).join(', ') || 'none'}. Warnings: ${(st.p.warnings as J[]).map((w) => w.code).join(', ') || 'none'}. Drift: ${(st.p.driftTokens as string[]).length}.`);
    }
    const fields: Record<string, string> = { stepId: String(st.id) };
    if (st.p.mustAcknowledge) fields.ack = st.p.digest;
    (st.p.driftTokens as string[]).forEach((t, i) => (fields[`drift_${i}`] = t));
    await post('/runs/1/send/scales', fields);
    console.log(`After the scales: run ${run().state}, ${send().phase}. ${send().message}`);
  } finally {
    harness('plug', 'KITCHEN');
  }
  const pend = () => app.shelf.db.prepare("SELECT scale, code, reason, price_cents FROM scale_pending WHERE run_id = 1 AND state = 'pending'").all() as Array<{ scale: string; code: string; reason: string; price_cents: number }>;
  console.log(`Pending: ${pend().map((p) => `${p.scale} code ${p.code} ${dollars(p.price_cents)}/lb (${p.reason})`).join('; ') || 'none'}.`);
  for (const scale of [...new Set(pend().map((p) => p.scale))]) {
    await post('/runs/1/send/resend/look', { scale, looked: '1' });
    // The person ticks the yes box and each drift box the page shows.
    const html = await page('/runs/1/send');
    const form = (html.split('action="/runs/1/send/resend/accept"').slice(1).find((f) => f.includes(`name="scale" value="${scale}"`)) ?? '').split('</form>')[0] ?? '';
    const digest = /name="digest" value="([0-9a-f]{32})"/.exec(form)?.[1];
    if (!digest) throw new Error(`No settle for ${scale} to say yes to.`);
    const fields: Record<string, string> = { scale, digest };
    for (const m of form.matchAll(/name="(drift_[0-9]+)" value="([^"]+)"/g)) fields[m[1]!] = m[2]!;
    await post('/runs/1/send/resend/accept', fields);
    console.log(`Resend to ${scale}: run ${run().state}. ${send().message}`);
  }

  // A correction: the Matiz line did not arrive after all.
  await app.inject({ method: 'POST', url: '/runs/1/lines/2/not-arrived', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ _csrf: csrf, confirm: '1' }).toString() });
  await post('/runs/1/send/corrections');

  // ---- 4. Read back
  const writes = app.shelf.db.prepare('SELECT step, state, attempts, object_ids FROM square_writes WHERE run_id = 1 ORDER BY id').all() as Array<{ step: string; state: string; attempts: number; object_ids: string }>;
  console.log(`Square writes: ${writes.map((w) => `${w.step} (${JSON.parse(w.object_ids).length}) ${w.state}`).join(', ')}.`);
  const watched = [pasta, tuna, cheddar].map((s) => ({ name: s.name, item: s.item, variation: s.variation })).concat(devIds.map((d) => ({ name: d.name, item: d.item, variation: d.variation })));
  const back = await sq('POST', '/v2/catalog/batch-retrieve', { object_ids: watched.map((w) => w.item) });
  const counts = await sq('POST', '/v2/inventory/counts/batch-retrieve', { catalog_object_ids: watched.map((w) => w.variation), location_ids: [locationId] });
  console.log('Sandbox read back:');
  for (const w of watched) {
    const it = (back.objects as J[]).find((o) => o.id === w.item)!;
    const d = it.item_data.variations[0].item_variation_data as J;
    const local = (d.location_overrides as J[] | undefined)?.find((o) => o.location_id === locationId);
    const count = (counts.counts as J[] | undefined)?.find((c) => c.catalog_object_id === w.variation && c.state === 'IN_STOCK')?.quantity ?? 'none';
    console.log(`  ${it.item_data.name}: ${d.pricing_type === 'FIXED_PRICING' ? dollars(d.price_money?.amount) : 'price at the register'}${d.measurement_unit_id === POUND ? ' per lb' : ''}${local ? `; store override ${local.pricing_type ?? ''} ${local.price_money ? dollars(local.price_money.amount) : ''} tracking ${local.track_inventory}` : ''}; tracking ${d.track_inventory}; in stock ${count}`);
  }
  const sc2 = await scaleApi();
  try {
    for (const d of DEV) console.log(`  Dev scale catalog ${d.plu}: ${String(((await sc2.getItem({ plu: d.plu })).data.item as J).price)} (wanted ${dollars(target[d.plu])})`);
    const unf = (((await sc2.listScales()).data.unfinished as J[]) ?? []).filter((u) => DEV.some((d) => d.plu === u.plu));
    console.log(`  Unfinished on the fake scales for these codes: ${unf.length ? unf.map((u) => `${u.scale} ${u.plu}`).join(', ') : 'none'}.`);
  } finally {
    await sc2.close();
  }
  console.log(`Final: run ${run().state}, send ${send().phase}.`);
  ok = run().state === 'done';
} finally {
  await app.close();
  if (process.argv.includes('--keep')) {
    // The database keeps the sandbox token, encrypted. Its key is removed, so what is kept cannot
    // be read back into a token.
    unlinkSync(join(dir, 'keys', 'master.key'));
    console.log(`Kept the database (its key removed, so its settings cannot be read): ${dir}`);
  }
  else rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
