import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { makeRunApp, multipart, signIn, upload, uploadPhoto, type RunApp } from './runs-fixtures.ts';
import { testImage } from './invoice-fixtures.ts';
import { ORIGIN } from './server-helpers.ts';

function storedFiles(s: RunApp): string[] {
  return existsSync(s.config.uploads.dir) ? readdirSync(s.config.uploads.dir) : [];
}

function runCount(s: RunApp): number {
  return (s.app.shelf.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;
}

test('managers and admins can upload; anonymous uploads are refused before the body is read', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  let read = 0;
  const body = new Readable({
    read() {
      read++;
      this.push(null);
    },
  });
  const anon = await s.app.inject({ method: 'POST', url: '/runs', headers: { origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '100' }, payload: body });
  assert.equal(anon.statusCode, 401);
  assert.equal(read, 0, 'the body was not read');
  for (const role of ['manager', 'admin'] as const) {
    const who = await signIn(s, role);
    const res = await uploadPhoto(s, who);
    assert.equal(res.statusCode, 303, `${role}: ${res.body.slice(0, 300)}`);
  }
  assert.equal(runCount(s), 2);
});

test('the upload page offers the camera and PDF, with the token first in the form', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  const page = await s.app.inject({ method: 'GET', url: '/runs/new', headers: { cookie: mgr.cookie } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /enctype="multipart\/form-data" class="stack"[^>]*>\s*<input type="hidden" name="_csrf"/);
  assert.match(page.body, /<input id="photos"[^>]*accept="image\/\*,application\/pdf" capture="environment" multiple/, 'the big camera button');
  assert.match(page.body, /<label class="button button-accent button-xl pick" for="photos">Take photos/);
  assert.match(page.body, /<input id="files"[^>]*accept="image\/\*,application\/pdf" multiple/, 'a PDF or saved photos');
  assert.match(page.body, /Up to \d+ photos, or one PDF of up to \d+ pages/);
  // The one script is a static file, there to help. No inline script, no inline style.
  const scripts = [...page.body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /^<script src="\/static\/js\/upload\.js\?v=[0-9a-f]{10}" defer>$/);
  assert.doesNotMatch(page.body, /\sstyle=|<script>/);
});

test('the CSRF token must be the first part; otherwise nothing is saved', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  const photo = await testImage(1);
  const cases = [
    [{ name: 'files', filename: 'a.jpg', type: 'image/jpeg', data: photo }, { name: '_csrf', value: mgr.csrf }],
    [{ name: '_csrf', value: 'wrong' }, { name: 'files', filename: 'a.jpg', type: 'image/jpeg', data: photo }],
    [{ name: 'files', filename: 'a.jpg', type: 'image/jpeg', data: photo }],
  ];
  for (const parts of cases) {
    const res = await upload(s, mgr.cookie, parts);
    assert.equal(res.statusCode, 403);
  }
  // Another origin is refused before anything else.
  const other = await upload(s, mgr.cookie, [{ name: '_csrf', value: mgr.csrf }, { name: 'files', filename: 'a.jpg', type: 'image/jpeg', data: photo }], { origin: 'https://evil.example' });
  assert.equal(other.statusCode, 403);
  assert.equal(runCount(s), 0);
  assert.deepEqual(storedFiles(s), []);
});

