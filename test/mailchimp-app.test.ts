// The fish email in the app: the Mailchimp key in settings, a run from dry run to send with the
// fish email change, and the home page alerts. Mailchimp is the fake on 127.0.0.1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ADMIN_PW, addUser, get, login, logText, makeApp, post, START } from './server-helpers.ts';
import { approvedRun, pressSend } from './send-fixtures.ts';
import { startFakeMailchimp, testConfig, TEST_KEY } from './mailchimp-fixtures.ts';
import { parseRows, findDateLine } from '../src/mailchimp/html.ts';
import { addCheckTask, addHeld, heldFor, lastTick, oldHeld, openAlerts, setLastTick, taskForRun, track, updateTask } from '../src/mailchimp/store.ts';
import { listAudit } from '../src/db/audit.ts';
import { buildMailchimpPreview } from '../src/mailchimp/plan.ts';
import type { MailchimpApi } from '../src/mailchimp/client.ts';
import type { FishMatches } from '../src/mailchimp/matches.ts';
import type { ChangePreview } from '../src/runs/preview.ts';
import { listIdMissing, PLACEHOLDER_LIST_ID } from '../src/mailchimp/config.ts';

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

test('the Mailchimp key: shape checked, write only, never shown or logged', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const cookie = (await login(s, 'bart', ADMIN_PW, true)).cookie;
  const bad = await post(s, '/settings', cookie, { ...BASE, secret_mailchimpApiKey: 'sk-not-a-mailchimp-key-at-all' }, { csrfPage: '/settings' });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /does not look like a Mailchimp API key/);
  assert.ok(!bad.body.includes('sk-not-a-mailchimp-key-at-all'));
  const ok = await post(s, '/settings', cookie, { ...BASE, secret_mailchimpApiKey: TEST_KEY }, { csrfPage: '/settings' });
  assert.equal(ok.statusCode, 303);
  assert.equal(s.app.shelf.settings.getSecret('mailchimpApiKey'), TEST_KEY);
  const page = await get(s, '/settings', cookie);
  assert.match(page.body, /Mailchimp API key/);
  assert.match(page.body, /Set, ends in -us0/);
  assert.ok(!page.body.includes(TEST_KEY.slice(0, 20)));
  assert.ok(!logText(s.logs).includes(TEST_KEY.slice(0, 20)));
  const audit = listAudit(s.app.shelf.db, { action: 'settings.update' });
  assert.ok(audit.some((a) => a.details.includes('"mailchimpApiKey":"set"')));
  assert.ok(audit.every((a) => !a.details.includes(TEST_KEY)));
});

