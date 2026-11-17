// Step 9 server tests: the TLS files, Host refusal, HSTS, Secure cookies, listening on several
// addresses, certificate reload and the slow-client timeouts. Real sockets listen on loopback only
// (127.0.0.1 and 127.0.0.2), never on a store address.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { ADMIN_PW, MANAGER_PW, addUser, csrfFrom, form, makeApp, tempDir, type TestApp } from './server-helpers.ts';
import { freePort, issuedChain, opensslMissing, privateDir, selfSigned } from './net-helpers.ts';
import { installPair } from '../scripts/net/cert-lib.ts';
import { loadTlsMaterial, TlsFileError } from '../src/server/tls.ts';
import { listenAll } from '../src/server/listen.ts';
import { REPO_ROOT, type ConfigInput } from '../src/server/config.ts';

const NAME = 'shelfready.example.com';
const skip = opensslMissing();

// Every temp folder made here (test keys, a fake token) is removed when the file's tests end.
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = tempDir();
  made.push(d);
  return d;
}

function tlsApp(dir: string, extra: ConfigInput = {}): ConfigInput {
  const { cert, key } = selfSigned(join(dir, 'tls'), [NAME]);
  return { tls: { enabled: true, certPath: cert, keyPath: key }, allowedHosts: [NAME], ...extra };
}

async function tlsTestApp(extra: ConfigInput = {}, deps: Parameters<typeof makeApp>[1] = {}): Promise<TestApp> {
  const dir = scratch();
  return makeApp(tlsApp(dir, extra), deps);
}

