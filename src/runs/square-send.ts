// Sending an approved run to Square (Phase 1 step 7, store/docs/DECISIONS.md decision 1). Square
// first; the scales only once Square has fully succeeded (src/runs/scale-push.ts).
//
// What is sent is exactly the approved dry run (runs.dry_run), after checking:
// - its hash still matches, and working it out again from today's settings, overrides and saved
//   matches gives the same hash;
// - the approval and the dry run are not older than approvalMaxAgeHours (default 24): Square has
//   moved on since, so an old one needs a new dry run;
// - the run's catalog came from Square at the store's location, in the environment ShelfReady uses
//   now (the sandbox, or live with both switches on). A saved catalog file, another location, or
//   a run read in the other environment is refused: a run never mixes the sandbox and live;
// - with live Square, a run with scale prices goes to every scale (CLAUDE.md rule 12): a test run
//   to some scales is for the sandbox only;
// - every by-weight item ends sold by weight, at the price the scales get (rule 12). Checked on the
//   objects about to be sent, before anything is sent, and again on what Square reads back.
//
// Then, in the cc-case-cards skill's order: item renames, then variations (price, sold by weight
// with its location override, tracking on), then stock counts, then corrections. Each item is read
// back from Square first, and the send stops if its version moved since the dry run. Square's REST
// API replaces whole objects (src/square/writer.ts), so every write is the full object as read just
// before, with only ShelfReady's fields changed. Every write is stored with its idempotency key and
// exact body before it goes, so a retry after a lost reply sends the same request and Square never
// applies it twice. Afterwards everything is read back and the report records what Square holds.
//
// Lines where nothing arrived are not in the dry run, so nothing at all is sent for them.

import { randomUUID } from 'node:crypto';
import { appendAudit, SYSTEM_ACTOR, type AuditActor } from '../db/audit.ts';
import { inTransaction } from '../db/db.ts';
import { lineKeys, lookupMapping, setMappingStoreName } from '../matching/mapping.ts';
import { itemOf } from '../matching/catalog.ts';
import { lookupCopy, saveLookupLink } from '../copy/lookup.ts';
import { SquareError } from '../square/client.ts';
import { catalogSourceLabel, envForSource, mixedEnvironmentProblem, type SquareEnv } from '../square/origins.ts';
import { MAX_INVENTORY_CHANGES_PER_CALL, MAX_VARIATIONS_PER_CALL, SquareNotSent, SquareWriteUnknown, type InventoryBody, type Json, type SquareWriteApi, type UpsertBody } from '../square/writer.ts';
import type { ScaleApi } from '../scaleconnect/connection.ts';
import type { ActionDeps } from './actions.ts';
import type { RunCatalog } from './catalog-cache.ts';
import type { Evaluation } from './evaluate.ts';
import { removePriceOverride, setPriceOverride } from './overrides.ts';
import { buildPreview, previewHash, type ChangePreview, type SquareChange } from './preview.ts';
import { evaluateRun, settleRun, type RunnerLog } from './runner.ts';
import { addSquareWrite, createSend, getSend, markWriteAttempt, setWriteState, squareWrites, updateSend, type RunSend, type SendSnapshot, type SquareWriteRow, type WriteStep } from './send-store.ts';
import { activeJob, addEvent, enqueueJob, mustGetRun, runCorrections, runDecisions, RunError, setState, updateRun, type RunRow } from './store.ts';

export interface SendDeps extends ActionDeps {
  /**
   * Builds the Square write client for one environment: the one the run's catalog was read in.
   * Throws when it cannot. The client refuses every call if the environment used now differs.
   */
  squareApi: (env: SquareEnv) => SquareWriteApi;
  /** The Square environment ShelfReady uses now: production only with both switches on. */
  squareEnvironment: () => SquareEnv;
  /** A connected ScaleConnect client, after the address checks. The caller closes it. */
  scaleApi: () => Promise<ScaleApi>;
  /** An approval or dry run older than this must be made again before sending. */
  approvalMaxAgeMs: number;
  /** The only scales a send may write to (server config writeScales, FRONT by default). */
  writeScales: readonly string[];
  /**
   * Why the scales cannot be reached at all (the ScaleConnect address or token), checked without
   * contacting anything, or null. Run before the first Square write, so a bad setting cannot leave
   * Square changed and the scales not.
   */
  scalePreflight: () => string | null;
  /** The store's Square location from settings. */
  squareLocationId: () => string;
  /**
   * Called inside the transaction that records Square as done, with the prices Square confirmed:
   * queues the fish email change (src/mailchimp/service.ts). It must not throw; if it does, the
   * error is logged and Square stays recorded as done.
   */
  afterSquareDone?: (runId: number, dryRunHash: string, report: SquareReport, catalogSource: string) => void;
  log?: RunnerLog;
}

/** A stop with words safe to show. */
export class SendStop extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendStop';
  }
}

// ---- Checks before sending

