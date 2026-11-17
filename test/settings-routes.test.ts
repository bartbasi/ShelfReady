import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PW, MANAGER_PW, addUser, ageReauth, get, logText, login, makeApp, post, type TestApp } from './server-helpers.ts';
import { listAudit } from '../src/db/audit.ts';

// Made up at run time, so no real-looking key sits in the repo.
const SECRET = `test-claude-key-${'q'.repeat(24)}ABCD`;
const SQ_TOKEN = `TESTSQUARE${'z'.repeat(30)}EFGH`;

const BASE = {
  anthropicFirstPassModel: 'claude-sonnet-5-5',
  anthropicFallbackModel: 'claude-opus-5-5',
  invoiceCostCapUsd: '1.00',
  cardCopyCapUsd: '5.00',
  dailyLimitUsd: '10.00',
  historySharePercent: '50',
  bigChangePercent: '30',
  squareEnvironment: 'sandbox',
  squareLocationId: '',
  scaleConnectUrl: '',
  cardConfigPath: '',
  pricingAddBefore: '0.00',
  pricingMultiplier: '2',
  pricingAddAfter: '1.00',
  pricingRounding: 'up-to-99',
  pricingVendors: '',
};

/** Everything a response or the log could carry. */
function assertNoSecrets(where: string, text: string): void {
  for (const s of [SECRET, SQ_TOKEN, ADMIN_PW, MANAGER_PW, SECRET.slice(0, 20), SQ_TOKEN.slice(0, 20)]) {
    assert.ok(!text.includes(s), `${where} contains a secret or password`);
  }
}

async function adminSession(s: TestApp): Promise<string> {
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  return (await login(s, 'bart', ADMIN_PW, true)).cookie;
}

test('admin saves secrets; no page, header or log line ever carries them', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const bodies: string[] = [];
  const save = await post(
    s,
    '/settings',
    cookie,
    { ...BASE, secret_anthropicApiKey: SECRET, secret_squareAccessToken: SQ_TOKEN, scaleConnectUrl: 'http://127.0.0.1:18765/mcp' },
    { csrfPage: '/settings' },
  );
  assert.equal(save.statusCode, 303);
  assert.equal(save.headers.location, '/settings?notice=saved');
  bodies.push(save.body, JSON.stringify(save.headers));
  assert.equal(s.app.shelf.settings.getSecret('anthropicApiKey'), SECRET);
  assert.equal(s.app.shelf.settings.getSecret('squareAccessToken'), SQ_TOKEN);

  const page = await get(s, '/settings', cookie);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Set, ends in ABCD/);
  assert.match(page.body, /Set, ends in EFGH/);
  assert.doesNotMatch(page.body, /name="secret_[a-zA-Z]+"[^>]*value=/, 'secret inputs are always empty');
  bodies.push(page.body);

  // A failed save shows the error but never echoes the secret typed in.
  const bad = await post(s, '/settings', cookie, { ...BASE, invoiceCostCapUsd: 'lots', secret_scaleConnectToken: SECRET }, { csrfPage: '/settings' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /Not saved/);
  assert.equal(s.app.shelf.settings.getSecret('scaleConnectToken'), undefined, 'nothing from a bad batch is saved');
  bodies.push(bad.body);

  // Leaving a secret blank keeps it.
  await post(s, '/settings', cookie, { ...BASE, invoiceCostCapUsd: '3.00' }, { csrfPage: '/settings' });
  assert.equal(s.app.shelf.settings.getSecret('anthropicApiKey'), SECRET);

  // The manager's screens.
  const mgr = await login(s, 'mgr', MANAGER_PW);
  for (const url of ['/', '/account', '/about', '/settings', '/users']) bodies.push((await get(s, url, mgr.cookie)).body);
  bodies.push((await get(s, '/users', cookie)).body, (await get(s, '/', cookie)).body);

  for (const b of bodies) assertNoSecrets('a response', b);
  assert.ok(s.logs.length > 10, 'the logger was captured');
  // Decode any bytes in the log too, so a secret in a raw packet or Buffer is still caught.
  assertNoSecrets('the log', logText(s.logs));
  // Session tokens stay out of the log too.
  const token = cookie.split('=')[1];
  assert.ok(!logText(s.logs).includes(token));
  assertNoSecrets('the audit log', JSON.stringify(s.app.shelf.db.prepare('SELECT * FROM audit_log').all()));
});

test('removing a secret clears it and is logged without the value', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  await post(s, '/settings', cookie, { ...BASE, secret_anthropicApiKey: SECRET }, { csrfPage: '/settings' });
  const res = await post(s, '/settings', cookie, { ...BASE, clear_anthropicApiKey: '1' }, { csrfPage: '/settings' });
  assert.equal(res.statusCode, 303);
  assert.equal(s.app.shelf.settings.getSecret('anthropicApiKey'), undefined);
  assert.match((await get(s, '/settings', cookie)).body, /Not set/);
});

