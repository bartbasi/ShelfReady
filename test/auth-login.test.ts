import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PW, MANAGER_PW, ORIGIN, START, addUser, csrfFrom, form, get, login, makeApp, post } from './server-helpers.ts';
import { hashPassword, verifyPassword } from '../src/auth/password.ts';
import { listAudit, SYSTEM_ACTOR } from '../src/db/audit.ts';
import { createUser } from '../src/auth/users.ts';
import { clearUserLock, recordLoginEvent, summarizeLoginEvents } from '../src/auth/throttle.ts';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('password hashes are salted, carry their parameters and verify in constant time', async () => {
  const p = { N: 1024, r: 8, p: 1 };
  const a = await hashPassword('same password here', p);
  const b = await hashPassword('same password here', p);
  assert.notEqual(a, b, 'each hash has its own salt');
  assert.match(a, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await verifyPassword('same password here', a), true);
  assert.equal(await verifyPassword('same password herE', a), false);
  assert.equal(await verifyPassword('x', 'not a hash'), false);
  const parts = a.split('$');
  parts[1] = String(2 ** 30);
  assert.equal(await verifyPassword('same password here', parts.join('$')), false, 'absurd parameters are refused');
});

test('sign in works, sets a strict HttpOnly session cookie, and stores only a hash', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'Bart', 'admin', ADMIN_PW);
  const r = await login(s, 'bart', ADMIN_PW);
  assert.equal(r.status, 303);
  assert.equal(r.location, '/');
  const sc = r.setCookie.find((c) => c.startsWith('sr_session='))!;
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  assert.doesNotMatch(sc, /Max-Age|Expires/, 'without remember the cookie ends with the browser');
  assert.doesNotMatch(sc, /Secure/, 'Secure is off while TLS is off');
  const home = await get(s, '/', r.cookie);
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /Signed in as <strong>Bart<\/strong>/);
  const token = r.cookie.split('=')[1];
  const rows = s.app.shelf.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id_hash, token);
  assert.equal(rows[0].id_hash.length, 64);
  assert.ok(listAudit(s.app.shelf.db).some((a) => a.action === 'auth.login' && a.username === 'Bart'));
});

test('cookies are marked Secure whenever TLS is on', async () => {
  const { makeConfig, cookiesSecure } = await import('../src/server/config.ts');
  const c = makeConfig({ tls: { enabled: true, certPath: '/x/cert.pem', keyPath: '/x/key.pem' }, listenAddresses: ['10.0.0.5'], allowedHosts: ['shelfready.example.com'] });
  assert.equal(cookiesSecure(c), true);
  assert.deepEqual(c.publicOrigins, ['https://shelfready.example.com:3000', 'https://127.0.0.1:3000', 'https://localhost:3000']);
  // A wildcard address is refused, with TLS or without.
  assert.throws(() => makeConfig({ tls: { enabled: true, certPath: '/x/cert.pem', keyPath: '/x/key.pem' }, host: '0.0.0.0' }), /loopback/);
});

test('wrong password and unknown user get the same generic message', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const wrong = await login(s, 'bart', 'not the password at all');
  const unknown = await login(s, 'nobody', 'not the password at all');
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(wrong.cookie, '');
  const msg = (b: string) => /<p class="error" role="alert">([^<]*)<\/p>/.exec(b)?.[1];
  assert.ok(msg(wrong.body));
  assert.equal(msg(wrong.body), msg(unknown.body));
  // The attempted unknown name is not logged, in case it was a password.
  const failed = listAudit(s.app.shelf.db, { action: 'auth.login_failed' });
  assert.ok(failed.every((a) => !a.details.includes('nobody')));
});

test('a disabled user cannot sign in', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const id = await addUser(s, 'mgr', 'manager', MANAGER_PW);
  s.app.shelf.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id);
  assert.equal((await login(s, 'mgr', MANAGER_PW)).status, 401);
});

test('the sign in form needs its own token, so another site cannot sign a browser in', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const res = await s.app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', cookie: 'sr_login=abc' },
    payload: form({ _csrf: 'different', username: 'bart', password: ADMIN_PW }),
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.cookies.find((c) => c.name === 'sr_session'), undefined);
  const cross = await s.app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'bart', password: ADMIN_PW }),
  });
  assert.equal(cross.statusCode, 403);
});