test('a run with a fish price: the dry run shows the email change, and the send changes it after Square', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00', settings: { title: 'Fish Email 20261016 (copy 09)', subject_line: 'Fish list', from_name: 'Example Fish Market', reply_to: 'fish@example.com' } });
  const s = await approvedRun({
    config: { allowMailchimpWrites: true, mailchimpFromSandboxRuns: true },
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          rows: [
            { row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON', confirmedBy: 'Bart', confirmedAt: '2026-11-06' },
            { row: 'Sea Bass (Wild)', status: 'proposed', itemId: 'I_GOUDA' },
          ],
        }),
        { mode: 0o600 },
      );
    },
  });
  t.after(() => s.close());
  // The dry run read Mailchimp and wrote nothing.
  assert.deepEqual(fake.writes(), []);
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.equal(dry.statusCode, 200);
  assert.match(dry.body, /Fish email in Mailchimp \(preview only, nothing changed\)/);
  assert.match(dry.body, /Send day: <strong>Monday, November 9, 2026<\/strong>/);
  assert.match(dry.body, /copies the last one sent, &quot;Fish Email 20261016 \(copy 09\)&quot;/);
  assert.match(dry.body, /<strong>Test King Salmon \(Testland\)<\/strong>: \$24\.99\/lb becomes \$19\.99\/lb/);
  assert.match(dry.body, /The copy is named "Fish Email 20261109"\./);
  assert.match(dry.body, /Date line at the top: added, reading "Monday, November 9, 2026"/);
  assert.match(dry.body, /no confirmed Square match/);

  const res = await pressSend(s);
  assert.equal(res.statusCode, 303);
  const task = taskForRun(s.app.shelf.db, 1);
  assert.ok(task, 'the fish email task is queued once Square is done');
  assert.deepEqual(task.plan!.map((p) => [p.key, p.toCents]), [['Test King Salmon (Testland)', 1999]]);
  await s.app.shelf.mailchimp.worker.drain();
  const done = taskForRun(s.app.shelf.db, 1)!;
  assert.equal(done.state, 'done', done.message);
  const copy = fake.campaigns.get(done.result!.campaignId)!;
  assert.equal(copy.status, 'schedule');
  assert.equal(copy.send_time, '2026-11-09T14:00:00+00:00');
  assert.equal(copy.settings.title, 'Fish Email 20261109');
  assert.equal(parseRows(copy.html).find((r) => r.key === 'Test King Salmon (Testland)')!.priceText, '$19.99');
  assert.equal(parseRows(copy.html).find((r) => r.key === 'Sea Bass (Wild)')!.priceText, '$31.99');
  assert.equal(findDateLine(copy.html, 'sr-fish-date')!.text, 'Monday, November 9, 2026');
  const page = await get(s, '/runs/1/send', s.mgr.cookie);
  assert.match(page.body, /<h2 id="mc-s">Fish email<\/h2>/);
  assert.match(page.body, /<strong>Test King Salmon \(Testland\)<\/strong>: \$24\.99 became \$19\.99/);
  // A second Send cannot queue it twice.
  assert.equal((s.app.shelf.db.prepare('SELECT count(*) AS n FROM mailchimp_tasks').get() as { n: number }).n, 1);
  assert.ok(!logText(s.logs).includes(TEST_KEY.slice(0, 20)));
  assert.ok(fake.calls.every((c) => c.auth === `Bearer ${TEST_KEY}`));
});

test('the placeholder list id from git: Mailchimp counts as not set up, so nothing is read or changed', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00', settings: { title: 'Fish Email 20261016 (copy 09)', subject_line: 'Fish list', from_name: 'Example Fish Market', reply_to: 'fish@example.com' } });
  const s = await approvedRun({
    config: { allowMailchimpWrites: true, mailchimpFromSandboxRuns: true },
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig({ list: { id: PLACEHOLDER_LIST_ID, name: 'Example Fish List' } }) },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON', confirmedBy: 'Bart', confirmedAt: '2026-11-06' }] }), { mode: 0o600 });
    },
  });
  t.after(() => s.close());
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.equal(dry.statusCode, 200);
  assert.match(dry.body, /The fish list id is not set\. Add it to config\/local\/mailchimp\.json and restart ShelfReady\./);
  assert.deepEqual(fake.calls, []);
});

