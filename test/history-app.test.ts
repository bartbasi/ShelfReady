// Old invoices through the real app: record only, duplicates, access, the downloads and removal.
// A fake model client, a Square writer and fetch that fail on any call, and a catalog source that
// counts its loads. Invented invoices only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import type { ModelInvoice } from '../src/invoice/types.ts';
import { fakeClient, image, invoice, line, testImage } from './invoice-fixtures.ts';
import { makeRunApp, multipart, signIn, type Part, type RunApp } from './runs-fixtures.ts';
import { ageReauth, get, ORIGIN, type TestApp } from './server-helpers.ts';

function oldInvoice(fields: Partial<ModelInvoice> = {}): ModelInvoice {
  const number = fields.invoice_number ?? 'HC-1001';
  return invoice({
    supplier_name: 'Hollow Creek Dairy',
    invoice_number: number,
    invoice_date: '03/14/26',
    invoice_date_iso: '2026-03-14',
    images: [image({ invoice_number: number })],
    lines: [
      line({ item_number: 'K1', description: '2 Year Old Cheddar', qty_shipped: '5', unit: 'LB', unit_price: '6.00', price_unit: 'LB', extension: '30.00' }),
      line({ item_number: 'W2', description: 'Wasabi Paste', units_per_pack: '12', qty_shipped: '2', unit: 'CS', unit_price: '36.00', price_unit: 'CS', extension: '72.00', confidence: 'medium', confidence_note: 'smudge' }),
    ],
    total: '102.00',
    ...fields,
  });
}

function modelReading(...invoices: ModelInvoice[]) {
  return fakeClient({ 'claude-sonnet-5-5': invoices.map((json) => ({ json })), 'claude-opus-5-5': invoices.map((json) => ({ json })) });
}

async function uploadOld(t: TestApp, cookie: string, parts: Part[], headers: Record<string, string> = {}) {
  const { payload, contentType } = multipart(parts);
  return t.app.inject({ method: 'POST', url: '/history', headers: { cookie, origin: ORIGIN, 'content-type': contentType, ...headers }, payload });
}

async function uploadOldPhoto(t: TestApp, who: { cookie: string; csrf: string }, seed = 1) {
  return uploadOld(t, who.cookie, [
    { name: '_csrf', value: who.csrf },
    { name: 'files', filename: `old${seed}.jpg`, type: 'image/jpeg', data: await testImage(seed) },
  ]);
}

function count(t: TestApp, table: string, where = ''): number {
  return (t.app.shelf.db.prepare(`SELECT count(*) AS n FROM ${table}${where ? ` WHERE ${where}` : ''}`).get() as { n: number }).n;
}

function state(t: TestApp, id: number): { state: string; message: string } {
  return t.app.shelf.db.prepare('SELECT state, message FROM purchase_invoices WHERE id = ?').get(id) as { state: string; message: string };
}

function historyDir(t: TestApp): string {
  return join(dirname(t.config.dbPath), 'history-uploads');
}

function storedHistoryFiles(t: TestApp): string[] {
  return existsSync(historyDir(t)) ? readdirSync(historyDir(t)) : [];
}

async function post(t: TestApp, who: { cookie: string; csrf: string }, url: string, fields: Record<string, string> = {}) {
  return t.app.inject({
    method: 'POST',
    url,
    headers: { cookie: who.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ _csrf: who.csrf, ...fields }).toString(),
  });
}

async function app(...invoices: ModelInvoice[]): Promise<RunApp> {
  return makeRunApp({ model: modelReading(...(invoices.length ? invoices : [oldInvoice()])), cards: false });
}

