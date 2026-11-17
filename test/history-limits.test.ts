// The review fixes for old invoices: the file route's headers, the shared byte budget both ways,
// the share of the daily limit, the reading that must fit under the limit, the separate hourly
// limit, the shared upload slots, the download cap and the startup booking. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelInvoice } from '../src/invoice/types.ts';
import { createPurchaseInvoice } from '../src/history/store.ts';
import { spendWait } from '../src/history/worker.ts';
import { bookCutShort } from '../src/runs/spend.ts';
import { ensureUploadDir, newStoredName, openNewFile } from '../src/runs/files.ts';
import { createUploadSlots } from '../src/server/upload-slots.ts';
import { fakeClient, image, invoice, line, testImage } from './invoice-fixtures.ts';
import { makeRunApp, multipart, signIn, uploadPhoto, type Part } from './runs-fixtures.ts';
import { get, ORIGIN, type TestApp } from './server-helpers.ts';

function oldInvoice(fields: Partial<ModelInvoice> = {}): ModelInvoice {
  return invoice({
    supplier_name: 'Hollow Creek Dairy',
    invoice_number: 'HC-1001',
    invoice_date_iso: '2026-03-14',
    invoice_date: '03/14/26',
    images: [image({ invoice_number: 'HC-1001' })],
    lines: [line({ description: '2 Year Old Cheddar', qty_shipped: '5', unit: 'LB', unit_price: '6.00', price_unit: 'LB', extension: '30.00' })],
    total: '30.00',
    ...fields,
  });
}

const model = (n = 5) => fakeClient({ 'claude-sonnet-5-5': Array.from({ length: n }, () => ({ json: oldInvoice() })), 'claude-opus-5-5': [] });

async function uploadOld(t: TestApp, who: { cookie: string; csrf: string }, seed = 1) {
  const parts: Part[] = [
    { name: '_csrf', value: who.csrf },
    { name: 'files', filename: `old${seed}.jpg`, type: 'image/jpeg', data: await testImage(seed) },
  ];
  const { payload, contentType } = multipart(parts);
  return t.app.inject({ method: 'POST', url: '/history', headers: { cookie: who.cookie, origin: ORIGIN, 'content-type': contentType }, payload });
}

function userId(t: TestApp, name: string): number {
  return (t.app.shelf.db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number }).id;
}

const recent = Date.parse('2026-11-06T17:30:00Z');

test('the file route: a sandbox CSP, inline only for JPEG, PNG and WebP, the right type, and only its own invoice', async (t) => {
  const s = await makeRunApp({ model: model(), cards: false });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const dir = join(dirname(s.config.dbPath), 'history-uploads');
  ensureUploadDir(dir);
  const kinds = ['jpeg', 'png', 'webp', 'heif', 'pdf'] as const;
  const stored = (text: string): string => {
    const storedName = newStoredName();
    const fd = openNewFile(dir, storedName);
    writeSync(fd, Buffer.from(text));
    closeSync(fd);
    return storedName;
  };
  const files = kinds.map((kind, i) => ({ storedName: stored(`invented ${kind} bytes`), originalName: `page ${i + 1}`, kind, bytes: 20, sha256: String(i).repeat(64) }));
  const id = createPurchaseInvoice(s.app.shelf.db, { userId: userId(s, 'mgr'), username: 'mgr' }, files, Date.now());
  const other = createPurchaseInvoice(s.app.shelf.db, { userId: userId(s, 'mgr'), username: 'mgr' }, [{ ...files[0]!, storedName: stored('another invoice'), sha256: 'f'.repeat(64) }], Date.now());
  const expect = {
    jpeg: ['image/jpeg', 'inline', 'jpg'],
    png: ['image/png', 'inline', 'png'],
    webp: ['image/webp', 'inline', 'webp'],
    heif: ['image/heif', 'attachment', 'heif'],
    pdf: ['application/pdf', 'attachment', 'pdf'],
  } as const;
  for (const [i, kind] of kinds.entries()) {
    const res = await get(s, `/history/${id}/files/${i + 1}`, mgr.cookie);
    assert.equal(res.statusCode, 200, kind);
    assert.equal(res.headers['content-type'], expect[kind][0], kind);
    assert.equal(res.headers['content-disposition'], `${expect[kind][1]}; filename="old-invoice-${id}-${i + 1}.${expect[kind][2]}"`, kind);
    assert.equal(res.headers['content-security-policy'], "default-src 'none'; sandbox", kind);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', kind);
  }
  // A file of another invoice, asked for under this one, is not found. So is a bad id.
  assert.equal((await get(s, `/history/${id}/files/6`, mgr.cookie)).statusCode, 404);
  assert.equal((await get(s, `/history/${other}/files/1`, mgr.cookie)).statusCode, 404);
  assert.equal((await get(s, `/history/${other}/files/6`, mgr.cookie)).statusCode, 200);
  assert.equal((await get(s, `/history/${id}/files/0`, mgr.cookie)).statusCode, 404);
  assert.equal((await get(s, `/history/${id}/files/..%2f1`, mgr.cookie)).statusCode, 404);
});

