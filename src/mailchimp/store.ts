// Database access for the fish email: dry run previews, tasks and the copies ShelfReady asked for.
// Column names come from fixed maps, never from input.

import type { Db } from '../db/db.ts';
import { inTransaction } from '../db/db.ts';
import { toJson } from '../runs/store.ts';
import type { MailchimpPreview, PlannedRow } from './plan.ts';

// ---- Dry run previews

export function savePreview(db: Db, runId: number, dryRunHash: string, preview: MailchimpPreview, now: number): void {
  db.prepare(
    `INSERT INTO mailchimp_previews (run_id, dry_run_hash, preview, made_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET dry_run_hash = excluded.dry_run_hash, preview = excluded.preview, made_at = excluded.made_at`,
  ).run(runId, dryRunHash, toJson(preview), now);
}

/** The preview made with this dry run, or null when there is none for it. */
export function getPreview(db: Db, runId: number, dryRunHash: string): MailchimpPreview | null {
  const r = db.prepare('SELECT dry_run_hash, preview FROM mailchimp_previews WHERE run_id = ?').get(runId) as { dry_run_hash: string; preview: string } | undefined;
  if (!r || r.dry_run_hash !== dryRunHash || !dryRunHash) return null;
  return JSON.parse(r.preview) as MailchimpPreview;
}

// ---- Tasks

export type TaskKind = 'run' | 'check';
export type TaskState = 'queued' | 'running' | 'done' | 'stopped' | 'needs_person';
export type AlertLevel = '' | 'note' | 'warn' | 'red';

/** How far a task got. Kept after each step, so a restart carries on from what Mailchimp holds. */
export interface TaskProgress {
  /** The send day (YYYY-MM-DD, local) and time this task works for. */
  day?: string;
  sendAt?: number;
  mode?: 'edit' | 'copy';
  /** The campaign being changed. */
  targetId?: string;
  /** The schedule time to put back: the edited email's own time, or the send time for a copy. */
  scheduleAt?: number;
  /** ShelfReady asked to unschedule the target. From here, it must be scheduled again. */
  unscheduling?: boolean;
  /** Mailchimp confirmed the unschedule. */
  unscheduled?: boolean;
  /** Tries that could not reach Mailchimp before anything changed. */
  tries?: number;
  /** A check: the fish day it guards, fixed when it is queued. It never moves on to a later day. */
  guardDay?: string;
  guardAt?: number;
  /** The task whose unfinished campaign this one took up, so its alert can say it was scheduled. */
  tookUpFrom?: number;
  /**
   * A check: ensure (the default) makes sure the email exists and is right; cutoff looks for a
   * second email at 7:00am; sent checks it went. All but ensure only read.
   */
  purpose?: 'ensure' | 'cutoff' | 'sent';
  /** The 6:00am check: a tracked email staff left unscheduled gets the held changes and is scheduled. */
  scheduleDrafts?: boolean;
  /** The 6:00am check took on a draft staff had left unscheduled. */
  drafted?: boolean;
  /** ShelfReady scheduled it and read it back. */
  scheduled?: boolean;
}

export interface TaskResult {
  campaignId: string;
  campaignTitle: string;
  mode: 'edit' | 'copy' | 'none';
  sourceId?: string;
  day: string;
  scheduledFor: string;
  title: { from: string; to: string } | null;
  dateLine: { from: string | null; to: string } | null;
  changes: Array<{ key: string; from: string; to: string; before: string; after: string; why?: 'invoice' | 'drift' }>;
  /** Email rows not compared with the register, with the reason (no match, matched to none, a dozen row). */
  notCompared?: Array<{ key: string; why: string }>;
  notChanged: Array<{ key: string; why: string }>;
  problems: string[];
}

export interface MailchimpTask {
  id: number;
  kind: TaskKind;
  runId: number | null;
  slot: string | null;
  state: TaskState;
  plan: PlannedRow[] | null;
  progress: TaskProgress;
  result: TaskResult | null;
  message: string;
  alert: AlertLevel;
  alertClearedByName: string;
  alertClearedAt: number | null;
  notBefore: number;
  createdAt: number;
  updatedAt: number;
}

