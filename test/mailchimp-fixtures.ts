// Shared test values for the fish email: an invented config, the invented email, and a fake
// Mailchimp server on 127.0.0.1 that behaves like the real one where it matters. Invented values
// only, never store data.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { checkMailchimpConfig, localCampaignId, type MailchimpConfig } from '../src/mailchimp/config.ts';

export const FIXTURE_HTML = readFileSync(join(import.meta.dirname, 'fixtures', 'mailchimp', 'fish-email.html'), 'utf8');
export const LIST = 'list000001';

/**
 * The saved copy of a real campaign in data/mailchimp (store data, out of git), found by its name
 * under "campaigns" in config/local/mailchimp.json, so no real id sits in the tests. Empty when
 * this install has no such id, and the test that needs it is skipped.
 */
export function realCampaignFile(name: string): string {
  const id = localCampaignId(name);
  return id ? join(import.meta.dirname, '..', 'data', 'mailchimp', `content-${id}.html`) : '';
}
/** Built at run time, so no key-shaped text sits in the repo. */
export const TEST_KEY = `${'ab12'.repeat(8)}-us${'0'}`;
/** A key shaped like a real one, for checks that a real key never goes to the fake. */
export const REAL_SHAPED_KEY = `${'cd34'.repeat(8)}-us${'9'}`;

export function testConfig(over: Partial<MailchimpConfig> = {}): MailchimpConfig {
  return {
    ...checkMailchimpConfig({
      list: { id: LIST, name: 'Example Fish List' },
      titlePrefix: 'Fish Email',
      timeZone: 'America/Chicago',
      fishDays: ['Mon', 'Wed', 'Fri'],
      sendTime: '08:00',
      safeMarginMinutes: 60,
      checks: [
        { days: ['Sun', 'Tue', 'Thu'], time: '18:00' },
        { days: ['Mon', 'Wed', 'Fri'], time: '06:00', scheduleDrafts: true },
      ],
      sentCheckTime: '08:15',
      newFishSection: 'Additional fresh fish',
      matchesFile: 'data/mailchimp/fish-matches.json',
      units: { lb: 'per_pound', unit: 'each', can: 'each' },
      dateLine: { class: 'sr-fish-date', topTableClass: 'wrap', style: 'padding:12px 20px;color:#c82c2c;text-align:center;' },
    }),
    ...over,
  };
}

export interface FakeCampaign {
  id: string;
  status: string;
  send_time: string;
  create_time: string;
  settings: { title: string; subject_line: string; from_name: string; reply_to: string; preview_text?: string; to_name?: string };
  recipients: { list_id: string; recipient_count?: number; segment_text?: string; segment_opts?: { saved_segment_id?: number; conditions?: unknown[] } };
  emails_sent?: number;
  html: string;
}

/** What a call does when told to fail: refuse (400, nothing applied), lose (applied, then the
 * connection drops), drop (dropped before it is applied), or 500 (nothing applied). */
export type Failure = 'refuse' | 'lose' | 'drop' | 'error500';
export type CallName = 'list' | 'get' | 'content' | 'replicate' | 'patch' | 'put' | 'unschedule' | 'schedule';