test('the daily byte budget is shared both ways: old invoice then run, and run then old invoice', async (t) => {
  // Room for one upload of this photo, and not a byte more for a second.
  const one = multipart([{ name: '_csrf', value: 'x'.repeat(43) }, { name: 'files', filename: 'old1.jpg', type: 'image/jpeg', data: await testImage(1) }]).payload.length;
  const s = await makeRunApp({ model: model(), cards: false, config: { uploads: { maxBytesPerUserPerDay: one + 100 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  assert.equal((await uploadOld(s, mgr, 1)).statusCode, 303);
  const run = await uploadPhoto(s, mgr, 1);
  assert.equal(run.statusCode, 429, 'the old invoice used the share');
  assert.match(run.body, /daily share/);
  const admin = await signIn(s, 'admin');
  assert.equal((await uploadPhoto(s, admin, 1)).statusCode, 303);
  const old = await uploadOld(s, admin, 1);
  assert.equal(old.statusCode, 429, 'the run used the share');
  assert.match(old.body, /daily share/);
});

test('old invoices have their own hourly upload limit; runs keep theirs', async (t) => {
  const s = await makeRunApp({ model: model(), cards: false, config: { uploads: { perUserPerHour: 1, historyPerUserPerHour: 2 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  assert.equal((await uploadPhoto(s, mgr, 1)).statusCode, 303);
  assert.equal((await uploadPhoto(s, mgr, 2)).statusCode, 429);
  assert.equal((await uploadOld(s, mgr, 3)).statusCode, 303, 'the run limit does not stop old invoices');
  assert.equal((await uploadOld(s, mgr, 4)).statusCode, 303);
  const third = await uploadOld(s, mgr, 5);
  assert.equal(third.statusCode, 429);
  assert.match(third.body, /a lot of uploads in the last hour/);
  assert.equal(s.config.uploads.historyPerUserPerHour, 2);
  const plain = await makeRunApp({ cards: false });
  t.after(() => plain.close());
  assert.equal(plain.config.uploads.historyPerUserPerHour, 60, 'the default');
});

test('one set of upload slots for both upload routes', async (t) => {
  const s = await makeRunApp({ model: model(), cards: false });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const release = s.app.shelf.uploadSlots.take(userId(s, 'mgr'), s.config.uploads);
  assert.ok(release);
  for (const res of [await uploadPhoto(s, mgr, 1), await uploadOld(s, mgr, 2)]) {
    assert.equal(res.statusCode, 429);
    assert.match(res.body, /Another upload is still in progress/);
  }
  release!();
  assert.equal(s.app.shelf.uploadSlots.held(), 0);
  assert.equal((await uploadOld(s, mgr, 3)).statusCode, 303);
  assert.equal((await uploadPhoto(s, mgr, 4)).statusCode, 303);
  assert.equal(s.app.shelf.uploadSlots.held(), 0, 'each upload gave its slot back');
  // The slots themselves.
  const slots = createUploadSlots();
  const a = slots.take(1, { maxInFlightPerUser: 1, maxInFlight: 2 });
  assert.equal(slots.take(1, { maxInFlightPerUser: 1, maxInFlight: 2 }), null);
  const b = slots.take(2, { maxInFlightPerUser: 1, maxInFlight: 2 });
  assert.equal(slots.take(3, { maxInFlightPerUser: 1, maxInFlight: 2 }), null);
  a!();
  a!();
  assert.equal(slots.held(), 1, 'release twice gives back one slot');
  b!();
  assert.equal(slots.held(), 0);
});

test('the spend split: old invoices use at most their share, and neither reader starts past the limit', () => {
  const base = { spentUsd: 0, historySpentUsd: 0, limitUsd: 10, sharePercent: 50, capUsd: 1 };
  assert.equal(spendWait(base), null);
  assert.equal(spendWait({ ...base, spentUsd: 4, historySpentUsd: 4 }), null, '$4 + $1 fits the $5 share');
  assert.match(spendWait({ ...base, spentUsd: 4.01, historySpentUsd: 4.01 })!, /their share of the daily limit, \$5\.00/);
  assert.equal(spendWait({ ...base, spentUsd: 9, historySpentUsd: 0 }), null, '$9 + $1 fits the $10 limit');
  assert.match(spendWait({ ...base, spentUsd: 9.5 })!, /could pass the daily limit of \$10\.00/);
  assert.equal(spendWait({ ...base, sharePercent: 100, spentUsd: 9, historySpentUsd: 9 }), null);
});

test('in the app: a backlog of old invoices waits at its share while a run still reads', async (t) => {
  const s = await makeRunApp({ cards: false, settings: { dailyLimitUsd: '4.00' } });
  t.after(() => s.close());
  assert.equal(s.app.shelf.settings.getSetting('historySharePercent'), '50');
  const mgr = await signIn(s);
  s.app.shelf.db.prepare("INSERT INTO model_spend (run_id, source, kind, state, usd, estimate, at, updated_at) VALUES (NULL, 'history', 'read', 'booked', 1.5, 0, ?, ?)").run(recent, recent);
  await uploadOld(s, mgr, 1);
  await s.app.shelf.history.drain();
  const waiting = s.app.shelf.db.prepare('SELECT state, message FROM purchase_invoices WHERE id = 1').get() as { state: string; message: string };
  assert.equal(waiting.state, 'uploaded');
  assert.match(waiting.message, /Old invoices in the last 24 hours have cost \$1\.50\. .*their share of the daily limit, \$2\.00/);
  const calls = s.model.calls.length;
  await uploadPhoto(s, mgr, 2);
  await s.app.shelf.runner.drain();
  assert.notEqual((s.app.shelf.db.prepare('SELECT state FROM runs WHERE id = 1').get() as { state: string }).state, 'needs_approval', 'the run was read');
  assert.equal(s.model.calls.length, calls + 1);
});

test('a run reading starts only if its worst case fits under the daily limit', async (t) => {
  const s = await makeRunApp({ cards: false, settings: { dailyLimitUsd: '4.00' } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  s.app.shelf.db.prepare("INSERT INTO model_spend (run_id, kind, state, usd, estimate, at, updated_at) VALUES (NULL, 'copy', 'booked', 3.5, 0, ?, ?)").run(recent, recent);
  await uploadPhoto(s, mgr, 1);
  await s.app.shelf.runner.drain();
  const run = s.app.shelf.db.prepare('SELECT state, message FROM runs WHERE id = 1').get() as { state: string; message: string };
  assert.equal(run.state, 'needs_approval');
  assert.match(run.message, /cost \$3\.50\. Reading this invoice, up to \$1\.00, could pass the daily limit of \$4\.00\./);
  assert.equal(s.model.calls.length, 0);
});

test('the share setting is checked: a whole percent from 10 to 100', async (t) => {
  const { checkSetting } = await import('../src/settings/schema.ts');
  const opts = { allowSquareProduction: false };
  assert.equal(checkSetting('historySharePercent', ' 050 ', opts), '50');
  assert.equal(checkSetting('historySharePercent', '10', opts), '10');
  assert.equal(checkSetting('historySharePercent', '100', opts), '100');
  for (const bad of ['9', '101', '50.5', 'half', '']) assert.throws(() => checkSetting('historySharePercent', bad, opts), /from 10 to 100/, bad);
  const s = await makeRunApp({ cards: false });
  t.after(() => s.close());
  const admin = await signIn(s, 'admin');
  assert.match((await get(s, '/settings', admin.cookie)).body, /<input id="historySharePercent" name="historySharePercent" value="50"/);
});

test('a download over 20,000 lines is refused; a shorter range works', async (t) => {
  const s = await makeRunApp({ model: model(), cards: false });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const db = s.app.shelf.db;
  db.prepare("INSERT INTO purchase_invoices (id, state, created_by_name, created_at, updated_at, vendor, invoice_date_iso) VALUES (1, 'done', 'test', 0, 0, 'Hollow Creek Dairy', '2026-03-14')").run();
  db.exec('BEGIN');
  const ins = db.prepare("INSERT INTO purchase_lines (invoice_id, n, product, qty, extension_cents) VALUES (1, ?, 'Invented', '1', 100)");
  for (let n = 1; n <= 20_001; n++) ins.run(n);
  db.exec('COMMIT');
  const big = await get(s, '/history/download.xlsx', mgr.cookie);
  assert.equal(big.statusCode, 400);
  assert.match(big.body, /That is more than 20,000 lines\. Pick a shorter date range\./);
  db.prepare('DELETE FROM purchase_lines WHERE n > 20000').run();
  assert.equal((await get(s, '/history/download.csv', mgr.cookie)).statusCode, 200, 'exactly 20,000 is fine');
});

test('at start, the run code books only its own cut-short calls, never an old invoice reading', async (t) => {
  const s = await makeRunApp({ cards: false });
  t.after(() => s.close());
  const db = s.app.shelf.db;
  db.prepare("INSERT INTO model_spend (run_id, source, kind, state, usd, estimate, at, updated_at) VALUES (NULL, 'history', 'read', 'reserved', 1, 1, ?, ?)").run(recent, recent);
  const res = bookCutShort(db, recent);
  assert.equal(res.count, 0);
  assert.equal((db.prepare("SELECT state FROM model_spend").get() as { state: string }).state, 'reserved');
  assert.equal((db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'run.spend_cut_short'").get() as { n: number }).n, 0);
});
