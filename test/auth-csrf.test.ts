import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PW, ORIGIN, addUser, csrfFrom, get, login, makeApp, post } from './server-helpers.ts';
import { originAllowed } from '../src/auth/csrf.ts';

const NEW_USER = { username: 'newbie', role: 'manager', password: 'a long enough pw 1' };

async function setup() {
  const s = await makeApp();
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const r = await login(s, 'bart', ADMIN_PW);
  const csrf = csrfFrom((await get(s, '/users', r.cookie)).body);
  const userCount = () => (s.app.shelf.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
  return { s, cookie: r.cookie, csrf, userCount };
}

test('origin check: Origin first, then Referer, and neither means refuse', () => {
  const allowed = [ORIGIN];
  assert.equal(originAllowed({ origin: ORIGIN }, allowed), true);
  assert.equal(originAllowed({ origin: 'http://127.0.0.1:3001' }, allowed), false);
  assert.equal(originAllowed({ origin: 'null' }, allowed), false);
  assert.equal(originAllowed({ referer: `${ORIGIN}/users` }, allowed), true);
  assert.equal(originAllowed({ referer: 'https://evil.example/x' }, allowed), false);
  assert.equal(originAllowed({ referer: 'not a url' }, allowed), false);
  assert.equal(originAllowed({}, allowed), false);
  // A good Referer does not rescue a bad Origin.
  assert.equal(originAllowed({ origin: 'https://evil.example', referer: `${ORIGIN}/` }, allowed), false);
});

test('a post with the right token and origin works', async (t) => {
  const { s, cookie, csrf, userCount } = await setup();
  t.after(() => s.close());
  const res = await post(s, '/users', cookie, NEW_USER, { csrf });
  assert.equal(res.statusCode, 303);
  assert.equal(userCount(), 2);
});

test('a post with only a same-origin Referer works', async (t) => {
  const { s, cookie, csrf, userCount } = await setup();
  t.after(() => s.close());
  const res = await post(s, '/users', cookie, NEW_USER, { csrf, origin: null, referer: `${ORIGIN}/users` });
  assert.equal(res.statusCode, 303);
  assert.equal(userCount(), 2);
});

test('a post from another origin is refused', async (t) => {
  const { s, cookie, csrf, userCount } = await setup();
  t.after(() => s.close());
  const res = await post(s, '/users', cookie, NEW_USER, { csrf, origin: 'https://evil.example' });
  assert.equal(res.statusCode, 403);
  assert.equal(userCount(), 1);
});

test('a post with no Origin and no Referer is refused', async (t) => {
  const { s, cookie, csrf, userCount } = await setup();
  t.after(() => s.close());
  const res = await post(s, '/users', cookie, NEW_USER, { csrf, origin: null });
  assert.equal(res.statusCode, 403);
  assert.equal(userCount(), 1);
});

test('a post with a missing or wrong token is refused', async (t) => {
  const { s, cookie, csrf, userCount } = await setup();
  t.after(() => s.close());
  assert.equal((await post(s, '/users', cookie, NEW_USER, { csrf: '' })).statusCode, 403);
  assert.equal((await post(s, '/users', cookie, NEW_USER, { csrf: csrf.slice(0, -1) + (csrf.endsWith('A') ? 'B' : 'A') })).statusCode, 403);
  assert.equal(userCount(), 1);
});

test("another session's token does not work", async (t) => {
  const { s, cookie, userCount } = await setup();
  t.after(() => s.close());
  const other = await login(s, 'bart', ADMIN_PW);
  const otherCsrf = csrfFrom((await get(s, '/users', other.cookie)).body);
  assert.equal((await post(s, '/users', cookie, NEW_USER, { csrf: otherCsrf })).statusCode, 403);
  assert.equal(userCount(), 1);
});

test('sign out also needs the token, so a page cannot sign someone out', async (t) => {
  const { s, cookie } = await setup();
  t.after(() => s.close());
  assert.equal((await post(s, '/logout', cookie, {}, { csrf: 'nope' })).statusCode, 403);
  assert.equal((await get(s, '/', cookie)).statusCode, 200);
});
