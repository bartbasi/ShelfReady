import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, makeRunApp, modelFor, runState, signIn, testInvoice, uploadPhoto, type RunApp } from './runs-fixtures.ts';
import { ORIGIN, logText } from './server-helpers.ts';
import { line } from './invoice-fixtures.ts';
import { setPriceOverride } from '../src/runs/overrides.ts';
import { SYSTEM_ACTOR } from '../src/db/audit.ts';

const fill = (url: string) => url.replace(':id', '1').replace(':n', '1').replace(':fileId', '1');

async function reviewed(s: RunApp, mgr: { cookie: string; csrf: string }): Promise<void> {
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
}

async function settled(s: RunApp, mgr: { cookie: string; csrf: string }): Promise<void> {
  await reviewed(s, mgr);
  await decide(s, mgr, '/runs/1/supplier', { create: '1' });
  await decide(s, mgr, '/runs/1/lines/1/pick', { variationId: 'V_GOUDA' });
  await decide(s, mgr, '/runs/1/lines/3/pick', { variationId: 'V_SALMON' });
}

function decisionsAndAudit(s: RunApp): string {
  const db = s.app.shelf.db;
  return JSON.stringify([db.prepare('SELECT * FROM run_decisions').all(), db.prepare("SELECT count(*) AS n FROM audit_log WHERE action LIKE 'run.%' OR action LIKE 'mapping.%' OR action LIKE 'supplier.%'").get(), db.prepare('SELECT state FROM runs').all()]);
}

test('every run route declares its access, and every run post needs the session token', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await reviewed(s, mgr);
  const runRoutes = s.app.shelf.routes.filter((r) => r.url.startsWith('/runs') && r.method !== 'HEAD');
  assert.ok(runRoutes.length >= 20);
  for (const r of runRoutes) assert.ok(r.access === 'user' || r.access === 'admin', `${r.method} ${r.url}`);
  const before = decisionsAndAudit(s);
  for (const r of runRoutes.filter((x) => x.method === 'POST' && x.url !== '/runs')) {
    const fields = { variationId: 'V_GOUDA', create: '1', skip: '1', arrived: 'all', hash: 'x', model: 'm', estimateUsd: '1.00' };
    const none = await s.app.inject({ method: 'POST', url: fill(r.url), headers: { cookie: mgr.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(fields).toString() });
    assert.equal(none.statusCode, 403, `no token: ${r.url}`);
    const wrong = await decide(s, { cookie: mgr.cookie, csrf: 'not-the-token' }, fill(r.url), fields);
    assert.equal(wrong.statusCode, 403, `wrong token: ${r.url}`);
  }
  assert.equal(decisionsAndAudit(s), before, 'nothing changed');
});