test('the hard requirement: an old invoice creates no run and touches nothing in Square, the scales or the cards', async (t) => {
  const s = await app();
  t.after(() => s.close());
  const mgr = await signIn(s);
  const before = { cards: count(s, 'cards'), links: count(s, 'card_links'), copy: count(s, 'run_copy') };
  const res = await uploadOldPhoto(s, mgr);
  assert.equal(res.statusCode, 303, res.body.slice(0, 300));
  assert.equal(res.headers.location, '/history/1');
  await s.app.shelf.history.drain();
  // The invoice runs' own runner finds nothing to do.
  await s.app.shelf.runner.drain();
  assert.equal(state(s, 1).state, 'done', state(s, 1).message);
  assert.equal(count(s, 'purchase_lines'), 2);
  for (const table of ['runs', 'run_files', 'run_jobs', 'run_events', 'run_decisions', 'run_sends', 'square_writes', 'scale_steps', 'scale_pending', 'scale_resends', 'card_sheets', 'run_corrections', 'mailchimp_tasks', 'mailchimp_held', 'catalog_snapshots', 'item_mappings', 'suppliers', 'price_overrides']) {
    assert.equal(count(s, table), 0, `${table} has no rows`);
  }
  assert.deepEqual({ cards: count(s, 'cards'), links: count(s, 'card_links'), copy: count(s, 'run_copy') }, before, 'no card was made or changed');
  assert.equal(s.writer.calls, 0, 'no Square write');
  assert.equal(s.fetch.calls, 0, 'no network call');
  assert.equal(s.source.loads, 0, 'the Square catalog was not even read');
  assert.equal(s.model.calls.length, 1, 'one reading');
  // The reading's cost is in the shared ledger, under the old invoice, not a run.
  const spend = s.app.shelf.db.prepare('SELECT run_id, source, purchase_invoice_id, kind, state, usd FROM model_spend').all() as Array<Record<string, unknown>>;
  assert.equal(spend.length, 1);
  assert.equal(spend[0]!.run_id, null);
  assert.equal(spend[0]!.purchase_invoice_id, 1);
  assert.equal(spend[0]!.source, 'history');
  assert.equal(spend[0]!.state, 'booked');
  assert.ok(Number(spend[0]!.usd) > 0);
  // The log: upload and reading, both under the old invoice.
  const actions = (s.app.shelf.db.prepare("SELECT action, run_id FROM audit_log WHERE action LIKE 'history.%' ORDER BY id").all() as Array<{ action: string; run_id: number | null }>);
  assert.deepEqual(actions.map((a) => a.action), ['history.upload', 'history.read']);
  assert.ok(actions.every((a) => a.run_id === null));
  // The page says it plainly.
  const page = await get(s, '/history/1', mgr.cookie);
  assert.match(page.body, /Old invoice: record only\.<\/strong> Nothing changes in Square, the scales or the cards\./);
  assert.match(page.body, /Hollow Creek Dairy/);
  assert.match(page.body, /2 Year Old Cheddar/);
  assert.match(page.body, /The reader was not fully sure: smudge\./);
  assert.match(page.body, /href="\/history\/1\/files\/1"/);
  assert.match(page.body, /2, 1 to check/);
  // Invoice text stays out of the server log: it carries ids, never what an invoice says.
  assert.doesNotMatch(s.logs.join('\n'), /Hollow Creek|Cheddar|Wasabi/);
});

test('text read from an invoice is escaped on the pages', async (t) => {
  const s = await app(oldInvoice({ supplier_name: '<img src=x onerror=alert(1)>', lines: [line({ description: '<script>alert(1)</script>', extension: '20.00' })], total: '20.00' }));
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadOldPhoto(s, mgr);
  await s.app.shelf.history.drain();
  for (const url of ['/history', '/history/1']) {
    const body = (await get(s, url, mgr.cookie)).body;
    assert.doesNotMatch(body, /<script>alert|<img src=x/, url);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/, url);
  }
});

