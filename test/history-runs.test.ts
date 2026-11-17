// Every invoice goes into the purchase history: invoice runs as well as old invoices. A run's own
// reading is recorded (no second model call, no second booking), what a person says arrived shows
// in the download, one copy of each invoice is in it, and a stopped run stays, marked Needs
// check, unless another copy of the invoice wins over it.
// Invented invoices only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyArrival, backfillRuns } from '../src/history/runs.ts';
import type { HistoryLine } from '../src/history/lines.ts';
import { testImage } from './invoice-fixtures.ts';
import { decide, makeRunApp, multipart, signIn, testInvoice, uploadPhoto, type RunApp } from './runs-fixtures.ts';
import { get, ORIGIN, type TestApp } from './server-helpers.ts';

async function uploadOld(t: TestApp, who: { cookie: string; csrf: string }, seed: number) {
  const { payload, contentType } = multipart([
    { name: '_csrf', value: who.csrf },
    { name: 'files', filename: `old${seed}.jpg`, type: 'image/jpeg', data: await testImage(seed) },
  ]);
  return t.app.inject({ method: 'POST', url: '/history', headers: { cookie: who.cookie, origin: ORIGIN, 'content-type': contentType }, payload });
}

async function csv(t: TestApp, cookie: string): Promise<string[][]> {
  const res = await t.app.inject({ method: 'GET', url: '/history/download.csv', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  // The invented invoice has no commas or quotes, so a plain split is enough here.
  return res.rawPayload.subarray(3).toString('utf8').trim().split('\r\n').map((l) => l.split(','));
}

function rows(t: TestApp, sql: string, ...args: Array<string | number>) {
  return t.app.shelf.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
}

async function readRun(s: RunApp, who: { cookie: string; csrf: string }, seed = 1): Promise<void> {
  assert.equal((await uploadPhoto(s, who, seed)).statusCode, 303);
  await s.app.shelf.runner.drain();
}

test("a run's reading is recorded in the history, with no second model call and no second booking", async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  const calls = s.model.calls.length;
  assert.ok(calls >= 1);
  const inv = rows(s, 'SELECT * FROM purchase_invoices');
  assert.equal(inv.length, 1);
  assert.equal(inv[0]!.source, 'run');
  assert.equal(inv[0]!.run_id, 1);
  assert.equal(inv[0]!.state, 'done');
  assert.equal(inv[0]!.vendor, 'Hilltop Provisions');
  assert.equal(inv[0]!.line_count, 3);
  assert.equal(rows(s, 'SELECT * FROM purchase_files').length, 0, 'the photos stay with the run');
  await s.app.shelf.history.drain();
  assert.equal(s.model.calls.length, calls, 'the history reads nothing again');
  assert.equal(rows(s, "SELECT * FROM model_spend WHERE source = 'history' OR purchase_invoice_id IS NOT NULL").length, 0, 'no second booking');
  // The list shows it, linking to the run. Its history page is the run page.
  const list = (await get(s, '/history', mgr.cookie)).body;
  assert.match(list, /href="\/runs\/1"/);
  assert.match(list, /Invoice run 1: Hilltop Provisions #INV-1/);
  const page = await get(s, '/history/1', mgr.cookie);
  assert.equal(page.statusCode, 303);
  assert.equal(page.headers.location, '/runs/1');
  // The download names its source. Same mapping as old invoices: the fish is priced by weight.
  const lines = await csv(s, mgr.cookie);
  assert.equal(lines[0]!.at(-3), 'Source');
  assert.equal(lines.length, 4);
  for (const l of lines.slice(1)) assert.equal(l[12], 'Invoice run 1');
  const salmon = lines.find((l) => l[3] === 'COHO SALMON FILLET')!;
  assert.deepEqual(salmon.slice(5, 10), ['8', 'LB', '9', 'LB', '72']);
  // An old invoice cannot be removed through a run's row.
  const admin = await signIn(s, 'admin');
  const refused = await s.app.inject({ method: 'POST', url: '/history/1/remove', headers: { cookie: admin.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${admin.csrf}&confirm=1` });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.body, /This one is invoice run 1\. It leaves the history only if that run is stopped\./);
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 1);
});

test('what a person says arrived shows in the download, and undo puts it back', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  const gouda = async () => (await csv(s, mgr.cookie)).find((l) => l[3] === 'GOUDA SMOKED WHEEL')!;
  assert.deepEqual((await gouda()).slice(5, 7), ['10.5', 'LB']);
  const none = await decide(s, mgr, '/runs/1/lines/1/arrived', { arrived: 'none' });
  assert.equal(none.statusCode, 303, none.body.slice(0, 300));
  let row = await gouda();
  assert.deepEqual(row.slice(5, 7), ['0', 'LB']);
  assert.match(row[11]!, /^Staff say none arrived\. The invoice says 10\.5 LB\./);
  assert.equal(row[9], '63', 'what was charged stays as printed');
  await decide(s, mgr, '/runs/1/lines/1/arrived', { arrived: 'some', pounds: '4.25' });
  row = await gouda();
  assert.deepEqual(row.slice(5, 7), ['4.25', 'LB']);
  assert.match(row[11]!, /^Staff say only part arrived\./);
  await decide(s, mgr, '/runs/1/undo', { kind: 'received', target: '1' });
  row = await gouda();
  assert.deepEqual(row.slice(5, 7), ['10.5', 'LB']);
  assert.doesNotMatch(row[11]!, /Staff/);
});

test('a line marked not arrived after approval shows as none, with the credit', () => {
  const l = { qty: '2', qtyUnit: 'CS', notes: ['Allowance of 0.50 off each unit price.'] } as HistoryLine;
  const out = applyArrival(l, { arrived: 'all' }, 7200);
  assert.equal(out.qty, '0');
  assert.deepEqual(out.notes, ['Marked not arrived after approval. Credit to claim $72.00. The invoice says 2 CS.', 'Allowance of 0.50 off each unit price.']);
  assert.equal(applyArrival(l, { arrived: 'some', pieces: '10' }, null).qtyUnit, 'PC');
  assert.equal(applyArrival(l, undefined, null).qty, '2');
});

test('an old invoice that matches a run is refused: "Already recorded from invoice run N."', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  // The fake reader reads the same invented invoice from any photo.
  assert.equal((await uploadOld(s, mgr, 7)).statusCode, 303);
  await s.app.shelf.history.drain();
  const old = rows(s, "SELECT state, message FROM purchase_invoices WHERE source = 'old'")[0]!;
  assert.equal(old.state, 'failed');
  assert.equal(old.message, 'Already recorded from invoice run 1. This copy was not saved.');
  assert.equal(rows(s, "SELECT * FROM purchase_files").length, 0, 'its photo was not kept');
  assert.deepEqual([...new Set((await csv(s, mgr.cookie)).slice(1).map((l) => l[12]))], ['Invoice run 1']);
});

test('a run that matches an old invoice goes ahead; the download uses the run, once; a stopped run is left out', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  assert.equal((await uploadOld(s, mgr, 7)).statusCode, 303);
  await s.app.shelf.history.drain();
  assert.equal(rows(s, "SELECT state FROM purchase_invoices WHERE id = 1")[0]!.state, 'done');
  let sources = (await csv(s, mgr.cookie)).slice(1).map((l) => l[12]);
  assert.deepEqual([...new Set(sources)], ['Old invoice 1']);
  await readRun(s, mgr, 1);
  const run = rows(s, 'SELECT state FROM runs WHERE id = 1')[0]!;
  assert.ok(['review', 'ready'].includes(String(run.state)), `the run went ahead as normal: ${run.state}`);
  sources = (await csv(s, mgr.cookie)).slice(1).map((l) => l[12]);
  assert.equal(sources.length, 3, 'one copy of the invoice, never two');
  assert.deepEqual([...new Set(sources)], ['Invoice run 1']);
  const oldPage = (await get(s, '/history/1', mgr.cookie)).body;
  assert.match(oldPage, /Also sent as <a href="\/runs\/1">invoice run 1<\/a>\. The spreadsheet uses the run\./);
  // The run is stopped: it stays listed, but the old copy wins over it in the download.
  const stop = await decide(s, mgr, '/runs/1/stop');
  assert.equal(stop.statusCode, 303, stop.body.slice(0, 300));
  assert.equal(rows(s, 'SELECT state FROM runs WHERE id = 1')[0]!.state, 'failed');
  sources = (await csv(s, mgr.cookie)).slice(1).map((l) => l[12]);
  assert.deepEqual(sources, ['Old invoice 1', 'Old invoice 1', 'Old invoice 1']);
  assert.match((await get(s, '/history', mgr.cookie)).body, /href="\/runs\/1"/);
  assert.doesNotMatch((await get(s, '/history/1', mgr.cookie)).body, /Also sent as/);
});

const STOPPED = 'This invoice run was stopped. Check whether the goods arrived.';

test('a stopped run stays in the history, every line marked Needs check with the reason', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  assert.equal((await decide(s, mgr, '/runs/1/stop')).statusCode, 303);
  const lines = (await csv(s, mgr.cookie)).slice(1);
  assert.equal(lines.length, 3);
  for (const l of lines) {
    assert.equal(l[12], 'Invoice run 1');
    assert.equal(l[10], 'Yes');
    assert.ok(l[11]!.startsWith(STOPPED), l[11]);
  }
  const list = (await get(s, '/history', mgr.cookie)).body;
  assert.match(list, /href="\/runs\/1"/);
  assert.match(list, /tag-stop">Stopped</);
  assert.match(list, /all to check/);
});

test('a stopped run gives way to a run that is not stopped, older or newer', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  // Run 1 stopped, run 2 not: run 2.
  await readRun(s, mgr, 1);
  await decide(s, mgr, '/runs/1/stop');
  await readRun(s, mgr, 2);
  let lines = (await csv(s, mgr.cookie)).slice(1);
  assert.deepEqual([...new Set(lines.map((l) => l[12]))], ['Invoice run 2']);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !l[11]!.startsWith(STOPPED)));
  // Run 3, newer, then stopped: run 2 still wins.
  await readRun(s, mgr, 3);
  await decide(s, mgr, '/runs/3/stop');
  lines = (await csv(s, mgr.cookie)).slice(1);
  assert.deepEqual([...new Set(lines.map((l) => l[12]))], ['Invoice run 2']);
});

test('of two stopped runs of one invoice, the newer one is kept', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr, 1);
  await decide(s, mgr, '/runs/1/stop');
  await readRun(s, mgr, 2);
  await decide(s, mgr, '/runs/2/stop');
  const lines = (await csv(s, mgr.cookie)).slice(1);
  assert.equal(lines.length, 3);
  assert.deepEqual([...new Set(lines.map((l) => l[12]))], ['Invoice run 2']);
  assert.ok(lines.every((l) => l[10] === 'Yes'));
});

test('an old invoice that matches only a stopped run is accepted, and wins over it', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  await decide(s, mgr, '/runs/1/stop');
  assert.equal((await uploadOld(s, mgr, 7)).statusCode, 303);
  await s.app.shelf.history.drain();
  const old = rows(s, "SELECT id, state FROM purchase_invoices WHERE source = 'old'")[0]!;
  assert.equal(old.state, 'done', 'not refused as a duplicate');
  const lines = (await csv(s, mgr.cookie)).slice(1);
  assert.deepEqual([...new Set(lines.map((l) => l[12]))], [`Old invoice ${old.id}`]);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => !l[11]!.startsWith(STOPPED)));
});

test('a run that failed before any reading shows nothing', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  s.app.shelf.db.prepare("INSERT INTO runs (id, state, created_by, created_by_name, created_at, updated_at) VALUES (5, 'failed', (SELECT id FROM users WHERE username = 'mgr'), 'mgr', 1, 1)").run();
  const { backfillRuns: backfill, refreshRunHistory } = await import('../src/history/runs.ts');
  assert.equal(refreshRunHistory(s.app.shelf.db, 5, Date.now()), false);
  assert.equal(backfill(s.app.shelf.db, Date.now()), 0);
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 0);
  assert.doesNotMatch((await get(s, '/history', mgr.cookie)).body, /href="\/runs\/5"/);
  assert.equal((await csv(s, mgr.cookie)).length, 1);
});

test('two runs of one invoice give one copy in the download: the newer one', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr, 1);
  await readRun(s, mgr, 2);
  const sources = (await csv(s, mgr.cookie)).slice(1).map((l) => l[12]);
  assert.deepEqual([...new Set(sources)], ['Invoice run 2']);
  assert.equal(sources.length, 3);
});

test('a run read before the history existed is recorded once at start', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  s.app.shelf.db.prepare('DELETE FROM purchase_invoices').run();
  assert.equal(backfillRuns(s.app.shelf.db, Date.now()), 1);
  assert.equal(backfillRuns(s.app.shelf.db, Date.now()), 0);
  assert.equal(rows(s, 'SELECT * FROM purchase_lines').length, 3);
});

test('a run whose invoice is new to the history is checked with the same rules as old invoices', async (t) => {
  const inv = testInvoice({ total: '200.00' });
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  const flagged = rows(s, 'SELECT needs_check, reasons FROM purchase_lines ORDER BY n');
  for (const l of flagged) {
    assert.equal(l.needs_check, 1);
    assert.ok(JSON.parse(String(l.reasons)).includes('The lines do not add up to the invoice total.'));
  }
});

test('read again takes the rejected reading out of the history until the new one is saved', async (t) => {
  // The total does not add up, so both readings fail a check and the run waits in review.
  const s = await makeRunApp({ inv: testInvoice({ total: '200.00' }) });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  assert.equal(rows(s, 'SELECT read_status FROM runs WHERE id = 1')[0]!.read_status, 'review');
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 1);
  const again = await decide(s, mgr, '/runs/1/read-again');
  assert.equal(again.statusCode, 303, again.body.slice(0, 300));
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 0, 'gone while the new reading is made');
  assert.equal(rows(s, 'SELECT * FROM purchase_lines').length, 0);
  assert.equal((await csv(s, mgr.cookie)).length, 1, 'the download has only its header');
  await s.app.shelf.runner.drain();
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 1, 'back with the new reading');
  assert.equal(rows(s, 'SELECT * FROM purchase_lines').length, 3);
});

test('a history that cannot be written never stops a run, a decision or a correction', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  // Every write of a line now fails, so every recording throws inside refreshRunHistory.
  s.app.shelf.db.exec('ALTER TABLE purchase_lines RENAME TO purchase_lines_gone');
  const { refreshRunHistory } = await import('../src/history/runs.ts');
  await readRun(s, mgr);
  assert.throws(() => refreshRunHistory(s.app.shelf.db, 1, Date.now()), /purchase_lines/);
  const run = rows(s, 'SELECT state, read_status FROM runs WHERE id = 1')[0]!;
  assert.ok(['review', 'ready'].includes(String(run.state)), `the run read and moved on: ${run.state}`);
  assert.equal(run.read_status, 'ok');
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 0, 'nothing half written');
  assert.ok(s.logs.some((l) => l.includes('could not record the run in the purchase history')));
  // What arrived is still saved.
  const none = await decide(s, mgr, '/runs/1/lines/1/arrived', { arrived: 'none' });
  assert.equal(none.statusCode, 303, none.body.slice(0, 300));
  assert.deepEqual(JSON.parse(String(rows(s, "SELECT value FROM run_decisions WHERE run_id = 1 AND kind = 'received' AND target = '1'")[0]!.value)), { arrived: 'none' });
  // So is a line marked not arrived after approval.
  const { addCorrection } = await import('../src/runs/store.ts');
  addCorrection(s.app.shelf.db, { userId: null, username: 'mgr' }, 1, { line: 2, variationId: 'V_CRACKER', stockTakeBack: '24', stockUnit: 'unit', creditCents: 6000 }, Date.now());
  assert.equal(rows(s, 'SELECT credit_cents FROM run_corrections WHERE run_id = 1 AND line = 2')[0]!.credit_cents, 6000);
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 0);
});

test('markup in a run reading is escaped on the purchase history list', async (t) => {
  const s = await makeRunApp({ inv: testInvoice({ supplier_name: '<img src=x onerror=alert(1)>', invoice_number: '<b>7</b>' }) });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await readRun(s, mgr);
  assert.equal(rows(s, 'SELECT * FROM purchase_invoices').length, 1);
  const body = (await get(s, '/history', mgr.cookie)).body;
  assert.doesNotMatch(body, /<img src=x|<b>7<\/b>/);
  assert.match(body, /Invoice run 1: &lt;img src=x onerror=alert\(1\)&gt; #&lt;b&gt;7&lt;\/b&gt;/);
});