const cookieNamed = (res: { cookies: { name: string; value: string }[] }, name: string): string | undefined => res.cookies.find((c) => c.name === name)?.value;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Adds an admin and signs in from the real name's origin. Returns the session cookie header. */
async function signInAdmin(s: TestApp, port: number): Promise<string> {
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const page = await s.app.inject({ method: 'GET', url: '/login', headers: { host: NAME } });
  const res = await s.app.inject({
    method: 'POST',
    url: '/login',
    headers: { host: NAME, origin: `https://${NAME}:${port}`, cookie: `__Host-sr_login=${cookieNamed(page, '__Host-sr_login')}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ _csrf: csrfFrom(page.body), username: 'bart', password: ADMIN_PW }),
  });
  return `__Host-sr_session=${cookieNamed(res, '__Host-sr_session')}`;
}

/** Waits until the app listens on address, or fails after about two seconds. */
async function listeningOn(s: TestApp, address: string): Promise<void> {
  for (let i = 0; i < 100 && !s.app.shelf.listeners.listening().includes(address); i++) await sleep(20);
  assert.ok(s.app.shelf.listeners.listening().includes(address), `listening on ${address}`);
}

/** Connects with TLS and resolves once the handshake is done, or rejects. */
function handshake(port: number, opts: Partial<ConnectionOptions> = {}, host = '127.0.0.1'): Promise<ReturnType<typeof tlsConnect>> {
  return new Promise((resolve, reject) => {
    const s = tlsConnect({ host, port, servername: NAME, rejectUnauthorized: false, ...opts }, () => resolve(s));
    s.once('error', reject);
  });
}

/** One HTTP/1.1 request over TLS. Returns the status line and the time taken, or 'closed' if the server hung up first. */
function rawRequest(port: number, head: string, bodyDrip: string, dripMs: number, host = '127.0.0.1'): Promise<{ status: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let got = '';
    let timer: NodeJS.Timeout | undefined;
    const s = tlsConnect({ host, port, servername: NAME, rejectUnauthorized: false }, () => {
      s.write(head);
      let i = 0;
      const drip = (): void => {
        if (s.destroyed || i >= bodyDrip.length) return;
        s.write(bodyDrip[i++]);
        timer = setTimeout(drip, dripMs);
      };
      timer = setTimeout(drip, dripMs);
    });
    s.on('data', (d) => (got += d.toString('latin1')));
    s.on('error', () => {});
    s.on('close', () => {
      clearTimeout(timer);
      resolve({ status: got.split('\r\n')[0] || 'closed', ms: Date.now() - t0 });
    });
  });
}

test('the TLS key must be private, outside the repo, and match a certificate that covers our name', { skip }, () => {
  const dir = scratch();
  const { cert, key } = selfSigned(join(dir, 'tls'), [NAME]);
  const paths = { certPath: cert, keyPath: key };
  const m = loadTlsMaterial(paths, [NAME], [REPO_ROOT]);
  assert.equal(m.chain.length, 1);
  assert.throws(() => loadTlsMaterial(paths, ['other.example.com'], [REPO_ROOT]), /does not cover other\.example\.com/);
  chmodSync(key, 0o640);
  assert.throws(() => loadTlsMaterial(paths, [NAME], [REPO_ROOT]), (e) => e instanceof TlsFileError && /can be read by other users/.test(e.message));
  chmodSync(key, 0o600);
  chmodSync(join(dir, 'tls'), 0o755);
  assert.throws(() => loadTlsMaterial(paths, [NAME], [REPO_ROOT]), /Other users can open the folder/);
  chmodSync(join(dir, 'tls'), 0o700);
  chmodSync(cert, 0o666);
  assert.throws(() => loadTlsMaterial(paths, [NAME], [REPO_ROOT]), /can change the certificate/);
  chmodSync(cert, 0o600);
  // A key that is a link, a key for another certificate, a damaged certificate, a key in a forbidden folder.
  symlinkSync(key, join(dir, 'tls', 'link.pem'));
  assert.throws(() => loadTlsMaterial({ certPath: cert, keyPath: join(dir, 'tls', 'link.pem') }, [NAME], [REPO_ROOT]), /symbolic link/);
  const other = selfSigned(join(dir, 'other'), [NAME]);
  assert.throws(() => loadTlsMaterial({ certPath: cert, keyPath: other.key }, [NAME], [REPO_ROOT]), /do not belong together/);
  writeFileSync(join(dir, 'tls', 'bad.pem'), 'not a certificate\n', { mode: 0o600 });
  assert.throws(() => loadTlsMaterial({ certPath: join(dir, 'tls', 'bad.pem'), keyPath: key }, [NAME], [REPO_ROOT]), /no certificate in PEM form/);
  assert.throws(() => loadTlsMaterial(paths, [NAME], [dir]), /must be outside/);
  assert.throws(() => loadTlsMaterial({ certPath: cert, keyPath: join(dir, 'missing', 'key.pem') }, [NAME], [REPO_ROOT]), /no folder/);
});

test('a request for any other name is refused before anything else runs, with TLS or without', { skip }, async (t) => {
  const s = await tlsTestApp({ bodyLimit: 2048, port: 8443 });
  t.after(() => s.close());
  const get = (host: string) => s.app.inject({ method: 'GET', url: '/login', headers: { host } });
  assert.equal((await get(`${NAME}:8443`)).statusCode, 200);
  assert.equal((await get(NAME)).statusCode, 200);
  for (const host of ['evil.example', 'evil.example:8443', `${NAME}.evil.example`, '10.0.0.20:8443', 'x y']) {
    const res = await get(host);
    assert.equal(res.statusCode, 421, host);
    assert.equal(res.headers['set-cookie'], undefined, `${host}: no cookie`);
    assert.match(res.body, /does not answer to that name/);
  }
  // Refused before the body is read: over the body limit it would otherwise be 413.
  const big = await s.app.inject({ method: 'POST', url: '/login', headers: { host: 'evil.example', origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: `x=${'a'.repeat(5000)}` });
  assert.equal(big.statusCode, 421);
  assert.ok(s.logs.some((l) => l.includes('refused a request for another host name')));
  // Without TLS the default test app still answers inject's own localhost.
  const plain = await makeApp();
  t.after(() => plain.close());
  assert.equal((await plain.app.inject({ method: 'GET', url: '/login' })).statusCode, 200);
  assert.equal((await plain.app.inject({ method: 'GET', url: '/login', headers: { host: 'evil.example' } })).statusCode, 421);
});

test('HSTS goes only to our names, and cookies are Secure with the __Host- prefix', { skip }, async (t) => {
  const s = await tlsTestApp({ port: 8443 });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const page = await s.app.inject({ method: 'GET', url: '/login', headers: { host: `${NAME}:8443` } });
  assert.equal(page.headers['strict-transport-security'], 'max-age=300');
  const setCookie = String(page.headers['set-cookie']);
  assert.match(setCookie, /^__Host-sr_login=[^;]+; Max-Age=3600; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  const local = await s.app.inject({ method: 'GET', url: '/login', headers: { host: 'localhost:8443' } });
  assert.equal(local.headers['strict-transport-security'], undefined, 'never for localhost');
  // Sign in from the real name's origin.
  const res = await s.app.inject({
    method: 'POST',
    url: '/login',
    headers: { host: `${NAME}:8443`, origin: `https://${NAME}:8443`, cookie: `__Host-sr_login=${cookieNamed(page, '__Host-sr_login')}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ _csrf: csrfFrom(page.body), username: 'bart', password: ADMIN_PW, remember: '1' }),
  });
  assert.equal(res.statusCode, 303);
  const session = (Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'] : [String(res.headers['set-cookie'])]).find((c) => c.startsWith('__Host-sr_session='));
  assert.ok(session, 'a __Host- session cookie');
  assert.match(session!, /; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  assert.doesNotMatch(session!, /Domain=/i);
  // The http origin of the same name is not ours any more.
  const wrongOrigin = await s.app.inject({ method: 'POST', url: '/login', headers: { host: NAME, origin: `http://${NAME}:8443`, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'x=1' });
  assert.equal(wrongOrigin.statusCode, 403);
});

test('the settings page shows the certificate to an admin only', { skip }, async (t) => {
  const s = await tlsTestApp({ port: 8443 });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const signIn = async (user: string, pw: string): Promise<string> => {
    const page = await s.app.inject({ method: 'GET', url: '/login', headers: { host: NAME } });
    const res = await s.app.inject({
      method: 'POST',
      url: '/login',
      headers: { host: NAME, origin: `https://${NAME}:8443`, cookie: `__Host-sr_login=${cookieNamed(page, '__Host-sr_login')}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ _csrf: csrfFrom(page.body), username: user, password: pw }),
    });
    return `__Host-sr_session=${cookieNamed(res, '__Host-sr_session')}`;
  };
  const admin = await s.app.inject({ method: 'GET', url: '/settings', headers: { host: NAME, cookie: await signIn('bart', ADMIN_PW) } });
  assert.equal(admin.statusCode, 200);
  assert.match(admin.body, /Certificate and network/);
  assert.match(admin.body, new RegExp(`<dt>Names</dt><dd>${NAME.replace(/\./g, '\\.')}</dd>`));
  assert.match(admin.body, /<dt>Next renewal<\/dt><dd>\d{4}-\d{2}-\d{2}<\/dd>/);
  assert.match(admin.body, /<dt>Address<\/dt><dd>https:\/\/shelfready\.example\.com:8443<\/dd>/);
  assert.match(admin.body, /The daily renewal check has not run/, 'no renewal record yet');
  assert.doesNotMatch(admin.body, /—|–|--/);
  const mgr = await s.app.inject({ method: 'GET', url: '/settings', headers: { host: NAME, cookie: await signIn('mgr', MANAGER_PW) } });
  assert.equal(mgr.statusCode, 403);
  assert.doesNotMatch(mgr.body, /Certificate and network/);
});

// 127.0.0.2 stands in for a second address so nothing listens on a real store address. It is a
// loopback address, so localhost refusal cannot be shown with it: the next test does that.
test('the server listens on each named address through one TLS server, and keeps trying one that is not up', { skip }, async (t) => {
  const s = await tlsTestApp({ port: 0 });
  t.after(() => s.close());
  // Test only: 127.0.0.2 stands in for a store address (the config refuses loopback addresses
  // there), and 192.0.2.1 is a documentation address that no PC holds.
  s.config.listenAddresses = ['127.0.0.2', '192.0.2.1'];
  await listenAll(s.app, { retryDelaysMs: [50] });
  const port = (s.app.server.address() as { port: number }).port;
  await listeningOn(s, '127.0.0.2');
  assert.deepEqual(s.app.shelf.listeners.listening(), ['127.0.0.2']);
  assert.equal(s.app.shelf.listeners.problems().get('192.0.2.1'), 'not-up');
  for (const host of ['127.0.0.1', '127.0.0.2']) {
    const r = await rawRequest(port, `GET /login HTTP/1.1\r\nHost: ${NAME}\r\nConnection: close\r\n\r\n`, '', 0, host);
    assert.equal(r.status, 'HTTP/1.1 200 OK', host);
    const evil = await rawRequest(port, `GET /login HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n`, '', 0, host);
    assert.equal(evil.status, 'HTTP/1.1 421 Misdirected Request', host);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(s.logs.some((l) => l.includes('cannot listen on this address yet') && l.includes('192.0.2.1')));
  // Closing the app stops every address and every retry.
  await s.app.close();
  await assert.rejects(handshake(port, {}, '127.0.0.2'));
});

test('localhost is refused on a connection that arrived on a store or tailnet address', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  // A real connection over loopback, handed to the server with its local address made to read as
  // a store address, the way a phone's connection to 10.0.0.20 would look.
  const ask = async (local: string | null, host: string): Promise<string> => {
    const relay: NetServer = createNetServer((sock: Socket) => {
      if (local) Object.defineProperty(sock, 'localAddress', { get: () => local });
      s.app.server.emit('connection', sock);
    });
    await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
    const port = (relay.address() as { port: number }).port;
    try {
      return await new Promise<string>((resolve) => {
        let got = '';
        const c = netConnect(port, '127.0.0.1', () => c.write(`GET /login HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
        c.on('data', (d) => (got += d.toString('latin1')));
        c.on('error', () => {});
        c.on('close', () => resolve(got.split('\r\n')[0]));
      });
    } finally {
      relay.close();
    }
  };
  for (const host of ['localhost', 'localhost:3000', '127.0.0.1:3000', '[::1]:3000']) {
    assert.equal(await ask('10.0.0.20', host), 'HTTP/1.1 421 Misdirected Request', `${host} on a store address`);
    assert.equal(await ask('100.64.0.20', host), 'HTTP/1.1 421 Misdirected Request', `${host} on a tailnet address`);
    assert.equal(await ask(null, host), 'HTTP/1.1 200 OK', `${host} on this PC's loopback`);
  }
});

test('only TLS 1.2 and 1.3 with forward-secret AEAD suites; a stalled handshake is dropped', { skip }, async (t) => {
  const s = await tlsTestApp({ port: 0, tlsHandshakeTimeoutSeconds: 1 });
  t.after(() => s.close());
  await listenAll(s.app);
  const port = (s.app.server.address() as { port: number }).port;
  const ok13 = await handshake(port);
  assert.equal(ok13.getProtocol(), 'TLSv1.3');
  ok13.destroy();
  const ok12 = await handshake(port, { maxVersion: 'TLSv1.2' });
  assert.match(ok12.getCipher().name, /^ECDHE-(ECDSA|RSA)-(AES\d+-GCM|CHACHA20)/);
  ok12.destroy();
  await assert.rejects(handshake(port, { maxVersion: 'TLSv1.1', minVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' }));
  await assert.rejects(handshake(port, { maxVersion: 'TLSv1.2', ciphers: 'ECDHE-ECDSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA' }));
  // Connect and send nothing: dropped after the handshake timeout.
  const t0 = Date.now();
  await new Promise<void>((resolve) => {
    const sock = netConnect(port, '127.0.0.1');
    sock.on('error', () => {});
    sock.on('close', () => resolve());
  });
  const took = Date.now() - t0;
  assert.ok(took >= 800 && took < 4000, `dropped after ${took} ms`);
});

test('a renewed certificate is loaded without a restart, and a bad pair is not', { skip }, async (t) => {
  const dir = scratch();
  const s = await makeApp(tlsApp(dir, { port: 0 }));
  t.after(() => s.close());
  await listenAll(s.app);
  const port = (s.app.server.address() as { port: number }).port;
  const served = async (): Promise<string> => {
    const sock = await handshake(port);
    const fp = sock.getPeerX509Certificate()!.fingerprint256;
    sock.destroy();
    return fp;
  };
  const first = await served();
  assert.equal(s.app.shelf.tlsReload(), 'unchanged');
  const renewed = selfSigned(join(dir, 'tls'), [NAME]);
  const want = new X509Certificate(readFileSync(renewed.cert)).fingerprint256;
  assert.equal(s.app.shelf.tlsReload(), 'reloaded');
  assert.equal(await served(), want);
  assert.notEqual(want, first);
  // A certificate whose key is not the one beside it: refused, the renewed one stays.
  const stray = selfSigned(join(dir, 'stray'), [NAME]);
  copyFileSync(stray.cert, renewed.cert);
  assert.equal(s.app.shelf.tlsReload(), 'failed');
  assert.equal(await served(), want);
  assert.equal(s.app.shelf.tlsReload(), 'unchanged', 'the same bad pair is not tried again');
  assert.ok(s.logs.some((l) => l.includes('the old one stays') && l.includes('do not belong together')));
  // The half pair recovers once the matching file lands.
  copyFileSync(stray.key, renewed.key);
  assert.equal(s.app.shelf.tlsReload(), 'reloaded');
  assert.equal(await served(), new X509Certificate(readFileSync(stray.cert)).fingerprint256);
  assert.ok(s.logs.some((l) => l.includes('certificate reloaded')));
});

test('closing waits for a request still running on a store address before the database closes', { skip }, async (t) => {
  let finished = false;
  const s = await tlsTestApp(
    { port: 0, shutdownGraceSeconds: 5 },
    {
      extraRoutes: (app) =>
        app.get('/slow-db', { config: { access: 'public' } }, async () => {
          await sleep(500);
          const row = app.shelf.db.prepare('SELECT 1 AS n').get();
          finished = true;
          return row;
        }),
    },
  );
  t.after(() => s.close());
  s.config.listenAddresses = ['127.0.0.2'];
  await listenAll(s.app, { retryDelaysMs: [50] });
  await listeningOn(s, '127.0.0.2');
  const port = (s.app.server.address() as { port: number }).port;
  // An idle kept-alive connection there too: it must not hold the close up.
  const idle = await handshake(port, {}, '127.0.0.2');
  await new Promise<void>((r) => {
    idle.once('data', () => r());
    idle.write(`GET /login HTTP/1.1\r\nHost: ${NAME}\r\n\r\n`);
  });
  const idleClosed = new Promise<void>((r) => idle.once('close', () => r()));
  const running = rawRequest(port, `GET /slow-db HTTP/1.1\r\nHost: ${NAME}\r\nConnection: close\r\n\r\n`, '', 0, '127.0.0.2');
  await sleep(150);
  const t0 = Date.now();
  await s.app.close();
  const took = Date.now() - t0;
  assert.equal((await running).status, 'HTTP/1.1 200 OK', 'the request finished with the database still open');
  assert.ok(finished);
  await idleClosed;
  assert.ok(took >= 250 && took < 3000, `close waited ${took} ms: for the request, not for the idle connection`);
  assert.equal(s.app.shelf.listeners.open(), 0);
});

test('every request is counted down once, so closing does not wait for requests that are done', async () => {
  const s = await makeApp({ shutdownGraceSeconds: 5 });
  // Answered pages, a refused name, a missing page and a refused post.
  for (const [url, host] of [['/login', 'localhost'], ['/login', 'evil.example'], ['/nope', 'localhost']]) {
    await s.app.inject({ method: 'GET', url, headers: { host } });
  }
  await s.app.inject({ method: 'POST', url: '/settings', headers: { host: 'localhost', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'x=1' });
  const t0 = Date.now();
  await s.close();
  assert.ok(Date.now() - t0 < 2000, `closed in ${Date.now() - t0} ms, not after the grace period`);
});

test('one device may hold only so many connections on a store address', { skip }, async (t) => {
  const s = await tlsTestApp({ port: 0, maxConnectionsPerDevice: 2 });
  t.after(() => s.close());
  s.config.listenAddresses = ['127.0.0.2'];
  await listenAll(s.app, { retryDelaysMs: [50] });
  await listeningOn(s, '127.0.0.2');
  const port = (s.app.server.address() as { port: number }).port;
  const a = await handshake(port, {}, '127.0.0.2');
  const b = await handshake(port, {}, '127.0.0.2');
  await assert.rejects(handshake(port, {}, '127.0.0.2'), 'the third is closed at once');
  assert.ok(s.logs.some((l) => l.includes('that device already has the most allowed')));
  a.destroy();
  await sleep(100);
  const c = await handshake(port, {}, '127.0.0.2');
  c.destroy();
  b.destroy();
});

test('another program on our address and port is an alarm: an error in the log and red on the settings page', { skip }, async (t) => {
  const port = await freePort();
  const squatter = createNetServer(() => {});
  await new Promise<void>((r) => squatter.listen(port, '127.0.0.2', () => r()));
  t.after(() => new Promise<void>((r) => squatter.close(() => r())));
  const s = await tlsTestApp({ port });
  t.after(() => s.close());
  s.config.listenAddresses = ['127.0.0.2'];
  await listenAll(s.app, { retryDelaysMs: [50] });
  await sleep(150);
  assert.equal(s.app.shelf.listeners.problems().get('127.0.0.2'), 'in-use');
  assert.ok(s.logs.some((l) => l.includes('"level":50') && l.includes('another program is listening on this address and port')));
  const page = await s.app.inject({ method: 'GET', url: '/settings', headers: { host: NAME, cookie: await signInAdmin(s, port) } });
  assert.match(page.body, new RegExp(`<p class="error" role="alert">Another program is listening on 127\\.0\\.0\\.2 port ${port}, so ShelfReady cannot\\.`));
  assert.match(page.body, /127\.0\.0\.2 \(taken by another program\)/);
  // Once it stops, ShelfReady takes the address.
  await new Promise<void>((r) => squatter.close(() => r()));
  await listeningOn(s, '127.0.0.2');
  assert.equal(s.app.shelf.listeners.problems().size, 0);
});

test('the server reads the pair cert.ts installs through the current link, and reloads when it switches', { skip }, async (t) => {
  const dir = scratch();
  const tls = privateDir(join(dir, 'tls'));
  const first = issuedChain(join(dir, 'a'), [NAME], { staging: true });
  installPair(tls, first.fullchain, first.key, { hosts: [NAME] });
  const s = await makeApp({ tls: { enabled: true, certPath: join(tls, 'current', 'fullchain.pem'), keyPath: join(tls, 'current', 'key.pem') }, allowedHosts: [NAME], port: 0 });
  t.after(() => s.close());
  assert.equal(s.config.tls.statusPath, join(tls, 'status.json'), 'the record beside current/');
  await listenAll(s.app);
  const port = (s.app.server.address() as { port: number }).port;
  const served = async (): Promise<string> => {
    const sock = await handshake(port);
    const fp = sock.getPeerX509Certificate()!.fingerprint256;
    sock.destroy();
    return fp;
  };
  const leaf = (chain: Buffer): string => new X509Certificate(chain).fingerprint256;
  assert.equal(await served(), leaf(first.fullchain));
  const second = issuedChain(join(dir, 'b'), [NAME], { staging: true });
  installPair(tls, second.fullchain, second.key, { hosts: [NAME] });
  assert.equal(s.app.shelf.tlsReload(), 'reloaded');
  assert.equal(await served(), leaf(second.fullchain));
});

test('slow clients are cut off: headers, sign-in bodies, but not the upload', { skip }, async (t) => {
  const port = await freePort();
  const s = await tlsTestApp(
    { port, headersTimeoutSeconds: 1, formTimeoutSeconds: 1, requestTimeoutSeconds: 5 },
    {
      // Stands in for the invoice upload: marked like it, so only requestTimeout applies.
      extraRoutes: (app) => app.post('/slow-upload', { config: { access: 'public', multipartCsrf: true } }, async () => 'ok'),
    },
  );
  t.after(() => s.close());
  await listenAll(s.app);
  const origin = `https://${NAME}:${port}`;
  const [headers, login, upload] = await Promise.all([
    rawRequest(port, `GET /login HTTP/1.1\r\nHost: ${NAME}\r\n`, 'X'.repeat(40), 200),
    rawRequest(port, `POST /login HTTP/1.1\r\nHost: ${NAME}\r\nOrigin: ${origin}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 100\r\n\r\n`, 'a'.repeat(100), 200),
    rawRequest(port, `POST /slow-upload HTTP/1.1\r\nHost: ${NAME}\r\nOrigin: ${origin}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 10\r\nConnection: close\r\n\r\n`, 'a=12345678', 200),
  ]);
  assert.ok(headers.ms < 3500 && headers.ms >= 900, `slow headers cut after ${headers.ms} ms`);
  assert.ok(login.ms < 3000 && login.ms >= 900, `slow sign-in body cut after ${login.ms} ms`);
  assert.doesNotMatch(login.status, /200/);
  assert.equal(upload.status, 'HTTP/1.1 200 OK', 'the upload route may take longer than formTimeoutSeconds');
  assert.ok(upload.ms >= 1800, `upload finished after ${upload.ms} ms`);
  assert.ok(s.logs.some((l) => l.includes('closed a request that was too slow to arrive')));
});

test('a key in the data folder or a missing certificate stops the start with plain words', { skip }, async () => {
  const dir = scratch();
  mkdirSync(join(dir, 'data'), { recursive: true });
  const t = selfSigned(privateDir(join(dir, 'data', 'tls')), [NAME]);
  const { buildApp } = await import('../src/server/app.ts');
  const { makeConfig } = await import('../src/server/config.ts');
  const base = { dbPath: join(dir, 'data', 'x.sqlite3'), masterKeyPath: join(dir, 'keys', 'master.key'), scrypt: { N: 1024, r: 8, p: 1 } };
  assert.throws(() => makeConfig({ ...base, tls: { enabled: true, certPath: t.cert, keyPath: t.key } }), /data folder/);
  const cfg = makeConfig({ ...base, tls: { enabled: true, certPath: join(dir, 'none', 'fullchain.pem'), keyPath: join(dir, 'none', 'key.pem') } });
  await assert.rejects(buildApp(cfg), /no folder .* for the TLS key/);
});
