// Sending a run with the real ScaleConnect client against the dev harness (ScaleConnect's real
// MCP server and three fake scales on 127.0.0.1). Square is the fake from send-fixtures.ts.
// Needs the harness: scripts/dev-scaleconnect/dev-sc.sh start. Skipped when it is not running.
//
// 1. KITCHEN unplugged: the first preview is blocked (KITCHEN may be frozen), a new one leaves it
//    out with a warning a person accepts, the run ends partial with KITCHEN pending. KITCHEN back:
//    a person confirms someone looked, a compare of KITCHEN alone, a settle per missed price, one
//    yes, then done.
// 2. A FRONT-only test run ends partial with KITCHEN and COUNTER pending, then a resend to each.
// 3. The apply's reply is lost: the result is found by preview id, and nothing is applied twice.
// The connection goes through the same guard the app uses: the dev address only, and the dev
// sentinel item in the catalog before anything reads or writes a scale.

import { test } from 'node:test';
import { withHarnessLock } from './harness-lock.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectScaleConnect, type ScaleApi } from '../src/scaleconnect/connection.ts';
import { DEV_MCP_URL, readDevConnection } from '../src/scaleconnect/dev-connection.ts';
import { image, invoice, line } from './invoice-fixtures.ts';
import { CAT_CHEESE, CAT_MEAT, item, POUND } from './matching-fixtures.ts';
import { decide, runState } from './runs-fixtures.ts';
import { get } from './server-helpers.ts';
import { acceptPreview, approvedRun, pending, pressSend, pushStep, sendPhase, settleFields, type SendApp } from './send-fixtures.ts';

const DEV_SC = fileURLToPath(new URL('../scripts/dev-scaleconnect/dev-sc.sh', import.meta.url));
const runFile = promisify(execFile);
const PLUS = ['8203', '8704'];

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: u.hostname, port: Number(u.port) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const conn = await readDevConnection();
let skip: string | false = false;
if (!conn) skip = 'dev ScaleConnect harness is not running. Start it with: scripts/dev-scaleconnect/dev-sc.sh start';
else if (!(await reachable(conn.url))) skip = 'dev ScaleConnect harness left its connection file but its MCP server does not answer. Restart it.';

async function harness(...args: string[]): Promise<void> {
  await runFile(DEV_SC, args, { timeout: 60_000 });
}

const devApi = (): Promise<ScaleApi> => connectScaleConnect({ url: conn!.url, token: conn!.token, allowLive: false, clientName: 'shelfready-send-test' });

async function catalogCents(plu: string): Promise<number> {
  const api = await devApi();
  try {
    const r = await api.getItem({ plu });
    const [w, f = '00'] = String((r.data.item as { price: string }).price).split('.');
    return Number(w) * 100 + Number(f.padEnd(2, '0'));
  } finally {
    await api.close();
  }
}

/**
 * An invoice for the two dev items whose new prices differ from what the dev catalog holds now,
 * with Square's prices a dollar lower (well under the 30 percent big-change tick).
 */
async function devRun(t: { after(fn: () => unknown): void }, opts: { wrap?: (api: ScaleApi) => ScaleApi } = {}): Promise<{ s: SendApp; cents: Record<string, number> }> {
  const cents: Record<string, number> = {};
  const lines = [];
  const extra = [];
  for (const [i, plu] of PLUS.entries()) {
    const now = await catalogCents(plu);
    const whole = now < 4000 ? Math.floor(now / 100) + 1 : Math.floor(now / 100) - 1;
    cents[plu] = whole * 100 + 99;
    // 2 x cost + 1 lands at whole + 0.50, which rounds up to whole.99.
    const cost = ((whole - 1) / 2 + 0.25).toFixed(2);
    lines.push(line({ item_number: `D${plu}`, description: `DEV ITEM ${plu}`, unit: 'LB', qty_shipped: '1', weight: '5', unit_price: cost, extension: (Number(cost) * 5).toFixed(2) }));
    extra.push(item({ id: `I_DEV${i}`, name: `${i === 0 ? 'Genoa Salami' : 'Comte 18 Month'} ${plu}`, category: i === 0 ? CAT_MEAT : CAT_CHEESE, variations: [{ id: `V_DEV${i}`, cents: cents[plu]! - 100, unit: POUND }] }));
  }
  const total = lines.reduce((a, l) => a + Number(l.extension), 0).toFixed(2);
  const s = await approvedRun({
    inv: invoice({ supplier_name: 'Hilltop Provisions', images: [image()], lines, total }),
    extra,
    picks: [
      [1, 'V_DEV0'],
      [2, 'V_DEV1'],
    ],
    deps: { scaleApi: async () => (opts.wrap ? opts.wrap(await devApi()) : devApi()) },
  });
  t.after(() => s.close());
  return { s, cents };
}

async function unfinished(): Promise<Array<{ scale: string; plu: string; kind: string }>> {
  const api = await devApi();
  try {
    const r = await api.listScales();
    return ((r.data.unfinished as Array<{ scale: string; plu: string; kind: string }>) ?? []).filter((u) => PLUS.includes(u.plu));
  } finally {
    await api.close();
  }
}

