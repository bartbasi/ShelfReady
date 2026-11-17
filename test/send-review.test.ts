// Fixes from the step 7 code and security reviews: lost replies stay unknown until Square or a
// person says otherwise, expired approvals and never-applied scale changes have a way on, resends
// never put back a wrong price, sibling variations, corrections before Send, the scales a send may
// write to, the recent password, and audit entries with the values written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAT_CRACKERS, item, upcA } from './matching-fixtures.ts';
import { image, invoice, line } from './invoice-fixtures.ts';
import { decide, runState, signIn } from './runs-fixtures.ts';
import { ageReauth, get, MANAGER_PW, ORIGIN } from './server-helpers.ts';
import { acceptPreview, approvedRun, dryRunHash, pending, pressSend, pushStep, sendPhase, settleFields, type SendApp } from './send-fixtures.ts';
import type { Json } from '../src/square/writer.ts';
import { makeConfig } from '../src/server/config.ts';
import type { SheetCheckFn } from '../src/runs/sheet-check.ts';

function errorOf(body: string): string {
  return body.match(/<p class="error"[^>]*>([^<]*)/)?.[1] ?? '';
}

function writeRows(s: SendApp): Array<{ id: number; step: string; state: string; attempts: number; idempotency_key: string }> {
  return s.app.shelf.db.prepare('SELECT id, step, state, attempts, idempotency_key FROM square_writes WHERE run_id = 1 ORDER BY id').all() as Array<{ id: number; step: string; state: string; attempts: number; idempotency_key: string }>;
}

async function sendAgain(s: SendApp) {
  const res = await decide(s, s.mgr, '/runs/1/send/start', { hash: dryRunHash(s) });
  await s.app.shelf.runner.drain();
  return res;
}

test('a lost reply stays unknown when the retry is refused locally or by Square, Stop is refused, and a person settles it', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  s.sq.fail({ on: 'upsert', mode: 'lost-after' });
  await pressSend(s);
  // The retry never reaches Square (as if the token were gone).
  s.sq.fail({ on: 'upsert', mode: 'not-sent' });
  await sendAgain(s);
  let row = writeRows(s).find((w) => w.step === 'variations')!;
  assert.equal(row.state, 'sending', 'still unknown: the first try may have landed');
  assert.equal(row.attempts, 1, 'the local refusal is not counted as a try');
  // Square answers 401 on the next retry: still unknown.
  s.sq.fail({ on: 'upsert', mode: 'refuse', status: 401, codes: ['UNAUTHORIZED'] });
  await sendAgain(s);
  row = writeRows(s).find((w) => w.step === 'variations')!;
  assert.equal(row.state, 'sending');
  assert.equal(sendPhase(s), 'square_failed');
  // Not "nothing reached Square": the send cannot be stopped.
  const stop = await decide(s, s.mgr, '/runs/1/send/stop', { confirm: '1' });
  assert.equal(stop.statusCode, 409);
  const page = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.match(page.body, /Square writes with no answer/);
  // A person checked Square: it landed. Then Send again finishes without writing it again.
  assert.equal((await decide(s, s.mgr, '/runs/1/send/writes/check', { writeId: String(row.id), landed: 'yes' })).statusCode, 400, 'the tick is needed');
  assert.equal((await decide(s, s.mgr, '/runs/1/send/writes/check', { writeId: String(row.id), landed: 'yes', confirm: '1' })).statusCode, 303);
  await sendAgain(s);
  assert.equal(sendPhase(s), 'scale_preview');
  assert.equal(s.sq.applied.filter((a) => a.on === 'upsert').length, 1, 'the variations landed once');
  assert.equal(new Set(writeRows(s).filter((w) => w.step === 'variations').map((w) => w.idempotency_key)).size, 1, 'never a new key');
  const audit = s.app.shelf.db.prepare("SELECT username FROM audit_log WHERE action = 'run.send.write_checked'").get() as { username: string };
  assert.equal(audit.username, 'mgr');
});

