import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { decide, makeRunApp, runState, signIn, uploadPhoto } from './runs-fixtures.ts';
import { get } from './server-helpers.ts';

test('a full run: upload, read, settle in review, dry run, approve, with nothing written anywhere', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  const up = await uploadPhoto(s, mgr);
  assert.equal(up.statusCode, 303, up.body);
  assert.equal(up.headers.location, '/runs/1');
  // The file is kept with a random name, private to this user.
  const files = readdirSync(s.config.uploads.dir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^[0-9a-f]{32}$/);
  assert.equal(statSync(`${s.config.uploads.dir}/${files[0]}`).mode & 0o077, 0);

  await s.app.shelf.runner.drain();
  assert.equal(s.model.calls.length, 1, 'one reading, no fallback');
  assert.equal(runState(s), 'review');
  let page = await get(s, '/runs/1', mgr.cookie);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Hilltop Provisions/);
  assert.match(page.body, /is new to ShelfReady/);
  assert.match(page.body, /Cards \(1\)/);

  assert.equal((await decide(s, mgr, '/runs/1/supplier', { create: '1' })).statusCode, 303);
  assert.equal((await decide(s, mgr, '/runs/1/lines/1/pick', { variationId: 'V_GOUDA' })).statusCode, 303);
  assert.equal((await decide(s, mgr, '/runs/1/lines/3/pick', { variationId: 'V_SALMON' })).statusCode, 303);
  page = await get(s, '/runs/1', mgr.cookie);
  assert.equal(runState(s), 'ready', page.body.match(/To settle[\s\S]*?<\/ul>/)?.[0] ?? '');
  assert.match(page.body, /Switch to sold by weight/);

  assert.equal((await decide(s, mgr, '/runs/1/dry-run')).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(runState(s), 'dry_run_done');
  const dry = await get(s, '/runs/1/dry-run', mgr.cookie);
  assert.equal(dry.statusCode, 200);
  assert.match(dry.body, /<body class="mode-dry-run">/);
  assert.match(dry.body, /class="banner-label">DRY RUN<\/p>/);
  assert.equal(dry.body.match(/DRY RUN<\/p>/g)?.length, 1, 'one banner, from the shared layout');
  assert.match(dry.body, /Nothing was sent to Square or the scales/);
  // Gouda drops to the formula price, the crackers rise and get stock, the salmon switches to weight.
  assert.match(dry.body, /Price: \$18\.99 becomes \$13\.99 per pound/);
  assert.match(dry.body, /Price: \$5\.99 becomes \$6\.99/);
  assert.match(dry.body, /Stock: 3 becomes 24 units/);
  assert.match(dry.body, /Switch to sold by weight: now the price is taken at the register|Switch to sold by weight: now no fixed price/);
  assert.match(dry.body, /Stock: no count becomes 8.00 lb/);
  assert.match(dry.body, /Stock tracking: turned on first/);
  assert.match(dry.body, /Code 7101, Gouda Smoked 7101: \$13\.99 per pound on FRONT, KITCHEN, COUNTER/);
  assert.match(dry.body, /Code 4101, Coho Salmon 4101: \$19\.99 per pound on FRONT, KITCHEN, COUNTER/);

  const row = s.app.shelf.db.prepare('SELECT dry_run, dry_run_hash FROM runs WHERE id = 1').get() as { dry_run: string; dry_run_hash: string };
  const preview = JSON.parse(row.dry_run);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.scales.contacted, false);
  assert.equal(preview.square.length, 3);

  const ok = await decide(s, mgr, '/runs/1/approve', { hash: row.dry_run_hash });
  assert.equal(ok.statusCode, 303);
  assert.equal(runState(s), 'approved');
  const approved = s.app.shelf.db.prepare("SELECT username FROM audit_log WHERE action = 'run.approve'").get() as { username: string };
  assert.equal(approved.username, 'mgr');

  // Nothing went to Square or anywhere else.
  assert.equal(s.writer.calls, 0);
  assert.equal(s.fetch.calls, 0);
  const actions = (s.app.shelf.db.prepare('SELECT action FROM audit_log WHERE run_id = 1').all() as { action: string }[]).map((r) => r.action);
  for (const a of ['run.upload', 'run.read', 'run.decide.pick', 'run.dry_run', 'run.approve']) assert.ok(actions.includes(a), a);
});

test('a pick is saved to the mapping, so the next invoice from the supplier matches on its own', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr, 1);
  await s.app.shelf.runner.drain();
  await decide(s, mgr, '/runs/1/supplier', { create: '1' });
  await decide(s, mgr, '/runs/1/lines/1/pick', { variationId: 'V_GOUDA' });
  await decide(s, mgr, '/runs/1/lines/3/pick', { variationId: 'V_SALMON' });
  await uploadPhoto(s, mgr, 2);
  await s.app.shelf.runner.drain();
  assert.equal(runState(s, 2), 'ready');
});

test('decisions are checked against the run: a pick outside its catalog or an unknown line is refused', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  // Supplier first.
  let res = await decide(s, mgr, '/runs/1/lines/1/pick', { variationId: 'V_GOUDA' });
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /Choose the supplier first/);
  await decide(s, mgr, '/runs/1/supplier', { create: '1' });
  for (const v of ['V_NOPE', 'V_OLD', 'V_AWAY']) {
    res = await decide(s, mgr, '/runs/1/lines/1/pick', { variationId: v });
    assert.equal(res.statusCode, 400, v);
  }
  res = await decide(s, mgr, '/runs/1/lines/99/pick', { variationId: 'V_GOUDA' });
  assert.equal(res.statusCode, 404);
  res = await decide(s, mgr, '/runs/1/conflict', { variationId: 'V_GOUDA', priceCents: '100' });
  assert.equal(res.statusCode, 400);
  res = await decide(s, mgr, '/runs/1/checks/accept', { checkId: 'totals' });
  assert.equal(res.statusCode, 400);
  assert.equal(s.app.shelf.db.prepare("SELECT count(*) AS n FROM run_decisions WHERE kind = 'pick'").get()!.n, 0);
});
