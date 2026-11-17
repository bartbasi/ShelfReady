// Users and roles. Two roles, as the brief says:
// manager: upload, review, approve, dry run, resend to a scale.
// admin: everything a manager can do, plus settings, keys and user management.

import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import type { ScryptParams } from '../server/config.ts';
import { hashPassword, passwordProblem } from './password.ts';

export type Role = 'manager' | 'admin';
export const ROLES: readonly Role[] = ['manager', 'admin'];

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
  disabled: boolean;
  createdAt: string;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  must_change_password: number;
  disabled: number;
  created_at: string;
}

/** A problem a person can fix, with a message safe to show on screen. */
export class UserError extends Error {}

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$/;

export function isRole(v: unknown): v is Role {
  return v === 'manager' || v === 'admin';
}

function toUser(r: UserRow): UserWithHash {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role,
    mustChangePassword: r.must_change_password === 1,
    disabled: r.disabled === 1,
    createdAt: r.created_at,
    passwordHash: r.password_hash,
  };
}

function strip(u: UserWithHash): User {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}

export function usernameProblem(username: string): string | undefined {
  if (!USERNAME_RE.test(username)) {
    return 'Usernames are 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.';
  }
  return undefined;
}

export function findUserByUsername(db: Db, username: string): UserWithHash | undefined {
  const r = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) as UserRow | undefined;
  return r ? toUser(r) : undefined;
}

export function getUser(db: Db, id: number): User | undefined {
  const r = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return r ? strip(toUser(r)) : undefined;
}

export function listUsers(db: Db): User[] {
  const rows = db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all() as unknown as UserRow[];
  return rows.map((r) => strip(toUser(r)));
}

export function countUsers(db: Db): number {
  return (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n;
}

function countActiveAdmins(db: Db): number {
  return (db.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
}

export interface NewUser {
  username: string;
  displayName?: string;
  role: Role;
  password: string;
  /** Set when someone other than the user picked the password. */
  mustChangePassword?: boolean;
}

export async function createUser(
  db: Db,
  input: NewUser,
  opts: { scrypt: ScryptParams; minLength: number; actor: AuditActor; now?: number },
): Promise<User> {
  const username = input.username.trim();
  const up = usernameProblem(username);
  if (up) throw new UserError(up);
  if (!isRole(input.role)) throw new UserError('Pick a role: manager or admin.');
  const pp = passwordProblem(input.password, opts.minLength, username);
  if (pp) throw new UserError(pp);
  const displayName = (input.displayName ?? '').trim().slice(0, 64);
  const hash = await hashPassword(input.password, opts.scrypt);
  const t = opts.now ?? Date.now();
  const now = new Date(t).toISOString();
  return inTransaction(db, () => {
    if (findUserByUsername(db, username)) throw new UserError('That username is taken.');
    const res = db
      .prepare(
        `INSERT INTO users (username, display_name, role, password_hash, must_change_password, disabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(username, displayName, input.role, hash, input.mustChangePassword ? 1 : 0, now, now);
    const id = Number(res.lastInsertRowid);
    appendAudit(db, opts.actor, { action: 'user.create', entityType: 'user', entityId: id, details: { username, role: input.role } }, t);
    return getUser(db, id)!;
  });
}

/** Disable or enable an account. Disabling also ends all its sessions. */
// Users are disabled, never deleted, so the audit log always names who did what.
export function setDisabled(db: Db, userId: number, disabled: boolean, actor: AuditActor, now: number = Date.now()): void {
  inTransaction(db, () => {
    const u = getUser(db, userId);
    if (!u) throw new UserError('No such user.');
    if (disabled && actor.userId === userId) throw new UserError('You cannot disable your own account.');
    if (disabled && u.role === 'admin' && !u.disabled && countActiveAdmins(db) <= 1) {
      throw new UserError('This is the last active admin. Make another admin first.');
    }
    db.prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?').run(disabled ? 1 : 0, new Date(now).toISOString(), userId);
    if (disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    appendAudit(db, actor, { action: disabled ? 'user.disable' : 'user.enable', entityType: 'user', entityId: userId, details: { username: u.username } }, now);
  });
}

export function setRole(db: Db, userId: number, role: Role, actor: AuditActor, now: number = Date.now()): void {
  if (!isRole(role)) throw new UserError('Pick a role: manager or admin.');
  inTransaction(db, () => {
    const u = getUser(db, userId);
    if (!u) throw new UserError('No such user.');
    if (u.role === role) return;
    if (u.role === 'admin' && !u.disabled && countActiveAdmins(db) <= 1) {
      throw new UserError('This is the last active admin. Make another admin first.');
    }
    db.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').run(role, new Date(now).toISOString(), userId);
    // A role change takes effect on the next request, since sessions look up the role each time.
    appendAudit(db, actor, { action: 'user.role', entityType: 'user', entityId: userId, details: { username: u.username, from: u.role, to: role } }, now);
  });
}

/**
 * Sets a new password and ends every session the user has.
 * byAdmin: an admin picked it, so the user must choose their own at next sign in.
 */
export async function setPassword(
  db: Db,
  userId: number,
  password: string,
  opts: { scrypt: ScryptParams; minLength: number; actor: AuditActor; byAdmin: boolean; now?: number },
): Promise<void> {
  const u = getUser(db, userId);
  if (!u) throw new UserError('No such user.');
  const pp = passwordProblem(password, opts.minLength, u.username);
  if (pp) throw new UserError(pp);
  const hash = await hashPassword(password, opts.scrypt);
  const now = opts.now ?? Date.now();
  inTransaction(db, () => {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?').run(
      hash,
      opts.byAdmin ? 1 : 0,
      new Date(now).toISOString(),
      userId,
    );
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    appendAudit(db, opts.actor, {
      action: opts.byAdmin ? 'user.password_reset' : 'user.password_change',
      entityType: 'user',
      entityId: userId,
      details: { username: u.username },
    }, now);
  });
}
