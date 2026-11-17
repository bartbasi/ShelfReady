// The scale side of sending, with a fake ScaleConnect: warnings are never acknowledged by the code,
// drift needs its own ticks, a scale that may be frozen blocks its preview, a FRONT-only test run
// ends partial, an apply whose reply is lost is looked up by preview id and never sent twice, and a
// pending scale is resent with a compare of that scale alone and a settle per missed price.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, runState } from './runs-fixtures.ts';
import { get, ORIGIN } from './server-helpers.ts';
import { acceptPreview, approvedRun, pending, pressSend, pushStep, sendPhase, settleFields, variation, type SendApp } from './send-fixtures.ts';
import type { Json } from '../src/square/writer.ts';

function errorOf(body: string): string {
  return body.match(/<p class="error"[^>]*>([^<]*)/)?.[1] ?? '';
}

function sendMessage(s: SendApp): string {
  return (s.app.shelf.db.prepare('SELECT message FROM run_sends WHERE run_id = 1').get() as { message: string }).message;
}

async function page(s: SendApp): Promise<string> {
  const p = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.equal(p.statusCode, 200);
  return p.body;
}

test('a FRONT-only test run: the warning is never accepted by the code, only by a person, and the run ends partial', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s, ['FRONT']);
  assert.equal(sendPhase(s), 'scale_preview');
  const sent = s.sc.calls.find((c) => c.tool === 'preview')!.args as { scales?: string[] };
  assert.deepEqual(sent.scales, ['FRONT']);
  const step = pushStep(s);
  assert.equal(step.preview.mustAcknowledge, true);
  assert.deepEqual(step.preview.warnings.map((w) => w.code), ['scale_not_targeted']);
  const body = await page(s);
  assert.match(body, /scale_not_targeted/);
  assert.match(body, /I have read every warning above/);

  // No tick: refused, and nothing reaches ScaleConnect's apply.
  let res = await acceptPreview(s, { warnings: false });
  assert.equal(res.statusCode, 400);
  assert.match(errorOf(res.body), /tick the box/i);
  // A tick tied to other warnings: refused too.
  res = await decide(s, s.mgr, '/runs/1/send/scales', { stepId: String(step.id), ack: '0'.repeat(32) });
  assert.equal(res.statusCode, 400);
  await s.app.shelf.runner.drain();
  assert.deepEqual(s.sc.applies(), []);
  assert.equal(pushStep(s).state, 'previewed');

  res = await acceptPreview(s);
  assert.equal(res.statusCode, 303);
  assert.deepEqual(s.sc.applies(), [{ previewId: step.previewId, acknowledgeWarnings: true, acknowledgeDrift: [] }]);
  const ack = s.app.shelf.db.prepare("SELECT username, details FROM audit_log WHERE action = 'run.scales.acknowledge'").get() as { username: string; details: string };
  assert.equal(ack.username, 'mgr');
  assert.deepEqual(JSON.parse(ack.details).warnings, ['scale_not_targeted']);
  assert.equal(runState(s), 'partial');
  assert.equal(sendPhase(s), 'partial');
  // FRONT verified; KITCHEN and COUNTER listed as missing both prices.
  assert.deepEqual(
    pending(s).map((p) => `${p.scale} ${p.code} ${p.reason} ${p.price_cents}`),
    ['COUNTER 4101 not_targeted 1999', 'COUNTER 7101 not_targeted 1399', 'KITCHEN 4101 not_targeted 1999', 'KITCHEN 7101 not_targeted 1399'],
  );
  const after = await page(s);
  assert.match(after, /<strong>FRONT<\/strong>: Verified/);
  assert.match(after, /<strong>KITCHEN<\/strong>: Pending \(left out of this test run\)/);
  assert.match(after, /Code 7101, Gouda Smoked 7101: \$13\.99 per pound/);
  // Square was not rolled back.
  assert.deepEqual((variation(s.sq, 'I_GOUDA', 'V_GOUDA').item_variation_data as Json).price_money, { amount: 1399, currency: 'USD' });
});

test('drift on a scale needs its own tick for each token', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  s.sc.held.get('COUNTER')!.set('7101', '17.49');
  await pressSend(s);
  const step = pushStep(s);
  assert.deepEqual(step.preview.driftTokens, ['COUNTER:7101:drift']);
  assert.equal(step.preview.mustAcknowledge, false);
  assert.match(await page(s), /COUNTER:7101:drift/);
  const res = await acceptPreview(s, { drift: false });
  assert.equal(res.statusCode, 400);
  assert.match(errorOf(res.body), /Tick each difference/);
  assert.deepEqual(s.sc.applies(), []);
  await acceptPreview(s);
  assert.deepEqual(s.sc.applies(), [{ previewId: step.previewId, acknowledgeWarnings: false, acknowledgeDrift: ['COUNTER:7101:drift'] }]);
  assert.equal(runState(s), 'done');
});