test('a correction whose answer was lost and whose body is too old to replay waits for a person, never a new key', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s);
  await acceptPreview(s);
  await decide(s, s.mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' });
  s.sq.fail({ on: 'inventory', mode: 'lost-after' });
  await decide(s, s.mgr, '/runs/1/send/corrections');
  await s.app.shelf.runner.drain();
  assert.equal(s.sq.counts.get('V_CRACKER'), 0);
  s.advance(25 * 3600_000);
  s.mgr = await signIn(s);
  await decide(s, s.mgr, '/runs/1/send/corrections');
  await s.app.shelf.runner.drain();
  assert.equal(s.sq.counts.get('V_CRACKER'), 0, 'never taken out twice');
  const row = writeRows(s).find((w) => w.step === 'correction')!;
  assert.equal(row.state, 'sending');
  assert.equal(writeRows(s).filter((w) => w.step === 'correction').length, 1, 'no new key');
  assert.match((await get(s, '/runs/1/send', s.mgr.cookie)).body, /Square writes with no answer/);
  await decide(s, s.mgr, '/runs/1/send/writes/check', { writeId: String(row.id), landed: 'yes', confirm: '1' });
  const c = s.app.shelf.db.prepare('SELECT state FROM run_corrections WHERE run_id = 1 AND line = 2').get() as { state: string };
  assert.equal(c.state, 'sent');
});

test('after the approval expires with part of the run in Square, Send again finishes only what went', async (t) => {
  const s = await approvedRun({
    config: { approvalMaxAgeHours: 1 },
    before: async (r, mgr) => {
      await decide(r, mgr, '/runs/1/rename', { itemId: 'I_GOUDA', name: 'Gouda Smoked Wheel' });
    },
  });
  t.after(() => s.close());
  s.sq.fail({ on: 'upsert', mode: 'refuse', nth: 2, codes: ['INVALID_VALUE'] });
  await pressSend(s);
  assert.equal(sendPhase(s), 'square_failed');
  s.advance(61 * 60_000);
  s.mgr = await signIn(s);
  const page = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.match(page.body, /Send again only resends/);
  const res = await sendAgain(s);
  assert.equal(res.statusCode, 303, errorOf(res.body));
  // Nothing new was written: no prices, no stock. The scales get nothing, since Square got no price.
  assert.deepEqual(s.sq.calls.filter((c) => c.on === 'upsert' || c.on === 'inventory').map((c) => c.on), ['upsert', 'upsert']);
  assert.equal(runState(s), 'done');
  assert.deepEqual(s.sc.calls, []);
  const report = JSON.parse((s.app.shelf.db.prepare('SELECT square_report FROM run_sends').get() as { square_report: string }).square_report);
  assert.deepEqual(report.scaleSkipped.sort(), ['4101', '7101']);
  assert.ok(report.warnings.some((w: string) => /approval expired/.test(w)));
});

test('a scale change that never reached ScaleConnect is recorded as never applied, and a new preview can follow', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  s.sc.expiresAt = '2026-11-06T18:15:00Z';
  await pressSend(s);
  s.sc.dropNextApply = true;
  await acceptPreview(s);
  assert.equal(pushStep(s).state, 'unknown');
  // Still within the preview's life: only unknown.
  await decide(s, s.mgr, '/runs/1/send/lookup');
  await s.app.shelf.runner.drain();
  assert.equal(pushStep(s).state, 'unknown');
  s.advance(30 * 60_000);
  await decide(s, s.mgr, '/runs/1/send/lookup');
  await s.app.shelf.runner.drain();
  assert.equal(pushStep(s).state, 'refused');
  assert.equal(sendPhase(s), 'scale_preview');
  assert.match((await get(s, '/runs/1/send', s.mgr.cookie)).body, /never reached ScaleConnect/);
  assert.deepEqual(s.sc.applies(), []);
  s.sc.expiresAt = '2099-01-01T00:00:00Z';
  s.mgr = await signIn(s);
  await decide(s, s.mgr, '/runs/1/send/scale-preview');
  await s.app.shelf.runner.drain();
  await acceptPreview(s);
  assert.equal(runState(s), 'done');
  assert.equal(s.sc.applies().length, 1);
});

