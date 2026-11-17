// The fish email worker against a fake Mailchimp on 127.0.0.1: every write path, failures after
// the unschedule, lost answers, two scheduled emails, a restart, and the week the clocks change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from '../src/db/db.ts';
import { listAudit } from '../src/db/audit.ts';
import { createMailchimpClient } from '../src/mailchimp/client.ts';
import { editEmail, findDateLine, parseRows } from '../src/mailchimp/html.ts';
import { nextFishSend } from '../src/mailchimp/days.ts';
import { addCheckTask, addHeld, addMissedCheck, addRunTask, heldFor, track, trackedFor, clearAlert, copiesFor, getTask, openAlerts, setLastTick, updateTask, type MailchimpTask } from '../src/mailchimp/store.ts';
import { baseTitle, createMailchimpWorker, LOOK_AGAIN_MS, type MailchimpWorker } from '../src/mailchimp/worker.ts';
import { confirmedRows } from '../src/mailchimp/service.ts';
import type { SquareReport } from '../src/runs/square-send.ts';
import type { PlannedRow } from '../src/mailchimp/plan.ts';
import type { FishMatches } from '../src/mailchimp/matches.ts';
import type { RegisterBook } from '../src/mailchimp/register.ts';
import { FIXTURE_HTML, LIST, startFakeMailchimp, testConfig, TEST_KEY, type FakeMailchimp } from './mailchimp-fixtures.ts';
import type { MailchimpConfig } from '../src/mailchimp/config.ts';

const Z = (s: string): number => Date.parse(s);
const cfg = testConfig();

interface Setup {
  /** This setup's own config, so a test may change it. */
  cfg: MailchimpConfig;
  db: Db;
  fake: FakeMailchimp;
  worker: MailchimpWorker;
  clock: { t: number };
  logs: string[];
  runId: number;
  done(): Promise<void>;
}

async function setup(at: string, key: string | null = TEST_KEY, extra: { matches?: () => FishMatches; register?: () => Promise<RegisterBook | null> } = {}): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-mc-'));
  const db = openDatabase(join(dir, 'test.sqlite3'));
  const clock = { t: Z(at) };
  const now = (): number => clock.t;
  const fake = await startFakeMailchimp(now);
  const logs: string[] = [];
  const ownCfg = testConfig();
  const worker = createMailchimpWorker({
    db,
    cfg: ownCfg,
    now,
    auto: false,
    api: () => createMailchimpClient({ key: () => key ?? undefined, testOrigin: fake.origin, now, env: {}, execArgv: [], allowWrites: true }),
    log: { info: (o, m) => logs.push(JSON.stringify({ o, m })), error: (o, m) => logs.push(JSON.stringify({ o, m })) },
    ...extra,
  });
  db.prepare("INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES (1, 'tester', 'manager', 'x', 'x', 'x')").run();
  const runId = Number(db.prepare("INSERT INTO runs (state, created_by, created_by_name, created_at, updated_at) VALUES ('sending', 1, 'tester', 0, 0)").run().lastInsertRowid);
  return {
    cfg: ownCfg,
    db,
    fake,
    worker,
    clock,
    logs,
    runId,
    async done() {
      await worker.stop();
      await fake.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const SENT_MON = { id: 'sent000001', status: 'sent', send_time: '2026-11-09T14:00:00+00:00', settings: { title: 'Fish Email 20261016 (copy 10)', subject_line: 'Fish list 🐟', from_name: 'Example Fish Market', reply_to: 'fish@example.com', preview_text: 'Order by 7pm', to_name: '*|FNAME|*' } };
const WED = '2026-11-11T14:00:00+00:00';

function plan(rows: Array<[string, number, boolean]>): PlannedRow[] {
  return rows.map(([key, toCents, perPound]) => ({ key, itemId: 'ITEM00001', variationId: `VAR${key.length}`, label: key, toCents, perPound }));
}

/** An invoice send: its prices held for the fish day, and a run task to put them in. */
function queueRun(s: Setup, rows: PlannedRow[], send: { day: string; at: number }): number {
  addHeld(s.db, s.runId, send.day, rows, s.clock.t);
  return addRunTask(s.db, s.runId, rows, send, s.clock.t);
}

function lastTask(s: Setup): MailchimpTask {
  const id = (s.db.prepare('SELECT max(id) AS id FROM mailchimp_tasks').get() as { id: number }).id;
  return getTask(s.db, id)!;
}

function price(html: string, key: string): string {
  return parseRows(html).find((r) => r.key === key)!.priceText;
}

test('evening check with nothing scheduled: copies the last sent email, names it, dates it, keeps prices, schedules it', async () => {
  // Tuesday November 10, 6:00pm Chicago.
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sent000000', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
    s.fake.add({ id: 'pause00001', status: 'paused', send_time: '2026-10-16T13:00:00+00:00', settings: { title: 'Fish Email 20261012 (copy 02)', subject_line: 's', from_name: 'f', reply_to: 'r' } });
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.kind, 'check');
    assert.equal(t.slot, '2026-11-10T18:00');
    assert.equal(t.state, 'done', t.message);
    assert.equal(t.alert, 'note');
    assert.match(t.message, /copied the last fish email and scheduled it for Wednesday, November 11, 2026, 8:00am.*prices kept/);
    const copy = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(copy.status, 'schedule');
    assert.equal(copy.send_time, WED);
    assert.equal(copy.settings.title, 'Fish Email 20261111');
    assert.equal(copy.settings.subject_line, 'Fish list 🐟');
    // Preview text and to-name go back as read: the PATCH leaves nothing out.
    assert.equal(copy.settings.preview_text, 'Order by 7pm');
    assert.equal(copy.settings.to_name, '*|FNAME|*');
    assert.equal(findDateLine(copy.html, cfg.dateLine.class)!.text, 'Wednesday, November 11, 2026');
    const before = parseRows(s.fake.campaigns.get('sent000001')!.html).map((r) => r.priceText);
    assert.deepEqual(parseRows(copy.html).map((r) => r.priceText), before);
    assert.deepEqual(s.fake.writes(), ['replicate sent000001', `patch ${copy.id}`, `put ${copy.id}`, `schedule ${copy.id}`]);
    assert.equal(s.fake.campaigns.get('pause00001')!.status, 'paused');
    // Logged in the audit log.
    const actions = listAudit(s.db).map((a) => a.action);
    for (const a of ['mailchimp.copy', 'mailchimp.edit', 'mailchimp.schedule', 'mailchimp.check.done']) assert.ok(actions.includes(a), a);
    // The same slot never runs twice.
    s.clock.t += 60_000;
    s.worker.tick();
    await s.worker.drain();
    assert.equal(lastTask(s).id, t.id);
    // The 6am check on Wednesday finds it scheduled and right: nothing is written.
    const writes = s.fake.writes().length;
    s.clock.t = Z('2026-11-11T12:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const morning = lastTask(s);
    assert.equal(morning.slot, '2026-11-11T06:00');
    assert.equal(morning.state, 'done');
    assert.equal(morning.alert, '');
    assert.equal(s.fake.writes().length, writes);
    assert.ok(s.logs.every((l) => !l.includes(TEST_KEY)));
  } finally {
    await s.done();
  }
});

test('a run edits the one scheduled email: unschedule, name, prices, date line, schedule again at its own time', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED, settings: { ...SENT_MON.settings, title: 'Fish Email 20261016 (copy 11)' } });
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true], ['Littlenecks', 699, false], ['Crab Meat (1 lb can)', 4199, false], ['Test Atlantic Salmon', 1899, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    const c = s.fake.campaigns.get('sched00001')!;
    assert.equal(c.status, 'schedule');
    assert.equal(c.send_time, WED);
    assert.equal(c.settings.title, 'Fish Email 20261111');
    assert.equal(c.settings.subject_line, SENT_MON.settings.subject_line);
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$33.99');
    assert.equal(price(c.html, 'Crab Meat (1 lb can)'), '$41.99');
    assert.equal(price(c.html, 'Sea Bass (Farmed)'), '$29.99');
    assert.equal(price(c.html, 'Littlenecks'), '$5.99');
    assert.deepEqual(t.result!.changes.map((x) => [x.key, x.from, x.to]), [['Sea Bass (Wild)', '$31.99', '$33.99'], ['Crab Meat (1 lb can)', '$39.99', '$41.99']]);
    assert.deepEqual(t.result!.notChanged.map((x) => x.key), ['Littlenecks']);
    assert.deepEqual(t.result!.title, { from: 'Fish Email 20261016 (copy 11)', to: 'Fish Email 20261111' });
    // A row it could not change makes the note a warning, so someone looks.
    assert.equal(t.alert, 'warn');
    assert.deepEqual(s.fake.writes(), ['unschedule sched00001', 'patch sched00001', 'put sched00001', 'schedule sched00001']);
    assert.ok(listAudit(s.db).some((a) => a.action === 'mailchimp.edit' && a.run_id === s.runId));
  } finally {
    await s.done();
  }
});

