// The Mailchimp client: only the allowed calls go out, the key never shows, and nothing is sent
// in a risky environment. No test reaches the real Mailchimp: fetch is faked, or the fake server
// on 127.0.0.1 answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailchimpClient, MailchimpError, scrub, setupProblem } from '../src/mailchimp/client.ts';
import { REAL_SHAPED_KEY, startFakeMailchimp, TEST_KEY } from './mailchimp-fixtures.ts';

const NOW = Date.parse('2026-11-09T19:00:00Z');

function recordingFetch(reply: (url: URL, init: RequestInit) => Response = () => new Response('{"id":"abc123def0","status":"save"}', { status: 200 })) {
  const seen: Array<{ url: URL; init: RequestInit }> = [];
  const f = (async (url: URL, init: RequestInit) => {
    seen.push({ url, init });
    return reply(url, init);
  }) as unknown as typeof fetch;
  return { f, seen };
}

test('the host comes from the key, the key goes only in the Authorization header, and redirects are refused', async () => {
  const { f, seen } = recordingFetch();
  const c = createMailchimpClient({ key: () => REAL_SHAPED_KEY, fetch: f, now: () => NOW, env: {} });
  await c.getCampaign('abc123def0');
  assert.equal(seen[0]!.url.origin, 'https://us9.api.mailchimp.com');
  assert.equal(seen[0]!.url.pathname, '/3.0/campaigns/abc123def0');
  assert.equal(seen[0]!.init.redirect, 'error');
  assert.equal((seen[0]!.init.headers as Record<string, string>).Authorization, `Bearer ${REAL_SHAPED_KEY}`);
  assert.ok(!seen[0]!.url.href.includes(REAL_SHAPED_KEY));
});

test('only allowed calls and shapes are sent', async () => {
  const { f, seen } = recordingFetch();
  const c = createMailchimpClient({ key: () => REAL_SHAPED_KEY, fetch: f, now: () => NOW, env: {}, allowWrites: true });
  await assert.rejects(c.getCampaign('../lists/x'), (e: MailchimpError) => e.kind === 'setup');
  await assert.rejects(c.setTitle('abc123def0', { title: 'Something Else', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }), /not the shape/);
  await assert.rejects(c.setTitle('abc123def0', { title: 'Fish Email 20261116', subject_line: 's\u0000', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }), /not the shape/);
  await assert.rejects(c.putContent('abc123def0', 'short'), /not the shape/);
  // Not on a quarter hour, in the past, or too far ahead.
  await assert.rejects(c.schedule('abc123def0', '2026-11-11T14:10:00+00:00'), /not the shape/);
  await assert.rejects(c.schedule('abc123def0', '2026-11-08T14:00:00+00:00'), /not the shape/);
  // Less than 10 minutes ahead: refused, like the worker's own lead time.
  await assert.rejects(c.schedule('abc123def0', '2026-11-09T19:00:00+00:00'), /not the shape/);
  // Empty subject, sender or reply-to: refused.
  for (const blank of ['subject_line', 'from_name', 'reply_to']) {
    await assert.rejects(c.setTitle('abc123def0', { title: 'Fish Email 20261116', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '', [blank]: ' ' }), /not the shape/);
  }
  await assert.rejects(c.schedule('abc123def0', '2026-12-30T14:00:00+00:00'), /not the shape/);
  await assert.rejects(c.listCampaigns({ listId: 'x', status: 'sent', sortField: 'send_time', count: 5 }), /list id/);
  assert.equal(seen.length, 0, 'nothing reached fetch');
  await c.schedule('abc123def0', '2026-11-11T14:00:00+00:00');
  await c.setTitle('abc123def0', { title: 'Fish Email 20261116', subject_line: 'Fish 🐟 list', from_name: 'f', reply_to: 'r@example.com', preview_text: 'p', to_name: '*|FNAME|*' });
  assert.deepEqual(
    seen.map((s) => `${s.init.method} ${s.url.pathname}`),
    ['POST /3.0/campaigns/abc123def0/actions/schedule', 'PATCH /3.0/campaigns/abc123def0'],
  );
  assert.deepEqual(JSON.parse(String(seen[1]!.init.body)), { settings: { title: 'Fish Email 20261116', subject_line: 'Fish 🐟 list', from_name: 'f', reply_to: 'r@example.com', preview_text: 'p', to_name: '*|FNAME|*' } });
});

