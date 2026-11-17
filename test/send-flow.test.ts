// Sending an approved run: Square (a fake that behaves like the sandbox) first, then the scales
// (a fake ScaleConnect). The dev harness test (send-dev.test.ts) runs the scale side for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, runState } from './runs-fixtures.ts';
import { get } from './server-helpers.ts';
import { acceptPreview, approvedRun, pending, pressSend, pushStep, sendPhase, variation, type SendApp } from './send-fixtures.ts';
import type { Json } from '../src/square/writer.ts';
import { codeUpc, LOCATION, POUND, UPC_CRACKER } from './matching-fixtures.ts';

function upserts(s: SendApp): Json[] {
  return s.sq.calls.filter((c) => c.on === 'upsert').map((c) => c.body as Json);
}

function objectsOf(body: Json): Json[] {
  return ((body.batches as Json[])[0]!.objects as Json[]) ?? [];
}

test('a full send: Square in the skill order, read back, then one scale preview a person accepts, then done', async (t) => {
  const s = await approvedRun({
    before: async (r, mgr) => {
      assert.equal((await decide(r, mgr, '/runs/1/rename', { itemId: 'I_GOUDA', name: 'Gouda Smoked Wheel' })).statusCode, 303);
    },
  });
  t.after(() => s.close());
  assert.equal(runState(s), 'approved');
  const page = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Send to Square, then the scales/);
  assert.match(page.body, /dev ScaleConnect harness on this PC only/);

  const res = await pressSend(s);
  assert.equal(res.statusCode, 303, res.body.match(/<p class="error"[^>]*>([^<]*)/)?.[1] ?? '');
  assert.equal(runState(s), 'sending');
  assert.equal(sendPhase(s), 'scale_preview', s.app.shelf.db.prepare('SELECT message FROM run_sends').get()!.message as string);

  // Order: the rename, then the variations, then stock. Reads come before each write.
  const order = s.sq.calls.map((c) => c.on).filter((o) => o !== 'retrieve' && o !== 'counts');
  assert.deepEqual(order, ['upsert', 'upsert', 'inventory']);
  const [rename, vars] = upserts(s);
  // The rename sends the whole item, with its variation as it was, and nothing else.
  assert.deepEqual(objectsOf(rename!).map((o) => o.type), ['ITEM']);
  assert.equal(((objectsOf(rename!)[0]!.item_data as Json).name), 'Gouda Smoked Wheel 7101');
  assert.equal(rename!.sparse_update, true);
  // Variations: never with their own item, at most 8, whole objects (the cracker keeps its UPC).
  const vo = objectsOf(vars!);
  assert.ok(vo.every((o) => o.type === 'ITEM_VARIATION'));
  assert.ok(vo.length <= 8);
  const cracker = vo.find((o) => o.id === 'V_CRACKER')!;
  assert.equal((cracker.item_variation_data as Json).upc, UPC_CRACKER);
  assert.equal(vars!.sparse_update, true);

  // Square now: the gouda renamed and repriced, the salmon sold by weight with its store override, tracking on.
  assert.equal(((s.sq.items.get('I_GOUDA')!.item_data as Json).name), 'Gouda Smoked Wheel 7101');
  assert.deepEqual((variation(s.sq, 'I_GOUDA', 'V_GOUDA').item_variation_data as Json).price_money, { amount: 1399, currency: 'USD' });
  const salmon = variation(s.sq, 'I_SALMON', 'V_SALMON').item_variation_data as Json;
  assert.equal(salmon.pricing_type, 'FIXED_PRICING');
  assert.equal(salmon.measurement_unit_id, POUND);
  assert.deepEqual(salmon.price_money, { amount: 1999, currency: 'USD' });
  const override = (salmon.location_overrides as Json[]).find((o) => o.location_id === LOCATION)!;
  assert.equal(override.pricing_type, 'FIXED_PRICING');
  assert.deepEqual(override.price_money, { amount: 1999, currency: 'USD' });
  assert.equal(override.track_inventory, true, 'tracking turned on at the store, before the count');
  assert.equal(salmon.upc, codeUpc('4101'), 'the code-built UPC is kept');
  assert.equal(s.sq.counts.get('V_CRACKER'), 24);
  assert.equal(s.sq.counts.get('V_SALMON'), 8);
  // Inventory: no catalog_object_type, a current time.
  const inv = s.sq.calls.find((c) => c.on === 'inventory')!.body as Json;
  assert.ok(!JSON.stringify(inv).includes('catalog_object_type'));

  // The store name sticks to the saved match.
  const m = s.app.shelf.db.prepare("SELECT store_name FROM item_mappings WHERE square_variation_id = 'V_GOUDA'").get() as { store_name: string };
  assert.equal(m.store_name, 'Gouda Smoked Wheel 7101');

  // The report records what Square read back.
  const report = JSON.parse((s.app.shelf.db.prepare('SELECT square_report FROM run_sends').get() as { square_report: string }).square_report);
  assert.equal(report.ok, true);
  assert.equal(report.items.find((i: { variationId: string }) => i.variationId === 'V_SALMON').readBack.perPound, true);

  // Nothing went to a scale yet but the preview. The person sees it and accepts.
  assert.deepEqual(s.sc.applies(), []);
  const step = pushStep(s);
  assert.equal(step.state, 'previewed');
  const sent = s.sc.calls.find((c) => c.tool === 'preview')!.args as { changes: Array<{ target_plu: string; price: string }>; scales?: string[] };
  assert.deepEqual(sent.changes, [
    { action: 'edit', target_plu: '7101', price: '13.99' },
    { action: 'edit', target_plu: '4101', price: '19.99' },
  ]);
  assert.equal(sent.scales, undefined, 'all scales: none named');
  const prev = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.match(prev.body, /Send to the scales/);
  const ok = await acceptPreview(s);
  assert.equal(ok.statusCode, 303);
  assert.equal(s.sc.applies().length, 1);
  assert.equal(runState(s), 'done');
  assert.equal(sendPhase(s), 'done');
  assert.deepEqual(pending(s), []);
  const actions = (s.app.shelf.db.prepare('SELECT action FROM audit_log WHERE run_id = 1').all() as { action: string }[]).map((r) => r.action);
  for (const a of ['run.send.start', 'run.send.square_done', 'run.scales.preview', 'run.scales.acknowledge', 'run.scales.result']) assert.ok(actions.includes(a), a);
});
