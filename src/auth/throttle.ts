// Sign-in throttling per username and per IP address, kept in the database so a restart
// does not reset it. After a set number of failures each further failure doubles the lockout,
// up to a cap. The same keys apply whether or not the username exists, so a lockout tells an
// attacker nothing about which accounts are real.
//
// Race safety: callers check the lock and record the attempt in one synchronous step, before
// the first await (the password hash). So parallel attempts cannot all slip past the check.
// A correct password then calls attemptSucceeded, which clears the username count and takes
// back the one IP count it added.
//
// The typed username is never stored. Rows are keyed by an HMAC of the lowercased name, with a
// key derived from the master key, so a copy of the database does not show what was typed, even
// when a password was typed into the username box. IPv4 addresses are stored as they are. IPv6
// addresses are counted by their /64, since one device can use many addresses in its /64.

import { createHmac } from 'node:crypto';
import { appendAudit, SYSTEM_ACTOR } from '../db/audit.ts';
import { deriveKey, type MasterKeys } from '../settings/crypto.ts';
import type { Db } from '../db/db.ts';
import type { ServerConfig } from '../server/config.ts';
import { throttleAddress } from '../server/network.ts';

type ThrottleConfig = ServerConfig['throttle'];

interface Row {
  key: string;
  failures: number;
  last_failure_at: number;
  locked_until: number;
}

/** Turns a typed username into its throttle key. */
export type UserKeyer = (username: string) => string;

/** The keyer the server and the admin command line share, derived from the master key. */
export function userKeyerFor(mk: MasterKeys): UserKeyer {
  return createUserKeyer(deriveKey(mk, 'login throttle v1'));
}

/** secret: 32 bytes. Use userKeyerFor unless a test needs its own secret. */
export function createUserKeyer(secret: Buffer): UserKeyer {
  return (username) =>
    `user:${createHmac('sha256', secret).update(username.trim().toLowerCase().normalize('NFKC').slice(0, 256), 'utf8').digest('hex')}`;
}

/** The throttle key for an address: IPv4 as is, IPv6 by its /64 (src/server/network.ts). */
export function ipKey(ip: string): string {
  return `ip:${throttleAddress(ip)}`;
}

function getRow(db: Db, key: string, cfg: ThrottleConfig, now: number): Row | undefined {
  const r = db.prepare('SELECT * FROM login_throttle WHERE key = ?').get(key) as Row | undefined;
  if (!r) return undefined;
  if (now - r.last_failure_at > cfg.windowMinutes * 60 * 1000 && now >= r.locked_until) {
    db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key);
    return undefined;
  }
  return r;
}

/** Milliseconds until a sign in may be tried again for any of the keys, or 0 if none is locked. */
export function lockedFor(db: Db, keys: string[], now: number, cfg: ThrottleConfig): number {
  let wait = 0;
  for (const k of keys) {
    const r = getRow(db, k, cfg, now);
    if (r && r.locked_until > now) wait = Math.max(wait, r.locked_until - now);
  }
  return wait;
}

function lockMs(failures: number, threshold: number, cfg: ThrottleConfig): number {
  if (failures < threshold) return 0;
  const steps = Math.min(failures - threshold, 30);
  return Math.min(cfg.baseLockSeconds * 2 ** steps, cfg.maxLockSeconds) * 1000;
}

function bump(db: Db, key: string, threshold: number, now: number, cfg: ThrottleConfig): void {
  const r = getRow(db, key, cfg, now);
  const failures = (r?.failures ?? 0) + 1;
  const lockedUntil = Math.max(r?.locked_until ?? 0, now + lockMs(failures, threshold, cfg));
  db.prepare(
    `INSERT INTO login_throttle (key, failures, last_failure_at, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, last_failure_at = excluded.last_failure_at, locked_until = excluded.locked_until`,
  ).run(key, failures, now, lockedUntil);
}

export type AttemptResult = { ok: true } | { ok: false; waitMs: number };

/**
 * Checks the lock and, if open, counts this attempt as a failure up front. Synchronous: call it
 * before any await. Returns ok false if the username or the IP is locked.
 */
export function beginAttempt(db: Db, user: string, ip: string, now: number, cfg: ThrottleConfig): AttemptResult {
  const keys = [user, ipKey(ip)];
  const waitMs = lockedFor(db, keys, now, cfg);
  if (waitMs > 0) return { ok: false, waitMs };
  bump(db, keys[0], cfg.userFailures, now, cfg);
  bump(db, keys[1], cfg.ipFailures, now, cfg);
  pruneThrottle(db, now);
  return { ok: true };
}