test('with Mailchimp writes off (the default), every change is refused before it is sent; reads still go', async () => {
  const { f, seen } = recordingFetch();
  const c = createMailchimpClient({ key: () => REAL_SHAPED_KEY, fetch: f, now: () => NOW, env: {} });
  for (const call of [
    () => c.replicate('abc123def0'),
    () => c.unschedule('abc123def0'),
    () => c.schedule('abc123def0', '2026-11-11T14:00:00+00:00'),
    () => c.putContent('abc123def0', 'x'.repeat(200)),
    () => c.setTitle('abc123def0', { title: 'Fish Email 20261116', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }),
  ]) {
    await assert.rejects(call(), (e: MailchimpError) => e.kind === 'setup' && /changes are off/.test(e.message));
  }
  assert.equal(seen.length, 0);
  await c.getCampaign('abc123def0');
  assert.equal(seen.length, 1);
});

test('nothing is sent without a usable key, with a proxy, with risky TLS settings, or to a test address off this PC', async () => {
  const { f, seen } = recordingFetch();
  const cases: Array<[Parameters<typeof createMailchimpClient>[0], RegExp]> = [
    [{ key: () => undefined, fetch: f, env: {} }, /No Mailchimp API key/],
    [{ key: () => 'not-a-key', fetch: f, env: {} }, /does not look like/],
    [{ key: () => { throw new Error('damaged'); }, fetch: f, env: {} }, /damaged/],
    [{ key: () => REAL_SHAPED_KEY, fetch: f, env: { HTTPS_PROXY: 'http://proxy.example:8080' } }, /proxy/],
    [{ key: () => REAL_SHAPED_KEY, fetch: f, env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }, /proxy or certificate/],
    [{ key: () => REAL_SHAPED_KEY, fetch: f, env: {}, execArgv: ['--use-env-proxy'] }, /proxy or certificate/],
    [{ key: () => TEST_KEY, fetch: f, env: {}, testOrigin: 'http://10.0.0.5:9000' }, /127\.0\.0\.1/],
    // A real key is never sent to a test address, and a test key never goes anywhere else.
    [{ key: () => REAL_SHAPED_KEY, fetch: f, env: {}, testOrigin: 'http://127.0.0.1:9000' }, /only with a test key/],
    [{ key: () => TEST_KEY, fetch: f, env: {} }, /is a test key/],
  ];
  for (const [opts, re] of cases) {
    assert.match(setupProblem(opts) ?? '', re);
    await assert.rejects(createMailchimpClient(opts).getCampaign('abc123def0'), (e: MailchimpError) => e.kind === 'setup' && re.test(e.message) && !e.message.includes(REAL_SHAPED_KEY));
  }
  assert.equal(seen.length, 0);
});

test('errors: 4xx is refused, 5xx and no answer are unknown, and the key never appears', async () => {
  let mode = 'refuse';
  const { f } = recordingFetch(() => {
    if (mode === 'refuse') return new Response(JSON.stringify({ title: `Bad key ${REAL_SHAPED_KEY} <script>`, detail: REAL_SHAPED_KEY }), { status: 401 });
    if (mode === '500') return new Response('oops', { status: 503 });
    throw new TypeError(`connect failed Authorization: Bearer ${REAL_SHAPED_KEY}`);
  });
  const c = createMailchimpClient({ key: () => REAL_SHAPED_KEY, fetch: f, now: () => NOW, env: {}, allowWrites: true });
  await assert.rejects(c.unschedule('abc123def0'), (e: MailchimpError) => e.kind === 'refused' && e.status === 401 && !e.message.includes(REAL_SHAPED_KEY) && !e.message.includes('<') && e.message.includes('[redacted]'));
  mode = '500';
  await assert.rejects(c.unschedule('abc123def0'), (e: MailchimpError) => e.kind === 'unknown' && !e.message.includes('oops'));
  mode = 'throw';
  await assert.rejects(c.unschedule('abc123def0'), (e: MailchimpError) => e.kind === 'unknown' && !e.message.includes(REAL_SHAPED_KEY) && !e.message.includes('Bearer'));
  assert.equal(scrub(`x ${REAL_SHAPED_KEY} y 0123456789abcdef0123456789abcdef`, undefined), 'x [redacted] y [redacted]');
});

test('the fake Mailchimp on 127.0.0.1: list, read, and the key in the header only', async () => {
  const fake = await startFakeMailchimp(() => NOW);
  try {
    fake.add({ id: 'sent000001', status: 'sent', send_time: '2026-11-09T14:00:00+00:00' });
    const c = createMailchimpClient({ key: () => TEST_KEY, testOrigin: fake.origin, now: () => NOW, env: {} });
    const list = await c.listCampaigns({ listId: 'list000001', status: 'sent', sortField: 'send_time', count: 10 });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.sendTime, Date.parse('2026-11-09T14:00:00Z'));
    assert.ok((await c.getContent('sent000001')).includes('Sea Bass'));
    assert.ok(fake.calls.every((x) => x.auth === `Bearer ${TEST_KEY}`));
    assert.ok(fake.calls.every((x) => !x.path.includes(TEST_KEY)));
  } finally {
    await fake.close();
  }
});
