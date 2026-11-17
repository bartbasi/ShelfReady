// The one-off live test script, against a fake fetch: no network. Invented ids and email content.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailchimpClient } from '../src/mailchimp/client.ts';
import { guardFetch } from '../scripts/mailchimp/remove-row.ts';
import { copyCalls, editCalls, liveTestJob, quarterAfter, TEST_AUDIENCE, TEST_TITLE } from '../scripts/mailchimp/live-test.ts';
import { FIXTURE_HTML, LIST, REAL_SHAPED_KEY, testConfig } from './mailchimp-fixtures.ts';

/** Invented: the whole-list fish send the segment check reads in the fake. */
const WHOLE_LIST_SEND = 'wholesend1';

const NOW = Date.parse('2026-11-14T20:00:00Z'); // A Saturday afternoon.
const TEST_LIST = 'testlist01';
const AUTO_TEXT = (html: string): string => `** The Fish List\n------------------------------------------------------------\n${html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')}\n`;

interface FakeCampaign {
  id: string;
  status: string;
  send_time: string;
  create_time: string;
  settings: { title: string; subject_line: string; from_name: string; reply_to: string; preview_text: string; to_name: string };
  recipients: { list_id: string; recipient_count?: number; segment_text?: string; segment_opts?: { saved_segment_id?: number; conditions?: unknown[] } };
  /** Not yet visible in campaign lists (a copy Mailchimp is still making). */
  hidden?: boolean;
  html: string;
  plain_text: string;
}
type Name = 'lists' | 'list' | 'get' | 'content' | 'put' | 'patch' | 'replicate' | 'schedule' | 'unschedule' | 'other';

interface FakeOpts {
  /** Mailchimp makes a new plain text on a PUT of HTML. */
  regenerate?: boolean;
  memberCount?: number;
  copyRecipients?: number;
}

