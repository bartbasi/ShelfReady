// The one-off script that removes one row from Wednesday's fish email. A fake fetch stands in for
// Mailchimp: no network. Invented email content; only the row name is the one Bart named.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailchimpClient } from '../src/mailchimp/client.ts';
import { checkRemoval, parseRows, removeRow } from '../src/mailchimp/html.ts';
import { guardFetch, LOOK_CALLS, plainTextIsMailchimps, removeRowJob, ROW_KEY, writeCalls } from '../scripts/mailchimp/remove-row.ts';
import { SOURCE_NAME } from '../scripts/mailchimp/make-wednesday.ts';
import { LIST, REAL_SHAPED_KEY, realCampaignFile, testConfig } from './mailchimp-fixtures.ts';

const REAL = realCampaignFile(SOURCE_NAME);

const Z = (s: string): number => Date.parse(s);
const NOW = Z('2026-11-10T20:00:00Z'); // Tuesday 2pm Chicago.
const WED = '2026-11-11T14:00:00+00:00';
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

// An invented email built like the fish email: every row has a bottom divider except the last
// row of each section.
const DIVIDER = 'border-bottom:1px solid #d0cdc5;';
interface R {
  price: string;
  unit: string;
  name: string;
  origin?: string;
}
const SECTIONS: Array<{ name: string; rows: R[] }> = [
  { name: 'Salmon &amp; trout', rows: [{ price: '$24.99', unit: '/lb', name: 'Test King Salmon', origin: 'Testland' }, { price: '$18.99', unit: '/lb', name: 'Test Atlantic Salmon' }] },
  { name: 'For the chef', rows: [{ price: '$12.99', unit: '/unit', name: 'Example Fish Stock', origin: '16 oz' }, { price: '$16.99', unit: '/unit', name: 'Bart&#39;s Lobster Stock', origin: '8 oz (1 cup)' }] },
  { name: 'Shellfish', rows: [{ price: '$5.99', unit: '/doz', name: 'Littlenecks' }, { price: '$39.99', unit: '/can', name: 'Crab Meat', origin: '1 lb can' }] },
];
function rowHtml(r: R, last: boolean, style?: string): string {
  return `<tr><td style="${style ?? `padding:11px 0;${last ? '' : DIVIDER}font:13px/19px Arial,sans-serif;color:#555`}"><b style="float:right;color:#c82c2c">${r.price}<small>${r.unit}</small></b><b style="font:700 17px/22px Georgia,serif">${r.name}</b>${r.origin ? `<span style="color:#888"> (${r.origin})</span>` : ''}<br>An invented line.</td></tr>`;
}
function build(sections = SECTIONS, style?: (section: number, row: number) => string | undefined): string {
  const body = sections
    .map((sec, si) => `<div style="margin:34px 0 0"><span style="font:24px/30px Georgia,serif">${sec.name}</span></div><table role="presentation" width="100%">${sec.rows.map((r, ri) => rowHtml(r, ri === sec.rows.length - 1, style?.(si, ri))).join('')}</table>`)
    .join('');
  return `<!DOCTYPE html><html><body><table class="wrap" width="600"><tr><td>Example Fish Market</td></tr><tr><td class="pad">${body}</td></tr></table></body></html>`;
}
const without = (name: string): Array<{ name: string; rows: R[] }> => SECTIONS.map((sec) => ({ ...sec, rows: sec.rows.filter((r) => !r.name.includes(name)) }));
/** The email with the row, and what it must become. */
const WITH = build();
const EXPECTED = build(without('Lobster Stock'));
const AUTO_TEXT = '** The Fish List\n------------------------------------------------------------\nSea Bass $31.99/lb\n';

interface FakeCampaign {
  id: string;
  status: string;
  send_time: string;
  create_time: string;
  settings: { title: string };
  recipients: { list_id: string };
  html: string;
  plain_text: string;
}

type Name = 'list' | 'get' | 'content' | 'put' | 'unschedule' | 'schedule' | 'other';

