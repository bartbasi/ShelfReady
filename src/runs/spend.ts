// The spend ledger: what every model call may have cost, for the budgets (migration 7).
//
// - Before a paid call goes out, its worst case is written as reserved. When it comes back, the
//   real cost replaces it (booked). So a budget read while a call is under way already counts it.
// - A restart books whatever is still reserved at its worst case: that call may have been paid
//   for, and the budgets must never count less than was spent.
// - Budgets add up reserved and booked rows: the daily limit over all runs (readings and copy
//   together), the card copy budget over every copy call of one run.

import { appendAudit, SYSTEM_ACTOR } from '../db/audit.ts';
import type { Db } from '../db/db.ts';

export type SpendKind = 'read' | 'copy';

const money = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) / 1e6 : 0);

/** Writes a call's worst case before it goes out. Returns the ledger row id. */
export function reserveSpend(db: Db, e: { runId: number; kind: SpendKind; variationId?: string; usd: number }, now: number): number {
  const res = db
    .prepare("INSERT INTO model_spend (run_id, kind, variation_id, state, usd, estimate, at, updated_at) VALUES (?, ?, ?, 'reserved', ?, 1, ?, ?)")
    .run(e.runId, e.kind, e.variationId ?? '', money(e.usd), now, now);
  return Number(res.lastInsertRowid);
}

/** Raises a reservation, for a further call of the same product. Never lowers it. */
export function raiseReservation(db: Db, id: number, usd: number, now: number): void {
  db.prepare("UPDATE model_spend SET usd = max(usd, ?), updated_at = ? WHERE id = ? AND state = 'reserved'").run(money(usd), now, id);
}

/** Replaces a reservation with the real cost the API reported. */
export function settleSpend(db: Db, id: number, usd: number, now: number): void {
  db.prepare("UPDATE model_spend SET state = 'booked', usd = ?, estimate = 0, updated_at = ? WHERE id = ?").run(money(usd), now, id);
}

/**
 * Books reservations left by a restart at their worst case: all of them at start up, or one
 * run's copy calls at the start of its job. Only one job runs at a time, so any reservation
 * still open then belongs to a call that was cut short.
 */
export function bookCutShort(db: Db, now: number, only?: { runId: number; kind: SpendKind }): { count: number; usd: number } {
  // Only invoice runs' own calls. Old invoices book theirs (src/history/store.ts bookCutShortReads).
  const where = only ? "state = 'reserved' AND run_id = ? AND kind = ?" : "state = 'reserved' AND run_id IS NOT NULL";
  const args = only ? [only.runId, only.kind] : [];
  const rows = db.prepare(`SELECT id, run_id, kind, variation_id, usd FROM model_spend WHERE ${where}`).all(...args) as Array<{ id: number; run_id: number | null; kind: string; variation_id: string; usd: number }>;
  for (const r of rows) {
    db.prepare("UPDATE model_spend SET state = 'booked', estimate = 1, updated_at = ? WHERE id = ?").run(now, r.id);
    appendAudit(db, SYSTEM_ACTOR, { action: 'run.spend_cut_short', entityType: 'run', entityId: r.run_id ?? '', runId: r.run_id ?? undefined, details: { kind: r.kind, variationId: r.variation_id, bookedUsd: r.usd, costIsEstimate: true } }, now);
  }
  return { count: rows.length, usd: rows.reduce((s, r) => s + Number(r.usd), 0) };
}

/** What all model calls have cost, or may have, since the given time. */
export function spendSince(db: Db, since: number): number {
  const r = db.prepare('SELECT coalesce(sum(usd), 0) AS usd FROM model_spend WHERE at >= ?').get(since) as { usd: number };
  return Number(r.usd) || 0;
}

/** What one run's calls of a kind have cost, or may have: every call, not only the latest. */
export function runSpend(db: Db, runId: number, kind: SpendKind, variationId?: string): number {
  const r = (
    variationId === undefined
      ? db.prepare('SELECT coalesce(sum(usd), 0) AS usd FROM model_spend WHERE run_id = ? AND kind = ?').get(runId, kind)
      : db.prepare('SELECT coalesce(sum(usd), 0) AS usd FROM model_spend WHERE run_id = ? AND kind = ? AND variation_id = ?').get(runId, kind, variationId)
  ) as { usd: number };
  return Number(r.usd) || 0;
}
