// Card copy written for an invoice run: one row per run and Square variation (migration 7).
//
// - A row says where the product's new copy stands in this run: asked for, being written, written,
//   failed, waiting for an admin's cost approval, approved, or cut short by a restart.
// - "calling" is written, and committed, before a paid call starts. A restart leaves it there, and
//   the next job turns it into "interrupted": that call may have been paid for, so it is never sent
//   again on its own. A person asks again (requestCopy), as for a reading.
// - Each waiting card's amount is stored here only. One admin approval covers every card still
//   waiting in the run (DECISIONS.md, Card copy budget): the admin needs a recent password (the
//   route checks the role and the password), and the form must repeat the stored model, the total
//   and the list it covers. The rows then move to approved, so the same approval cannot be used
//   twice.
// - Money is in the spend ledger (src/runs/spend.ts), not here.

import { createHash } from 'node:crypto';
import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import type { CopyResult } from '../copy/generate.ts';
import { redactSecrets } from '../invoice/redact.ts';
import { runSpend } from './spend.ts';
import { RunError } from './store.ts';

export type RunCopyState = 'requested' | 'calling' | 'written' | 'review' | 'failed' | 'needs_approval' | 'approved' | 'interrupted';

export interface RunCopyRow {
  runId: number;
  variationId: string;
  state: RunCopyState;
  /** What this run's copy calls for this product have cost, or may have, in US dollars. */
  costUsd: number;
  cardId: number | null;
  reasons: string[];
  /** For needs_approval and approved: the model and the amount, two decimals. */
  approvalModel: string;
  approvalUsd: string;
  approvedByName: string;
  approvedAt: number | null;
  requestedByName: string;
  updatedAt: number;
}

interface DbRow {
  run_id: number;
  variation_id: string;
  state: RunCopyState;
  card_id: number | null;
  reasons: string;
  approval_model: string;
  approval_usd: string;
  approved_by: number | null;
  approved_by_name: string;
  approved_at: number | null;
  requested_by_name: string;
  updated_at: number;
}

function fromDb(db: Db, r: DbRow): RunCopyRow {
  const reasons = JSON.parse(r.reasons) as unknown;
  return {
    runId: r.run_id,
    variationId: r.variation_id,
    state: r.state,
    costUsd: runSpend(db, r.run_id, 'copy', r.variation_id),
    cardId: r.card_id,
    reasons: Array.isArray(reasons) ? reasons.filter((x): x is string => typeof x === 'string') : [],
    approvalModel: r.approval_model,
    approvalUsd: r.approval_usd,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    requestedByName: r.requested_by_name,
    updatedAt: r.updated_at,
  };
}

export function runCopyRows(db: Db, runId: number): Map<string, RunCopyRow> {
  const rows = db.prepare('SELECT * FROM run_copy WHERE run_id = ? ORDER BY id').all(runId) as unknown as DbRow[];
  return new Map(rows.map((r) => [r.variation_id, fromDb(db, r)]));
}

export function runCopyRow(db: Db, runId: number, variationId: string): RunCopyRow | null {
  const r = db.prepare('SELECT * FROM run_copy WHERE run_id = ? AND variation_id = ?').get(runId, variationId) as DbRow | undefined;
  return r ? fromDb(db, r) : null;
}

/** An amount to approve: the worst case rounded up to the cent, so approving it always covers it. */
export function approvalAmount(worstUsd: number): string {
  return (Math.ceil(Math.max(0, worstUsd) * 100 - 1e-6) / 100).toFixed(2);
}

function upsert(db: Db, runId: number, variationId: string, fields: Partial<Record<keyof DbRow, string | number | null>>, now: number): void {
  const cols = Object.keys(fields) as Array<keyof DbRow>;
  for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error('bad run_copy column');
  const exists = db.prepare('SELECT 1 FROM run_copy WHERE run_id = ? AND variation_id = ?').get(runId, variationId);
  if (exists) {
    db.prepare(`UPDATE run_copy SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE run_id = ? AND variation_id = ?`).run(
      ...cols.map((c) => fields[c] as string | number | null),
      now,
      runId,
      variationId,
    );
  } else {
    db.prepare(`INSERT INTO run_copy (run_id, variation_id, ${cols.join(', ')}, updated_at) VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?)`).run(
      runId,
      variationId,
      ...cols.map((c) => fields[c] as string | number | null),
      now,
    );
  }
}

const CLEAR_APPROVAL = { approval_model: '', approval_usd: '', approved_by: null, approved_by_name: '', approved_at: null } as const;

/** A person asks for copy for one product. Refused while a call is under way or already queued. */
export function requestCopy(db: Db, actor: AuditActor, runId: number, variationId: string, now: number): void {
  inTransaction(db, () => {
    const row = runCopyRow(db, runId, variationId);
    if (row && (row.state === 'calling' || row.state === 'requested' || row.state === 'approved')) throw new RunError('Copy for this card is already being written, or is queued.', 409);
    upsert(db, runId, variationId, { state: 'requested', reasons: '[]', requested_by_name: actor.username, ...CLEAR_APPROVAL }, now);
    appendAudit(db, actor, { action: 'run.copy_requested', entityType: 'run', entityId: runId, runId, details: { variationId } }, now);
  });
}

/** Records that a paid call for this product is about to start. Committed before the call. */
export function markCalling(db: Db, runId: number, variationId: string, now: number): void {
  upsert(db, runId, variationId, { state: 'calling' }, now);
}

const RESTARTED = 'ShelfReady restarted while writing this card. That call may already have been paid for, so it was not sent again, and its worst case was counted. Press Write copy now to try once more.';