function fake(now: number) {
  const campaigns = new Map<string, FakeCampaign>();
  const calls: Array<{ name: Name; method: string; path: string; body: string }> = [];
  const fail: Partial<Record<Name, Array<'refuse' | 'lose'>>> = {};
  let onPut: ((html: string) => string) | null = null;
  const opts = { unscheduleTo: 'save' };
  const add = (c: Partial<FakeCampaign> & { id: string; status: string }): FakeCampaign => {
    const full: FakeCampaign = { send_time: '', create_time: iso(now - 3600_000), settings: { title: 'Fish Email 20261016 (copy 11)' }, recipients: { list_id: LIST }, html: WITH, plain_text: AUTO_TEXT, ...c };
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
      method === 'GET' && parts.length === 2 ? 'list' : method === 'GET' && parts.length === 3 ? 'get' : method === 'GET' && parts[3] === 'content' ? 'content' : method === 'PUT' ? 'put' : parts[4] === 'unschedule' ? 'unschedule' : parts[4] === 'schedule' ? 'schedule' : 'other';
    calls.push({ name, method, path: url.pathname, body: String(init.body ?? '') });
    const mode = fail[name]?.shift();
    if (mode === 'refuse') return json(400, { title: 'Refused on purpose' });
    const c = campaigns.get(parts[2] ?? '');
    let res: Response;
    if (name === 'list') {
      const st = url.searchParams.get('status');
      res = json(200, { campaigns: [...campaigns.values()].filter((x) => x.status === st && x.recipients.list_id === url.searchParams.get('list_id')).map(view) });
    } else if (!c) res = json(404, { title: 'Not found' });
    else if (name === 'get') res = json(200, view(c));
    else if (name === 'content') res = json(200, { html: c.html, plain_text: c.plain_text });
    else if (name === 'put') {
      if (c.status === 'schedule') res = json(400, { title: 'Cannot update a scheduled campaign' });
      else {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body), ['html'], 'only html is sent');
        c.html = onPut ? onPut(body.html as string) : (body.html as string);
        c.plain_text = c.html.includes('Lobster Stock') ? AUTO_TEXT + 'Lobster Stock\n' : AUTO_TEXT;
        res = json(200, { html: c.html });
      }
    } else if (name === 'unschedule') {
      if (c.status !== 'schedule') res = json(400, { title: 'Not scheduled' });
      else {
        c.status = opts.unscheduleTo;
        c.send_time = '';
        res = json(204);
      }
    } else if (name === 'schedule') {
      const t = (JSON.parse(String(init.body)) as { schedule_time: string }).schedule_time;
      if (c.status === 'schedule') res = json(400, { title: 'Already scheduled' });
      else {
        c.status = 'schedule';
        c.send_time = t;
        res = json(204);
      }
    } else res = json(400, { title: 'Unknown call' });
    if (mode === 'lose') throw new TypeError('connection reset');
    return res;
  }) as unknown as typeof fetch;
  return {
    fetch: f,
    campaigns,
    calls,
    fail,
    opts,
    add,
    setOnPut(fn: (html: string) => string) {
      onPut = fn;
    },
    writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.name} ${c.path.split('/')[3]}`),
  };
}

const SENT = { id: 'sent000001', status: 'sent', send_time: '2026-11-09T14:00:00+00:00', create_time: '2026-11-09T05:03:24+00:00', settings: { title: 'Fish Email 20261016 (copy 10)' } };

async function run(fk: ReturnType<typeof fake>, opts: { apply?: boolean; now?: number } = {}) {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-rm-'));
  const code = await removeRowJob({ key: REAL_SHAPED_KEY, cfg: testConfig(), apply: opts.apply ?? false, now: () => opts.now ?? NOW, print: (l) => lines.push(l), backupDir: join(dir, 'backups'), fetch: fk.fetch, env: {}, execArgv: [] });
  const out = lines.join('\n');
  assert.ok(!out.includes(REAL_SHAPED_KEY), 'the key is never printed');
  return { code, out, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the last row of its section: the row and the new last row\'s divider go, nothing else', () => {
  const r = removeRow(WITH, ROW_KEY);
  assert.equal(r.kind, 'removed');
  if (r.kind !== 'removed') return;
  assert.equal(r.html, EXPECTED);
  assert.deepEqual(r.cuts.map((c) => c.what), ['divider', 'row']);
  assert.equal(r.cuts[0]!.text, DIVIDER);
  assert.equal(r.dividerFrom, 'Example Fish Stock (16 oz)');
  assert.deepEqual(checkRemoval(WITH, r.html, ROW_KEY, r.cuts), []);
  assert.equal(parseRows(r.html).length, parseRows(WITH).length - 1);
  // checkRemoval allows exactly those two cuts: one more changed byte anywhere fails it.
  assert.notDeepEqual(checkRemoval(WITH, r.html.replace('Crab Meat', 'Crab  Meat'), ROW_KEY, r.cuts), []);
  assert.notDeepEqual(checkRemoval(WITH, r.html.replace('$39.99', '$39.98'), ROW_KEY, r.cuts), []);
  // A divider cut that is not one declaration inside a cell is refused.
  const bad = r.cuts.map((c) => (c.what === 'divider' ? { ...c, end: c.end + 4, text: WITH.slice(c.start, c.end + 4) } : c));
  assert.notDeepEqual(checkRemoval(WITH, WITH.slice(0, bad[0]!.start) + WITH.slice(bad[0]!.end, bad[1]!.start) + WITH.slice(bad[1]!.end), ROW_KEY, bad), []);
});

test('a row in the middle of its section: only the row goes, no divider changes', () => {
  const key = 'Example Fish Stock (16 oz)';
  const r = removeRow(WITH, key);
  assert.equal(r.kind, 'removed');
  if (r.kind !== 'removed') return;
  assert.deepEqual(r.cuts.map((c) => c.what), ['row']);
  assert.equal(r.dividerFrom, null);
  assert.equal(r.html, build(without('Example Fish Stock')));
  assert.deepEqual(checkRemoval(WITH, r.html, key, r.cuts), []);
});

test('an unexpected divider shape: stops and removes nothing, never the row alone', () => {
  // The row above has one more difference than a divider.
  const extra = build(SECTIONS, (si, ri) => (si === 1 && ri === 0 ? `padding:11px 0;${DIVIDER}background:#eee;font:13px/19px Arial,sans-serif;color:#555` : undefined));
  // The row above has a divider of another kind.
  const top = build(SECTIONS, (si, ri) => (si === 1 && ri === 0 ? 'padding:11px 0;border-top:1px solid #d0cdc5;font:13px/19px Arial,sans-serif;color:#555' : undefined));
  // The other sections' last rows are not built the same.
  const mixed = build(SECTIONS, (si, ri) => (si === 2 && ri === 1 ? 'padding:12px 0;font:13px/19px Arial,sans-serif;color:#555' : undefined));
  // No other section to compare with.
  const alone = build([SECTIONS[1]!]);
  for (const h of [extra, top, mixed, alone]) {
    const r = removeRow(h, ROW_KEY);
    assert.equal(r.kind, 'refused', h.slice(0, 60));
  }
  // The other shapes still refuse.
  const shared = WITH.replace('<br>An invented line.</td></tr></table><div style="margin:34px 0 0"><span style="font:24px/30px Georgia,serif">Shellfish', '<br>Line.<table><tr><td>x</td></tr></table></td></tr></table><div style="margin:34px 0 0"><span style="font:24px/30px Georgia,serif">Shellfish');
  assert.equal(removeRow(shared, ROW_KEY).kind, 'refused');
  assert.equal(removeRow(build(without('Lobster Stock')), ROW_KEY).kind, 'absent');
});

