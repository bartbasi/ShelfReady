import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PW, MANAGER_PW, addUser, get, login, makeApp, post } from './server-helpers.ts';
import { makeRunApp, signIn, testInvoice, uploadPhoto } from './runs-fixtures.ts';
import { listAudit } from '../src/db/audit.ts';
import { checkSetting, defaultSettings } from '../src/settings/schema.ts';
import { makeConfig } from '../src/server/config.ts';

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

const OPTS = { allowSquareProduction: false };

test('the defaults: card copy $5, daily limit $10, big change 30 percent', () => {
  const d = defaultSettings();
  assert.equal(d.cardCopyCapUsd, '5.00');
  assert.equal(d.dailyLimitUsd, '10.00');
  assert.equal(d.bigChangePercent, '30');
});

test('the three settings are checked for sane ranges and tidied', () => {
  assert.equal(checkSetting('cardCopyCapUsd', ' $2.5 ', OPTS), '2.50');
  assert.equal(checkSetting('cardCopyCapUsd', '100', OPTS), '100.00');
  for (const bad of ['0', '0.00', '100.01', '-1', 'lots', '', '1e3', '1,00']) assert.throws(() => checkSetting('cardCopyCapUsd', bad, OPTS), /Enter an amount|Enter a/, `cardCopyCapUsd ${bad}`);
  assert.equal(checkSetting('dailyLimitUsd', '0', OPTS), '0.00', 'zero asks an admin every time');
  assert.equal(checkSetting('dailyLimitUsd', '1000', OPTS), '1000.00');
  for (const bad of ['1000.01', '-1', 'ten', '', '9999']) assert.throws(() => checkSetting('dailyLimitUsd', bad, OPTS), /Enter an amount|Enter a/, `dailyLimitUsd ${bad}`);
  assert.equal(checkSetting('bigChangePercent', ' 45 ', OPTS), '45');
  assert.equal(checkSetting('bigChangePercent', '030', OPTS), '30');
  assert.equal(checkSetting('bigChangePercent', '5', OPTS), '5');
  assert.equal(checkSetting('bigChangePercent', '50', OPTS), '50', 'the level where the scales ask too is the most');
  // Over 50 is refused. At 100 or more no price drop could ever need a tick, since no price falls by
  // more than 100 percent, which would switch Bart's rule off.
  for (const bad of ['51', '60', '99', '100', '101', '200', '1000', '0', '4', '-5', '30.5', '30%', 'half', '']) {
    assert.throws(() => checkSetting('bigChangePercent', bad, OPTS), /whole number of percent from 5 to 50/, `bigChangePercent ${bad}`);
  }
});

test('the settings page shows the three fields to an admin, with their saved values, and not to a manager', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const admin = (await login(s, 'bart', ADMIN_PW, true)).cookie;
  const page = (await get(s, '/settings', admin)).body;
  assert.match(page, /<label for="cardCopyCapUsd">Card copy cap per invoice, US dollars<\/label><input id="cardCopyCapUsd" name="cardCopyCapUsd" value="5\.00"/);
  assert.match(page, /<label for="dailyLimitUsd">Daily limit, US dollars<\/label><input id="dailyLimitUsd" name="dailyLimitUsd" value="10\.00"/);
  assert.match(page, /<label for="bigChangePercent">A price moving more than this percent needs its own tick<\/label><input id="bigChangePercent" name="bigChangePercent" value="30"/);
  const mgr = (await login(s, 'mgr', MANAGER_PW)).cookie;
  const res = await get(s, '/settings', mgr);
  assert.equal(res.statusCode, 403);
  assert.doesNotMatch(res.body, /dailyLimitUsd|bigChangePercent|cardCopyCapUsd/);
});

test('saving changes them, audits the change, and bad values are refused with nothing saved', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW, true)).cookie;
  const ok = await post(s, '/settings', cookie, { ...BASE, cardCopyCapUsd: '2.50', dailyLimitUsd: '20', bigChangePercent: '45' }, { csrfPage: '/settings' });
  assert.equal(ok.statusCode, 303);
  assert.equal(s.app.shelf.settings.getSetting('cardCopyCapUsd'), '2.50');
  assert.equal(s.app.shelf.settings.getSetting('dailyLimitUsd'), '20.00');
  assert.equal(s.app.shelf.settings.getSetting('bigChangePercent'), '45');
  const entries = listAudit(s.app.shelf.db).filter((e) => e.action.startsWith('settings'));
  assert.equal(entries.length, 1);
  const details = JSON.parse(entries[0]!.details) as { values: Record<string, { from: string; to: string }> };
  assert.deepEqual(details.values.cardCopyCapUsd, { from: '5.00', to: '2.50' });
  assert.deepEqual(details.values.dailyLimitUsd, { from: '10.00', to: '20.00' });
  assert.deepEqual(details.values.bigChangePercent, { from: '30', to: '45' });
  // Refused, in plain words, and the old values stay.
  for (const [field, value, message] of [
    ['cardCopyCapUsd', '0', /Enter an amount from 0\.01 to 100\.00/],
    ['dailyLimitUsd', '5000', /Enter an amount from 0\.00 to 1000\.00/],
    ['bigChangePercent', '51', /whole number of percent from 5 to 50/],
    ['bigChangePercent', '100', /whole number of percent from 5 to 50/],
    ['bigChangePercent', 'lots', /whole number of percent from 5 to 50/],
  ] as const) {
    const bad = await post(s, '/settings', cookie, { ...BASE, cardCopyCapUsd: '2.50', dailyLimitUsd: '20.00', bigChangePercent: '45', [field]: value }, { csrfPage: '/settings' });
    assert.equal(bad.statusCode, 400, field);
    assert.match(bad.body, message, field);
    assert.match(bad.body, /Not saved\./);
  }
  assert.equal(s.app.shelf.settings.getSetting('dailyLimitUsd'), '20.00');
  assert.equal(s.app.shelf.settings.getSetting('bigChangePercent'), '45');
  // A manager cannot post them.
  await addUser(s, 'mgr', 'manager', MANAGER_PW);
  const mgr = (await login(s, 'mgr', MANAGER_PW)).cookie;
  const denied = await post(s, '/settings', mgr, { ...BASE, bigChangePercent: '99' }, { csrfPage: '/' });
  assert.equal(denied.statusCode, 403);
  assert.equal(s.app.shelf.settings.getSetting('bigChangePercent'), '45');
});

