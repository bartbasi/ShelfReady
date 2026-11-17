// Going live (docs/GO-LIVE.md): a run read in live Square is sent to live Square and every scale,
// never mixed with the sandbox, with Square first and the scales only after Square fully
// succeeded (store/docs/DECISIONS.md decision 1), and rule 12 holding. Fakes only: the fake Square write
// API, the fake ScaleConnect, and a catalog source that follows the environment like the real one.
// Invented values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decide, runState } from './runs-fixtures.ts';
import { get, logText } from './server-helpers.ts';
import { acceptPreview, approvedRun, dryRunHash, pending, pressSend, pushStep, sendObjects, sendPhase, variation, type SendApp } from './send-fixtures.ts';
import { LOCATION, POUND } from './matching-fixtures.ts';
import { startFakeMailchimp, testConfig, TEST_KEY } from './mailchimp-fixtures.ts';
import { taskForRun } from '../src/mailchimp/store.ts';
import type { CatalogSource } from '../src/square/catalog-source.ts';
import { catalogSourceLabel, sourceForEnv, type SquareEnv } from '../src/square/origins.ts';
import type { Json } from '../src/square/writer.ts';
import type { ConfigInput } from '../src/server/config.ts';
import type { AppDeps } from '../src/server/app.ts';
import type { RunApp } from './runs-fixtures.ts';

const LIVE_URL = 'http://10.0.0.20:8765/mcp';
const ALL = ['FRONT', 'KITCHEN', 'COUNTER'];
const LIVE_CONFIG: ConfigInput = { allowSquareProduction: true, allowLiveScaleConnect: true, liveScaleConnectUrl: LIVE_URL, scaleNames: ALL, writeScales: ALL };

/** A catalog source whose kind follows the environment, like squareCatalogSource does. */
function followingSource(env: { now: SquareEnv }): CatalogSource & { countsFrom: string[] } {
  const objects = sendObjects();
  const src = {
    countsFrom: [] as string[],
    get kind() {
      return sourceForEnv(env.now);
    },
    get label() {
      return catalogSourceLabel(sourceForEnv(env.now));
    },
    async load() {
      return { source: sourceForEnv(env.now), locationId: LOCATION, takenAt: '2026-11-06T17:00:00.000Z', objects: structuredClone(objects) };
    },
    async counts(ids: readonly string[], _loc: string, expect?: string) {
      if (expect !== undefined && expect !== sourceForEnv(env.now)) throw new Error('counts from the other Square');
      src.countsFrom.push(sourceForEnv(env.now));
      return new Map(Object.entries({ V_CRACKER: '3' }).filter(([k]) => ids.includes(k)));
    },
  };
  return src;
}

/** Switches the Square environment the way an admin does, and the fake source with it. */
function useEnv(s: RunApp, env: { now: SquareEnv }, to: SquareEnv): void {
  s.app.shelf.settings.update({ values: { squareEnvironment: to } }, { userId: null, username: 'test' });
  env.now = to;
}

interface LiveApp extends SendApp {
  env: { now: SquareEnv };
  /** Square and scale calls in the order they happened. */
  order: string[];
}

/** An approved run read in the given environment, with live Square and live scales allowed. */
async function liveRun(opts: { readIn?: SquareEnv; config?: ConfigInput; deps?: AppDeps; before?: (s: RunApp, mgr: { cookie: string; csrf: string }) => Promise<void> } = {}): Promise<LiveApp> {
  const env = { now: (opts.readIn ?? 'production') as SquareEnv };
  const source = followingSource(env);
  const s = await approvedRun({
    config: { ...LIVE_CONFIG, ...opts.config },
    deps: { catalogSource: source, ...opts.deps },
    before: async (r, mgr) => {
      // The setting matches the environment the catalog was read in.
      r.app.shelf.settings.update({ values: { squareEnvironment: env.now } }, { userId: null, username: 'test' });
      await opts.before?.(r, mgr);
    },
  });
  // The fake Square write API speaks for the environment the run was read in.
  (s.sq as { environment: SquareEnv }).environment = env.now;
  // One list of every Square and scale call, to check the order.
  const order: string[] = [];
  for (const on of ['retrieveObjects', 'batchUpsert', 'changeInventory', 'inventoryCounts'] as const) {
    const f = s.sq[on].bind(s.sq) as (...a: unknown[]) => Promise<unknown>;
    (s.sq as unknown as Record<string, unknown>)[on] = async (...a: unknown[]) => {
      order.push(`square:${on}`);
      return f(...a);
    };
  }
  for (const on of ['listScales', 'getItem', 'previewChanges', 'applyChanges', 'getChange', 'compareScale', 'previewSettleDrift'] as const) {
    const f = (s.sc[on] as (...a: unknown[]) => Promise<unknown>).bind(s.sc);
    (s.sc as unknown as Record<string, unknown>)[on] = async (...a: unknown[]) => {
      order.push(`scale:${on}`);
      return f(...a);
    };
  }
  return Object.assign(s, { env, order });
}