interface DbTask {
  id: number;
  kind: TaskKind;
  run_id: number | null;
  slot: string | null;
  state: TaskState;
  plan: string;
  progress: string;
  result: string;
  message: string;
  alert: AlertLevel;
  alert_cleared_by_name: string;
  alert_cleared_at: number | null;
  not_before: number;
  created_at: number;
  updated_at: number;
}

function fromDb(r: DbTask): MailchimpTask {
  return {
    id: r.id,
    kind: r.kind,
    runId: r.run_id,
    slot: r.slot,
    state: r.state,
    plan: JSON.parse(r.plan) as PlannedRow[] | null,
    progress: JSON.parse(r.progress) as TaskProgress,
    result: JSON.parse(r.result) as TaskResult | null,
    message: r.message,
    alert: r.alert,
    alertClearedByName: r.alert_cleared_by_name,
    alertClearedAt: r.alert_cleared_at,
    notBefore: r.not_before,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTask(db: Db, id: number): MailchimpTask | null {
  const r = db.prepare('SELECT * FROM mailchimp_tasks WHERE id = ?').get(id) as DbTask | undefined;
  return r ? fromDb(r) : null;
}

export function taskForRun(db: Db, runId: number): MailchimpTask | null {
  const r = db.prepare('SELECT * FROM mailchimp_tasks WHERE run_id = ?').get(runId) as DbTask | undefined;
  return r ? fromDb(r) : null;
}

/**
 * Adds the run's task once, with the send day it is for (the next fish day outside the cutoff
 * when Square confirmed the prices). It expires on that day: a task that never started does not
 * put old prices in weeks later. A second call (a retried send) changes nothing. Returns the id.
 */
export function addRunTask(db: Db, runId: number, plan: PlannedRow[], send: { day: string; at: number }, now: number): number {
  const progress: TaskProgress = { day: send.day, sendAt: send.at };
  db.prepare("INSERT INTO mailchimp_tasks (kind, run_id, state, plan, progress, created_at, updated_at) VALUES ('run', ?, 'queued', ?, ?, ?, ?) ON CONFLICT DO NOTHING").run(runId, toJson(plan), toJson(progress), now, now);
  return (db.prepare('SELECT id FROM mailchimp_tasks WHERE run_id = ?').get(runId) as { id: number }).id;
}

/** Adds the check for a slot once, with the fish day it guards. Returns true when it was new. */
export function addCheckTask(db: Db, slot: string, guard: { day: string; at: number }, now: number, opts: { purpose?: 'ensure' | 'cutoff' | 'sent'; scheduleDrafts?: boolean } = {}): boolean {
  const progress: TaskProgress = { guardDay: guard.day, guardAt: guard.at, ...(opts.purpose && opts.purpose !== 'ensure' ? { purpose: opts.purpose } : {}), ...(opts.scheduleDrafts ? { scheduleDrafts: true } : {}) };
  const res = db.prepare("INSERT INTO mailchimp_tasks (kind, slot, state, progress, created_at, updated_at) VALUES ('check', ?, 'queued', ?, ?, ?) ON CONFLICT DO NOTHING").run(slot, toJson(progress), now, now);
  return Number(res.changes) > 0;
}

/** Records a check slot that never ran (ShelfReady was off), as a red alert. Returns true when new. */
export function addMissedCheck(db: Db, slot: string, guard: { day: string; at: number }, message: string, now: number): boolean {
  const progress: TaskProgress = { guardDay: guard.day, guardAt: guard.at, day: guard.day };
  const res = db
    .prepare("INSERT INTO mailchimp_tasks (kind, slot, state, progress, message, alert, created_at, updated_at) VALUES ('check', ?, 'stopped', ?, ?, 'red', ?, ?) ON CONFLICT DO NOTHING")
    .run(slot, toJson(progress), message.slice(0, 1000), now, now);
  return Number(res.changes) > 0;
}

/** Takes the oldest queued task that is due, and marks it running, in one step. */
export function claimTask(db: Db, now: number): MailchimpTask | null {
  return inTransaction(db, () => {
    const r = db.prepare("SELECT * FROM mailchimp_tasks WHERE state = 'queued' AND not_before <= ? ORDER BY id LIMIT 1").get(now) as DbTask | undefined;
    if (!r) return null;
    db.prepare("UPDATE mailchimp_tasks SET state = 'running', updated_at = ? WHERE id = ?").run(now, r.id);
    return fromDb({ ...r, state: 'running' });
  });
}

export function queuedTasks(db: Db): number {
  return (db.prepare("SELECT count(*) AS n FROM mailchimp_tasks WHERE state = 'queued'").get() as { n: number }).n;
}

/**
 * Tasks marked running whose last step is older than the limit. One process runs one task, every
 * call times out in 30 seconds and each step saves progress, so this means the task is stuck.
 */
export function staleRunning(db: Db, olderThan: number): MailchimpTask[] {
  return (db.prepare("SELECT * FROM mailchimp_tasks WHERE state = 'running' AND updated_at < ? AND alert != 'red'").all(olderThan) as unknown as DbTask[]).map(fromDb);
}

/** Marks a task with a red alert without touching its state or progress. */
export function raiseAlert(db: Db, id: number, message: string, now: number): void {
  db.prepare("UPDATE mailchimp_tasks SET alert = 'red', message = ?, alert_cleared_at = NULL, alert_cleared_by_name = '', updated_at = ? WHERE id = ?").run(message.slice(0, 1000), now, id);
}

/**
 * Other tasks with an open red alert for this send day that name a campaign a person may be
 * handling: any target (a copy ShelfReady made, an email it unscheduled or asked to, one a person
 * unscheduled) and any copy it made or asked for. A red alert that names no campaign (an outage,
 * a missed check, a stop) does not count: it must never stop the next check from making sure an
 * email goes.
 */
export function openRedWithCampaign(db: Db, day: string, exceptTaskId: number): string[] {
  const rows = db
    .prepare("SELECT id, progress FROM mailchimp_tasks WHERE id != ? AND alert = 'red' AND alert_cleared_at IS NULL AND json_extract(progress, '$.day') = ?")
    .all(exceptTaskId, day) as Array<{ id: number; progress: string }>;
  const out: string[] = [];
  for (const r of rows) {
    const p = JSON.parse(r.progress) as TaskProgress;
    if (p.targetId) out.push(p.targetId);
    for (const c of copiesFor(db, r.id)) if (c.state !== 'not_made' && !out.includes(c.campaignId || `copy asked by task ${r.id}`)) out.push(c.campaignId || `copy asked by task ${r.id}`);
  }
  return out;
}

/**
 * Campaigns ShelfReady itself left unfinished for a send day: a copy it made, or an email it
 * unscheduled, that it did not schedule again. Known by id from its own records, never by looks.
 */
export function ownUnfinished(db: Db, day: string, exceptTaskId: number): Array<{ taskId: number; campaignId: string; mode: 'edit' | 'copy'; scheduleAt: number | null }> {
  const rows = db
    .prepare(
      `SELECT id, progress FROM mailchimp_tasks WHERE id != ? AND state NOT IN ('queued', 'running')
         AND json_extract(progress, '$.day') = ? AND coalesce(json_extract(progress, '$.scheduled'), 0) = 0`,
    )
    .all(exceptTaskId, day) as Array<{ id: number; progress: string }>;
  const out = new Map<string, { taskId: number; campaignId: string; mode: 'edit' | 'copy'; scheduleAt: number | null }>();
  for (const r of rows) {
    const p = JSON.parse(r.progress) as TaskProgress;
    // Only an unschedule Mailchimp confirmed: an email a person unscheduled stays theirs.
    if (p.targetId && (p.mode === 'copy' || p.unscheduled)) out.set(p.targetId, { taskId: r.id, campaignId: p.targetId, mode: p.mode ?? 'edit', scheduleAt: p.scheduleAt ?? null });
    // A copy recorded as made by that task, even if the task stopped before using it.
    for (const c of copiesFor(db, r.id)) if (c.state === 'made' && c.campaignId && !out.has(c.campaignId)) out.set(c.campaignId, { taskId: r.id, campaignId: c.campaignId, mode: 'copy', scheduleAt: null });
  }
  return [...out.values()];
}

/** Adds a line to another task's alert message, keeping the alert as it is. */
export function addAlertNote(db: Db, id: number, note: string, now: number): void {
  const r = db.prepare('SELECT message FROM mailchimp_tasks WHERE id = ?').get(id) as { message: string } | undefined;
  if (!r) return;
  db.prepare('UPDATE mailchimp_tasks SET message = ?, updated_at = ? WHERE id = ?').run(`${r.message} ${note}`.slice(0, 1000), now, id);
}

/** When the check clock last ran, or null on a fresh install. */
export function lastTick(db: Db): number | null {
  const r = db.prepare('SELECT last_tick FROM mailchimp_clock WHERE id = 1').get() as { last_tick: number } | undefined;
  return r ? r.last_tick : null;
}

/** Forgets the clock, so turning the checks on later raises no alerts for the time they were off. */
export function clearClock(db: Db): void {
  db.prepare('DELETE FROM mailchimp_clock').run();
}

export function setLastTick(db: Db, now: number): void {
  db.prepare('INSERT INTO mailchimp_clock (id, last_tick) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET last_tick = excluded.last_tick').run(now);
}

export function hasSlot(db: Db, slot: string): boolean {
  return db.prepare('SELECT 1 FROM mailchimp_tasks WHERE slot = ?').get(slot) !== undefined;
}

const TASK_COLUMNS: Record<string, string> = { state: 'state', progress: 'progress', result: 'result', message: 'message', alert: 'alert', notBefore: 'not_before' };
const TASK_JSON = new Set(['progress', 'result']);

export function updateTask(db: Db, id: number, fields: Partial<Pick<MailchimpTask, 'state' | 'progress' | 'result' | 'message' | 'alert' | 'notBefore'>>, now: number): void {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = TASK_COLUMNS[k];
    if (!col) throw new Error(`unknown task field ${k}`);
    sets.push(`${col} = ?`);
    vals.push(TASK_JSON.has(k) ? toJson(v ?? null) : k === 'message' ? String(v).slice(0, 1000) : (v as string | number));
  }
  sets.push('updated_at = ?');
  vals.push(now);
  db.prepare(`UPDATE mailchimp_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

/** Tasks a restart cut short go back in the queue. Each step reads Mailchimp before acting, so this is safe. */
export function requeueRunning(db: Db, now: number): number {
  return Number(db.prepare("UPDATE mailchimp_tasks SET state = 'queued', updated_at = ? WHERE state = 'running'").run(now).changes);
}

/** Alerts and notes not yet cleared: red first, then warnings, then notes, newest first in each. */
export function openAlerts(db: Db, limit = 20): MailchimpTask[] {
  return (
    db
      .prepare("SELECT * FROM mailchimp_tasks WHERE alert != '' AND alert_cleared_at IS NULL ORDER BY CASE alert WHEN 'red' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, id DESC LIMIT ?")
      .all(limit) as unknown as DbTask[]
  ).map(fromDb);
}

export function clearAlert(db: Db, id: number, byName: string, now: number): boolean {
  const res = db.prepare("UPDATE mailchimp_tasks SET alert_cleared_by_name = ?, alert_cleared_at = ?, updated_at = ? WHERE id = ? AND alert != '' AND alert_cleared_at IS NULL AND state != 'running'").run(byName.slice(0, 100), now, now, id);
  return Number(res.changes) > 0;
}

/** The newest tasks, for pages. */
export function recentTasks(db: Db, limit = 10): MailchimpTask[] {
  return (db.prepare('SELECT * FROM mailchimp_tasks ORDER BY id DESC LIMIT ?').all(limit) as unknown as DbTask[]).map(fromDb);
}

// ---- Copies

export interface CopyRow {
  id: number;
  taskId: number;
  sourceId: string;
  sourceTitle: string;
  startedAt: number;
  state: 'asking' | 'made' | 'not_made';
  campaignId: string;
  looks: number;
}

export function copiesFor(db: Db, taskId: number): CopyRow[] {
  const rows = db.prepare('SELECT * FROM mailchimp_copies WHERE task_id = ? ORDER BY id').all(taskId) as Array<{ id: number; task_id: number; source_id: string; source_title: string; started_at: number; state: CopyRow['state']; campaign_id: string; looks: number }>;
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, sourceId: r.source_id, sourceTitle: r.source_title, startedAt: r.started_at, state: r.state, campaignId: r.campaign_id, looks: r.looks }));
}

/** Stored before the replicate call, so a lost answer is never copied again blindly. */
export function startCopy(db: Db, taskId: number, source: { id: string; title: string }, now: number): number {
  const res = db.prepare("INSERT INTO mailchimp_copies (task_id, source_id, source_title, started_at, state, updated_at) VALUES (?, ?, ?, ?, 'asking', ?)").run(taskId, source.id, source.title.slice(0, 300), now, now);
  return Number(res.lastInsertRowid);
}

export function settleCopy(db: Db, id: number, fields: { state?: CopyRow['state']; campaignId?: string; looks?: number }, now: number): void {
  const sets: string[] = [];
  const vals: Array<string | number> = [];
  if (fields.state !== undefined) {
    sets.push('state = ?');
    vals.push(fields.state);
  }
  if (fields.campaignId !== undefined) {
    sets.push('campaign_id = ?');
    vals.push(fields.campaignId);
  }
  if (fields.looks !== undefined) {
    sets.push('looks = ?');
    vals.push(fields.looks);
  }
  sets.push('updated_at = ?');
  vals.push(now);
  db.prepare(`UPDATE mailchimp_copies SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

// ---- One campaign per fish day

export interface FishDay {
  day: string;
  campaignId: string;
  how: 'copied' | 'adopted';
  taskId: number | null;
  /** The fish rows it had when ShelfReady first read it, or null before then. */
  rowCount: number | null;
}

/** The campaign ShelfReady uses for a fish day, or null when it has none yet. */
export function trackedFor(db: Db, day: string): FishDay | null {
  const r = db.prepare('SELECT day, campaign_id, how, task_id, row_count FROM mailchimp_fish_days WHERE day = ?').get(day) as { day: string; campaign_id: string; how: FishDay['how']; task_id: number | null; row_count: number | null } | undefined;
  return r ? { day: r.day, campaignId: r.campaign_id, how: r.how, taskId: r.task_id, rowCount: r.row_count } : null;
}

/** Records how many fish rows the day's email had the first time ShelfReady read it. */
export function setRowCount(db: Db, day: string, rows: number): void {
  db.prepare('UPDATE mailchimp_fish_days SET row_count = ? WHERE day = ? AND row_count IS NULL').run(rows, day);
}

/**
 * Records the campaign for a fish day. A day keeps its first campaign: recording another for the
 * same day, or the same campaign for another day, throws, so a second email is never taken on.
 */
export function track(db: Db, day: string, campaignId: string, how: FishDay['how'], taskId: number | null, now: number): void {
  const had = trackedFor(db, day);
  if (had) {
    if (had.campaignId !== campaignId) throw new Error(`The ${day} fish email is already ${had.campaignId}.`);
    return;
  }
  db.prepare('INSERT INTO mailchimp_fish_days (day, campaign_id, how, task_id, created_at) VALUES (?, ?, ?, ?, ?)').run(day, campaignId, how, taskId, now);
}

// ---- Held price changes

export interface HeldRow {
  id: number;
  day: string;
  rowKey: string;
  itemId: string;
  variationId: string;
  label: string;
  toCents: number;
  perPound: boolean;
  runId: number | null;
  createdAt: number;
}

/** Changes older than this are not put in an email on their own: a person looks at them. */
export const HELD_MAX_AGE_MS = 21 * 86400_000;

/** Keeps an invoice's confirmed prices until they are in a fish email. */
export function addHeld(db: Db, runId: number | null, day: string, rows: readonly PlannedRow[], now: number): void {
  const ins = db.prepare('INSERT INTO mailchimp_held (day, row_key, item_id, variation_id, label, to_cents, per_pound, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  inTransaction(db, () => {
    for (const r of rows) ins.run(day, r.key.slice(0, 300), r.itemId, r.variationId, r.label.slice(0, 200), r.toCents, r.perPound ? 1 : 0, runId, now);
  });
}

function heldFromDb(r: { id: number; day: string; row_key: string; item_id: string; variation_id: string; label: string; to_cents: number; per_pound: number; run_id: number | null; created_at: number }): HeldRow {
  return { id: r.id, day: r.day, rowKey: r.row_key, itemId: r.item_id, variationId: r.variation_id, label: r.label, toCents: r.to_cents, perPound: r.per_pound === 1, runId: r.run_id, createdAt: r.created_at };
}

/**
 * The changes still to go into the email for a fish day: every change not yet in an email, meant
 * for that day or an earlier one, and not too old. Where one row changed twice, the latest wins;
 * every row id is returned in ids, so all of them are marked once the email has it.
 */
export function heldFor(db: Db, day: string, now: number): { rows: HeldRow[]; ids: number[]; fresh: HeldRow[]; tooOld: HeldRow[] } {
  const all = (db.prepare('SELECT * FROM mailchimp_held WHERE applied_at IS NULL AND dismissed_at IS NULL AND day <= ? ORDER BY id').all(day) as unknown as Parameters<typeof heldFromDb>[0][]).map(heldFromDb);
  const fresh = all.filter((r) => now - r.createdAt <= HELD_MAX_AGE_MS);
  const latest = new Map<string, HeldRow>();
  for (const r of fresh) latest.set(r.rowKey.toLowerCase(), r);
  return { rows: [...latest.values()], ids: fresh.map((r) => r.id), fresh, tooOld: all.filter((r) => now - r.createdAt > HELD_MAX_AGE_MS) };
}

/** Held changes over three weeks old, not in an email and not set aside: listed for an admin. */
export function oldHeld(db: Db, now: number): HeldRow[] {
  return (db.prepare('SELECT * FROM mailchimp_held WHERE applied_at IS NULL AND dismissed_at IS NULL AND created_at < ? ORDER BY id LIMIT 200').all(now - HELD_MAX_AGE_MS) as unknown as Parameters<typeof heldFromDb>[0][]).map(heldFromDb);
}

/**
 * An admin sets aside one held change over three weeks old, so it is no longer listed. Only an
 * old one that is still waiting can be set aside. Returns it, or null when nothing changed.
 */
export function dismissHeld(db: Db, id: number, byName: string, now: number): HeldRow | null {
  const row = oldHeld(db, now).find((r) => r.id === id);
  if (!row) return null;
  const res = db.prepare('UPDATE mailchimp_held SET dismissed_by_name = ?, dismissed_at = ? WHERE id = ? AND applied_at IS NULL AND dismissed_at IS NULL').run(byName.slice(0, 100), now, id);
  return Number(res.changes) > 0 ? row : null;
}

export function markHeldApplied(db: Db, ids: readonly number[], day: string, now: number): void {
  const up = db.prepare('UPDATE mailchimp_held SET applied_day = ?, applied_at = ? WHERE id = ? AND applied_at IS NULL');
  inTransaction(db, () => {
    for (const id of ids) up.run(day, now, id);
  });
}