/** Drops rows with no failure for 24 hours and no lock. Also run hourly by the server. */
export function pruneThrottle(db: Db, now: number): void {
  db.prepare('DELETE FROM login_throttle WHERE last_failure_at < ? AND locked_until < ?').run(now - 24 * 60 * 60 * 1000, now);
}

/**
 * user is the key from a UserKeyer. The password was right. Clears the username's count, and takes back this attempt's IP count.
 * The rest of the IP count stays, so one valid account cannot reset it for an attacker.
 */
export function attemptSucceeded(db: Db, user: string, ip: string, cfg: ThrottleConfig): void {
  db.prepare('DELETE FROM login_throttle WHERE key = ?').run(user);
  const key = ipKey(ip);
  const r = db.prepare('SELECT * FROM login_throttle WHERE key = ?').get(key) as Row | undefined;
  if (!r) return;
  const failures = r.failures - 1;
  if (failures <= 0) {
    db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key);
  } else {
    // Below the threshold no lock should stand. At or above it, keep the earlier lock.
    db.prepare('UPDATE login_throttle SET failures = ?, locked_until = ? WHERE key = ?').run(
      failures,
      failures < cfg.ipFailures ? 0 : r.locked_until,
      key,
    );
  }
}

/** Lifts the sign-in lockout for one username, for the admin command line. IP lockouts stay. */
export function clearUserLock(db: Db, username: string, keyer: UserKeyer): void {
  db.prepare('DELETE FROM login_throttle WHERE key = ?').run(keyer(username));
}

const HOUR_MS = 60 * 60 * 1000;
const KEEP_HOURS = 30 * 24;

export type LoginEventKind = 'unknown_user' | 'locked' | 'busy';

/**
 * Counts a failed sign in for an unknown name, a locked attempt or a busy refusal. One counter
 * row per hour and kind, so the table stays small however many attempts arrive. No username or
 * address is kept: a username may be a typed password, and nothing needs them.
 */
export function recordLoginEvent(db: Db, kind: LoginEventKind, now: number): void {
  db.prepare(
    `INSERT INTO login_events (hour, kind, events) VALUES (?, ?, 1)
     ON CONFLICT(hour, kind) DO UPDATE SET events = events + 1`,
  ).run(Math.floor(now / HOUR_MS), kind);
  summarizeLoginEvents(db, now);
}

/**
 * Writes one audit line covering every finished hour not yet summarized, then prunes summarized
 * hours older than 30 days. Called on each event and from the hourly timer, so the last hour
 * before a quiet spell is summarized too. Writes nothing when there is nothing new.
 */
export function summarizeLoginEvents(db: Db, now: number): void {
  const current = Math.floor(now / HOUR_MS);
  const last = db.prepare("SELECT details FROM audit_log WHERE action = 'auth.login_events_summary' ORDER BY id DESC LIMIT 1").get() as
    | { details: string }
    | undefined;
  const through = last ? Number((JSON.parse(last.details) as { throughHour?: number }).throughHour ?? -1) : -1;
  const rows = db
    .prepare('SELECT kind, sum(events) AS n, min(hour) AS first, max(hour) AS lastHour FROM login_events WHERE hour > ? AND hour < ? GROUP BY kind')
    .all(through, current) as { kind: string; n: number; first: number; lastHour: number }[];
  let summarizedThrough = through;
  if (rows.length > 0) {
    const counts: Record<string, number> = {};
    let first = current;
    let lastHour = through;
    for (const r of rows) {
      counts[r.kind] = r.n;
      first = Math.min(first, r.first);
      lastHour = Math.max(lastHour, r.lastHour);
    }
    summarizedThrough = lastHour;
    appendAudit(
      db,
      SYSTEM_ACTOR,
      {
        action: 'auth.login_events_summary',
        details: { from: new Date(first * HOUR_MS).toISOString(), to: new Date((lastHour + 1) * HOUR_MS).toISOString(), throughHour: lastHour, counts },
      },
      now,
    );
  }
  // Only hours already in a summary are pruned, so no count is lost.
  db.prepare('DELETE FROM login_events WHERE hour < ? AND hour <= ?').run(current - KEEP_HOURS, summarizedThrough);
}

/** Caps how many password hashes run at once, so a burst of sign ins cannot exhaust memory or CPU. */
export interface HashLimiter {
  tryAcquire(): boolean;
  release(): void;
  readonly active: number;
}

export function createHashLimiter(max: number): HashLimiter {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= max) return false;
      active++;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
    },
    get active() {
      return active;
    },
  };
}