function upserts(s: SendApp): Json[] {
  return s.sq.calls.filter((c) => c.on === 'upsert').map((c) => c.body as Json);
}

test('live: every page says Square (live) with a LIVE tag, and the run records it was read in live Square', async (t) => {
  const s = await liveRun();
  t.after(() => s.close());
  const snap = s.app.shelf.db.prepare('SELECT c.source FROM runs r JOIN catalog_snapshots c ON c.id = r.catalog_snapshot_id WHERE r.id = 1').get() as { source: string };
  assert.equal(snap.source, 'square_production');
  const runPage = await get(s, '/runs/1', s.mgr.cookie);
  assert.match(runPage.body, /Square catalog: <strong>Square \(live\)<\/strong> <span class="tag tag-live">LIVE<\/span>/);
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.match(dry.body, /from <strong>Square \(live\)<\/strong> <span class="tag tag-live">LIVE<\/span>/);
  for (const url of ['/runs', '/runs/new']) {
    const page = await get(s, url, s.mgr.cookie);
    assert.match(page.body, /Square catalog: <strong>Square \(live\)<\/strong> <span class="tag tag-live">LIVE<\/span>/, url);
  }
  const send = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.match(send.body, /Sends to Square \(live\), the store register, then to the store scales: FRONT, KITCHEN, COUNTER\./);
  assert.match(send.body, /class="banner banner-live"/);
  assert.match(send.body, /<title>LIVE: Send invoice 1/);
  assert.doesNotMatch(send.body, /sandbox/i);
  // The sandbox reads plainly as the sandbox, with no LIVE tag.
  useEnv(s, s.env, 'sandbox');
  const upload = await get(s, '/runs/new', s.mgr.cookie);
  assert.match(upload.body, /Square catalog: Square sandbox\./);
  assert.doesNotMatch(upload.body, /tag-live/);
});