function fake(opts: FakeOpts = {}) {
  const campaigns = new Map<string, FakeCampaign>();
  const calls: Array<{ name: Name; method: string; path: string; auth: string; fields: string }> = [];
  /** refuse: 400. lose: done, reply lost. loseHidden: done, reply lost, not listed until a later list. drop: not done, reply lost. */
  const fail: Partial<Record<Name, Array<'refuse' | 'lose' | 'loseHidden' | 'drop'>>> = {};
  const hooks: { onPut?: () => void; tidy?: (html: string) => string; plainAfterReads?: number } = {};
  let contentReadsSincePut = 0;
  let n = 0;
  const add = (c: Partial<FakeCampaign> & { id: string; status: string }): FakeCampaign => {
    const full: FakeCampaign = {
      send_time: '',
      create_time: '2026-11-14T18:00:00+00:00',
      settings: { title: TEST_TITLE, subject_line: 'Fish list', from_name: 'Example Fish Market', reply_to: 'fish@example.com', preview_text: 'Order by 7pm', to_name: '*|FNAME|*' },
      recipients: { list_id: TEST_LIST, recipient_count: 1 },
      html: FIXTURE_HTML,
      plain_text: AUTO_TEXT(FIXTURE_HTML),
      ...c,
    };
    campaigns.set(full.id, full);
    return full;
  };
  const json = (status: number, body?: unknown): Response => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const view = (c: FakeCampaign) => ({ id: c.id, status: c.status, send_time: c.send_time, create_time: c.create_time, settings: c.settings, recipients: c.recipients });
  const f = (async (input: URL, init: RequestInit) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean);
    const name: Name =
      parts[1] === 'lists'
        ? 'lists'
        : method === 'GET' && parts.length === 2
          ? 'list'
          : method === 'GET' && parts.length === 3
            ? 'get'
            : method === 'GET' && parts[3] === 'content'
              ? 'content'
              : method === 'PUT'
                ? 'put'
                : method === 'PATCH'
                  ? 'patch'
                  : parts[4] === 'replicate'
                    ? 'replicate'
                    : parts[4] === 'schedule'
                      ? 'schedule'
                      : parts[4] === 'unschedule'
                        ? 'unschedule'
                        : 'other';
    calls.push({ name, method, path: url.pathname, auth: String((init.headers as Record<string, string>).Authorization ?? ''), fields: url.searchParams.get('fields') ?? '' });
    const mode = fail[name]?.shift();
    if (mode === 'refuse') return json(400, { title: 'Refused on purpose' });
    if (mode === 'drop') throw new TypeError('connection reset');
    const c = campaigns.get(parts[2] ?? '');
    let res: Response;
    if (name === 'lists') {
      res = json(200, { lists: [{ id: LIST, name: 'Example Fish List', stats: { member_count: 900 } }, { id: TEST_LIST, name: TEST_AUDIENCE, stats: { member_count: opts.memberCount ?? 1 } }] });
    } else if (name === 'list') {
      const st = url.searchParams.get('status');
      res = json(200, { campaigns: [...campaigns.values()].filter((x) => !x.hidden && x.status === st && x.recipients.list_id === url.searchParams.get('list_id')).map(view) });
      // A copy still being made shows up on the next list.
      for (const x of campaigns.values()) x.hidden = false;
    } else if (!c) res = json(404, { title: 'Not found' });
    else if (name === 'get') res = json(200, view(c));
    else if (name === 'content') {
      contentReadsSincePut++;
      // Mailchimp may build the plain text a moment after the PUT.
      if (hooks.plainAfterReads !== undefined && contentReadsSincePut >= hooks.plainAfterReads) c.plain_text = AUTO_TEXT(c.html);
      res = json(200, { html: c.html, plain_text: c.plain_text });
    }
    else if (name === 'replicate') {
      const copy = add({ ...structuredClone(c), id: `copy${String(++n).padStart(6, '0')}`, status: 'save', send_time: '', create_time: '2026-11-14T20:00:00+00:00' });
      copy.settings.title = `${c.settings.title} (copy 01)`;
      copy.recipients = { ...copy.recipients, recipient_count: opts.copyRecipients ?? 1 };
      if (mode === 'loseHidden') copy.hidden = true;
      res = json(200, view(copy));
    } else if (name === 'patch') {
      const body = JSON.parse(String(init.body)) as { settings: FakeCampaign['settings'] };
      c.settings = { ...c.settings, ...body.settings };
      res = json(200, view(c));
    } else if (name === 'put') {
      c.html = (JSON.parse(String(init.body)) as { html: string }).html;
      if (hooks.tidy) c.html = hooks.tidy(c.html);
      contentReadsSincePut = 0;
      if (opts.regenerate !== false && hooks.plainAfterReads === undefined) c.plain_text = AUTO_TEXT(c.html);
      hooks.onPut?.();
      res = json(200, { html: c.html });
    } else if (name === 'schedule') {
      if (c.status !== 'save') res = json(400, { title: 'Already scheduled' });
      else {
        c.status = 'schedule';
        c.send_time = (JSON.parse(String(init.body)) as { schedule_time: string }).schedule_time;
        res = json(204);
      }
    } else if (name === 'unschedule') {
      if (c.status !== 'schedule') res = json(400, { title: 'Not scheduled' });
      else {
        c.status = 'save';
        c.send_time = '';
        res = json(204);
      }
    } else res = json(400, { title: 'Unknown call' });
    if (mode === 'lose' || mode === 'loseHidden') throw new TypeError('connection reset');
    return res;
  }) as unknown as typeof fetch;
  // The fish list: a scheduled fish email and the last whole-list send.
  add({ id: 'fishsched1', status: 'schedule', send_time: '2026-11-16T14:00:00+00:00', settings: { title: 'Fish Email 20261116', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }, recipients: { list_id: LIST, recipient_count: 900 } });
  add({ id: WHOLE_LIST_SEND, status: 'sent', send_time: '2026-11-13T14:00:00+00:00', settings: { title: 'Fish Email 20261113', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }, recipients: { list_id: LIST, recipient_count: 900, segment_text: '', segment_opts: { conditions: [] } } });
  return { fetch: f, campaigns, calls, fail, hooks, add, writes: () => calls.filter((x) => x.method !== 'GET').map((x) => `${x.name} ${x.path.split('/')[3]}`) };
}

