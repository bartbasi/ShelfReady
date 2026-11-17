// The one-off script that makes Wednesday's fish email. A fake fetch stands in for Mailchimp: no
// network. The email is invented, with rows named as in the approved corrections.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailchimpClient } from '../src/mailchimp/client.ts';
import { findDateLine, parseRows } from '../src/mailchimp/html.ts';
import { loadMailchimpConfig } from '../src/mailchimp/config.ts';
import { guardFetch } from '../scripts/mailchimp/remove-row.ts';
import { copyCalls, editCalls, makeWednesdayJob, planEdit, PRICE_FIXES, SOURCE_NAME } from '../scripts/mailchimp/make-wednesday.ts';
import { LIST, REAL_SHAPED_KEY, realCampaignFile, testConfig } from './mailchimp-fixtures.ts';

const Z = (s: string): number => Date.parse(s);
const NOW = Z('2026-11-10T20:00:00Z'); // Tuesday 2pm Chicago.
const WED = '2026-11-11T14:00:00+00:00';
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
/** Invented: the id of Monday's sent email in the fake. */
const SOURCE_ID = 'monsent009';
const REAL = realCampaignFile(SOURCE_NAME);

const DIVIDER = 'border-bottom:1px solid #d0cdc5;';
interface R {
  price: string;
  unit: string;
  name: string;
  origin?: string;
}
function build(sections: Array<{ name: string; rows: R[] }>): string {
  const row = (r: R, last: boolean): string =>
    `<tr><td style="padding:11px 0;${last ? '' : DIVIDER}color:#555"><b style="float:right;color:#c82c2c">${r.price}<small>${r.unit}</small></b><b style="font:700 17px/22px Georgia,serif">${r.name}</b>${r.origin ? `<span style="color:#888"> (${r.origin})</span>` : ''}<br>An invented line.</td></tr>`;
  const body = sections.map((s) => `<div><span style="font:24px/30px Georgia,serif">${s.name}</span></div><table role="presentation">${s.rows.map((r, i) => row(r, i === s.rows.length - 1)).join('')}</table>`).join('');
  return `<!DOCTYPE html><html><body><div class="price">$8.99</div><table class="wrap" width="600"><tr><td>Example Fish Market</td></tr><tr><td class="pad">${body}</td></tr></table></body></html>`;
}
const SECTIONS = (bigeye = '$42.99'): Array<{ name: string; rows: R[] }> => [
  { name: 'Tuna', rows: [{ price: '$30.99', unit: '/lb', name: 'Albacore Tuna' }, { price: bigeye, unit: '/lb', name: 'Bigeye Tuna' }] },
  { name: 'Additional fresh fish', rows: [{ price: '$40.99', unit: '/lb', name: 'Cod', origin: 'Iceland' }, { price: '$20.99', unit: '/lb', name: 'Branzino' }] },
  { name: 'For the chef', rows: [{ price: '$12.99', unit: '/unit', name: 'Example Fish Stock', origin: '16 oz' }, { price: '$16.99', unit: '/unit', name: 'Bart&#39;s Lobster Stock', origin: '8 oz (1 cup)' }] },
  {
    name: 'Lobsters',
    rows: [
      { price: '$28.99', unit: '/lb', name: 'Live Lobster, 1&ndash;1.5 lb' },
      { price: '$30.99', unit: '/lb', name: 'Live Lobster, 1.5&ndash;2 lb' },
      { price: '$30.99', unit: '/lb', name: 'Live Lobster, 2&ndash;3 lb' },
      { price: 'Call', unit: '', name: 'Live Lobster, 4+ lb', origin: 'Special order' },
    ],
  },
  { name: 'Crab', rows: [{ price: '$43.99', unit: '/can', name: 'Lump Crab Meat', origin: '1 lb can, cooked' }, { price: '$84.99', unit: '/can', name: 'Jumbo Crab Meat', origin: '1 lb can, cooked' }] },
];
const SOURCE_HTML = build(SECTIONS());
const AUTO_TEXT = '** The Fish List\n------------------------------------------------------------\n';

