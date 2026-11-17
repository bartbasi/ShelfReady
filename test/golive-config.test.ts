// Going live (docs/GO-LIVE.md): the switches, the live ScaleConnect address and scales, the words
// pages use for each Square, and the settings page. Fakes only. Nothing here reaches Square, a
// ScaleConnect or a scale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { makeConfig } from '../src/server/config.ts';
import { checkSetting } from '../src/settings/schema.ts';
import { catalogSourceLabel, effectiveEnvironment, envForSource, mixedEnvironmentProblem, sourceForEnv } from '../src/square/origins.ts';
import { createSquareReader } from '../src/square/client.ts';
import { catalogLabelFor, squareCatalogSource } from '../src/square/catalog-source.ts';
import { defaultSettings, type SettingValues } from '../src/settings/schema.ts';
import { connectScaleConnect, scalePreflightProblem } from '../src/scaleconnect/connection.ts';
import { liveListenerProblem } from '../src/scaleconnect/live-address.ts';
import { ScaleConnectError } from '../src/scaleconnect/client.ts';
import { ADMIN_PW, addUser, get, login, makeApp, post } from './server-helpers.ts';

const LIVE_URL = 'http://10.0.0.20:8765/mcp';
const ALL = ['FRONT', 'KITCHEN', 'COUNTER'];
const LIVE = { allowSquareProduction: true, allowLiveScaleConnect: true, liveScaleConnectUrl: LIVE_URL, scaleNames: ALL, writeScales: ALL };

test('config: live Square needs live scales writing to every scale, so rule 12 can hold', () => {
  // Off by default, both.
  const d = makeConfig({});
  assert.equal(d.allowSquareProduction, false);
  assert.equal(d.allowLiveScaleConnect, false);
  assert.equal(d.liveScaleConnectUrl, '');
  // The going-live config is accepted, with the address written the one way.
  const c = makeConfig(LIVE);
  assert.equal(c.liveScaleConnectUrl, LIVE_URL);
  assert.deepEqual(c.writeScales, ALL);
  // Live Square without live scales, or with only some scales: refused.
  assert.throws(() => makeConfig({ allowSquareProduction: true, scaleNames: ALL }), /needs the live scales too/);
  assert.throws(() => makeConfig({ ...LIVE, writeScales: ['FRONT'] }), /writeScales to name every scale in scaleNames/);
  assert.throws(() => makeConfig({ ...LIVE, writeScales: ['FRONT', 'KITCHEN'] }), /every scale/);
  // Development and sandbox test settings cannot stay on with live Square.
  assert.throws(() => makeConfig({ ...LIVE, devCatalogFile: 'data/square/live-catalog.json' }), /devCatalogFile is for development only/);
  assert.throws(() => makeConfig({ ...LIVE, mailchimpFromSandboxRuns: true }), /mailchimpFromSandboxRuns is a sandbox test setting/);
  // The step 10 FRONT test (sandbox Square, live FRONT only) still works.
  const front = makeConfig({ allowLiveScaleConnect: true, liveScaleConnectUrl: LIVE_URL, scaleNames: ALL, writeScales: ['FRONT'] });
  assert.deepEqual(front.writeScales, ['FRONT']);
  // A store with no scales at all may use live Square alone.
  assert.equal(makeConfig({ allowSquareProduction: true }).allowSquareProduction, true);
});

