// The Square side of sending: freshness and hash checks, version drift, order and batch limits,
// failures that stop before the scales, retries after a lost reply that never double anything,
// corrections, and nothing sent for lines where nothing arrived.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoice, image, line } from './invoice-fixtures.ts';
import { CAT_CRACKERS, item, upcA } from './matching-fixtures.ts';
import { decide, runState, signIn, testInvoice } from './runs-fixtures.ts';
import { get } from './server-helpers.ts';
import { acceptPreview, approvedRun, dryRunHash, pressSend, sendPhase, type SendApp } from './send-fixtures.ts';
import type { Json } from '../src/square/writer.ts';
import { makeConfig } from '../src/server/config.ts';

function writes(s: SendApp): string[] {
  return s.sq.calls.map((c) => c.on).filter((o) => o === 'upsert' || o === 'inventory');
}

function sendMessage(s: SendApp): string {
  return (s.app.shelf.db.prepare('SELECT message FROM run_sends WHERE run_id = 1').get() as { message: string } | undefined)?.message ?? '';
}

function errorOf(body: string): string {
  return body.match(/<p class="error"[^>]*>([^<]*)/)?.[1] ?? '';
}

test('an approval older than the limit is refused before anything is read or written, and goes back for a new dry run', async (t) => {
  // The limit is 24 hours by default. A short one here, so the test session stays signed in.
  const s = await approvedRun({ config: { approvalMaxAgeHours: 1 } });
  t.after(() => s.close());
  s.advance(61 * 60_000);
  // Sending needs the password typed recently, so the manager signs in again.
  s.mgr = await signIn(s);
  const page = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.match(page.body, /older than 1 hour/);
  const res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(errorOf(res.body), /older than 1 hour/);
  assert.deepEqual(s.sq.calls, []);
  assert.deepEqual(s.sc.calls, []);
  assert.equal(runState(s), 'approved');
  assert.equal((await decide(s, s.mgr, '/runs/1/send/redo-dry-run')).statusCode, 303);
  assert.equal(runState(s), 'ready');
  const row = s.app.shelf.db.prepare('SELECT dry_run_hash FROM runs WHERE id = 1').get() as { dry_run_hash: string };
  assert.equal(row.dry_run_hash, '', 'the old dry run is gone');
});

test('the default approval limit is 24 hours', () => {
  assert.equal(makeConfig({}).approvalMaxAgeHours, 24);
  assert.throws(() => makeConfig({ approvalMaxAgeHours: 25 }), /at most 24/);
  assert.equal(makeConfig({}).allowLiveScaleConnect, false);
});