test('a unit that disagrees with Square is never changed', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    queueRun(s, plan([['Sea Bass (Wild)', 3399, false], ["Example's Fish Stock (16 oz)", 1099, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(t.result!.changes.length, 0);
    assert.deepEqual(t.result!.notChanged.map((x) => x.key).sort(), ["Example's Fish Stock (16 oz)", 'Sea Bass (Wild)']);
    const copy = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(price(copy.html, 'Sea Bass (Wild)'), '$31.99');
  } finally {
    await s.done();
  }
});

test('two scheduled fish emails: stop, change nothing, and say so', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    s.fake.add({ id: 'sched00002', status: 'schedule', send_time: '2026-11-13T14:00:00+00:00' });
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'needs_person');
    assert.equal(t.alert, 'red');
    assert.match(t.message, /More than one fish email is scheduled/);
    assert.deepEqual(s.fake.writes(), []);
    assert.equal(openAlerts(s.db)[0]!.id, t.id);
  } finally {
    await s.done();
  }
});

test('the unschedule fails: nothing changes, the email goes out as it was', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    s.fake.fail.unschedule = ['refuse', 'refuse'];
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'stopped');
    assert.equal(t.alert, 'warn');
    assert.match(t.message, /could not unschedule/);
    const c = s.fake.campaigns.get('sched00001')!;
    assert.equal(c.status, 'schedule');
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$31.99');
    assert.deepEqual(s.fake.writes(), ['unschedule sched00001', 'unschedule sched00001']);
  } finally {
    await s.done();
  }
});

test('the schedule fails after the unschedule: tried once more, then a red alert', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    s.fake.fail.schedule = ['error500', 'refuse'];
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'needs_person');
    assert.equal(t.alert, 'red');
    assert.match(t.message, /is NOT scheduled\. ShelfReady tried twice/);
    assert.equal(s.fake.campaigns.get('sched00001')!.status, 'save');
    assert.equal(s.fake.writes().filter((w) => w.startsWith('schedule')).length, 2);
    assert.ok(listAudit(s.db).some((a) => a.action === 'mailchimp.schedule_failed'));
  } finally {
    await s.done();
  }
});

test('the schedule fails once, then works on the second try', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    s.fake.fail.schedule = ['refuse'];
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    assert.equal(lastTask(s).state, 'done');
    assert.equal(s.fake.campaigns.get('sched00001')!.status, 'schedule');
  } finally {
    await s.done();
  }
});

test('the edit fails after the unschedule: the email is still scheduled, with a red alert (Bart, November 9)', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED, settings: { ...SENT_MON.settings, title: 'Fish Email 20261111' } });
    s.fake.fail.put = ['refuse'];
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'needs_person');
    assert.equal(t.alert, 'red');
    assert.match(t.message, /is scheduled for Wednesday, November 11, 2026, 8:00am, but its prices, name or date line did not change.*Fix it by hand/);
    assert.equal(s.fake.campaigns.get('sched00001')!.status, 'schedule');
    assert.equal(s.fake.campaigns.get('sched00001')!.send_time, WED);
  } finally {
    await s.done();
  }
});

test('lost answers: schedule, unschedule and content are read back, not repeated blindly', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    s.fake.fail.unschedule = ['lose'];
    s.fake.fail.put = ['lose'];
    s.fake.fail.schedule = ['lose'];
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    const c = s.fake.campaigns.get('sched00001')!;
    assert.equal(c.status, 'schedule');
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$33.99');
    // Each landed the first time, so each was sent once.
    assert.deepEqual(s.fake.writes(), ['unschedule sched00001', 'patch sched00001', 'put sched00001', 'schedule sched00001']);
  } finally {
    await s.done();
  }
});

test('a copy whose answer was lost after it was made is found, and never made twice', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.fail.replicate = ['lose'];
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    const copies = [...s.fake.campaigns.values()].filter((c) => c.id.startsWith('copy'));
    assert.equal(copies.length, 1);
    assert.equal(copies[0]!.status, 'schedule');
    assert.equal(s.fake.writes().filter((w) => w.startsWith('replicate')).length, 1);
    assert.equal(copiesFor(s.db, t.id)[0]!.state, 'made');
    assert.ok(listAudit(s.db).some((a) => a.action === 'mailchimp.copy_found'));
    // Mailchimp numbers it from the source's own number: "(copy 10)" made "(copy 11)", and the
    // search still found it.
    assert.equal(s.fake.calls.filter((c) => c.name === 'replicate').length, 1);
  } finally {
    await s.done();
  }
});

test('a copy that was never made: looked for twice, two minutes apart, then made once', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.fail.replicate = ['drop'];
    s.worker.tick();
    await s.worker.drain();
    let t = lastTask(s);
    assert.equal(t.state, 'queued');
    assert.match(t.message, /looks again in two minutes/);
    assert.equal(s.fake.writes().filter((w) => w.startsWith('replicate')).length, 1);
    s.clock.t += LOOK_AGAIN_MS;
    await s.worker.drain();
    t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.deepEqual(copiesFor(s.db, t.id).map((c) => c.state), ['not_made', 'made']);
    assert.equal([...s.fake.campaigns.values()].filter((c) => c.id.startsWith('copy')).length, 1);
  } finally {
    await s.done();
  }
});

test('two drafts that both look like the lost copy: a person decides', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.fail.replicate = ['lose'];
    // A second draft named like a copy, with the same HTML, made just now by someone else.
    s.fake.add({ id: 'draft00009', status: 'save', create_time: new Date(s.clock.t).toISOString().replace(/\.\d{3}Z$/, '+00:00'), settings: { ...SENT_MON.settings, title: 'Fish Email 20261016 (copy 77)' } });
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'needs_person');
    assert.equal(t.alert, 'red');
    assert.deepEqual(s.fake.writes(), ['replicate sent000001']);
  } finally {
    await s.done();
  }
});

test('a restart after the unschedule carries on and schedules it again', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    const c = s.fake.add({ id: 'sched00001', status: 'save', send_time: '' });
    const id = queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    // As if ShelfReady stopped right after asking Mailchimp to unschedule it.
    updateTask(s.db, id, { state: 'running', progress: { day: '2026-11-11', sendAt: Z(WED), scheduleAt: Z(WED), mode: 'edit', targetId: 'sched00001', unscheduling: true, unscheduled: true } }, s.clock.t);
    s.worker.recover();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(c.status, 'schedule');
    assert.equal(c.send_time, WED);
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$33.99');
  } finally {
    await s.done();
  }
});