test('throttling per username locks out even the right password, then backs off', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  for (let i = 0; i < 5; i++) assert.equal((await login(s, 'bart', `wrong password ${i}`)).status, 401);
  const locked = await login(s, 'BART', ADMIN_PW);
  assert.equal(locked.status, 429, 'locked, and the name is matched without case');
  assert.equal(locked.cookie, '');
  s.advance(31 * 1000);
  // One more failure after the lock doubles it to 60 seconds.
  assert.equal((await login(s, 'bart', 'wrong again here')).status, 401);
  s.advance(31 * 1000);
  assert.equal((await login(s, 'bart', ADMIN_PW)).status, 429);
  s.advance(30 * 1000);
  const ok = await login(s, 'bart', ADMIN_PW);
  assert.equal(ok.status, 303);
  // Success clears the username count.
  assert.equal((await login(s, 'bart', 'one wrong try')).status, 401);
  assert.equal((await login(s, 'bart', ADMIN_PW)).status, 303);
});

test('throttling per IP stops spraying many usernames', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  for (let i = 0; i < 20; i++) await login(s, `user${i}`, 'wrong password', false, '10.0.0.9');
  assert.equal((await login(s, 'bart', ADMIN_PW, false, '10.0.0.9')).status, 429);
  assert.equal((await login(s, 'bart', ADMIN_PW, false, '10.0.0.10')).status, 303, 'another address is not affected');
});

test('a session without remember ends after the idle timeout', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const r = await login(s, 'bart', ADMIN_PW);
  s.advance(119 * MIN);
  assert.equal((await get(s, '/', r.cookie)).statusCode, 200);
  s.advance(119 * MIN);
  assert.equal((await get(s, '/', r.cookie)).statusCode, 200, 'activity keeps it alive');
  s.advance(121 * MIN);
  const res = await get(s, '/', r.cookie);
  assert.equal(res.statusCode, 303);
  assert.equal(res.headers.location, '/login');
  assert.equal((s.app.shelf.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 0);
});

test('a session without remember ends after 12 hours even when active', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const r = await login(s, 'bart', ADMIN_PW);
  for (let i = 0; i < 11; i++) {
    s.advance(HOUR);
    assert.equal((await get(s, '/', r.cookie)).statusCode, 200);
  }
  s.advance(HOUR);
  assert.equal((await get(s, '/', r.cookie)).statusCode, 303);
});

test('remember this device lasts about 30 days, idle or not', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const r = await login(s, 'bart', ADMIN_PW, true);
  const sc = r.setCookie.find((c) => c.startsWith('sr_session='))!;
  assert.match(sc, new RegExp(`Max-Age=${30 * 24 * 60 * 60}`));
  s.advance(10 * DAY);
  assert.equal((await get(s, '/', r.cookie)).statusCode, 200, 'ten idle days is fine');
  s.advance(19 * DAY);
  assert.equal((await get(s, '/', r.cookie)).statusCode, 200);
  s.advance(1 * DAY + MIN);
  assert.equal((await get(s, '/', r.cookie)).statusCode, 303, 'gone after 30 days');
});

test('sign out ends the session and clears the cookie', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const r = await login(s, 'bart', ADMIN_PW);
  const out = await post(s, '/logout', r.cookie, {}, { csrfPage: '/' });
  assert.equal(out.statusCode, 303);
  assert.equal(out.headers.location, '/login');
  assert.ok(out.cookies.some((c) => c.name === 'sr_session' && c.value === ''));
  assert.equal((await get(s, '/', r.cookie)).statusCode, 303, 'the old cookie no longer works');
});

test('sign out everywhere ends every session for that user', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const mgrId = await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const phone = await login(s, 'mgr', MANAGER_PW, true);
  const desk = await login(s, 'mgr', MANAGER_PW);
  const admin = await login(s, 'bart', ADMIN_PW);
  // By the admin, for the manager.
  const res = await post(s, `/users/${mgrId}/sign-out-everywhere`, admin.cookie, {}, { csrfPage: '/users' });
  assert.equal(res.statusCode, 303);
  assert.equal((await get(s, '/', phone.cookie)).statusCode, 303);
  assert.equal((await get(s, '/', desk.cookie)).statusCode, 303);
  assert.equal((await get(s, '/', admin.cookie)).statusCode, 200, 'the admin stays signed in');
  // By a user, for themselves.
  const a2 = await login(s, 'bart', ADMIN_PW);
  await post(s, '/account/sign-out-everywhere', a2.cookie, {});
  assert.equal((await get(s, '/', admin.cookie)).statusCode, 303);
  assert.equal((await get(s, '/', a2.cookie)).statusCode, 303);
});