interface FakeCampaign {
  id: string;
  status: string;
  send_time: string;
  create_time: string;
  settings: { title: string; subject_line: string; from_name: string; reply_to: string; preview_text: string; to_name: string };
  recipients: { list_id: string };
  html: string;
}
type Name = 'list' | 'get' | 'content' | 'put' | 'patch' | 'replicate' | 'schedule' | 'other';

function fake(now: number) {
  const campaigns = new Map<string, FakeCampaign>();
  const calls: Array<{ name: Name; method: string; path: string }> = [];
  const fail: Partial<Record<Name, Array<'refuse' | 'lose' | 'drop'>>> = {};
  const hooks: { onPut?: (h: string) => string; onPatch?: (c: FakeCampaign) => void } = {};
  let n = 0;
  const add = (c: Partial<FakeCampaign> & { id: string; status: string }): FakeCampaign => {
    const full: FakeCampaign = {
      send_time: '',
      create_time: iso(now - 86400_000),
      settings: { title: 'Fish Email 20261016 (copy 10)', subject_line: 'Fish list', from_name: 'Example Fish Market', reply_to: 'fish@example.com', preview_text: 'Order by 7pm', to_name: '*|FNAME|*' },
      recipients: { list_id: LIST },
      html: SOURCE_HTML,
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
      method === 'GET' && parts.length === 2 ? 'list' : method === 'GET' && parts.length === 3 ? 'get' : method === 'GET' && parts[3] === 'content' ? 'content' : method === 'PUT' ? 'put' : method === 'PATCH' ? 'patch' : parts[4] === 'replicate' ? 'replicate' : parts[4] === 'schedule' ? 'schedule' : 'other';
    calls.push({ name, method, path: url.pathname });
    const mode = fail[name]?.shift();
    if (mode === 'refuse') return json(400, { title: 'Refused on purpose' });
    if (mode === 'drop') throw new TypeError('connection reset');
    const c = campaigns.get(parts[2] ?? '');
    let res: Response;
    if (name === 'list') {
      const st = url.searchParams.get('status');
      res = json(200, { campaigns: [...campaigns.values()].filter((x) => x.status === st && x.recipients.list_id === url.searchParams.get('list_id')).map(view) });
    } else if (!c) res = json(404, { title: 'Not found' });
    else if (name === 'get') res = json(200, view(c));
    else if (name === 'content') res = json(200, { html: c.html, plain_text: AUTO_TEXT });
    else if (name === 'replicate') {
      const m = /^(.*) \(copy (\d+)\)$/.exec(c.settings.title);
      const copy = add({ ...structuredClone(c), id: `copy${String(++n).padStart(6, '0')}`, status: 'save', send_time: '', create_time: iso(now) });
      copy.settings.title = m ? `${m[1]} (copy ${String(Number(m[2]) + 1).padStart(2, '0')})` : `${c.settings.title} (copy 01)`;
      res = json(200, view(copy));
    } else if (name === 'put') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), ['html']);
      c.html = hooks.onPut ? hooks.onPut(body.html as string) : (body.html as string);
      res = json(200, { html: c.html });
    } else if (name === 'patch') {
      const body = JSON.parse(String(init.body)) as { settings: FakeCampaign['settings'] };
      assert.deepEqual(Object.keys(body), ['settings']);
      c.settings = { ...c.settings, ...body.settings };
      hooks.onPatch?.(c);
      res = json(200, view(c));
    } else if (name === 'schedule') {
      c.status = 'schedule';
      c.send_time = (JSON.parse(String(init.body)) as { schedule_time: string }).schedule_time;
      res = json(204);
    } else res = json(400, { title: 'Unknown call' });
    if (mode === 'lose') throw new TypeError('connection reset');
    return res;
  }) as unknown as typeof fetch;
  return { fetch: f, campaigns, calls, fail, hooks, add, writes: () => calls.filter((c) => c.method !== 'GET').map((c) => `${c.name} ${c.path.split('/')[3]}`) };
}

