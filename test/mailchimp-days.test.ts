// Fish days, check times and choosing the campaign, including the week the clocks change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateLineText, dueCheckSlot, missedCheckSlots, fishTitle, localToUtc, mailchimpTime, nextFishSend } from '../src/mailchimp/days.ts';
import { selectTarget } from '../src/mailchimp/target.ts';
import type { Campaign } from '../src/mailchimp/client.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMailchimpConfig, DEFAULT_MAILCHIMP_CONFIG, listIdMissing, loadMailchimpConfig, localCampaignId, PLACEHOLDER_LIST_ID } from '../src/mailchimp/config.ts';
import { LIST, testConfig } from './mailchimp-fixtures.ts';

const cfg = testConfig();
const Z = (s: string): number => Date.parse(s);

test('8:00 in Chicago is 13:00Z in summer time and 14:00Z in winter time', () => {
  // In 2026 the clocks go back on Sunday, November 1.
  assert.equal(mailchimpTime(localToUtc('2026-10-30', '08:00', cfg.timeZone)), '2026-10-30T13:00:00+00:00');
  assert.equal(mailchimpTime(localToUtc('2026-11-02', '08:00', cfg.timeZone)), '2026-11-02T14:00:00+00:00');
  assert.equal(mailchimpTime(localToUtc('2027-03-12', '08:00', cfg.timeZone)), '2027-03-12T14:00:00+00:00');
  assert.equal(mailchimpTime(localToUtc('2027-03-15', '08:00', cfg.timeZone)), '2027-03-15T13:00:00+00:00');
  // The check on the night the clocks change, 6pm Saturday is not a check day; Sunday 6pm is after the change.
  assert.equal(mailchimpTime(localToUtc('2026-11-01', '18:00', cfg.timeZone)), '2026-11-02T00:00:00+00:00');
  assert.equal(mailchimpTime(localToUtc('2026-11-01', '01:30', cfg.timeZone)), '2026-11-01T06:30:00+00:00');
});

test('the next fish day, with the safe margin', () => {
  // Monday November 9, 2026, 13:00 local: Wednesday is next.
  assert.deepEqual(nextFishSend(Z('2026-11-09T19:00:00Z'), cfg), { day: '2026-11-11', at: Z('2026-11-11T14:00:00Z') });
  // Monday 6:00am local: Monday's own email is two hours away.
  assert.equal(nextFishSend(Z('2026-11-09T12:00:00Z'), cfg).day, '2026-11-09');
  // Monday 7:15am local: too close, so Wednesday.
  assert.equal(nextFishSend(Z('2026-11-09T13:15:00Z'), cfg).day, '2026-11-11');
  // Exactly the margin is still in time.
  assert.equal(nextFishSend(Z('2026-11-09T13:00:00Z'), cfg).day, '2026-11-09');
  // Friday evening and Saturday: Monday.
  assert.equal(nextFishSend(Z('2026-11-14T03:00:00Z'), cfg).day, '2026-11-16');
  // Across the clock change: Saturday October 31 evening goes to Monday November 2 at 14:00Z.
  assert.deepEqual(nextFishSend(Z('2026-11-01T01:00:00Z'), cfg), { day: '2026-11-02', at: Z('2026-11-02T14:00:00Z') });
});

test('names and date lines use the send day', () => {
  assert.equal(fishTitle('Fish Email', '2026-11-16'), 'Fish Email 20261116');
  assert.equal(dateLineText('2026-11-16'), 'Monday, November 16, 2026');
  assert.equal(dateLineText('2026-11-02'), 'Monday, November 2, 2026');
});

test('check slots: 6pm Sun, Tue and Thu, 6am on fish days, caught up after a stop', () => {
  // Tuesday 18:05 local (CST, -6).
  assert.equal(dueCheckSlot(Z('2026-11-11T00:05:00Z'), cfg)?.slot, '2026-11-10T18:00');
  // Tuesday 17:55: the slot before is Monday 06:00, whose Monday 8:00 send has passed: nothing due.
  assert.equal(dueCheckSlot(Z('2026-11-10T23:55:00Z'), cfg), null);
  // Wednesday 03:00: the Tuesday slot is still due (ShelfReady was off at 6pm).
  assert.equal(dueCheckSlot(Z('2026-11-11T09:00:00Z'), cfg)?.slot, '2026-11-10T18:00');
  // Wednesday 06:10: the morning check.
  assert.equal(dueCheckSlot(Z('2026-11-11T12:10:00Z'), cfg)?.slot, '2026-11-11T06:00');
  // Wednesday 07:30: too close to 8:00, nothing is due.
  assert.equal(dueCheckSlot(Z('2026-11-11T13:30:00Z'), cfg), null);
  // The slot carries the day it guards.
  assert.deepEqual(dueCheckSlot(Z('2026-11-11T00:05:00Z'), cfg)?.guard, { day: '2026-11-11', at: Z('2026-11-11T14:00:00Z') });
  // Off from Tuesday 5pm to Wednesday 7:30am: the Tuesday 6pm and Wednesday 6am checks were missed.
  assert.deepEqual(missedCheckSlots(Z('2026-11-10T23:00:00Z'), Z('2026-11-11T13:30:00Z'), cfg).map((x) => x.slot), ['2026-11-10T18:00', '2026-11-11T06:00']);
  assert.deepEqual(missedCheckSlots(Z('2026-11-10T23:00:00Z'), Z('2026-11-11T09:00:00Z'), cfg), []);
  // Sunday November 1, 18:00 local, the day the clocks went back: 00:00Z Monday.
  assert.equal(dueCheckSlot(Z('2026-11-02T00:00:00Z'), cfg)?.slot, '2026-11-01T18:00');
});