test('production cannot be chosen while the config locks it', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  const page = await get(s, '/settings', cookie);
  assert.match(page.body, /value="production" disabled/);
  const res = await post(s, '/settings', cookie, { ...BASE, squareEnvironment: 'production' }, { csrfPage: '/settings' });
  assert.equal(res.statusCode, 400);
  assert.equal(s.app.shelf.settings.getSetting('squareEnvironment'), 'sandbox');
});

test('vendor formulas are saved from the settings form', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  const res = await post(s, '/settings', cookie, { ...BASE, pricingVendors: "Example's Cheese Co | 2.25 | 2 | 0.00" }, { csrfPage: '/settings' });
  assert.equal(res.statusCode, 303);
  assert.deepEqual(s.app.shelf.settings.getSetting('pricing').vendors, [
    { vendor: "Example's Cheese Co", formula: { addBefore: '2.25', multiplier: '2', addAfter: '0.00', rounding: 'up-to-99' } },
  ]);
  const page = await get(s, '/settings', cookie);
  assert.match(page.body, /Example&#39;s Cheese Co \| 2.25 \| 2 \| 0.00/);
});

test('a repeated form field is refused, not guessed at', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  const csrf = /name="_csrf" value="([^"]+)"/.exec((await get(s, '/settings', cookie)).body)![1];
  const res = await s.app.inject({
    method: 'POST',
    url: '/settings',
    headers: { cookie, origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-www-form-urlencoded' },
    payload: `_csrf=${csrf}&invoiceCostCapUsd=1&invoiceCostCapUsd=2`,
  });
  assert.equal(res.statusCode, 400);
});

test('settings and user changes need the password typed in the last 15 minutes', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  ageReauth(s, 16 * 60 * 1000);
  const page = await get(s, '/settings', cookie);
  assert.match(page.body, /Confirm it is you/);
  assert.doesNotMatch(page.body, /action="\/settings"/, 'the settings form is hidden, so nothing typed is lost');
  const usersStale = (await get(s, '/users', cookie)).body;
  assert.doesNotMatch(usersStale, /action="\/users/, 'no user forms either');
  assert.match(usersStale, /<h3>bart<\/h3>/, 'the list still shows');
  const stale = await post(s, '/settings', cookie, { ...BASE, invoiceCostCapUsd: '5.00' }, { csrfPage: '/settings' });
  assert.equal(stale.statusCode, 403);
  assert.match(stale.body, /Nothing was changed/);
  assert.equal(s.app.shelf.settings.getSetting('invoiceCostCapUsd'), '1.00');
  const addUserStale = await post(s, '/users', cookie, { username: 'newbie', role: 'manager', password: 'long enough pw 12' }, { csrfPage: '/users' });
  assert.equal(addUserStale.statusCode, 403);
  const wrong = await post(s, '/reauth', cookie, { next: '/settings', password: 'not my password' }, { csrfPage: '/settings' });
  assert.equal(wrong.statusCode, 400);
  const ok = await post(s, '/reauth', cookie, { next: 'https://evil.example/', password: ADMIN_PW }, { csrfPage: '/settings' });
  assert.equal(ok.statusCode, 303);
  assert.equal(ok.headers.location, '/settings?notice=confirmed', 'next is one of a fixed list');
  assert.match((await get(s, '/settings', cookie)).body, /action="\/settings"/, 'the form is back');
  const saved = await post(s, '/settings', cookie, { ...BASE, invoiceCostCapUsd: '5.00' }, { csrfPage: '/settings' });
  assert.equal(saved.statusCode, 303);
  assert.equal(s.app.shelf.settings.getSetting('invoiceCostCapUsd'), '5.00');
});

test('a damaged setting is shown as damaged and can be entered again', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  await post(s, '/settings', cookie, { ...BASE, secret_anthropicApiKey: SECRET, invoiceCostCapUsd: '2.00' }, { csrfPage: '/settings' });
  s.app.shelf.db.prepare("UPDATE settings SET tag = zeroblob(16)").run();
  const page = await get(s, '/settings', cookie);
  assert.equal(page.statusCode, 200, 'the admin is not locked out');
  assert.match(page.body, /damaged and cannot be read/);
  assert.match(page.body, /Damaged, please enter it again/);
  const res = await post(s, '/settings', cookie, { ...BASE, secret_anthropicApiKey: SECRET, invoiceCostCapUsd: '2.00' }, { csrfPage: '/settings' });
  assert.equal(res.statusCode, 303);
  assert.equal(s.app.shelf.settings.getSecret('anthropicApiKey'), SECRET);
  assert.doesNotMatch((await get(s, '/settings', cookie)).body, /damaged/i);
});

