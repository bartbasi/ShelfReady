// Sessions. The browser holds a random 256-bit token. The server keeps only its SHA-256,
// so a copy of the database cannot be used to sign in.

import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/db.ts';
import type { ServerConfig } from '../server/config.ts';
import type { Role } from './users.ts';

export interface SessionUser {
  sessionHash: string;
  csrfToken: string;
  remember: boolean;
  /** When the password was last typed on this session, in milliseconds. */
  authAt: number;
  userId: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

interface Row {
  id_hash: string;
  csrf_token: string;
  remember: number;
  auth_at: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  user_id: number;
  username: string;
  display_name: string;
  role: Role;
  must_change_password: number;
  disabled: number;
}

/** Only touch last_seen_at once a minute, to keep writes down. */
const TOUCH_EVERY_MS = 60 * 1000;

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface SessionPolicy {
  rememberMs: number;
  idleMs: number;
  absoluteMs: number;
}

export function sessionPolicy(c: ServerConfig): SessionPolicy {
  return {
    rememberMs: c.session.rememberDays * 24 * 60 * 60 * 1000,
    idleMs: c.session.idleMinutes * 60 * 1000,
    absoluteMs: c.session.absoluteHours * 60 * 60 * 1000,
  };
}

export function createSession(
  db: Db,
  userId: number,
  opts: { remember: boolean; policy: SessionPolicy; now: number; ip: string; userAgent: string },
): { token: string; expiresAt: number } {
  const token = newToken();
  const expiresAt = opts.now + (opts.remember ? opts.policy.rememberMs : opts.policy.absoluteMs);
  db.prepare(
    `INSERT INTO sessions (id_hash, user_id, csrf_token, remember, auth_at, created_at, last_seen_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(token), userId, newToken(), opts.remember ? 1 : 0, opts.now, opts.now, opts.now, expiresAt, opts.ip.slice(0, 64), opts.userAgent.slice(0, 200));
  return { token, expiresAt };
}

/** The signed-in user for a token, or undefined if the session is unknown, expired, idle too long or the user is disabled. */
export function lookupSession(db: Db, token: string, policy: SessionPolicy, now: number): SessionUser | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
  const idHash = hashToken(token);
  const r = db
    .prepare(
      `SELECT s.id_hash, s.csrf_token, s.remember, s.auth_at, s.created_at, s.last_seen_at, s.expires_at,
              u.id AS user_id, u.username, u.display_name, u.role, u.must_change_password, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
    .get(idHash) as Row | undefined;
  if (!r) return undefined;
  const idleExpired = r.remember === 0 && now - r.last_seen_at > policy.idleMs;
  if (now >= r.expires_at || idleExpired || r.disabled === 1) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
    return undefined;
  }
  if (now - r.last_seen_at >= TOUCH_EVERY_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now, idHash);
  }
  return {
    sessionHash: r.id_hash,
    csrfToken: r.csrf_token,
    remember: r.remember === 1,
    authAt: r.auth_at,
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    mustChangePassword: r.must_change_password === 1,
  };
}

/** The password was typed again on this session. */
export function markReauth(db: Db, sessionHash: string, now: number): void {
  db.prepare('UPDATE sessions SET auth_at = ? WHERE id_hash = ?').run(now, sessionHash);
}

export function deleteSession(db: Db, sessionHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sessionHash);
}

/** Sign out everywhere. Returns how many sessions ended. */
export function deleteUserSessions(db: Db, userId: number): number {
  return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes);
}

export function purgeExpiredSessions(db: Db, policy: SessionPolicy, now: number): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR (remember = 0 AND last_seen_at < ?)').run(now, now - policy.idleMs);
}