function hours(ms: number): string {
  const h = Math.round(ms / 3600_000);
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

/** When the approval stops being fresh, or null when there is none. */
export function approvalExpiresAt(deps: Pick<SendDeps, 'approvalMaxAgeMs'>, run: RunRow): number | null {
  if (run.approvedAt === null || run.dryRunAt === null) return null;
  return Math.min(run.approvedAt, run.dryRunAt) + deps.approvalMaxAgeMs;
}

export function approvalExpired(deps: Pick<SendDeps, 'approvalMaxAgeMs' | 'now'>, run: RunRow): boolean {
  const expires = approvalExpiresAt(deps, run);
  return expires === null || deps.now() > expires;
}

/** Something of this run may be in Square: a write confirmed, or one whose answer was lost. */
export function somethingInSquare(deps: Pick<SendDeps, 'db'>, runId: number): boolean {
  return squareWrites(deps.db, runId).some((w) => w.state !== 'failed');
}

/**
 * After the approval expired, a send with something in Square may still finish what already went:
 * writes whose answer was lost are sent again with their stored key and body (exactly what was
 * approved), nothing new is written, and the scales get only the prices Square confirmed.
 */
export function replayOnly(deps: SendDeps, run: RunRow): boolean {
  return run.state === 'sending' && approvalExpired(deps, run) && somethingInSquare(deps, run.id);
}

/** By-weight items with a scale code, from the run's own catalog: variation id to code. */
function weightCodes(catalog: RunCatalog, changes: readonly SquareChange[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of changes) {
    const v = catalog.index.variationById.get(c.variationId);
    if (!v) continue;
    const code = itemOf(catalog.index, v).scaleCode;
    if (code) out.set(c.variationId, code);
  }
  return out;
}

/**
 * Why this run may not be sent, resent or corrected now because of where it was read, or null:
 * a saved catalog file, or a Square environment other than the one used now. Words safe to show.
 */
export function runEnvironmentProblem(deps: Pick<SendDeps, 'catalogs' | 'squareEnvironment'>, run: RunRow): string | null {
  if (run.catalogSnapshotId === null) return 'This invoice has no catalog.';
  return mixedEnvironmentProblem(deps.catalogs.get(run.catalogSnapshotId).snapshot.source, deps.squareEnvironment());
}

/** The environment of the run's catalog, or null when it is not Square. */
export function runEnvironment(deps: Pick<SendDeps, 'catalogs'>, run: RunRow): SquareEnv | null {
  return run.catalogSnapshotId === null ? null : envForSource(deps.catalogs.get(run.catalogSnapshotId).snapshot.source);
}

/**
 * Rule 12 for live Square: scale prices go to every scale in the same run. Why these scales are
 * not enough, or null. A test run to some scales is for the sandbox only.
 */
export function liveScalesProblem(deps: Pick<SendDeps, 'scaleNames' | 'writeScales'>, env: SquareEnv | null, scales: readonly string[], scalePrices: number): string | null {
  if (env !== 'production' || scalePrices === 0) return null;
  const missing = deps.scaleNames.filter((n) => !scales.includes(n));
  if (missing.length) return `Live Square sends every scale price to every scale in the same run, so a price sold by weight is the same in Square and on each scale. ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} left out. Choose every scale.`;
  const locked = deps.scaleNames.filter((n) => !deps.writeScales.includes(n));
  if (locked.length) return `Live Square needs every scale, but ${locked.join(', ')} may not get writes (server config writeScales). Nothing was sent.`;
  return null;
}

/** Rule 12 in the dry run itself: each scale price matches the Square price for that code. */
function previewWeightProblems(preview: ChangePreview, codes: Map<string, string>, perPoundUnitId: string | null): string[] {
  const out: string[] = [];
  for (const c of preview.square) {
    const code = codes.get(c.variationId);
    if (!code) continue;
    if (!perPoundUnitId) out.push(`${c.label} has scale code ${code}, but the catalog has no single per-pound unit, so it cannot be sold by weight.`);
    const scale = preview.scales.changes.find((s) => s.code === code);
    if (c.price && (!scale || scale.priceCents !== c.price.toCents)) out.push(`${c.label}: the Square price and the scale price for code ${code} differ in the dry run.`);
    if (scale && !c.price) out.push(`${c.label}: code ${code} gets a scale price but no Square price in the dry run.`);
  }
  return out;
}

/**
 * Every reason this run cannot be sent now, in plain words. Empty means it can. postedHash is the
 * dry run hash the page showed, or null inside the job.
 */
export function sendProblems(deps: SendDeps, run: RunRow, postedHash: string | null): string[] {
  const out: string[] = [];
  const send = getSend(deps.db, run.id);
  const retry = run.state === 'sending' && send?.phase === 'square_failed';
  const inJob = postedHash === null && run.state === 'sending' && send?.phase === 'sending_square';
  if (run.state !== 'approved' && !retry && !inJob) return [run.state === 'sending' || run.state === 'partial' || run.state === 'done' ? 'This invoice is already being sent.' : 'Only an approved invoice can be sent.'];
  if (postedHash !== null && activeJob(deps.db, run.id)) out.push('This invoice is still being worked on.');
  const stored = run.dryRun as ChangePreview | null;
  if (!stored || run.catalogSnapshotId === null || !run.dryRunHash) return [...out, 'There is no approved dry run to send.'];
  const { hash: _h, computedAt: _c, ...body } = stored;
  if (stored.hash !== run.dryRunHash || previewHash(body) !== run.dryRunHash) out.push('The stored dry run does not match what was approved. Make a new dry run.');
  if (postedHash !== null && postedHash !== run.dryRunHash) out.push('The dry run changed since the page was shown. Look at it again.');
  if (approvalExpired(deps, run) && !((retry || inJob) && somethingInSquare(deps, run.id))) out.push(`The approval is older than ${hours(deps.approvalMaxAgeMs)}, and Square has moved on since. Make a new dry run and approve it again.`);
  const catalog = deps.catalogs.get(run.catalogSnapshotId);
  const mixed = runEnvironmentProblem(deps, run);
  if (mixed) out.push(mixed);
  if (catalog.snapshot.locationId !== deps.squareLocationId()) out.push('This invoice was matched at a different Square location from the one in settings. Make a new dry run.');
  if (out.length) return out;
  // Worked out again from today's settings, overrides and saved matches.
  const ev = evaluateRun(deps, run);
  for (const b of ev.blockers) out.push(b.message);
  const counts = new Map(stored.square.filter((s) => s.stock?.from).map((s) => [s.variationId, s.stock!.from!]));
  const again = buildPreview({ runId: run.id, evaluation: ev, catalog, catalogLabel: deps.catalogLabelFor(catalog.snapshot.source), decisions: runDecisions(deps.db, run.id), counts, scaleNames: deps.scaleNames, now: deps.now() });
  if (again.hash !== run.dryRunHash) out.push('Something changed since approval (a setting, a price override or a saved match). Make a new dry run.');
  out.push(...previewWeightProblems(stored, weightCodes(catalog, stored.square), ev.perPoundUnitId));
  if (stored.scales.changes.length > 0 && deps.scaleNames.length === 0) out.push('No scales are named in the server config, so the scale prices cannot be sent.');
  if (stored.scales.changes.length > 0) {
    const scaleProblem = deps.scalePreflight();
    if (scaleProblem) out.push(`${scaleProblem} Nothing was sent: Square waits until the scales can follow.`);
    const notAllowed = (send?.scales ?? []).filter((x) => !deps.writeScales.includes(x));
    if (notAllowed.length) out.push(`${notAllowed.join(', ')} may not get writes (server config writeScales).`);
    // A retry keeps the scales chosen at the first press. They must still be every scale when live.
    if (send) {
      const live = liveScalesProblem(deps, envForSource(catalog.snapshot.source), send.scales, stored.scales.changes.length);
      if (live) out.push(live);
    }
  }
  return out;
}

// ---- Person actions

const SCALE_NAME = /^[A-Za-z0-9 _-]{1,32}$/;

/**
 * A person presses Send: Square first, then the scales. scales: the scales to send to (all of
 * them, or FRONT alone for a test run). Also used to send the rest after Square stopped.
 */
export function startSend(deps: SendDeps, runId: number, actor: AuditActor & { userId: number }, input: { hash: string; scales: string[] }): void {
  inTransaction(deps.db, () => {
    const run = mustGetRun(deps.db, runId);
    const problems = sendProblems(deps, run, input.hash);
    if (problems.length) throw new RunError(`Not sent. ${problems[0]}`, 409);
    const send = getSend(deps.db, runId);
    if (run.state === 'approved') {
      const chosen = [...new Set(input.scales)];
      if (chosen.length === 0 && (run.dryRun as ChangePreview).scales.changes.length > 0) throw new RunError('Choose at least one scale.', 400);
      for (const s of chosen) if (!SCALE_NAME.test(s) || !deps.scaleNames.includes(s)) throw new RunError('Choose scales from the list.', 400);
      for (const s of chosen) if (!deps.writeScales.includes(s)) throw new RunError(`${s} may not get writes. The server config allows ${deps.writeScales.join(', ') || 'no scale'}.`, 400);
      const scales = deps.scaleNames.filter((s) => chosen.includes(s));
      const env = runEnvironment(deps, run);
      // Rule 12, checked before anything is sent: live Square and every scale, or nothing.
      const live = liveScalesProblem(deps, env, scales, (run.dryRun as ChangePreview).scales.changes.length);
      if (live) throw new RunError(`Not sent. ${live}`, 400);
      const where = catalogSourceLabel(run.catalogSnapshotId === null ? '' : deps.catalogs.get(run.catalogSnapshotId).snapshot.source);
      createSend(deps.db, runId, { scales, allScales: [...deps.scaleNames], startedBy: actor.userId, startedByName: actor.username }, deps.now());
      setState(deps.db, runId, 'sending', { now: deps.now(), actor, message: `Sending to ${where}. The scales follow once Square is done.` });
      appendAudit(deps.db, actor, { action: 'run.send.start', entityType: 'run', entityId: runId, runId, details: { previewHash: run.dryRunHash, scales, test: scales.length < deps.scaleNames.length, squareEnvironment: env } }, deps.now());
      addEvent(deps.db, runId, 'send', `${actor.username} pressed Send, to ${where}${scales.length < deps.scaleNames.length ? ` (a test run to ${scales.join(', ')} only)` : ''}.`, deps.now());
    } else {
      updateSend(deps.db, runId, { phase: 'sending_square', message: '' }, deps.now());
      updateRun(deps.db, runId, { message: 'Sending the rest to Square.' }, deps.now());
      appendAudit(deps.db, actor, { action: 'run.send.retry_square', entityType: 'run', entityId: runId, runId, details: { previewHash: run.dryRunHash, scales: send?.scales ?? [], replayOnly: replayOnly(deps, run) } }, deps.now());
      addEvent(deps.db, runId, 'send', `${actor.username} asked to send the rest to Square.`, deps.now());
    }
    enqueueJob(deps.db, runId, 'send_square', actor.userId, deps.now());
  });
}

/** True when Square holds nothing from this run: no write confirmed, none whose answer was lost. */
export function nothingInSquare(deps: Pick<SendDeps, 'db'>, runId: number): boolean {
  return squareWrites(deps.db, runId).every((w) => w.state === 'failed');
}

/**
 * Stops a send that Square refused before anything landed (for example an item changed since the
 * dry run). The run ends stopped, so the invoice can be uploaded again against a fresh catalog. A
 * send with anything in Square cannot be stopped this way: Send again finishes it.
 */
export function stopSend(deps: SendDeps, runId: number, actor: AuditActor, confirmed: boolean): void {
  inTransaction(deps.db, () => {
    const run = mustGetRun(deps.db, runId);
    const send = getSend(deps.db, runId);
    if (run.state !== 'sending' || send?.phase !== 'square_failed') throw new RunError('Only a send that Square stopped can be stopped here.', 409);
    if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
    if (!nothingInSquare(deps, runId)) throw new RunError('Part of this invoice is already in Square, so it cannot be stopped. Press Send again to finish it.', 409);
    if (!confirmed) throw new RunError('Tick the box to confirm you want to stop this send.', 400);
    setState(deps.db, runId, 'failed', { now: deps.now(), actor, message: `Stopped by ${actor.username}. Nothing was changed in Square or on the scales. Upload the invoice again to send it.` });
    appendAudit(deps.db, actor, { action: 'run.send.stop', entityType: 'run', entityId: runId, runId, details: { previewHash: run.dryRunHash } }, deps.now());
  });
}

/** An approval that is too old, or a dry run that no longer matches: back to review for a new dry run. */
export function redoDryRun(deps: SendDeps, runId: number, actor: AuditActor): void {
  const run = mustGetRun(deps.db, runId);
  if (run.state !== 'approved') throw new RunError('Only an approved invoice that has not been sent can go back for a new dry run.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
  appendAudit(deps.db, actor, { action: 'run.send.redo_dry_run', entityType: 'run', entityId: runId, runId, details: { previewHash: run.dryRunHash } }, deps.now());
  addEvent(deps.db, runId, 'send', `${actor.username} sent the invoice back for a new dry run.`, deps.now());
  settleRun(deps, runId, actor, 'The approval was set aside. Make a new dry run and approve it again.');
}

// ---- Square objects

function obj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

function variationsOf(item: Json): Json[] {
  const vs = obj(item.item_data)?.variations;
  return Array.isArray(vs) ? (vs.map(obj).filter((v) => v !== null) as Json[]) : [];
}

function variationIn(item: Json | undefined, variationId: string): Json | undefined {
  return item ? variationsOf(item).find((v) => v.id === variationId) : undefined;
}

function version(o: Json | undefined): number | null {
  const v = o?.version;
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

function localOverride(d: Json, loc: string): Json | null {
  const list = Array.isArray(d.location_overrides) ? d.location_overrides : [];
  return (list.map(obj).find((o) => o !== null && o.location_id === loc) as Json | undefined) ?? null;
}

function currencyOf(d: Json): string {
  const c = obj(d.price_money)?.currency;
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : 'USD';
}

function needsVariationWrite(c: SquareChange): boolean {
  return c.price !== null || c.switchToWeight !== null || c.tracking.turnOn;
}

/** The variation with this change applied: price, sold by weight, location override, tracking. */
export function applyVariationChange(variation: Json, c: SquareChange, loc: string): Json {
  const v = clone(variation);
  const d = obj(v.item_variation_data);
  if (!d) throw new SendStop(`${c.label}: Square sent the variation in an unexpected shape.`);
  const local = localOverride(d, loc);
  const cents = c.price?.toCents ?? null;
  if (cents !== null) {
    const currency = currencyOf(d);
    d.pricing_type = 'FIXED_PRICING';
    d.price_money = { amount: cents, currency };
    // A store override with its own price or pricing type would keep the old price at the register.
    if (local && (local.price_money !== undefined || local.pricing_type !== undefined)) {
      local.pricing_type = 'FIXED_PRICING';
      local.price_money = { amount: cents, currency };
    }
  }
  if (c.switchToWeight) d.measurement_unit_id = c.switchToWeight.unitId;
  if (c.tracking.turnOn) {
    d.track_inventory = true;
    if (local && typeof local.track_inventory === 'boolean') local.track_inventory = true;
  }
  return v;
}

/** The fields ShelfReady decides on, for comparing. */
function watchVariation(v: Json | undefined, loc: string): string {
  const d = obj(v?.item_variation_data) ?? {};
  const local = localOverride(d, loc);
  return JSON.stringify({
    deleted: v?.is_deleted === true,
    pricingType: d.pricing_type ?? null,
    price: obj(d.price_money)?.amount ?? null,
    unit: d.measurement_unit_id ?? null,
    track: d.track_inventory ?? null,
    local: local ? { pricingType: local.pricing_type ?? null, price: obj(local.price_money)?.amount ?? null, track: local.track_inventory ?? null } : null,
  });
}

function itemName(item: Json | undefined): string {
  const n = obj(item?.item_data)?.name;
  return typeof n === 'string' ? n : '';
}

/** Rule 12 on one variation as Square will hold it. Empty means sold by weight at the scale price. */
export function weightProblems(label: string, code: string, variation: Json | undefined, loc: string, perPoundUnitId: string | null, scaleCents: number | null): string[] {
  const d = obj(variation?.item_variation_data);
  if (!d) return [`${label} (code ${code}) is missing in Square.`];
  const out: string[] = [];
  const price = obj(d.price_money)?.amount;
  if (d.pricing_type !== 'FIXED_PRICING' || typeof price !== 'number') out.push(`${label} (code ${code}) would not have a fixed price in Square.`);
  if (!perPoundUnitId || d.measurement_unit_id !== perPoundUnitId) out.push(`${label} (code ${code}) would not be sold by the pound in Square.`);
  const local = localOverride(d, loc);
  if (local?.pricing_type === 'VARIABLE_PRICING') out.push(`${label} (code ${code}) would still take its price at the register at this store.`);
  const localPrice = obj(local?.price_money)?.amount;
  if (typeof localPrice === 'number' && localPrice !== price) out.push(`${label} (code ${code}) has a different price at this store than on the item.`);
  if (scaleCents !== null && price !== scaleCents) out.push(`${label} (code ${code}) would cost differently in Square and on the scales.`);
  return out;
}

// ---- The report

export type PartState = 'done' | 'failed' | 'unknown' | 'not_sent';

export interface SquareReportItem {
  variationId: string;
  label: string;
  rename: { to: string; state: PartState } | null;
  price: { toCents: number; perPound: boolean; state: PartState } | null;
  switchToWeight: { state: PartState } | null;
  tracking: { state: PartState } | null;
  stock: { to: string; unit: 'lb' | 'unit'; state: PartState; squareNow: string | null } | null;
  /** What Square held when read back, or null when it could not be read. */
  readBack: { name: string; priceCents: number | null; pricingType: string; perPound: boolean; tracked: boolean | null } | null;
  problems: string[];
}

export interface SquareReport {
  ok: boolean;
  at: number;
  items: SquareReportItem[];
  corrections: Array<{ line: number; variationId: string; takeBack: string; state: PartState }>;
  writes: Array<{ step: WriteStep; objects: number; state: string; attempts: number; error: string }>;
  /** Why the send stopped, or ''. */
  stopped: string;
  warnings: string[];
  /** Scale codes left out of the scale push because Square did not get their price (an expired approval). */
  scaleSkipped: string[];
}

function partState(rows: SquareWriteRow[], step: WriteStep, id: string): PartState {
  const mine = rows.filter((w) => w.step === step && w.objectIds.includes(id));
  if (mine.some((w) => w.state === 'confirmed')) return 'done';
  if (mine.some((w) => w.state === 'sending')) return 'unknown';
  if (mine.some((w) => w.state === 'failed')) return 'failed';
  return 'not_sent';
}

// ---- The job

interface SendContext {
  deps: SendDeps;
  run: RunRow;
  send: RunSend;
  preview: ChangePreview;
  catalog: RunCatalog;
  loc: string;
  api: SquareWriteApi;
  ev: Evaluation;
  codes: Map<string, string>;
  /** The approval expired: only writes already stored are sent again. */
  replay: boolean;
}

function confirmed(ctx: SendContext, step: WriteStep): Set<string> {
  return new Set(squareWrites(ctx.deps.db, ctx.run.id).filter((w) => w.step === step && w.state === 'confirmed').flatMap((w) => w.objectIds));
}

async function readItems(ctx: SendContext): Promise<Map<string, Json>> {
  const ids = [...new Set(ctx.preview.square.map((c) => c.itemId))];
  const got = await ctx.api.retrieveObjects(ids);
  return new Map(got.filter((o) => o.type === 'ITEM' && typeof o.id === 'string').map((o) => [o.id as string, o]));
}

/**
 * Checks Square holds what this run expects before a write: objects untouched by this run's
 * confirmed writes must be at the dry run's version; touched ones must hold exactly what the first
 * read held with this run's confirmed changes applied. Anything else means someone else changed
 * it, and the send stops.
 */
function checkNotMoved(ctx: SendContext, now: Map<string, Json>): void {
  const renamed = confirmed(ctx, 'rename');
  const varied = confirmed(ctx, 'variations');
  // Writing one variation moves its item's version, so a sibling on the same item counts as touched.
  const variedItems = new Set(ctx.preview.square.filter((c) => varied.has(c.variationId)).map((c) => c.itemId));
  const snap = ctx.send.snapshot!;
  for (const c of ctx.preview.square) {
    const item = now.get(c.itemId);
    const v = variationIn(item, c.variationId);
    if (!item || item.is_deleted === true || !v || v.is_deleted === true) throw new SendStop(`${c.label} is no longer in Square. Nothing more was sent.`);
    const first = snap.items[c.itemId];
    const firstVar = variationIn(first, c.variationId);
    if (!first || !firstVar) throw new SendStop(`${c.label} was not read before the first write. Nothing more was sent.`);
    const touched = renamed.has(c.itemId) || variedItems.has(c.itemId);
    if (!touched) {
      if (c.versions.item === null || c.versions.variation === null) throw new SendStop(`${c.label}: the dry run did not record its Square version. Make a new dry run.`);
      if (version(item) !== c.versions.item || version(v) !== c.versions.variation) {
        throw new SendStop(`${c.label} changed in Square since the dry run. Nothing more was sent. Make a new dry run.`);
      }
      continue;
    }
    const wantName = renamed.has(c.itemId) && c.rename ? c.rename.to : itemName(first);
    if (itemName(item) !== wantName) throw new SendStop(`${c.label}: its name in Square changed since ShelfReady wrote it. Nothing more was sent.`);
    const wantVar = varied.has(c.variationId) ? applyVariationChange(firstVar, c, ctx.loc) : firstVar;
    if (watchVariation(v, ctx.loc) !== watchVariation(wantVar, ctx.loc)) throw new SendStop(`${c.label} changed in Square since ShelfReady wrote it. Nothing more was sent.`);
  }
}

/** Rule 12 on what Square would hold (or holds) for every by-weight item in the run. */
function checkWeight(ctx: SendContext, now: Map<string, Json>, planned: boolean): void {
  const problems: string[] = [];
  for (const c of ctx.preview.square) {
    const code = ctx.codes.get(c.variationId);
    if (!code || folded(ctx).skipped.has(c.variationId)) continue;
    const v = variationIn(now.get(c.itemId), c.variationId);
    const after = planned && v && needsVariationWrite(c) && !confirmed(ctx, 'variations').has(c.variationId) ? applyVariationChange(v, c, ctx.loc) : v;
    const scale = ctx.preview.scales.changes.find((s) => s.code === code);
    problems.push(...weightProblems(c.label, code, after, ctx.loc, ctx.ev.perPoundUnitId, scale?.priceCents ?? null));
  }
  if (problems.length) {
    throw new SendStop(`${planned ? 'Nothing more was sent.' : 'Square did not end as planned.'} Every item with a scale code must be sold by weight in Square at the scale price. ${problems[0]}`);
  }
}

/** What a write holds, for the audit log: ids, prices, units, tracking and stock. Never a token. */
export function writeDetails(step: WriteStep, body: Json): Record<string, unknown>[] {
  if (step === 'rename' || step === 'variations') {
    const objects = (obj((body.batches as unknown[] | undefined)?.[0])?.objects as Json[] | undefined) ?? [];
    return objects.map((o) => {
      if (o.type === 'ITEM') return { type: 'ITEM', id: o.id, name: itemName(o) };
      const d = obj(o.item_variation_data) ?? {};
      const local = Array.isArray(d.location_overrides) ? d.location_overrides.map(obj).filter((x) => x !== null) : [];
      return {
        type: 'ITEM_VARIATION',
        id: o.id,
        itemId: d.item_id ?? null,
        pricingType: d.pricing_type ?? null,
        priceCents: obj(d.price_money)?.amount ?? null,
        unitId: d.measurement_unit_id ?? null,
        tracked: d.track_inventory ?? null,
        overrides: local.map((x) => ({ locationId: x!.location_id, pricingType: x!.pricing_type ?? null, priceCents: obj(x!.price_money)?.amount ?? null, tracked: x!.track_inventory ?? null })),
      };
    });
  }
  return ((body.changes as Json[] | undefined) ?? []).map((c) => {
    const d = obj(c.physical_count) ?? obj(c.adjustment) ?? {};
    return { type: c.type, variationId: d.catalog_object_id, quantity: d.quantity, state: d.state ?? null, from: d.from_state ?? null, to: d.to_state ?? null, occurredAt: d.occurred_at };
  });
}

function stepWords(step: WriteStep): string {
  return step === 'variations' ? 'price and tracking' : step === 'inventory' ? 'stock' : step;
}

/**
 * Sends one stored write. Throws SendStop when it did not go through.
 * - A refusal by this client before sending (a stored body too old to replay, no token, a risky
 *   environment) never reached Square. On a first try the write is failed (nothing landed). A write
 *   whose earlier answer was lost stays unknown: its first try may have landed.
 * - No answer: unknown, sent again later with the same key and body.
 * - A refusal from Square on a FIRST try: failed, nothing landed. On a later try the write stays
 *   unknown (unless what it set is found in Square): a person checks Square and says.
 */
async function sendWrite(ctx: SendContext, w: SquareWriteRow | { id: number; step: WriteStep; body: Json; objectIds: string[]; attempts?: number }): Promise<void> {
  const { db, now } = ctx.deps;
  const firstTry = (w.attempts ?? 0) === 0;
  const actor: AuditActor = { userId: ctx.send.startedBy, username: ctx.send.startedByName };
  const record = (outcome: string): void =>
    void appendAudit(db, actor, { action: 'run.send.square_write', entityType: 'run', entityId: ctx.run.id, runId: ctx.run.id, details: { writeId: w.id, step: w.step, idempotencyKey: w.body.idempotency_key, outcome, objects: writeDetails(w.step, w.body) } }, now());
  // Counted before the call: a restart in the middle then treats it as possibly sent.
  markWriteAttempt(db, w.id, now(), 1);
  try {
    if (w.step === 'rename' || w.step === 'variations') await ctx.api.batchUpsert(w.body as unknown as UpsertBody);
    else await ctx.api.changeInventory(w.body as unknown as InventoryBody);
    setWriteState(db, w.id, 'confirmed', '', now());
    record(firstTry ? 'confirmed' : 'confirmed on a later try (same key)');
  } catch (err) {
    if (err instanceof SquareNotSent) {
      markWriteAttempt(db, w.id, now(), -1);
      if (firstTry) {
        setWriteState(db, w.id, 'failed', err.message, now());
        throw new SendStop(`A ${stepWords(w.step)} write was not sent: ${err.message}`);
      }
      setWriteState(db, w.id, 'sending', `Not sent again: ${err.message}`, now());
      record('not sent again; still unknown');
      throw new SendStop(`A ${stepWords(w.step)} write whose answer was lost could not be sent again: ${err.message} Its first try may have landed. A person must check Square and say whether it did.`);
    }
    if (err instanceof SquareWriteUnknown) {
      setWriteState(db, w.id, 'sending', 'Square did not answer.', now());
      record('no answer; unknown');
      throw new SendStop(`Square did not answer a ${stepWords(w.step)} write. It may have landed. Press Send again: ShelfReady sends the same request with the same key, so nothing is doubled.`);
    }
    if (err instanceof SquareError && err.codes.includes('VERSION_MISMATCH') && (w.step === 'rename' || w.step === 'variations') && (await landedEarlier(ctx, w))) {
      setWriteState(db, w.id, 'confirmed', 'Found already in Square.', now());
      record('found already in Square');
      return;
    }
    const text = err instanceof SquareError ? err.message : 'Square could not be reached.';
    if (firstTry && err instanceof SquareError && err.status !== null && err.status >= 400 && err.status < 500) {
      setWriteState(db, w.id, 'failed', text, now());
      record('refused by Square');
      throw new SendStop(`Square refused a ${stepWords(w.step)} write: ${text}`);
    }
    setWriteState(db, w.id, 'sending', text, now());
    record('refused on a later try; still unknown');
    throw new SendStop(`Square refused sending a ${stepWords(w.step)} write again: ${text} Its first try may have landed. A person must check Square and say whether it did.`);
  }
}

/**
 * A person checked Square for a write whose answer was lost and says whether it landed. Landed:
 * it counts as confirmed (a correction is marked sent). Did not land: it is failed, so the next
 * Send writes it again with a new key. Never decided by the code.
 */
export function resolveWrite(deps: SendDeps, runId: number, actor: AuditActor, writeId: number, landed: 'yes' | 'no', confirmed: boolean): void {
  inTransaction(deps.db, () => {
    const run = mustGetRun(deps.db, runId);
    if (!['sending', 'partial', 'done'].includes(run.state)) throw new RunError('This invoice has nothing being sent.', 409);
    if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
    const w = squareWrites(deps.db, runId).find((x) => x.id === writeId);
    if (!w || w.state !== 'sending') throw new RunError('That Square write is not waiting for a person.', 409);
    if (!confirmed) throw new RunError('Tick the box to confirm you checked Square.', 400);
    setWriteState(deps.db, writeId, landed === 'yes' ? 'confirmed' : 'failed', `${actor.username} checked Square: it ${landed === 'yes' ? 'landed' : 'did not land'}.`, deps.now());
    if (landed === 'yes' && w.step === 'correction') {
      for (const id of w.objectIds) {
        const line = Number(id.replace(/^line:/, ''));
        if (Number.isInteger(line)) deps.db.prepare("UPDATE run_corrections SET state = 'sent' WHERE run_id = ? AND line = ?").run(runId, line);
      }
    }
    appendAudit(deps.db, actor, { action: 'run.send.write_checked', entityType: 'run', entityId: runId, runId, details: { writeId, step: w.step, landed, idempotencyKey: w.idempotencyKey, objects: writeDetails(w.step, w.body) } }, deps.now());
    addEvent(deps.db, runId, 'send', `${actor.username} checked Square: a ${stepWords(w.step)} write ${landed === 'yes' ? 'landed' : 'did not land'}.`, deps.now());
  });
}

/** A catalog write refused for its version: did an earlier try of it land? Compares what Square holds with what it set. */
async function landedEarlier(ctx: SendContext, w: { body: Json }): Promise<boolean> {
  const sent = (obj((w.body.batches as unknown[] | undefined)?.[0])?.objects as Json[] | undefined) ?? [];
  const items = await readItems(ctx);
  for (const o of sent) {
    if (o.type === 'ITEM') {
      if (itemName(items.get(o.id as string)) !== itemName(o)) return false;
    } else {
      const parent = obj(o.item_variation_data)?.item_id as string;
      if (watchVariation(variationIn(items.get(parent), o.id as string), ctx.loc) !== watchVariation(o, ctx.loc)) return false;
    }
  }
  return true;
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Items in groups whose variations add up to at most 8. An item with more goes alone. */
function itemBatches(items: Json[]): Json[][] {
  const out: Json[][] = [];
  let cur: Json[] = [];
  let n = 0;
  for (const it of items) {
    const k = variationsOf(it).length;
    if (cur.length && n + k > MAX_VARIATIONS_PER_CALL) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(it);
    n += k;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function write(ctx: SendContext, step: WriteStep, body: Json, objectIds: string[]): Promise<void> {
  const id = addSquareWrite(ctx.deps.db, ctx.run.id, { step, idempotencyKey: body.idempotency_key as string, body, objectIds }, ctx.deps.now());
  await sendWrite(ctx, { id, step, body, objectIds });
}

function occurredAt(ctx: SendContext): string {
  // Current, never backdated (a backdated count makes Square replay later sales), never ahead.
  return new Date(ctx.deps.now() - 1000).toISOString();
}

/** The corrections folded into this send so far. */
function folded(ctx: SendContext): { skipped: Set<string>; minus: Map<string, number>; lines: Set<number> } {
  const f = ctx.send.snapshot?.folded;
  return { skipped: new Set(f?.skipped ?? []), minus: new Map(Object.entries(f?.minus ?? {})), lines: new Set(f?.foldedLines ?? []) };
}

/**
 * Corrections recorded before their item's stock went to Square are folded into the send, not
 * sent as waste: an item where nothing arrived after all on every line gets nothing at all (no
 * price, no stock, no scale price; decisions "What arrived"), and an item where only some lines did
 * not arrive gets a lower count. Stock already sent, or whose answer was lost, is corrected later
 * by taking it back out.
 */
function foldCorrections(ctx: SendContext): void {
  const { db, now } = ctx.deps;
  const rows = squareWrites(db, ctx.run.id);
  const stockSent = new Set(rows.filter((w) => w.step === 'inventory' && w.state !== 'failed').flatMap((w) => w.objectIds));
  const varied = new Set(rows.filter((w) => w.step === 'variations' && w.state !== 'failed').flatMap((w) => w.objectIds));
  const f = folded(ctx);
  const pending = runCorrections(db, ctx.run.id).filter((c) => c.state === 'pending' && c.variationId && !stockSent.has(c.variationId));
  if (!pending.length) return;
  const actor: AuditActor = { userId: ctx.send.startedBy, username: ctx.send.startedByName };
  // The corrections marked sent and the folded record are saved together.
  const snapshot = inTransaction(db, () => {
    for (const c of ctx.preview.square) {
      const mine = pending.filter((x) => x.variationId === c.variationId);
      if (!mine.length) continue;
      const corrected = new Set([...runCorrections(db, ctx.run.id).filter((x) => x.variationId === c.variationId).map((x) => x.line)]);
      const all = c.lines.every((n) => corrected.has(n)) && !varied.has(c.variationId);
      if (all) f.skipped.add(c.variationId);
      else f.minus.set(c.variationId, (f.minus.get(c.variationId) ?? 0) + mine.reduce((a, x) => a + (Number(x.stockTakeBack) || 0), 0));
      for (const x of mine) {
        f.lines.add(x.line);
        db.prepare("UPDATE run_corrections SET state = 'sent' WHERE run_id = ? AND line = ?").run(ctx.run.id, x.line);
        appendAudit(db, actor, { action: 'run.correct.folded', entityType: 'run', entityId: ctx.run.id, runId: ctx.run.id, details: { line: x.line, variationId: x.variationId, stockTakeBack: x.stockTakeBack, unit: x.stockUnit, how: all ? 'nothing sent for this item' : 'taken off the count before it was sent' } }, now());
      }
    }
    const next: SendSnapshot = { ...(ctx.send.snapshot ?? { takenAt: now(), items: {} }), folded: { skipped: [...f.skipped], minus: Object.fromEntries(f.minus), foldedLines: [...f.lines] } };
    updateSend(db, ctx.run.id, { snapshot: next }, now());
    return next;
  });
  ctx.send = { ...ctx.send, snapshot };
}

/** The count to send: the invoice figure less any stock folded off it, never below zero. */
function countToSend(ctx: SendContext, c: SquareChange): string {
  const minus = folded(ctx).minus.get(c.variationId) ?? 0;
  if (!minus) return c.stock!.to;
  const places = (c.stock!.to.split('.')[1] ?? '').length;
  return Math.max(0, Number(c.stock!.to) - minus).toFixed(places);
}

async function squareSteps(ctx: SendContext): Promise<void> {
  const { db, now } = ctx.deps;
  const runId = ctx.run.id;

  // Writes whose reply was lost go again first, with the same key and body.
  for (const w of squareWrites(db, runId).filter((x) => x.state === 'sending')) await sendWrite(ctx, w);
  // After the approval expired, only those: nothing new is written.
  if (ctx.replay) return;

  let items = await readItems(ctx);
  if (!ctx.send.snapshot) {
    const snapshot: SendSnapshot = { takenAt: now(), items: Object.fromEntries(items) };
    updateSend(db, runId, { snapshot }, now());
    ctx.send = { ...ctx.send, snapshot };
  }
  checkNotMoved(ctx, items);
  foldCorrections(ctx);
  checkWeight(ctx, items, true);

  // 1. Renames: the whole item as read, with its variations as they are, and only the name changed.
  const renamed = confirmed(ctx, 'rename');
  // An item where nothing arrived after all gets nothing, its new name included.
  const toRename = ctx.preview.square.filter((c) => c.rename && !renamed.has(c.itemId) && !folded(ctx).skipped.has(c.variationId));
  if (toRename.length) {
    addEvent(db, runId, 'send', `Square: renaming ${toRename.length} ${toRename.length === 1 ? 'item' : 'items'}.`, now());
    const objs = toRename.map((c) => {
      const it = clone(items.get(c.itemId)!);
      (it.item_data as Json).name = c.rename!.to;
      return it;
    });
    for (const batch of itemBatches(objs)) {
      const body: UpsertBody = { idempotency_key: randomUUID(), sparse_update: true, batches: [{ objects: batch }] };
      await write(ctx, 'rename', body as unknown as Json, batch.map((o) => o.id as string));
    }
    items = await readItems(ctx);
    checkNotMoved(ctx, items);
  }

  // 2. Variations: price, sold by weight with the location override, tracking on before counts.
  const varied = confirmed(ctx, 'variations');
  const skipped = folded(ctx).skipped;
  const toVary = ctx.preview.square.filter((c) => needsVariationWrite(c) && !varied.has(c.variationId) && !skipped.has(c.variationId));
  if (toVary.length) {
    addEvent(db, runId, 'send', `Square: prices and tracking for ${toVary.length} ${toVary.length === 1 ? 'item' : 'items'}.`, now());
    const objs = toVary.map((c) => applyVariationChange(variationIn(items.get(c.itemId), c.variationId)!, c, ctx.loc));
    for (const batch of chunk(objs, MAX_VARIATIONS_PER_CALL)) {
      const body: UpsertBody = { idempotency_key: randomUUID(), sparse_update: true, batches: [{ objects: batch }] };
      await write(ctx, 'variations', body as unknown as Json, batch.map((o) => o.id as string));
    }
    items = await readItems(ctx);
    checkNotMoved(ctx, items);
  }

  // 3. Stock: set to the invoice figure, replacing what Square shows.
  const counted = confirmed(ctx, 'inventory');
  const toCount = ctx.preview.square.filter((c) => c.stock && !counted.has(c.variationId) && !skipped.has(c.variationId));
  if (toCount.length) {
    addEvent(db, runId, 'send', `Square: stock for ${toCount.length} ${toCount.length === 1 ? 'item' : 'items'}.`, now());
    for (const batch of chunk(toCount, MAX_INVENTORY_CHANGES_PER_CALL)) {
      const at = occurredAt(ctx);
      const body: InventoryBody = {
        idempotency_key: randomUUID(),
        ignore_unchanged_counts: false,
        changes: batch.map((c) => ({ type: 'PHYSICAL_COUNT', physical_count: { catalog_object_id: c.variationId, state: 'IN_STOCK', location_id: ctx.loc, quantity: countToSend(ctx, c), occurred_at: at } })),
      };
      await write(ctx, 'inventory', body as unknown as Json, batch.map((c) => c.variationId));
    }
  }

  // 4. Corrections recorded after approval: take that stock back out.
  await sendCorrectionWrites(ctx);
}

/** Pending corrections: each line's stock comes back out of Square, then the correction is marked sent. */
async function sendCorrectionWrites(ctx: SendContext): Promise<number> {
  const { db, now } = ctx.deps;
  const runId = ctx.run.id;
  const done = confirmed(ctx, 'correction');
  const markSent = (c: { line: number; variationId: string; stockTakeBack: string; stockUnit: string }): void => {
    db.prepare("UPDATE run_corrections SET state = 'sent' WHERE run_id = ? AND line = ?").run(runId, c.line);
    appendAudit(db, SYSTEM_ACTOR, { action: 'run.correct.sent', entityType: 'run', entityId: runId, runId, details: { line: c.line, variationId: c.variationId, stockTakeBack: c.stockTakeBack, unit: c.stockUnit } }, now());
  };
  // A correction whose write was confirmed on a retry (its first answer was lost).
  for (const c of runCorrections(db, runId)) if (c.state === 'pending' && done.has(`line:${c.line}`)) markSent(c);
  const pending = runCorrections(db, runId).filter((c) => c.state === 'pending' && !done.has(`line:${c.line}`));
  const zero = pending.filter((c) => !c.variationId || !(Number(c.stockTakeBack) > 0));
  for (const c of zero) db.prepare("UPDATE run_corrections SET state = 'sent' WHERE run_id = ? AND line = ?").run(runId, c.line);
  const real = pending.filter((c) => !zero.includes(c));
  for (const batch of chunk(real, MAX_INVENTORY_CHANGES_PER_CALL)) {
    const at = occurredAt(ctx);
    const body: InventoryBody = {
      idempotency_key: randomUUID(),
      ignore_unchanged_counts: false,
      changes: batch.map((c) => ({ type: 'ADJUSTMENT', adjustment: { catalog_object_id: c.variationId, from_state: 'IN_STOCK', to_state: 'WASTE', location_id: ctx.loc, quantity: c.stockTakeBack, occurred_at: at } })),
    };
    await write(ctx, 'correction', body as unknown as Json, batch.map((c) => `line:${c.line}`));
    inTransaction(db, () => {
      for (const c of batch) markSent(c);
    });
    addEvent(db, runId, 'correction', `Square: took back the stock of ${batch.length === 1 ? `line ${batch[0]!.line}` : `${batch.length} lines`} that did not arrive.`, now());
  }
  return real.length;
}

/** Reads everything back and writes the report. Throws SendStop when Square does not hold the plan. */
async function readBack(ctx: SendContext, stopped: string): Promise<SquareReport> {
  const rows = squareWrites(ctx.deps.db, ctx.run.id);
  let items: Map<string, Json> | null = null;
  let countMap: Map<string, string> | null = null;
  try {
    items = await readItems(ctx);
    const ids = ctx.preview.square.filter((c) => c.stock).map((c) => c.variationId);
    if (ids.length) {
      const list = await ctx.api.inventoryCounts(ids, ctx.loc);
      countMap = new Map(list.filter((c) => c.state === 'IN_STOCK' && c.locationId === ctx.loc).map((c) => [c.variationId, c.quantity]));
    } else countMap = new Map();
  } catch {
    // The report then says what could not be read.
  }
  const warnings: string[] = [];
  const corrections = runCorrections(ctx.deps.db, ctx.run.id);
  const report: SquareReport = { ok: stopped === '', at: ctx.deps.now(), items: [], corrections: [], writes: [], stopped, warnings, scaleSkipped: [] };
  for (const c of ctx.preview.square) {
    const item = items?.get(c.itemId);
    const v = variationIn(item, c.variationId);
    const d = obj(v?.item_variation_data);
    const problems: string[] = [];
    const first = variationIn(ctx.send.snapshot?.items[c.itemId], c.variationId);
    const varState = needsVariationWrite(c) ? partState(rows, 'variations', c.variationId) : 'not_sent';
    const skippedHere = folded(ctx).skipped.has(c.variationId);
    if (skippedHere && stopped === '') {
      warnings.push(`${c.label}: nothing arrived after all, so nothing was sent for it.`);
      const code = ctx.codes.get(c.variationId);
      if (code) report.scaleSkipped.push(code);
    } else if (items && stopped === '') {
      // Only what was written is compared. A part not written is a problem, unless the approval
      // expired and the send is only finishing what already went.
      const notSent = (what: string): void => {
        if (ctx.replay) warnings.push(`${c.label}: ${what} was not sent. The approval expired before it went.`);
        else problems.push(`${what} was not sent.`);
      };
      const renameState = c.rename ? partState(rows, 'rename', c.itemId) : 'done';
      if (c.rename && renameState !== 'done') notSent('The new name');
      else if (c.rename && itemName(item) !== c.rename.to) problems.push(`Square shows the name "${itemName(item)}", not "${c.rename.to}".`);
      if (needsVariationWrite(c) && varState !== 'done') notSent('The price, unit or tracking');
      else if (needsVariationWrite(c) && first && watchVariation(v, ctx.loc) !== watchVariation(applyVariationChange(first, c, ctx.loc), ctx.loc)) problems.push('Square does not show the price, unit or tracking that was sent.');
      if (c.stock && partState(rows, 'inventory', c.variationId) !== 'done') notSent('The stock count');
      const code = ctx.codes.get(c.variationId);
      if (code) {
        if (needsVariationWrite(c) && varState !== 'done' && ctx.replay) report.scaleSkipped.push(code);
        else problems.push(...weightProblems(c.label, code, v, ctx.loc, ctx.ev.perPoundUnitId, ctx.preview.scales.changes.find((s) => s.code === code)?.priceCents ?? null));
      }
    }
    let squareNow: string | null = null;
    if (c.stock && countMap) {
      squareNow = countMap.get(c.variationId) ?? null;
      const foldedLines = folded(ctx).lines;
      const takenBack = corrections.filter((x) => x.variationId === c.variationId && x.state === 'sent' && !foldedLines.has(x.line)).reduce((a, x) => a + (Number(x.stockTakeBack) || 0), 0);
      const want = Number(countToSend(ctx, c)) - takenBack;
      if (stopped === '' && partState(rows, 'inventory', c.variationId) === 'done' && (squareNow === null || Math.abs(Number(squareNow) - want) > 0.0005)) {
        warnings.push(`${c.label}: Square shows ${squareNow ?? 'no count'} in stock, not ${want}. A sale since may explain it.`);
      }
    }
    const price = obj(d?.price_money)?.amount;
    report.items.push({
      variationId: c.variationId,
      label: c.label,
      rename: c.rename ? { to: c.rename.to, state: partState(rows, 'rename', c.itemId) } : null,
      price: c.price ? { toCents: c.price.toCents, perPound: c.price.perPound, state: varState } : null,
      switchToWeight: c.switchToWeight ? { state: varState } : null,
      tracking: c.tracking.turnOn ? { state: varState } : null,
      stock: c.stock ? { to: c.stock.to, unit: c.stock.unit, state: partState(rows, 'inventory', c.variationId), squareNow } : null,
      readBack: d
        ? {
            name: itemName(item),
            priceCents: typeof price === 'number' ? price : null,
            pricingType: typeof d.pricing_type === 'string' ? d.pricing_type : '',
            perPound: ctx.ev.perPoundUnitId !== null && d.measurement_unit_id === ctx.ev.perPoundUnitId,
            tracked: typeof d.track_inventory === 'boolean' ? d.track_inventory : null,
          }
        : null,
      problems,
    });
  }
  report.corrections = corrections.map((c) => ({ line: c.line, variationId: c.variationId, takeBack: c.stockTakeBack, state: c.state === 'sent' ? 'done' : partState(rows, 'correction', `line:${c.line}`) }));
  const steps: WriteStep[] = ['rename', 'variations', 'inventory', 'correction'];
  report.writes = rows.sort((a, b) => steps.indexOf(a.step) - steps.indexOf(b.step) || a.id - b.id).map((w) => ({ step: w.step, objects: w.objectIds.length, state: w.state, attempts: w.attempts, error: w.error }));
  if (!items && stopped === '') {
    report.ok = false;
    report.stopped = 'Square could not be read back, so ShelfReady cannot say what it holds. Nothing was sent to the scales.';
  }
  const bad = report.items.find((i) => i.problems.length);
  if (bad && stopped === '') {
    report.ok = false;
    report.stopped = `${bad.label}: ${bad.problems[0]}`;
  }
  return report;
}

/** After Square confirmed everything: the store name sticks, overrides follow, card links are kept. */
function afterSquare(ctx: SendContext): void {
  const { db, now } = ctx.deps;
  const actor: AuditActor = { userId: ctx.send.startedBy, username: ctx.send.startedByName };
  const written = confirmed(ctx, 'variations');
  const renamed = confirmed(ctx, 'rename');
  inTransaction(db, () => {
    const supplierId = ctx.ev.supplier?.status === 'known' ? ctx.ev.supplier.supplier.id : null;
    for (const c of ctx.preview.square) {
      if (c.rename && supplierId !== null && renamed.has(c.itemId)) {
        for (const n of c.lines) {
          const l = ctx.ev.lines.find((x) => x.n === n);
          const p = l?.line.line;
          const keys = p ? lineKeys({ itemNumber: p.item_number, upc: p.upc, description: p.description, brand: p.brand }) : null;
          const m = keys ? lookupMapping(db, supplierId, keys).exact : null;
          if (m && m.kind === 'square' && m.variationId === c.variationId) setMappingStoreName(db, actor, m.id, c.rename.to, now());
        }
      }
      // An override follows only a price Square has. Without a price change, keep and none do nothing.
      const priced = ctx.ev.lines.find((l) => l.variationId === c.variationId && l.priced)?.priced;
      const action = c.price && !written.has(c.variationId) ? undefined : priced?.overrideAction;
      if (action?.kind === 'remove') removePriceOverride(db, actor, c.variationId, now(), ctx.run.id);
      else if (action?.kind === 'set') setPriceOverride(db, actor, c.variationId, action.priceCents, `Set in invoice run ${ctx.run.id}.`, now(), ctx.run.id);
    }
  });
  // The sure card links found by name or code, so they are not looked up again every time.
  let linked = 0;
  for (const card of ctx.preview.cards.cards) {
    try {
      const lookup = lookupCopy(db, { index: ctx.catalog.index, source: ctx.catalog.snapshot.source }, card.variationId);
      if (saveLookupLink(db, actor, lookup, now())) linked++;
    } catch {
      // A card link is a convenience. It never stops a send.
    }
  }
  if (linked) addEvent(db, ctx.run.id, 'send', `Kept ${linked} card ${linked === 1 ? 'link' : 'links'} found by name or code.`, now());
}

function failText(err: unknown): string {
  if (err instanceof SendStop || err instanceof RunError || err instanceof SquareError) return err.message;
  return 'Something went wrong while sending to Square.';
}

/** The send_square job. Ends in square_done (then the scale preview), done, or square_failed. */
export async function runSquareSend(deps: SendDeps, runId: number, next: (deps: SendDeps, runId: number) => Promise<void>): Promise<void> {
  const { db, now } = deps;
  const run = mustGetRun(db, runId);
  const send = getSend(db, runId);
  if (!send || run.state !== 'sending' || send.phase !== 'sending_square') return;
  const fail = (stopped: string, report: SquareReport | null): void => {
    const nothing = squareWrites(db, runId).every((w) => w.state === 'failed');
    const message = `${nothing ? 'Nothing was changed in Square.' : 'Square did not finish.'} Nothing was sent to the scales. ${stopped}`;
    updateSend(db, runId, { phase: 'square_failed', squareReport: report, message }, now());
    updateRun(db, runId, { message }, now());
    addEvent(db, runId, 'send', message, now());
    appendAudit(db, SYSTEM_ACTOR, { action: 'run.send.square_failed', entityType: 'run', entityId: runId, runId, details: { stopped, writes: report?.writes ?? [] } }, now());
  };
  const problems = sendProblems(deps, run, null);
  if (problems.length) return fail(problems[0]!, null);
  const env = runEnvironment(deps, run);
  if (env === null) return fail('This invoice was not read in Square.', null);
  let api: SquareWriteApi;
  try {
    api = deps.squareApi(env);
    if (api.environment !== env) throw new SquareError('The Square write client is for another environment. Nothing was sent.');
  } catch (err) {
    return fail(failText(err), null);
  }
  const catalog = deps.catalogs.get(run.catalogSnapshotId!);
  const preview = run.dryRun as ChangePreview;
  const ev = evaluateRun(deps, run);
  const replay = replayOnly(deps, run);
  const ctx: SendContext = { deps, run, send, preview, catalog, loc: catalog.snapshot.locationId, api, ev, codes: weightCodes(catalog, preview.square), replay };
  addEvent(db, runId, 'send', replay ? 'The approval expired: sending again only the writes whose answer was lost, with their stored keys.' : 'Square: reading each item back before writing.', now());
  let stopped = '';
  try {
    await squareSteps(ctx);
  } catch (err) {
    stopped = failText(err);
    if (!(err instanceof SendStop || err instanceof SquareError || err instanceof RunError)) deps.log?.error({ runId, err: err instanceof Error ? err.name : 'unknown' }, 'square send error');
  }
  ctx.send = getSend(db, runId)!;
  const report = await readBack(ctx, stopped);
  if (!report.ok) return fail(report.stopped, report);
  const scaleCount = preview.scales.changes.filter((c) => !report.scaleSkipped.includes(c.code)).length;
  const message = `Square is done and read back.${report.warnings.length && replay ? ' Some of it was not sent: see below.' : ''} ${scaleCount ? 'Preparing the scale change.' : 'No scale prices change.'}`;
  // The follow-up records and the phase change land together, or not at all.
  inTransaction(db, () => {
    afterSquare(ctx);
    // The fish email shows register prices, so it follows Square, not the scales.
    try {
      deps.afterSquareDone?.(runId, run.dryRunHash, report, catalog.snapshot.source);
    } catch (err) {
      deps.log?.error({ runId, err: err instanceof Error ? err.name : 'unknown' }, 'fish email task not queued');
    }
    updateSend(db, runId, { phase: scaleCount ? 'square_done' : 'done', squareReport: report, message }, now());
    appendAudit(db, SYSTEM_ACTOR, { action: 'run.send.square_done', entityType: 'run', entityId: runId, runId, details: { items: report.items, writes: report.writes, warnings: report.warnings, scaleSkipped: report.scaleSkipped, replay } }, now());
    addEvent(db, runId, 'send', message, now());
    if (!scaleCount) setState(db, runId, 'done', { now: now(), actor: SYSTEM_ACTOR, message: 'Sent. Square is done and read back. No scale prices changed.' });
    else updateRun(db, runId, { message }, now());
  });
  if (scaleCount) await next(deps, runId);
}

// ---- Corrections after the send

/** A person asks to send corrections recorded after the run was sent. */
export function requestCorrections(deps: SendDeps, runId: number, actor: AuditActor & { userId: number }): void {
  const run = mustGetRun(deps.db, runId);
  const send = getSend(deps.db, runId);
  const sentOk = send && ['square_done', 'scale_preview', 'sending_scales', 'done', 'partial'].includes(send.phase);
  if (!sentOk || !['sending', 'partial', 'done'].includes(run.state)) throw new RunError('Corrections go to Square once the invoice has been sent there. Until then they go with the send.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
  const pending = runCorrections(deps.db, runId).filter((c) => c.state === 'pending');
  if (!pending.length) throw new RunError('There are no corrections waiting.', 409);
  appendAudit(deps.db, actor, { action: 'run.send.corrections', entityType: 'run', entityId: runId, runId, details: { lines: pending.map((c) => c.line) } }, deps.now());
  addEvent(deps.db, runId, 'correction', `${actor.username} asked to send ${pending.length === 1 ? 'a correction' : `${pending.length} corrections`} to Square.`, deps.now());
  enqueueJob(deps.db, runId, 'corrections', actor.userId, deps.now());
}

/** The corrections job: writes lost replies again, then each pending correction. */
export async function runCorrectionsJob(deps: SendDeps, runId: number): Promise<void> {
  const { db, now } = deps;
  const run = mustGetRun(db, runId);
  const send = getSend(db, runId);
  if (!send || run.catalogSnapshotId === null) return;
  const catalog = deps.catalogs.get(run.catalogSnapshotId);
  const mixed = runEnvironmentProblem(deps, run);
  if (mixed) {
    addEvent(db, runId, 'correction', `Corrections not sent: ${mixed}`, now());
    return;
  }
  if (catalog.snapshot.locationId !== deps.squareLocationId()) {
    addEvent(db, runId, 'correction', 'Corrections not sent: this invoice was not matched at the Square location in settings.', now());
    return;
  }
  const preview = run.dryRun as ChangePreview;
  const env = runEnvironment(deps, run)!;
  let api: SquareWriteApi;
  try {
    api = deps.squareApi(env);
    if (api.environment !== env) throw new SquareError('The Square write client is for another environment. Nothing was sent.');
  } catch (err) {
    addEvent(db, runId, 'correction', `Corrections not sent: ${failText(err)}`, now());
    return;
  }
  const ctx: SendContext = { deps, run, send, preview, catalog, loc: catalog.snapshot.locationId, api, ev: evaluateRun(deps, run), codes: weightCodes(catalog, preview.square), replay: false };
  try {
    for (const w of squareWrites(db, runId).filter((x) => x.state === 'sending' && x.step === 'correction')) await sendWrite(ctx, w);
    const n = await sendCorrectionWrites(ctx);
    addEvent(db, runId, 'correction', n ? 'Corrections sent to Square.' : 'No stock to take back. The corrections are marked sent.', now());
  } catch (err) {
    addEvent(db, runId, 'correction', `Corrections stopped: ${failText(err)}`, now());
  }
}
