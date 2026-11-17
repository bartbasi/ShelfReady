// Sending a run's scale prices through ScaleConnect, only after Square fully succeeded
// (store/docs/DECISIONS.md decision 1, store/docs/SCALECONNECT-NOTES.md).
//
// Every step that would read or write a scale first checks the run was read in the Square
// environment used now (runEnvironmentProblem): a sandbox run's prices never reach the live
// scales, and a live run's never go to the dev harness. With live Square, a run's prices go to
// every scale (rule 12, liveScalesProblem).
//
// 1. One preview with every scale price change (an edit of each by-weight item whose price
//    changed). Codes not in ScaleConnect's list stop the preview: nothing is sent to any scale.
//    A test run names its scales (FRONT alone), which ScaleConnect warns about.
// 2. The person sees every warning (a price jump over 50 percent, a subset of scales, a scale left
//    out, a PLU change, a scale that may be frozen) and every drift with its token, and accepts
//    them on the page. This code never sets acknowledge_warnings to true on its own: it is true
//    only when a person ticked the box tied to exactly the warnings shown, and the drift tokens
//    passed are exactly the ones a person ticked (CLAUDE.md rule 5).
//    A preview whose own read found a scale that may be frozen is never applied: the person makes
//    a new one, which leaves that scale out.
// 3. The apply runs in the background job. Its state is stored as applying before the call, so a
//    lost reply or a restart never applies it again: the result is looked up by preview id.
// 4. Each scale ends verified or pending, with the prices it is missing and why (may be frozen,
//    not known, left out of a test run). Pending scales get a resend: a person confirms someone
//    looked at the scale, then a compare of that scale alone, then a settle per missed item taking
//    the catalog's record, shown for one yes, then applied.
//
// Nothing here retries a call that reads or writes a scale. Text from scales is data: it is kept
// in its own fields and the pages escape it.

import { createHash } from 'node:crypto';
import { appendAudit, SYSTEM_ACTOR, type AuditActor } from '../db/audit.ts';
import { inTransaction } from '../db/db.ts';
import { ScaleConnectError, targetedScaleStatuses, type ChangeResult, type PreviewResult, type ScaleChange, type WriteResult, type LoggedChange } from '../scaleconnect/client.ts';
import type { ScaleApi } from '../scaleconnect/connection.ts';
import { stableJson, type ChangePreview } from './preview.ts';
import { liveScalesProblem, runEnvironment, runEnvironmentProblem, type SendDeps } from './square-send.ts';
import {
  addScaleStep,
  getSend,
  openPending,
  pendingRows,
  resends,
  resolvePending,
  scaleSteps,
  setPending,
  setResend,
  startResend,
  updateScaleStep,
  updateSend,
  type ScaleStepRow,
  type StepPreview,
  type SendPhase,
} from './send-store.ts';
import { activeJob, addEvent, enqueueJob, mustGetRun, RunError, setState, updateRun } from './store.ts';

/** The run's scale prices that go to the scales: all of them, less any Square did not get (an expired approval). */
export function scaleChangesFor(deps: Pick<SendDeps, 'db'>, runId: number): ChangePreview['scales']['changes'] {
  const run = mustGetRun(deps.db, runId);
  const skipped = new Set(((getSend(deps.db, runId)?.squareReport as { scaleSkipped?: string[] } | null)?.scaleSkipped ?? []).filter((x) => typeof x === 'string'));
  return (run.dryRun as ChangePreview).scales.changes.filter((c) => !skipped.has(c.code));
}

