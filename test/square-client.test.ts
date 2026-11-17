import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSquareReader, SQUARE_SANDBOX_ORIGIN, SquareError, type SquareReaderDeps } from '../src/square/client.ts';
import { fileCatalogSource, squareCatalogSource } from '../src/square/catalog-source.ts';
import { SQUARE_PRODUCTION_ORIGIN } from '../src/square/origins.ts';
import type { SettingValues } from '../src/settings/schema.ts';
import { defaultSettings } from '../src/settings/schema.ts';
import { tempDir } from './server-helpers.ts';

/** A token built at run time, so no token-like text sits in the source. */
const TOKEN = ['EAAA', 'x'.repeat(40)].join('');

interface Call {
  url: string;
  method: string;
  redirect: string | undefined;
  auth: string;
  body: unknown;
}

function fakeFetch(respond: (url: URL, n: number) => { status?: number; json: unknown }): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    calls.push({ url: url.toString(), method: String(init.method), redirect: init.redirect, auth: headers.get('authorization') ?? '', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = respond(url, calls.length);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

function deps(over: Partial<SquareReaderDeps> & { env?: SettingValues['squareEnvironment']; token?: string | undefined } = {}): SquareReaderDeps {
  const values = { ...defaultSettings(), squareEnvironment: over.env ?? 'sandbox', squareLocationId: 'LOC1234' };
  return {
    getSetting: (name) => values[name],
    getSecret: () => ('token' in over ? over.token : TOKEN),
    allowSquareProduction: false,
    ...over,
  };
}

test('reads go to the sandbox only, with redirects refused and the token in the header', async () => {
  const f = fakeFetch((url) => (url.pathname === '/v2/locations' ? { json: { locations: [{ id: 'LOC1234', name: 'Test', status: 'ACTIVE', timezone: 'America/Chicago' }] } } : { json: { objects: [] } }));
  const r = createSquareReader(deps({ fetch: f }));
  const locs = await r.listLocations();
  assert.equal(locs[0]!.id, 'LOC1234');
  assert.equal(f.calls[0]!.url, `${SQUARE_SANDBOX_ORIGIN}/v2/locations`);
  assert.equal(f.calls[0]!.redirect, 'error');
  assert.equal(f.calls[0]!.auth, `Bearer ${TOKEN}`);
});

test('live Square needs both switches: the config and the setting', async () => {
  const f = fakeFetch(() => ({ json: {} }));
  // Locked by the config: the client uses the sandbox anyway.
  const locked = createSquareReader(deps({ env: 'production', fetch: f }));
  assert.equal(locked.environment(), 'sandbox');
  await locked.listLocations();
  assert.ok(f.calls[0]!.url.startsWith(SQUARE_SANDBOX_ORIGIN));
  // The config allows it, but the setting says sandbox: the sandbox.
  const g = fakeFetch(() => ({ json: {} }));
  await createSquareReader(deps({ env: 'sandbox', allowSquareProduction: true, fetch: g })).listLocations();
  assert.ok(g.calls[0]!.url.startsWith(SQUARE_SANDBOX_ORIGIN));
  // Both on: live Square's pinned origin.
  const h = fakeFetch(() => ({ json: {} }));
  const live = createSquareReader(deps({ env: 'production', allowSquareProduction: true, tokenEnvironment: () => 'production', fetch: h }));
  assert.equal(live.environment(), 'production');
  await live.listLocations();
  assert.equal(h.calls[0]!.url, `${SQUARE_PRODUCTION_ORIGIN}/v2/locations`);
  assert.equal(h.calls[0]!.redirect, 'error');
  // A read pinned to the sandbox is refused once live is in use, before anything is sent.
  await assert.rejects(live.listCatalog('sandbox'), /changed while ShelfReady was reading/);
  assert.equal(h.calls.length, 1);
});

test('the token goes only to the environment it was entered for: never a live token to the sandbox, nor the reverse', async () => {
  // A token entered for live, while the sandbox is in use (the config switch went off): refused.
  const f = fakeFetch(() => ({ json: {} }));
  const err = await createSquareReader(deps({ env: 'production', allowSquareProduction: false, tokenEnvironment: () => 'production', fetch: f })).listLocations().then(() => new Error('sent'), (e: Error) => e);
  assert.match(String(err.message), /entered for Square \(live\), not the Square sandbox, so it is not sent/);
  assert.ok(!String(err.message).includes(TOKEN));
  // A sandbox token while live is in use: refused.
  await assert.rejects(createSquareReader(deps({ env: 'production', allowSquareProduction: true, tokenEnvironment: () => 'sandbox', fetch: f })).listLocations(), /entered for the Square sandbox, not Square \(live\)/);
  // A caller that does not say which environment the token is for: live is refused.
  await assert.rejects(createSquareReader(deps({ env: 'production', allowSquareProduction: true, fetch: f })).listLocations(), /entered for the Square sandbox/);
  // No token saved, or a damaged record: refused.
  await assert.rejects(createSquareReader(deps({ tokenEnvironment: () => null, fetch: f })).listLocations(), /No Square access token/);
  await assert.rejects(createSquareReader(deps({ tokenEnvironment: () => { throw new Error('integrity'); }, fetch: f })).listLocations(), /damaged/);
  assert.equal(f.calls.length, 0, 'nothing was sent');
  // Matching: sent.
  await createSquareReader(deps({ tokenEnvironment: () => 'sandbox', fetch: f })).listLocations();
  assert.equal(f.calls.length, 1);
});

test('a missing or misshapen token is refused before anything is sent', async () => {
  for (const token of [undefined, '', ['sk', 'ant', 'wrong', '0'.repeat(30)].join('-'), `${TOKEN}\n`]) {
    const f = fakeFetch(() => ({ json: {} }));
    await assert.rejects(createSquareReader(deps({ token, fetch: f })).listCatalog(), SquareError);
    assert.equal(f.calls.length, 0);
  }
});

test('errors carry only Square error codes, never the token or the reply text', async () => {
  const f = fakeFetch(() => ({ status: 400, json: { errors: [{ code: 'BAD_REQUEST', detail: `echo ${TOKEN}` }] } }));
  const err = await createSquareReader(deps({ fetch: f })).listCatalog().catch((e: Error) => e);
  assert.ok(err instanceof SquareError);
  assert.match(err.message, /BAD_REQUEST/);
  assert.doesNotMatch(err.message, /EAAA|echo/);
  const g = fakeFetch(() => ({ status: 401, json: { errors: [{ code: 'UNAUTHORIZED' }] } }));
  await assert.rejects(createSquareReader(deps({ fetch: g })).listLocations(), /refused the access token/);
  const h = (async () => {
    throw new Error(`connect failed Authorization: Bearer ${TOKEN}`);
  }) as unknown as typeof fetch;
  const e2 = await createSquareReader(deps({ fetch: h })).listLocations().catch((e: Error) => e);
  assert.ok(e2 instanceof SquareError);
  assert.doesNotMatch(e2.message, /EAAA|Bearer/);
});

test('the catalog follows cursors, and a bad reply shape or a proxy setting is refused', async () => {
  const f = fakeFetch((_u, n) => ({ json: n < 3 ? { objects: [{ id: `o${n}` }], cursor: `c${n}` } : { objects: [{ id: 'last' }] } }));
  const objs = await createSquareReader(deps({ fetch: f })).listCatalog();
  assert.equal(objs.length, 3);
  assert.equal(new URL(f.calls[1]!.url).searchParams.get('cursor'), 'c1');
  assert.equal(new URL(f.calls[0]!.url).searchParams.get('types'), 'ITEM,CATEGORY,TAX,MEASUREMENT_UNIT');
  const bad = fakeFetch(() => ({ json: { objects: 'nope' } }));
  await assert.rejects(createSquareReader(deps({ fetch: bad })).listCatalog(), /unexpected shape/);
  const badCursor = fakeFetch(() => ({ json: { objects: [], cursor: 'a b' } }));
  await assert.rejects(createSquareReader(deps({ fetch: badCursor })).listCatalog(), /cursor/);
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    const p = fakeFetch(() => ({ json: {} }));
    await assert.rejects(createSquareReader(deps({ fetch: p })).listLocations(), /NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.equal(p.calls.length, 0);
  } finally {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
});

test('stock counts are read in batches of 500 for one location, with ids checked', async () => {
  const f = fakeFetch((_u, n) => ({ json: { counts: [{ catalog_object_id: `V${n}`, location_id: 'LOC1234', state: 'IN_STOCK', quantity: '2' }] } }));
  const r = createSquareReader(deps({ fetch: f }));
  const ids = Array.from({ length: 700 }, (_, i) => `V${i}`);
  const counts = await r.inventoryCounts(ids, 'LOC1234');
  assert.equal(f.calls.length, 2);
  assert.equal((f.calls[0]!.body as { catalog_object_ids: string[] }).catalog_object_ids.length, 500);
  assert.equal(f.calls[0]!.method, 'POST');
  assert.equal(counts.length, 2);
  await assert.rejects(r.inventoryCounts(['bad id!'], 'LOC1234'), /does not look like/);
});

test('the Square catalog source checks the location, and the file source only reads its file', async (t) => {
  const f = fakeFetch((url) => (url.pathname === '/v2/locations' ? { json: { locations: [{ id: 'OTHER', status: 'ACTIVE' }] } } : { json: { objects: [] } }));
  await assert.rejects(squareCatalogSource(createSquareReader(deps({ fetch: f })), () => 'LOC1234').load(), /not one of this Square account/);
  await assert.rejects(squareCatalogSource(createSquareReader(deps({ fetch: f })), () => '').load(), /No Square location id/);

  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'catalog.json');
  writeFileSync(path, JSON.stringify({
    takenAt: '2026-11-07T10:00:00Z',
    location: { id: 'LOC9' },
    objects: [{ type: 'ITEM', id: 'I1' }],
    counts: [
      { catalog_object_id: 'V1', location_id: 'LOC9', state: 'IN_STOCK', quantity: '4.5' },
      { catalog_object_id: 'V1', location_id: 'LOC9', state: 'WASTE', quantity: '1' },
      { catalog_object_id: 'V2', location_id: 'ELSEWHERE', state: 'IN_STOCK', quantity: '9' },
    ],
  }));
  const src = fileCatalogSource(path);
  const data = await src.load();
  assert.equal(data.locationId, 'LOC9');
  assert.equal(data.source, 'file');
  assert.deepEqual([...(await src.counts(['V1', 'V2'], 'LOC9'))], [['V1', '4.5']]);
  const link = join(dir, 'link.json');
  symlinkSync(path, link);
  await assert.rejects(fileCatalogSource(link).load());
});