const SOURCE = { id: SOURCE_ID, status: 'sent', send_time: '2026-11-09T14:00:00+00:00', create_time: '2026-11-09T05:03:24+00:00' };

async function run(fk: ReturnType<typeof fake>, opts: { apply?: boolean; now?: number } = {}) {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-wed-'));
  try {
    const code = await makeWednesdayJob({ key: REAL_SHAPED_KEY, cfg: testConfig(), sourceId: SOURCE_ID, apply: opts.apply ?? false, now: () => opts.now ?? NOW, print: (l) => lines.push(l), backupDir: join(dir, 'backups'), fetch: fk.fetch, env: {}, execArgv: [], sleep: async () => {} });
    const out = lines.join('\n');
    assert.ok(!out.includes(REAL_SHAPED_KEY), 'the key is never printed');
    assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(out), 'no control or bidi characters are printed');
    return { code, out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function copyOf(fk: ReturnType<typeof fake>): FakeCampaign | undefined {
  return [...fk.campaigns.values()].find((c) => c.id.startsWith('copy'));
}

test('the plan: one row and its divider, seven prices, the date line, and nothing else', () => {
  const p = planEdit(SOURCE_HTML, testConfig());
  assert.ok(typeof p !== 'string', String(p));
  if (typeof p === 'string') return;
  assert.equal(p.removed.dividerFrom, 'Example Fish Stock (16 oz)');
  assert.equal(p.prices.length, 7);
  assert.equal(findDateLine(p.html, 'sr-fish-date')!.text, 'Wednesday, November 11, 2026');
  const rows = parseRows(p.html);
  for (const f of PRICE_FIXES) assert.equal(rows.find((r) => r.key === f.key)!.priceText, `$${Math.floor(f.to / 100)}.${String(f.to % 100).padStart(2, '0')}`);
  assert.ok(p.html.includes('<div class="price">$8.99</div>'));
  assert.equal(rows.find((r) => r.key === 'Albacore Tuna')!.priceText, '$30.99');
  // A source price not as approved: stops.
  assert.match(String(planEdit(build(SECTIONS('$44.99')), testConfig())), /Bigeye Tuna" shows \$44\.99\/lb, not \$42\.99\/lb/);
  // A source that already has a date line: stops.
  assert.match(String(planEdit(SOURCE_HTML.replace('<tr><td>Example', '<tr><td class="sr-fish-date">Monday, November 9, 2026</td></tr><tr><td>Example'), testConfig())), /date line/);
});

test('the real saved source: the plan checks out', { skip: !existsSync(REAL) && 'no saved campaign in data/mailchimp' }, () => {
  const p = planEdit(readFileSync(REAL, 'utf8'), loadMailchimpConfig());
  assert.ok(typeof p !== 'string', String(p));
  if (typeof p !== 'string') assert.deepEqual(p.prices.map((x) => [x.key, x.from, x.to]), PRICE_FIXES.map((f) => [f.key, f.from, `$${Math.floor(f.to / 100)}.${String(f.to % 100).padStart(2, '0')}`]));
});

test('dry run: reads only, prints the summary for Bart', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  const r = await run(fk);
  assert.equal(r.code, 0, r.out);
  assert.ok(fk.calls.every((c) => c.method === 'GET'));
  assert.match(r.out, /Summary for Bart:/);
  assert.match(r.out, /Campaign: "Fish Email 20261111" \(not made yet\), dry run\./);
  assert.match(r.out, /Send time: Wed 2026-11-11 08:00 America\/Chicago\./);
  assert.match(r.out, /Price: Live Lobster, 1–1\.5 lb, \$28\.99\/lb to \$24\.99\/lb\./);
  assert.match(r.out, /Price: Cod \(Iceland\), \$40\.99\/lb to \$41\.99\/lb\./);
  assert.match(r.out, /Removed: "Bart's Lobster Stock \(8 oz \(1 cup\)\)", and the divider under "Example Fish Stock \(16 oz\)"/);
  assert.match(r.out, /Date line at the top: "Wednesday, November 11, 2026"\./);
});

test('happy path: copy, one PUT, the title, schedule, each read back', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 0, r.out);
  const c = copyOf(fk)!;
  assert.deepEqual(fk.writes(), [`replicate ${SOURCE_ID}`, `put ${c.id}`, `patch ${c.id}`, `schedule ${c.id}`]);
  assert.equal(c.status, 'schedule');
  assert.equal(c.send_time, WED);
  assert.equal(c.settings.title, 'Fish Email 20261111');
  assert.equal(c.settings.subject_line, 'Fish list');
  assert.equal(c.settings.preview_text, 'Order by 7pm');
  const p = planEdit(SOURCE_HTML, testConfig());
  assert.equal(c.html, typeof p === 'string' ? '' : p.html);
  assert.equal(fk.campaigns.get(SOURCE_ID)!.html, SOURCE_HTML);
  assert.match(r.out, new RegExp(`Campaign: "Fish Email 20261111" \\(${c.id}\\), scheduled\\.`));
});