/** Cents from a scale price written as text, or null. */
function centsOf(price: unknown): number | null {
  if (typeof price !== 'string' || !/^\d{1,5}(\.\d{1,2})?$/.test(price)) return null;
  const [w, f = ''] = price.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

export function priceText(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strs(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === 'string');
}

function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function s(v: unknown, max = 300): string {
  return typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '';
}

function errorCodesOf(data: Record<string, unknown>): string[] {
  const out = arr(data.errors).map((e) => s(rec(e).code ?? rec(e).error, 60)).filter((x) => x);
  const one = s(rec(data.error).code, 60);
  if (one) out.push(one);
  return out;
}

/** Ties a person's yes to exactly these previews, warnings and drift tokens. */
export function digestOf(previews: Array<{ previewId: string; preview: StepPreview | null }>): string {
  const what = previews.map((p) => ({
    id: p.previewId,
    warnings: (p.preview?.warnings ?? []).map((w) => [w.code, w.message]),
    drift: [...(p.preview?.driftTokens ?? [])].sort(),
  }));
  return createHash('sha256').update(stableJson(what)).digest('hex').slice(0, 32);
}

/** What a person is shown of a preview, and why it cannot be applied, if it cannot. */
export function keepPreview(data: PreviewResult): StepPreview {
  const d = data as Record<string, unknown>;
  const warnings = arr(d.warnings).map((w) => {
    const o = rec(w);
    return { code: s(o.code, 60), message: s(o.message, 500), requiresAck: o.requires_ack === true, mayBeFrozen: o.may_be_frozen === true };
  });
  const drift = arr(d.drift).map((x) => {
    const o = rec(x);
    return { token: s(o.ack_token ?? o.token, 200), scale: s(o.scale, 40), plu: s(o.plu, 10), text: s(o.message, 500) };
  });
  const driftCannotAck = arr(d.drift_that_cannot_be_acknowledged).map((x) => {
    const o = rec(x);
    return s(o.message, 500) || `${s(o.scale, 40)} ${s(o.kind, 60)}`.trim() || 'A difference that cannot be accepted.';
  });
  const differences = arr(d.differences).map((x) => {
    const o = rec(x);
    const fields = Object.entries(rec(o.fields))
      .map(([k, v]) => `${k} ${s(rec(v).before, 60)} to ${s(rec(v).after, 60)}`)
      .join(', ');
    return { plu: s(o.plu, 10), fields: fields.slice(0, 500) };
  });
  const newPrices: Record<string, string> = {};
  for (const x of arr(d.differences)) {
    const o = rec(x);
    const price = rec(rec(o.fields).price);
    if (typeof price.after === 'string' && s(o.plu, 10)) newPrices[s(o.plu, 10)] = price.after;
  }
  const mayBeFrozen = strs(d.scales_may_be_frozen);
  let blockedWhy = '';
  if (d.ok !== true || typeof d.preview_id !== 'string' || !d.preview_id) {
    const codes = errorCodesOf(d);
    blockedWhy = `ScaleConnect refused the preview${codes.length ? ` (${codes.join(', ')})` : ''}. Nothing was sent.`;
  } else if (mayBeFrozen.length) {
    blockedWhy = `${mayBeFrozen.join(', ')} gave no reply to this preview's read, so ${mayBeFrozen.length === 1 ? 'it' : 'they'} may be frozen. Someone should look at ${mayBeFrozen.length === 1 ? 'it' : 'them'}. This preview cannot be sent. Make a new preview: it leaves ${mayBeFrozen.length === 1 ? 'that scale' : 'those scales'} out.`;
  } else if (driftCannotAck.length) {
    blockedWhy = 'A scale holds something that no acknowledgement can allow, such as another product at that id. A person must sort it out in ScaleConnect first.';
  }
  const kept: StepPreview = {
    summary: s(d.summary, 4000),
    expiresAt: s(d.expires_at, 40),
    scales: strs(d.scales),
    mustAcknowledge: d.must_acknowledge_warnings === true,
    warnings,
    driftTokens: strs(d.drift_tokens_to_acknowledge),
    drift,
    driftCannotAck,
    leftOut: strs(d.left_out),
    mayBeFrozen,
    differences,
    newPrices,
    blockedWhy,
    digest: '',
  };
  kept.digest = digestOf([{ previewId: typeof d.preview_id === 'string' ? d.preview_id : '', preview: kept }]);
  return kept;
}

function expired(p: StepPreview | null, now: number): boolean {
  const t = Date.parse(p?.expiresAt ?? '');
  return !Number.isFinite(t) || t <= now;
}

function scaleWords(e: unknown): string {
  if (e instanceof ScaleConnectError || e instanceof RunError) return e.message;
  return 'ScaleConnect could not be reached.';
}

function setPhase(deps: SendDeps, runId: number, phase: SendPhase, message: string): void {
  updateSend(deps.db, runId, { phase, message }, deps.now());
  updateRun(deps.db, runId, { message }, deps.now());
  addEvent(deps.db, runId, 'scales', message, deps.now());
}

async function withScales<T>(deps: SendDeps, fn: (api: ScaleApi) => Promise<T>): Promise<T> {
  const api = await deps.scaleApi();
  try {
    return await fn(api);
  } finally {
    await api.close().catch(() => undefined);
  }
}

function pushSteps(deps: SendDeps, runId: number): ScaleStepRow[] {
  return scaleSteps(deps.db, runId).filter((x) => x.kind === 'push');
}

// ---- 1. The preview

/** The scale_preview job (also run straight after Square is done). */
export async function prepareScalePreview(deps: SendDeps, runId: number): Promise<void> {
  const { db, now } = deps;
  const run = mustGetRun(db, runId);
  const send = getSend(db, runId);
  if (!send || run.state !== 'sending' || !['square_done', 'scale_preview'].includes(send.phase)) return;
  const preview = { scales: { changes: scaleChangesFor(deps, runId) } };
  const notAllowed = send.scales.filter((x) => !deps.writeScales.includes(x));
  if (notAllowed.length) {
    setPhase(deps, runId, 'scale_preview', `${notAllowed.join(', ')} may not get writes (server config writeScales). Nothing was sent to the scales.`);
    return;
  }
  const mixed = runEnvironmentProblem(deps, run) ?? liveScalesProblem(deps, runEnvironment(deps, run), send.scales, preview.scales.changes.length);
  if (mixed) {
    setPhase(deps, runId, 'scale_preview', `${mixed} Nothing was sent to the scales.`);
    return;
  }
  for (const old of pushSteps(deps, runId)) if (old.state === 'previewed' || old.state === 'blocked' || old.state === 'refused' || old.state === 'failed') updateScaleStep(db, old.id, { state: 'replaced' }, now());
  try {
    await withScales(deps, async (api) => {
      const list = await api.listScales();
      const names = arr(list.data.scales).map((x) => s(rec(x).name, 40)).filter((n) => n);
      const want = [...deps.scaleNames].sort().join(',');
      if ([...names].sort().join(',') !== want) {
        setPhase(deps, runId, 'scale_preview', `ScaleConnect reports the scales ${names.join(', ') || 'none'}, but ShelfReady's config names ${deps.scaleNames.join(', ')}. Nothing was sent to the scales. Fix the config, then prepare the scale change again.`);
        return;
      }
      updateSend(db, runId, { allScales: names }, now());
      // Every code must be on ScaleConnect's list. getItem contacts no scale.
      const missing: string[] = [];
      for (const ch of preview.scales.changes) {
        const found = await api.getItem({ plu: ch.code });
        if (found.data.ok === false || !found.data.item) missing.push(ch.code);
      }
      if (missing.length) {
        const why = `Code${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in ScaleConnect's list. Nothing was sent to any scale. Add ${missing.length === 1 ? 'it' : 'them'} in ScaleConnect, then prepare the scale change again.`;
        addScaleStep(db, runId, { kind: 'push', previewId: '', preview: null, state: 'blocked', result: { blockedWhy: why } }, now());
        setPhase(deps, runId, 'scale_preview', why);
        return;
      }
      const changes: ScaleChange[] = preview.scales.changes.map((ch) => ({ action: 'edit', target_plu: ch.code, price: priceText(ch.priceCents) }));
      const subset = send.scales.length < names.length;
      addEvent(db, runId, 'scales', `Asking ScaleConnect for a preview of ${changes.length} ${changes.length === 1 ? 'price' : 'prices'} on ${send.scales.join(', ')}. It reads the scales and changes nothing.`, now());
      const p = await api.previewChanges(changes, subset ? { scales: send.scales } : {});
      const kept = keepPreview(p.data);
      addScaleStep(db, runId, { kind: 'push', previewId: kept.blockedWhy && !p.data.preview_id ? '' : String(p.data.preview_id ?? ''), preview: kept, state: kept.blockedWhy ? 'blocked' : 'previewed' }, now());
      appendAudit(
        db,
        SYSTEM_ACTOR,
        { action: 'run.scales.preview', entityType: 'run', entityId: runId, runId, details: { previewId: p.data.preview_id ?? null, scales: send.scales, warnings: kept.warnings.map((w) => w.code), drift: kept.driftTokens.length, leftOut: kept.leftOut, mayBeFrozen: kept.mayBeFrozen, blocked: kept.blockedWhy !== '' } },
        now(),
      );
      setPhase(deps, runId, 'scale_preview', kept.blockedWhy || 'The scale change is ready. A person must read every warning and difference and accept them before anything is sent to a scale.');
    });
  } catch (err) {
    setPhase(deps, runId, 'scale_preview', `The scale preview did not work: ${scaleWords(err)} Nothing was sent to the scales. Prepare the scale change again when ScaleConnect is back.`);
  }
}

/** A person asks for a new scale preview. */
export function requestScalePreview(deps: SendDeps, runId: number, actor: AuditActor & { userId: number }): void {
  const run = mustGetRun(deps.db, runId);
  const send = getSend(deps.db, runId);
  if (run.state !== 'sending' || !send || !['square_done', 'scale_preview'].includes(send.phase)) throw new RunError('A scale preview can be made only after Square is done and before the scales are sent.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
  appendAudit(deps.db, actor, { action: 'run.scales.preview_requested', entityType: 'run', entityId: runId, runId }, deps.now());
  addEvent(deps.db, runId, 'scales', `${actor.username} asked for a new scale preview.`, deps.now());
  enqueueJob(deps.db, runId, 'scale_preview', actor.userId, deps.now());
}

// ---- 2. The person's acknowledgement

/**
 * A person accepts the preview. warnings: the digest from the page's tick box, or '' when it was
 * not ticked. drift: the drift tokens the person ticked, each one. Only then is the apply queued.
 */
export function acknowledgeScales(deps: SendDeps, runId: number, actor: AuditActor & { userId: number }, input: { stepId: number; warnings: string; drift: string[] }): void {
  inTransaction(deps.db, () => {
    const run = mustGetRun(deps.db, runId);
    const send = getSend(deps.db, runId);
    if (run.state !== 'sending' || send?.phase !== 'scale_preview') throw new RunError('There is no scale change waiting for a yes.', 409);
    if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
    const step = pushSteps(deps, runId).at(-1);
    if (!step || step.id !== input.stepId) throw new RunError('That scale preview is not the current one. Look at the page again.', 409);
    if (step.state !== 'previewed' || !step.preview || !step.previewId) throw new RunError(step.preview?.blockedWhy || 'This scale preview cannot be sent. Make a new preview.', 409);
    const mixed = runEnvironmentProblem(deps, run) ?? liveScalesProblem(deps, runEnvironment(deps, run), send.scales, scaleChangesFor(deps, runId).length);
    if (mixed) throw new RunError(`${mixed} Nothing was sent to the scales.`, 409);
    const outside = step.preview.scales.filter((x) => !deps.writeScales.includes(x));
    if (outside.length) throw new RunError(`This preview would write to ${outside.join(', ')}, which may not get writes (server config writeScales). Nothing was sent.`, 409);
    if (expired(step.preview, deps.now())) throw new RunError('This scale preview has expired (ScaleConnect keeps one for 15 minutes). Make a new preview. Nothing was sent.', 409);
    const p = step.preview;
    if (p.mustAcknowledge) {
      if (input.warnings !== p.digest) throw new RunError('Read every warning and tick the box to accept them. Nothing was sent.', 400);
    } else if (input.warnings !== '' && input.warnings !== p.digest) {
      throw new RunError('The warnings changed since the page was shown. Look at them again.', 409);
    }
    const posted = [...new Set(input.drift)].sort();
    const wanted = [...p.driftTokens].sort();
    if (posted.length !== wanted.length || posted.some((t, i) => t !== wanted[i])) throw new RunError('Tick each difference shown on the scales to accept it. Nothing was sent.', 400);
    const ack = { byName: actor.username, byId: actor.userId, at: deps.now(), acknowledgeWarnings: p.mustAcknowledge, acknowledgeDrift: wanted };
    updateScaleStep(deps.db, step.id, { state: 'acknowledged', ack }, deps.now());
    updateSend(deps.db, runId, { phase: 'sending_scales', message: 'Sending to the scales. This can take a few minutes. You can leave this page.' }, deps.now());
    updateRun(deps.db, runId, { message: 'Sending to the scales.' }, deps.now());
    appendAudit(deps.db, actor, { action: 'run.scales.acknowledge', entityType: 'run', entityId: runId, runId, details: { previewId: step.previewId, warnings: p.warnings.map((w) => w.code), acknowledgeWarnings: ack.acknowledgeWarnings, drift: wanted } }, deps.now());
    addEvent(deps.db, runId, 'scales', `${actor.username} accepted the scale preview${p.warnings.length ? ` and its ${p.warnings.length === 1 ? 'warning' : `${p.warnings.length} warnings`}` : ''}${wanted.length ? ` and ${wanted.length} ${wanted.length === 1 ? 'difference' : 'differences'}` : ''}.`, deps.now());
    enqueueJob(deps.db, runId, 'send_scales', actor.userId, deps.now());
  });
}

// ---- 3. The apply

type Outcome =
  | { kind: 'success' | 'partial' | 'failed'; data: ChangeResult }
  | { kind: 'refused'; code: string; message: string }
  | { kind: 'unknown'; message: string }
  /** The preview expired with no apply logged: it can never run now, and no scale changed. */
  | { kind: 'never_applied' };

/** How long past a preview's expiry ShelfReady waits before calling an unlogged apply never applied. */
const NEVER_APPLIED_AFTER_MS = 5 * 60_000;

/** The apply, or the lookup when one may already have gone. Never applies a step twice. */
async function applyOrLookUp(deps: SendDeps, api: ScaleApi, step: ScaleStepRow): Promise<Outcome> {
  if (step.state === 'acknowledged') {
    if (!step.ack) return { kind: 'refused', code: 'no_ack', message: 'No person accepted this preview.' };
    // Stored before the call, so a restart or a lost reply looks it up instead of applying again.
    updateScaleStep(deps.db, step.id, { state: 'applying' }, deps.now());
    const w: WriteResult = await api.applyChanges(step.previewId, { acknowledgeWarnings: step.ack.acknowledgeWarnings, acknowledgeDrift: step.ack.acknowledgeDrift });
    if (w.kind === 'success' || w.kind === 'partial' || w.kind === 'failed') return { kind: w.kind, data: w.data };
    if (w.kind === 'refused') return { kind: 'refused', code: errorCodesOf((w.data ?? {}) as Record<string, unknown>)[0] ?? '', message: w.message };
  }
  return lookUp(api, step, deps.now());
}

async function lookUp(api: ScaleApi, step: ScaleStepRow, now: number): Promise<Outcome> {
  let logged: LoggedChange;
  try {
    logged = await api.getChange({ previewId: step.previewId });
  } catch {
    return { kind: 'unknown', message: 'ScaleConnect could not be asked for the result.' };
  }
  if (logged.kind === 'success' || logged.kind === 'partial' || logged.kind === 'failed') return { kind: logged.kind, data: logged.data };
  const expiresAt = Date.parse(step.preview?.expiresAt ?? '');
  if (logged.kind === 'not_applied' && Number.isFinite(expiresAt) && now > expiresAt + NEVER_APPLIED_AFTER_MS) return { kind: 'never_applied' };
  return { kind: 'unknown', message: logged.kind === 'not_applied' ? 'ScaleConnect has no result for it yet.' : 'The result is not clear yet.' };
}

function refusedWords(code: string): string {
  if (code === 'apply_busy') return 'ScaleConnect is busy with another change. Nothing was sent. Make a new preview in a few minutes.';
  if (code === 'acknowledgement_required') return 'ScaleConnect asked for an acknowledgement this preview did not have. Nothing was sent. Make a new preview.';
  return `ScaleConnect refused the change${code ? ` (${code})` : ''}. Nothing was sent. Make a new preview.`;
}

function resultSummary(o: Outcome): Record<string, unknown> {
  if (o.kind === 'refused') return { kind: o.kind, code: o.code };
  if (o.kind === 'unknown' || o.kind === 'never_applied') return { kind: o.kind };
  return { kind: o.kind, outcome: o.data.outcome ?? null, success: o.data.success ?? null, statuses: o.data.scale_statuses ?? {}, mayBeFrozen: strs(o.data.scales_may_be_frozen), changeId: o.data.change_id ?? null };
}

/** Each scale verified or pending for each price, from a push result. */
function recordPush(deps: SendDeps, runId: number, data: ChangeResult): void {
  const send = getSend(deps.db, runId)!;
  const preview = { scales: { changes: scaleChangesFor(deps, runId) } };
  const frozen = new Set(strs(data.scales_may_be_frozen));
  const rows = arr(data.items).map(rec);
  const differs = arr(data.still_differ).map(rec);
  for (const scale of send.allScales) {
    for (const ch of preview.scales.changes) {
      const base = { scale, code: ch.code, priceCents: ch.priceCents, itemName: ch.itemName };
      if (!send.scales.includes(scale)) {
        setPending(deps.db, runId, { ...base, reason: 'not_targeted' }, deps.now());
        continue;
      }
      const row = rows.find((r) => s(r.plu, 10) === ch.code);
      const stillDiffers = differs.some((d) => typeof d.scale !== 'string' || (d.scale === scale && (d.plu === undefined || s(d.plu, 10) === ch.code)));
      const verified = rec(data.scale_statuses)[scale] === 'verified' && strs(row?.confirmed_on).includes(scale) && !stillDiffers;
      if (verified) continue;
      const reason = frozen.has(scale) ? 'may_be_frozen' : strs(row?.not_known).includes(scale) ? 'not_known' : 'not_verified';
      setPending(deps.db, runId, { ...base, reason }, deps.now());
    }
  }
}

function finishIfDone(deps: SendDeps, runId: number, actor: AuditActor = SYSTEM_ACTOR): boolean {
  const run = mustGetRun(deps.db, runId);
  const open = openPending(deps.db, runId);
  if (open === 0) {
    updateSend(deps.db, runId, { phase: 'done', message: 'Done. Square and every scale confirmed the new prices.' }, deps.now());
    if (run.state !== 'done') setState(deps.db, runId, 'done', { now: deps.now(), actor, message: 'Sent. Square and every scale confirmed the new prices.' });
    addEvent(deps.db, runId, 'scales', 'Every scale confirmed. Square and the scales match.', deps.now());
    return true;
  }
  const scales = [...new Set(pendingRows(deps.db, runId).filter((p) => p.state === 'pending').map((p) => p.scale))];
  const message = `Square is done. ${scales.join(', ')} ${scales.length === 1 ? 'is' : 'are'} pending: ${scales.length === 1 ? 'it has' : 'they have'} not confirmed every new price. Use Resend once someone has looked at ${scales.length === 1 ? 'it' : 'them'}.`;
  updateSend(deps.db, runId, { phase: 'partial', message }, deps.now());
  if (run.state === 'sending') setState(deps.db, runId, 'partial', { now: deps.now(), actor, message });
  else updateRun(deps.db, runId, { message }, deps.now());
  return false;
}

/** The send_scales job: applies the acknowledged preview, or looks up one already sent. */
export async function applyScales(deps: SendDeps, runId: number): Promise<void> {
  const { db, now } = deps;
  const step = pushSteps(deps, runId).at(-1);
  if (!step || !['acknowledged', 'applying', 'unknown'].includes(step.state)) return;
  // A lookup is always safe. A new apply waits if the environment changed since the yes.
  const mixed = step.state === 'acknowledged' ? runEnvironmentProblem(deps, mustGetRun(db, runId)) : null;
  if (mixed) {
    updateScaleStep(db, step.id, { state: 'previewed' }, now());
    setPhase(deps, runId, 'scale_preview', `${mixed} Nothing was sent to the scales.`);
    return;
  }
  let o: Outcome;
  try {
    o = await withScales(deps, (api) => applyOrLookUp(deps, api, step));
  } catch (err) {
    // Before any apply left (the connection failed), nothing was sent: the person accepts again.
    const fresh = scaleSteps(db, runId).find((x) => x.id === step.id)!;
    if (fresh.state === 'acknowledged') {
      updateScaleStep(db, step.id, { state: 'previewed' }, now());
      setPhase(deps, runId, 'scale_preview', `Nothing was sent to the scales: ${scaleWords(err)} Accept the preview again when ScaleConnect is back, or make a new one if it has expired.`);
      return;
    }
    o = { kind: 'unknown', message: scaleWords(err) };
  }
  updateScaleStep(db, step.id, { state: o.kind === 'never_applied' ? 'refused' : o.kind, result: resultSummary(o) }, now());
  appendAudit(db, SYSTEM_ACTOR, { action: 'run.scales.result', entityType: 'run', entityId: runId, runId, details: { previewId: step.previewId, ...resultSummary(o) } }, now());
  if (o.kind === 'refused') return setPhase(deps, runId, 'scale_preview', refusedWords(o.code));
  if (o.kind === 'never_applied') {
    return setPhase(deps, runId, 'scale_preview', 'The change never reached ScaleConnect: its preview expired and no apply was logged, so no scale changed. Square has the new prices, so every scale is behind. When a person agrees, make a new preview: it reads the scales again and shows what each one holds.');
  }
  if (o.kind === 'unknown') return setPhase(deps, runId, 'sending_scales', `The scales' answer did not come back. ${o.message} The change may still be running: it can take minutes. ShelfReady never sends it twice. Look up the result in a minute.`);
  if (o.kind === 'failed') return setPhase(deps, runId, 'scale_preview', 'Nothing reached any scale, and ScaleConnect knows it. Square still has the new prices. Make a new preview to send them to the scales.');
  recordPush(deps, runId, o.data);
  finishIfDone(deps, runId);
}

/** A person asks to look up a result that did not come back. Contacts no scale. */
export function requestLookup(deps: SendDeps, runId: number, actor: AuditActor & { userId: number }): void {
  const steps = scaleSteps(deps.db, runId).filter((x) => x.state === 'unknown');
  if (!steps.length) throw new RunError('There is no scale result to look up.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
  appendAudit(deps.db, actor, { action: 'run.scales.lookup', entityType: 'run', entityId: runId, runId, details: { previewIds: steps.map((x) => x.previewId) } }, deps.now());
  enqueueJob(deps.db, runId, 'scale_lookup', actor.userId, deps.now());
}

/** The scale_lookup job: asks ScaleConnect for each result not yet known, by preview id. */
export async function lookupResults(deps: SendDeps, runId: number): Promise<void> {
  const push = pushSteps(deps, runId).at(-1);
  if (push && push.state === 'unknown') await applyScales(deps, runId);
  if (scaleSteps(deps.db, runId).some((x) => x.kind === 'settle' && x.state === 'unknown')) await resendApply(deps, runId);
}

// ---- 4. Resend for a pending scale

function pendingScales(deps: SendDeps, runId: number): Set<string> {
  return new Set(pendingRows(deps.db, runId).filter((p) => p.state === 'pending').map((p) => p.scale));
}

/** Step 1: a person confirms someone has looked at the scale. Then a compare of that scale alone. */
export function confirmLooked(deps: SendDeps, runId: number, actor: AuditActor & { userId: number }, scale: string, looked: boolean): void {
  inTransaction(deps.db, () => {
    const run = mustGetRun(deps.db, runId);
    if (run.state !== 'partial') throw new RunError('There is no pending scale to resend to.', 409);
    if (!pendingScales(deps, runId).has(scale)) throw new RunError('That scale has nothing pending from this invoice.', 400);
    if (!deps.writeScales.includes(scale)) throw new RunError(`${scale} may not get writes. The server config allows ${deps.writeScales.join(', ') || 'no scale'}.`, 400);
    if (!looked) throw new RunError(`Tick the box to confirm someone has looked at ${scale}, and rebooted it if it needed that.`, 400);
    const mixed = runEnvironmentProblem(deps, run);
    if (mixed) throw new RunError(`${mixed} Nothing was sent to ${scale}.`, 409);
    if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
    for (const st of scaleSteps(deps.db, runId)) if (st.kind === 'settle' && st.scale === scale && (st.state === 'previewed' || st.state === 'blocked')) updateScaleStep(deps.db, st.id, { state: 'replaced' }, deps.now());
    startResend(deps.db, runId, scale, actor.username, deps.now());
    appendAudit(deps.db, actor, { action: 'run.scales.looked', entityType: 'run', entityId: runId, runId, details: { scale } }, deps.now());
    addEvent(deps.db, runId, 'scales', `${actor.username} confirmed someone looked at ${scale}. Comparing ${scale} alone, then preparing a settle for each missed price.`, deps.now());
    enqueueJob(deps.db, runId, 'resend_compare', actor.userId, deps.now());
  });
}

/** The resend_compare job: the compare of each looked-at scale alone, then one settle preview per missed item. */
export async function resendCompare(deps: SendDeps, runId: number): Promise<void> {
  const { db, now } = deps;
  const mixed = runEnvironmentProblem(deps, mustGetRun(db, runId));
  for (const r of resends(db, runId).filter((x) => x.state === 'looked')) {
    if (mixed) {
      setResend(db, runId, r.scale, 'stopped', `${mixed} Nothing was read or sent.`, now());
      continue;
    }
    try {
      await withScales(deps, async (api) => {
        const cmp = await api.compareScale(r.scale);
        const here = arr(cmp.data.scales).map(rec).find((x) => x.scale === r.scale);
        const answered = here?.status === 'compared' && !strs(cmp.data.scales_may_be_frozen).includes(r.scale);
        appendAudit(db, SYSTEM_ACTOR, { action: 'run.scales.compare', entityType: 'run', entityId: runId, runId, details: { scale: r.scale, status: s(here?.status, 40), answered } }, now());
        if (!answered) {
          for (const p of pendingRows(db, runId).filter((x) => x.scale === r.scale && x.state === 'pending')) setPending(db, runId, { ...p, reason: 'may_be_frozen' }, now());
          setResend(db, runId, r.scale, 'still_frozen', `${r.scale} still did not answer, so it may be frozen. Have someone look at it and reboot it if needed, then try again. Nothing was sent.`, now());
          return;
        }
        const notes: string[] = [];
        // What ScaleConnect's list holds and whether it took each change. Neither contacts a scale.
        const unfinished = arr((await api.listScales()).data.unfinished).map(rec);
        for (const p of pendingRows(db, runId).filter((x) => x.scale === r.scale && x.state === 'pending')) {
          // A settle sends the catalog's record. Offer it only when that record holds this run's price,
          // so a resend can never put back an old or different price.
          const item = rec((await api.getItem({ plu: p.code })).data.item);
          const listCents = centsOf(item.price);
          if (listCents !== p.priceCents) {
            notes.push(`Code ${p.code}: ScaleConnect's list holds ${listCents === null ? 'no price' : priceText(listCents)}, not this invoice's ${priceText(p.priceCents)}, so a settle would put the wrong price on ${r.scale}. None is offered. Check the item in ScaleConnect.`);
            continue;
          }
          const row = unfinished.find((u) => u.scale === r.scale && s(u.plu, 10) === p.code);
          if (row && row.catalog_took_it === false) {
            notes.push(`Code ${p.code}: ScaleConnect's list did not take this change, so a settle would put back the old value. None is offered.`);
            continue;
          }
          const ps = await api.previewSettleDrift(r.scale, 'catalog', { plu: p.code });
          const d = ps.data as Record<string, unknown>;
          if (d.ok !== true) {
            const codes = errorCodesOf(d);
            if (codes.includes('no_drift') || /no_drift/.test(ps.data.summary)) {
              resolvePending(db, runId, r.scale, p.code, 'Already matched when compared.', now());
            } else {
              notes.push(`Code ${p.code}: ScaleConnect would not prepare a settle${codes.length ? ` (${codes.join(', ')})` : ''}.`);
            }
            continue;
          }
          const kept = keepPreview(ps.data);
          const after = kept.newPrices?.[p.code];
          if (!kept.blockedWhy && after !== undefined && centsOf(after) !== p.priceCents) {
            kept.blockedWhy = `This settle would put ${after} on ${r.scale}, not this invoice's ${priceText(p.priceCents)}. It is not offered.`;
          }
          addScaleStep(db, runId, { kind: 'settle', scale: r.scale, code: p.code, previewId: String(ps.data.preview_id), preview: kept, state: kept.blockedWhy ? 'blocked' : 'previewed' }, now());
          if (kept.blockedWhy) notes.push(`Code ${p.code}: ${kept.blockedWhy}`);
          if (kept.mayBeFrozen.includes(r.scale)) break;
        }
        const left = pendingRows(db, runId).filter((x) => x.scale === r.scale && x.state === 'pending').length;
        const ready = scaleSteps(db, runId).some((x) => x.kind === 'settle' && x.scale === r.scale && x.state === 'previewed');
        if (left === 0) setResend(db, runId, r.scale, 'done', `${r.scale} already holds every price. Nothing needed sending.`, now());
        else if (ready) setResend(db, runId, r.scale, 'previewed', [`Read the settle for ${r.scale} below and say yes once.`, ...notes].join(' '), now());
        else setResend(db, runId, r.scale, 'stopped', notes.join(' ') || `Nothing could be prepared for ${r.scale}.`, now());
      });
    } catch (err) {
      setResend(db, runId, r.scale, 'stopped', `The resend did not work: ${scaleWords(err)} Nothing was sent.`, now());
    }
    addEvent(db, runId, 'scales', resends(db, runId).find((x) => x.scale === r.scale)?.message ?? '', now());
  }
  finishIfDone(deps, runId);
}

/** The settle previews waiting for one yes for this scale. */
export function settlesWaiting(deps: Pick<SendDeps, 'db'>, runId: number, scale: string): ScaleStepRow[] {
  return scaleSteps(deps.db, runId).filter((x) => x.kind === 'settle' && x.scale === scale && x.state === 'previewed');
}

/**
 * Step 2: a yes for every settle of this scale, tied to exactly what was shown: the warnings box
 * (a digest of every settle, its warnings and its drift) and one box per drift token.
 */
export function acceptSettles(deps: SendDeps, runId: number, actor: AuditActor & { userId: number }, scale: string, digest: string, drift: string[]): void {
  inTransaction(deps.db, () => {
    const run = mustGetRun(deps.db, runId);
    if (run.state !== 'partial') throw new RunError('There is no pending scale to resend to.', 409);
    if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on.', 409);
    const steps = settlesWaiting(deps, runId, scale);
    if (!steps.length) throw new RunError('There is no settle waiting for a yes for that scale.', 409);
    if (steps.some((x) => expired(x.preview, deps.now()))) throw new RunError('The settle has expired (ScaleConnect keeps one for 15 minutes). Start the resend again. Nothing was sent.', 409);
    if (!deps.writeScales.includes(scale)) throw new RunError(`${scale} may not get writes. The server config allows ${deps.writeScales.join(', ') || 'no scale'}.`, 400);
    const mixed = runEnvironmentProblem(deps, run);
    if (mixed) throw new RunError(`${mixed} Nothing was sent to ${scale}.`, 409);
    const mustAck = steps.some((x) => x.preview!.mustAcknowledge);
    if (mustAck ? digest !== digestOf(steps) : digest !== '' && digest !== digestOf(steps)) throw new RunError('Read the settle and its warnings, and tick the box to say yes. Nothing was sent.', 400);
    const wanted = [...new Set(steps.flatMap((x) => x.preview!.driftTokens))].sort();
    const posted = [...new Set(drift)].sort();
    if (posted.length !== wanted.length || posted.some((t, i) => t !== wanted[i])) throw new RunError('Tick each difference shown on the scale to accept it. Nothing was sent.', 400);
    // Each settle must still put this invoice's price on the scale, and its item must still be pending.
    const open = pendingRows(deps.db, runId).filter((p) => p.scale === scale && p.state === 'pending');
    for (const st of steps) {
      const p = open.find((x) => x.code === st.code);
      const after = st.preview!.newPrices?.[st.code];
      if (!p || (after !== undefined && centsOf(after) !== p.priceCents)) throw new RunError(`The settle for code ${st.code} no longer matches this invoice. Start the resend again. Nothing was sent.`, 409);
    }
    for (const st of steps) {
      // The warnings and drift on each settle are exactly the ones the person just accepted.
      const ack = { byName: actor.username, byId: actor.userId, at: deps.now(), acknowledgeWarnings: st.preview!.mustAcknowledge, acknowledgeDrift: [...st.preview!.driftTokens] };
      updateScaleStep(deps.db, st.id, { state: 'acknowledged', ack }, deps.now());
    }
    setResend(deps.db, runId, scale, 'applying', `Sending the settle to ${scale}.`, deps.now());
    appendAudit(
      deps.db,
      actor,
      { action: 'run.scales.resend_yes', entityType: 'run', entityId: runId, runId, details: { scale, previews: steps.map((x) => ({ previewId: x.previewId, code: x.code, warnings: x.preview!.warnings.map((w) => w.code), drift: x.preview!.driftTokens })) } },
      deps.now(),
    );
    addEvent(deps.db, runId, 'scales', `${actor.username} said yes to the settle for ${scale}.`, deps.now());
    enqueueJob(deps.db, runId, 'resend_apply', actor.userId, deps.now());
  });
}

/** The resend_apply job: applies each accepted settle, or looks it up when it may already have gone. */
export async function resendApply(deps: SendDeps, runId: number): Promise<void> {
  const { db, now } = deps;
  const steps = scaleSteps(db, runId).filter((x) => x.kind === 'settle' && ['acknowledged', 'applying', 'unknown'].includes(x.state));
  const touched = new Set<string>();
  const mixed = runEnvironmentProblem(deps, mustGetRun(db, runId));
  for (const step of steps) {
    touched.add(step.scale);
    if (mixed && step.state === 'acknowledged') {
      updateScaleStep(db, step.id, { state: 'refused', result: { kind: 'refused', code: 'square_environment' } }, now());
      setResend(db, runId, step.scale, 'stopped', `${mixed} Nothing was sent to ${step.scale}.`, now());
      continue;
    }
    let o: Outcome;
    try {
      o = await withScales(deps, (api) => applyOrLookUp(deps, api, step));
    } catch (err) {
      const fresh = scaleSteps(db, runId).find((x) => x.id === step.id)!;
      if (fresh.state === 'acknowledged') {
        updateScaleStep(db, step.id, { state: 'refused', result: { kind: 'refused', code: 'not_connected' } }, now());
        setResend(db, runId, step.scale, 'stopped', `Nothing was sent: ${scaleWords(err)} Start the resend again.`, now());
        continue;
      }
      o = { kind: 'unknown', message: scaleWords(err) };
    }
    updateScaleStep(db, step.id, { state: o.kind === 'never_applied' ? 'refused' : o.kind, result: resultSummary(o) }, now());
    appendAudit(db, SYSTEM_ACTOR, { action: 'run.scales.resend_result', entityType: 'run', entityId: runId, runId, details: { scale: step.scale, code: step.code, previewId: step.previewId, ...resultSummary(o) } }, now());
    if (o.kind === 'success' || o.kind === 'partial') {
      // A settle touches one scale, so it is partial when other scales exist. Only that scale counts.
      const t = targetedScaleStatuses(o.data);
      if (t.allVerified && step.scale in t.statuses) resolvePending(db, runId, step.scale, step.code, 'Settled to the catalog and verified.', now());
      else setResend(db, runId, step.scale, 'stopped', `${step.scale} did not confirm code ${step.code}. Look at the scale and try the resend again.`, now());
    } else if (o.kind === 'never_applied') {
      setResend(db, runId, step.scale, 'stopped', `The settle for code ${step.code} never reached ScaleConnect: it expired with no apply logged, so ${step.scale} did not change. Start the resend again when a person agrees: it reads the scale again.`, now());
    } else if (o.kind === 'refused') {
      setResend(db, runId, step.scale, 'stopped', refusedWords(o.code).replace('Make a new preview', 'Start the resend again'), now());
    } else if (o.kind === 'failed') {
      setResend(db, runId, step.scale, 'stopped', `Code ${step.code} did not reach ${step.scale}. Start the resend again.`, now());
    } else {
      setResend(db, runId, step.scale, 'applying', `The answer from ${step.scale} did not come back. ShelfReady never sends it twice. Look up the result in a minute.`, now());
    }
  }
  for (const scale of touched) {
    const left = pendingRows(db, runId).filter((p) => p.scale === scale && p.state === 'pending').length;
    if (left === 0) setResend(db, runId, scale, 'done', `${scale} confirmed every missed price.`, now());
  }
  finishIfDone(deps, runId);
}