async function resendTo(s: SendApp, scale: string): Promise<void> {
  assert.equal((await decide(s, s.mgr, '/runs/1/send/resend/look', { scale, looked: '1' })).statusCode, 303);
  await s.app.shelf.runner.drain();
  const fields = await settleFields(s, scale);
  assert.ok(fields.digest, `a settle for ${scale} waits for a yes`);
  assert.ok(Object.keys(fields).some((k) => k.startsWith('drift_')), 'each drift token has its own box');
  const res = await decide(s, s.mgr, '/runs/1/send/resend/accept', fields);
  assert.equal(res.statusCode, 303);
  await s.app.shelf.runner.drain();
}

test('dev harness: KITCHEN unplugged ends partial with KITCHEN pending, then the resend after someone looked', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  assert.equal(conn!.url, DEV_MCP_URL);
  await harness('plug', 'KITCHEN');
  const { s, cents } = await devRun(t);
  await harness('unplug', 'KITCHEN');
  try {
    await pressSend(s);
    assert.equal(sendPhase(s), 'scale_preview');
    let step = pushStep(s);
    t.diagnostic(`first preview: state=${step.state} may_be_frozen=${JSON.stringify(step.preview.mayBeFrozen)}`);
    assert.equal(step.state, 'blocked', 'a preview whose read found KITCHEN silent is never applied');
    assert.deepEqual(step.preview.mayBeFrozen, ['KITCHEN']);
    assert.equal((await decide(s, s.mgr, '/runs/1/send/scale-preview')).statusCode, 303);
    await s.app.shelf.runner.drain();
    step = pushStep(s);
    t.diagnostic(`second preview: left_out=${JSON.stringify(step.preview.leftOut)} warnings=${JSON.stringify(step.preview.warnings.map((w) => w.code))}`);
    assert.deepEqual(step.preview.leftOut, ['KITCHEN']);
    assert.ok(step.preview.warnings.some((w) => w.code === 'scale_left_out'));
    const refused = await acceptPreview(s, { warnings: false });
    assert.equal(refused.statusCode, 400, 'never sent without the person ticking the warning');
    await acceptPreview(s);
    assert.equal(runState(s), 'partial');
    assert.deepEqual(pending(s).map((p) => `${p.scale} ${p.code} ${p.reason} ${p.price_cents}`), [`KITCHEN 8203 may_be_frozen ${cents['8203']}`, `KITCHEN 8704 may_be_frozen ${cents['8704']}`]);
    for (const plu of PLUS) assert.equal(await catalogCents(plu), cents[plu], 'the catalog took the new price');
  } finally {
    await harness('plug', 'KITCHEN');
  }
  await resendTo(s, 'KITCHEN');
  t.diagnostic(`after resend: ${JSON.stringify(pending(s))}`);
  assert.equal(runState(s), 'done');
  assert.deepEqual(await unfinished(), [], 'KITCHEN is no longer missing either price');
}));

test('dev harness: a FRONT-only test run ends partial; a resend to KITCHEN and COUNTER finishes it', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await harness('plug', 'KITCHEN');
  const { s } = await devRun(t);
  await pressSend(s, ['FRONT']);
  const step = pushStep(s);
  assert.ok(step.preview.warnings.some((w) => w.code === 'scale_not_targeted'));
  await acceptPreview(s);
  assert.equal(runState(s), 'partial');
  assert.deepEqual([...new Set(pending(s).map((p) => `${p.scale} ${p.reason}`))], ['COUNTER not_targeted', 'KITCHEN not_targeted']);
  const left = await unfinished();
  t.diagnostic(`unfinished after FRONT only: ${JSON.stringify(left.map((u) => `${u.scale} ${u.kind} ${u.plu}`))}`);
  await resendTo(s, 'KITCHEN');
  assert.equal(runState(s), 'partial');
  await resendTo(s, 'COUNTER');
  assert.equal(runState(s), 'done');
  assert.deepEqual(await unfinished(), []);
}));

test('dev harness: a lost apply reply is found by preview id, and the change is applied once', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await harness('plug', 'KITCHEN');
  let applies = 0;
  const { s, cents } = await devRun(t, {
    wrap: (api) => ({
      close: () => api.close(),
      listScales: () => api.listScales(),
      getItem: (x) => api.getItem(x),
      previewChanges: (c, o) => api.previewChanges(c, o),
      previewSettleDrift: (sc, take, x) => api.previewSettleDrift(sc, take, x),
      compareScale: (sc, m) => api.compareScale(sc, m),
      getChange: (x) => api.getChange(x),
      applyChanges: async (id, acks) => {
        applies++;
        await api.applyChanges(id, acks);
        // The change ran, but its answer never reaches ShelfReady.
        return { kind: 'unknown', previewId: id, isError: true, message: 'The apply did not return (client timeout).' };
      },
    }),
  });
  await pressSend(s);
  await acceptPreview(s);
  assert.equal(applies, 1);
  assert.equal(runState(s), 'done', JSON.stringify(pending(s)));
  for (const plu of PLUS) assert.equal(await catalogCents(plu), cents[plu]);
}));
