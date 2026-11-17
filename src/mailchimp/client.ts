// The Mailchimp client for the fish email (step 11). Mailchimp API keys cannot be limited, so a
// key that can edit a campaign can also send one to every customer, or delete the list. This
// module is the limit:
//   - one private sender, with a fixed allowlist of exactly the calls step 11 needs, checked on
//     the method, the parsed path, every query parameter name and the body's shape before sending:
//       GET    /3.0/lists                              audience names and member counts (read
//                                                      only; the live test finds its audience)
//       GET    /3.0/campaigns                          list campaigns (one list, read only)
//       GET    /3.0/campaigns/{id}                     read one campaign back by id
//       GET    /3.0/campaigns/{id}/content             get its HTML
//       POST   /3.0/campaigns/{id}/actions/replicate   copy the last fish email
//       PATCH  /3.0/campaigns/{id}                     settings.title only (subject, sender,
//                                                      reply-to, preview text and to-name go back
//                                                      exactly as read; empty subject, sender or
//                                                      reply-to are refused)
//       PUT    /3.0/campaigns/{id}/content             the HTML only
//       POST   /3.0/campaigns/{id}/actions/unschedule
//       POST   /3.0/campaigns/{id}/actions/schedule    a quarter hour, 10 minutes to 3 weeks ahead
//     There is no send, no test send, no delete, no list or member call.
//   - every change is refused unless the server config allows Mailchimp writes (off until Bart
//     approves live Mailchimp changes); reads still work, for the dry run;
//   - the host is built from the key's own data center ("us7"); a test may point it at a fake on
//     127.0.0.1 only, through code (never settings or the browser), and only with a test key in
//     the data center us0, which Mailchimp does not have; a us0 key goes nowhere else;
//   - no redirects, a timeout, a size cap on replies, and no run with proxy or TLS settings that
//     could send the key elsewhere (src/lib/risky-env.ts and the proxy variables);
//   - the key is read from settings when a call is made, appears only in the Authorization
//     header, and is never logged or shown. Mailchimp's error title is kept only after the key and
//     anything key-like is removed, and only plain characters are kept.

import { riskyEnvironment } from '../lib/risky-env.ts';
import { parseMailchimpTime, onQuarterHour } from './days.ts';

export const CAMPAIGN_ID = /^[a-z0-9]{6,20}$/;
export const KEY_SHAPE = /^[0-9a-f]{32}-(us[0-9]{1,3})$/;
const TEST_ORIGIN = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/;
/**
 * Tests use a fake key in the data center us0, which Mailchimp does not have. The fake Mailchimp
 * address is honored only with such a key, and such a key is refused anywhere else, so a real key
 * can never go to a test address.
 */
export const TEST_DATA_CENTER = 'us0';
/** Never schedule closer than this to now: Mailchimp needs a little time. The worker uses it too. */
export const MIN_LEAD_MS = 10 * 60_000;
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

export type MailchimpErrorKind = 'setup' | 'refused' | 'unknown';

/**
 * A call that failed. setup: refused before sending (no key, a risky environment, a call not on
 * the list), so nothing reached Mailchimp. refused: Mailchimp answered 4xx, so it did not apply.
 * unknown: no answer, a 5xx or a reply that could not be read, so it may or may not have applied.
 * The message is plain words, safe to show, and never holds the key.
 */
export class MailchimpError extends Error {
  readonly kind: MailchimpErrorKind;
  readonly status: number;
  constructor(kind: MailchimpErrorKind, message: string, status = 0) {
    super(message);
    this.name = 'MailchimpError';
    this.kind = kind;
    this.status = status;
  }
}