/**
 * Turns calls left under way into interrupted: one run's at the start of its job, or every run's
 * at start up. Only one job runs at a time, so a call still marked then was cut short.
 */
export function interruptCalls(db: Db, runId: number | null, now: number): number {
  const sql = "UPDATE run_copy SET state = 'interrupted', reasons = ?, updated_at = ? WHERE state = 'calling'" + (runId === null ? '' : ' AND run_id = ?');
  const args: Array<string | number> = [JSON.stringify([RESTARTED]), now];
  if (runId !== null) args.push(runId);
  return Number(db.prepare(sql).run(...args).changes);
}

/** Stores one product's result and writes run.copy to the audit log. The cost is booked in the ledger by the caller. */
export function recordCopyResult(db: Db, actor: AuditActor, runId: number, variationId: string, r: CopyResult, now: number): void {
  inTransaction(db, () => {
    const before = runCopyRow(db, runId, variationId);
    const state: RunCopyState = r.status === 'written' ? 'written' : r.status;
    const approval = r.status === 'needs_approval' && r.approval ? { approval_model: r.approval.model, approval_usd: approvalAmount(r.approval.worstUsd), approved_by: null, approved_by_name: '', approved_at: null } : CLEAR_APPROVAL;
    upsert(db, runId, variationId, { state, card_id: r.card?.id ?? null, reasons: JSON.stringify(r.reasons.map((x) => redactSecrets(x, 400)).slice(0, 20)), ...approval }, now);
    appendAudit(
      db,
      actor,
      {
        action: 'run.copy',
        entityType: 'run',
        entityId: runId,
        runId,
        details: {
          variationId,
          status: r.status,
          cardId: r.card?.id ?? null,
          totalCostUsd: Math.round(Math.max(0, r.costUsd) * 1e6) / 1e6,
          calls: r.attempts.length,
          models: [...new Set(r.attempts.map((a) => a.model))],
          // The approval stays on the row while its call is under way, and is cleared after.
          approvedBy: before?.approvedByName || null,
          approval: r.approval ? { model: r.approval.model, worstUsd: approvalAmount(r.approval.worstUsd) } : null,
        },
      },
      now,
    );
  });
}

/** Marks a product failed without a call, for example when the key is missing. */
export function recordCopyRefusal(db: Db, runId: number, variationId: string, reasons: string[], now: number): void {
  upsert(db, runId, variationId, { state: 'failed', reasons: JSON.stringify(reasons.map((x) => redactSecrets(x, 400))), ...CLEAR_APPROVAL }, now);
}

/** Cards waiting for an approval, as one batch: the model, the total and a fingerprint of what it covers. */
export interface CopyApprovalBatch {
  model: string;
  /** Two decimals. */
  totalUsd: string;
  /** Ties the approval to exactly these cards and amounts. */
  fingerprint: string;
  cards: Array<{ variationId: string; usd: string }>;
}

/** The batch for these waiting rows, or null when none waits. Every row must name the same model. */
export function approvalBatch(rows: readonly RunCopyRow[]): CopyApprovalBatch | null {
  const waiting = rows.filter((r) => r.state === 'needs_approval').sort((a, b) => (a.variationId < b.variationId ? -1 : a.variationId > b.variationId ? 1 : 0));
  if (waiting.length === 0) return null;
  const models = [...new Set(waiting.map((r) => r.approvalModel))];
  const cents = waiting.reduce((s, r) => s + Math.round(Number(r.approvalUsd) * 100), 0);
  const cards = waiting.map((r) => ({ variationId: r.variationId, usd: r.approvalUsd }));
  const fingerprint = createHash('sha256').update(JSON.stringify({ models, cards })).digest('hex').slice(0, 32);
  return { model: models.length === 1 ? models[0]! : models.join(', '), totalUsd: (cents / 100).toFixed(2), fingerprint, cards };
}

/**
 * An admin approves every card in the batch at once. shown must repeat the stored model, total
 * and fingerprint; currentModel is the copy model in settings now, which must still be the one.
 * Each card is then written under its own stored amount. The rows move to approved, so the same
 * approval cannot be used again.
 */
export function approveCopyBatch(
  db: Db,
  actor: AuditActor & { userId: number },
  runId: number,
  batch: CopyApprovalBatch | null,
  shown: { model: string; totalUsd: string; fingerprint: string },
  currentModel: string,
  now: number,
): void {
  inTransaction(db, () => {
    if (!batch) throw new RunError('No card is waiting for a cost approval.', 409);
    if (shown.model !== batch.model || shown.totalUsd !== batch.totalUsd || shown.fingerprint !== batch.fingerprint) {
      throw new RunError('The cards or the cost to approve changed since the page was shown. Look at them again.', 409);
    }
    if (batch.model !== currentModel) throw new RunError('The copy model in settings changed since these costs were worked out. Press Write copy now to see the new cost.', 409);
    for (const c of batch.cards) {
      const row = runCopyRow(db, runId, c.variationId);
      if (!row || row.state !== 'needs_approval' || row.approvalUsd !== c.usd) throw new RunError('The cards or the cost to approve changed since the page was shown. Look at them again.', 409);
      upsert(db, runId, c.variationId, { state: 'approved', approved_by: actor.userId, approved_by_name: actor.username, approved_at: now }, now);
    }
    appendAudit(db, actor, { action: 'run.copy_cost_approved', entityType: 'run', entityId: runId, runId, details: { model: batch.model, totalUsd: batch.totalUsd, cards: batch.cards } }, now);
  });
}