test('the real saved email: the lobster stock row and Fish Stock\'s divider, nothing else', { skip: !existsSync(REAL) && 'no saved campaign in data/mailchimp' }, () => {
  const html = readFileSync(REAL, 'utf8');
  const r = removeRow(html, ROW_KEY);
  assert.equal(r.kind, 'removed');
  if (r.kind !== 'removed') return;
  assert.deepEqual(r.cuts.map((c) => [c.what, c.what === 'divider' ? c.text : '']), [['divider', 'border-bottom:1px solid #d0cdc5;'], ['row', '']]);
  assert.equal(r.dividerFrom, "Bart's Fish Stock (16 oz (2 cups))");
  assert.deepEqual(checkRemoval(html, r.html, ROW_KEY, r.cuts), []);
});

test('no candidate: stops and says why, reading only', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'pause00001', status: 'paused' });
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 2);
  assert.match(r.out, /no draft or scheduled fish email made after "Fish Email 20261016 \(copy 10\)" yet/);
  assert.deepEqual(fk.writes(), []);
});

test('two candidates: stops', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'draft00001', status: 'save' });
  fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 2);
  assert.match(r.out, /there are 2 draft or scheduled fish emails/);
  assert.deepEqual(fk.writes(), []);
});

test('older drafts, other lists and other titles are not candidates', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'olddraft01', status: 'save', create_time: '2026-11-01T00:00:00+00:00' });
  fk.add({ id: 'otherlist1', status: 'save', recipients: { list_id: 'otherlist1' } });
  fk.add({ id: 'turkey0001', status: 'save', settings: { title: 'Turkey Special' } });
  const r = await run(fk);
  r.cleanup();
  assert.equal(r.code, 2);
  assert.match(r.out, /no draft or scheduled fish email made after/);
});

test('scheduled for the wrong time: stops', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'sched00001', status: 'schedule', send_time: '2026-11-11T14:15:00+00:00' });
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 2);
  assert.match(r.out, /scheduled for Wed 2026-11-11 08:15 America\/Chicago, not Wed 2026-11-11 08:00/);
  assert.deepEqual(fk.writes(), []);
});