test('config: the live ScaleConnect address is pinned, plain http to a store address with its port and /mcp', () => {
  assert.throws(() => makeConfig({ allowLiveScaleConnect: true, scaleNames: ALL, writeScales: ALL }), /needs liveScaleConnectUrl/);
  for (const [bad, why] of [
    ['https://10.0.0.20:8765/mcp', /must start with http:\/\//],
    ['http://scales.example.com:8765/mcp', /IPv4 address/],
    ['http://203.0.113.9:8765/mcp', /IPv4 address on this PC or the store network/],
    ['http://100.64.0.9:8765/mcp', /store network/],
    ['http://10.0.0.20/mcp', /write out the port/],
    ['http://10.0.0.20:8765/other', /must end in \/mcp/],
    ['http://10.0.0.20:8765/mcp?x=1', /must end in \/mcp/],
    ['http://user:pw@10.0.0.20:8765/mcp', /no login/],
    ['http://127.0.0.1:18765/mcp', /dev harness address/],
    ['not a url', /full address/],
  ] as const) {
    assert.throws(() => makeConfig({ allowLiveScaleConnect: true, liveScaleConnectUrl: bad, scaleNames: ALL, writeScales: ALL }), why, bad);
  }
  // writeScales must be scales ScaleConnect reports.
  assert.throws(() => makeConfig({ allowLiveScaleConnect: true, liveScaleConnectUrl: LIVE_URL, scaleNames: ALL, writeScales: ['BACK'] }), /scaleNames does not list/);
  // An address with live scales off is a mistake, not a silent no-op.
  assert.throws(() => makeConfig({ liveScaleConnectUrl: LIVE_URL }), /allowLiveScaleConnect is off/);
});

test('gating: production only with both the config switch and the setting', () => {
  assert.throws(() => checkSetting('squareEnvironment', 'production', { allowSquareProduction: false }), /locked/);
  assert.equal(checkSetting('squareEnvironment', 'production', { allowSquareProduction: true }), 'production');
  assert.equal(effectiveEnvironment('production', false), 'sandbox');
  assert.equal(effectiveEnvironment('sandbox', true), 'sandbox');
  assert.equal(effectiveEnvironment('production', true), 'production');
  assert.equal(effectiveEnvironment('anything else', true), 'sandbox');
});

test('labels: live Square is always "Square (live)", never the sandbox words', () => {
  assert.equal(catalogSourceLabel('square_production'), 'Square (live)');
  assert.equal(catalogSourceLabel('square_sandbox'), 'Square sandbox');
  assert.match(catalogSourceLabel('file'), /Saved catalog file/);
  assert.equal(sourceForEnv('production'), 'square_production');
  assert.equal(envForSource('square_production'), 'production');
  assert.equal(envForSource('file'), null);
  // A recorded source keeps its own words, whichever Square is in use now.
  const live = { kind: 'square_production' as const, label: 'Square (live)' };
  assert.equal(catalogLabelFor(live, 'square_sandbox'), 'Square sandbox');
  assert.equal(catalogLabelFor(live, 'square_production'), 'Square (live)');
});

test('labels: the Square catalog source follows the environment, and a load records and keeps the one it started in', async () => {
  const values: SettingValues = { ...defaultSettings(), squareEnvironment: 'sandbox', squareLocationId: 'LOC1234' };
  const urls: string[] = [];
  const f = (async (input: URL | string) => {
    const url = new URL(String(input));
    urls.push(url.origin);
    // The setting changes in the middle of a load.
    if (url.pathname === '/v2/locations') {
      values.squareEnvironment = values.squareEnvironment === 'sandbox' ? 'production' : 'sandbox';
      return new Response(JSON.stringify({ locations: [{ id: 'LOC1234', status: 'ACTIVE' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  }) as typeof fetch;
  const token = ['EAAA', 'w'.repeat(40)].join('');
  const reader = createSquareReader({ getSetting: (n) => values[n], getSecret: () => token, allowSquareProduction: true, fetch: f });
  const src = squareCatalogSource(reader, () => values.squareLocationId);
  assert.equal(src.kind, 'square_sandbox');
  assert.equal(src.label, 'Square sandbox');
  // Started in the sandbox, the setting moved to live mid-load: the catalog read is refused.
  await assert.rejects(src.load(), /changed while ShelfReady was reading/);
  assert.equal(urls.length, 1);
  assert.equal(src.kind, 'square_production');
  assert.equal(src.label, 'Square (live)');
  // Counts pinned to the run's source are refused from the other Square.
  await assert.rejects(src.counts(['V1'], 'LOC1234', 'square_sandbox'), /changed while ShelfReady was reading/);
});

test('mixed environments are named plainly, both ways', () => {
  assert.equal(mixedEnvironmentProblem('square_production', 'production'), null);
  assert.equal(mixedEnvironmentProblem('square_sandbox', 'sandbox'), null);
  assert.match(mixedEnvironmentProblem('square_sandbox', 'production') ?? '', /read in Square sandbox, but ShelfReady now uses Square \(live\)\. A run never mixes the two\./);
  assert.match(mixedEnvironmentProblem('square_production', 'sandbox') ?? '', /read in Square \(live\), but ShelfReady now uses Square sandbox/);
  assert.match(mixedEnvironmentProblem('file', 'production') ?? '', /saved catalog file/);
});

test('live ScaleConnect: only the pinned address, and only to a listener our own user owns; nothing is sent otherwise', async (t) => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/mcp`;
  const token = 'T'.repeat(43);
  const uid = process.getuid?.() ?? 0;
  // The settings address differs from the config's: refused.
  await assert.rejects(connectScaleConnect({ url, token, allowLive: true, liveUrl: `http://127.0.0.1:${port + 1}/mcp` }), (e: Error) => e instanceof ScaleConnectError && /not the live address in the server config/.test(e.message) && !e.message.includes(token));
  // The listener belongs to another user: refused before connecting.
  await assert.rejects(connectScaleConnect({ url, token, allowLive: true, liveUrl: url, listenerHooks: { uid: uid + 1 } }), /belongs to another user/);
  assert.equal(requests, 0, 'no request reached the listener');
  // Nothing listening: refused.
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  assert.match(liveListenerProblem(`http://127.0.0.1:${closedPort}/mcp`) ?? '', /Nothing is listening/);
  // Our own listener on this PC passes the check.
  assert.equal(liveListenerProblem(url), null);
  // An address that is not this PC's is refused: its listener could not be checked.
  assert.match(liveListenerProblem(LIVE_URL, { localAddresses: () => [] }) ?? '', /not an address of this PC, so ShelfReady cannot check who is listening there/);
  await assert.rejects(
    connectScaleConnect({ url: LIVE_URL, token, allowLive: true, liveUrl: LIVE_URL, listenerHooks: { localAddresses: () => ['10.0.0.99'] } }),
    /not an address of this PC/,
  );
  assert.match(liveListenerProblem(LIVE_URL, { localAddresses: () => ['10.0.0.20'], procNet: () => ({ tcp: '', tcp6: '' }) }) ?? '', /Nothing is listening on 10\.0\.0\.20:8765/);
});

test('the settings page says plainly which Square and which scales are in use', async (t) => {
  const s = await makeApp(LIVE);
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW, true)).cookie;
  let page = (await get(s, '/settings', cookie)).body;
  assert.match(page, /<span class="tag tag-mute">TEST<\/span> In use now: Square sandbox\. Nothing reaches the store register\./);
  assert.match(page, /<span class="tag tag-live">LIVE<\/span> Sends go to the store scales: FRONT, KITCHEN, COUNTER, through http:\/\/10\.0\.0\.20:8765\/mcp\./);
  assert.doesNotMatch(page, /value="production" disabled/);
  const form = {
    anthropicFirstPassModel: 'claude-sonnet-5-5',
    anthropicFallbackModel: 'claude-opus-5-5',
    invoiceCostCapUsd: '1.00',
    cardCopyCapUsd: '5.00',
    dailyLimitUsd: '10.00',
    historySharePercent: '50',
    bigChangePercent: '30',
    squareEnvironment: 'production',
    squareLocationId: '',
    scaleConnectUrl: LIVE_URL,
    cardConfigPath: '',
    pricingAddBefore: '0.00',
    pricingMultiplier: '2',
    pricingAddAfter: '1.00',
    pricingRounding: 'up-to-99',
    pricingVendors: '',
  };
  const res = await post(s, '/settings', cookie, form, { csrfPage: '/settings' });
  assert.equal(res.statusCode, 303);
  page = (await get(s, '/settings', cookie)).body;
  assert.match(page, /<span class="tag tag-live">LIVE<\/span> In use now: Square \(live\)\. Sending an invoice changes the store register\./);

  // Without the switches, the page says so too.
  const off = await makeApp();
  t.after(() => off.close());
  await addUser(off, 'bart', 'admin', ADMIN_PW);
  const c2 = (await login(off, 'bart', ADMIN_PW, true)).cookie;
  const p2 = (await get(off, '/settings', c2)).body;
  assert.match(p2, /In use now: Square sandbox/);
  assert.match(p2, /Sends go only to the dev ScaleConnect harness on this PC, never the store scales\./);
});

test('migration 13: catalog copies may be live, and every run keeps its catalog', async () => {
  const { migrate, openDatabase, schemaVersion } = await import('../src/db/db.ts');
  const { MIGRATIONS } = await import('../src/db/migrations.ts');
  const db = openDatabase(':memory:', MIGRATIONS.slice(0, 12));
  assert.equal(schemaVersion(db), 12);
  db.prepare("INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES (1, 'mgr', 'manager', 'x', 't', 't')").run();
  db.prepare("INSERT INTO catalog_snapshots (id, sha256, source, location_id, taken_at, data, created_at) VALUES (7, ?, 'square_sandbox', 'LOCA', 't', x'00', 1)").run('a'.repeat(64));
  db.prepare("INSERT INTO runs (id, state, created_by, created_by_name, created_at, updated_at, catalog_snapshot_id) VALUES (1, 'review', 1, 'mgr', 100, 100, 7)").run();
  assert.throws(() => db.prepare("INSERT INTO catalog_snapshots (sha256, source, location_id, taken_at, data, created_at) VALUES (?, 'square_production', 'LOCB', 't', x'00', 1)").run('b'.repeat(64)), /CHECK/);
  migrate(db);
  assert.equal(schemaVersion(db), 13);
  const joined = db.prepare('SELECT c.source FROM runs r JOIN catalog_snapshots c ON c.id = r.catalog_snapshot_id WHERE r.id = 1').get() as { source: string };
  assert.equal(joined.source, 'square_sandbox');
  db.prepare("INSERT INTO catalog_snapshots (sha256, source, location_id, taken_at, data, created_at) VALUES (?, 'square_production', 'LOCB', 't', x'00', 1)").run('b'.repeat(64));
  assert.throws(() => db.prepare("INSERT INTO catalog_snapshots (sha256, source, location_id, taken_at, data, created_at) VALUES (?, 'somewhere', 'LOCB', 't', x'00', 1)").run('c'.repeat(64)), /CHECK/);
  // The runs table still points at catalog_snapshots, and the reference still holds.
  const fk = db.prepare('PRAGMA foreign_key_list(runs)').all() as Array<{ table: string; from: string }>;
  assert.ok(fk.some((k) => k.table === 'catalog_snapshots' && k.from === 'catalog_snapshot_id'));
  assert.throws(() => db.prepare('DELETE FROM catalog_snapshots WHERE id = 7').run(), /FOREIGN KEY/);
  db.close();
});

test('the config names the dev harness address the same way the ScaleConnect code does', async () => {
  const { DEV_HARNESS_MCP_URL } = await import('../src/server/config.ts');
  const { DEV_MCP_URL } = await import('../src/scaleconnect/dev-connection.ts');
  assert.equal(DEV_HARNESS_MCP_URL, DEV_MCP_URL);
});

test('settings: the Square token is saved with its environment; changing the environment without a new token removes it', async (t) => {
  const s = await makeApp(LIVE);
  t.after(() => s.close());
  const st = s.app.shelf.settings;
  const actor = { userId: null, username: 'test' };
  const SANDBOX_TOKEN = ['EAAA', 's'.repeat(40)].join('');
  const LIVE_TOKEN = ['EAAA', 'l'.repeat(40)].join('');
  assert.equal(st.squareTokenEnvironment(), null);
  // Entered while the sandbox is in use: the sandbox's.
  st.update({ values: { squareEnvironment: 'sandbox' }, secrets: { squareAccessToken: SANDBOX_TOKEN } }, actor);
  assert.equal(st.squareTokenEnvironment(), 'sandbox');
  // The environment changes to live with no token in the same save: the sandbox token is gone.
  const r = st.update({ values: { squareEnvironment: 'production' } }, actor);
  assert.deepEqual(r.changed.sort(), ['squareAccessToken', 'squareEnvironment']);
  assert.equal(st.getSecret('squareAccessToken'), undefined);
  assert.equal(st.squareTokenEnvironment(), null);
  // The live token, entered with live: bound to live.
  st.update({ values: { squareEnvironment: 'production' }, secrets: { squareAccessToken: LIVE_TOKEN } }, actor);
  assert.equal(st.squareTokenEnvironment(), 'production');
  // Saving the same environment again keeps it.
  st.update({ values: { squareEnvironment: 'production', bigChangePercent: '25' } }, actor);
  assert.equal(st.getSecret('squareAccessToken'), LIVE_TOKEN);
  // Back to the sandbox, with the sandbox token in the same save: rebound, the live token gone.
  st.update({ values: { squareEnvironment: 'sandbox' }, secrets: { squareAccessToken: SANDBOX_TOKEN } }, actor);
  assert.equal(st.squareTokenEnvironment(), 'sandbox');
  assert.equal(st.getSecret('squareAccessToken'), SANDBOX_TOKEN);
  // The same token entered again for live is bound to live: a token is for the environment it was entered with.
  st.update({ values: { squareEnvironment: 'production' }, secrets: { squareAccessToken: SANDBOX_TOKEN } }, actor);
  assert.equal(st.squareTokenEnvironment(), 'production');
  // Clearing the token clears its environment too.
  st.update({ secrets: { squareAccessToken: null } }, actor);
  assert.equal(st.squareTokenEnvironment(), null);
  // The audit log names the token as set or cleared, never its value.
  const rows = s.app.shelf.db.prepare("SELECT details FROM audit_log WHERE action = 'settings.update'").all() as Array<{ details: string }>;
  assert.ok(rows.every((x) => !x.details.includes(LIVE_TOKEN) && !x.details.includes(SANDBOX_TOKEN)));
});

test('settings: a token saved before tokens had an environment counts as the sandbox, so it is never sent live', async (t) => {
  const s = await makeApp(LIVE);
  t.after(() => s.close());
  const st = s.app.shelf.settings;
  st.update({ secrets: { squareAccessToken: ['EAAA', 'o'.repeat(40)].join('') } }, { userId: null, username: 'test' });
  s.app.shelf.db.prepare("DELETE FROM settings WHERE name = 'bind:squareAccessToken'").run();
  assert.equal(st.squareTokenEnvironment(), 'sandbox');
});

test('settings page: the token for the other environment is named plainly, and the app does not send it', async (t) => {
  const s = await makeApp(LIVE);
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW, true)).cookie;
  const st = s.app.shelf.settings;
  st.update({ values: { squareEnvironment: 'production' }, secrets: { squareAccessToken: ['EAAA', 'l'.repeat(40)].join('') } }, { userId: null, username: 'test' });
  let page = (await get(s, '/settings', cookie)).body;
  assert.match(page, /The saved Square access token was entered for Square \(live\)\./);
  // A token bound to live while the sandbox is used (here: the row changed underneath): an error on the page.
  s.app.shelf.db.prepare("DELETE FROM settings WHERE name = 'bind:squareAccessToken'").run();
  page = (await get(s, '/settings', cookie)).body;
  assert.match(page, /entered for Square sandbox, not Square \(live\), so ShelfReady does not send it/);
});

test('the check before Square: no address, the wrong address, nobody listening, no token, each stops the send first', () => {
  const token = 'T'.repeat(43);
  const base = { url: () => LIVE_URL, token: () => token, allowLive: true, liveUrl: LIVE_URL, listenerHooks: { localAddresses: () => ['10.0.0.20'], procNet: () => ({ tcp: '', tcp6: '' }) } };
  assert.match(scalePreflightProblem({ ...base, url: () => '' }) ?? '', /No ScaleConnect address is set/);
  assert.match(scalePreflightProblem({ ...base, url: () => 'http://10.0.0.21:8765/mcp' }) ?? '', /not the live address in the server config/);
  assert.match(scalePreflightProblem(base) ?? '', /Nothing is listening on 10\.0\.0\.20:8765/);
  assert.match(scalePreflightProblem({ ...base, listenerHooks: { localAddresses: () => [] } }) ?? '', /not an address of this PC/);
  // A listener of ours: only the token is left to check.
  const uid = process.getuid?.() ?? 0;
  const ours = { tcp: `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid\n   0: 1400000A:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}\n`, tcp6: '' };
  const listening = { ...base, listenerHooks: { localAddresses: () => ['10.0.0.20'], procNet: () => ours, uid } };
  assert.equal(scalePreflightProblem(listening), null);
  assert.match(scalePreflightProblem({ ...listening, token: () => undefined }) ?? '', /No usable ScaleConnect token/);
  assert.match(scalePreflightProblem({ ...listening, token: () => { throw new Error('integrity'); } }) ?? '', /damaged/);
  // The dev harness, with live off: no listener check, the address alone.
  assert.equal(scalePreflightProblem({ url: () => 'http://127.0.0.1:18765/mcp', token: () => token, allowLive: false, liveUrl: '' }), null);
});