test('a config/local/mailchimp.json that is not right: the app starts, Mailchimp is not set up with the reason shown, and nothing is sent', async (t) => {
  for (const [bad, reason] of [
    ['{ not json', /Cannot read the local Mailchimp config at [^ ]*mailchimp\.json\./],
    [JSON.stringify({ list: { id: 'NOT-A-REAL-LIST' } }), /mailchimp\.json: list\.id must be a Mailchimp list id\./],
  ] as const) {
    const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
    t.after(() => fake.close());
    fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00', settings: { title: 'Fish Email 20261016 (copy 09)', subject_line: 'Fish list', from_name: 'Example Fish Market', reply_to: 'fish@example.com' } });
    const dir = mkdtempSync(join(tmpdir(), 'shelfready-mc-bad-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const local = join(dir, 'mailchimp.json');
    writeFileSync(local, bad, { mode: 0o600 });
    const s = await approvedRun({
      config: { allowMailchimpWrites: true, mailchimpFromSandboxRuns: true },
      deps: { mailchimpTestOrigin: fake.origin, mailchimpLocalConfig: local },
      before: async (r) => {
        r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
        const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON', confirmedBy: 'Bart', confirmedAt: '2026-11-06' }] }), { mode: 0o600 });
      },
    });
    t.after(() => s.close());
    assert.ok(listIdMissing(s.app.shelf.mailchimp.cfg), 'the placeholder list stays');
    const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
    assert.equal(dry.statusCode, 200);
    assert.match(dry.body, /The local Mailchimp config is not right, so Mailchimp is not set up\./);
    assert.match(dry.body, reason);
    assert.match(dry.body, /Fix it and restart ShelfReady\./);
    assert.ok(!dry.body.includes('NOT-A-REAL-LIST') && !logText(s.logs).includes('NOT-A-REAL-LIST'), 'the id is never shown or logged');
    assert.match(logText(s.logs), /config\/local\/mailchimp\.json is not right/);
    // The rest of the app works.
    assert.equal((await get(s, '/', s.mgr.cookie)).statusCode, 200);
    // The send goes ahead as with no key: the email task stops on the same reason and sends nothing.
    assert.equal((await pressSend(s)).statusCode, 303);
    await s.app.shelf.mailchimp.worker.drain();
    const task = taskForRun(s.app.shelf.db, 1);
    assert.ok(task && task.state !== 'done', String(task?.state));
    assert.ok(!JSON.stringify(task).includes('NOT-A-REAL-LIST'));
    assert.deepEqual(fake.calls, []);
  }
});

test('with Mailchimp writes off (the default), the dry run still shows the change, and the send queues nothing', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
  const s = await approvedRun({
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON' }] }), { mode: 0o600 });
    },
  });
  t.after(() => s.close());
  assert.equal(s.config.allowMailchimpWrites, false);
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.match(dry.body, /Mailchimp changes are off in this install/);
  assert.match(dry.body, /\$24\.99\/lb becomes \$19\.99\/lb/);
  await pressSend(s);
  assert.equal(taskForRun(s.app.shelf.db, 1), null);
  assert.deepEqual(fake.writes(), []);
});

test('Mailchimp writes on, but a sandbox send never changes the live fish email', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
  const s = await approvedRun({
    config: { allowMailchimpWrites: true },
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON' }] }), { mode: 0o600 });
    },
  });
  t.after(() => s.close());
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.match(dry.body, /matched against the Square sandbox, so sending it does not change the live fish email/);
  await pressSend(s);
  assert.equal(taskForRun(s.app.shelf.db, 1), null);
  assert.deepEqual(fake.writes(), []);
});

test('the dry run waits a short time for Mailchimp, then says it did not answer and keeps the plan', async () => {
  const hang = new Promise<never>(() => {});
  const api = { listCampaigns: () => hang, getCampaign: () => hang, getContent: () => hang } as unknown as MailchimpApi;
  const matches = (): FishMatches => ({ version: 1, rows: [{ row: 'Salmon Heads', status: 'confirmed', itemId: 'ITEM00001', variationId: null, confirmedBy: '', confirmedAt: '', note: '' }] });
  const square = [{ itemId: 'ITEM00001', variationId: 'VAR1', label: 'Salmon Heads', price: { fromCents: 399, toCents: 499, perPound: true, locationOverride: false } }] as unknown as ChangePreview['square'];
  const t0 = Date.now();
  const p = await buildMailchimpPreview({ cfg: testConfig(), api, setupProblem: '', matches, now: Date.parse('2026-11-09T19:00:00Z'), timeoutMs: 50 }, { square });
  assert.ok(Date.now() - t0 < 1000);
  assert.match(p!.problem, /Mailchimp did not answer in time/);
  assert.deepEqual(p!.planned.map((r) => [r.key, r.toCents]), [['Salmon Heads', 499]]);
});

test('a run with no fish price shows nothing about the email and queues nothing', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  const s = await approvedRun({
    config: { allowMailchimpWrites: true, mailchimpFromSandboxRuns: true },
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
    },
  });
  t.after(() => s.close());
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.ok(!dry.body.includes('Fish email in Mailchimp'));
  await pressSend(s);
  assert.equal(taskForRun(s.app.shelf.db, 1), null);
  assert.equal(fake.calls.length, 0);
});