test('the hash is checked: a changed stored dry run, a stale page and a setting changed since approval are all refused', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  // The page showed another hash.
  let res = await decide(s, s.mgr, '/runs/1/send/start', { hash: 'f'.repeat(64), scale_FRONT: '1' });
  assert.equal(res.statusCode, 409);
  assert.match(errorOf(res.body), /changed since the page was shown/);
  // A setting changed since approval: the preview worked out again differs.
  s.app.shelf.settings.update({ values: { pricing: { default: { addBefore: '0.00', multiplier: '2', addAfter: '2.00', rounding: 'up-to-99' }, vendors: [] } } }, { userId: null, username: 'test' });
  res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(errorOf(res.body), /Something changed since approval|Tick it to confirm/);
  s.app.shelf.settings.update({ values: { pricing: { default: { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' }, vendors: [] } } }, { userId: null, username: 'test' });
  // The stored dry run was changed behind ShelfReady's back.
  s.app.shelf.db.prepare("UPDATE runs SET dry_run = json_set(dry_run, '$.square[0].price.toCents', 1) WHERE id = 1").run();
  res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(errorOf(res.body), /does not match what was approved/);
  assert.deepEqual(writes(s), []);
});

test('a run matched at another Square location is refused', async (t) => {
  const s = await approvedRun({ deps: { squareLocationId: () => 'LOCOTHER1' } });
  t.after(() => s.close());
  const res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(errorOf(res.body), /different Square location/);
  assert.deepEqual(s.sq.calls, []);
});

test('an item changed in Square since the dry run stops the send before any write, and nothing goes to the scales', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  s.sq.touch('I_CRACKER');
  const res = await pressSend(s);
  assert.equal(res.statusCode, 303);
  assert.equal(sendPhase(s), 'square_failed');
  assert.match(sendMessage(s), /Nothing was changed in Square\. Nothing was sent to the scales\./);
  assert.match(sendMessage(s), /changed in Square since the dry run/);
  assert.deepEqual(writes(s), []);
  assert.deepEqual(s.sc.calls, []);
  assert.equal(runState(s), 'sending');
  // Nothing reached Square, so the send may be stopped, for a fresh upload. A tick is needed.
  assert.match((await get(s, '/runs/1/send', s.mgr.cookie)).body, /Stop this send/);
  assert.equal((await decide(s, s.mgr, '/runs/1/send/stop')).statusCode, 400);
  assert.equal((await decide(s, s.mgr, '/runs/1/send/stop', { confirm: '1' })).statusCode, 303);
  assert.equal(runState(s), 'failed');
});

test('a Square refusal stops before the scales, reports what did and did not update, and Send again finishes with a new key', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  s.sq.fail({ on: 'inventory', mode: 'refuse', codes: ['INVALID_VALUE'] });
  await pressSend(s);
  assert.equal(sendPhase(s), 'square_failed');
  assert.match(sendMessage(s), /Square did not finish\. Nothing was sent to the scales\./);
  assert.deepEqual(s.sc.calls, [], 'no scale contact at all');
  const report = JSON.parse((s.app.shelf.db.prepare('SELECT square_report FROM run_sends').get() as { square_report: string }).square_report);
  const cracker = report.items.find((i: { variationId: string }) => i.variationId === 'V_CRACKER');
  assert.equal(cracker.price.state, 'done');
  assert.equal(cracker.stock.state, 'failed');
  const page = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.match(page.body, /Square did not finish/);
  assert.match(page.body, /Send the rest to Square/);
  assert.doesNotMatch(page.body, /Stop this send/);
  const stop = await decide(s, s.mgr, '/runs/1/send/stop', { confirm: '1' });
  assert.equal(stop.statusCode, 409, 'part of it is in Square: it can only be finished');

  const res = await decide(s, s.mgr, '/runs/1/send/start', { hash: dryRunHash(s) });
  assert.equal(res.statusCode, 303, errorOf(res.body));
  await s.app.shelf.runner.drain();
  assert.equal(sendPhase(s), 'scale_preview');
  // The variations were not written again: only the stock went, with a new key.
  assert.deepEqual(writes(s), ['upsert', 'inventory', 'inventory']);
  const keys = s.sq.calls.filter((c) => c.on === 'inventory').map((c) => (c.body as Json).idempotency_key);
  assert.notEqual(keys[0], keys[1]);
  assert.equal(s.sq.counts.get('V_CRACKER'), 24);
});

test('a lost reply: Send again sends the same request with the same key, so Square applies it once', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  // The variation write lands, but its answer is lost.
  s.sq.fail({ on: 'upsert', mode: 'lost-after' });
  await pressSend(s);
  assert.equal(sendPhase(s), 'square_failed');
  assert.match(sendMessage(s), /did not answer/);
  assert.match(sendMessage(s), /same key/);
  assert.deepEqual(s.sc.calls, []);
  const row = s.app.shelf.db.prepare("SELECT state, idempotency_key FROM square_writes WHERE step = 'variations'").get() as { state: string; idempotency_key: string };
  assert.equal(row.state, 'sending');

  await decide(s, s.mgr, '/runs/1/send/start', { hash: dryRunHash(s) });
  await s.app.shelf.runner.drain();
  assert.equal(sendPhase(s), 'scale_preview', sendMessage(s));
  const ups = s.sq.calls.filter((c) => c.on === 'upsert').map((c) => (c.body as Json).idempotency_key);
  assert.deepEqual(ups, [row.idempotency_key, row.idempotency_key], 'sent again with the same key');
  assert.equal(s.sq.applied.filter((a) => a.on === 'upsert').length, 1, 'Square applied it once');
});

test('a stock correction after the send comes back out of Square once, even after a lost reply', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s);
  await acceptPreview(s);
  assert.equal(runState(s), 'done');
  assert.equal(s.sq.counts.get('V_CRACKER'), 24);
  assert.equal((await decide(s, s.mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' })).statusCode, 303);
  s.sq.fail({ on: 'inventory', mode: 'lost-after' });
  assert.equal((await decide(s, s.mgr, '/runs/1/send/corrections')).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(s.sq.counts.get('V_CRACKER'), 0, 'taken out once');
  let c = s.app.shelf.db.prepare('SELECT state FROM run_corrections WHERE run_id = 1 AND line = 2').get() as { state: string };
  assert.equal(c.state, 'pending', 'not marked sent while the answer is lost');
  // Again: the same key, so Square does not take it out twice.
  assert.equal((await decide(s, s.mgr, '/runs/1/send/corrections')).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(s.sq.counts.get('V_CRACKER'), 0);
  c = s.app.shelf.db.prepare('SELECT state FROM run_corrections WHERE run_id = 1 AND line = 2').get() as { state: string };
  assert.equal(c.state, 'sent');
  const adj = s.sq.calls.filter((x) => x.on === 'inventory').at(-1)!.body as Json;
  const change = (adj.changes as Json[])[0]!;
  assert.equal(change.type, 'ADJUSTMENT');
  assert.deepEqual([(change.adjustment as Json).from_state, (change.adjustment as Json).to_state, (change.adjustment as Json).quantity], ['IN_STOCK', 'WASTE', '24']);
  assert.equal(s.sq.applied.filter((a) => a.on === 'inventory').length, 2, 'the count, then the correction once');
});

test('nothing at all is sent for a line where nothing arrived, not even its price or a scale change', async (t) => {
  const s = await approvedRun({
    before: async (r, mgr) => {
      assert.equal((await decide(r, mgr, '/runs/1/lines/3/arrived', { arrived: 'none' })).statusCode, 303);
    },
  });
  t.after(() => s.close());
  await pressSend(s);
  assert.equal(sendPhase(s), 'scale_preview');
  const text = JSON.stringify(s.sq.calls.filter((c) => c.on !== 'retrieve' && c.on !== 'counts'));
  assert.ok(!text.includes('V_SALMON'), 'no write names the salmon');
  const preview = s.sc.calls.find((c) => c.tool === 'preview')!.args as { changes: Array<{ target_plu: string }> };
  assert.deepEqual(preview.changes.map((c) => c.target_plu), ['7101']);
});

test('batch limits: at most 8 variations per catalog call and 25 stock changes per call, variations before stock', async (t) => {
  const N = 27;
  const extra = Array.from({ length: N }, (_, i) => item({ id: `I_P${i}`, name: `Testmaker - Product ${i}`, category: CAT_CRACKERS, variations: [{ id: `V_P${i}`, upc: upcA(`0007770${String(i).padStart(4, '0')}`), cents: 599 }] }));
  const inv = invoice({
    supplier_name: 'Hilltop Provisions',
    images: [image()],
    lines: Array.from({ length: N }, (_, i) => line({ item_number: `P${i}`, upc: upcA(`0007770${String(i).padStart(4, '0')}`), description: `TESTMAKER PRODUCT ${i}`, pack_size: '12/4.4Z', unit: 'CS', qty_shipped: '1', unit_price: '30.00', extension: '30.00' })),
    total: `${30 * N}.00`,
  });
  const s = await approvedRun({ inv, extra, picks: [] });
  t.after(() => s.close());
  await pressSend(s);
  assert.equal(runState(s), 'done', sendMessage(s));
  assert.equal(sendPhase(s), 'done');
  const calls = s.sq.calls.filter((c) => c.on === 'upsert' || c.on === 'inventory');
  const sizes = calls.map((c) => `${c.on}:${c.on === 'upsert' ? (((c.body as Json).batches as Json[])[0]!.objects as Json[]).length : ((c.body as Json).changes as Json[]).length}`);
  assert.deepEqual(sizes, ['upsert:8', 'upsert:8', 'upsert:8', 'upsert:3', 'inventory:25', 'inventory:2']);
  for (let i = 0; i < N; i++) assert.equal(s.sq.counts.get(`V_P${i}`), 12);
  assert.deepEqual(s.sc.calls, [], 'no scale prices change, so ScaleConnect is not contacted');
});

test('the dry run page and approval still write nothing; only Send writes', async (t) => {
  const s = await approvedRun({ inv: testInvoice() });
  t.after(() => s.close());
  assert.deepEqual(s.sq.calls, []);
  assert.deepEqual(s.sc.calls, []);
  assert.equal(s.writer.calls, 0);
  assert.equal(s.fetch.calls, 0);
});