test('live: Square first and read back, then the scales only after Square fully succeeded (decision 1), to every scale', async (t) => {
  const s = await liveRun();
  t.after(() => s.close());
  const res = await pressSend(s);
  assert.equal(res.statusCode, 303, res.body.match(/<p class="error"[^>]*>([^<]*)/)?.[1] ?? '');
  assert.equal(sendPhase(s), 'scale_preview');
  // Every Square write came before any scale call, and the scale preview names no subset.
  const firstScale = s.order.findIndex((o) => o.startsWith('scale:'));
  const lastSquareWrite = s.order.map((o, i) => (o === 'square:batchUpsert' || o === 'square:changeInventory' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(lastSquareWrite >= 0 && firstScale > lastSquareWrite, s.order.join(' '));
  const preview = s.sc.calls.find((c) => c.tool === 'preview')!.args as { scales?: string[] };
  assert.equal(preview.scales, undefined, 'all scales, not a test subset');
  assert.equal(s.sc.applies().length, 0, 'nothing applied without a person');
  // A person accepts; every scale verifies; the run is done.
  await acceptPreview(s);
  assert.equal(runState(s), 'done');
  // Rule 12: the by-weight items are sold by weight in Square at exactly the scale price.
  for (const [itemId, variationId, code] of [['I_GOUDA', 'V_GOUDA', '7101'], ['I_SALMON', 'V_SALMON', '4101']] as const) {
    const v = variation(s.sq, itemId, variationId).item_variation_data as Json;
    assert.equal(v.pricing_type, 'FIXED_PRICING');
    assert.equal(v.measurement_unit_id, POUND);
    const cents = (v.price_money as { amount: number }).amount;
    for (const scale of ALL) assert.equal(Math.round(Number(s.sc.held.get(scale)!.get(code)) * 100), cents, `${code} on ${scale}`);
  }
  const audit = s.app.shelf.db.prepare("SELECT details FROM audit_log WHERE action = 'run.send.start'").get() as { details: string };
  assert.equal(JSON.parse(audit.details).squareEnvironment, 'production');
});

test('live: when Square fails, no scale is contacted at all', async (t) => {
  const s = await liveRun();
  t.after(() => s.close());
  s.sq.fail({ on: 'upsert', mode: 'refuse', codes: ['BAD_REQUEST'] });
  await pressSend(s);
  assert.equal(sendPhase(s), 'square_failed');
  assert.equal(s.order.filter((o) => o.startsWith('scale:')).length, 0, s.order.join(' '));
});

test('rule 12, live: a send to some scales is refused before anything is sent; a scale that misses it leaves the run partial, saying why', async (t) => {
  const s = await liveRun();
  t.after(() => s.close());
  const res = await pressSend(s, ['FRONT']);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Live Square sends every scale price to every scale in the same run/);
  assert.match(res.body, /KITCHEN, COUNTER are left out/);
  assert.equal(runState(s), 'approved');
  assert.equal(s.order.length, 0, 'nothing reached Square or ScaleConnect');

  // All three chosen, but KITCHEN does not answer the preview's read: that preview is never sent.
  s.sc.unplugged.add('KITCHEN');
  await pressSend(s);
  assert.equal(pushStep(s).state, 'blocked');
  assert.match(pushStep(s).preview.blockedWhy, /KITCHEN gave no reply/);
  // A person asks for a new preview, which leaves KITCHEN out and says so; they accept it.
  await decide(s, s.mgr, '/runs/1/send/scale-preview');
  await s.app.shelf.runner.drain();
  assert.deepEqual(pushStep(s).preview.leftOut, ['KITCHEN']);
  assert.ok(pushStep(s).preview.warnings.some((w) => w.code === 'scale_left_out'));
  await acceptPreview(s);
  // The run stops partial, with KITCHEN pending, and says why.
  assert.equal(runState(s), 'partial');
  const p = pending(s).filter((x) => x.state === 'pending');
  assert.deepEqual([...new Set(p.map((x) => x.scale))], ['KITCHEN']);
  const message = (s.app.shelf.db.prepare('SELECT message FROM runs WHERE id = 1').get() as { message: string }).message;
  assert.match(message, /KITCHEN is pending: it has not confirmed every new price/);
  // Square keeps the new price (decision 1: no roll back), and the resend is offered.
  assert.equal(((variation(s.sq, 'I_GOUDA', 'V_GOUDA').item_variation_data as Json).price_money as { amount: number }).amount, 1399);
});

test('rule 12, live: a run with scale prices cannot be sent when the scales cannot follow', async (t) => {
  // The fake ScaleConnect stays in place, so nothing here can reach a real one. The check made
  // before Square says the scales cannot be reached (scalePreflightProblem is tested on its own).
  const s = await liveRun({ deps: { scalePreflight: () => 'No ScaleConnect address is set. An admin must set it in settings.' } });
  t.after(() => s.close());
  // The send stops before Square.
  const res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /No ScaleConnect address is set/);
  assert.match(res.body, /Square waits until the scales can follow/);
  assert.equal(s.order.length, 0);
});

test('a run never mixes environments: a sandbox run cannot be sent live, and nothing is contacted', async (t) => {
  const s = await liveRun({ readIn: 'sandbox' });
  t.after(() => s.close());
  assert.equal(runState(s), 'approved');
  useEnv(s, s.env, 'production');
  const res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /This invoice was read in Square sandbox, but ShelfReady now uses Square \(live\)\. A run never mixes the two\./);
  assert.equal(s.order.length, 0, 'nothing reached Square or ScaleConnect');
  assert.equal(upserts(s).length, 0);
});