export interface Campaign {
  id: string;
  /** save (draft), paused, schedule, sending, sent, or another Mailchimp status. */
  status: string;
  title: string;
  listId: string;
  /** When it is scheduled or was sent, in milliseconds, or null. */
  sendTime: number | null;
  createTime: number | null;
  subjectLine: string;
  fromName: string;
  replyTo: string;
  previewText: string;
  toName: string;
  /** Sent, or to be sent, to only part of the list. Never a copy source. */
  segmented: boolean;
  /**
   * Mailchimp's segment description, for people only: never used to decide anything. Asked for
   * only by the live test (getCampaign with segmentText); '' otherwise.
   */
  segmentText: string;
  /** The reply held recipients.segment_opts at all, so segmented can be trusted to say no. */
  segmentOptsRead: boolean;
  /** How many people it is for, and how many it went to, when Mailchimp says. */
  recipientCount: number | null;
  emailsSent: number | null;
}

/**
 * The settings a title change sends. Mailchimp's PATCH may reset settings left out, so every one
 * a person sees goes back exactly as read; only the title changes.
 */
export interface TitleSettings {
  title: string;
  subject_line: string;
  from_name: string;
  reply_to: string;
  preview_text: string;
  to_name: string;
}

export interface Audience {
  id: string;
  name: string;
  memberCount: number | null;
}

export interface MailchimpApi {
  /** The audiences (lists) on the account: id, name and member count. Read only. */
  listAudiences(): Promise<Audience[]>;
  listCampaigns(q: { listId: string; status: 'schedule' | 'sent' | 'save' | 'sending' | 'paused'; sortField: 'create_time' | 'send_time'; count: number; sinceCreateTime?: string }): Promise<Campaign[]>;
  /** One campaign by id. segmentText: also ask for recipients.segment_text (the live test only). */
  getCampaign(id: string, opts?: { segmentText?: boolean }): Promise<Campaign>;
  getContent(id: string): Promise<string>;
  /** The HTML and the plain text Mailchimp holds, for checking whether the plain text was set by hand. */
  getContentWithText(id: string): Promise<{ html: string; plainText: string }>;
  replicate(id: string): Promise<Campaign>;
  setTitle(id: string, settings: TitleSettings): Promise<void>;
  putContent(id: string, html: string): Promise<void>;
  unschedule(id: string): Promise<void>;
  schedule(id: string, scheduleTime: string): Promise<void>;
}

export interface ClientOptions {
  /** The key from settings, read on each call. */
  key: () => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests only: a fake Mailchimp on 127.0.0.1. Set in code, never from settings. */
  testOrigin?: string;
  /**
   * False: only GET calls go out; every change is refused before it is sent. From the server config
   * allowMailchimpWrites (off until Bart approves live Mailchimp changes). Default false.
   */
  allowWrites?: boolean;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

interface Call {
  method: Method;
  path: RegExp;
  query: readonly string[];
  /** Checks the body. Throws when it is not the one shape this call may carry. */
  body: (b: unknown, now: number) => void;
}

const ID = '[a-z0-9]{6,20}';
const noBody = (b: unknown): void => {
  if (b !== undefined) throw new Error('no body allowed');
};

function exactKeys(o: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
  const got = Object.keys(o).sort();
  if (got.length !== keys.length || got.some((k, i) => k !== [...keys].sort()[i])) throw new Error('wrong fields');
  return o as Record<string, unknown>;
}

/** Plain text a person could have typed: no control characters, a sane length. */
function plainText(v: unknown, max: number): void {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) throw new Error('bad text');
}

