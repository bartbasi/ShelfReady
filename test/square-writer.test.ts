// The Square write client: sandbox only, pinned origin, no redirects, write bodies checked before
// sending, lost replies told apart from refusals, and the token never in an error. Plus the
// ScaleConnect address guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkInventoryBody, checkUpsertBody, createSquareWriteApi, SquareWriteUnknown, type InventoryBody, type UpsertBody } from '../src/square/writer.ts';
import { SquareError } from '../src/square/client.ts';
import { SQUARE_PRODUCTION_ORIGIN } from '../src/square/origins.ts';
import { scaleAddressProblem } from '../src/scaleconnect/connection.ts';
import { DEV_MCP_URL } from '../src/scaleconnect/dev-connection.ts';

const TOKEN = 'EAAA' + 'x'.repeat(60);
const NOW = Date.parse('2026-11-07T12:00:00Z');

function api(fetchImpl: typeof fetch, env: 'sandbox' | 'production' = 'sandbox', pinned: 'sandbox' | 'production' = 'sandbox', allowSquareProduction = false, tokenEnv: 'sandbox' | 'production' = pinned) {
  return createSquareWriteApi({
    tokenEnvironment: () => tokenEnv,
    getSetting: ((k: string) => (k === 'squareEnvironment' ? env : '')) as never,
    getSecret: () => TOKEN,
    locationId: () => 'LOC1',
    fetch: fetchImpl,
    now: () => NOW,
    environment: pinned,
    allowSquareProduction,
  });
}

function variationObj(id: string, itemId = 'I1', version = 1) {
  return { type: 'ITEM_VARIATION', id, version, item_variation_data: { item_id: itemId, price_money: { amount: 100, currency: 'USD' } } };
}

function itemObj(id: string, variations = 1) {
  return { type: 'ITEM', id, version: 1, item_data: { name: 'x', variations: Array.from({ length: variations }, (_, i) => variationObj(`${id}V${i}`, id)) } };
}

function upsert(objects: unknown[]): UpsertBody {
  return { idempotency_key: randomUUID(), sparse_update: true, batches: [{ objects: objects as Record<string, unknown>[] }] };
}

function count(over: Record<string, unknown> = {}): InventoryBody {
  return {
    idempotency_key: randomUUID(),
    ignore_unchanged_counts: false,
    changes: [{ type: 'PHYSICAL_COUNT', physical_count: { catalog_object_id: 'V1', state: 'IN_STOCK', location_id: 'LOC1', quantity: '4.500', occurred_at: new Date(NOW - 1000).toISOString(), ...over } }],
  };
}

test('write bodies are checked before anything is sent', () => {
  checkUpsertBody(upsert([variationObj('V1'), variationObj('V2')]));
  checkUpsertBody(upsert([itemObj('I1'), itemObj('I2')]));
  const refused = (body: UpsertBody, why: RegExp) => assert.throws(() => checkUpsertBody(body), (e: Error) => e instanceof SquareError && why.test(e.message));
  refused(upsert([itemObj('I1'), variationObj('V9', 'I1')]), /item and its own variation/);
  refused(upsert(Array.from({ length: 9 }, (_, i) => variationObj(`V${i}`))), /at most 8 variations/);
  refused(upsert([itemObj('I1', 5), itemObj('I2', 4)]), /at most 8 variations/);
  refused(upsert([{ ...variationObj('V1'), version: undefined }]), /no version/);
  refused(upsert([{ ...variationObj('#new') }]), /never creates/);
  refused(upsert([{ type: 'ITEM', id: 'I1', version: 1, item_data: { name: 'x' } }]), /with its variations/);
  refused(upsert([{ type: 'CATEGORY', id: 'C1', version: 1 }]), /only items and item variations/);
  refused({ ...upsert([variationObj('V1')]), sparse_update: false as true }, /sparse_update/);
  refused({ idempotency_key: 'not-a-key', sparse_update: true, batches: [{ objects: [variationObj('V1')] }] }, /idempotency key/);

  checkInventoryBody(count(), 'LOC1', NOW);
  const inv = (body: InventoryBody, why: RegExp) => assert.throws(() => checkInventoryBody(body, 'LOC1', NOW), (e: Error) => why.test(e.message));
  inv(count({ catalog_object_type: 'ITEM_VARIATION' }), /catalog_object_type/);
  inv(count({ occurred_at: new Date(NOW + 60_000).toISOString() }), /current/);
  inv(count({ occurred_at: new Date(NOW - 25 * 3600_000).toISOString() }), /current/);
  inv(count({ location_id: 'OTHER' }), /another location/);
  inv(count({ quantity: '-1' }), /quantity/);
  const many = count();
  many.changes = Array.from({ length: 26 }, () => many.changes[0]!);
  inv(many, /at most 25/);
  const toNone = { ...count(), changes: [{ type: 'ADJUSTMENT', adjustment: { catalog_object_id: 'V1', from_state: 'IN_STOCK', to_state: 'NONE', location_id: 'LOC1', quantity: '1', occurred_at: new Date(NOW).toISOString() } }] };
  inv(toNone, /IN_STOCK to WASTE only/);
});