test('an email staff unscheduled while ShelfReady worked on it: changes held, nothing written, no alert', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add({ id: 'sched00001', status: 'save', send_time: '' });
    const id = queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    updateTask(s.db, id, { progress: { day: '2026-11-11', sendAt: Z(WED), scheduleAt: Z(WED), mode: 'edit', targetId: 'sched00001' } }, s.clock.t);
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done');
    assert.equal(t.alert, '');
    assert.match(t.message, /Staff unscheduled .*held until they schedule it, or until 6:00am/);
    assert.deepEqual(s.fake.writes(), []);
    assert.equal(heldFor(s.db, '2026-11-11', s.clock.t).rows.length, 1);
  } finally {
    await s.done();
  }
});

test('the week the clocks change: Saturday evening schedules Monday at 14:00Z with Monday on top', async () => {
  // Saturday October 31, 2026, 7:00pm CDT. The clocks go back that night.
  const s = await setup('2026-11-01T00:00:00Z');
  try {
    s.fake.add({ ...SENT_MON, id: 'sent000030', send_time: '2026-10-30T13:00:00+00:00' });
    queueRun(s, plan([['Salmon Heads', 499, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    const copy = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(copy.send_time, '2026-11-02T14:00:00+00:00');
    assert.equal(copy.settings.title, 'Fish Email 20261102');
    assert.equal(findDateLine(copy.html, cfg.dateLine.class)!.text, 'Monday, November 2, 2026');
    assert.equal(price(copy.html, 'Salmon Heads'), '$4.99');
  } finally {
    await s.done();
  }
});

test('no key: a check stops with a red alert and nothing is sent; Mailchimp unreachable is tried again later', async () => {
  const s = await setup('2026-11-11T00:00:00Z', null);
  try {
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'stopped', t.message);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /No Mailchimp API key/);
    assert.equal(s.fake.calls.length, 0);
  } finally {
    await s.done();
  }
  const s2 = await setup('2026-11-11T00:00:00Z');
  try {
    s2.fake.add(SENT_MON);
    s2.fake.fail.list = ['error500'];
    s2.worker.tick();
    await s2.worker.drain();
    assert.equal(lastTask(s2).state, 'queued');
    s2.clock.t += 5 * 60_000;
    await s2.worker.drain();
    assert.equal(lastTask(s2).state, 'done');
  } finally {
    await s2.done();
  }
});

// ---- Review fixes: double sends, the cutoff, the guarded day, lost copies, stuck tasks.

test('copy titles: Mailchimp renumbers, so the search compares titles without the copy number', () => {
  assert.equal(baseTitle('Fish Email 20261016 (copy 10)'), 'Fish Email 20261016');
  assert.equal(baseTitle('Fish Email 20261016'), 'Fish Email 20261016');
  assert.equal(baseTitle('Fish Email (copy) list'), 'Fish Email (copy) list');
});

test('a draft named like the lost copy but with other HTML is not taken for it', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.fail.replicate = ['drop'];
    s.fake.add({ id: 'draft00009', status: 'save', create_time: new Date(s.clock.t).toISOString().replace(/\.\d{3}Z$/, '+00:00'), settings: { ...SENT_MON.settings, title: 'Fish Email 20261016 (copy 11)' }, html: '<html>staff draft, another layout</html>'.padEnd(200, ' ') });
    s.worker.tick();
    await s.worker.drain();
    s.clock.t += LOOK_AGAIN_MS;
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.notEqual(t.result!.campaignId, 'draft00009');
    assert.equal(s.fake.campaigns.get('draft00009')!.status, 'save');
  } finally {
    await s.done();
  }
});

test('no double send: with a red alert open on its own leftover copy, the 6am check schedules that copy by id, makes no second one, and updates the alert', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.fail.schedule = ['refuse', 'refuse'];
    s.worker.tick();
    await s.worker.drain();
    const first = lastTask(s);
    assert.equal(first.alert, 'red');
    const draft = first.result!.campaignId;
    assert.equal(s.fake.campaigns.get(draft)!.status, 'save');
    s.clock.t = Z('2026-11-11T12:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const morning = lastTask(s);
    assert.equal(morning.state, 'done', morning.message);
    assert.equal(morning.result!.campaignId, draft);
    assert.equal(s.fake.campaigns.get(draft)!.status, 'schedule');
    assert.equal(s.fake.writes().filter((w) => w.startsWith('replicate')).length, 1);
    assert.ok(listAudit(s.db).some((a) => a.action === 'mailchimp.take_up'));
    // The open alert now says it was scheduled, so nobody makes another.
    const updated = getTask(s.db, first.id)!;
    assert.equal(updated.alert, 'red');
    assert.match(updated.message, new RegExp(`Update: ShelfReady scheduled .*${draft}.* at the 2026-11-11 06:00 check\\. Do not make or schedule another`));
  } finally {
    await s.done();
  }
});