test('a resend never offers a settle that would put a different price on the scale', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  s.sc.unplugged.add('KITCHEN');
  await pressSend(s);
  await decide(s, s.mgr, '/runs/1/send/scale-preview');
  await s.app.shelf.runner.drain();
  await acceptPreview(s);
  assert.equal(runState(s), 'partial');
  s.sc.unplugged.delete('KITCHEN');
  // Someone changed 7101 in ScaleConnect's list since: a settle would send that price, not ours.
  s.sc.catalog.set('7101', '15.00');
  await decide(s, s.mgr, '/runs/1/send/resend/look', { scale: 'KITCHEN', looked: '1' });
  await s.app.shelf.runner.drain();
  const settles = s.sc.calls.filter((c) => c.tool === 'settle_preview').map((c) => (c.args as { target: { plu: string } }).target.plu);
  assert.deepEqual(settles, ['4101']);
  const body = (await get(s, '/runs/1/send', s.mgr.cookie)).body;
  assert.match(body, /Code 7101: ScaleConnect&#39;s list holds 15\.00, not this invoice&#39;s 13\.99/);
  await decide(s, s.mgr, '/runs/1/send/resend/accept', await settleFields(s, 'KITCHEN'));
  await s.app.shelf.runner.drain();
  assert.equal(runState(s), 'partial');
  assert.deepEqual(pending(s).filter((p) => p.state === 'pending').map((p) => p.code), ['7101']);
});

test('a stock-only sibling variation is not taken for an outside change when another variation of its item was written', async (t) => {
  const upc1 = upcA('00088800001');
  const upc2 = upcA('00088800002');
  const multi = item({ id: 'I_MULTI', name: 'Testmaker - Biscuits', category: CAT_CRACKERS, variations: [{ id: 'V_M1', name: 'Plain', upc: upc1, cents: 599 }, { id: 'V_M2', name: 'Seeded', upc: upc2, cents: 699 }] });
  ((multi.item_data as Json).variations as Json[])[1]!.item_variation_data = { ...(((multi.item_data as Json).variations as Json[])[1]!.item_variation_data as Json), track_inventory: true };
  const inv = invoice({
    supplier_name: 'Hilltop Provisions',
    images: [image()],
    lines: [
      line({ item_number: 'M1', upc: upc1, description: 'TESTMAKER BISCUITS PLAIN', pack_size: '12/4.4Z', unit: 'CS', qty_shipped: '1', unit_price: '30.00', extension: '30.00' }),
      line({ item_number: 'M2', upc: upc2, description: 'TESTMAKER BISCUITS SEEDED', pack_size: '12/4.4Z', unit: 'CS', qty_shipped: '1', unit_price: '30.00', extension: '30.00' }),
    ],
    total: '60.00',
  });
  const s = await approvedRun({ inv, extra: [multi], picks: [] });
  t.after(() => s.close());
  await pressSend(s);
  assert.equal(runState(s), 'done', (s.app.shelf.db.prepare('SELECT message FROM run_sends').get() as { message: string }).message);
  assert.equal(s.sq.counts.get('V_M1'), 12);
  assert.equal(s.sq.counts.get('V_M2'), 12);
});