test('a run never mixes environments: a live run cannot be sent in the sandbox', async (t) => {
  const s = await liveRun({ readIn: 'production' });
  t.after(() => s.close());
  useEnv(s, s.env, 'sandbox');
  const res = await pressSend(s);
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /This invoice was read in Square \(live\), but ShelfReady now uses Square sandbox/);
  assert.equal(s.order.length, 0);
});

test('a run never mixes environments: a new dry run never reads stock counts from the other Square', async (t) => {
  const env = { now: 'production' as SquareEnv };
  const source = followingSource(env);
  const s = await approvedRun({
    config: LIVE_CONFIG,
    deps: { catalogSource: source },
    approve: false,
    before: async (r) => void r.app.shelf.settings.update({ values: { squareEnvironment: 'production' } }, { userId: null, username: 'test' }),
  });
  t.after(() => s.close());
  assert.deepEqual(source.countsFrom, ['square_production']);
  useEnv(s, env, 'sandbox');
  await decide(s, s.mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  const job = s.app.shelf.db.prepare("SELECT state, error FROM run_jobs WHERE kind = 'dry_run' ORDER BY id DESC LIMIT 1").get() as { state: string; error: string };
  assert.equal(job.state, 'failed');
  assert.match(job.error, /read in Square \(live\), but ShelfReady now uses Square sandbox/);
  assert.deepEqual(source.countsFrom, ['square_production'], 'no counts from the sandbox');
});

test('a run never mixes environments: approval is refused when the environment changed after the dry run', async (t) => {
  const env = { now: 'sandbox' as SquareEnv };
  const s = await approvedRun({ config: LIVE_CONFIG, deps: { catalogSource: followingSource(env) }, approve: false });
  t.after(() => s.close());
  assert.equal(runState(s), 'dry_run_done');
  useEnv(s, env, 'production');
  const res = await decide(s, s.mgr, '/runs/1/approve', { hash: dryRunHash(s) });
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /read in Square sandbox, but ShelfReady now uses Square \(live\)/);
  assert.equal(runState(s), 'dry_run_done');
});

test('a run never mixes environments: a live run with Square done does not send its prices to the scales after a switch back', async (t) => {
  const s = await liveRun();
  t.after(() => s.close());
  await pressSend(s);
  assert.equal(sendPhase(s), 'scale_preview');
  useEnv(s, s.env, 'sandbox');
  const st = pushStep(s);
  const res = await decide(s, s.mgr, '/runs/1/send/scales', { stepId: String(st.id), ...(st.preview.mustAcknowledge ? { ack: st.preview.digest } : {}) });
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /A run never mixes the two/);
  assert.equal(s.sc.applies().length, 0);
});

test('the fish email follows live runs: a live send queues the fish email change, with no test setting', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00', settings: { title: 'Fish Email 20261016', subject_line: 'Fish list', from_name: 'Example Fish Market', reply_to: 'fish@example.com' } });
  const s = await liveRun({
    config: { allowMailchimpWrites: true },
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON', confirmedBy: 'Bart', confirmedAt: '2026-11-06' }] }), { mode: 0o600 });
    },
  });
  t.after(() => s.close());
  assert.equal(s.config.mailchimpFromSandboxRuns, false);
  assert.equal(s.app.shelf.mailchimp.runChangesEmail('square_production'), true);
  assert.equal(s.app.shelf.mailchimp.runChangesEmail('square_sandbox'), false);
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.doesNotMatch(dry.body, /does not change the live fish email/);
  assert.doesNotMatch(dry.body, /Test setting on/);
  await pressSend(s);
  const task = taskForRun(s.app.shelf.db, 1);
  assert.ok(task, 'the fish email task is queued once live Square is done');
  assert.deepEqual(task.plan!.map((p) => [p.key, p.toCents]), [['Test King Salmon (Testland)', 1999]]);
  assert.doesNotMatch(logText(s.logs), /queued from a Square sandbox send/);
});

test('the fish email: a sandbox send while live Square is allowed changes nothing in Mailchimp', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
  const s = await liveRun({
    readIn: 'sandbox',
    config: { allowMailchimpWrites: true },
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON' }] }), { mode: 0o600 });
    },
  });
  t.after(() => s.close());
  await pressSend(s);
  assert.equal(taskForRun(s.app.shelf.db, 1), null);
});