test('a user given a password by an admin must choose their own before going on', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await addUser(s, 'mgr', 'manager', MANAGER_PW, true);
  const r = await login(s, 'mgr', MANAGER_PW);
  assert.equal(r.location, '/account');
  const home = await get(s, '/', r.cookie);
  assert.equal(home.statusCode, 303);
  assert.equal(home.headers.location, '/account');
  const bad = await post(s, '/account/password', r.cookie, { current: 'wrong current pw', password: 'a brand new pass 1', confirm: 'a brand new pass 1' });
  assert.equal(bad.statusCode, 400);
  const ok = await post(s, '/account/password', r.cookie, { current: MANAGER_PW, password: 'a brand new pass 1', confirm: 'a brand new pass 1' });
  assert.equal(ok.statusCode, 303);
  const fresh = ok.cookies.find((c) => c.name === 'sr_session')!.value;
  assert.equal((await get(s, '/', r.cookie)).statusCode, 303, 'the old session ended');
  assert.equal((await get(s, '/', `sr_session=${fresh}`)).statusCode, 200);
  assert.equal((await login(s, 'mgr', 'a brand new pass 1')).status, 303);
});

test('parallel sign-in attempts cannot get past the lockout', async (t) => {
  const s = await makeApp({ maxConcurrentHashes: 50 });
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  // Fetch 30 sign-in forms first, then fire all 30 posts at once.
  const forms = await Promise.all(
    Array.from({ length: 30 }, async () => {
      const page = await s.app.inject({ method: 'GET', url: '/login' });
      return { cookie: page.cookies.find((c) => c.name === 'sr_login')!.value, csrf: csrfFrom(page.body) };
    }),
  );
  const results = await Promise.all(
    forms.map((f, i) =>
      s.app.inject({
        method: 'POST',
        url: '/login',
        headers: { origin: ORIGIN, cookie: `sr_login=${f.cookie}`, 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ _csrf: f.csrf, username: 'bart', password: `wrong guess ${i}` }),
      }),
    ),
  );
  const checked = results.filter((r) => r.statusCode === 401).length;
  const locked = results.filter((r) => r.statusCode === 429).length;
  assert.equal(checked, 5, 'only the first 5 passwords were checked');
  assert.equal(locked, 25);
});

test('too many password checks at once get 429 and are not counted as failures', async (t) => {
  const s = await makeApp({ maxConcurrentHashes: 1 });
  t.after(() => s.close());
  // A slow hash (real parameters), so the first check is still running when the others arrive.
  await createUser(s.app.shelf.db, { username: 'bart', role: 'admin', password: ADMIN_PW }, { scrypt: { N: 2 ** 15, r: 8, p: 1 }, minLength: 12, actor: SYSTEM_ACTOR });
  const forms = await Promise.all([0, 1, 2].map(async () => {
    const page = await s.app.inject({ method: 'GET', url: '/login' });
    return { cookie: page.cookies.find((c) => c.name === 'sr_login')!.value, csrf: csrfFrom(page.body) };
  }));
  const results = await Promise.all(
    forms.map((f) =>
      s.app.inject({
        method: 'POST',
        url: '/login',
        headers: { origin: ORIGIN, cookie: `sr_login=${f.cookie}`, 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({ _csrf: f.csrf, username: 'bart', password: ADMIN_PW }),
      }),
    ),
  );
  const codes = results.map((r) => r.statusCode).sort();
  assert.equal(codes[0], 303, 'one got through');
  assert.ok(codes.slice(1).every((c) => c === 429), String(codes));
  assert.match(results.find((r) => r.statusCode === 429)!.body, /busy/);
  assert.equal((s.app.shelf.db.prepare('SELECT count(*) AS n FROM login_throttle WHERE key = ?').get(s.app.shelf.userKey('bart')) as { n: number }).n, 0);
});

test('a good sign in takes back its own IP count but keeps earlier failures', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await login(s, 'someone', 'wrong password 1', false, '10.0.0.7');
  await login(s, 'someone', 'wrong password 2', false, '10.0.0.7');
  assert.equal((await login(s, 'bart', ADMIN_PW, false, '10.0.0.7')).status, 303);
  const ip = s.app.shelf.db.prepare("SELECT failures FROM login_throttle WHERE key = 'ip:10.0.0.7'").get() as { failures: number };
  assert.equal(ip.failures, 2);
  assert.equal(s.app.shelf.db.prepare('SELECT * FROM login_throttle WHERE key = ?').get(s.app.shelf.userKey('bart')), undefined);
});

