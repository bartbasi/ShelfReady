import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PW, MANAGER_PW, ORIGIN, addUser, csrfFrom, form, get, login, makeApp, post, tempDir } from './server-helpers.ts';
import { openDatabase } from '../src/db/db.ts';
import { SYSTEM_ACTOR } from '../src/db/audit.ts';
import { createUser, setDisabled, setRole, UserError } from '../src/auth/users.ts';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

/** Fills :id with a real user id so the route is reached, not a 404. */
function concrete(url: string, id: number): string {
  return url.replace(':id', String(id));
}

test('every route declares an access level', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const routes = s.app.shelf.routes.filter((r) => r.method !== 'HEAD');
  assert.ok(routes.length >= 15);
  for (const r of routes) assert.ok(r.access, `${r.method} ${r.url} has no access level`);
});

test('a manager gets 403 on every admin route, for GET and POST, with a valid session and token', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const mgrId = await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const r = await login(s, 'mgr', MANAGER_PW);
  const csrf = csrfFrom((await get(s, '/', r.cookie)).body);
  const admin = s.app.shelf.routes.filter((x) => x.access === 'admin' && x.method !== 'HEAD');
  assert.ok(admin.some((x) => x.url === '/settings'));
  assert.ok(admin.some((x) => x.url === '/users'));
  // Count the same set of rows before and after: everything that is not a sign-in event.
  const adminActions = () => (s.app.shelf.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action NOT LIKE 'auth.%'").get() as { n: number }).n;
  const usersBefore = JSON.stringify(s.app.shelf.db.prepare('SELECT id, role, disabled, password_hash FROM users ORDER BY id').all());
  const before = adminActions();
  for (const route of admin) {
    const url = concrete(route.url, mgrId);
    const res =
      route.method === 'GET'
        ? await get(s, url, r.cookie)
        : await post(s, url, r.cookie, { role: 'admin', password: 'promote me please 1', username: 'x1', squareEnvironment: 'sandbox' }, { csrf });
    assert.equal(res.statusCode, 403, `${route.method} ${route.url}`);
    assert.doesNotMatch(res.body, /Claude API key|Square access token|Add a user/, `${route.url} leaked admin content`);
  }
  for (const url of ['/settings', '/users']) {
    const head = await s.app.inject({ method: 'HEAD', url, headers: { cookie: r.cookie } });
    assert.equal(head.statusCode, 403, `HEAD ${url}`);
  }
  const u = s.app.shelf.db.prepare('SELECT role FROM users WHERE id = ?').get(mgrId) as { role: string };
  assert.equal(u.role, 'manager', 'the manager could not promote themselves');
  assert.equal(adminActions(), before, 'no admin action was logged');
  assert.equal(JSON.stringify(s.app.shelf.db.prepare('SELECT id, role, disabled, password_hash FROM users ORDER BY id').all()), usersBefore, 'no user row changed');
  assert.equal((s.app.shelf.db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n, 0, 'no setting was written');
});

test('signed-out visitors are sent to sign in, or refused for posts', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  for (const route of s.app.shelf.routes.filter((x) => x.access !== 'public' && x.method !== 'HEAD')) {
    const url = concrete(route.url, 1);
    if (route.method === 'GET') {
      const res = await get(s, url);
      assert.equal(res.statusCode, 303, route.url);
      assert.equal(res.headers.location, '/login');
    } else {
      const res = await s.app.inject({ method: 'POST', url, headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: form({}) });
      assert.equal(res.statusCode, 401, route.url);
    }
  }
});

test('the manager home page has no settings or users links; the admin one does', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const m = await get(s, '/', (await login(s, 'mgr', MANAGER_PW)).cookie);
  assert.doesNotMatch(m.body, /href="\/settings"|href="\/users"/);
  const a = await get(s, '/', (await login(s, 'bart', ADMIN_PW)).cookie);
  assert.match(a.body, /href="\/settings"/);
  assert.match(a.body, /href="\/users"/);
});

test('a role change takes effect on the next request', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const mgrId = await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const mgr = await login(s, 'mgr', MANAGER_PW);
  const admin = await login(s, 'bart', ADMIN_PW);
  assert.equal((await get(s, '/settings', mgr.cookie)).statusCode, 403);
  assert.equal((await post(s, `/users/${mgrId}/role`, admin.cookie, { role: 'admin' }, { csrfPage: '/users' })).statusCode, 303);
  assert.equal((await get(s, '/settings', mgr.cookie)).statusCode, 200);
  assert.equal((await post(s, `/users/${mgrId}/role`, admin.cookie, { role: 'manager' }, { csrfPage: '/users' })).statusCode, 303);
  assert.equal((await get(s, '/settings', mgr.cookie)).statusCode, 403);
});