test('the settings page shows a worked example for each formula', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  await post(s, '/settings', cookie, { ...BASE, pricingVendors: "Example's Cheese Co | 2.25 | 2 | 0.00" }, { csrfPage: '/settings' });
  const body = (await get(s, '/settings', cookie)).body;
  assert.match(body, /Saved formula: \$10.00 cost gives \$21.99/);
  assert.match(body, /<td>Example&#39;s Cheese Co<\/td>.*<td>\$10.00 cost gives \$24.99<\/td>/);
  assert.match(body, /inputmode="decimal"/, 'attributes are not escaped into text');
});

test('only a wrong re-auth password is audited; locked tries only count', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  ageReauth(s, 16 * 60 * 1000);
  const csrf = /name="_csrf" value="([^"]+)"/.exec((await get(s, '/settings', cookie)).body)![1];
  const codes: number[] = [];
  for (let i = 0; i < 8; i++) codes.push((await post(s, '/reauth', cookie, { next: '/settings', password: `wrong pw ${i}` }, { csrf })).statusCode);
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 429, 429, 429]);
  assert.equal(listAudit(s.app.shelf.db, { action: 'auth.reauth_failed' }).length, 5);
  const locked = s.app.shelf.db.prepare("SELECT events FROM login_events WHERE kind = 'locked'").get() as { events: number };
  assert.equal(locked.events, 3);
});

test('saving an unrelated field leaves a damaged value alone', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  await post(s, '/settings', cookie, { ...BASE, invoiceCostCapUsd: '2.00', pricingVendors: 'Acme | 1.00 | 2 | 0.00' }, { csrfPage: '/settings' });
  s.app.shelf.db.prepare("UPDATE settings SET tag = zeroblob(16) WHERE name IN ('value:invoiceCostCapUsd', 'value:pricing')").run();
  // The page shows the damaged fields blank. The admin changes only the location id.
  const page = (await get(s, '/settings', cookie)).body;
  assert.match(page, /id="invoiceCostCapUsd" name="invoiceCostCapUsd" value=""/);
  assert.match(page, /id="pricingMultiplier" name="pricingMultiplier" value=""/);
  assert.match(page, /<select id="pricingRounding" name="pricingRounding">\s*<option value="" selected>Choose<\/option>/);
  assert.match(page, /The saved pricing is damaged/);
  assert.doesNotMatch(page, /Saved vendor formulas/);
  const blanks = { invoiceCostCapUsd: '', cardCopyCapUsd: '5.00', dailyLimitUsd: '10.00', bigChangePercent: '30', pricingAddBefore: '', pricingMultiplier: '', pricingAddAfter: '', pricingRounding: '', pricingVendors: '' };
  const res = await post(s, '/settings', cookie, { ...BASE, ...blanks, squareLocationId: 'LOC12345' }, { csrfPage: '/settings' });
  assert.equal(res.statusCode, 303);
  assert.equal(s.app.shelf.settings.getSetting('squareLocationId'), 'LOC12345');
  assert.throws(() => s.app.shelf.settings.getSetting('invoiceCostCapUsd'), /integrity/, 'still damaged, not reset to 1.00');
  assert.throws(() => s.app.shelf.settings.getSetting('pricing'), /integrity/);
  // Typing a real value into it saves it.
  await post(s, '/settings', cookie, { ...BASE, ...blanks, squareLocationId: 'LOC12345', invoiceCostCapUsd: '4.00' }, { csrfPage: '/settings' });
  assert.equal(s.app.shelf.settings.getSetting('invoiceCostCapUsd'), '4.00');
});

test('a damaged row can be repaired with its default value', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const cookie = await adminSession(s);
  // Put unreadable rows in place: an unknown key id and a zero tag.
  const db = s.app.shelf.db;
  const keyId = 'k-unknown';
  for (const name of ['value:squareEnvironment', 'value:pricing']) {
    db.prepare('INSERT OR REPLACE INTO settings (name, key_id, nonce, ciphertext, tag, updated_at) VALUES (?, ?, zeroblob(12), x\'00\', zeroblob(16), ?)').run(name, keyId, 't');
  }
  assert.throws(() => s.app.shelf.settings.getSetting('squareEnvironment'));
  const page = (await get(s, '/settings', cookie)).body;
  assert.match(page, /<select id="squareEnvironment" name="squareEnvironment">\s*<option value="" selected>Choose<\/option>/);
  // Production is locked, so sandbox, the default, is the only valid choice. It must repair the row.
  const res = await post(s, '/settings', cookie, { ...BASE, invoiceCostCapUsd: '2.00' }, { csrfPage: '/settings' });
  assert.equal(res.statusCode, 303);
  assert.equal(s.app.shelf.settings.getSetting('squareEnvironment'), 'sandbox');
  assert.deepEqual(s.app.shelf.settings.getSetting('pricing'), { default: { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' }, vendors: [] });
  assert.deepEqual(s.app.shelf.settings.view().damaged, []);
});
