// Tests for the step 6 review fixes: case sizes, not-for-resale confirmation and undo, big price
// changes, location prices, What arrived and corrections, state moves, catalog times, upload
// limits, spend cap and duplicate invoices. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { canMove } from '../src/runs/states.ts';
import { decide, fakeCatalogSource, makeRunApp, modelFor, runState, signIn, testInvoice, upload, uploadPhoto, type RunApp } from './runs-fixtures.ts';
import { line, testImage } from './invoice-fixtures.ts';
import { item, LOCATION, POUND, CAT_CHEESE, CAT_CRACKERS, UPC_CRACKER } from './matching-fixtures.ts';
import { ORIGIN, ADMIN_PW } from './server-helpers.ts';
import { createSquareReader } from '../src/square/client.ts';
import { defaultSettings } from '../src/settings/schema.ts';

type Session = { cookie: string; csrf: string };

async function settle(s: RunApp, mgr: Session, id = 1): Promise<void> {
  await s.app.shelf.runner.drain();
  await decide(s, mgr, `/runs/${id}/supplier`, { create: '1' });
  await decide(s, mgr, `/runs/${id}/lines/1/pick`, { variationId: 'V_GOUDA' });
  await decide(s, mgr, `/runs/${id}/lines/3/pick`, { variationId: 'V_SALMON' });
}

async function dryRun(s: RunApp, mgr: Session, id = 1): Promise<Record<string, any>> {
  assert.equal(runState(s, id), 'ready');
  await decide(s, mgr, `/runs/${id}/dry-run`);
  await s.app.shelf.runner.drain();
  assert.equal(runState(s, id), 'dry_run_done');
  return JSON.parse((s.app.shelf.db.prepare('SELECT dry_run FROM runs WHERE id = ?').get(id) as { dry_run: string }).dry_run);
}

const page = async (s: RunApp, mgr: Session, url = '/runs/1') => (await s.app.inject({ method: 'GET', url, headers: { cookie: mgr.cookie } })).body;

test('C1: a missing case size is entered once, checked, saved with the match and used next time', async (t) => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, pack_size: '' };
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr, 1);
  await settle(s, mgr);
  assert.equal(runState(s), 'review');
  assert.match(await page(s, mgr), /name="unitsPerCase"/);
  for (const bad of ['0', '-3', '2.5', 'twelve', '']) assert.equal((await decide(s, mgr, '/runs/1/lines/2/pack', { unitsPerCase: bad })).statusCode, 400, bad);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/pack', { unitsPerCase: '12' })).statusCode, 303);
  assert.equal(runState(s), 'ready');
  assert.match(await page(s, mgr), /Case size from saved match: 12 units/);
  // The next invoice from the supplier leaves it out too, and the saved size is used.
  await uploadPhoto(s, mgr, 2);
  await s.app.shelf.runner.drain();
  assert.equal(runState(s, 2), 'ready');
  assert.match(await page(s, mgr, '/runs/2'), /Case size from saved match: 12 units/);
});

test('C1: a unit weight prices and stocks a line sold by the pound on the invoice but by the unit in Square', async (t) => {
  const inv = testInvoice();
  inv.lines[1] = line({ item_number: 'C200', upc: UPC_CRACKER, description: 'BLUECREST SEA SALT CRACKERS', unit: 'LB', price_unit: 'LB', qty_shipped: '4', unit_price: '3.00', extension: '12.00' });
  inv.total = '147.00';
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  assert.match(await page(s, mgr), /name="poundsPerUnit"/);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/pack', { poundsPerUnit: '0' })).statusCode, 400);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/pack', { poundsPerUnit: '0.5' })).statusCode, 303);
  const body = await page(s, mgr);
  assert.match(body, /0\.50 lb per unit/);
  assert.match(body, /Stock to set: 8 units/);
  // 3.00 a pound for half a pound is 1.50 a unit; 2 x 1.50 + 1 = 4.00, rounded to 4.99.
  assert.match(body, /Price: \$5\.99 now, \$4\.99/);
});

