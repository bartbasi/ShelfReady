// Database access for invoice runs. Every state change goes through setState, which refuses a
// move the state machine does not allow. Every decision and state change is audited with the run id.

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { recordUploadAttemptOf, storedUploadBytesSince, uploadAttemptsOfSince } from '../db/uploads.ts';
import { recordRunInHistory } from '../history/runs.ts';
import type { CatalogData, CatalogSourceKind } from '../square/catalog-source.ts';
import { canMove, isRunState, type RunState } from './states.ts';

/** A refusal with words safe to show. statusCode lets the server's error handler use it too. */
export class RunError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RunError';
    this.status = status;
  }
  get statusCode(): number {
    return this.status;
  }
}

/** JSON that survives bigint values (exact prices use them). */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
}

export interface RunRow {
  id: number;
  state: RunState;
  createdBy: number;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  catalogSnapshotId: number | null;
  readStatus: '' | 'ok' | 'review' | 'needs_approval' | 'retry';
  readResult: unknown;
  pendingApproval: unknown;
  approvalModel: string;
  approvalEstimateUsd: string;
  costApprovedBy: number | null;
  costApprovedByName: string;
  costApprovedAt: number | null;
  evaluation: unknown;
  blockers: number;
  dryRun: unknown;
  dryRunHash: string;
  dryRunAt: number | null;
  approvedBy: number | null;
  approvedByName: string;
  approvedAt: number | null;
  message: string;
  catalogTakenAt: string;
  /** The automatic first pass of card copy is done. */
  copyAutoDone: boolean;
}

interface DbRun {
  id: number;
  state: string;
  created_by: number;
  created_by_name: string;
  created_at: number;
  updated_at: number;
  catalog_snapshot_id: number | null;
  read_status: string;
  read_result: string;
  pending_approval: string;
  approval_model: string;
  approval_estimate_usd: string;
  cost_approved_by: number | null;
  cost_approved_by_name: string;
  cost_approved_at: number | null;
  evaluation: string;
  blockers: number;
  dry_run: string;
  dry_run_hash: string;
  dry_run_at: number | null;
  approved_by: number | null;
  approved_by_name: string;
  approved_at: number | null;
  message: string;
  catalog_taken_at: string;
  copy_auto_done: number;
}

function fromDb(r: DbRun): RunRow {
  if (!isRunState(r.state)) throw new Error('a run has an unknown state');
  return {
    id: r.id,
    state: r.state,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    catalogSnapshotId: r.catalog_snapshot_id,
    readStatus: r.read_status as RunRow['readStatus'],
    readResult: JSON.parse(r.read_result),
    pendingApproval: JSON.parse(r.pending_approval),
    approvalModel: r.approval_model,
    approvalEstimateUsd: r.approval_estimate_usd,
    costApprovedBy: r.cost_approved_by,
    costApprovedByName: r.cost_approved_by_name,
    costApprovedAt: r.cost_approved_at,
    evaluation: JSON.parse(r.evaluation),
    blockers: r.blockers,
    dryRun: JSON.parse(r.dry_run),
    dryRunHash: r.dry_run_hash,
    dryRunAt: r.dry_run_at,
    approvedBy: r.approved_by,
    approvedByName: r.approved_by_name,
    approvedAt: r.approved_at,
    message: r.message,
    catalogTakenAt: r.catalog_taken_at,
    copyAutoDone: r.copy_auto_done === 1,
  };
}

export interface StoredFile {
  storedName: string;
  originalName: string;
  kind: 'jpeg' | 'png' | 'webp' | 'heif' | 'pdf';
  bytes: number;
  sha256: string;
}

export interface RunFile extends StoredFile {
  id: number;
  runId: number;
  position: number;
}

/**
 * Creates a run. maxPerHour is checked again here, inside the transaction, so uploads that
 * finish at the same moment cannot pass the limit together.
 */
