// Database access for sending a run: the send's phase, every Square write with its idempotency
// key, every ScaleConnect preview and what became of it, the pending scales and their resends.
// Column names come from fixed maps, never from input.

import type { Db } from '../db/db.ts';
import { toJson } from './store.ts';

export type SendPhase = 'sending_square' | 'square_done' | 'square_failed' | 'scale_preview' | 'sending_scales' | 'done' | 'partial';

/** Plain words for pages. */
export const PHASE_LABELS: Record<SendPhase, string> = {
  sending_square: 'Sending to Square',
  square_done: 'Square is done. Preparing the scales',
  square_failed: 'Square did not finish. Nothing was sent to the scales',
  scale_preview: 'Square is done. The scale change waits for a person',
  sending_scales: 'Square is done. Sending to the scales',
  done: 'Done: Square and every scale',
  partial: 'Square is done. Some scales are pending',
};

/**
 * Each Square item the run touches, exactly as first read before any write (with its variations).
 * A retry compares what Square holds now against this with ShelfReady's own confirmed writes
 * applied, so it can tell its own writes from someone else's.
 */
export interface SendSnapshot {
  takenAt: number;
  items: Record<string, Record<string, unknown>>;
  /**
   * Corrections recorded before their stock went to Square, folded into the send: skipped holds
   * variations where nothing arrived after all (nothing is sent for them), minus the stock taken
   * off a count before it was sent, foldedLines the corrections handled this way.
   */
  folded?: { skipped: string[]; minus: Record<string, number>; foldedLines: number[] };
}

export interface RunSend {
  runId: number;
  phase: SendPhase;
  scales: string[];
  allScales: string[];
  startedBy: number | null;
  startedByName: string;
  startedAt: number;
  snapshot: SendSnapshot | null;
  squareReport: unknown;
  message: string;
  updatedAt: number;
}

interface DbSend {
  run_id: number;
  phase: SendPhase;
  scales: string;
  all_scales: string;
  started_by: number | null;
  started_by_name: string;
  started_at: number;
  snapshot: string;
  square_report: string;
  message: string;
  updated_at: number;
}

export function getSend(db: Db, runId: number): RunSend | null {
  const r = db.prepare('SELECT * FROM run_sends WHERE run_id = ?').get(runId) as DbSend | undefined;
  if (!r) return null;
  return {
    runId: r.run_id,
    phase: r.phase,
    scales: JSON.parse(r.scales) as string[],
    allScales: JSON.parse(r.all_scales) as string[],
    startedBy: r.started_by,
    startedByName: r.started_by_name,
    startedAt: r.started_at,
    snapshot: JSON.parse(r.snapshot) as SendSnapshot | null,
    squareReport: JSON.parse(r.square_report),
    message: r.message,
    updatedAt: r.updated_at,
  };
}

export function createSend(db: Db, runId: number, s: { scales: string[]; allScales: string[]; startedBy: number | null; startedByName: string }, now: number): void {
  db.prepare(
    `INSERT INTO run_sends (run_id, phase, scales, all_scales, started_by, started_by_name, started_at, updated_at) VALUES (?, 'sending_square', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET phase = 'sending_square', scales = excluded.scales, all_scales = excluded.all_scales, updated_at = excluded.updated_at`,
  ).run(runId, toJson(s.scales), toJson(s.allScales), s.startedBy, s.startedByName, now, now);
}

const SEND_COLUMNS: Record<string, string> = { phase: 'phase', snapshot: 'snapshot', squareReport: 'square_report', message: 'message', allScales: 'all_scales' };
const SEND_JSON = new Set(['snapshot', 'squareReport', 'allScales']);

export function updateSend(db: Db, runId: number, fields: Partial<Pick<RunSend, 'phase' | 'snapshot' | 'squareReport' | 'message' | 'allScales'>>, now: number): void {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = SEND_COLUMNS[k];
    if (!col) throw new Error(`unknown send field ${k}`);
    sets.push(`${col} = ?`);
    vals.push(SEND_JSON.has(k) ? toJson(v ?? null) : (v as string));
  }
  sets.push('updated_at = ?');
  vals.push(now);
  db.prepare(`UPDATE run_sends SET ${sets.join(', ')} WHERE run_id = ?`).run(...vals, runId);
}

// ---- Square writes

export type WriteStep = 'rename' | 'variations' | 'inventory' | 'correction';
export type WriteState = 'sending' | 'confirmed' | 'failed';