test('only an admin can approve going over the cost cap, and only the stored model and estimate', async (t) => {
  const s = await makeRunApp({ deps: { invoiceSettings: { costCapUsd: 0.001 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  assert.equal(runState(s), 'needs_approval');
  assert.equal(s.model.calls.length, 0, 'nothing sent before approval');
  const row = s.app.shelf.db.prepare('SELECT approval_model, approval_estimate_usd FROM runs').get() as { approval_model: string; approval_estimate_usd: string };
  const page = await s.app.inject({ method: 'GET', url: '/runs/1', headers: { cookie: mgr.cookie } });
  assert.match(page.body, /Ask an admin to approve it/);
  assert.doesNotMatch(page.body, /approve-cost/);
  assert.doesNotMatch(page.body, /inputFingerprint|"attempts"/, 'the pending approval stays on the server');
  const asMgr = await decide(s, mgr, '/runs/1/approve-cost', { model: row.approval_model, estimateUsd: row.approval_estimate_usd });
  assert.equal(asMgr.statusCode, 403);
  const admin = await signIn(s, 'admin');
  const adminPage = await s.app.inject({ method: 'GET', url: '/runs/1', headers: { cookie: admin.cookie } });
  assert.match(adminPage.body, /action="\/runs\/1\/approve-cost"/);
  const wrong = await decide(s, admin, '/runs/1/approve-cost', { model: row.approval_model, estimateUsd: '0.01' });
  assert.equal(wrong.statusCode, 409);
  const other = await decide(s, admin, '/runs/1/approve-cost', { model: 'claude-opus-5-5', estimateUsd: row.approval_estimate_usd });
  assert.equal(other.statusCode, 409);
  assert.equal(runState(s), 'needs_approval');
  const ok = await decide(s, admin, '/runs/1/approve-cost', { model: row.approval_model, estimateUsd: row.approval_estimate_usd });
  assert.equal(ok.statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(s.model.calls.length, 1);
  assert.equal(s.model.calls[0]!.model, row.approval_model);
  assert.equal(runState(s), 'review');
  const audit = s.app.shelf.db.prepare("SELECT username, details FROM audit_log WHERE action = 'run.cost_approved'").get() as { username: string; details: string };
  assert.equal(audit.username, 'bart');
  assert.deepEqual(JSON.parse(audit.details), { model: row.approval_model, estimateUsd: row.approval_estimate_usd });
});

test('approval is refused without a dry run, with blockers, with another preview, or after anything changed', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await reviewed(s, mgr);
  // In review, with blockers.
  let res = await decide(s, mgr, '/runs/1/approve', { hash: 'x' });
  assert.equal(res.statusCode, 409);
  assert.equal(runState(s), 'review');
  // A dry run is refused while anything blocks.
  res = await decide(s, mgr, '/runs/1/dry-run');
  assert.equal(res.statusCode, 409);
  await decide(s, mgr, '/runs/1/supplier', { create: '1' });
  await decide(s, mgr, '/runs/1/lines/1/pick', { variationId: 'V_GOUDA' });
  await decide(s, mgr, '/runs/1/lines/3/pick', { variationId: 'V_SALMON' });
  assert.equal(runState(s), 'ready');
  // Ready, but no dry run yet.
  res = await decide(s, mgr, '/runs/1/approve', { hash: 'x' });
  assert.equal(res.statusCode, 409);
  await decide(s, mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  const hash = () => (s.app.shelf.db.prepare('SELECT dry_run_hash AS h FROM runs').get() as { h: string }).h;
  const first = hash();
  // Another preview's hash.
  res = await decide(s, mgr, '/runs/1/approve', { hash: 'f'.repeat(64) });
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /changed since the page was shown/);
  // A decision after the dry run puts the run back in review and drops the preview.
  await decide(s, mgr, '/runs/1/lines/2/skip', { skip: '1' });
  assert.equal(runState(s), 'ready');
  res = await decide(s, mgr, '/runs/1/approve', { hash: first });
  assert.equal(res.statusCode, 409);
  await decide(s, mgr, '/runs/1/lines/2/skip', { skip: '0' });
  await decide(s, mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  assert.equal(hash(), first, 'the same decisions give the same preview');
  // A price override set elsewhere after the dry run changes what would be sent.
  setPriceOverride(s.app.shelf.db, SYSTEM_ACTOR, 'V_CRACKER', 749, 'test', Date.now());
  res = await decide(s, mgr, '/runs/1/approve', { hash: first });
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /Something changed since the dry run/);
  assert.equal(runState(s), 'dry_run_done');
  assert.equal(s.app.shelf.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'run.approve'").get()!.n, 0);
});

test('model text and file names are escaped on every run page', async (t) => {
  const inv = testInvoice({ supplier_name: '<script>alert(1)</script> Foods' });
  inv.lines[1] = line({ ...inv.lines[1]!, description: 'CRACKERS <img src=x onerror=alert(1)>' });
  const s = await makeRunApp({ model: modelFor(inv) });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const { testImage } = await import('./invoice-fixtures.ts');
  const { upload } = await import('./runs-fixtures.ts');
  await upload(s, mgr.cookie, [{ name: '_csrf', value: mgr.csrf }, { name: 'files', filename: '<b>evil</b>".jpg', type: 'image/jpeg', data: await testImage(1) }]);
  await s.app.shelf.runner.drain();
  for (const url of ['/runs', '/runs/1', '/runs/1/lines/2/search?q=%3Cscript%3E']) {
    const page = await s.app.inject({ method: 'GET', url, headers: { cookie: mgr.cookie } });
    assert.equal(page.statusCode, 200, url);
    assert.doesNotMatch(page.body, /<script|<img|<b>/i, url);
  }
  const page = await s.app.inject({ method: 'GET', url: '/runs/1', headers: { cookie: mgr.cookie } });
  assert.match(page.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Foods/);
  assert.match(page.body, /CRACKERS &lt;img src=x onerror=alert\(1\)&gt;/);
});

test('the run page refreshes itself while work is queued, and the log names no secret', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  const waiting = await s.app.inject({ method: 'GET', url: '/runs/1', headers: { cookie: mgr.cookie } });
  assert.match(waiting.body, /<meta http-equiv="refresh" content="5">/);
  await s.app.shelf.runner.drain();
  const done = await s.app.inject({ method: 'GET', url: '/runs/1', headers: { cookie: mgr.cookie } });
  assert.doesNotMatch(done.body, /http-equiv="refresh"/);
  const logs = logText(s.logs);
  assert.doesNotMatch(logs, /sk-ant-|EAAA|Bearer /);
  assert.doesNotMatch(logs, new RegExp(mgr.csrf));
});

test('a stopped run and a run read again behave', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await settled(s, mgr);
  assert.equal((await decide(s, mgr, '/runs/1/read-again')).statusCode, 409, 'a good reading is not paid for again');
  assert.equal((await decide(s, mgr, '/runs/1/stop')).statusCode, 303);
  assert.equal(runState(s), 'failed');
  assert.equal((await decide(s, mgr, '/runs/1/lines/1/skip', { skip: '1' })).statusCode, 409);
});

test('approving the cost needs a recent password, and confirming it returns to the invoice', async (t) => {
  const s = await makeRunApp({ deps: { invoiceSettings: { costCapUsd: 0.001 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  const admin = await signIn(s, 'admin');
  const { ageReauth, ADMIN_PW } = await import('./server-helpers.ts');
  ageReauth(s, 60 * 60 * 1000);
  const row = s.app.shelf.db.prepare('SELECT approval_model AS m, approval_estimate_usd AS e FROM runs').get() as { m: string; e: string };
  const res = await decide(s, admin, '/runs/1/approve-cost', { model: row.m, estimateUsd: row.e });
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /name="next" value="\/runs\/1"/);
  assert.equal(runState(s), 'needs_approval');
  const re = await decide(s, admin, '/reauth', { next: '/runs/1', password: ADMIN_PW });
  assert.equal(re.statusCode, 303);
  assert.equal(re.headers.location, '/runs/1');
  const evil = await decide(s, admin, '/reauth', { next: 'https://evil.example/runs/1', password: ADMIN_PW });
  assert.equal(evil.headers.location, '/settings?notice=confirmed');
  assert.equal((await decide(s, admin, '/runs/1/approve-cost', { model: row.m, estimateUsd: row.e })).statusCode, 303);
});