test('C2: not for resale needs a confirmation, can be undone, and a picked item can replace it', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/not-for-resale')).statusCode, 400);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/not-for-resale', { confirm: '1' })).statusCode, 303);
  let body = await page(s, mgr);
  assert.match(body, /Not for resale: line 2/);
  assert.match(body, /Undo also forgets the saved match/);
  assert.match(body, /action="\/runs\/1\/lines\/2\/pick"/, 'pick is offered on a not-for-resale line');
  const saved = () => (s.app.shelf.db.prepare("SELECT count(*) AS n FROM item_mappings WHERE kind = 'not_for_resale'").get() as { n: number }).n;
  assert.equal(saved(), 1);
  assert.equal((await decide(s, mgr, '/runs/1/undo', { kind: 'not_for_resale', target: '2' })).statusCode, 303);
  assert.equal(saved(), 0, 'undo forgets the saved mark too');
  body = await page(s, mgr);
  assert.match(body, /Will update Square[\s\S]*<span class="line-no">3<\/span>/);
  // An accepted check can be undone as well.
  assert.match(body, /Decisions on this invoice/);
});

test('C3: a price moving more than 30% needs its own tick, tied to the prices shown, with a count on both pages', async (t) => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, unit_price: '48.00', extension: '96.00' };
  inv.total = '231.00';
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  assert.equal(runState(s), 'review');
  let body = await page(s, mgr);
  // 48 / 12 = 4.00; 2 x 4 + 1 = 9.00, so 9.99 against 5.99: up 67%.
  assert.match(body, /1 price moves more than 30%\.<\/strong> 1 still needs its own tick/);
  assert.match(body, /class="line big-change over-half"/);
  assert.match(body, /Price goes up 67%, from \$5\.99 to \$9\.99\. Over 50%: the scales will ask too\./);
  assert.equal((await decide(s, mgr, '/runs/1/big-change', { variationId: 'V_CRACKER', fromCents: '599', toCents: '899' })).statusCode, 409);
  assert.equal((await decide(s, mgr, '/runs/1/big-change', { variationId: 'V_CRACKER', fromCents: '599', toCents: '999' })).statusCode, 303);
  const p = await dryRun(s, mgr);
  assert.deepEqual(p.square.find((x: any) => x.variationId === 'V_CRACKER').bigChange, { percent: 67, up: true, overHalf: true });
  body = await page(s, mgr, '/runs/1/dry-run');
  assert.match(body, /1 price moves more than 30%/);
  assert.match(body, /Price goes up 67%\. Confirmed in review\. Over 50%: the scales will ask too\./);
});

const LOCAL_PRICE = item({ id: 'I_LOCAL', name: 'Bluecrest - Rye Crisps', category: CAT_CRACKERS, variations: [{ id: 'V_LOCAL', upc: '000111222445', cents: 599 }] });
(LOCAL_PRICE.item_data as any).variations[0].item_variation_data.location_overrides = [{ location_id: LOCATION, price_money: { amount: 649, currency: 'USD' } }];
const LOCAL_VARIABLE = item({ id: 'I_SMOKED', name: 'Smoked Trout 4105', category: CAT_CHEESE, variations: [{ id: 'V_SMOKED', cents: 1999, unit: POUND }] });
(LOCAL_VARIABLE.item_data as any).variations[0].item_variation_data.location_overrides = [{ location_id: LOCATION, pricing_type: 'VARIABLE_PRICING' }];