test('the upload page says record only, with the token first and the same limits as invoice runs', async (t) => {
  const s = await app();
  t.after(() => s.close());
  const mgr = await signIn(s);
  const page = await get(s, '/history/new', mgr.cookie);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Old invoice: record only\.<\/strong> Nothing changes in Square, the scales or the cards\./);
  assert.match(page.body, /action="\/history" enctype="multipart\/form-data" class="stack"[^>]*>\s*<input type="hidden" name="_csrf"/);
  assert.match(page.body, /Up to 10 photos, or one PDF of up to 20 pages/);
  // The form token is random and can hold "--", so its value is taken out before the check.
  assert.doesNotMatch(page.body.replace(/(name="_csrf" value=")[^"]*"/g, '$1"'), /\u2014|\u2013|--|\sstyle=|<script>/);
  for (const url of ['/history', '/history/new', '/']) {
    const body = (await get(s, url, mgr.cookie)).body;
    assert.match(body, /href="\/history"/, `${url} links to old invoices`);
    assert.doesNotMatch(body, /\u2014|\u2013|--/, url);
  }
  assert.match((await get(s, '/history', mgr.cookie)).body, /href="\/history" aria-current="page">Purchase history</);
  assert.match((await get(s, '/', mgr.cookie)).body, /class="tile" href="\/history"/);
});

test('the CSRF token must come first, and refused uploads keep nothing', async (t) => {
  const s = await makeRunApp({ model: modelReading(oldInvoice()), cards: false, deps: { invoiceSettings: { upload: { maxFiles: 2, maxFileBytes: 30_000, maxPdfPages: 2 } } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const photo = await testImage(1, 120, 160);
  const file = (name: string, data: Buffer, type = 'image/jpeg') => ({ name: 'files', filename: name, type, data });
  for (const parts of [[file('a.jpg', photo), { name: '_csrf', value: mgr.csrf }], [{ name: '_csrf', value: 'wrong' }, file('a.jpg', photo)], [file('a.jpg', photo)]]) {
    assert.equal((await uploadOld(s, mgr.cookie, parts)).statusCode, 403);
  }
  const tok = { name: '_csrf', value: mgr.csrf };
  const cases: Array<[number, Part[], RegExp]> = [
    [413, [tok, file('a.jpg', photo), file('b.jpg', photo), file('c.jpg', photo)], /At most 2 files/],
    [413, [tok, file('big.jpg', Buffer.concat([photo, Buffer.alloc(40_000, 1)]))], /larger than/],
    [415, [tok, file('notes.jpg', Buffer.from('just some text, not a picture at all'))], /is not a JPEG/],
    [400, [tok], /at least one/],
  ];
  for (const [status, parts, msg] of cases) {
    const res = await uploadOld(s, mgr.cookie, parts);
    assert.equal(res.statusCode, status, String(msg));
    assert.match(res.body, msg);
  }
  assert.equal(count(s, 'purchase_invoices'), 0);
  assert.deepEqual(storedHistoryFiles(s), []);
  // Another origin is refused before anything.
  assert.equal((await uploadOld(s, mgr.cookie, [tok, file('a.jpg', photo)], { origin: 'https://evil.example' })).statusCode, 403);
  // A form post is not an upload.
  const form = await s.app.inject({ method: 'POST', url: '/history', headers: { cookie: mgr.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${mgr.csrf}` });
  assert.equal(form.statusCode, 415);
});

test('files are kept mode 600 in a folder only this user can open', async (t) => {
  const s = await app();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadOldPhoto(s, mgr);
  const { statSync } = await import('node:fs');
  const dir = historyDir(s);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const files = storedHistoryFiles(s);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^[0-9a-f]{32}$/);
  assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
});

test('an identical photo is refused at once; a failed upload does not count', async (t) => {
  const s = await app(oldInvoice());
  t.after(() => s.close());
  const mgr = await signIn(s);
  assert.equal((await uploadOldPhoto(s, mgr, 1)).statusCode, 303);
  const again = await uploadOldPhoto(s, mgr, 1);
  assert.equal(again.statusCode, 409);
  assert.match(again.body, /That photo was already uploaded, as old invoice 1\. It was not uploaded again\./);
  assert.equal(count(s, 'purchase_invoices'), 1);
  assert.equal(storedHistoryFiles(s).length, 1, 'the refused copy was not kept');
  // Once the first one has failed, the same photo may be uploaded again.
  s.app.shelf.db.prepare("UPDATE purchase_invoices SET state = 'failed' WHERE id = 1").run();
  assert.equal((await uploadOldPhoto(s, mgr, 1)).statusCode, 303);
});

test('the same vendor and invoice number is refused, however the vendor is printed', async (t) => {
  const first = oldInvoice({ supplier_name: 'Hollow Creek Dairy, Inc.' });
  const second = oldInvoice({ supplier_name: 'HOLLOW CREEK DAIRY', invoice_number: 'hc-1001' });
  const other = oldInvoice({ invoice_number: 'HC-1002' });
  const s = await app(first, second, other);
  t.after(() => s.close());
  const mgr = await signIn(s);
  for (const seed of [1, 2, 3]) assert.equal((await uploadOldPhoto(s, mgr, seed)).statusCode, 303);
  await s.app.shelf.history.drain();
  assert.equal(state(s, 1).state, 'done');
  const dup = state(s, 2);
  assert.equal(dup.state, 'failed');
  assert.match(dup.message, /^Already recorded as old invoice 1: Hollow Creek Dairy, Inc\. invoice HC-1001, dated 2026-03-14\. This copy was not saved\.$/);
  assert.equal(count(s, 'purchase_lines', 'invoice_id = 2'), 0);
  assert.equal(count(s, 'purchase_files', 'invoice_id = 2'), 0, 'its photo was not kept');
  assert.equal(storedHistoryFiles(s).length, 2);
  assert.equal(state(s, 3).state, 'done', 'another invoice number from the same vendor is fine');
  assert.equal(count(s, 'audit_log', "action = 'history.duplicate'"), 1);
  // The list shows both outcomes, newest first.
  const list = (await get(s, '/history', mgr.cookie)).body;
  assert.ok(list.indexOf('href="/history/3"') < list.indexOf('href="/history/1"'));
  assert.match(list, /tag-mute">Failed</);
  // The database refuses a second recorded copy too, whatever the code does.
  assert.throws(() => s.app.shelf.db.prepare("UPDATE purchase_invoices SET state = 'done', vendor_key = 'hollow creek dairy', invoice_number_key = 'HC-1001' WHERE id = 2").run(), /UNIQUE/);
});

test('a reading that fails, or a restart mid-reading, ends in failed with a plain message', async (t) => {
  const s = await makeRunApp({ model: fakeClient({ 'claude-sonnet-5-5': [new Error('boom')], 'claude-opus-5-5': [new Error('boom')] }), cards: false });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadOldPhoto(s, mgr, 1);
  await s.app.shelf.history.drain();
  const st = state(s, 1);
  assert.equal(st.state, 'failed');
  assert.match(st.message, /could not make a reading/);
  assert.doesNotMatch(st.message, /boom/, 'no raw error text');
  // A restart that finds an invoice still reading does not send it again.
  await uploadOldPhoto(s, mgr, 2);
  s.app.shelf.db.prepare("UPDATE purchase_invoices SET state = 'reading' WHERE id = 2").run();
  s.app.shelf.db.prepare("INSERT INTO model_spend (run_id, source, purchase_invoice_id, kind, state, usd, estimate, at, updated_at) VALUES (NULL, 'history', 2, 'read', 'reserved', 1, 1, 0, 0)").run();
  s.app.shelf.history.recover();
  assert.equal(state(s, 2).state, 'failed');
  assert.match(state(s, 2).message, /restarted while reading/);
  assert.equal(count(s, 'model_spend', "state = 'reserved'"), 0, 'the cut-short call stays booked at its worst case');
});

test('over the daily limit, uploads wait and are read later; a reading starts only if its worst case fits', async (t) => {
  const s = await makeRunApp({ model: modelReading(oldInvoice()), cards: false, settings: { dailyLimitUsd: '4.00', historySharePercent: '100' } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  // $3.50 spent: one more reading, up to the $1.00 cap, could reach $4.50, past the $4.00 limit.
  s.app.shelf.db.prepare("INSERT INTO model_spend (run_id, kind, state, usd, estimate, at, updated_at) VALUES (NULL, 'copy', 'booked', 3.5, 0, ?, ?)").run(Date.parse('2026-11-06T17:30:00Z'), Date.parse('2026-11-06T17:30:00Z'));
  await uploadOldPhoto(s, mgr);
  await s.app.shelf.history.drain();
  assert.equal(state(s, 1).state, 'uploaded');
  assert.match(state(s, 1).message, /^Waiting\. .*could pass the daily limit of \$4\.00/);
  assert.equal(s.model.calls.length, 0);
  s.advance(25 * 3600_000);
  await s.app.shelf.history.drain();
  assert.equal(state(s, 1).state, 'done');
});

test('access: signed-in managers and admins use it; only an admin removes, with a recent password', async (t) => {
  const s = await app();
  t.after(() => s.close());
  // Anonymous: nothing.
  for (const url of ['/history', '/history/new', '/history/1', '/history/1/files/1', '/history/download.xlsx', '/history/download.csv']) {
    const res = await get(s, url, '');
    assert.equal(res.statusCode, 303, url);
    assert.equal(res.headers.location, '/login', url);
  }
  assert.equal((await s.app.inject({ method: 'POST', url: '/history', headers: { origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '10' }, payload: 'xxxxxxxxxx' })).statusCode, 401);
  assert.equal((await s.app.inject({ method: 'POST', url: '/history/1/remove', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'confirm=1' })).statusCode, 401);
  // Every route declares its access, and removal is the one admin route.
  const routes = s.app.shelf.routes.filter((r) => r.url.startsWith('/history') && r.method !== 'HEAD');
  assert.ok(routes.length >= 7);
  for (const r of routes) assert.equal(r.access, r.url === '/history/:id/remove' ? 'admin' : 'user', `${r.method} ${r.url}`);

  const mgr = await signIn(s);
  await uploadOldPhoto(s, mgr);
  await s.app.shelf.history.drain();
  for (const url of ['/history', '/history/new', '/history/1', '/history/1/files/1', '/history/download.xlsx', '/history/download.csv']) {
    assert.equal((await get(s, url, mgr.cookie)).statusCode, 200, url);
  }
  assert.doesNotMatch((await get(s, '/history/1', mgr.cookie)).body, /\/history\/1\/remove/, 'a manager sees no remove button');
  const refused = await post(s, mgr, '/history/1/remove', { confirm: '1' });
  assert.equal(refused.statusCode, 403);
  assert.equal(count(s, 'purchase_invoices'), 1);

  const admin = await signIn(s, 'admin');
  assert.match((await get(s, '/history/1', admin.cookie)).body, /action="\/history\/1\/remove"/);
  // A bad token is refused.
  assert.equal((await post(s, { cookie: admin.cookie, csrf: 'nope' }, '/history/1/remove', { confirm: '1' })).statusCode, 403);
  // An old password must be typed again, and the confirm page leads back here.
  ageReauth(s, 60 * 60_000);
  const stale = await post(s, admin, '/history/1/remove', { confirm: '1' });
  assert.equal(stale.statusCode, 403);
  assert.match(stale.body, /name="next" value="\/history\/1"/);
  assert.equal(count(s, 'purchase_invoices'), 1);
  ageReauth(s, -60 * 60_000);
  // Without the tick box, nothing happens.
  const unticked = await post(s, admin, '/history/1/remove');
  assert.equal(unticked.statusCode, 400);
  assert.equal(count(s, 'purchase_invoices'), 1);
  const ok = await post(s, admin, '/history/1/remove', { confirm: '1' });
  assert.equal(ok.statusCode, 303);
  assert.equal(count(s, 'purchase_invoices'), 0);
  assert.equal(count(s, 'purchase_lines'), 0);
  assert.equal(count(s, 'purchase_files'), 0);
  assert.deepEqual(storedHistoryFiles(s), [], 'the photo is deleted');
  const log = s.app.shelf.db.prepare("SELECT username, details FROM audit_log WHERE action = 'history.remove'").get() as { username: string; details: string };
  assert.equal(log.username, 'bart');
  const details = JSON.parse(log.details) as Record<string, unknown>;
  assert.equal(details.vendor, 'Hollow Creek Dairy');
  assert.equal(details.invoiceNumber, 'HC-1001');
  assert.equal(details.lines, 2);
  // The spend it caused still counts toward the daily limit.
  assert.equal(count(s, 'model_spend'), 1);
  assert.equal((await get(s, '/history/1', admin.cookie)).statusCode, 404);
});

test('the downloads: xlsx and csv, with optional dates on the invoice date', async (t) => {
  const s = await app(oldInvoice(), oldInvoice({ invoice_number: 'HC-2002', invoice_date_iso: '2026-06-01', invoice_date: '06/01/26', supplier_name: 'Kaito Trading' }));
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadOldPhoto(s, mgr, 1);
  await uploadOldPhoto(s, mgr, 2);
  await s.app.shelf.history.drain();
  const x = await s.app.inject({ method: 'GET', url: '/history/download.xlsx', headers: { cookie: mgr.cookie } });
  assert.equal(x.statusCode, 200);
  assert.equal(x.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(x.headers['content-disposition'], 'attachment; filename="purchase-history-all.xlsx"');
  const sheet = strFromU8(unzipSync(x.rawPayload)['xl/worksheets/sheet1.xml']!);
  assert.equal((sheet.match(/<row /g) ?? []).length, 5, 'a header and four lines');
  assert.doesNotMatch(sheet, /<f[\s>/]/);
  assert.ok(sheet.indexOf('Hollow Creek Dairy') < sheet.indexOf('Kaito Trading'), 'oldest invoice first');

  const c = await s.app.inject({ method: 'GET', url: '/history/download.csv?from=2026-05-01&to=2026-12-31', headers: { cookie: mgr.cookie } });
  assert.equal(c.statusCode, 200);
  assert.equal(c.headers['content-type'], 'text/csv; charset=utf-8');
  assert.equal(c.headers['content-disposition'], 'attachment; filename="purchase-history-2026-05-01-to-2026-12-31.csv"');
  assert.deepEqual([...c.rawPayload.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const lines = c.rawPayload.subarray(3).toString('utf8').trim().split('\r\n');
  assert.equal(lines[0], 'Vendor,Invoice date,Invoice #,Product,Pack size,Qty bought,Unit,Unit price,Price per,Extended,Needs check,Reason,Source,Item #,UPC');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'Kaito Trading,2026-06-01,HC-2002,2 Year Old Cheddar,,5,LB,6,LB,30,No,,Old invoice 2,K1,');
  assert.equal(lines[2], 'Kaito Trading,2026-06-01,HC-2002,Wasabi Paste,12 units/case,2,CS,36,CS,72,Yes,The reader was not fully sure: smudge.,Old invoice 2,W2,');

  for (const q of ['from=2026-02-30', 'to=yesterday', 'from=2026-07-01&to=2026-01-01']) {
    const bad = await get(s, `/history/download.csv?${q}`, mgr.cookie);
    assert.equal(bad.statusCode, 400, q);
    assert.match(bad.body, /class="error"/);
  }
  // Nothing in range: just the header.
  const none = await s.app.inject({ method: 'GET', url: '/history/download.csv?to=2026-01-01', headers: { cookie: mgr.cookie } });
  assert.equal(none.rawPayload.subarray(3).toString('utf8').trim().split('\r\n').length, 1);
});
