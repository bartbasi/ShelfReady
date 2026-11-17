// Register prices for the fish email drift check, from an invented Square catalog, and the sent
// check's timing. Pure: no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerFromCatalog } from '../src/mailchimp/register.ts';
import { dueCutoffCheck, dueSentCheck } from '../src/mailchimp/days.ts';
import { checkMailchimpConfig, cutoffTime } from '../src/mailchimp/config.ts';
import { CAT_FISH, codeUpc, item, LOCATION, POUND, testObjects } from './matching-fixtures.ts';
import { testConfig } from './mailchimp-fixtures.ts';

const Z = (s: string): number => Date.parse(s);

test('register prices: a fixed price per pound or per item; anything else says why', () => {
  const objects = testObjects();
  // An item with a scale code that Square does not sell by the pound (rule 12).
  objects.push(item({ id: 'I_BADCODE', name: 'Test Halibut 4999', category: CAT_FISH, variations: [{ id: 'V_BADCODE', upc: codeUpc('4999'), cents: 2999 }] }));
  const book = registerFromCatalog({ source: 'square_sandbox', locationId: LOCATION, takenAt: '', objects }, 'test catalog');
  assert.deepEqual(book.lookup('I_GOUDA', null), { cents: 1899, perPound: true });
  assert.deepEqual(book.lookup('I_CRACKER', 'V_CRACKER'), { cents: 599, perPound: false });
  assert.match(String(book.lookup('I_SALMON', null)), /no fixed price/);
  assert.match(String(book.lookup('I_NOPE', null)), /not in Square/);
  assert.match(String(book.lookup('I_BADCODE', null)), /scale code 4999 but Square does not sell it by the pound \(rule 12\)/);
  assert.match(String(book.lookup('I_GOUDA', 'V_OTHER')), /not at the store/);
  void POUND;
});

test('the sent check is due from 8:15am on a fish day, for ten hours, and not on other days', () => {
  const cfg = testConfig();
  assert.equal(dueSentCheck(Z('2026-11-11T14:10:00Z'), cfg), null); // Wednesday 8:10am.
  assert.deepEqual(dueSentCheck(Z('2026-11-11T14:20:00Z'), cfg), { slot: '2026-11-11T08:15', day: '2026-11-11', sendAt: Z('2026-11-11T14:00:00Z') });
  assert.equal(dueSentCheck(Z('2026-11-12T01:00:00Z'), cfg), null); // Wednesday 7pm: past the window.
  assert.equal(dueSentCheck(Z('2026-11-10T14:20:00Z'), cfg), null); // Tuesday: not a fish day.
  // The week the clocks change: Monday November 2, 8:15am is 14:15Z.
  assert.equal(dueSentCheck(Z('2026-11-02T14:16:00Z'), cfg)?.slot, '2026-11-02T08:15');
  assert.throws(() => checkMailchimpConfig({ ...structuredClone(cfg), sentCheckTime: '07:45' }), /after sendTime/);
  assert.equal(cfg.checks.find((c) => c.time === '06:00')!.scheduleDrafts, true);
  assert.equal(cfg.checks.find((c) => c.time === '18:00')!.scheduleDrafts, false);
});

test('config: the sent check and the cutoff each need their own time, and the drift count is checked', () => {
  const cfg = testConfig();
  assert.throws(() => checkMailchimpConfig({ ...structuredClone(cfg), sentCheckTime: '18:00' }), /sentCheckTime must not be the same time as a check/);
  assert.throws(() => checkMailchimpConfig({ ...structuredClone(cfg), checks: [...cfg.checks, { days: ['Sat'], time: '07:00' }] }), /no check may be at 07:00, the cutoff/);
  assert.throws(() => checkMailchimpConfig({ ...structuredClone(cfg), driftMaxPerEdit: -1 }), /driftMaxPerEdit/);
  assert.equal(checkMailchimpConfig({ ...structuredClone(cfg), driftMaxPerEdit: undefined }).driftMaxPerEdit, 10);
  assert.equal(cutoffTime('08:00', 60), '07:00');
  assert.equal(cutoffTime('00:30', 60), '23:30');
});

test('the cutoff check is due from 7:00am to 8:00am on a fish day only', () => {
  const cfg = testConfig();
  assert.equal(dueCutoffCheck(Z('2026-11-11T12:59:00Z'), cfg), null);
  assert.deepEqual(dueCutoffCheck(Z('2026-11-11T13:00:00Z'), cfg), { slot: '2026-11-11T07:00', day: '2026-11-11', sendAt: Z('2026-11-11T14:00:00Z') });
  assert.equal(dueCutoffCheck(Z('2026-11-11T14:00:00Z'), cfg), null);
  assert.equal(dueCutoffCheck(Z('2026-11-10T13:30:00Z'), cfg), null);
});