test('inside the cutoff (after 7:00am Wednesday): stops', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  const r = await run(fk, { apply: true, now: Z('2026-11-11T13:05:00Z') });
  r.cleanup();
  assert.equal(r.code, 2);
  assert.match(r.out, /inside the 60-minute cutoff/);
  assert.deepEqual(fk.writes(), []);
});

test('the row is not there: says so, changes nothing, exits 0', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'draft00001', status: 'save', html: EXPECTED });
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 0);
  assert.match(r.out, /is not in this email\. Nothing to do/);
  assert.deepEqual(fk.writes(), []);
});

test('plain text written by hand: stops, since new HTML would replace it', async () => {
  assert.ok(plainTextIsMailchimps(AUTO_TEXT));
  assert.ok(plainTextIsMailchimps(''));
  assert.ok(!plainTextIsMailchimps('Hi all, fresh fish this week. Call us.'));
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'draft00001', status: 'save', plain_text: 'Hi all, fresh fish this week.' });
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 2);
  assert.match(r.out, /plain text looks written by hand/);
  assert.deepEqual(fk.writes(), []);
});

test('dry run: prints the target, the row and the markup, and only reads', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  const r = await run(fk);
  r.cleanup();
  assert.equal(r.code, 0);
  assert.match(r.out, /Target: "Fish Email 20261016 \(copy 11\)" \(sched00001\), status schedule, send time Wed 2026-11-11 08:00 America\/Chicago\./);
  assert.match(r.out, /Row to remove: "Bart's Lobster Stock \(8 oz \(1 cup\)\)", \$16\.99\/unit/);
  assert.match(r.out, /  - <tr><td/);
  assert.match(r.out, /Divider removed from "Example Fish Stock \(16 oz\)", now the last row of its section/);
  assert.match(r.out, /  - border-bottom:1px solid #d0cdc5;/);
  assert.match(r.out, /Dry run\. Nothing was changed/);
  assert.ok(fk.calls.every((c) => c.method === 'GET'));
});

test('a draft: one PUT of the HTML only, read back, with a private backup first', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  const c = fk.add({ id: 'draft00001', status: 'save' });
  const original = c.html;
  const r = await run(fk, { apply: true });
  try {
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(fk.writes(), ['put draft00001']);
    assert.equal(c.html, EXPECTED);
    assert.equal(c.status, 'save');
    assert.match(r.out, /the row is gone and the rest is byte for byte the same/);
    const dir = join(r.dir, 'backups');
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, files[0]!)).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(dir, files[0]!), 'utf8'), original);
  } finally {
    r.cleanup();
  }
});

test('scheduled: unschedule, PUT, schedule again for the same time, each read back', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  const c = fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(fk.writes(), ['unschedule sched00001', 'put sched00001', 'schedule sched00001']);
  assert.equal(c.status, 'schedule');
  assert.equal(c.send_time, WED);
  assert.equal(c.html, EXPECTED);
  assert.match(r.out, /Scheduled again for Wed 2026-11-11 08:00/);
});

test('scheduled, and the PUT fails after the unschedule: scheduled again anyway, with a loud failure', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  const c = fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  const before = c.html;
  fk.fail.put = ['refuse'];
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 1);
  assert.equal(c.status, 'schedule');
  assert.equal(c.send_time, WED);
  assert.equal(c.html, before);
  assert.match(r.out, /\*+ FAILED \*+/);
  assert.match(r.out, /The row was NOT removed/);
  assert.match(r.out, /Scheduled again for Wed 2026-11-11 08:00/);
  assert.deepEqual(fk.writes(), ['unschedule sched00001', 'put sched00001', 'schedule sched00001']);
});

test('scheduled, and the schedule fails twice: says IT IS NOT SCHEDULED', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  fk.fail.schedule = ['refuse', 'refuse'];
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 1);
  assert.match(r.out, /IT IS NOT SCHEDULED/);
});

test('an odd status after the unschedule: no PUT, and every failure is printed, including IT IS NOT SCHEDULED', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  fk.opts.unscheduleTo = 'sending';
  fk.fail.schedule = ['refuse', 'refuse'];
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 1);
  assert.match(r.out, /\*+ FAILED \*+/);
  assert.match(r.out, /After the unschedule the campaign is "sending", so the row was not removed/);
  assert.match(r.out, /IT IS NOT SCHEDULED/);
  assert.ok(!fk.writes().some((w) => w.startsWith('put ')), 'no PUT');
});

