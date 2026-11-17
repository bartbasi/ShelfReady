import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { decide, failingWriter, fakeCatalogSource, makeAppWith, modelFor, runState, seedCards, signIn, testInvoice, uploadPhoto, SCALES } from './runs-fixtures.ts';
import { tempDir } from './server-helpers.ts';
import { fakeClient } from './invoice-fixtures.ts';

async function appIn(dir: string, model: ReturnType<typeof fakeClient>) {
  return makeAppWith({ scaleNames: SCALES }, { modelClient: model, catalogSource: fakeCatalogSource(), squareWriter: failingWriter(), startRunner: false }, dir);
}

test('a queued run survives a restart and is read once', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = modelFor(testInvoice());
  const a = await appIn(dir, first);
  const mgr = await signIn(a);
  await uploadPhoto(a, mgr);
  assert.equal(runState(a), 'uploaded');
  await a.app.close();

  const second = modelFor(testInvoice());
  const b = await appIn(dir, second);
  t.after(() => b.app.close());
  await b.app.shelf.runner.drain();
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 1);
  assert.equal(runState(b), 'review');
});

test('a restart in the middle of a model call does not read again on its own', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = await appIn(dir, modelFor(testInvoice()));
  const mgr = await signIn(a);
  await uploadPhoto(a, mgr);
  // As if the server died while the model was reading: the job is running, the run is reading.
  a.app.shelf.db.exec("UPDATE run_jobs SET state = 'running'; UPDATE runs SET state = 'reading'");
  await a.app.close();

  const model = modelFor(testInvoice());
  const b = await appIn(dir, model);
  t.after(() => b.app.close());
  await b.app.shelf.runner.drain();
  assert.equal(model.calls.length, 0, 'not sent again without a person');
  assert.equal(runState(b), 'retry');
  const s = await signIn(b);
  const page = await b.app.inject({ method: 'GET', url: '/runs/1', headers: { cookie: s.cookie } });
  assert.match(page.body, /restarted while reading/);
  assert.match(page.body, /Read again/);
  assert.equal((await decide(b, s, '/runs/1/read-again')).statusCode, 303);
  await b.app.shelf.runner.drain();
  assert.equal(model.calls.length, 1);
  assert.equal(runState(b), 'review');
});

test('a restart after the reading was saved picks up from there without paying again', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const firstModel = modelFor(testInvoice());
  const a = await appIn(dir, firstModel);
  const mgr = await signIn(a);
  await uploadPhoto(a, mgr);
  await a.app.shelf.runner.drain();
  assert.equal(firstModel.calls.length, 1);
  // As if it died after saving the reading but before matching finished.
  a.app.shelf.db.exec("UPDATE run_jobs SET state = 'running'; UPDATE runs SET state = 'reading'");
  await a.app.close();

  const model = modelFor(testInvoice());
  const b = await appIn(dir, model);
  t.after(() => b.app.close());
  await b.app.shelf.runner.drain();
  assert.equal(model.calls.length, 0);
  assert.equal(runState(b), 'review');
});

test('a dry run interrupted by a restart runs again, still writing nothing', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = await appIn(dir, modelFor(testInvoice()));
  await seedCards(a.app.shelf.db, fakeCatalogSource());
  const mgr = await signIn(a);
  await uploadPhoto(a, mgr);
  await a.app.shelf.runner.drain();
  await decide(a, mgr, '/runs/1/supplier', { create: '1' });
  await decide(a, mgr, '/runs/1/lines/1/pick', { variationId: 'V_GOUDA' });
  await decide(a, mgr, '/runs/1/lines/3/pick', { variationId: 'V_SALMON' });
  await decide(a, mgr, '/runs/1/dry-run');
  a.app.shelf.db.exec("UPDATE run_jobs SET state = 'running' WHERE kind = 'dry_run'");
  await a.app.close();
  const writer = failingWriter();
  const b = await makeAppWith({ scaleNames: SCALES }, { modelClient: modelFor(testInvoice()), catalogSource: fakeCatalogSource(), squareWriter: writer, startRunner: false }, dir);
  t.after(() => b.app.close());
  await b.app.shelf.runner.drain();
  assert.equal(runState(b), 'dry_run_done');
  assert.equal(writer.calls, 0);
});