test('C4 and C7: a store price override is recorded on a plain price change and on a switch to sold by weight', async (t) => {
  const inv = testInvoice();
  inv.lines.push(line({ item_number: 'R1', upc: '000111222445', description: 'BLUECREST RYE CRISPS', pack_size: '12/4Z', unit: 'CS', qty_shipped: '1', unit_price: '30.00', extension: '30.00' }));
  inv.lines.push(line({ item_number: 'T1', description: 'SMOKED TROUT', unit: 'LB', qty_shipped: '1', weight: '2', unit_price: '9.00', extension: '18.00' }));
  inv.total = '243.00';
  const s = await makeRunApp({ inv, deps: { catalogSource: fakeCatalogSource([LOCAL_PRICE, LOCAL_VARIABLE]) } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  await decide(s, mgr, '/runs/1/lines/5/pick', { variationId: 'V_SMOKED' });
  const p = await dryRun(s, mgr);
  const rye = p.square.find((x: any) => x.variationId === 'V_LOCAL');
  assert.deepEqual(rye.price, { fromCents: 649, toCents: 699, perPound: false, locationOverride: true });
  assert.equal(p.square.find((x: any) => x.variationId === 'V_CRACKER').price.locationOverride, false);
  const trout = p.square.find((x: any) => x.variationId === 'V_SMOKED');
  assert.equal(trout.switchToWeight.locationOverride, true);
  const body = await page(s, mgr, '/runs/1/dry-run');
  assert.match(body, /, at this store too\./);
  assert.match(body, /The store has its own price for this item: it is changed too/);
});

test('C5: What arrived starts from the invoice, notes need a person, and nothing arrived keeps today\'s price', async (t) => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, annotations: [{ kind: 'handwritten', text: 'not on truck', meaning: 'not_received' }] };
  inv.lines.push(line({ item_number: 'W1', description: 'NORTHFIELD WAFER CRACKERS PEPPER', printed_status: 'out_of_stock', qty_shipped: '0', unit: 'CS', pack_size: '6/5Z', unit_price: '20.00', extension: '0.00' }));
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  await decide(s, mgr, '/runs/1/lines/4/pick', { variationId: 'V_WAFER' });
  let body = await page(s, mgr);
  assert.match(body, /Line 2: Note says &quot;not on truck&quot;[^<]*Confirm what arrived/);
  assert.match(body, /What arrived: None of it \(from the invoice\)/, 'an Out line starts as none without asking');
  assert.equal(runState(s), 'review');
  // Pieces for a packaged item: pounds are refused.
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/arrived', { arrived: 'some', pounds: '3' })).statusCode, 400);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/arrived', { arrived: 'some', pieces: '18' })).statusCode, 303);
  body = await page(s, mgr);
  assert.match(body, /Line 2: \$15\.00\. Charged for 24\.00 pieces, 18\.00 arrived\./);
  assert.match(body, /Stock to set: 18 units/);
  // Pounds for a by-weight item, compared with the pounds shipped.
  assert.equal((await decide(s, mgr, '/runs/1/lines/1/arrived', { arrived: 'some', pieces: '1' })).statusCode, 400);
  assert.equal((await decide(s, mgr, '/runs/1/lines/1/arrived', { arrived: 'some', pounds: '7' })).statusCode, 303);
  body = await page(s, mgr);
  assert.match(body, /Line 1: \$21\.00\. Charged for 10\.50 lb, 7\.00 arrived\./);
  // None of line 2: no price, no stock, no scale change, no card.
  await decide(s, mgr, '/runs/1/lines/2/arrived', { arrived: 'none' });
  const p = await dryRun(s, mgr);
  assert.equal(p.square.some((x: any) => x.variationId === 'V_CRACKER' || x.variationId === 'V_WAFER'), false);
  assert.equal(p.cards.cards.some((c: any) => c.variationId === 'V_CRACKER'), false);
  assert.deepEqual(p.credits.find((c: any) => c.n === 2), { n: 2, cents: 6000, reason: 'Charged but not delivered.' });
  assert.equal(p.square.find((x: any) => x.variationId === 'V_GOUDA').stock.to, '7.00');
});