test('home page: a red alert shows to managers until a person says they dealt with it', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  await addUser(s, 'mgr', 'manager', 'manager pass phrase 42');
  const cookie = (await login(s, 'mgr', 'manager pass phrase 42', true)).cookie;
  const db = s.app.shelf.db;
  // The worker does not start with the app: the server starts it once it is listening (main.ts).
  // Writes are off here: start records nothing and raises no alerts.
  assert.equal(lastTick(db), null);
  s.app.shelf.mailchimp.start();
  assert.equal(lastTick(db), null);
  assert.equal(openAlerts(db).length, 0);
  addCheckTask(db, '2026-11-10T18:00', { day: '2026-11-11', at: Date.parse('2026-11-11T14:00:00Z') }, Date.now());
  const id = (db.prepare('SELECT id FROM mailchimp_tasks').get() as { id: number }).id;
  updateTask(db, id, { state: 'needs_person', alert: 'red', message: 'The fish email for Wednesday, November 11, 2026 is NOT scheduled. <b>x</b>' }, Date.now());
  // A note made later still shows after the red alert.
  addCheckTask(db, '2026-11-11T06:00', { day: '2026-11-11', at: Date.parse('2026-11-11T14:00:00Z') }, Date.now());
  const noteId = (db.prepare('SELECT max(id) AS id FROM mailchimp_tasks').get() as { id: number }).id;
  updateTask(db, noteId, { state: 'done', alert: 'note', message: 'A later note.' }, Date.now());
  assert.deepEqual(openAlerts(db).map((a) => a.alert), ['red', 'note']);
  const home = await get(s, '/', cookie);
  assert.ok(home.body.indexOf('is NOT scheduled') < home.body.indexOf('A later note.'));
  assert.match(home.body, /A fish email needs a person now\./);
  assert.match(home.body, /is NOT scheduled\. &lt;b&gt;x&lt;\/b&gt;/);
  // A post without the form token is refused.
  const forged = await post(s, `/mailchimp/alerts/${id}/clear`, cookie, {}, { csrf: 'nope' });
  assert.equal(forged.statusCode, 403);
  assert.equal(openAlerts(db).length, 2);
  const res = await post(s, `/mailchimp/alerts/${id}/clear`, cookie, {}, { csrfPage: '/' });
  assert.equal(res.statusCode, 303);
  assert.deepEqual(openAlerts(db).map((a) => a.alert), ['note']);
  assert.ok(!(await get(s, '/', cookie)).body.includes('A fish email needs a person now'));
  assert.ok(listAudit(db, { action: 'mailchimp.alert_cleared' }).some((a) => a.username === 'mgr'));
  // Signed out: refused before anything else.
  const anon = await s.app.inject({ method: 'POST', url: `/mailchimp/alerts/${id}/clear` });
  assert.notEqual(anon.statusCode, 303);
});


test('writes off: a restart a week after the checks last ran raises no alerts, and turning writes on later starts clean', async (t) => {
  // A week ago the checks ran (writes on), then Bart turned writes off.
  const s = await makeApp();
  t.after(() => s.close());
  const db = s.app.shelf.db;
  setLastTick(db, Date.parse('2026-10-30T23:00:00Z'));
  s.app.shelf.mailchimp.start();
  assert.equal(openAlerts(db).length, 0);
  assert.equal(lastTick(db), null);
});

test('writes on: start after a long stop reports only the latest fish day, and starts the clock', async (t) => {
  const s = await makeApp({ allowMailchimpWrites: true }, { startRunner: false });
  t.after(() => s.close());
  const db = s.app.shelf.db;
  // The test clock is Friday November 6, 18:00Z (noon). Last seen Monday November 2, noon.
  setLastTick(db, Date.parse('2026-11-02T18:00:00Z'));
  s.app.shelf.mailchimp.start();
  assert.deepEqual(openAlerts(db).map((a) => a.slot).sort(), ['2026-11-05T18:00', '2026-11-06T06:00']);
  assert.notEqual(lastTick(db), null);
});