test('an existing draft or scheduled fish email: stops, nothing written', async () => {
  for (const status of ['save', 'schedule']) {
    const fk = fake(NOW);
    fk.add(SOURCE);
    fk.add({ id: 'byhand0001', status, send_time: status === 'schedule' ? WED : '', create_time: iso(NOW - 3600_000) });
    const r = await run(fk, { apply: true });
    assert.equal(r.code, 2);
    assert.match(r.out, /already exists: "Fish Email 20261016 \(copy 10\)" \(byhand0001/);
    assert.deepEqual(fk.writes(), []);
  }
  // A paused one does not count.
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.add({ id: 'paused0001', status: 'paused', create_time: iso(NOW - 3600_000) });
  assert.equal((await run(fk)).code, 0);
});

test('a scheduled fish email made before the source still stops it; an old draft does not', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.add({ id: 'ahead00001', status: 'schedule', send_time: WED, create_time: '2026-11-01T12:00:00+00:00' });
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 2);
  assert.match(r.out, /already exists: .*\(ahead00001, schedule\)/);
  assert.deepEqual(fk.writes(), []);
  const fk2 = fake(NOW);
  fk2.add(SOURCE);
  fk2.add({ id: 'olddraft01', status: 'save', create_time: '2026-11-01T12:00:00+00:00' });
  assert.equal((await run(fk2)).code, 0);
});

test('the source is not the one Bart named: stops', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.add({ ...SOURCE, id: 'newer00001', send_time: '2026-11-10T14:00:00+00:00', create_time: '2026-11-10T05:00:00+00:00' });
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 2);
  assert.match(r.out, /the last fish email sent is newer00001/);
});

test('inside the cutoff: stops', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  const r = await run(fk, { apply: true, now: Z('2026-11-11T13:05:00Z') });
  assert.equal(r.code, 2);
  assert.match(r.out, /inside the 60-minute cutoff/);
  assert.deepEqual(fk.writes(), []);
});

test('a source price not as approved: stops before any write', async () => {
  const fk = fake(NOW);
  fk.add({ ...SOURCE, html: build(SECTIONS('$44.99')) });
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 2);
  assert.match(r.out, /Bigeye Tuna" shows \$44\.99/);
  assert.deepEqual(fk.writes(), []);
});

test('a lost answer to the copy: the copy is found, never made twice', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.fail.replicate = ['lose'];
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Looking for it instead of copying again/);
  assert.equal(fk.writes().filter((w) => w.startsWith('replicate')).length, 1);
  assert.equal(copyOf(fk)!.status, 'schedule');
});

test('a lost copy that was never made: looked for, not made again, loud', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.fail.replicate = ['drop'];
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /no copy was found\. Check the drafts/);
  assert.deepEqual(fk.writes(), [`replicate ${SOURCE_ID}`]);
});