test('terminal escapes hidden in the email never reach the terminal', async () => {
  const sneaky = SECTIONS.map((sec, si) =>
    si === 1
      ? { name: 'For the chef&#27;]0;owned&#7;', rows: [{ ...sec.rows[0]!, name: 'Example Fish Stock\u001b[8m' }, sec.rows[1]!] }
      : si === 2
        ? { ...sec, name: '\u001b[8m\u202eShellfish' }
        : sec,
  );
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'draft00001', status: 'save', html: build(sneaky) });
  const r = await run(fk);
  r.cleanup();
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(r.out), r.out);
  assert.match(r.out, /Markup removed/);
});

test('a lost answer to the PUT is read back, not sent again', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  const c = fk.add({ id: 'draft00001', status: 'save' });
  fk.fail.put = ['lose'];
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 0, r.out);
  assert.equal(c.html, EXPECTED);
  assert.deepEqual(fk.writes(), ['put draft00001']);
});

test('verify mismatch: Mailchimp holds something other than expected, and it says so', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  fk.setOnPut((h) => h.replace('</body>', ' </body>'));
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 1);
  assert.match(r.out, /not exactly the expected one/);
  assert.match(r.out, /Scheduled again for/);
});

test('the unschedule fails: nothing is changed, and it says the email goes as it was', async () => {
  const fk = fake(NOW);
  fk.add(SENT);
  const c = fk.add({ id: 'sched00001', status: 'schedule', send_time: WED });
  fk.fail.unschedule = ['refuse'];
  const r = await run(fk, { apply: true });
  r.cleanup();
  assert.equal(r.code, 2);
  assert.match(r.out, /did not unschedule it/);
  assert.deepEqual(fk.writes(), ['unschedule sched00001']);
  assert.equal(c.status, 'schedule');
});

test('the allowlist: anything outside it is refused before it leaves', async () => {
  let reached = 0;
  const inner = (async () => {
    reached++;
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  // Looking: reads only.
  const look = guardFetch(inner, LOOK_CALLS);
  const reader = createMailchimpClient({ key: () => REAL_SHAPED_KEY, fetch: look.fetch, env: {}, execArgv: [], allowWrites: true, now: () => NOW });
  await assert.rejects(reader.replicate('sent000001'));
  await assert.rejects(reader.putContent('sched00001', 'x'.repeat(200)));
  await assert.rejects(reader.unschedule('sched00001'));
  await assert.rejects(reader.setTitle('sched00001', { title: 'Fish Email 20261111', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }));
  assert.equal(reached, 0);
  assert.deepEqual(look.refused, ['POST /3.0/campaigns/sent000001/actions/replicate', 'PUT /3.0/campaigns/sched00001/content', 'POST /3.0/campaigns/sched00001/actions/unschedule', 'PATCH /3.0/campaigns/sched00001']);
  // Writing: only the one campaign, and only its five calls.
  const write = guardFetch(inner, writeCalls('sched00001'));
  const writer = createMailchimpClient({ key: () => REAL_SHAPED_KEY, fetch: write.fetch, env: {}, execArgv: [], allowWrites: true, now: () => NOW });
  await assert.rejects(writer.putContent('other00001', 'x'.repeat(200)));
  await assert.rejects(writer.listCampaigns({ listId: LIST, status: 'sent', sortField: 'send_time', count: 5 }));
  await assert.rejects(writer.replicate('sched00001'));
  await assert.rejects(writer.setTitle('sched00001', { title: 'Fish Email 20261111', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }));
  assert.equal(reached, 0);
  await writer.putContent('sched00001', 'x'.repeat(200));
  assert.equal(reached, 1);
  // Another host or a followed redirect: refused too.
  const g = guardFetch(inner, LOOK_CALLS);
  await assert.rejects(g.fetch(new URL('https://evil.example/3.0/campaigns'), { method: 'GET', redirect: 'error' }));
  await assert.rejects(g.fetch(new URL('https://us9.api.mailchimp.com/3.0/campaigns'), { method: 'GET', redirect: 'follow' }));
  assert.equal(reached, 1);
  assert.throws(() => writeCalls('../lists'));
});

test('a proxy or risky TLS setting: stops before reading the key or sending anything', async () => {
  const fk = fake(NOW);
  for (const env of [{ HTTPS_PROXY: 'http://proxy.example:8080' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
    const lines: string[] = [];
    const code = await removeRowJob({ key: REAL_SHAPED_KEY, cfg: testConfig(), apply: true, now: () => NOW, print: (l) => lines.push(l), backupDir: '/nonexistent', fetch: fk.fetch, env, execArgv: [] });
    assert.equal(code, 2);
  }
  assert.equal(fk.calls.length, 0);
});