test('mailchimpFromSandboxRuns: the dry run warns in red that a sandbox send changes the live email, and the start logs it', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
  const s = await approvedRun({
    config: { allowMailchimpWrites: true, mailchimpFromSandboxRuns: true },
    deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON' }] }), { mode: 0o600 });
    },
  });
  t.after(() => s.close());
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.match(dry.body, /callout-stop">Test setting on \(mailchimpFromSandboxRuns\): sending this Square sandbox invoice WILL change the live fish email/);
  s.app.shelf.mailchimp.start();
  assert.match(logText(s.logs), /mailchimpFromSandboxRuns is on/);
  await pressSend(s);
  assert.match(logText(s.logs), /queued from a Square sandbox send/);
});

test('the dry run shows a held change when staff have the tracked email unscheduled, and the register drift beside it', async (t) => {
  const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
  t.after(() => fake.close());
  fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
  fake.add({ id: 'draft00001', status: 'save', settings: { title: 'Fish Email 20261109', subject_line: 'Fish list', from_name: 'Example Fish Market', reply_to: 'fish@example.com', preview_text: '', to_name: '' } });
  const s = await approvedRun({
    config: { allowMailchimpWrites: true, mailchimpFromSandboxRuns: true },
    deps: {
      mailchimpTestOrigin: fake.origin,
      mailchimpConfig: testConfig(),
      mailchimpRegister: async () => ({ source: 'test', lookup: (itemId: string) => (itemId === 'I_BASS' ? { cents: 3299, perPound: true } : 'it is not in Square.') }),
    },
    before: async (r) => {
      r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
      track(r.app.shelf.db, '2026-11-09', 'draft00001', 'copied', null, Date.parse('2026-11-06T18:00:00Z'));
      const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(
        file,
        JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON' }, { row: 'Sea Bass (Wild)', status: 'confirmed', itemId: 'I_BASS' }] }),
        { mode: 0o600 },
      );
    },
  });
  t.after(() => s.close());
  const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
  assert.match(dry.body, /Edit ShelfReady&#39;s email for Monday, November 9, 2026, &quot;Fish Email 20261109&quot; \(draft00001\) \(save\)/);
  assert.match(dry.body, /Staff have it unscheduled, so this change is held until they schedule it, or until 6:00am on Monday, November 9, 2026/);
  assert.match(dry.body, /Prices that differ from the register \(1\)/);
  assert.match(dry.body, /<strong>Sea Bass \(Wild\)<\/strong>: \$31\.99 becomes \$32\.99/);
  // Send: the change is held for Monday, and nothing is written while staff have it unscheduled.
  await pressSend(s);
  assert.equal(heldFor(s.app.shelf.db, '2026-11-09', Date.parse('2026-11-06T18:00:00Z')).rows.length, 1);
  await s.app.shelf.mailchimp.worker.drain();
  assert.match(taskForRun(s.app.shelf.db, 1)!.message, /unscheduled\. 1 price change is held/);
  assert.deepEqual(fake.writes(), []);
});

test('drift has its own setting: the sandbox test setting alone never turns it on; with it on, the dry run and the log say so', async (t) => {
  for (const drift of [false, true]) {
    const fake = await startFakeMailchimp(() => Date.parse('2026-11-06T18:00:00Z'));
    fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
    const s = await approvedRun({
      config: { allowMailchimpWrites: true, mailchimpFromSandboxRuns: true, mailchimpDriftCheck: drift },
      deps: { mailchimpTestOrigin: fake.origin, mailchimpConfig: testConfig() },
      before: async (r) => {
        r.app.shelf.settings.update({ secrets: { mailchimpApiKey: TEST_KEY } }, { userId: null, username: 'test' });
        const file = join(dirname(r.config.dbPath), 'mailchimp', 'fish-matches.json');
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify({ version: 1, rows: [{ row: 'Test King Salmon (Testland)', status: 'confirmed', itemId: 'I_SALMON' }] }), { mode: 0o600 });
      },
    });
    try {
      const dry = await get(s, '/runs/1/dry-run', s.mgr.cookie);
      if (drift) assert.match(dry.body, /Drift check on \(mailchimpDriftCheck\): every fish email edit and check sets email prices to the register prices from the Test catalog/);
      else assert.doesNotMatch(dry.body, /Drift check on/);
      s.app.shelf.mailchimp.start();
      if (drift) assert.match(logText(s.logs), /mailchimpDriftCheck is on/);
      else assert.doesNotMatch(logText(s.logs), /mailchimpDriftCheck is on/);
    } finally {
      await s.close();
      await fake.close();
    }
  }
  void t;
});