test('the store config loads and is checked', () => {
  const real = loadMailchimpConfig();
  assert.deepEqual(real.fishDays, ['Mon', 'Wed', 'Fri']);
  assert.equal(real.sendTime, '08:00');
  assert.equal(real.timeZone, 'America/Chicago');
  assert.throws(() => checkMailchimpConfig({ ...structuredClone(testConfig()), sendTime: '08:10' }), /quarter hour/);
  assert.throws(() => checkMailchimpConfig({ ...structuredClone(testConfig()), dateLine: { class: 'x1', topTableClass: 'wrap', style: 'color:red" onload="x' } }), /no quotes/);
  assert.throws(() => checkMailchimpConfig({ ...structuredClone(testConfig()), fishDays: ['Monday'] }), /days like/);
});

test('the Mailchimp ids stay out of git: the file in git holds a placeholder, config/local/mailchimp.json the real list', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-mc-local-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const local = join(dir, 'mailchimp.json');
  // No local file: the placeholder, and Mailchimp is not set up.
  const bare = loadMailchimpConfig(DEFAULT_MAILCHIMP_CONFIG, local);
  assert.equal(bare.list.id, PLACEHOLDER_LIST_ID);
  assert.ok(listIdMissing(bare));
  // The local list id wins over the placeholder; the rest of the file in git stays.
  writeFileSync(local, JSON.stringify({ list: { id: 'abc123list' }, campaigns: { oneOff: 'camp000042' } }));
  const set = loadMailchimpConfig(DEFAULT_MAILCHIMP_CONFIG, local);
  assert.equal(set.list.id, 'abc123list');
  assert.equal(set.list.name, bare.list.name);
  assert.equal(set.sendTime, bare.sendTime);
  assert.ok(!listIdMissing(set));
  assert.equal(localCampaignId('oneOff', local), 'camp000042');
  assert.equal(localCampaignId('other', local), null);
  // Another config file named on purpose is read as it is.
  assert.equal(loadMailchimpConfig(DEFAULT_MAILCHIMP_CONFIG, null).list.id, PLACEHOLDER_LIST_ID);
  // A local file that is not right stops with its path, never a value from it.
  for (const bad of ['{', '[]', JSON.stringify({ list: { id: 'NOT A LIST' } }), JSON.stringify({ campaigns: { x: '../lists' } })]) {
    writeFileSync(local, bad);
    assert.throws(() => loadMailchimpConfig(DEFAULT_MAILCHIMP_CONFIG, local), (e: Error) => e.message.includes(local) && !e.message.includes('NOT A LIST'));
  }
});

function camp(id: string, status: string, sendTime: string | null, over: Partial<Campaign> = {}): Campaign {
  return { id, status, title: 'Fish Email 20261016 (copy 10)', listId: LIST, sendTime: sendTime ? Z(sendTime) : null, createTime: Z('2026-11-01T00:00:00Z'), subjectLine: 's', fromName: 'f', replyTo: 'r', previewText: '', toName: '', segmented: false, segmentText: '', segmentOptsRead: false, recipientCount: null, emailsSent: null, ...over };
}

test('picks the target by Bart rules', () => {
  const now = Z('2026-11-09T19:00:00Z'); // Monday afternoon: next fish day Wednesday 11th.
  const sent = camp('sent000001', 'sent', '2026-11-09T14:00:00Z');
  const older = camp('sent000000', 'sent', '2026-11-06T14:00:00Z');
  // Nothing scheduled: copy the most recent sent one.
  const t1 = selectTarget([older, sent], now, cfg);
  assert.equal(t1.kind, 'copy');
  assert.equal(t1.kind === 'copy' && t1.source.id, 'sent000001');
  assert.equal(t1.send.day, '2026-11-11');
  // One scheduled for Wednesday: edit it.
  const wed = camp('sched00001', 'schedule', '2026-11-11T14:00:00Z');
  const t2 = selectTarget([sent, wed], now, cfg);
  assert.equal(t2.kind === 'edit' && t2.campaign.id, 'sched00001');
  // Paused, drafts, other lists and other titles are ignored.
  const ignored = [
    camp('pause00001', 'paused', '2026-11-11T14:00:00Z'),
    camp('draft00001', 'save', null),
    camp('other00001', 'schedule', '2026-11-13T14:00:00Z', { listId: 'otherlist1' }),
    camp('promo00001', 'schedule', '2026-11-13T14:00:00Z', { title: 'Turkey Special' }),
  ];
  assert.equal(selectTarget([sent, wed, ...ignored], now, cfg).kind, 'edit');
  assert.equal(selectTarget([sent, ...ignored], now, cfg).kind, 'copy');
  // Two scheduled: stop.
  const fri = camp('sched00002', 'schedule', '2026-11-13T14:00:00Z');
  const t3 = selectTarget([sent, wed, fri], now, cfg);
  assert.equal(t3.kind, 'stop');
  assert.match(t3.kind === 'stop' ? t3.reason : '', /More than one fish email is scheduled.*sched00001.*sched00002.*changed nothing/);
  // One scheduled for another day: stop.
  const t4 = selectTarget([sent, fri], now, cfg);
  assert.equal(t4.kind, 'stop');
  assert.match(t4.kind === 'stop' ? t4.reason : '', /next fish day is 2026-11-11/);
  // One going out within the margin is left alone and does not count.
  const soon = camp('soon000001', 'schedule', '2026-11-09T14:00:00Z');
  const t5 = selectTarget([older, soon], Z('2026-11-09T13:30:00Z'), cfg);
  assert.equal(t5.kind, 'copy');
  assert.equal(t5.send.day, '2026-11-11');
  // No sent fish email at all: stop.
  assert.equal(selectTarget([], now, cfg).kind, 'stop');
});
