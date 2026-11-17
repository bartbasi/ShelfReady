// The audit log. Append only: the database refuses updates and deletes.
// Never put a secret, a password or a token in details.

import type { Db } from './db.ts';

export interface AuditActor {
  userId: number | null;
  username: string;
  ip?: string;
}

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | number;
  runId?: number;
  details?: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  at: string;
  user_id: number | null;
  username: string;
  action: string;
  entity_type: string;
  entity_id: string;
  run_id: number | null;
  ip: string;
  details: string;
}

export const SYSTEM_ACTOR: AuditActor = { userId: null, username: 'system' };

/** now is milliseconds since 1970, from the app's clock so tests can move it. */
export function appendAudit(db: Db, actor: AuditActor, entry: AuditEntry, now: number = Date.now()): number {
  const res = db
    .prepare(
      `INSERT INTO audit_log (at, user_id, username, action, entity_type, entity_id, run_id, ip, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date(now).toISOString(),
      actor.userId,
      actor.username,
      entry.action,
      entry.entityType ?? '',
      entry.entityId === undefined ? '' : String(entry.entityId),
      entry.runId ?? null,
      actor.ip ?? '',
      JSON.stringify(entry.details ?? {}),
    );
  return Number(res.lastInsertRowid);
}

export function listAudit(db: Db, opts: { limit?: number; action?: string } = {}): AuditRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  if (opts.action) {
    return db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?').all(opts.action, limit) as unknown as AuditRow[];
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as AuditRow[];
}