test('the PUT fails: the copy stays a draft, with its id and what is left, loudly', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.fail.put = ['refuse'];
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 1);
  const c = copyOf(fk)!;
  assert.equal(c.status, 'save');
  assert.match(r.out, /\*+ FAILED \*+/);
  assert.match(r.out, /The new HTML did NOT land/);
  assert.match(r.out, new RegExp(`The copy ${c.id} stays a draft\\. Left to do by hand in Mailchimp: remove .*schedule it for Wed 2026-11-11 08:00`));
  assert.deepEqual(fk.writes(), [`replicate ${SOURCE_ID}`, `put ${c.id}`]);
});

test('the schedule fails twice: IT IS NOT SCHEDULED, the copy stays a draft', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.fail.schedule = ['refuse', 'refuse'];
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /IT IS NOT SCHEDULED/);
  assert.equal(copyOf(fk)!.status, 'save');
  assert.equal(copyOf(fk)!.settings.title, 'Fish Email 20261111');
});

test('read-back mismatches: the HTML, and a setting the title change moved', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  fk.hooks.onPut = (h) => h.replace('</body>', ' </body>');
  const r = await run(fk, { apply: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /holds HTML that is not the expected one/);
  assert.equal(copyOf(fk)!.status, 'save');
  const fk2 = fake(NOW);
  fk2.add(SOURCE);
  fk2.hooks.onPatch = (c) => {
    c.settings.preview_text = '';
  };
  const r2 = await run(fk2, { apply: true });
  assert.equal(r2.code, 1);
  assert.match(r2.out, /Setting the name also changed previewText/);
  assert.equal(copyOf(fk2)!.status, 'save');
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
  const copying = client(copyCalls(SOURCE_ID));
  await assert.rejects(copying.api.replicate('other00001'));
  await assert.rejects(copying.api.putContent(SOURCE_ID, 'x'.repeat(200)));
  await assert.rejects(copying.api.schedule(SOURCE_ID, WED));
  await assert.rejects(copying.api.unschedule(SOURCE_ID));
  assert.equal(reached, 0);
  await copying.api.replicate(SOURCE_ID);
  assert.equal(reached, 1);
  const editing = client(editCalls('copy000001'));
  await assert.rejects(editing.api.putContent(SOURCE_ID, 'x'.repeat(200)));
  await assert.rejects(editing.api.replicate('copy000001'));
  await assert.rejects(editing.api.unschedule('copy000001'));
  await assert.rejects(editing.api.listCampaigns({ listId: LIST, status: 'sent', sortField: 'send_time', count: 5 }));
  await assert.rejects(editing.api.setTitle(SOURCE_ID, { title: 'Fish Email 20261111', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' }));
  assert.equal(reached, 1);
  assert.deepEqual(editing.g.refused, [`PUT /3.0/campaigns/${SOURCE_ID}/content`, 'POST /3.0/campaigns/copy000001/actions/replicate', 'POST /3.0/campaigns/copy000001/actions/unschedule', 'GET /3.0/campaigns', `PATCH /3.0/campaigns/${SOURCE_ID}`]);
  assert.throws(() => editCalls('../lists'));
});

test('escapes in the email text are never printed', async () => {
  const fk = fake(NOW);
  fk.add({ ...SOURCE, settings: { title: 'Fish Email 20261016 \u001b[31m(copy 10)\u202e', subject_line: 's', from_name: 'f', reply_to: 'r', preview_text: '', to_name: '' } });
  const r = await run(fk);
  // run() asserts no control or bidi character reached the output.
  assert.match(r.out, /Fish Email 20261016 \?\[31m\(copy 10\)\?/);
});

test('a proxy or risky TLS setting: stops before anything is sent', async () => {
  const fk = fake(NOW);
  fk.add(SOURCE);
  for (const env of [{ HTTPS_PROXY: 'http://proxy.example:8080' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }]) {
    const code = await makeWednesdayJob({ key: REAL_SHAPED_KEY, cfg: testConfig(), sourceId: SOURCE_ID, apply: true, now: () => NOW, print: () => {}, backupDir: '/nonexistent', fetch: fk.fetch, env, execArgv: [], sleep: async () => {} });
    assert.equal(code, 2);
  }
  assert.equal(fk.calls.length, 0);
});