export function createRun(db: Db, actor: AuditActor & { userId: number }, files: readonly StoredFile[], now: number, maxPerHour = Infinity): number {
  return inTransaction(db, () => {
    if (uploadsSince(db, actor.userId, now - 3600_000) >= maxPerHour) throw new RunError('You have uploaded a lot of invoices in the last hour. Wait a while and try again.', 429);
    const res = db
      .prepare('INSERT INTO runs (state, created_by, created_by_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('uploaded', actor.userId, actor.username, now, now);
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare('INSERT INTO run_files (run_id, position, stored_name, original_name, kind, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    files.forEach((f, i) => ins.run(id, i + 1, f.storedName, f.originalName, f.kind, f.bytes, f.sha256, now));
    addEvent(db, id, 'upload', `${files.length} ${files.length === 1 ? 'file' : 'files'} uploaded by ${actor.username}.`, now);
    appendAudit(
      db,
      actor,
      { action: 'run.upload', entityType: 'run', entityId: id, runId: id, details: { files: files.map((f) => ({ name: f.originalName, kind: f.kind, bytes: f.bytes, sha256: f.sha256 })) } },
      now,
    );
    return id;
  });
}

export function getRun(db: Db, id: number): RunRow | null {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as DbRun | undefined;
  return r ? fromDb(r) : null;
}

export function mustGetRun(db: Db, id: number): RunRow {
  const r = getRun(db, id);
  if (!r) throw new RunError('There is no such invoice run.', 404);
  return r;
}

export interface RunListItem {
  id: number;
  state: RunState;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  blockers: number;
  supplier: string;
  invoiceNumber: string;
}

export function listRuns(db: Db, limit = 50): RunListItem[] {
  const rows = db
    .prepare(
      `SELECT id, state, created_by_name, created_at, updated_at, blockers,
         coalesce(json_extract(read_result, '$.reading.invoice.supplier_name'), '') AS supplier,
         coalesce(json_extract(read_result, '$.reading.invoice.invoice_number'), '') AS invoice_number
       FROM runs ORDER BY id DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 500)) as Array<{ id: number; state: string; created_by_name: string; created_at: number; updated_at: number; blockers: number; supplier: unknown; invoice_number: unknown }>;
  return rows.map((r) => ({
    id: r.id,
    state: isRunState(r.state) ? r.state : 'failed',
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    blockers: r.blockers,
    supplier: String(r.supplier ?? '').slice(0, 120),
    invoiceNumber: String(r.invoice_number ?? '').slice(0, 60),
  }));
}

export function runFiles(db: Db, runId: number): RunFile[] {
  const rows = db.prepare('SELECT * FROM run_files WHERE run_id = ? ORDER BY position').all(runId) as Array<{
    id: number;
    run_id: number;
    position: number;
    stored_name: string;
    original_name: string;
    kind: RunFile['kind'];
    bytes: number;
    sha256: string;
  }>;
  return rows.map((r) => ({ id: r.id, runId: r.run_id, position: r.position, storedName: r.stored_name, originalName: r.original_name, kind: r.kind, bytes: r.bytes, sha256: r.sha256 }));
}

/** Moves a run to a new state, if the state machine allows it, and records why. */
export function setState(db: Db, id: number, to: RunState, opts: { now: number; actor: AuditActor; message?: string; fields?: Record<string, unknown> }): RunRow {
  return inTransaction(db, () => {
    const run = mustGetRun(db, id);
    if (run.state !== to && !canMove(run.state, to)) throw new RunError(`This invoice is ${run.state}, so it cannot move to ${to}.`, 409);
    updateRun(db, id, { ...(opts.fields ?? {}), state: to, message: opts.message ?? '' }, opts.now);
    if (run.state !== to) {
      appendAudit(db, opts.actor, { action: 'run.state', entityType: 'run', entityId: id, runId: id, details: { from: run.state, to, message: opts.message ?? '' } }, opts.now);
    }
    return mustGetRun(db, id);
  });
}

const COLUMNS: Record<string, string> = {
  state: 'state',
  message: 'message',
  catalogSnapshotId: 'catalog_snapshot_id',
  readStatus: 'read_status',
  readResult: 'read_result',
  pendingApproval: 'pending_approval',
  approvalModel: 'approval_model',
  approvalEstimateUsd: 'approval_estimate_usd',
  costApprovedBy: 'cost_approved_by',
  costApprovedByName: 'cost_approved_by_name',
  costApprovedAt: 'cost_approved_at',
  evaluation: 'evaluation',
  blockers: 'blockers',
  dryRun: 'dry_run',
  dryRunHash: 'dry_run_hash',
  dryRunAt: 'dry_run_at',
  approvedBy: 'approved_by',
  approvedByName: 'approved_by_name',
  approvedAt: 'approved_at',
  catalogTakenAt: 'catalog_taken_at',
  copyAutoDone: 'copy_auto_done',
};
const JSON_FIELDS = new Set(['readResult', 'pendingApproval', 'evaluation', 'dryRun']);

/** Sets the named fields. Column names come from a fixed map, never from input. */
export function updateRun(db: Db, id: number, fields: Record<string, unknown>, now: number): void {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = COLUMNS[k];
    if (!col) throw new Error(`unknown run field ${k}`);
    sets.push(`${col} = ?`);
    vals.push(JSON_FIELDS.has(k) ? toJson(v ?? null) : (v as string | number | null));
  }
  sets.push('updated_at = ?');
  vals.push(now);
  db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

export interface RunEvent {
  at: number;
  stage: string;
  message: string;
}

export function addEvent(db: Db, runId: number, stage: string, message: string, now: number): void {
  db.prepare('INSERT INTO run_events (run_id, at, stage, message) VALUES (?, ?, ?, ?)').run(runId, now, stage.slice(0, 40), message.slice(0, 500));
}

export function runEvents(db: Db, runId: number, limit = 200): RunEvent[] {
  return (db.prepare('SELECT at, stage, message FROM run_events WHERE run_id = ? ORDER BY id DESC LIMIT ?').all(runId, limit) as unknown as RunEvent[]).reverse();
}

// Decisions

export const DECISION_KINDS = ['skip_line', 'pick', 'not_for_resale', 'received', 'override', 'conflict', 'rename', 'description', 'accept_check', 'accept_big_change', 'card_skip'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface Decision {
  kind: DecisionKind;
  target: string;
  value: Record<string, unknown>;
  decidedBy: number | null;
  decidedByName: string;
  decidedAt: number;
}

export function runDecisions(db: Db, runId: number): Decision[] {
  const rows = db.prepare('SELECT kind, target, value, decided_by, decided_by_name, decided_at FROM run_decisions WHERE run_id = ? ORDER BY id').all(runId) as Array<{
    kind: DecisionKind;
    target: string;
    value: string;
    decided_by: number | null;
    decided_by_name: string;
    decided_at: number;
  }>;
  return rows.map((r) => ({ kind: r.kind, target: r.target, value: JSON.parse(r.value) as Record<string, unknown>, decidedBy: r.decided_by, decidedByName: r.decided_by_name, decidedAt: r.decided_at }));
}

export function setDecision(db: Db, actor: AuditActor, runId: number, kind: DecisionKind, target: string, value: Record<string, unknown>, now: number): void {
  inTransaction(db, () => {
    const before = db.prepare('SELECT value FROM run_decisions WHERE run_id = ? AND kind = ? AND target = ?').get(runId, kind, target) as { value: string } | undefined;
    db.prepare(
      `INSERT INTO run_decisions (run_id, kind, target, value, decided_by, decided_by_name, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, kind, target) DO UPDATE SET value = excluded.value, decided_by = excluded.decided_by,
         decided_by_name = excluded.decided_by_name, decided_at = excluded.decided_at`,
    ).run(runId, kind, target, toJson(value), actor.userId, actor.username, now);
    appendAudit(
      db,
      actor,
      { action: `run.decide.${kind}`, entityType: 'run', entityId: runId, runId, details: { target, value, before: before ? JSON.parse(before.value) : null } },
      now,
    );
    // What arrived changes the purchase history's quantity. Never blocks the decision.
    if (kind === 'received') recordRunInHistory(db, runId, now);
  });
}

export function clearDecision(db: Db, actor: AuditActor, runId: number, kind: DecisionKind, target: string, now: number): boolean {
  return inTransaction(db, () => {
    const before = db.prepare('SELECT value FROM run_decisions WHERE run_id = ? AND kind = ? AND target = ?').get(runId, kind, target) as { value: string } | undefined;
    if (!before) return false;
    db.prepare('DELETE FROM run_decisions WHERE run_id = ? AND kind = ? AND target = ?').run(runId, kind, target);
    appendAudit(db, actor, { action: `run.undo.${kind}`, entityType: 'run', entityId: runId, runId, details: { target, before: JSON.parse(before.value) } }, now);
    if (kind === 'received') recordRunInHistory(db, runId, now);
    return true;
  });
}

// Jobs

export const SEND_JOB_KINDS = ['send_square', 'scale_preview', 'send_scales', 'scale_lookup', 'resend_compare', 'resend_apply', 'corrections'] as const;
export type SendJobKind = (typeof SEND_JOB_KINDS)[number];
export type JobKind = 'process' | 'dry_run' | SendJobKind;
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';

export interface Job {
  id: number;
  runId: number;
  kind: JobKind;
  state: JobState;
  resumeApproved: boolean;
  queuedBy: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string;
}

interface DbJob {
  id: number;
  run_id: number;
  kind: JobKind;
  state: JobState;
  resume_approved: number;
  queued_by: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string;
}

function jobFromDb(r: DbJob): Job {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    state: r.state,
    resumeApproved: r.resume_approved === 1,
    queuedBy: r.queued_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    error: r.error,
  };
}

/** The run's queued or running job, if any. A run has at most one at a time. */
export function activeJob(db: Db, runId: number): Job | null {
  const r = db.prepare("SELECT * FROM run_jobs WHERE run_id = ? AND state IN ('queued', 'running') ORDER BY id LIMIT 1").get(runId) as DbJob | undefined;
  return r ? jobFromDb(r) : null;
}

export function enqueueJob(db: Db, runId: number, kind: JobKind, queuedBy: number | null, now: number, opts: { resumeApproved?: boolean } = {}): number {
  return inTransaction(db, () => {
    if (activeJob(db, runId)) throw new RunError('This invoice is already being worked on. Wait for it to finish.', 409);
    const res = db
      .prepare('INSERT INTO run_jobs (run_id, kind, state, resume_approved, queued_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, kind, 'queued', opts.resumeApproved ? 1 : 0, queuedBy, now);
    return Number(res.lastInsertRowid);
  });
}

/** Takes the oldest queued job and marks it running, in one step. */
export function claimNextJob(db: Db, now: number): Job | null {
  return inTransaction(db, () => {
    const r = db.prepare("SELECT * FROM run_jobs WHERE state = 'queued' ORDER BY id LIMIT 1").get() as DbJob | undefined;
    if (!r) return null;
    db.prepare("UPDATE run_jobs SET state = 'running', started_at = ? WHERE id = ?").run(now, r.id);
    return jobFromDb({ ...r, state: 'running', started_at: now });
  });
}

export function finishJob(db: Db, id: number, state: 'done' | 'failed' | 'interrupted', now: number, error = ''): void {
  db.prepare('UPDATE run_jobs SET state = ?, finished_at = ?, error = ? WHERE id = ?').run(state, now, error.slice(0, 500), id);
}

export function runningJobs(db: Db): Job[] {
  return (db.prepare("SELECT * FROM run_jobs WHERE state = 'running' ORDER BY id").all() as unknown as DbJob[]).map(jobFromDb);
}

export function queuedJobCount(db: Db): number {
  return (db.prepare("SELECT count(*) AS n FROM run_jobs WHERE state = 'queued'").get() as { n: number }).n;
}

/** Runs this user uploaded since the given time, for the upload rate limit. */
export function uploadsSince(db: Db, userId: number, since: number): number {
  return (db.prepare('SELECT count(*) AS n FROM runs WHERE created_by = ? AND created_at >= ?').get(userId, since) as { n: number }).n;
}

// Catalog snapshots

export interface StoredCatalog extends CatalogData {
  id: number;
  sha256: string;
}

/** Saves a catalog once per content and returns its id. */
export function saveCatalogSnapshot(db: Db, data: CatalogData, now: number): number {
  const json = toJson({ objects: data.objects });
  const sha = createHash('sha256').update(`${data.source}\n${data.locationId}\n${json}`).digest('hex');
  return inTransaction(db, () => {
    const found = db.prepare('SELECT id FROM catalog_snapshots WHERE sha256 = ?').get(sha) as { id: number } | undefined;
    if (found) return found.id;
    const res = db
      .prepare('INSERT INTO catalog_snapshots (sha256, source, location_id, taken_at, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha, data.source, data.locationId, data.takenAt, gzipSync(json), now);
    return Number(res.lastInsertRowid);
  });
}

export function loadCatalogSnapshot(db: Db, id: number): StoredCatalog {
  const r = db.prepare('SELECT id, sha256, source, location_id, taken_at, data FROM catalog_snapshots WHERE id = ?').get(id) as
    | { id: number; sha256: string; source: CatalogSourceKind; location_id: string; taken_at: string; data: Uint8Array }
    | undefined;
  if (!r) throw new RunError('The catalog this invoice was matched against is missing.', 500);
  const parsed = JSON.parse(gunzipSync(Buffer.from(r.data)).toString('utf8')) as { objects: unknown[] };
  return { id: r.id, sha256: r.sha256, source: r.source, locationId: r.location_id, takenAt: r.taken_at, objects: parsed.objects };
}

/**
 * Records an upload attempt, refused or not, and prunes attempts older than a day. The caller
 * stops recording once a person is over the limit, so a flood cannot grow the table.
 */
export function recordUploadAttempt(db: Db, userId: number, now: number): void {
  recordUploadAttemptOf(db, 'run', userId, now);
}

/** Invoice run upload attempts only. Old invoices have their own hourly limit. */
export function uploadAttemptsSince(db: Db, userId: number, since: number): number {
  return uploadAttemptsOfSince(db, 'run', userId, since);
}

/**
 * Bytes of invoice files kept since the given time, for everyone or for one person. Old invoice
 * files count too, so both kinds of upload share one daily allowance (src/db/uploads.ts).
 */
export function uploadBytesSince(db: Db, since: number, userId?: number): number {
  return storedUploadBytesSince(db, since, userId);
}

/** Other live runs holding a file with one of these hashes, uploaded since the given time. */
export function runsWithSameFiles(db: Db, runId: number, since: number): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT f2.run_id AS id FROM run_files f1 JOIN run_files f2 ON f2.sha256 = f1.sha256 AND f2.run_id <> f1.run_id
       JOIN runs r ON r.id = f2.run_id
       WHERE f1.run_id = ? AND r.state <> 'failed' AND f2.created_at >= ? ORDER BY f2.run_id`,
    )
    .all(runId, since) as { id: number }[];
  return rows.map((r) => r.id);
}

// Corrections after approval

export interface Correction {
  line: number;
  variationId: string;
  stockTakeBack: string;
  stockUnit: '' | 'lb' | 'unit';
  creditCents: number;
  state: 'pending' | 'sent';
  recordedByName: string;
  recordedAt: number;
}

export function runCorrections(db: Db, runId: number): Correction[] {
  const rows = db.prepare('SELECT * FROM run_corrections WHERE run_id = ? ORDER BY line').all(runId) as Array<{
    line: number;
    variation_id: string;
    stock_take_back: string;
    stock_unit: Correction['stockUnit'];
    credit_cents: number;
    state: Correction['state'];
    recorded_by_name: string;
    recorded_at: number;
  }>;
  return rows.map((r) => ({
    line: r.line,
    variationId: r.variation_id,
    stockTakeBack: r.stock_take_back,
    stockUnit: r.stock_unit,
    creditCents: r.credit_cents,
    state: r.state,
    recordedByName: r.recorded_by_name,
    recordedAt: r.recorded_at,
  }));
}

export function addCorrection(db: Db, actor: AuditActor, runId: number, c: Omit<Correction, 'state' | 'recordedByName' | 'recordedAt'>, now: number): void {
  inTransaction(db, () => {
    if (db.prepare('SELECT 1 FROM run_corrections WHERE run_id = ? AND line = ?').get(runId, c.line)) throw new RunError('That line is already marked as not arrived.', 409);
    db.prepare(
      `INSERT INTO run_corrections (run_id, line, variation_id, stock_take_back, stock_unit, credit_cents, recorded_by, recorded_by_name, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(runId, c.line, c.variationId, c.stockTakeBack, c.stockUnit, c.creditCents, actor.userId, actor.username, now);
    appendAudit(db, actor, { action: 'run.correct.not_arrived', entityType: 'run', entityId: runId, runId, details: { ...c } }, now);
    addEvent(db, runId, 'correction', `${actor.username} marked line ${c.line} as not arrived.`, now);
    // The purchase history shows the line as not arrived. Never blocks the correction.
    recordRunInHistory(db, runId, now);
  });
}
