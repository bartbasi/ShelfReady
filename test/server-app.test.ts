import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { ADMIN_PW, ORIGIN, addUser, get, logText, login, makeApp, tempDir } from './server-helpers.ts';
import { makeConfig, REPO_ROOT } from '../src/server/config.ts';
import { escapeHtml, html } from '../src/server/views/html.ts';

test('security headers are on pages, errors and static files', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  for (const url of ['/login', '/about', '/nope', '/static/app.css']) {
    const res = await get(s, url);
    const csp = String(res.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/, url);
    assert.match(csp, /script-src 'self'/, url);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, url);
    assert.match(csp, /frame-ancestors 'none'/, url);
    assert.equal(res.headers['x-frame-options'], 'DENY', url);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(res.headers['referrer-policy'], 'same-origin', url);
    assert.equal(res.headers['strict-transport-security'], undefined, 'no HSTS while TLS is off');
  }
  assert.equal((await get(s, '/login')).headers['cache-control'], 'no-store');
});

test('pages have no inline script or style', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW)).cookie;
  for (const url of ['/login', '/about', '/', '/settings', '/users', '/account']) {
    const body = (await get(s, url, url === '/login' ? '' : cookie)).body;
    assert.doesNotMatch(body, /<script|<style|\sstyle=|\son[a-z]+=/i, url);
  }
});

test('the About page shows the copyright, developers and license', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const res = await get(s, '/about');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Designed and written by Bart Basi, with assistance from Claude\. Copyright 2026 Cheese &amp; Crackers, Inc\./);
  assert.match(res.body, /GNU General Public License, version 3/);
});

test('only form posts are accepted, and bodies have a size limit', async (t) => {
  const s = await makeApp({ bodyLimit: 2048 });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW)).cookie;
  const json = await s.app.inject({ method: 'POST', url: '/users', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(json.statusCode, 415);
  const big = await s.app.inject({
    method: 'POST',
    url: '/users',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `username=${'a'.repeat(5000)}`,
  });
  assert.equal(big.statusCode, 413);
});

test('unknown pages get a plain 404', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const res = await get(s, '/admin/secret');
  assert.equal(res.statusCode, 404);
  assert.match(res.body, /There is no page here/);
});

test('without TLS the server will only bind to loopback', () => {
  assert.throws(() => makeConfig({ host: '0.0.0.0' }), /127\.0\.0\.1 only/);
  assert.throws(() => makeConfig({ host: '10.0.0.20' }), /127\.0\.0\.1 only/);
  assert.equal(makeConfig({}).host, '127.0.0.1');
  assert.deepEqual(makeConfig({ port: 4000 }).publicOrigins, ['http://127.0.0.1:4000', 'http://localhost:4000']);
  assert.throws(() => makeConfig({ publicOrigins: ['https://x.example/path'] }), /bare origins/);
});

test('the server refuses a master key inside the repo or the data folder', async () => {
  const dir = tempDir();
  try {
    const { buildApp } = await import('../src/server/app.ts');
    await assert.rejects(
      buildApp(makeConfig({ dbPath: join(dir, 'data', 'x.sqlite3'), masterKeyPath: join(dir, 'data', 'master.key'), scrypt: { N: 1024, r: 8, p: 1 } })),
      /must be outside/,
    );
    await assert.rejects(
      buildApp(makeConfig({ dbPath: join(dir, 'data', 'y.sqlite3'), masterKeyPath: join(REPO_ROOT, 'config', 'local', 'never.key'), scrypt: { N: 1024, r: 8, p: 1 } })),
      /must be outside/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('templates escape values by default', () => {
  assert.equal(escapeHtml(`<a href="x">'&\``), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#96;');
  const evil = '<script>alert(1)</script>';
  assert.equal(html`<p>${evil}</p>`.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.equal(html`<ul>${['<b>', html`<i>ok</i>`]}</ul>`.value, '<ul>&lt;b&gt;<i>ok</i></ul>');
  assert.equal(html`${null}${undefined}${false}${0}`.value, '0');
});

test('create-user refuses a password on the command line and a piped stdin', () => {
  const dir = tempDir();
  try {
    const cfg = join(dir, 'server.json');
    writeFileSync(cfg, JSON.stringify({ dbPath: join(dir, 'cli.sqlite3'), masterKeyPath: join(dir, 'master.key') }));
    const script = join(REPO_ROOT, 'scripts', 'admin', 'create-user.ts');
    const env = { ...process.env, SHELFREADY_CONFIG: cfg };
    const withArg = spawnSync(process.execPath, [script, '--username', 'x', '--password', 'hunter2hunter2'], { env, input: '', encoding: 'utf8' });
    assert.equal(withArg.status, 1);
    assert.match(withArg.stderr, /never passed as arguments/);
    assert.doesNotMatch(withArg.stderr + withArg.stdout, /hunter2/);
    const piped = spawnSync(process.execPath, [script, '--username', 'x'], { env, input: 'some password\n', encoding: 'utf8' });
    assert.equal(piped.status, 1);
    assert.match(piped.stderr, /Run this in a terminal/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trace and debug logging are refused outside tests', () => {
  assert.throws(() => makeConfig({ logLevel: 'trace' }), /logLevel/);
  assert.throws(() => makeConfig({ logLevel: 'debug' }), /logLevel/);
  assert.equal(makeConfig({ logLevel: 'trace' }, { allowVerboseLogs: true }).logLevel, 'trace');
  assert.equal(makeConfig({ logLevel: 'warn' }).logLevel, 'warn');
});

test('default origins cover IPv6 loopback', () => {
  assert.deepEqual(makeConfig({ host: '::1', port: 4000 }).publicOrigins, ['http://[::1]:4000', 'http://localhost:4000']);
  assert.deepEqual(makeConfig({ host: 'localhost', port: 4000 }).publicOrigins, ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']);
});

test('anonymous posts are refused before the body is read', async (t) => {
  const s = await makeApp({ bodyLimit: 2048 });
  t.after(() => s.close());
  // Over the body limit: if the body were parsed first this would be 413.
  const res = await s.app.inject({
    method: 'POST',
    url: '/settings',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `x=${'a'.repeat(5000)}`,
  });
  assert.equal(res.statusCode, 401);
});

test('a malformed request gets 400 and its raw bytes never reach the log', async (t) => {
  const s = await makeApp({ port: 0 });
  t.after(() => s.close());
  await s.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (s.app.server.address() as { port: number }).port;
  const secretCookie = `sr_session=RAWPACKETSECRET${'z'.repeat(30)}`;
  const reply = await new Promise<string>((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(`GET / HTTP/1.1\r\nHost: x\r\nCookie: ${secretCookie}\r\nBad Header Line\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => (data += d.toString()));
    sock.on('end', () => resolve(data));
    sock.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1.1 400/);
  assert.ok(s.logs.some((l) => l.includes('client error')));
  assert.ok(!logText(s.logs).includes('RAWPACKETSECRET'));
});

test('the server will not make a new key when encrypted settings exist without one', async () => {
  const dir = tempDir();
  try {
    const { buildApp } = await import('../src/server/app.ts');
    const cfg = makeConfig({ dbPath: join(dir, 'data', 'k.sqlite3'), masterKeyPath: join(dir, 'keys', 'master.key'), scrypt: { N: 1024, r: 8, p: 1 } });
    const app = await buildApp(cfg);
    app.shelf.settings.update({ values: { invoiceCostCapUsd: '2.00' } }, { userId: null, username: 'test' });
    await app.close();
    unlinkSync(join(dir, 'keys', 'master.key'));
    await assert.rejects(buildApp(cfg), /Restore the key file from backup/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