test('admin creates, disables, enables and resets users through the pages', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const a = await login(s, 'bart', ADMIN_PW);
  const opts = { csrfPage: '/users' };
  assert.equal((await post(s, '/users', a.cookie, { username: 'Anna', role: 'manager', password: 'starting password 1' }, opts)).statusCode, 303);
  const dup = await post(s, '/users', a.cookie, { username: 'anna', role: 'manager', password: 'starting password 1' }, opts);
  assert.equal(dup.statusCode, 400, 'usernames are unique without case');
  assert.match(dup.body, /That username is taken/);
  const short = await post(s, '/users', a.cookie, { username: 'zed', role: 'manager', password: 'short' }, opts);
  assert.equal(short.statusCode, 400);
  const id = (s.app.shelf.db.prepare("SELECT id FROM users WHERE username = 'anna'").get() as { id: number }).id;
  const anna = await login(s, 'anna', 'starting password 1');
  assert.equal(anna.location, '/account', 'a new user picks their own password');
  assert.equal((await post(s, `/users/${id}/disable`, a.cookie, {}, opts)).statusCode, 303);
  assert.equal((await get(s, '/account', anna.cookie)).statusCode, 303, 'disabling ends their sessions');
  assert.equal((await login(s, 'anna', 'starting password 1')).status, 401);
  assert.equal((await post(s, `/users/${id}/enable`, a.cookie, {}, opts)).statusCode, 303);
  assert.equal((await post(s, `/users/${id}/password`, a.cookie, { password: 'another start pw 2' }, opts)).statusCode, 303);
  assert.equal((await login(s, 'anna', 'another start pw 2')).status, 303);
  assert.equal((await post(s, '/users/999/disable', a.cookie, {}, opts)).statusCode, 404);
  assert.equal((await post(s, '/users/abc/disable', a.cookie, {}, opts)).statusCode, 400);
});

test('an admin cannot disable themselves or remove the last admin', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const bartId = await addUser(s, 'bart', 'admin', ADMIN_PW);
  const a = await login(s, 'bart', ADMIN_PW);
  const opts = { csrfPage: '/users' };
  const self = await post(s, `/users/${bartId}/disable`, a.cookie, {}, opts);
  assert.equal(self.statusCode, 400);
  assert.match(self.body, /cannot disable your own account/);
  const demote = await post(s, `/users/${bartId}/role`, a.cookie, { role: 'manager' }, opts);
  assert.equal(demote.statusCode, 400);
  assert.match(demote.body, /last active admin/);
  assert.equal((await get(s, '/settings', a.cookie)).statusCode, 200, 'still an admin');
});

test('last-admin rules hold in the users module too', async () => {
  const dir = tempDir();
  const db = openDatabase(join(dir, 'u.sqlite3'));
  try {
    const opts = { scrypt: { N: 1024, r: 8, p: 1 }, minLength: 12, actor: SYSTEM_ACTOR };
    const a = await createUser(db, { username: 'a1', role: 'admin', password: 'admin one pass 1' }, opts);
    const b = await createUser(db, { username: 'b1', role: 'admin', password: 'admin two pass 2' }, opts);
    const asA = { userId: a.id, username: 'a1' };
    setDisabled(db, b.id, true, asA);
    // b is disabled, so a is the last active admin. Nobody can disable or demote a.
    assert.throws(() => setDisabled(db, a.id, true, { userId: b.id, username: 'b1' }), UserError);
    assert.throws(() => setRole(db, a.id, 'manager', SYSTEM_ACTOR), UserError);
    // Demoting a disabled admin is allowed: it does not reduce active admins.
    setRole(db, b.id, 'manager', asA);
    setDisabled(db, b.id, false, asA);
    setRole(db, b.id, 'admin', asA);
    setRole(db, a.id, 'manager', { userId: b.id, username: 'b1' });
    await assert.rejects(createUser(db, { username: 'A1', role: 'manager', password: 'whatever pass 12' }, opts), /taken/);
    await assert.rejects(createUser(db, { username: 'bad name', role: 'manager', password: 'whatever pass 12' }, opts), UserError);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