test('the config no longer takes them: one place to change each', () => {
  assert.throws(() => makeConfig({ dailyReadingCapUsd: 3 } as never), /dailyReadingCapUsd is now an admin setting/);
  assert.throws(() => makeConfig({ bigChangePercent: 50 } as never), /bigChangePercent is now an admin setting/);
  const c = makeConfig({}) as unknown as Record<string, unknown>;
  assert.equal('dailyReadingCapUsd' in c, false);
  assert.equal('bigChangePercent' in c, false);
});

test('a change on the settings page applies to the next page view and the next reading, with no restart', async (t) => {
  const inv = testInvoice();
  // A 33.4 percent rise: $5.99 to $7.99.
  inv.lines[1] = { ...inv.lines[1]!, unit_price: '39.00', extension: '78.00' };
  inv.total = '213.00';
  const s = await makeRunApp({ inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  const body = async () => (await get(s, '/runs/1', mgr.cookie)).body;
  // The default 30 percent: the 33 percent rise needs a tick.
  assert.match(await body(), /price moves more than 30%\./);
  s.app.shelf.settings.update({ values: { bigChangePercent: '50' } }, { userId: null, username: 'test' });
  assert.doesNotMatch(await body(), /price moves more than/, 'a 33 percent rise is under a 50 percent limit');
  s.app.shelf.settings.update({ values: { bigChangePercent: '20' } }, { userId: null, username: 'test' });
  assert.match(await body(), /price moves more than 20%\./);
});

test('the daily limit setting stops a reading for an admin, and raising it lets the next one through', async (t) => {
  const s = await makeRunApp({ settings: { dailyLimitUsd: '0.00' } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  const state = () => (s.app.shelf.db.prepare('SELECT state FROM runs WHERE id = 1').get() as { state: string }).state;
  assert.equal(state(), 'needs_approval');
  assert.match((await get(s, '/runs/1', mgr.cookie)).body, /daily limit of \$0\.00/);
  s.app.shelf.settings.update({ values: { dailyLimitUsd: '10.00' } }, { userId: null, username: 'test' });
  await uploadPhoto(s, mgr, 2);
  await s.app.shelf.runner.drain();
  const second = (s.app.shelf.db.prepare('SELECT state FROM runs WHERE id = 2').get() as { state: string }).state;
  assert.notEqual(second, 'needs_approval', 'the new limit applies without a restart');
});

test('the daily limit must hold one reading at the cap per invoice, or be 0 to always ask', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW, true)).cookie;
  // A limit under the cap: every reading would wait.
  const low = await post(s, '/settings', cookie, { ...BASE, dailyLimitUsd: '0.50' }, { csrfPage: '/settings' });
  assert.equal(low.statusCode, 400);
  assert.match(low.body, /Not saved\. The daily limit, \$0\.50, is less than the reading cost cap per invoice, \$1\.00\. Every reading would wait for an admin\. Use 0\.00 for the daily limit if that is what you want\./);
  // The cap raised over the limit: the same, said from the cap's side.
  const high = await post(s, '/settings', cookie, { ...BASE, invoiceCostCapUsd: '12.00' }, { csrfPage: '/settings' });
  assert.equal(high.statusCode, 400);
  assert.match(high.body, /The reading cost cap per invoice, \$12\.00, is more than the daily limit, \$10\.00\./);
  assert.equal(s.app.shelf.settings.getSetting('dailyLimitUsd'), '10.00');
  assert.equal(s.app.shelf.settings.getSetting('invoiceCostCapUsd'), '1.00');
  // Equal is fine, 0 means always ask, and both may change in one save.
  for (const [limit, cap] of [['1.00', '1.00'], ['0.00', '1.00'], ['20.00', '15.00']] as const) {
    const ok = await post(s, '/settings', cookie, { ...BASE, dailyLimitUsd: limit, invoiceCostCapUsd: cap }, { csrfPage: '/settings' });
    assert.equal(ok.statusCode, 303, `${limit} and ${cap}`);
  }
  // Either one alone is checked against the saved other.
  assert.throws(() => s.app.shelf.settings.update({ values: { dailyLimitUsd: '14.99' } }, { userId: null, username: 'test' }), /less than the reading cost cap/);
  assert.throws(() => s.app.shelf.settings.update({ values: { invoiceCostCapUsd: '20.01' } }, { userId: null, username: 'test' }), /more than the daily limit/);
});

test('the hourly limit for old invoices is from 1 to 1000', () => {
  for (const bad of [0, 1001, 2.5]) assert.throws(() => makeConfig({ uploads: { historyPerUserPerHour: bad } } as never), /historyPerUserPerHour must be a whole number from 1 to 1000/, String(bad));
  assert.equal(makeConfig({ uploads: { historyPerUserPerHour: 1000 } } as never).uploads.historyPerUserPerHour, 1000);
});