test('a correction recorded before Send is folded in: nothing at all is sent for an item where nothing arrived', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  assert.equal((await decide(s, s.mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' })).statusCode, 303);
  await pressSend(s);
  const text = JSON.stringify(s.sq.calls.filter((c) => c.on === 'upsert' || c.on === 'inventory'));
  assert.ok(!text.includes('V_CRACKER'), 'no price, no count, no waste for the crackers');
  assert.equal(s.sq.counts.get('V_CRACKER'), 3, 'Square keeps its count');
  const c = s.app.shelf.db.prepare('SELECT state FROM run_corrections WHERE run_id = 1 AND line = 2').get() as { state: string };
  assert.equal(c.state, 'sent');
  assert.ok(s.app.shelf.db.prepare("SELECT 1 FROM audit_log WHERE action = 'run.correct.folded'").get());
  assert.equal(sendPhase(s), 'scale_preview');
});

test('only the scales the config allows get writes; FRONT alone by default', async (t) => {
  assert.deepEqual(makeConfig({}).writeScales, ['FRONT']);
  assert.throws(() => makeConfig({ allowLiveScaleConnect: true }), /writeScales/);
  assert.throws(() => makeConfig({ allowSquareProduction: 'yes' as unknown as boolean }), /allowSquareProduction/);
  const s = await approvedRun({ config: { writeScales: ['FRONT'] } });
  t.after(() => s.close());
  const page = (await get(s, '/runs/1/send', s.mgr.cookie)).body;
  assert.match(page, /name="scale_FRONT"/);
  assert.doesNotMatch(page, /name="scale_KITCHEN"/);
  assert.match(page, /Not allowed to get writes \(server config\): KITCHEN, COUNTER/);
  const res = await pressSend(s, ['FRONT', 'KITCHEN']);
  assert.equal(res.statusCode, 400);
  assert.match(errorOf(res.body), /KITCHEN may not get writes/);
  await pressSend(s, ['FRONT']);
  await acceptPreview(s);
  assert.equal(runState(s), 'partial');
  const look = await decide(s, s.mgr, '/runs/1/send/resend/look', { scale: 'KITCHEN', looked: '1' });
  assert.equal(look.statusCode, 400);
  assert.match(errorOf(look.body), /KITCHEN may not get writes/);
});

test('Send needs the password typed recently, for a manager too', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  ageReauth(s, 16 * 60_000);
  const res = await pressSend(s);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /Confirm it is you/);
  assert.match(res.body, /name="next" value="\/runs\/1\/send"/);
  assert.deepEqual(s.sq.calls, []);
  assert.equal(runState(s), 'approved');
  const re = await s.app.inject({ method: 'POST', url: '/reauth', headers: { cookie: s.mgr.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ _csrf: s.mgr.csrf, next: '/runs/1/send', password: MANAGER_PW }).toString() });
  assert.equal(re.statusCode, 303);
  assert.equal(re.headers.location, '/runs/1/send');
  assert.equal((await pressSend(s)).statusCode, 303);
  assert.equal(runState(s), 'sending');
});

test('each Square write is audited with its ids, prices, units and stock', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s);
  const rows = (s.app.shelf.db.prepare("SELECT details FROM audit_log WHERE action = 'run.send.square_write'").all() as Array<{ details: string }>).map((r) => JSON.parse(r.details));
  const vars = rows.find((r) => r.step === 'variations');
  const gouda = vars.objects.find((o: { id: string }) => o.id === 'V_GOUDA');
  assert.equal(gouda.priceCents, 1399);
  assert.equal(gouda.pricingType, 'FIXED_PRICING');
  assert.ok(gouda.unitId);
  const stock = rows.find((r) => r.step === 'inventory');
  assert.ok(stock.objects.some((o: { variationId: string; quantity: string }) => o.variationId === 'V_CRACKER' && o.quantity === '24'));
  assert.ok(!JSON.stringify(rows).includes('EAAA'), 'no token');
});