test('failures for unknown names are hourly counters, summarized once per finished hour', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const db = s.app.shelf.db;
  for (let i = 0; i < 12; i++) await login(s, `ghost${i}`, 'wrong password', false, `10.1.0.${i}`);
  assert.deepEqual(db.prepare('SELECT kind, events FROM login_events').all().map((r) => ({ ...r })), [{ kind: 'unknown_user', events: 12 }]);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM login_events').all()).includes('ghost'), 'no username is kept');
  assert.equal(listAudit(db, { action: 'auth.login_failed' }).length, 0);
  assert.equal(listAudit(db, { action: 'auth.login_events_summary' }).length, 0, 'the hour is not finished yet');
  // A quiet spell: no more attempts. The hourly timer still writes the summary.
  s.advance(61 * 60 * 1000);
  summarizeLoginEvents(db, START + 61 * 60 * 1000);
  const sums = listAudit(db, { action: 'auth.login_events_summary' });
  assert.equal(sums.length, 1);
  assert.deepEqual(JSON.parse(sums[0].details).counts, { unknown_user: 12 });
  summarizeLoginEvents(db, START + 62 * 60 * 1000);
  assert.equal(listAudit(db, { action: 'auth.login_events_summary' }).length, 1, 'nothing new, nothing written');
  // Summarized hours older than 30 days are pruned.
  s.advance(31 * 24 * 60 * 60 * 1000);
  await login(s, 'ghost-later', 'wrong password', false, '10.3.0.1');
  assert.equal((db.prepare('SELECT count(*) AS n FROM login_events').get() as { n: number }).n, 1);
});

test('a flood of locked attempts adds one counter row, not one row each', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  for (let i = 0; i < 5; i++) await login(s, 'bart', `wrong ${i} password`);
  for (let i = 0; i < 200; i++) recordLoginEvent(s.app.shelf.db, 'locked', START);
  assert.equal((await login(s, 'bart', ADMIN_PW)).status, 429);
  const rows = s.app.shelf.db.prepare('SELECT kind, events FROM login_events').all() as { kind: string; events: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].events, 201);
});

test('changing your own password signs out your other devices and keeps this one', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const phone = await login(s, 'mgr', MANAGER_PW, true);
  const desk = await login(s, 'mgr', MANAGER_PW);
  const res = await post(s, '/account/password', desk.cookie, { current: MANAGER_PW, password: 'new pass phrase 77', confirm: 'new pass phrase 77' });
  assert.equal(res.statusCode, 303);
  const fresh = `sr_session=${res.cookies.find((c) => c.name === 'sr_session')!.value}`;
  assert.equal((await get(s, '/', phone.cookie)).statusCode, 303, 'the phone is signed out');
  assert.equal((await get(s, '/', desk.cookie)).statusCode, 303, 'the old desk token is gone');
  assert.equal((await get(s, '/', fresh)).statusCode, 200, 'this device stays signed in');
  assert.equal((s.app.shelf.db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 1);
});

test('the typed username is never stored, only an HMAC of it', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await login(s, 'MyTypedPassword99', 'wrong password');
  const rows = s.app.shelf.db.prepare('SELECT key FROM login_throttle').all() as { key: string }[];
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => !r.key.toLowerCase().includes('mytypedpassword')));
  assert.ok(rows.some((r) => /^user:[0-9a-f]{64}$/.test(r.key)));
  assert.equal(s.app.shelf.userKey('MYTYPEDPASSWORD99 '), s.app.shelf.userKey('mytypedpassword99'), 'case and spaces do not matter');
  assert.equal((s.app.shelf.db.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete, 1);
});

test('housekeeping prunes stale throttle rows and survives a database error', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const db = s.app.shelf.db;
  db.prepare("INSERT INTO login_throttle (key, failures, last_failure_at, locked_until) VALUES ('ip:10.9.9.9', 1, ?, 0)").run(START - 25 * 60 * 60 * 1000);
  s.app.shelf.housekeeping();
  assert.equal(db.prepare("SELECT * FROM login_throttle WHERE key = 'ip:10.9.9.9'").get(), undefined);
  db.exec('DROP TABLE login_events');
  assert.doesNotThrow(() => s.app.shelf.housekeeping());
  const line = s.logs.find((l) => l.includes('housekeeping failed'));
  assert.ok(line, 'the failure is logged');
  assert.doesNotMatch(line!, /"msg":"housekeeping failed".*SELECT|login_events/, 'no SQL or values in the log line');
});

test('clearUserLock lifts only that username', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const db = s.app.shelf.db;
  for (const n of ['anna', 'bart']) for (let i = 0; i < 5; i++) await login(s, n, `wrong pw ${i}`, false, `10.4.0.${i}`);
  const count = () => (db.prepare("SELECT count(*) AS n FROM login_throttle WHERE key LIKE 'user:%'").get() as { n: number }).n;
  assert.equal(count(), 2);
  clearUserLock(db, 'ANNA', s.app.shelf.userKey);
  assert.equal(count(), 1);
  clearUserLock(db, 'whoever', s.app.shelf.userKey);
  assert.equal(count(), 1, 'bart is still locked');
  assert.ok((db.prepare("SELECT count(*) AS n FROM login_throttle WHERE key LIKE 'ip:%'").get() as { n: number }).n > 0, 'IP counts stay');
});
