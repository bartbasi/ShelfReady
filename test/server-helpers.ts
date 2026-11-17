// Shared test helpers. Each test app gets its own temp folder for the database and master key,
// so tests never touch ~/.config/shelfready or data/.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../src/server/app.ts';
import { makeConfig, type ConfigInput, type ServerConfig } from '../src/server/config.ts';
import { createUser, type Role } from '../src/auth/users.ts';
import { SYSTEM_ACTOR } from '../src/db/audit.ts';

export const ORIGIN = 'http://127.0.0.1:3000';
export const START = Date.parse('2026-11-06T18:00:00Z');
/** Fast scrypt for tests only. */
export const TEST_SCRYPT = { N: 1024, r: 8, p: 1 };
export const ADMIN_PW = 'correct horse battery staple';
export const MANAGER_PW = 'manager pass phrase 42';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'shelfready-test-'));
}

export interface TestApp {
  app: FastifyInstance;
  config: ServerConfig;
  dir: string;
  logs: string[];
  advance(ms: number): void;
  close(): Promise<void>;
}

export async function makeApp(overrides: ConfigInput = {}, extraDeps: Partial<AppDeps> = {}): Promise<TestApp> {
  const dir = tempDir();
  let clock = START;
  const logs: string[] = [];
  // trace, so the log-leak tests see every line the server could ever write.
  const config = makeConfig(
    {
      dbPath: join(dir, 'data', 'test.sqlite3'),
      masterKeyPath: join(dir, 'keys', 'master.key'),
      // The settings page reads the certificate status: never from ~/.config/shelfready in tests.
      tls: { enabled: false, certPath: join(dir, 'tls', 'fullchain.pem'), keyPath: join(dir, 'tls', 'key.pem') },
      scrypt: TEST_SCRYPT,
      logLevel: 'trace',
      ...overrides,
    },
    { allowVerboseLogs: true },
  );
  const app = await buildApp(config, { now: () => clock, logStream: { write: (l: string) => void logs.push(l) }, ...extraDeps });
  return {
    app,
    config,
    dir,
    logs,
    advance(ms: number) {
      clock += ms;
    },
    async close() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function addUser(t: TestApp, username: string, role: Role, password: string, mustChangePassword = false): Promise<number> {
  const u = await createUser(
    t.app.shelf.db,
    { username, role, password, mustChangePassword },
    { scrypt: TEST_SCRYPT, minLength: t.config.passwordMinLength, actor: SYSTEM_ACTOR },
  );
  return u.id;
}

/**
 * Log lines as text, plus every Buffer or byte array in them decoded, so a secret hidden in raw
 * bytes is still found.
 */
export function logText(lines: string[]): string {
  const out: string[] = [...lines];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      if (v.length > 0 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) out.push(Buffer.from(v as number[]).toString('latin1'));
      else v.forEach(walk);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (o.type === 'Buffer' && Array.isArray(o.data)) out.push(Buffer.from(o.data as number[]).toString('latin1'));
      Object.values(o).forEach(walk);
    } else if (typeof v === 'string' && /^[A-Za-z0-9+/]{24,}={0,2}$/.test(v)) {
      out.push(Buffer.from(v, 'base64').toString('latin1'));
    }
  };
  for (const l of lines) {
    try {
      walk(JSON.parse(l));
    } catch {
      // Not JSON: the raw text is already included.
    }
  }
  return out.join('\n');
}

/** Moves the session's last password entry into the past, as if time had passed. */
export function ageReauth(t: TestApp, ms: number): void {
  t.app.shelf.db.prepare('UPDATE sessions SET auth_at = auth_at - ?').run(ms);
}

export function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function csrfFrom(body: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(body);
  if (!m) throw new Error('no csrf token in page');
  return m[1];
}

function cookieValue(res: { cookies: { name: string; value: string }[] }, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}

export interface LoginResult {
  status: number;
  location?: string;
  /** Cookie header to send on later requests, or '' if sign in failed. */
  cookie: string;
  body: string;
  setCookie: string[];
}

export async function login(t: TestApp, username: string, password: string, remember = false, ip = '127.0.0.1'): Promise<LoginResult> {
  const page = await t.app.inject({ method: 'GET', url: '/login', remoteAddress: ip });
  const loginCookie = cookieValue(page, 'sr_login')!;
  const res = await t.app.inject({
    method: 'POST',
    url: '/login',
    remoteAddress: ip,
    headers: { origin: ORIGIN, cookie: `sr_login=${loginCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ _csrf: csrfFrom(page.body), username, password, ...(remember ? { remember: '1' } : {}) }),
  });
  const session = cookieValue(res, 'sr_session');
  const raw = res.headers['set-cookie'];
  return {
    status: res.statusCode,
    location: res.headers.location as string | undefined,
    cookie: session ? `sr_session=${session}` : '',
    body: res.body,
    setCookie: raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)],
  };
}

export async function get(t: TestApp, url: string, cookie = '') {
  return t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

/** Reads the page's csrf token, then posts. Pass csrf or origin to override. */
export async function post(
  t: TestApp,
  url: string,
  cookie: string,
  fields: Record<string, string>,
  opts: { csrf?: string; origin?: string | null; referer?: string; csrfPage?: string } = {},
) {
  let csrf = opts.csrf;
  if (csrf === undefined) {
    const page = await get(t, opts.csrfPage ?? '/account', cookie);
    csrf = csrfFrom(page.body);
  }
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie) headers.cookie = cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.referer) headers.referer = opts.referer;
  return t.app.inject({ method: 'POST', url, headers, payload: form({ _csrf: csrf, ...fields }) });
}