test('a client writes only to the environment it was made for, and live only with both switches', async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return new Response('{}');
  }) as typeof fetch;
  // Made for the sandbox, but the setting now says production: refused, nothing sent.
  const w = api(counting, 'production', 'sandbox', true);
  assert.equal(w.environment, 'sandbox');
  await assert.rejects(w.retrieveObjects(['I1']), /This send is for Square sandbox, but ShelfReady now uses Square \(live\)/);
  await assert.rejects(w.batchUpsert(upsert([variationObj('V1')])), /A run never mixes the two/);
  // Made for live, but the config does not allow it: refused, whatever the setting says.
  const noConfig = api(counting, 'production', 'production', false);
  await assert.rejects(noConfig.batchUpsert(upsert([variationObj('V1')])), /allowSquareProduction/);
  // Made for live, both switches on, but the setting went back to the sandbox: refused.
  const back = api(counting, 'sandbox', 'production', true);
  await assert.rejects(back.batchUpsert(upsert([variationObj('V1')])), /This send is for Square \(live\), but ShelfReady now uses Square sandbox/);
  assert.equal(calls, 0);
});

test('a live client, with both switches on, sends to live Square only, with redirects refused', async () => {
  const seen: string[] = [];
  const w = api((async (url: URL, init: RequestInit) => {
    seen.push(String(url));
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  }) as unknown as typeof fetch, 'production', 'production', true);
  assert.equal(w.environment, 'production');
  await w.retrieveObjects(['I1']);
  await w.batchUpsert(upsert([variationObj('V1')]));
  assert.deepEqual(seen, [`${SQUARE_PRODUCTION_ORIGIN}/v2/catalog/batch-retrieve`, `${SQUARE_PRODUCTION_ORIGIN}/v2/catalog/batch-upsert`]);
});

test('a write client sends the token only to the environment it was entered for', async () => {
  let calls = 0;
  const counting = (async () => {
    calls++;
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  }) as typeof fetch;
  // A live token, a sandbox send: refused before anything is sent.
  await assert.rejects(api(counting, 'sandbox', 'sandbox', true, 'production').batchUpsert(upsert([variationObj('V1')])), /entered for Square \(live\), not the Square sandbox/);
  // A sandbox token, a live send: refused.
  await assert.rejects(api(counting, 'production', 'production', true, 'sandbox').batchUpsert(upsert([variationObj('V1')])), /entered for the Square sandbox, not Square \(live\)/);
  assert.equal(calls, 0);
});

test('the sandbox origin is pinned, redirects are refused, and the token stays in the header', async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const w = api((async (url: URL, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ objects: [] }), { status: 200 });
  }) as unknown as typeof fetch);
  await w.retrieveObjects(['I1']);
  await w.batchUpsert(upsert([variationObj('V1')]));
  assert.equal(seen[0]!.url, 'https://connect.squareupsandbox.com/v2/catalog/batch-retrieve');
  assert.equal(seen[1]!.url, 'https://connect.squareupsandbox.com/v2/catalog/batch-upsert');
  for (const s of seen) {
    assert.equal(s.init.redirect, 'error');
    assert.equal((s.init.headers as Record<string, string>).Authorization, `Bearer ${TOKEN}`);
    assert.ok(!String(s.init.body).includes(TOKEN));
  }
});

test('a lost reply on a write is unknown; a refusal is a refusal; a failed read is never unknown; no token in errors', async () => {
  const thrower = api((async () => {
    throw new Error(`socket hang up Authorization: Bearer ${TOKEN}`);
  }) as typeof fetch);
  const lost = await thrower.batchUpsert(upsert([variationObj('V1')])).catch((e) => e);
  assert.ok(lost instanceof SquareWriteUnknown);
  assert.ok(!String(lost.message).includes(TOKEN));
  const read = await thrower.retrieveObjects(['I1']).catch((e) => e);
  assert.ok(read instanceof SquareError && !(read instanceof SquareWriteUnknown));
  assert.ok(!String(read.message).includes(TOKEN));

  const status = (code: number, body: unknown) => api((async () => new Response(JSON.stringify(body), { status: code })) as typeof fetch);
  const five = await status(502, { errors: [{ code: 'INTERNAL_SERVER_ERROR', detail: TOKEN }] }).changeInventory(count()).catch((e) => e);
  assert.ok(five instanceof SquareWriteUnknown);
  assert.ok(!String(five.message).includes(TOKEN));
  const four = await status(400, { errors: [{ code: 'VERSION_MISMATCH', detail: 'secret detail' }] }).batchUpsert(upsert([variationObj('V1')])).catch((e) => e);
  assert.ok(four instanceof SquareError && !(four instanceof SquareWriteUnknown));
  assert.deepEqual(four.codes, ['VERSION_MISMATCH']);
  assert.ok(!String(four.message).includes('secret detail'));
});

test('ScaleConnect: only the dev harness address until live scales are approved', () => {
  assert.equal(scaleAddressProblem(DEV_MCP_URL, false), null);
  assert.match(scaleAddressProblem('http://10.0.0.20:8765/mcp', false) ?? '', /refused/);
  assert.match(scaleAddressProblem('http://127.0.0.1:8765/mcp', false) ?? '', /refused/);
  assert.match(scaleAddressProblem('', false) ?? '', /No ScaleConnect address/);
  // Live: only the address the server config pins, and the setting must be exactly it.
  assert.equal(scaleAddressProblem('http://10.0.0.20:8765/mcp', true, 'http://10.0.0.20:8765/mcp'), null);
  assert.match(scaleAddressProblem('http://10.0.0.21:8765/mcp', true, 'http://10.0.0.20:8765/mcp') ?? '', /not the live address in the server config/);
  assert.match(scaleAddressProblem(DEV_MCP_URL, true, 'http://10.0.0.20:8765/mcp') ?? '', /not the live address/);
  assert.match(scaleAddressProblem('http://10.0.0.20:8765/mcp', true) ?? '', /names no live ScaleConnect address/);
});