test('a scale that may be frozen blocks its preview; a new one leaves it out; resend after someone looked, compare alone, then a settle', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  s.sc.unplugged.add('KITCHEN');
  await pressSend(s);
  let step = pushStep(s);
  assert.equal(step.state, 'blocked');
  assert.deepEqual(step.preview.mayBeFrozen, ['KITCHEN']);
  assert.match(step.preview.blockedWhy, /KITCHEN gave no reply/);
  let body = await page(s);
  assert.match(body, /KITCHEN gave no reply/);
  assert.doesNotMatch(body, /Send to the scales/);
  let res = await decide(s, s.mgr, '/runs/1/send/scales', { stepId: String(step.id), ack: step.preview.digest });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(s.sc.applies(), []);

  // A new preview leaves KITCHEN out, with a warning a person accepts.
  assert.equal((await decide(s, s.mgr, '/runs/1/send/scale-preview')).statusCode, 303);
  await s.app.shelf.runner.drain();
  step = pushStep(s);
  assert.equal(step.state, 'previewed');
  assert.deepEqual(step.preview.leftOut, ['KITCHEN']);
  assert.deepEqual(step.preview.warnings.map((w) => w.code), ['scale_left_out']);
  await acceptPreview(s);
  assert.equal(runState(s), 'partial');
  assert.deepEqual(pending(s).map((p) => `${p.scale} ${p.code} ${p.reason}`), ['KITCHEN 4101 may_be_frozen', 'KITCHEN 7101 may_be_frozen']);
  body = await page(s);
  assert.match(body, /May be frozen\. Someone should look at it\./);

  // Resend: the person must confirm someone looked.
  res = await decide(s, s.mgr, '/runs/1/send/resend/look', { scale: 'KITCHEN' });
  assert.equal(res.statusCode, 400);
  assert.match(errorOf(res.body), /confirm someone has looked at KITCHEN/);
  // Still unplugged: the compare of KITCHEN alone gets no answer, and nothing is sent.
  assert.equal((await decide(s, s.mgr, '/runs/1/send/resend/look', { scale: 'KITCHEN', looked: '1' })).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.match(await page(s), /KITCHEN still did not answer/);
  assert.equal(s.sc.calls.filter((c) => c.tool === 'settle_preview').length, 0);
  // Plugged back in and looked at: compare alone clears the flag, then a settle per missed price.
  s.sc.unplugged.delete('KITCHEN');
  await decide(s, s.mgr, '/runs/1/send/resend/look', { scale: 'KITCHEN', looked: '1' });
  await s.app.shelf.runner.drain();
  const compares = s.sc.calls.filter((c) => c.tool === 'compare').map((c) => c.args);
  assert.deepEqual(compares, [{ scale: 'KITCHEN' }, { scale: 'KITCHEN' }], 'only ever KITCHEN alone');
  assert.equal(s.sc.calls.filter((c) => c.tool === 'settle_preview').length, 2);
  body = await page(s);
  assert.match(body, /Settle PLU 7101 on KITCHEN/);
  assert.match(body, /KITCHEN:7101:settle/);
  // One yes, tied to exactly what was shown.
  const fields = await settleFields(s, 'KITCHEN');
  assert.deepEqual(Object.keys(fields).filter((k) => k.startsWith('drift_')).length, 2, 'a box for each drift token');
  res = await decide(s, s.mgr, '/runs/1/send/resend/accept', { ...fields, digest: '1'.repeat(32) });
  assert.equal(res.statusCode, 400);
  // The yes box without the drift boxes: refused too.
  res = await decide(s, s.mgr, '/runs/1/send/resend/accept', { scale: 'KITCHEN', digest: fields.digest! });
  assert.equal(res.statusCode, 400);
  assert.match(errorOf(res.body), /Tick each difference/);
  res = await decide(s, s.mgr, '/runs/1/send/resend/accept', fields);
  assert.equal(res.statusCode, 303, errorOf(res.body));
  await s.app.shelf.runner.drain();
  const settles = s.sc.applies().slice(1);
  assert.equal(settles.length, 2);
  assert.ok(settles.every((a) => a.acknowledgeWarnings === true && a.acknowledgeDrift.length === 1 && a.acknowledgeDrift[0]!.startsWith('KITCHEN:')));
  assert.equal(runState(s), 'done', sendMessage(s));
  assert.equal(s.sc.held.get('KITCHEN')!.get('7101'), '13.99');
  assert.deepEqual(pending(s).map((p) => p.state), ['resolved', 'resolved']);
});

