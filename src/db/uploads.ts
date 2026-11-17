// Upload budgets shared by invoice runs and old invoices.
//
// - Bytes kept on disk: one daily allowance for everyone and one per person, counting run files
//   and old invoice files together, so neither kind of upload can use the other's share.
// - Upload attempts per person per hour: kept in one table, counted by kind, because old invoices
//   have their own hourly limit and must not use up the one for invoice runs.

import type { Db } from './db.ts';

export type UploadKind = 'run' | 'history';

/** Bytes of invoice files kept since the given time, invoice runs and old invoices together. */
export function storedUploadBytesSince(db: Db, since: number, userId?: number): number {
  const q = (sql: string, ...args: number[]) => Number((db.prepare(sql).get(...args) as { n: number }).n) || 0;
  if (userId === undefined) {
    return q('SELECT coalesce(sum(bytes), 0) AS n FROM run_files WHERE created_at >= ?', since) + q('SELECT coalesce(sum(bytes), 0) AS n FROM purchase_files WHERE created_at >= ?', since);
  }
  return (
    q('SELECT coalesce(sum(f.bytes), 0) AS n FROM run_files f JOIN runs r ON r.id = f.run_id WHERE f.created_at >= ? AND r.created_by = ?', since, userId) +
    q('SELECT coalesce(sum(f.bytes), 0) AS n FROM purchase_files f JOIN purchase_invoices p ON p.id = f.invoice_id WHERE f.created_at >= ? AND p.created_by = ?', since, userId)
  );
}

/** Counts one upload attempt of a kind. Rows older than a day are pruned. */
export function recordUploadAttemptOf(db: Db, kind: UploadKind, userId: number, now: number): void {
  db.prepare('INSERT INTO upload_attempts (user_id, kind, at) VALUES (?, ?, ?)').run(userId, kind, now);
  db.prepare('DELETE FROM upload_attempts WHERE at < ?').run(now - 24 * 3600_000);
}

export function uploadAttemptsOfSince(db: Db, kind: UploadKind, userId: number, since: number): number {
  return (db.prepare('SELECT count(*) AS n FROM upload_attempts WHERE user_id = ? AND kind = ? AND at >= ?').get(userId, kind, since) as { n: number }).n;
}