test('an upload over the total limit is refused from its Content-Length, before the body is read', async (t) => {
  const s = await makeRunApp({ config: { uploads: { maxTotalBytes: 50_000 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  let read = 0;
  const body = new Readable({
    read() {
      read++;
      this.push(null);
    },
  });
  const res = await s.app.inject({
    method: 'POST',
    url: '/runs',
    headers: { cookie: mgr.cookie, origin: ORIGIN, 'content-type': 'multipart/form-data; boundary=x', 'content-length': '60000' },
    payload: body,
  });
  assert.equal(res.statusCode, 413);
  assert.equal(read, 0, 'the body was not read');
  assert.equal(runCount(s), 0);
});

test('too many files, a file too large, a file of the wrong kind, or a PDF with photos are refused and nothing is kept', async (t) => {
  const s = await makeRunApp({ deps: { invoiceSettings: { upload: { maxFiles: 2, maxFileBytes: 30_000, maxPdfPages: 2 } } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  const small = await testImage(1, 120, 160);
  const big = Buffer.concat([await testImage(2), Buffer.alloc(40_000, 1)]);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF\n');
  const tok = { name: '_csrf', value: mgr.csrf };
  const file = (name: string, data: Buffer, type = 'image/jpeg') => ({ name: 'files', filename: name, type, data });
  const cases: Array<[number, Parameters<typeof upload>[2], RegExp]> = [
    [413, [tok, file('a.jpg', small), file('b.jpg', small), file('c.jpg', small)], /At most 2 files/],
    [413, [tok, file('big.jpg', big)], /larger than/],
    [415, [tok, file('notes.jpg', Buffer.from('just some text, not a picture at all'))], /is not a JPEG/],
    [400, [tok, file('a.jpg', small), file('b.pdf', pdf, 'application/pdf')], /not both/],
    [413, [tok, file('long.pdf', pdf, 'application/pdf')], /more than 2 pages/],
    [400, [tok], /at least one/],
  ];
  for (const [status, parts, msg] of cases) {
    const res = await upload(s, mgr.cookie, parts);
    assert.equal(res.statusCode, status, String(msg));
    assert.match(res.body, msg);
    assert.deepEqual(storedFiles(s), [], `nothing kept after ${msg}`);
  }
  assert.equal(runCount(s), 0);
  // A file box left empty is skipped, not refused.
  const ok = await upload(s, mgr.cookie, [tok, file('', Buffer.alloc(0), 'application/octet-stream'), file('a.jpg', small)]);
  assert.equal(ok.statusCode, 303);
  assert.equal(storedFiles(s).length, 1);
});

test('uploads are rate limited per person', async (t) => {
  const s = await makeRunApp({ config: { uploads: { perUserPerHour: 2 } } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  assert.equal((await uploadPhoto(s, mgr, 1)).statusCode, 303);
  assert.equal((await uploadPhoto(s, mgr, 2)).statusCode, 303);
  const third = await uploadPhoto(s, mgr, 3);
  assert.equal(third.statusCode, 429);
  // Another person is not affected.
  const admin = await signIn(s, 'admin');
  assert.equal((await uploadPhoto(s, admin, 4)).statusCode, 303);
  s.advance(3601_000);
  assert.equal((await uploadPhoto(s, mgr, 5)).statusCode, 303);
});

test('multipart is refused on every other route, and the upload refuses form posts', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const admin = await signIn(s, 'admin');
  const { payload, contentType } = multipart([{ name: '_csrf', value: admin.csrf }, { name: 'username', value: 'x' }]);
  for (const url of ['/users', '/settings', '/runs/1/dry-run', '/account/password']) {
    const res = await s.app.inject({ method: 'POST', url, headers: { cookie: admin.cookie, origin: ORIGIN, 'content-type': contentType }, payload });
    assert.equal(res.statusCode, 415, url);
  }
  const form = await s.app.inject({ method: 'POST', url: '/runs', headers: { cookie: admin.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: `_csrf=${admin.csrf}` });
  assert.equal(form.statusCode, 415);
});

test('uploaded files are served only to signed-in users, by id, never as HTML', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  const anon = await s.app.inject({ method: 'GET', url: '/runs/1/files/1' });
  assert.equal(anon.statusCode, 303);
  assert.equal(anon.headers.location, '/login');
  const res = await s.app.inject({ method: 'GET', url: '/runs/1/files/1', headers: { cookie: mgr.cookie } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.match(String(res.headers['content-security-policy']), /sandbox/);
  assert.match(String(res.headers['content-disposition']), /^inline; filename="invoice-1-1\.jpg"$/);
  assert.equal((await s.app.inject({ method: 'GET', url: '/runs/1/files/2', headers: { cookie: mgr.cookie } })).statusCode, 404);
  assert.equal((await s.app.inject({ method: 'GET', url: '/runs/2/files/1', headers: { cookie: mgr.cookie } })).statusCode, 404);
  assert.equal((await s.app.inject({ method: 'GET', url: '/runs/1/files/..%2f..%2fetc', headers: { cookie: mgr.cookie } })).statusCode, 404);
});