test('C5: after approval a line can be marked not arrived, recording the stock to take back and the credit', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' })).statusCode, 409, 'not before approval');
  const p = await dryRun(s, mgr);
  await decide(s, mgr, '/runs/1/approve', { hash: p.hash });
  assert.equal(runState(s), 'approved');
  assert.match(await page(s, mgr, '/runs/1/dry-run'), /Line 2 did not arrive\?/);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/not-arrived')).statusCode, 400);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' })).statusCode, 303);
  assert.equal((await decide(s, mgr, '/runs/1/lines/2/not-arrived', { confirm: '1' })).statusCode, 409);
  const c = s.app.shelf.db.prepare('SELECT * FROM run_corrections').get() as Record<string, unknown>;
  assert.equal(c.stock_take_back, '24');
  assert.equal(c.stock_unit, 'unit');
  assert.equal(c.credit_cents, 6000);
  assert.equal(c.state, 'pending');
  assert.equal(c.recorded_by_name, 'mgr');
  assert.match(await page(s, mgr, '/runs/1/dry-run'), /Line 2 did not arrive: take 24 units back out of stock, credit \$60\.00\. Recorded by mgr\. Waiting to be sent/);
  assert.equal(s.writer.calls, 0);
});

test('C6: review and needs_approval can move to retry, and a job failing before the reading leaves a clear message', async (t) => {
  assert.ok(canMove('review', 'retry'));
  assert.ok(canMove('needs_approval', 'retry'));
  const failing = fakeCatalogSource();
  failing.load = async () => {
    throw new Error('network down');
  };
  const s = await makeRunApp({ deps: { catalogSource: failing } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  assert.equal(runState(s), 'retry');
  const msg = (s.app.shelf.db.prepare('SELECT message FROM runs').get() as { message: string }).message;
  assert.match(msg, /^Stopped before the reading: Something went wrong/);
  assert.doesNotMatch(msg, /network down/);
  assert.equal(s.model.calls.length, 0);
});

test('C7: a rename shows in the preview with the code kept, and the card takes the new name', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  assert.equal((await decide(s, mgr, '/runs/1/rename', { itemId: 'I_GOUDA', name: 'Smoked Gouda' })).statusCode, 303);
  const p = await dryRun(s, mgr);
  const g = p.square.find((x: any) => x.variationId === 'V_GOUDA');
  assert.deepEqual(g.rename, { from: 'Gouda Smoked 7101', to: 'Smoked Gouda 7101' });
  assert.equal(p.cards.cards.find((c: any) => c.variationId === 'V_GOUDA').title, 'Smoked Gouda');
  assert.equal(p.scales.changes.find((c: any) => c.code === '7101').itemName, 'Smoked Gouda 7101');
});

test('C8: a rename ending in four digits is refused for an item with no scale code', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  const res = await decide(s, mgr, '/runs/1/rename', { itemId: 'I_CRACKER', name: 'Sea Salt Crackers 2024' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /reads as a scale code/);
});

test('C8: a run keeps its own catalog time even when the catalog copy is shared with an older run', async (t) => {
  const src = fakeCatalogSource();
  let taken = '2026-11-06T10:00:00.000Z';
  const load = src.load.bind(src);
  src.load = async () => ({ ...(await load()), takenAt: taken });
  const s = await makeRunApp({ deps: { catalogSource: src } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr, 1);
  await s.app.shelf.runner.drain();
  taken = '2026-11-06T16:30:00.000Z';
  await uploadPhoto(s, mgr, 2);
  await s.app.shelf.runner.drain();
  const rows = s.app.shelf.db.prepare('SELECT catalog_snapshot_id AS id, catalog_taken_at AS t FROM runs ORDER BY id').all() as { id: number; t: string }[];
  assert.equal(rows[0]!.id, rows[1]!.id, 'the copy is shared');
  assert.deepEqual(rows.map((r) => r.t), ['2026-11-06T10:00:00.000Z', '2026-11-06T16:30:00.000Z']);
});

test('C7: a restart during a cost-approved resumed reading does not read again on its own', async (t) => {
  const { tempDir } = await import('./server-helpers.ts');
  const { makeAppWith, failingWriter, SCALES } = await import('./runs-fixtures.ts');
  const { rmSync } = await import('node:fs');
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deps = (model: ReturnType<typeof modelFor>) => ({ modelClient: model, catalogSource: fakeCatalogSource(), squareWriter: failingWriter(), startRunner: false, invoiceSettings: { costCapUsd: 0.001 } });
  const a = await makeAppWith({ scaleNames: SCALES }, deps(modelFor(testInvoice())), dir);
  const mgr = await signIn(a);
  await uploadPhoto(a, mgr);
  await a.app.shelf.runner.drain();
  const admin = await signIn(a, 'admin');
  const row = a.app.shelf.db.prepare('SELECT approval_model AS m, approval_estimate_usd AS e FROM runs').get() as { m: string; e: string };
  await decide(a, admin, '/runs/1/approve-cost', { model: row.m, estimateUsd: row.e });
  // As if it died during the approved reading.
  a.app.shelf.db.exec("UPDATE run_jobs SET state = 'running' WHERE resume_approved = 1; UPDATE runs SET state = 'reading'");
  await a.app.close();
  const model = modelFor(testInvoice());
  const b = await makeAppWith({ scaleNames: SCALES }, deps(model), dir);
  t.after(() => b.app.close());
  await b.app.shelf.runner.drain();
  assert.equal(model.calls.length, 0);
  assert.equal(runState(b), 'retry');
});

test('S1: refused attempts count toward the hourly limit, and a daily byte budget and a free-space floor apply', async (t) => {
  const s = await makeRunApp({ config: { uploads: { perUserPerHour: 2 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const photo = await testImage(1);
  for (let i = 0; i < 2; i++) assert.equal((await upload(s, mgr.cookie, [{ name: '_csrf', value: 'wrong' }, { name: 'files', filename: 'a.jpg', type: 'image/jpeg', data: photo }])).statusCode, 403);
  assert.equal((await uploadPhoto(s, mgr)).statusCode, 429);

  const b = await makeRunApp({ config: { uploads: { maxBytesPerDay: 1000 } } });
  t.after(() => b.close());
  const m2 = await signIn(b);
  assert.equal((await uploadPhoto(b, m2)).statusCode, 429);

  const c = await makeRunApp({ config: { uploads: { minFreeBytes: Number.MAX_SAFE_INTEGER } } });
  t.after(() => c.close());
  const m3 = await signIn(c);
  assert.equal((await uploadPhoto(c, m3)).statusCode, 507);
});

test('S1: one upload in progress per person at a time', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  let push!: (b: Buffer | null) => void;
  const slow = new Readable({ read() {} });
  push = (b) => slow.push(b);
  const first = s.app.inject({ method: 'POST', url: '/runs', headers: { cookie: mgr.cookie, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=zz', 'content-length': '5000' }, payload: slow });
  await new Promise((r) => setTimeout(r, 50));
  const second = await uploadPhoto(s, mgr, 2);
  assert.equal(second.statusCode, 429);
  assert.match(second.body, /Another upload is still in progress/);
  push(Buffer.from(`--zz\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\nwrong\r\n--zz--\r\n`));
  push(null);
  assert.equal((await first).statusCode, 403);
  assert.equal((await uploadPhoto(s, mgr, 3)).statusCode, 303, 'the slot is free again');
});

test('S3: a conflict pick for a name like __proto__ is refused, not a crash', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await settle(s, mgr);
  for (const v of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal((await decide(s, mgr, '/runs/1/conflict', { variationId: v, priceCents: '100' })).statusCode, 400, v);
  }
});

test('S4: the daily reading cap stops for an admin, and the same files or invoice twice are caught', async (t) => {
  const s = await makeRunApp({ settings: { dailyLimitUsd: '0.00' } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr, 1);
  await s.app.shelf.runner.drain();
  assert.equal(runState(s), 'needs_approval');
  assert.equal(s.model.calls.length, 0);
  assert.match(await page(s, mgr), /daily limit/);
  const admin = await signIn(s, 'admin');
  const row = s.app.shelf.db.prepare('SELECT approval_model AS m, approval_estimate_usd AS e FROM runs').get() as { m: string; e: string };
  assert.equal((await decide(s, admin, '/runs/1/approve-cost', { model: row.m, estimateUsd: row.e })).statusCode, 303);
  await settle(s, mgr);
  const p = await dryRun(s, mgr);
  await decide(s, mgr, '/runs/1/approve', { hash: p.hash });
  assert.equal(runState(s), 'approved');

  // The same photo again, read after another approval of the daily cap.
  await uploadPhoto(s, mgr, 1);
  await s.app.shelf.runner.drain();
  const row2 = s.app.shelf.db.prepare('SELECT approval_model AS m, approval_estimate_usd AS e FROM runs WHERE id = 2').get() as { m: string; e: string };
  await decide(s, admin, '/runs/2/approve-cost', { model: row2.m, estimateUsd: row2.e });
  await s.app.shelf.runner.drain();
  assert.match(await page(s, mgr, '/runs/2'), /The same files were uploaded in <a href="\/runs\/1">invoice 1<\/a>/);
  const p2 = await dryRun(s, mgr, 2);
  const res = await decide(s, mgr, '/runs/2/approve', { hash: p2.hash });
  assert.equal(res.statusCode, 409);
  assert.match(res.body, /already approved\. Approving this one would add the stock twice/);
  void ADMIN_PW;
});

test('S5: a Square reply over the size cap is cancelled while it is read', async () => {
  let cancelled = false;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      sent++;
      c.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const f = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
  const values = { ...defaultSettings(), squareEnvironment: 'sandbox' as const };
  const r = createSquareReader({ getSetting: (n) => values[n], getSecret: () => ['EAAA', 'y'.repeat(40)].join(''), allowSquareProduction: false, fetch: f });
  await assert.rejects(r.listLocations(), /too large/);
  assert.ok(cancelled);
  assert.ok(sent < 30, `read ${sent} MB`);
});

test('review 3, item 1: a saved case size stays with its item; re-picking the line to another item drops it', async (t) => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, pack_size: '' };
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr, 1);
  await settle(s, mgr);
  await decide(s, mgr, '/runs/1/lines/2/pack', { unitsPerCase: '12' });
  assert.match(await page(s, mgr), /Case size from saved match: 12 units/);
  await decide(s, mgr, '/runs/1/lines/2/pick', { variationId: 'V_CRACKER_ROSE' });
  const body = await page(s, mgr);
  assert.doesNotMatch(body, /Case size from saved match/);
  assert.match(body, /name="unitsPerCase"/);
  assert.equal((s.app.shelf.db.prepare('SELECT count(*) AS n FROM item_mapping_packs').get() as { n: number }).n, 0);
});

test('review 3, item 2: undo of a pick puts back the saved match it replaced, with its wordings and pack', async (t) => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, pack_size: '' };
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr, 1);
  await settle(s, mgr);
  await decide(s, mgr, '/runs/1/lines/2/pack', { unitsPerCase: '12' });
  const before = s.app.shelf.db.prepare("SELECT m.square_variation_id AS v, p.units_per_case AS u, (SELECT count(*) FROM item_mapping_wordings w WHERE w.mapping_id = m.id) AS w FROM item_mappings m LEFT JOIN item_mapping_packs p ON p.mapping_id = m.id WHERE m.item_number = 'C200'").get();
  // A second invoice: the line matches the saved crackers; the manager re-picks it, then undoes that.
  await uploadPhoto(s, mgr, 2);
  await s.app.shelf.runner.drain();
  await decide(s, mgr, '/runs/2/lines/2/pick', { variationId: 'V_CRACKER_ROSE' });
  assert.match(await page(s, mgr, '/runs/2'), /Undo also puts back the saved match this supplier item had before/);
  assert.equal((await decide(s, mgr, '/runs/2/undo', { kind: 'pick', target: '2' })).statusCode, 303);
  const after = s.app.shelf.db.prepare("SELECT m.square_variation_id AS v, p.units_per_case AS u, (SELECT count(*) FROM item_mapping_wordings w WHERE w.mapping_id = m.id) AS w FROM item_mappings m LEFT JOIN item_mapping_packs p ON p.mapping_id = m.id WHERE m.item_number = 'C200'").get();
  assert.deepEqual(after, before);
  assert.deepEqual({ ...(before as object) }, { v: 'V_CRACKER', u: 12, w: 1 });
  assert.equal((s.app.shelf.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'mapping.restore'").get() as { n: number }).n, 1);
  assert.match(await page(s, mgr, '/runs/2'), /Case size from saved match: 12 units/);
});

test('review 3, item 3: the big-change limit comes from the settings, and the pages show it', async (t) => {
  const inv = testInvoice();
  // Cost 3.25 a unit: the shelf price goes from $5.99 to $7.99, a 33.4 percent rise.
  inv.lines[1] = { ...inv.lines[1]!, unit_price: '39.00', extension: '78.00' };
  inv.total = '213.00';
  const loose = await makeRunApp({ inv, settings: { bigChangePercent: '50' } });
  t.after(() => loose.close());
  const m1 = await signIn(loose);
  await uploadPhoto(loose, m1);
  await settle(loose, m1);
  assert.equal(runState(loose), 'ready', 'a 33% rise is under a 50% limit');
  const strict = await makeRunApp({ inv, settings: { bigChangePercent: '30' } });
  t.after(() => strict.close());
  const m2 = await signIn(strict);
  await uploadPhoto(strict, m2);
  await settle(strict, m2);
  assert.match(await page(strict, m2), /1 price moves more than 30%\./);
  // A rise of 33.4 percent over a limit of 33 reads 34%, never 33% beside "more than 33%".
  const edge = await makeRunApp({ inv, settings: { bigChangePercent: '33' } });
  t.after(() => edge.close());
  const m3 = await signIn(edge);
  await uploadPhoto(edge, m3);
  await settle(edge, m3);
  const body = await page(edge, m3);
  assert.match(body, /1 price moves more than 33%\./);
  assert.match(body, /the price goes up 34%|Price goes up 34%, from \$5\.99 to \$7\.99/);
  assert.doesNotMatch(body, /up 33%/);
});

test('review 3, item 4: each person has a share of the daily bytes, attempts over the limit are not recorded, and underscore flags are refused', async (t) => {
  const s = await makeRunApp({ config: { uploads: { maxBytesPerUserPerDay: 1000, perUserPerHour: 2 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const res = await uploadPhoto(s, mgr);
  assert.equal(res.statusCode, 429);
  assert.match(res.body, /daily share/);
  await uploadPhoto(s, mgr);
  for (let i = 0; i < 5; i++) assert.equal((await uploadPhoto(s, mgr)).statusCode, 429);
  assert.equal((s.app.shelf.db.prepare('SELECT count(*) AS n FROM upload_attempts').get() as { n: number }).n, 2, 'attempts over the limit add no rows');

  const values = { ...defaultSettings(), squareEnvironment: 'sandbox' as const };
  const f = (async () => new Response('{}')) as unknown as typeof fetch;
  const r = createSquareReader({ getSetting: (n) => values[n], getSecret: () => ['EAAA', 'z'.repeat(40)].join(''), allowSquareProduction: false, fetch: f });
  const old = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--use_env_proxy';
  try {
    await assert.rejects(r.listLocations(), /proxy or certificate flag/);
  } finally {
    if (old === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = old;
  }
});