test('an apply whose reply is lost is looked up by preview id, never applied twice', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s);
  s.sc.loseNextApply = true;
  await acceptPreview(s);
  assert.equal(s.sc.applies().length, 1);
  assert.ok(s.sc.calls.some((c) => c.tool === 'get_change'), 'looked up by preview id');
  assert.equal(runState(s), 'done');

  // And when ScaleConnect has no result yet: the step waits as unknown; a person looks it up later.
  const s2 = await approvedRun();
  t.after(() => s2.close());
  await pressSend(s2);
  s2.sc.loseNextApply = true;
  const real = s2.sc.getChange.bind(s2.sc);
  s2.sc.getChange = async () => ({ isError: false, data: { summary: 'Not applied.', ok: true, applied: false }, kind: 'not_applied' });
  await acceptPreview(s2);
  assert.equal(pushStep(s2).state, 'unknown');
  assert.equal(sendPhase(s2), 'sending_scales');
  assert.match(await page(s2), /Look up the result/);
  s2.sc.getChange = real;
  assert.equal((await decide(s2, s2.mgr, '/runs/1/send/lookup')).statusCode, 303);
  await s2.app.shelf.runner.drain();
  assert.equal(s2.sc.applies().length, 1, 'still applied once');
  assert.equal(runState(s2), 'done');
});

test('after a restart in the middle of an apply, ShelfReady only looks the result up', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s);
  const step = pushStep(s);
  await decide(s, s.mgr, '/runs/1/send/scales', { stepId: String(step.id) });
  // As if the apply had gone out and ShelfReady stopped before the answer.
  s.app.shelf.db.prepare("UPDATE scale_steps SET state = 'applying' WHERE id = ?").run(step.id);
  s.app.shelf.db.prepare("UPDATE run_jobs SET state = 'running' WHERE kind = 'send_scales'").run();
  s.app.shelf.runner.recover();
  await s.app.shelf.runner.drain();
  assert.deepEqual(s.sc.applies(), [], 'never applied again');
  assert.ok(s.sc.calls.some((c) => c.tool === 'get_change'));
  assert.equal(pushStep(s).state, 'unknown');
});

test('a scale read cut short by a restart is not run again on its own', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s);
  await decide(s, s.mgr, '/runs/1/send/scale-preview');
  s.app.shelf.db.prepare("UPDATE run_jobs SET state = 'running' WHERE kind = 'scale_preview'").run();
  const before = s.sc.calls.length;
  s.app.shelf.runner.recover();
  await s.app.shelf.runner.drain();
  assert.equal(s.sc.calls.length, before);
  assert.match((s.app.shelf.db.prepare('SELECT message FROM runs WHERE id = 1').get() as { message: string }).message, /not run again on its own/);
});

test('rule 12: an item with a scale code that would not end sold by weight stops the send before any write', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  // Square lost the gouda's per-pound unit without its version moving.
  delete (variation(s.sq, 'I_GOUDA', 'V_GOUDA').item_variation_data as Json).measurement_unit_id;
  await pressSend(s);
  assert.equal(sendPhase(s), 'square_failed');
  assert.match(sendMessage(s), /must be sold by weight in Square at the scale price/);
  assert.deepEqual(s.sq.calls.filter((c) => c.on === 'upsert' || c.on === 'inventory'), []);
  assert.deepEqual(s.sc.calls, []);
});

test('send routes: managers only, with the form token', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  const anon = await s.app.inject({ method: 'GET', url: '/runs/1/send' });
  assert.notEqual(anon.statusCode, 200);
  const noToken = await s.app.inject({ method: 'POST', url: '/runs/1/send/start', headers: { cookie: s.mgr.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'hash=x' });
  assert.equal(noToken.statusCode, 403);
  const routes = s.app.shelf.routes.filter((r) => r.url.startsWith('/runs/:id/send'));
  assert.ok(routes.length >= 9);
  assert.ok(routes.every((r) => r.access === 'user'));
  assert.deepEqual(s.sq.calls, []);
});