test('after a send that finished without some prices, their cards do not print and cannot be reprinted', async (t) => {
  const passing: SheetCheckFn = async (_docx, slots) => ({
    state: 'passed',
    result: { pages: slots.length / 4, expectedPages: slots.length / 4, pageCountOk: true, failures: [], mostCopyLines: 3, maxCopyLines: 10, missingFonts: [] },
    message: 'Every card is whole.',
  });
  const s = await approvedRun({
    config: { approvalMaxAgeHours: 1 },
    deps: { cardSheetCheck: passing },
    before: async (r, mgr) => {
      await decide(r, mgr, '/runs/1/rename', { itemId: 'I_GOUDA', name: 'Gouda Smoked Wheel' });
    },
  });
  t.after(() => s.close());
  assert.equal((await decide(s, s.mgr, '/runs/1/card-sheet')).statusCode, 303);
  await s.app.shelf.sheetChecker.drain();
  s.sq.fail({ on: 'upsert', mode: 'refuse', nth: 2, codes: ['INVALID_VALUE'] });
  await pressSend(s);
  s.advance(61 * 60_000);
  s.mgr = await signIn(s);
  await sendAgain(s);
  assert.equal(runState(s), 'done');
  const sheet = s.app.shelf.db.prepare('SELECT id FROM card_sheets ORDER BY id LIMIT 1').get() as { id: number };
  const dl = await get(s, `/runs/1/card-sheets/${sheet.id}`, s.mgr.cookie);
  assert.equal(dl.statusCode, 409);
  assert.match(dl.body, /Square never got the new price for [^<]*Gouda/);
  const cards = (JSON.parse((s.app.shelf.db.prepare('SELECT dry_run FROM runs WHERE id = 1').get() as { dry_run: string }).dry_run) as { cards: { cards: Array<{ variationId: string }> } }).cards.cards;
  const at = cards.findIndex((c) => c.variationId === 'V_GOUDA');
  const re = await decide(s, s.mgr, '/runs/1/card-sheet/reprint', { [`card_${at}`]: '1' });
  assert.equal(re.statusCode, 409);
  assert.match(re.body, /Square never got the new price/);
});

test('an item folded out because nothing arrived does not get its new name either', async (t) => {
  const s = await approvedRun({
    before: async (r, mgr) => {
      assert.equal((await decide(r, mgr, '/runs/1/rename', { itemId: 'I_CRACKER', name: 'Bluecrest - Sea Salt Crackers' })).statusCode, 303);
    },
  });
  t.after(() => s.close());
  await decide(s, s.mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' });
  await pressSend(s);
  assert.ok(!JSON.stringify(s.sq.calls.filter((c) => c.on === 'upsert')).includes('I_CRACKER'));
  assert.equal(((s.sq.items.get('I_CRACKER')!.item_data as Json).name), 'Bluecrest - Crackers, Sea Salt');
  assert.equal(sendPhase(s), 'scale_preview');
});

test('sending corrections needs the password typed recently', async (t) => {
  const s = await approvedRun();
  t.after(() => s.close());
  await pressSend(s);
  await acceptPreview(s);
  await decide(s, s.mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' });
  ageReauth(s, 16 * 60_000);
  const res = await decide(s, s.mgr, '/runs/1/send/corrections');
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /Confirm it is you/);
});

test('a ScaleConnect address that cannot be used stops the send before anything goes to Square', async (t) => {
  const s = await approvedRun({ deps: { scaleApi: undefined } });
  t.after(() => s.close());
  const res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(errorOf(res.body), /No ScaleConnect address is set/);
  assert.deepEqual(s.sq.calls, []);
  assert.equal(runState(s), 'approved');
});

test('a stored scale preview naming a scale outside writeScales is never accepted', async (t) => {
  const s = await approvedRun({ config: { writeScales: ['FRONT'] } });
  t.after(() => s.close());
  await pressSend(s, ['FRONT']);
  const st = pushStep(s);
  s.app.shelf.db.prepare("UPDATE scale_steps SET preview = json_set(preview, '$.scales', json('[\"FRONT\",\"COUNTER\"]')) WHERE id = ?").run(st.id);
  const res = await acceptPreview(s);
  assert.equal(res.statusCode, 409);
  assert.match(errorOf(res.body), /COUNTER, which may not get writes/);
  assert.deepEqual(s.sc.applies(), []);
});