async function run(fk: ReturnType<typeof fake>, opts: { apply?: boolean; id?: string; now?: () => number; wholeListSend?: string | null } = {}) {
  const lines: string[] = [];
  const sleeps: number[] = [];
  const code = await liveTestJob({
    key: REAL_SHAPED_KEY,
    cfg: testConfig(),
    campaignId: opts.id ?? 'testcamp01',
    wholeListSend: opts.wholeListSend === undefined ? WHOLE_LIST_SEND : opts.wholeListSend,
    apply: opts.apply ?? false,
    now: opts.now ?? (() => NOW),
    print: (l) => lines.push(l),
    fetch: fk.fetch,
    env: {},
    execArgv: [],
    sleep: async (ms) => void sleeps.push(ms),
  });
  const out = lines.join('\n');
  assert.ok(!out.includes(REAL_SHAPED_KEY), 'the key is never printed');
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(out), 'no control characters printed');
  return { code, out, sleeps };
}

test('dry run: every read check passes, the plan is printed, nothing is written', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  const r = await run(fk);
  assert.equal(r.code, 0, r.out);
  assert.ok(fk.calls.every((c) => c.method === 'GET'));
  assert.match(r.out, /Test audience: "Cheese & Crackers TEST" \(testlist01\), 1 member\./);
  assert.match(r.out, new RegExp(`Last whole-list fish send ${WHOLE_LIST_SEND}: segment_opts read, segment in it: no; segment_text: ""`));
  // segment_text is asked for in that one read only.
  assert.ok(fk.calls.find((c) => c.path.endsWith(WHOLE_LIST_SEND))!.fields.includes('recipients.segment_text'));
  assert.ok(fk.calls.filter((c) => c.name === 'get' && !c.path.endsWith(WHOLE_LIST_SEND)).every((c) => !c.fields.includes('segment_text')));
  assert.match(r.out, /Scheduled on the fish list: "Fish Email 20261116" \(fishsched1\)\./);
  assert.match(r.out, /Planned on the copy: name "TEST ShelfReady do not send 20261122"; date line "Sunday, November 22, 2026"; Test King Salmon \(Testland\) \$24\.99 to \$25\.99/);
  assert.match(r.out, /CONFIRMED: segments: a whole-list fish send shows no segment/);
  assert.match(r.out, /NOT TESTED: segments: a segment send shows one/);
  assert.match(r.out, /Dry run\. Nothing was changed/);
});