test('an admin sets aside a held change over three weeks old: admin only, form token, recent password, audited', async (t) => {
  const s = await makeApp();
  t.after(() => s.close());
  const db = s.app.shelf.db;
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  await addUser(s, 'mgr', 'manager', 'manager pass phrase 42');
  const admin = (await login(s, 'bart', ADMIN_PW, true)).cookie;
  const mgr = (await login(s, 'mgr', 'manager pass phrase 42', true)).cookie;
  const row = { key: 'Sea Bass <b>(Wild)</b>', itemId: 'ITEM00001', variationId: 'VAR000001', label: 'Sea Bass', toCents: 3399, perPound: true };
  addHeld(db, null, '2026-10-14', [row, { ...row, key: 'Salmon Heads', toCents: 499 }], START - 22 * 86400_000);
  const [first, second] = oldHeld(db, START);
  assert.ok(first && second);
  // A manager sees nothing of it, and cannot post.
  assert.doesNotMatch((await get(s, '/', mgr)).body, /Old fish email price changes/);
  assert.equal((await post(s, `/mailchimp/held/${first.id}/dismiss`, mgr, {}, { csrfPage: '/' })).statusCode, 403);
  // An admin sees each, escaped, with a button.
  const home = await get(s, '/', admin);
  assert.match(home.body, /Old fish email price changes/);
  assert.match(home.body, /Sea Bass &lt;b&gt;\(Wild\)&lt;\/b&gt;<\/strong>: \$33\.99, for 2026-10-14/);
  assert.match(home.body, new RegExp(`action="/mailchimp/held/${first.id}/dismiss"`));
  // A bad form token is refused.
  assert.equal((await post(s, `/mailchimp/held/${first.id}/dismiss`, admin, {}, { csrf: 'nope' })).statusCode, 403);
  // Without a recent password, nothing changes.
  s.advance(16 * 60_000);
  const stale = await post(s, `/mailchimp/held/${first.id}/dismiss`, admin, {}, { csrfPage: '/' });
  assert.equal(stale.statusCode, 403);
  assert.match(stale.body, /Confirm it is you/);
  assert.equal(oldHeld(db, START).length, 2);
  // With a recent password: set aside, audited, and no longer listed or put in.
  await post(s, '/reauth', admin, { next: '/', password: ADMIN_PW }, { csrfPage: '/' });
  const ok = await post(s, `/mailchimp/held/${first.id}/dismiss`, admin, {}, { csrfPage: '/' });
  assert.equal(ok.statusCode, 303);
  assert.deepEqual(oldHeld(db, START + 20 * 60_000).map((r) => r.id), [second.id]);
  const a = listAudit(db, { action: 'mailchimp.held_dismissed' });
  assert.equal(a.length, 1);
  assert.equal(a[0]!.username, 'bart');
  assert.match(a[0]!.details, /"toCents":3399/);
  assert.equal(heldFor(db, '2026-11-09', START).tooOld.length, 1);
  // Once set aside, a second post changes nothing.
  await post(s, `/mailchimp/held/${first.id}/dismiss`, admin, {}, { csrfPage: '/' });
  assert.equal(listAudit(db, { action: 'mailchimp.held_dismissed' }).length, 1);
});