export interface SquareWriteRow {
  id: number;
  runId: number;
  step: WriteStep;
  idempotencyKey: string;
  body: Record<string, unknown>;
  objectIds: string[];
  state: WriteState;
  error: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export function squareWrites(db: Db, runId: number): SquareWriteRow[] {
  const rows = db.prepare('SELECT * FROM square_writes WHERE run_id = ? ORDER BY id').all(runId) as Array<{
    id: number;
    run_id: number;
    step: WriteStep;
    idempotency_key: string;
    body: string;
    object_ids: string;
    state: WriteState;
    error: string;
    attempts: number;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    step: r.step,
    idempotencyKey: r.idempotency_key,
    body: JSON.parse(r.body) as Record<string, unknown>,
    objectIds: JSON.parse(r.object_ids) as string[],
    state: r.state,
    error: r.error,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/** Stores a write before it is sent, with its key and exact body. */
export function addSquareWrite(db: Db, runId: number, w: { step: WriteStep; idempotencyKey: string; body: unknown; objectIds: string[] }, now: number): number {
  const res = db
    .prepare("INSERT INTO square_writes (run_id, step, idempotency_key, body, object_ids, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'sending', ?, ?)")
    .run(runId, w.step, w.idempotencyKey, toJson(w.body), toJson(w.objectIds), now, now);
  return Number(res.lastInsertRowid);
}

/** Adds delta (1 before a call, -1 when this client refused it before sending) to the tries that may have reached Square. */
export function markWriteAttempt(db: Db, id: number, now: number, delta: 1 | -1): void {
  db.prepare('UPDATE square_writes SET attempts = max(0, attempts + ?), updated_at = ? WHERE id = ?').run(delta, now, id);
}

export function setWriteState(db: Db, id: number, state: WriteState, error: string, now: number): void {
  db.prepare('UPDATE square_writes SET state = ?, error = ?, updated_at = ? WHERE id = ?').run(state, error.slice(0, 300), now, id);
}

// ---- ScaleConnect steps

export type StepKind = 'push' | 'settle';
export type StepState = 'previewed' | 'blocked' | 'acknowledged' | 'applying' | 'unknown' | 'success' | 'partial' | 'failed' | 'refused' | 'replaced';

/** What a person is shown of a ScaleConnect preview, and what the apply needs. Text from scales is data. */
export interface StepPreview {
  summary: string;
  expiresAt: string;
  scales: string[];
  mustAcknowledge: boolean;
  warnings: Array<{ code: string; message: string; requiresAck: boolean; mayBeFrozen: boolean }>;
  driftTokens: string[];
  drift: Array<{ token: string; scale: string; plu: string; text: string }>;
  driftCannotAck: string[];
  leftOut: string[];
  mayBeFrozen: string[];
  differences: Array<{ plu: string; fields: string }>;
  /** The price each change would put on the scale, by PLU, when it changes the price. */
  newPrices?: Record<string, string>;
  /** Why the preview cannot be applied, or ''. */
  blockedWhy: string;
  /** Ties a person's yes to exactly this list of warnings and drift. */
  digest: string;
}

export interface StepAck {
  byName: string;
  byId: number | null;
  at: number;
  acknowledgeWarnings: boolean;
  acknowledgeDrift: string[];
}

export interface ScaleStepRow {
  id: number;
  runId: number;
  kind: StepKind;
  scale: string;
  code: string;
  previewId: string;
  preview: StepPreview | null;
  state: StepState;
  ack: StepAck | null;
  result: unknown;
  createdAt: number;
  updatedAt: number;
}

export function scaleSteps(db: Db, runId: number): ScaleStepRow[] {
  const rows = db.prepare('SELECT * FROM scale_steps WHERE run_id = ? ORDER BY id').all(runId) as Array<{
    id: number;
    run_id: number;
    kind: StepKind;
    scale: string;
    code: string;
    preview_id: string;
    preview: string;
    state: StepState;
    ack: string;
    result: string;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    scale: r.scale,
    code: r.code,
    previewId: r.preview_id,
    preview: JSON.parse(r.preview) as StepPreview | null,
    state: r.state,
    ack: JSON.parse(r.ack) as StepAck | null,
    result: JSON.parse(r.result),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function addScaleStep(db: Db, runId: number, s: { kind: StepKind; scale?: string; code?: string; previewId: string; preview: StepPreview | null; state: StepState; result?: unknown }, now: number): number {
  const res = db
    .prepare('INSERT INTO scale_steps (run_id, kind, scale, code, preview_id, preview, state, result, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, s.kind, s.scale ?? '', s.code ?? '', s.previewId, toJson(s.preview), s.state, toJson(s.result ?? null), now, now);
  return Number(res.lastInsertRowid);
}

export function updateScaleStep(db: Db, id: number, fields: { state?: StepState; ack?: StepAck | null; result?: unknown }, now: number): void {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  if (fields.state !== undefined) {
    sets.push('state = ?');
    vals.push(fields.state);
  }
  if (fields.ack !== undefined) {
    sets.push('ack = ?');
    vals.push(toJson(fields.ack));
  }
  if (fields.result !== undefined) {
    sets.push('result = ?');
    vals.push(toJson(fields.result));
  }
  sets.push('updated_at = ?');
  vals.push(now);
  db.prepare(`UPDATE scale_steps SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

// ---- Pending scales

export type PendingReason = 'not_verified' | 'not_targeted' | 'may_be_frozen' | 'not_known';

export interface PendingRow {
  scale: string;
  code: string;
  priceCents: number;
  itemName: string;
  reason: PendingReason;
  state: 'pending' | 'resolved';
  resolvedHow: string;
  updatedAt: number;
}

export function pendingRows(db: Db, runId: number): PendingRow[] {
  const rows = db.prepare('SELECT * FROM scale_pending WHERE run_id = ? ORDER BY scale, code').all(runId) as Array<{
    scale: string;
    code: string;
    price_cents: number;
    item_name: string;
    reason: PendingReason;
    state: 'pending' | 'resolved';
    resolved_how: string;
    updated_at: number;
  }>;
  return rows.map((r) => ({ scale: r.scale, code: r.code, priceCents: r.price_cents, itemName: r.item_name, reason: r.reason, state: r.state, resolvedHow: r.resolved_how, updatedAt: r.updated_at }));
}

export function setPending(db: Db, runId: number, p: { scale: string; code: string; priceCents: number; itemName: string; reason: PendingReason }, now: number): void {
  db.prepare(
    `INSERT INTO scale_pending (run_id, scale, code, price_cents, item_name, reason, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(run_id, scale, code) DO UPDATE SET price_cents = excluded.price_cents, item_name = excluded.item_name, reason = excluded.reason,
       state = 'pending', resolved_how = '', updated_at = excluded.updated_at`,
  ).run(runId, p.scale, p.code, p.priceCents, p.itemName.slice(0, 200), p.reason, now);
}

export function resolvePending(db: Db, runId: number, scale: string, code: string, how: string, now: number): void {
  db.prepare("UPDATE scale_pending SET state = 'resolved', resolved_how = ?, updated_at = ? WHERE run_id = ? AND scale = ? AND code = ? AND state = 'pending'").run(how.slice(0, 200), now, runId, scale, code);
}

export function openPending(db: Db, runId: number): number {
  return (db.prepare("SELECT count(*) AS n FROM scale_pending WHERE run_id = ? AND state = 'pending'").get(runId) as { n: number }).n;
}

// ---- Resends

export type ResendState = 'looked' | 'still_frozen' | 'previewed' | 'applying' | 'done' | 'stopped';

export interface ResendRow {
  scale: string;
  state: ResendState;
  lookedByName: string;
  lookedAt: number;
  message: string;
  updatedAt: number;
}

export function resends(db: Db, runId: number): ResendRow[] {
  const rows = db.prepare('SELECT * FROM scale_resends WHERE run_id = ? ORDER BY scale').all(runId) as Array<{ scale: string; state: ResendState; looked_by_name: string; looked_at: number; message: string; updated_at: number }>;
  return rows.map((r) => ({ scale: r.scale, state: r.state, lookedByName: r.looked_by_name, lookedAt: r.looked_at, message: r.message, updatedAt: r.updated_at }));
}

export function startResend(db: Db, runId: number, scale: string, byName: string, now: number): void {
  db.prepare(
    `INSERT INTO scale_resends (run_id, scale, state, looked_by_name, looked_at, message, updated_at) VALUES (?, ?, 'looked', ?, ?, '', ?)
     ON CONFLICT(run_id, scale) DO UPDATE SET state = 'looked', looked_by_name = excluded.looked_by_name, looked_at = excluded.looked_at, message = '', updated_at = excluded.updated_at`,
  ).run(runId, scale, byName, now, now);
}

export function setResend(db: Db, runId: number, scale: string, state: ResendState, message: string, now: number): void {
  db.prepare('UPDATE scale_resends SET state = ?, message = ?, updated_at = ? WHERE run_id = ? AND scale = ?').run(state, message.slice(0, 500), now, runId, scale);
}