test('--apply: copy, rename, put, schedule a week ahead, unschedule, all on the copy, each read back', async () => {
  const fk = fake();
  const source = fk.add({ id: 'testcamp01', status: 'save' });
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 0, r.out);
  const copy = fk.campaigns.get('copy000001')!;
  assert.deepEqual(fk.writes(), ['replicate testcamp01', 'patch copy000001', 'put copy000001', 'schedule copy000001', 'unschedule copy000001']);
  assert.equal(copy.status, 'save');
  assert.equal(copy.settings.title, 'TEST ShelfReady do not send 20261122');
  assert.equal(copy.settings.preview_text, 'Order by 7pm');
  assert.ok(copy.html.includes('Sunday, November 22, 2026'));
  assert.equal(source.html, FIXTURE_HTML);
  assert.equal(source.settings.title, TEST_TITLE);
  // Scheduled for a quarter hour more than seven days ahead.
  const sched = fk.calls.find((c) => c.name === 'schedule');
  assert.ok(sched);
  for (const item of ['title: PATCH keeps', 'replicate: the copy holds the source HTML', 'content: a PUT of only the HTML gets a new plain text', 'unschedule: the status is save', 'replicate: the copy is a draft on the same audience', 'Mailchimp accepts the key']) {
    assert.match(r.out, new RegExp(`CONFIRMED: ${item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }
  assert.match(r.out, /delete both test campaigns by hand: testcamp01 and copy000001/);
  assert.ok(fk.calls.every((c) => c.auth === `Bearer ${REAL_SHAPED_KEY}`));
});

test('--apply: a plain text Mailchimp did not make again is reported as contradicted', async () => {
  const fk = fake({ regenerate: false });
  fk.add({ id: 'testcamp01', status: 'save' });
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Plain text was NOT made again/);
  assert.match(r.out, /CONTRADICTED: content: a PUT of only the HTML gets a new plain text/);
});

test('guards before anything: wrong audience, two recipients, two members, a fish list campaign, wrong title, not a draft', async () => {
  const cases: Array<[string, (fk: ReturnType<typeof fake>) => void, RegExp, { memberCount?: number; id?: string }]> = [
    ['wrong audience', (fk) => fk.add({ id: 'testcamp01', status: 'save', recipients: { list_id: 'otherlist1', recipient_count: 1 } }), /on list otherlist1, not the TEST audience/, {}],
    ['recipient_count 2', (fk) => fk.add({ id: 'testcamp01', status: 'save', recipients: { list_id: TEST_LIST, recipient_count: 2 } }), /has 2 recipients, not exactly 1/, {}],
    ['two members', (fk) => fk.add({ id: 'testcamp01', status: 'save' }), /has 2 members, not exactly 1/, { memberCount: 2 }],
    ['a fish list campaign', () => {}, /on list list000001, not the TEST audience/, { id: 'fishsched1' }],
    ['wrong title', (fk) => fk.add({ id: 'testcamp01', status: 'save', settings: { title: 'Fish Email 20261116', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' } }), /not exactly "TEST ShelfReady, do not send"/, {}],
    ['not a draft', (fk) => fk.add({ id: 'testcamp01', status: 'schedule' }), /not a draft/, {}],
  ];
  for (const [name, set, re, o] of cases) {
    const fk = fake({ memberCount: o.memberCount });
    set(fk);
    const r = await run(fk, { apply: true, id: o.id });
    assert.equal(r.code, 2, name);
    assert.match(r.out, re, name);
    assert.deepEqual(fk.writes(), [], name);
  }
});

test('guard on the copy: a copy with two recipients stops before any change to it, loudly', async () => {
  const fk = fake({ copyRecipients: 2 });
  fk.add({ id: 'testcamp01', status: 'save' });
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /copy000001 is on list testlist01 with 2 recipients, not the TEST audience with 1/);
  assert.deepEqual(fk.writes(), ['replicate testcamp01']);
  assert.match(r.out, /Delete the test campaigns by hand once checked: testcamp01 and the copy copy000001/);
});

test('guard: never a schedule under 24 hours ahead', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  // The clock jumps seven and a half days after the PUT, so the planned time is under 24 hours away.
  let jumped = false;
  fk.hooks.onPut = () => {
    jumped = true;
  };
  const r = await run(fk, { apply: true, now: () => (jumped ? NOW + 7.5 * 86400_000 : NOW) });
  assert.equal(r.code, 1);
  assert.match(r.out, /the schedule time is less than 24 hours ahead/);
  assert.ok(!fk.writes().some((w) => w.startsWith('schedule')));
  assert.equal(fk.campaigns.get('copy000001')!.status, 'save');
});

test('a failure after the schedule leaves the copy unscheduled, and says so loudly', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  fk.fail.unschedule = ['refuse', 'refuse'];
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAILED: the copy did not unschedule/);
  assert.match(r.out, /The copy copy000001 was unscheduled again/);
  assert.equal(fk.campaigns.get('copy000001')!.status, 'save');
});

test('the allowlist: per phase, anything else is refused before it leaves', async () => {
  let reached = 0;
  const inner = (async () => {
    reached++;
    return new Response('{"id":"copy000001","status":"save"}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = (allowed: ReturnType<typeof copyCalls>) => {
    const g = guardFetch(inner, allowed);
    return { g, api: createMailchimpClient({ key: () => REAL_SHAPED_KEY, fetch: g.fetch, env: {}, execArgv: [], allowWrites: true, now: () => NOW }) };
  };
  const copying = client(copyCalls('testcamp01'));
  await assert.rejects(copying.api.replicate('fishsched1'));
  await assert.rejects(copying.api.putContent('testcamp01', 'x'.repeat(200)));
  await assert.rejects(copying.api.schedule('testcamp01', '2026-11-22T14:00:00+00:00'));
  await assert.rejects(copying.api.unschedule('fishsched1'));
  assert.equal(reached, 0);
  const editing = client(editCalls('copy000001'));
  await assert.rejects(editing.api.putContent('testcamp01', 'x'.repeat(200)));
  await assert.rejects(editing.api.unschedule('fishsched1'));
  await assert.rejects(editing.api.replicate('copy000001'));
  await assert.rejects(editing.api.listAudiences());
  assert.equal(reached, 0);
  await editing.api.unschedule('copy000001');
  assert.equal(reached, 1);
  assert.throws(() => editCalls('../lists'));
});

test('the schedule time: a quarter hour, more than seven days ahead', () => {
  const at = quarterAfter(NOW + 7 * 60_000, 8 * 86400_000);
  assert.equal(at % (15 * 60_000), 0);
  assert.ok(at - NOW >= 8 * 86400_000);
});

test('a proxy or risky TLS setting, or a bad id: stops before anything is sent', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  for (const env of [{ HTTPS_PROXY: 'http://proxy.example:8080' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
    const code = await liveTestJob({ key: REAL_SHAPED_KEY, cfg: testConfig(), campaignId: 'testcamp01', wholeListSend: WHOLE_LIST_SEND, apply: true, now: () => NOW, print: () => {}, fetch: fk.fetch, env, execArgv: [] });
    assert.equal(code, 2);
  }
  const code = await liveTestJob({ key: REAL_SHAPED_KEY, cfg: testConfig(), campaignId: '../lists', wholeListSend: WHOLE_LIST_SEND, apply: true, now: () => NOW, print: () => {}, fetch: fk.fetch, env: {}, execArgv: [] });
  assert.equal(code, 2);
  assert.equal(fk.calls.length, 0);
});

test('the segment item is not tested when the reply has no segment_opts', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  delete fk.campaigns.get(WHOLE_LIST_SEND)!.recipients.segment_opts;
  const r = await run(fk);
  assert.equal(r.code, 0);
  assert.match(r.out, /segment_opts NOT in the reply/);
  assert.match(r.out, /NOT TESTED: segments: a whole-list fish send shows no segment in segment_opts\. the reply did not include segment_opts/);
});

test('with no whole-list send named in the local config, the segment item is not tested and that read is not made', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  const r = await run(fk, { wholeListSend: null });
  assert.equal(r.code, 0);
  assert.match(r.out, /add campaigns\.liveTestWholeListSend to config\/local\/mailchimp\.json/);
  assert.match(r.out, /NOT TESTED: segments: a whole-list fish send shows no segment in segment_opts\. no whole-list send was named/);
  assert.ok(!fk.calls.some((c) => c.path.endsWith(WHOLE_LIST_SEND)));
});

test('a lost copy found on a later look is used, and never copied twice', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  fk.fail.replicate = ['loseHidden'];
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Found the copy on a later look: copy000001/);
  assert.equal(fk.writes().filter((w) => w.startsWith('replicate')).length, 1);
  assert.deepEqual(r.sleeps.slice(0, 1), [10_000]);
  assert.equal(fk.campaigns.get('copy000001')!.status, 'save');
});

test('a lost copy never found: three looks, a loud failure, and no second copy', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  fk.fail.replicate = ['drop'];
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /after 3 looks 0 drafts look like it\. No second copy was made/);
  assert.deepEqual(fk.writes(), ['replicate testcamp01']);
  assert.deepEqual(r.sleeps, [10_000, 10_000]);
  assert.equal(fk.calls.filter((c) => c.name === 'list' && c.path === '/3.0/campaigns').length, 1 + 3);
});

test('Mailchimp tidies the HTML: byte for byte is contradicted, with the first difference, and the test carries on', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  fk.hooks.tidy = (h) => h.replace('<body style=', '<body  style=');
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CONTRADICTED: content: a PUT of HTML reads back byte for byte\. first difference at character \d+: sent "/);
  assert.ok(fk.writes().includes('schedule copy000001'));
  assert.ok(fk.writes().includes('unschedule copy000001'));
  assert.match(r.out, /CONFIRMED: unschedule: the status is save/);
});

test('a plain text Mailchimp builds a moment later is seen on a later read', async () => {
  const fk = fake();
  fk.add({ id: 'testcamp01', status: 'save' });
  fk.hooks.plainAfterReads = 4;
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /CONFIRMED: content: a PUT of only the HTML gets a new plain text from Mailchimp\. the plain text shows the new date line and price\. Look at the plain text in Mailchimp too/);
  assert.ok(r.sleeps.filter((x) => x === 10_000).length >= 1);
});