export interface FakeMailchimp {
  origin: string;
  campaigns: Map<string, FakeCampaign>;
  calls: Array<{ name: CallName; method: string; path: string; auth: string }>;
  /** Failures to apply, in order, per call name. Each entry is used once. */
  fail: Partial<Record<CallName, Failure[]>>;
  add(c: Partial<FakeCampaign> & { id: string; status: string }): FakeCampaign;
  writes(): string[];
  close(): Promise<void>;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

export async function startFakeMailchimp(now: () => number): Promise<FakeMailchimp> {
  const campaigns = new Map<string, FakeCampaign>();
  const calls: FakeMailchimp['calls'] = [];
  const fail: FakeMailchimp['fail'] = {};
  let copies = 0;
  let ids = 0;

  const view = (c: FakeCampaign): Record<string, unknown> => {
    const { html: _html, ...rest } = c;
    return rest;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let body = '';
    for await (const chunk of req) body += chunk;
    const parts = url.pathname.split('/').filter(Boolean);
    const m = req.method ?? 'GET';
    let name: CallName;
    if (m === 'GET' && parts.length === 2) name = 'list';
    else if (m === 'GET' && parts.length === 3) name = 'get';
    else if (m === 'GET' && parts[3] === 'content') name = 'content';
    else if (m === 'PUT') name = 'put';
    else if (m === 'PATCH') name = 'patch';
    else if (parts[4] === 'replicate') name = 'replicate';
    else if (parts[4] === 'unschedule') name = 'unschedule';
    else name = 'schedule';
    calls.push({ name, method: m, path: url.pathname, auth: String(req.headers.authorization ?? '') });
    const f = fail[name]?.shift();
    const send = (status: number, json?: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(json === undefined ? '' : JSON.stringify(json));
    };
    if (f === 'drop') {
      req.socket.destroy();
      return;
    }
    if (f === 'refuse') return send(400, { title: `Refused on purpose, key ${TEST_KEY}`, status: 400 });
    if (f === 'error500') return send(500, { title: 'Server error' });
    const id = parts[2] ?? '';
    const c = campaigns.get(id);
    let out: { status: number; json?: unknown };
    if (name === 'list') {
      const status = url.searchParams.get('status');
      const list = url.searchParams.get('list_id');
      const field = url.searchParams.get('sort_field') === 'send_time' ? 'send_time' : 'create_time';
      const found = [...campaigns.values()].filter((x) => (!status || x.status === status) && (!list || x.recipients.list_id === list)).sort((a, b) => (b[field] > a[field] ? 1 : -1));
      out = { status: 200, json: { campaigns: found.slice(0, Number(url.searchParams.get('count') ?? 10)).map(view), total_items: found.length } };
    } else if (!c) out = { status: 404, json: { title: 'Resource Not Found' } };
    else if (name === 'get') out = { status: 200, json: view(c) };
    else if (name === 'content') out = { status: 200, json: { html: c.html } };
    else if (name === 'replicate') {
      copies++;
      const copy: FakeCampaign = { ...structuredClone(c), id: `copy${String(++ids).padStart(6, '0')}`, status: 'save', send_time: '', create_time: iso(now()) };
      // Like Mailchimp: "X" becomes "X (copy 01)", and "X (copy 10)" becomes "X (copy 11)".
      const n = /^(.*) \(copy (\d+)\)$/.exec(c.settings.title);
      copy.settings.title = n ? `${n[1]} (copy ${String(Number(n[2]) + 1).padStart(2, '0')})` : `${c.settings.title} (copy 01)`;
      void copies;
      campaigns.set(copy.id, copy);
      out = { status: 200, json: view(copy) };
    } else if (name === 'patch') {
      const b = JSON.parse(body) as { settings?: Record<string, string> };
      if (c.status === 'schedule') out = { status: 400, json: { title: 'Cannot update a scheduled campaign' } };
      else if (!b.settings?.subject_line || !b.settings.from_name || !b.settings.reply_to) out = { status: 400, json: { title: 'Invalid Resource' } };
      // Like a PATCH that resets what it is not sent: a setting left out comes back empty.
      else if (b.settings.preview_text === undefined || b.settings.to_name === undefined) {
        c.settings = { ...c.settings, ...b.settings, preview_text: b.settings.preview_text ?? '', to_name: b.settings.to_name ?? '' };
        out = { status: 200, json: view(c) };
      }
      else {
        c.settings = { ...c.settings, ...b.settings };
        out = { status: 200, json: view(c) };
      }
    } else if (name === 'put') {
      if (c.status === 'schedule') out = { status: 400, json: { title: 'Cannot update a scheduled campaign' } };
      else {
        c.html = (JSON.parse(body) as { html: string }).html;
        out = { status: 200, json: { html: c.html } };
      }
    } else if (name === 'unschedule') {
      if (c.status !== 'schedule') out = { status: 400, json: { title: 'Not scheduled' } };
      else {
        c.status = 'save';
        c.send_time = '';
        out = { status: 204 };
      }
    } else {
      const t = (JSON.parse(body) as { schedule_time: string }).schedule_time;
      if (c.status !== 'save' && c.status !== 'paused') out = { status: 400, json: { title: 'Already scheduled' } };
      else if (Date.parse(t) % 900_000 !== 0 || Date.parse(t) <= now()) out = { status: 400, json: { title: 'Bad schedule time' } };
      else {
        c.status = 'schedule';
        c.send_time = iso(Date.parse(t));
        out = { status: 204 };
      }
    }
    if (f === 'lose') {
      req.socket.destroy();
      return;
    }
    send(out.status, out.json);
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    campaigns,
    calls,
    fail,
    add(c) {
      const full: FakeCampaign = {
        send_time: '',
        create_time: iso(now() - 86400_000),
        settings: { title: 'Fish Email 20261016', subject_line: 'Fresh fish this week', from_name: 'Example Fish Market', reply_to: 'fish@example.com', preview_text: 'Order by 7pm', to_name: '*|FNAME|*' },
        recipients: { list_id: LIST },
        html: FIXTURE_HTML,
        ...c,
      };
      campaigns.set(full.id, full);
      return full;
    },
    writes() {
      return calls.filter((x) => x.method !== 'GET').map((x) => `${x.name} ${x.path.split('/')[3]}`);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