/** The allowlist. Nothing else is ever sent. */
const CALLS: readonly Call[] = [
  { method: 'GET', path: /^\/3\.0\/lists$/, query: ['fields', 'count'], body: noBody },
  { method: 'GET', path: /^\/3\.0\/campaigns$/, query: ['list_id', 'status', 'count', 'sort_field', 'sort_dir', 'fields', 'since_create_time'], body: noBody },
  { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${ID}$`), query: ['fields'], body: noBody },
  { method: 'GET', path: new RegExp(`^/3\\.0/campaigns/${ID}/content$`), query: ['fields'], body: noBody },
  { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${ID}/actions/replicate$`), query: [], body: noBody },
  {
    method: 'PATCH',
    path: new RegExp(`^/3\\.0/campaigns/${ID}$`),
    query: [],
    body: (b) => {
      const o = exactKeys(b, ['settings']);
      const s = exactKeys(o.settings, ['title', 'subject_line', 'from_name', 'reply_to', 'preview_text', 'to_name']);
      plainText(s.title, 100);
      if (!/^[A-Za-z0-9 &'-]{3,40} [0-9]{8}$/.test(s.title as string)) throw new Error('title must be the fish email name');
      // An empty subject, sender or reply-to would be a broken email: refused, never sent.
      for (const k of ['subject_line', 'from_name', 'reply_to'] as const) {
        plainText(s[k], 300);
        if ((s[k] as string).trim() === '') throw new Error(`${k} is empty`);
      }
      plainText(s.preview_text, 300);
      plainText(s.to_name, 300);
    },
  },
  {
    method: 'PUT',
    path: new RegExp(`^/3\\.0/campaigns/${ID}/content$`),
    query: [],
    body: (b) => {
      const o = exactKeys(b, ['html']);
      if (typeof o.html !== 'string' || o.html.length < 100 || Buffer.byteLength(o.html) > MAX_HTML_BYTES) throw new Error('html must be the whole email');
    },
  },
  { method: 'POST', path: new RegExp(`^/3\\.0/campaigns/${ID}/actions/unschedule$`), query: [], body: noBody },
  {
    method: 'POST',
    path: new RegExp(`^/3\\.0/campaigns/${ID}/actions/schedule$`),
    query: [],
    body: (b, now) => {
      const o = exactKeys(b, ['schedule_time']);
      const t = parseMailchimpTime(o.schedule_time);
      if (t === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+00:00$/.test(o.schedule_time as string)) throw new Error('schedule_time must be UTC');
      if (!onQuarterHour(t) || t < now + MIN_LEAD_MS || t > now + 21 * 86400_000) throw new Error('schedule_time must be a quarter hour, at least 10 minutes ahead and within three weeks');
    },
  },
];

/** Removes the key, and anything shaped like a key or a long token, from text Mailchimp sent. */
export function scrub(text: unknown, key: string | undefined): string {
  let s = String(text ?? '').slice(0, 2000);
  if (key) s = s.split(key).join('[redacted]');
  s = s.replace(/[0-9a-f]{20,}(-us[0-9]{1,3})?/gi, '[redacted]');
  return s.replace(/[^A-Za-z0-9 .,'[\]()-]/g, '').slice(0, 120).trim();
}

function campaignFrom(o: unknown): Campaign {
  const c = o as Record<string, any>;
  const id = typeof c?.id === 'string' ? c.id : '';
  if (!CAMPAIGN_ID.test(id)) throw new MailchimpError('unknown', 'Mailchimp sent a campaign without a usable id.');
  const s = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id,
    status: s(c.status, 30),
    title: s(c.settings?.title),
    listId: s(c.recipients?.list_id, 30),
    sendTime: parseMailchimpTime(c.send_time),
    createTime: parseMailchimpTime(c.create_time),
    subjectLine: s(c.settings?.subject_line),
    fromName: s(c.settings?.from_name),
    replyTo: s(c.settings?.reply_to),
    previewText: s(c.settings?.preview_text),
    toName: s(c.settings?.to_name),
    segmented: isSegmented(c.recipients),
    segmentText: s(c.recipients?.segment_text, 300),
    segmentOptsRead: c.recipients?.segment_opts !== null && typeof c.recipients?.segment_opts === 'object',
    recipientCount: count(c.recipients?.recipient_count),
    emailsSent: count(c.emails_sent),
  };
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * Sent to part of the list: segment_opts names a saved segment or holds conditions. Mailchimp's
 * segment_text is a description for people and is not relied on. To confirm in the first live
 * test: a whole-list fish send shows no segment (store/docs/MAILCHIMP-NOTES.md).
 */
function isSegmented(r: unknown): boolean {
  const rec = (r ?? {}) as Record<string, any>;
  const opts = rec.segment_opts as Record<string, any> | undefined;
  return !!opts && (Number(opts.saved_segment_id) > 0 || (Array.isArray(opts.conditions) && opts.conditions.length > 0));
}

const CAMPAIGN_FIELDS =
  'id,status,send_time,create_time,emails_sent,settings.title,settings.subject_line,settings.from_name,settings.reply_to,settings.preview_text,settings.to_name,recipients.list_id,recipients.recipient_count,recipients.segment_opts';

/** Why the client cannot send now, or null. Checked before every call. */
export function setupProblem(opts: Pick<ClientOptions, 'env' | 'execArgv' | 'key' | 'testOrigin'>): string | null {
  const env = opts.env ?? process.env;
  const risky = riskyEnvironment(env, opts.execArgv ?? process.execArgv);
  if (risky) return 'ShelfReady is running with a proxy or certificate setting that could send the Mailchimp key elsewhere, so nothing was sent.';
  for (const v of PROXY_VARS) if (env[v]) return 'ShelfReady is running with a proxy set, so nothing was sent to Mailchimp.';
  let k: string | undefined;
  try {
    k = opts.key();
  } catch {
    return 'The Mailchimp API key in settings is damaged. An admin must enter it again.';
  }
  if (!k) return 'No Mailchimp API key is set. An admin must set it in settings.';
  const dc = KEY_SHAPE.exec(k)?.[1];
  if (!dc) return 'The Mailchimp API key in settings does not look like a Mailchimp key.';
  if (opts.testOrigin !== undefined) {
    if (!TEST_ORIGIN.test(opts.testOrigin)) return 'The test Mailchimp address must be on 127.0.0.1.';
    if (dc !== TEST_DATA_CENTER) return 'A test Mailchimp address is used only with a test key, so a real key is never sent there.';
  } else if (dc === TEST_DATA_CENTER) {
    return 'The Mailchimp API key in settings is a test key.';
  }
  return null;
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_REPLY_BYTES) {
      await reader.cancel();
      throw new Error('too big');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createMailchimpClient(opts: ClientOptions): MailchimpApi {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  async function send(method: Method, path: string, query: Record<string, string>, body?: unknown): Promise<unknown> {
    const problem = setupProblem(opts);
    if (problem) throw new MailchimpError('setup', problem);
    const key = opts.key()!;
    const origin = opts.testOrigin ?? `https://${KEY_SHAPE.exec(key)![1]}.api.mailchimp.com`;
    const url = new URL(path, origin);
    for (const [n, v] of Object.entries(query)) url.searchParams.set(n, v);
    const call = CALLS.find((c) => c.method === method && c.path.test(url.pathname));
    if (url.origin !== origin || url.username || url.password || url.hash || !call) throw new MailchimpError('setup', `ShelfReady refused to send ${method} ${url.pathname}: not a call it may make.`);
    for (const n of url.searchParams.keys()) if (!call.query.includes(n)) throw new MailchimpError('setup', `ShelfReady refused to send ${method} ${url.pathname}: the ${n} parameter is not allowed.`);
    if (method !== 'GET' && opts.allowWrites !== true) throw new MailchimpError('setup', 'Mailchimp changes are off in this install (allowMailchimpWrites in the server config), so nothing was changed.');
    try {
      call.body(body, now());
    } catch {
      throw new MailchimpError('setup', `ShelfReady refused to send ${method} ${url.pathname}: the body is not the shape this call may carry.`);
    }
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // The thrown error is not kept: it could quote the request.
      throw new MailchimpError('unknown', `Mailchimp did not answer ${method} ${url.pathname}.`);
    }
    let text: string;
    try {
      text = await readCapped(res);
    } catch {
      throw new MailchimpError('unknown', `Mailchimp's answer to ${method} ${url.pathname} could not be read.`, res.status);
    }
    let json: any = null;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.status >= 400 && res.status < 500) {
      throw new MailchimpError('refused', `Mailchimp refused ${method} ${url.pathname} (HTTP ${res.status}). ${scrub(json?.title, key)}`.trim(), res.status);
    }
    if (!res.ok) throw new MailchimpError('unknown', `Mailchimp had a problem with ${method} ${url.pathname} (HTTP ${res.status}).`, res.status);
    if (text !== '' && json === null) throw new MailchimpError('unknown', `Mailchimp's answer to ${method} ${url.pathname} was not JSON.`, res.status);
    return json;
  }

  const idOk = (id: string): string => {
    if (!CAMPAIGN_ID.test(id)) throw new MailchimpError('setup', 'That is not a Mailchimp campaign id.');
    return id;
  };

  return {
    async listAudiences() {
      const json = (await send('GET', '/3.0/lists', { count: '100', fields: 'lists.id,lists.name,lists.stats.member_count' })) as { lists?: unknown[] } | null;
      if (!json || !Array.isArray(json.lists)) throw new MailchimpError('unknown', 'Mailchimp sent the audiences in a shape ShelfReady does not know.');
      return json.lists.map((l) => {
        const o = l as Record<string, any>;
        const id = typeof o?.id === 'string' && /^[a-z0-9]{6,20}$/.test(o.id) ? o.id : '';
        if (!id) throw new MailchimpError('unknown', 'Mailchimp sent an audience without a usable id.');
        return { id, name: typeof o.name === 'string' ? o.name.slice(0, 200) : '', memberCount: count(o.stats?.member_count) };
      });
    },
    async listCampaigns(q) {
      if (!/^[a-z0-9]{6,20}$/.test(q.listId)) throw new MailchimpError('setup', 'That is not a Mailchimp list id.');
      const count = Math.min(Math.max(1, Math.floor(q.count)), 200);
      const query: Record<string, string> = {
        list_id: q.listId,
        status: q.status,
        count: String(count),
        sort_field: q.sortField,
        sort_dir: 'DESC',
        fields: `total_items,${CAMPAIGN_FIELDS.split(',').map((f) => `campaigns.${f}`).join(',')}`,
      };
      if (q.sinceCreateTime) query.since_create_time = q.sinceCreateTime;
      const json = (await send('GET', '/3.0/campaigns', query)) as { campaigns?: unknown[] } | null;
      if (!json || !Array.isArray(json.campaigns)) throw new MailchimpError('unknown', 'Mailchimp sent a campaign list in a shape ShelfReady does not know.');
      return json.campaigns.map(campaignFrom);
    },
    async getCampaign(id, opts) {
      return campaignFrom(await send('GET', `/3.0/campaigns/${idOk(id)}`, { fields: opts?.segmentText ? `${CAMPAIGN_FIELDS},recipients.segment_text` : CAMPAIGN_FIELDS }));
    },
    async getContent(id) {
      const json = (await send('GET', `/3.0/campaigns/${idOk(id)}/content`, { fields: 'html' })) as { html?: unknown } | null;
      if (!json || typeof json.html !== 'string') throw new MailchimpError('unknown', 'Mailchimp sent the email without its HTML.');
      return json.html;
    },
    async getContentWithText(id) {
      const json = (await send('GET', `/3.0/campaigns/${idOk(id)}/content`, { fields: 'html,plain_text' })) as { html?: unknown; plain_text?: unknown } | null;
      if (!json || typeof json.html !== 'string') throw new MailchimpError('unknown', 'Mailchimp sent the email without its HTML.');
      return { html: json.html, plainText: typeof json.plain_text === 'string' ? json.plain_text : '' };
    },
    async replicate(id) {
      return campaignFrom(await send('POST', `/3.0/campaigns/${idOk(id)}/actions/replicate`, {}));
    },
    async setTitle(id, settings) {
      const { title, subject_line, from_name, reply_to, preview_text, to_name } = settings;
      await send('PATCH', `/3.0/campaigns/${idOk(id)}`, {}, { settings: { title, subject_line, from_name, reply_to, preview_text, to_name } });
    },
    async putContent(id, html) {
      await send('PUT', `/3.0/campaigns/${idOk(id)}/content`, {}, { html });
    },
    async unschedule(id) {
      await send('POST', `/3.0/campaigns/${idOk(id)}/actions/unschedule`, {});
    },
    async schedule(id, scheduleTime) {
      await send('POST', `/3.0/campaigns/${idOk(id)}/actions/schedule`, {}, { schedule_time: scheduleTime });
    },
  };
}