test('no double send: with a "never saw Mailchimp confirm" alert open on email X, the next check makes no copy and raises red', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'save', send_time: '' });
    const id = queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    updateTask(s.db, id, { progress: { day: '2026-11-11', sendAt: Z(WED), scheduleAt: Z(WED), mode: 'edit', targetId: 'sched00001', unscheduling: true } }, s.clock.t);
    await s.worker.drain();
    assert.match(getTask(s.db, id)!.message, /never saw Mailchimp confirm it/);
    s.clock.t = Z('2026-11-11T00:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.kind, 'check');
    assert.equal(t.state, 'needs_person');
    assert.equal(t.alert, 'red');
    assert.match(t.message, /names sched00001.*made no copy/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('a run while a fish email is about to go: its prices are held, nothing is written, no wait loop', async () => {
  const s = await setup('2026-11-11T13:30:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done');
    assert.match(t.message, /about to go, so these prices are held for the next fish day/);
    assert.deepEqual(s.fake.writes(), []);
    assert.equal(heldFor(s.db, '2026-11-13', s.clock.t).rows.length, 1);
  } finally {
    await s.done();
  }
});

test('a PC that slept through a check is reported on the next tick, not only at start', async () => {
  const s = await setup('2026-11-10T23:00:00Z');
  try {
    s.worker.tick();
    assert.equal(openAlerts(s.db).length, 0);
    // Asleep from Tuesday 5pm until Wednesday 7:30am: no tick fired in between.
    s.clock.t = Z('2026-11-11T13:30:00Z');
    s.worker.tick();
    assert.deepEqual(openAlerts(s.db).map((a) => a.slot).sort(), ['2026-11-10T18:00', '2026-11-11T06:00']);
    assert.match(openAlerts(s.db)[0]!.message, /off or asleep/);
  } finally {
    await s.done();
  }
});

test('a red alert that changed nothing in Mailchimp (an outage at 6pm) never stops the 6am copy', async () => {
  const s = await setup('2026-11-11T12:00:00Z');
  try {
    s.fake.add(SENT_MON);
    addMissedCheck(s.db, '2026-11-10T18:00', { day: '2026-11-11', at: Z(WED) }, 'Mailchimp could not be reached at 6pm.', s.clock.t);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(s.fake.campaigns.get(t.result!.campaignId)!.status, 'schedule');
  } finally {
    await s.done();
  }
});

test('an unschedule ShelfReady asked for but never saw confirmed is not taken as its own', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add({ id: 'sched00001', status: 'save', send_time: '' });
    const id = queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    updateTask(s.db, id, { progress: { day: '2026-11-11', sendAt: Z(WED), scheduleAt: Z(WED), mode: 'edit', targetId: 'sched00001', unscheduling: true } }, s.clock.t);
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /never saw Mailchimp confirm it/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('the cutoff: a resumed run never unschedules inside it; its held prices go into the next email', async () => {
  const s = await setup('2026-11-11T12:00:00Z');
  try {
    s.fake.add(SENT_MON);
    const wed = s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    track(s.db, '2026-11-11', 'sched00001', 'adopted', null, s.clock.t);
    const id = queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), { day: '2026-11-11', at: Z(WED) });
    updateTask(s.db, id, { progress: { day: '2026-11-11', sendAt: Z(WED), scheduleAt: Z(WED), mode: 'edit', targetId: 'sched00001' } }, s.clock.t);
    s.clock.t = Z('2026-11-11T13:30:00Z');
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done');
    assert.match(t.message, /inside the cutoff, so ShelfReady left it as it is\. Its price changes go into the next fish day's email/);
    assert.deepEqual(s.fake.writes(), []);
    // Wednesday's went. The Thursday 6pm check copies it for Friday, and the held price goes in.
    wed.status = 'sent';
    s.clock.t = Z('2026-11-13T00:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const fri = lastTask(s);
    assert.equal(fri.state, 'done', fri.message);
    const c = s.fake.campaigns.get(fri.result!.campaignId)!;
    assert.equal(c.send_time, '2026-11-13T14:00:00+00:00');
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$33.99');
    assert.equal(s.fake.writes()[0], 'replicate sched00001');
    assert.equal(heldFor(s.db, '2026-11-13', s.clock.t).rows.length, 0);
  } finally {
    await s.done();
  }
});

test('the cutoff: a check inside it leaves the scheduled email alone', async () => {
  const s = await setup('2026-11-11T12:00:00Z');
  try {
    s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    addCheckTask(s.db, '2026-11-11T06:00', { day: '2026-11-11', at: Z(WED) }, s.clock.t);
    const id = lastTask(s).id;
    updateTask(s.db, id, { progress: { guardDay: '2026-11-11', guardAt: Z(WED), day: '2026-11-11', sendAt: Z(WED), scheduleAt: Z(WED), mode: 'edit', targetId: 'sched00001' } }, s.clock.t);
    s.clock.t = Z('2026-11-11T13:30:00Z');
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done');
    assert.match(t.message, /inside the cutoff, so ShelfReady left it as it is/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('a check guards its own day: if Mailchimp stays down until the cutoff, it raises a red alert and never moves on to Friday', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.fail.list = ['error500', 'error500'];
    s.worker.tick();
    await s.worker.drain();
    assert.equal(lastTask(s).state, 'queued');
    // Next try comes after 7:00am: Wednesday is inside the cutoff.
    s.clock.t = Z('2026-11-11T13:05:00Z');
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'needs_person');
    assert.equal(t.alert, 'red');
    assert.match(t.message, /check for the Wednesday, November 11, 2026 fish email could not finish before the cutoff/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('checks missed while ShelfReady was off raise a red alert on start', async () => {
  const s = await setup('2026-11-11T13:30:00Z');
  try {
    // Last seen Tuesday 5pm; back Wednesday 7:30am, too late for both checks.
    setLastTick(s.db, Z('2026-11-10T23:00:00Z'));
    s.worker.catchUp();
    const alerts = openAlerts(s.db);
    assert.deepEqual(alerts.map((a) => a.slot).sort(), ['2026-11-10T18:00', '2026-11-11T06:00']);
    assert.ok(alerts.every((a) => a.alert === 'red' && /ShelfReady was off/.test(a.message)));
    // Starting again does not add them twice.
    s.worker.catchUp();
    assert.equal(openAlerts(s.db).length, 2);
  } finally {
    await s.done();
  }
});

test('a fresh install with no clock yet raises no missed check alerts', async () => {
  const s = await setup('2026-11-11T13:30:00Z');
  try {
    s.worker.catchUp();
    assert.equal(openAlerts(s.db).length, 0);
  } finally {
    await s.done();
  }
});

test('a task still running after 15 minutes raises a red alert', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    const id = queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    updateTask(s.db, id, { state: 'running' }, s.clock.t);
    s.clock.t += 16 * 60_000;
    s.worker.tick();
    const t = getTask(s.db, id)!;
    assert.equal(t.alert, 'red');
    assert.equal(t.state, 'running');
    assert.match(t.message, /over 15 minutes/);
  } finally {
    await s.done();
  }
});

test('every change since the last email goes into the next one; one over three weeks old is listed, not put in', async () => {
  const s = await setup('2026-11-12T20:00:00Z');
  try {
    s.fake.add({ ...SENT_MON, id: 'sentwed001', send_time: WED });
    // Held for Wednesday, never put in (ShelfReady was off), and one from October.
    addHeld(s.db, s.runId, '2026-11-11', plan([['Sea Bass (Wild)', 3399, true]]), Z('2026-11-10T20:00:00Z'));
    addHeld(s.db, s.runId, '2026-10-14', plan([['Salmon Heads', 599, true]]), Z('2026-10-13T20:00:00Z'));
    s.clock.t = Z('2026-11-13T00:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    const c = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(c.send_time, '2026-11-13T14:00:00+00:00');
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$33.99');
    assert.equal(price(c.html, 'Salmon Heads'), '$3.99');
    assert.ok(t.result!.notChanged.some((n) => n.key === 'Salmon Heads' && /over three weeks ago/.test(n.why)));
  } finally {
    await s.done();
  }
});

test('a run inside the cutoff: held; Thursday 6pm copies Wednesday (with staff edits) for Friday with the price', async () => {
  const s = await setup('2026-11-11T13:30:00Z');
  try {
    s.fake.add(SENT_MON);
    const wed = s.fake.add({ id: 'sched00001', status: 'schedule', send_time: WED });
    wed.html = wed.html.replace('Example Fish Market</td>', 'Example Fish Market. Staff note for Wednesday.</td>');
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    assert.equal(lastTask(s).state, 'done');
    assert.deepEqual(s.fake.writes(), []);
    wed.status = 'sent';
    s.clock.t = Z('2026-11-13T00:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    const fri = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(fri.send_time, '2026-11-13T14:00:00+00:00');
    assert.ok(fri.html.includes('Staff note for Wednesday.'));
    assert.equal(price(fri.html, 'Sea Bass (Wild)'), '$33.99');
    assert.equal(s.fake.writes()[0], 'replicate sched00001');
    assert.equal([...s.fake.campaigns.values()].filter((c) => c.status === 'schedule').length, 1);
  } finally {
    await s.done();
  }
});

test('missed checks: only the latest fish day is reported', async () => {
  const s = await setup('2026-11-13T13:30:00Z');
  try {
    // Last seen Monday noon, back Friday 7:30am: Mon 6pm is not a check day; Tue 6pm, Wed 6am,
    // Thu 6pm and Fri 6am were missed. Only Friday's two are reported.
    setLastTick(s.db, Z('2026-11-09T18:00:00Z'));
    s.worker.catchUp();
    assert.deepEqual(openAlerts(s.db).map((a) => a.slot).sort(), ['2026-11-12T18:00', '2026-11-13T06:00']);
  } finally {
    await s.done();
  }
});

test('only prices Square confirmed reach the email', () => {
  const rows = plan([['Sea Bass (Wild)', 3399, true], ['Salmon Heads', 499, true], ['Crab Meat (1 lb can)', 4199, false], ['Mussels (Sold in 2 lb units)', 799, true]]);
  const item = (variationId: string, toCents: number, state: string) => ({ variationId, label: '', rename: null, price: { toCents, perPound: true, state }, switchToWeight: null, tracking: null, stock: null, readBack: null, problems: [] });
  const report = {
    ok: true,
    at: 0,
    items: [item(rows[0]!.variationId, 3399, 'done'), item(rows[1]!.variationId, 499, 'failed'), item(rows[2]!.variationId, 4199, 'unknown'), item(rows[3]!.variationId, 899, 'done')],
    corrections: [],
    writes: [],
    stopped: '',
    warnings: [],
    scaleSkipped: [],
  } as unknown as SquareReport;
  // Confirmed at the planned price: in. Failed, unknown, or confirmed at another price: out.
  assert.deepEqual(confirmedRows(rows, report).map((r) => r.key), ['Sea Bass (Wild)']);
});

// ---- Bart, November 10: one email per fish day, held changes, the 6am schedule, the sent check,
// price drift, and staff edits kept.

/** Invented matches for the fixture email, and a register book with invented prices. */
function driftDeps(prices: Record<string, { cents: number; perPound: boolean } | string>): { matches: () => FishMatches; register: () => Promise<RegisterBook> } {
  const row = (r: string, itemId: string | null, status: 'confirmed' | 'none' = 'confirmed') => ({ row: r, status, itemId, variationId: null, confirmedBy: 'test', confirmedAt: '', note: '' });
  const matches: FishMatches = {
    version: 1,
    rows: [row('Sea Bass (Wild)', 'ITEM_BASS_W'), row('Sea Bass (Farmed)', 'ITEM_BASS_F'), row('Crab Meat (1 lb can)', 'ITEM_CRAB'), row('Salmon Heads', 'ITEM_HEADS'), row('Mussels (Sold in 2 lb units)', 'ITEM_MUSSELS'), row('Giant Lobster (Special order)', null, 'none')],
  };
  return {
    matches: () => matches,
    register: async () => ({ source: 'test register', lookup: (itemId) => prices[itemId] ?? 'it is not in Square.' }),
  };
}

test('one email per fish day: a copy is tracked by id; staff unschedule it, and no second one is ever made', async () => {
  const s = await setup('2026-11-08T00:00:00Z'); // Saturday 6pm: Monday is next.
  try {
    s.fake.add({ ...SENT_MON, id: 'sentfri001', send_time: '2026-11-06T14:00:00+00:00' });
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const first = lastTask(s);
    assert.equal(first.state, 'done', first.message);
    const id = first.result!.campaignId;
    assert.equal(trackedFor(s.db, '2026-11-09')!.campaignId, id);
    // Staff unschedule it to edit it. Sunday 6pm: the check holds; nothing is copied.
    const c = s.fake.campaigns.get(id)!;
    c.status = 'save';
    c.send_time = '';
    queueRun(s, plan([['Salmon Heads', 499, true]]), nextFishSend(s.clock.t, cfg));
    s.clock.t = Z('2026-11-09T00:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const held = lastTask(s);
    assert.equal(held.state, 'done');
    assert.match(held.message, /Staff have the Monday, November 9, 2026 email .* unscheduled\. 1 price change is held/);
    assert.equal(s.fake.writes().filter((w) => w.startsWith('replicate')).length, 1);
    assert.equal(c.status, 'save');
    assert.equal(price(c.html, 'Salmon Heads'), '$3.99');
  } finally {
    await s.done();
  }
});

test('6:00am on the fish day: a draft staff left unscheduled gets the held changes and is scheduled for 8:00am, with a note', async () => {
  const s = await setup('2026-11-08T18:00:00Z'); // Sunday noon.
  try {
    s.fake.add({ ...SENT_MON, id: 'sentfri001', send_time: '2026-11-06T14:00:00+00:00' });
    const draft = s.fake.add({ id: 'ours000001', status: 'save', settings: { ...SENT_MON.settings, title: 'Fish Email 20261109' } });
    draft.html = draft.html.replace('Example Fish Market</td>', 'Example Fish Market. Staff wrote this.</td>');
    track(s.db, '2026-11-09', 'ours000001', 'copied', null, s.clock.t);
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    assert.match(lastTask(s).message, /held/);
    assert.deepEqual(s.fake.writes(), []);
    s.clock.t = Z('2026-11-09T12:00:00Z'); // Monday 6:00am.
    s.worker.tick();
    const t = lastTask(s);
    assert.equal(t.slot, '2026-11-09T06:00');
    assert.equal(t.progress.scheduleDrafts, true);
    await s.worker.drain();
    const done = getTask(s.db, t.id)!;
    assert.equal(done.state, 'done', done.message);
    assert.equal(done.alert, 'note');
    assert.match(done.message, /staff had left it unscheduled, so ShelfReady put in the held changes and scheduled it at 6:00am/);
    assert.equal(draft.status, 'schedule');
    assert.equal(draft.send_time, '2026-11-09T14:00:00+00:00');
    assert.equal(price(draft.html, 'Sea Bass (Wild)'), '$33.99');
    assert.ok(draft.html.includes('Staff wrote this.'), 'staff text is kept');
    assert.deepEqual(s.fake.writes(), ['put ours000001', 'schedule ours000001']);
    assert.equal(heldFor(s.db, '2026-11-09', s.clock.t).rows.length, 0);
  } finally {
    await s.done();
  }
});

test('staff schedule it again after editing: the next check puts the held changes in and keeps their text', async () => {
  const s = await setup('2026-11-08T18:00:00Z');
  try {
    s.fake.add({ ...SENT_MON, id: 'sentfri001', send_time: '2026-11-06T14:00:00+00:00' });
    const c = s.fake.add({ id: 'ours000001', status: 'schedule', send_time: '2026-11-09T14:00:00+00:00', settings: { ...SENT_MON.settings, title: 'Fish Email 20261109' } });
    c.html = c.html.replace('An invented description for a test fish.', 'Staff rewrote this line.');
    track(s.db, '2026-11-09', 'ours000001', 'copied', null, s.clock.t);
    addHeld(s.db, s.runId, '2026-11-09', plan([['Crab Meat (1 lb can)', 4199, false]]), s.clock.t);
    s.clock.t = Z('2026-11-09T00:00:00Z'); // Sunday 6pm.
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(price(c.html, 'Crab Meat (1 lb can)'), '$41.99');
    assert.ok(c.html.includes('Staff rewrote this line.'));
    assert.equal(c.settings.subject_line, SENT_MON.settings.subject_line);
    assert.equal(c.status, 'schedule');
    assert.deepEqual(s.fake.writes(), ['unschedule ours000001', 'put ours000001', 'schedule ours000001']);
  } finally {
    await s.done();
  }
});

test('a staff-scheduled email is taken on and kept by id; a second scheduled one for that day is a red alert', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'byhand0001', status: 'schedule', send_time: WED });
    s.worker.tick();
    await s.worker.drain();
    assert.equal(trackedFor(s.db, '2026-11-11')!.how, 'adopted');
    assert.equal(trackedFor(s.db, '2026-11-11')!.campaignId, 'byhand0001');
    s.fake.add({ id: 'second0001', status: 'schedule', send_time: WED });
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /Another fish email is scheduled besides ShelfReady's .*byhand0001.*second0001/);
  } finally {
    await s.done();
  }
});

test('the tracked email was deleted in Mailchimp: a red alert, and never a second one', async () => {
  const s = await setup('2026-11-10T20:00:00Z');
  try {
    s.fake.add(SENT_MON);
    track(s.db, '2026-11-11', 'gone000001', 'copied', null, s.clock.t);
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /gone from Mailchimp\. ShelfReady will not make a second one/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('the sent check at 8:15am: went out is quiet; still scheduled past its time is a red alert that says check Mailchimp first', async () => {
  for (const [status, expectRed] of [['sent', false], ['schedule', true]] as const) {
    const s = await setup('2026-11-11T14:20:00Z'); // Wednesday 8:20am.
    try {
      s.fake.add({ id: 'wed0000001', status, send_time: WED });
      track(s.db, '2026-11-11', 'wed0000001', 'copied', null, s.clock.t);
      s.worker.tick();
      const t = lastTask(s);
      assert.equal(t.slot, '2026-11-11T08:15');
      assert.equal(t.progress.purpose, 'sent');
      await s.worker.drain();
      // Scheduled for 8:00, and it is 8:20: past the 15 minutes' grace.
      const done = getTask(s.db, t.id)!;
      assert.equal(done.alert, expectRed ? 'red' : '');
      if (expectRed) {
        assert.match(done.message, /has not gone out: Mailchimp shows it as "schedule" for 8:00am\. Check Mailchimp first/);
        assert.doesNotMatch(done.message, /send it by hand now/i);
      }
      assert.deepEqual(s.fake.writes(), []);
    } finally {
      await s.done();
    }
  }
  // Not tracked: a fish email sent that day counts; none is a red alert.
  const s = await setup('2026-11-11T14:20:00Z');
  try {
    s.fake.add({ ...SENT_MON, id: 'byhand0001', send_time: WED });
    s.worker.tick();
    await s.worker.drain();
    assert.equal(lastTask(s).alert, '');
  } finally {
    await s.done();
  }
  const s2 = await setup('2026-11-11T14:20:00Z');
  try {
    s2.fake.add(SENT_MON);
    s2.worker.tick();
    await s2.worker.drain();
    assert.equal(lastTask(s2).alert, 'red');
    assert.match(lastTask(s2).message, /No fish email went out on Wednesday, November 11, 2026\. Check Mailchimp first/);
  } finally {
    await s2.done();
  }
});

test('the sent check waits for an email staff scheduled for 8:15am, then confirms it went', async () => {
  for (const tracked of [true, false]) {
    const s = await setup('2026-11-11T14:20:00Z'); // 8:20am.
    try {
      const c = s.fake.add({ id: 'wed0000001', status: 'schedule', send_time: '2026-11-11T14:15:00+00:00' });
      if (tracked) track(s.db, '2026-11-11', 'wed0000001', 'adopted', null, s.clock.t);
      s.worker.tick();
      await s.worker.drain();
      const t = lastTask(s);
      assert.equal(t.state, 'queued');
      assert.equal(t.notBefore, Z('2026-11-11T14:30:00Z'));
      assert.equal(t.alert, '');
      c.status = 'sent';
      s.clock.t = Z('2026-11-11T14:30:00Z');
      await s.worker.drain();
      const done = getTask(s.db, t.id)!;
      assert.equal(done.state, 'done');
      assert.equal(done.alert, '');
    } finally {
      await s.done();
    }
  }
});

test('the sent check: two fish emails went out that day, or one went to far fewer people, is a red alert', async () => {
  const s = await setup('2026-11-11T14:20:00Z');
  try {
    s.fake.add({ ...SENT_MON, emails_sent: 1000 });
    s.fake.add({ id: 'wed0000001', status: 'sent', send_time: WED, emails_sent: 1000 });
    s.fake.add({ id: 'wed0000002', status: 'sent', send_time: WED, emails_sent: 1000 });
    s.worker.tick();
    await s.worker.drain();
    assert.equal(lastTask(s).alert, 'red');
    assert.match(lastTask(s).message, /More than one fish email went out on Wednesday, November 11, 2026: /);
    assert.match(lastTask(s).message, /wed0000001/);
    assert.match(lastTask(s).message, /wed0000002/);
  } finally {
    await s.done();
  }
  const s2 = await setup('2026-11-11T14:20:00Z');
  try {
    s2.fake.add({ ...SENT_MON, emails_sent: 1000 });
    s2.fake.add({ id: 'wed0000001', status: 'sent', send_time: WED, emails_sent: 12, recipients: { list_id: LIST, segment_opts: { saved_segment_id: 7 } } });
    track(s2.db, '2026-11-11', 'wed0000001', 'copied', null, s2.clock.t);
    s2.worker.tick();
    await s2.worker.drain();
    assert.equal(lastTask(s2).alert, 'red');
    assert.match(lastTask(s2).message, /went to 12 people, far fewer than the 1000 the last fish email \(sent000001\) went to, and it was sent to a segment\. Check Mailchimp first/);
  } finally {
    await s2.done();
  }
});

test('the copy source is ShelfReady\'s own sent email for the last fish day, not a staff one sent at the same time', async () => {
  const s = await setup('2026-11-13T00:00:00Z'); // Thursday 6pm: Friday next.
  try {
    s.fake.add({ ...SENT_MON, id: 'staff00001', send_time: WED, html: FIXTURE_HTML.replace('Example Fish Market</td>', 'Staff version.</td>') });
    s.fake.add({ ...SENT_MON, id: 'ours000001', send_time: WED });
    track(s.db, '2026-11-11', 'ours000001', 'copied', null, s.clock.t);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(s.fake.writes()[0], 'replicate ours000001');
  } finally {
    await s.done();
  }
});

test('no tracked sent email and two fish emails went out the same day: ShelfReady will not choose, red alert', async () => {
  const s = await setup('2026-11-13T00:00:00Z'); // Thursday 6pm: Friday next.
  try {
    s.fake.add({ ...SENT_MON, id: 'staff00001', send_time: WED });
    s.fake.add({ ...SENT_MON, id: 'other00001', send_time: WED });
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /More than one fish email went out on 2026-11-11: .*ShelfReady will not choose which to copy/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('an email sent to a segment is never a copy source', async () => {
  const s = await setup('2026-11-13T00:00:00Z'); // Thursday 6pm: Friday next.
  try {
    s.fake.add({ ...SENT_MON, id: 'monday0001', send_time: '2026-11-09T14:00:00+00:00' });
    s.fake.add({ ...SENT_MON, id: 'segment001', send_time: WED, recipients: { list_id: LIST, segment_opts: { conditions: [{ field: 'x' }] } } });
    s.worker.tick();
    await s.worker.drain();
    assert.equal(s.fake.writes()[0], 'replicate monday0001');
  } finally {
    await s.done();
  }
});

const PROMO_HTML = `<html><body><table class="wrap"><tr><td>Order your holiday turkey by Friday. ${'Fresh and local. '.repeat(10)}</td></tr></table></body></html>`;

test('the 7:00am cutoff check: a second fish email that morning, under any name, is red; nothing scheduled is red; a promotion is a warning', async () => {
  // A replacement fish email under another title: it holds fish rows, so it counts.
  const s = await setup('2026-11-11T13:02:00Z'); // Wednesday 7:02am.
  try {
    s.fake.add({ id: 'ours000001', status: 'schedule', send_time: WED });
    track(s.db, '2026-11-11', 'ours000001', 'copied', null, s.clock.t);
    s.fake.add({ id: 'replace001', status: 'schedule', send_time: '2026-11-11T14:30:00+00:00', settings: { ...SENT_MON.settings, title: 'Wednesday list' } });
    s.worker.tick();
    const t = lastTask(s);
    assert.equal(t.slot, '2026-11-11T07:00');
    assert.equal(t.progress.purpose, 'cutoff');
    await s.worker.drain();
    const done = getTask(s.db, t.id)!;
    assert.equal(done.alert, 'red');
    assert.match(done.message, /More than one fish email is scheduled for the morning of Wednesday, November 11, 2026: /);
    assert.match(done.message, /ours000001/);
    assert.match(done.message, /replace001/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
  // Only ShelfReady's: quiet.
  const s2 = await setup('2026-11-11T13:02:00Z');
  try {
    s2.fake.add({ id: 'ours000001', status: 'schedule', send_time: WED });
    track(s2.db, '2026-11-11', 'ours000001', 'copied', null, s2.clock.t);
    s2.worker.tick();
    await s2.worker.drain();
    assert.equal(lastTask(s2).alert, '');
  } finally {
    await s2.done();
  }
  // Nothing scheduled for that morning: red.
  const s3 = await setup('2026-11-11T13:02:00Z');
  try {
    s3.fake.add({ id: 'ours000001', status: 'save' });
    track(s3.db, '2026-11-11', 'ours000001', 'copied', null, s3.clock.t);
    s3.worker.tick();
    await s3.worker.drain();
    const t = lastTask(s3);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /No fish email is scheduled for 8:00am on Wednesday, November 11, 2026\. Check Mailchimp\./);
  } finally {
    await s3.done();
  }
  // A holiday promotion beside ShelfReady's: a warning only.
  const s4 = await setup('2026-11-11T13:02:00Z');
  try {
    s4.fake.add({ id: 'ours000001', status: 'schedule', send_time: WED });
    track(s4.db, '2026-11-11', 'ours000001', 'copied', null, s4.clock.t);
    s4.fake.add({ id: 'turkey0001', status: 'schedule', send_time: '2026-11-11T15:00:00+00:00', settings: { ...SENT_MON.settings, title: 'Holiday turkeys' }, html: PROMO_HTML });
    s4.worker.tick();
    await s4.worker.drain();
    const t = lastTask(s4);
    assert.equal(t.alert, 'warn');
    assert.match(t.message, /Another campaign also goes to the fish list that morning: .*turkey0001/);
  } finally {
    await s4.done();
  }
});

test('a turkey promotion to the fish list that morning does not block: the fish email is still scheduled, with a warning', async () => {
  const s = await setup('2026-11-11T00:00:00Z'); // Tuesday 6pm.
  try {
    s.fake.add(SENT_MON);
    const ours = s.fake.add({ id: 'ours000001', status: 'save', settings: { ...SENT_MON.settings, title: 'Fish Email 20261111' } });
    track(s.db, '2026-11-11', 'ours000001', 'copied', null, s.clock.t);
    s.fake.add({ id: 'turkey0001', status: 'schedule', send_time: '2026-11-11T15:00:00+00:00', settings: { ...SENT_MON.settings, title: 'Holiday turkeys' }, html: PROMO_HTML });
    addHeld(s.db, s.runId, '2026-11-11', plan([['Sea Bass (Wild)', 3399, true]]), s.clock.t);
    // The 6:00am check on Wednesday schedules the draft staff left, held change in.
    s.clock.t = Z('2026-11-11T12:00:00Z');
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(t.alert, 'warn');
    assert.match(t.message, /Another campaign also goes to the fish list that morning: .*turkey0001/);
    assert.equal(ours.status, 'schedule');
    assert.equal(price(ours.html, 'Sea Bass (Wild)'), '$33.99');
  } finally {
    await s.done();
  }
});

test('a replacement fish email under another title that morning blocks the 6:00am schedule: red, nothing written', async () => {
  const s = await setup('2026-11-11T12:00:00Z'); // Wednesday 6:00am.
  try {
    s.fake.add(SENT_MON);
    const ours = s.fake.add({ id: 'ours000001', status: 'save', settings: { ...SENT_MON.settings, title: 'Fish Email 20261111' } });
    track(s.db, '2026-11-11', 'ours000001', 'copied', null, s.clock.t);
    s.fake.add({ id: 'replace001', status: 'schedule', send_time: WED, settings: { ...SENT_MON.settings, title: 'Wednesday list' } });
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /Another fish email is scheduled besides ShelfReady's .*replace001/);
    assert.equal(ours.status, 'save');
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('segment text alone does not make an email a segment send: it can still be the copy source', async () => {
  const s = await setup('2026-11-13T00:00:00Z'); // Thursday 6pm.
  try {
    s.fake.add({ ...SENT_MON, id: 'wed0000001', send_time: WED, recipients: { list_id: LIST, segment_text: 'All subscribers on the list' } });
    s.worker.tick();
    await s.worker.drain();
    assert.equal(s.fake.writes()[0], 'replicate wed0000001');
  } finally {
    await s.done();
  }
});

test('the sent check while the email is still sending uses the recipient count, not the partial sent count', async () => {
  const s = await setup('2026-11-11T14:20:00Z');
  try {
    s.fake.add({ ...SENT_MON, emails_sent: 1000 });
    s.fake.add({ id: 'wed0000001', status: 'sending', send_time: WED, emails_sent: 40, recipients: { list_id: LIST, recipient_count: 1000 } });
    track(s.db, '2026-11-11', 'wed0000001', 'copied', null, s.clock.t);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, '');
    assert.match(t.message, /went out/);
  } finally {
    await s.done();
  }
});

test('a scheduled email with nothing to change, but a held change it refused: a warning, and the change stays held', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    const c = s.fake.add({ id: 'ours000001', status: 'schedule', send_time: WED, settings: { ...SENT_MON.settings, title: 'Fish Email 20261111' } });
    c.html = editEmail(c.html, [], { units: cfg.units, dateLine: cfg.dateLine, dateText: 'Wednesday, November 11, 2026' }).html;
    track(s.db, '2026-11-11', 'ours000001', 'copied', null, s.clock.t);
    addHeld(s.db, s.runId, '2026-11-11', plan([['Sea Bass (Wild Caught)', 3399, true]]), s.clock.t);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(t.alert, 'warn');
    assert.deepEqual(s.fake.writes(), []);
    assert.equal(heldFor(s.db, '2026-11-11', s.clock.t).rows.length, 1);
  } finally {
    await s.done();
  }
});

test('the last tracked email went out but is no longer named like a fish email: no copy, red alert', async () => {
  const s = await setup('2026-11-13T00:00:00Z'); // Thursday 6pm.
  try {
    s.fake.add({ ...SENT_MON, id: 'monday0001', send_time: '2026-11-09T14:00:00+00:00' });
    s.fake.add({ ...SENT_MON, id: 'ours000001', send_time: WED, settings: { ...SENT_MON.settings, title: 'Thanksgiving Special' } });
    track(s.db, '2026-11-11', 'ours000001', 'copied', null, s.clock.t);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /is no longer named like a fish email, so it will not copy it or any other/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('a tracked draft staff reused for something else is never scheduled at 6:00am: red alert, nothing written', async () => {
  // The security reviewer's reproduction: a tracked draft retitled and refilled, then 6:00am.
  const s = await setup('2026-11-09T12:00:00Z'); // Monday 6:00am.
  try {
    s.fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00', settings: { ...SENT_MON.settings, title: 'Fish Email 20261106' } });
    const d = s.fake.add({ id: 'ours000001', status: 'save', settings: { ...SENT_MON.settings, title: 'Thanksgiving Special, DO NOT SEND', subject_line: 'Turkey preorders' } });
    d.html = `<html><body><p>${'Preorder your Thanksgiving turkey now. '.repeat(5)}</p></body></html>`;
    track(s.db, '2026-11-09', 'ours000001', 'copied', null, s.clock.t);
    addCheckTask(s.db, '2026-11-09T06:00', { day: '2026-11-09', at: Z('2026-11-09T14:00:00Z') }, s.clock.t, { scheduleDrafts: true });
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /has no fish rows\. It may have been reused for something else, so ShelfReady left it alone and scheduled nothing/);
    assert.equal(d.status, 'save');
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
  // Fish rows still there but renamed, or most rows gone: left alone too.
  const s2 = await setup('2026-11-09T12:00:00Z');
  try {
    s2.fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
    const d = s2.fake.add({ id: 'ours000001', status: 'save', settings: { ...SENT_MON.settings, title: 'Thanksgiving Special' } });
    track(s2.db, '2026-11-09', 'ours000001', 'copied', null, s2.clock.t);
    addCheckTask(s2.db, '2026-11-09T06:00', { day: '2026-11-09', at: Z('2026-11-09T14:00:00Z') }, s2.clock.t, { scheduleDrafts: true });
    await s2.worker.drain();
    assert.match(lastTask(s2).message, /no longer named like a fish email/);
    assert.equal(d.status, 'save');
  } finally {
    await s2.done();
  }
  const s3 = await setup('2026-11-09T12:00:00Z');
  try {
    s3.fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-06T14:00:00+00:00' });
    const d = s3.fake.add({ id: 'ours000001', status: 'save', settings: { ...SENT_MON.settings, title: 'Fish Email 20261109' } });
    track(s3.db, '2026-11-09', 'ours000001', 'copied', null, s3.clock.t);
    s3.db.prepare("UPDATE mailchimp_fish_days SET row_count = 40 WHERE day = '2026-11-09'").run();
    addCheckTask(s3.db, '2026-11-09T06:00', { day: '2026-11-09', at: Z('2026-11-09T14:00:00Z') }, s3.clock.t, { scheduleDrafts: true });
    await s3.worker.drain();
    assert.match(lastTask(s3).message, /now has 12 fish rows, not the 40 it had/);
    assert.equal(d.status, 'save');
    assert.deepEqual(s3.fake.writes(), []);
  } finally {
    await s3.done();
  }
});

test('any campaign scheduled to the fish list that morning beside the tracked one, whatever its title: red, nothing written', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    s.fake.add({ id: 'ours000001', status: 'schedule', send_time: WED });
    track(s.db, '2026-11-11', 'ours000001', 'copied', null, s.clock.t);
    s.fake.add({ id: 'replace001', status: 'schedule', send_time: '2026-11-11T14:15:00+00:00', settings: { ...SENT_MON.settings, title: 'Wednesday list (new)' } });
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'red');
    assert.match(t.message, /Another fish email is scheduled besides ShelfReady's .*replace001/);
    assert.deepEqual(s.fake.writes(), []);
  } finally {
    await s.done();
  }
});

test('a held change the email refuses (a renamed row) stays held, with a warning on the check too', async () => {
  const s = await setup('2026-11-11T00:00:00Z');
  try {
    s.fake.add(SENT_MON);
    addHeld(s.db, s.runId, '2026-11-11', plan([['Sea Bass (Wild Caught)', 3399, true], ['Salmon Heads', 499, true]]), s.clock.t);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.kind, 'check');
    assert.equal(t.state, 'done', t.message);
    assert.equal(t.alert, 'warn');
    assert.ok(t.result!.notChanged.some((n) => n.key === 'Sea Bass (Wild Caught)'));
    const left = heldFor(s.db, '2026-11-11', s.clock.t).rows.map((r) => r.rowKey);
    assert.deepEqual(left, ['Sea Bass (Wild Caught)']);
  } finally {
    await s.done();
  }
});

test('drift limits: a move over the big-change limit, or past the count, is left for a person with a warning', async () => {
  const d = driftDeps({ ITEM_BASS_W: { cents: 4999, perPound: true }, ITEM_BASS_F: { cents: 3099, perPound: true }, ITEM_CRAB: { cents: 3899, perPound: false }, ITEM_MUSSELS: { cents: 699, perPound: true } });
  const s = await setup('2026-11-11T00:00:00Z', TEST_KEY, d);
  try {
    s.fake.add(SENT_MON);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.alert, 'warn');
    const c = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$31.99');
    assert.ok(t.result!.notChanged.some((n) => n.key === 'Sea Bass (Wild)' && /a 56% move, more than 30%\. A person must check it/.test(n.why)));
    assert.equal(price(c.html, 'Sea Bass (Farmed)'), '$30.99');
    assert.equal(price(c.html, 'Crab Meat (1 lb can)'), '$38.99');
  } finally {
    await s.done();
  }
  // At most driftMaxPerEdit fixes on their own.
  const s2 = await setup('2026-11-11T00:00:00Z', TEST_KEY, d);
  try {
    s2.fake.add(SENT_MON);
    s2.cfg.driftMaxPerEdit = 1;
    s2.worker.tick();
    await s2.worker.drain();
    const t = lastTask(s2);
    assert.equal(t.result!.changes.filter((x) => x.why === 'drift').length, 1);
    assert.ok(t.result!.notChanged.some((n) => /fixes at most 1 prices on its own/.test(n.why)));
  } finally {
    await s2.done();
  }
});

test('price drift: email prices that differ from the register are fixed, each listed; others are left alone and listed', async () => {
  const d = driftDeps({
    ITEM_BASS_W: { cents: 3299, perPound: true },
    ITEM_BASS_F: { cents: 2999, perPound: true },
    ITEM_CRAB: { cents: 3999, perPound: true },
    ITEM_HEADS: 'it has scale code 1234 but Square does not sell it by the pound (rule 12).',
  });
  const s = await setup('2026-11-11T00:00:00Z', TEST_KEY, d);
  try {
    s.fake.add(SENT_MON);
    s.worker.tick();
    await s.worker.drain();
    const t = lastTask(s);
    assert.equal(t.state, 'done', t.message);
    assert.equal(t.alert, 'note');
    assert.match(t.message, /set to the register price: Sea Bass \(Wild\) \$31\.99 to \$32\.99/);
    const c = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$32.99');
    assert.equal(price(c.html, 'Sea Bass (Farmed)'), '$29.99');
    assert.deepEqual(t.result!.changes.map((x) => [x.key, x.why]), [['Sea Bass (Wild)', 'drift']]);
    const why = new Map(t.result!.notCompared!.map((n) => [n.key, n.why]));
    assert.match(why.get('Crab Meat (1 lb can)')!, /sells it by the can, but Square prices it per pound/);
    assert.match(why.get('Salmon Heads')!, /rule 12/);
    assert.match(why.get('Giant Lobster (Special order)')!, /matched to no Square item/);
    assert.match(why.get('Littlenecks')!, /no confirmed Square match/);
  } finally {
    await s.done();
  }
});

test('price drift and an older invoice change for the same row: the register price wins', async () => {
  const s = await setup('2026-11-10T20:00:00Z', TEST_KEY, driftDeps({ ITEM_BASS_W: { cents: 3499, perPound: true } }));
  try {
    s.fake.add(SENT_MON);
    queueRun(s, plan([['Sea Bass (Wild)', 3399, true]]), nextFishSend(s.clock.t, cfg));
    await s.worker.drain();
    const t = lastTask(s);
    const c = s.fake.campaigns.get(t.result!.campaignId)!;
    assert.equal(price(c.html, 'Sea Bass (Wild)'), '$34.99');
    assert.equal(t.result!.changes[0]!.why, 'drift');
  } finally {
    await s.done();
  }
});
