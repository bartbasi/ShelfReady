// The view model for sending a run: everything the send page needs, as plain data and plain words.
// No markup here. Text from scales and Square is data: the templates escape it.

import type { Db } from '../db/db.ts';
import { STATE_LABELS, type RunState } from './states.ts';
import type { ChangePreview } from './preview.ts';
import { money } from './review.ts';
import { digestOf, settlesWaiting } from './scale-push.ts';
import { approvalExpiresAt, nothingInSquare, replayOnly, sendProblems, type SendDeps, type SquareReport } from './square-send.ts';
import { getSend, PHASE_LABELS, pendingRows, resends, scaleSteps, squareWrites, type PendingReason, type ResendState, type SendPhase, type StepPreview } from './send-store.ts';
import { activeJob, runCorrections, type RunRow } from './store.ts';

function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

const REASONS: Record<PendingReason, string> = {
  not_verified: 'did not confirm it',
  not_targeted: 'was left out of this test run',
  may_be_frozen: 'gave no reply and may be frozen',
  not_known: 'may or may not have it (the reply was lost)',
};

const RESEND_LABELS: Record<ResendState, string> = {
  looked: 'Comparing the scale',
  still_frozen: 'Still not answering',
  previewed: 'Settle ready: waiting for a yes',
  applying: 'Sending the settle',
  done: 'Done',
  stopped: 'Stopped',
};

export interface PreviewView extends StepPreview {
  stepId: number;
  previewId: string;
  expired: boolean;
}

export interface ScaleRow {
  name: string;
  targeted: boolean;
  status: 'verified' | 'pending' | 'waiting';
  statusLabel: string;
  mayBeFrozen: boolean;
  missing: Array<{ code: string; itemName: string; price: string; why: string }>;
  resend: null | {
    state: ResendState;
    label: string;
    message: string;
    lookedByName: string;
    lookedAt: string;
    settles: PreviewView[];
    digest: string;
  };
  canLook: boolean;
  canAcceptSettle: boolean;
}

export interface SendView {
  runId: number;
  runState: RunState;
  stateLabel: string;
  phase: SendPhase | null;
  phaseLabel: string;
  message: string;
  working: boolean;
  start: null | {
    retry: boolean;
    canStart: boolean;
    problems: string[];
    hash: string;
    expiresAt: string;
    /** Only the scales the server config lets a send write to. */
    scales: Array<{ name: string; checked: boolean }>;
    /** Scales the config does not let a send write to, for the page to say so. */
    notAllowed: string[];
    /** The approval expired with part of the run in Square: Send again only finishes what went. */
    replayOnly: boolean;
    squareItems: number;
    scalePrices: number;
    canRedoDryRun: boolean;
    /** Square refused before anything landed: the send can be stopped, for a fresh upload. */
    canStop: boolean;
  };
  square: SquareReport | null;
  scalePreview: PreviewView | null;
  canNewPreview: boolean;
  canLookup: boolean;
  /** Square writes whose answer was lost and that need a person to check Square. */
  unknownWrites: Array<{ id: number; step: string; objects: string[]; attempts: number; error: string }>;
  canCheckWrites: boolean;
  scales: ScaleRow[];
  corrections: { list: Array<{ line: number; takeBack: string; unit: string; credit: string; state: string; recordedByName: string }>; canSend: boolean };
}

function previewView(stepId: number, previewId: string, p: StepPreview, now: number): PreviewView {
  const t = Date.parse(p.expiresAt);
  return { ...p, stepId, previewId, expired: !Number.isFinite(t) || t <= now };
}

export function sendView(deps: SendDeps, run: RunRow): SendView {
  const db: Db = deps.db;
  const now = deps.now();
  const send = getSend(db, run.id);
  const working = activeJob(db, run.id) !== null;
  const preview = run.dryRun as ChangePreview | null;
  const view: SendView = {
    runId: run.id,
    runState: run.state,
    stateLabel: working ? 'Working' : STATE_LABELS[run.state],
    phase: send?.phase ?? null,
    phaseLabel: send ? PHASE_LABELS[send.phase] : '',
    message: send?.message || run.message,
    working,
    start: null,
    square: (send?.squareReport as SquareReport | null) ?? null,
    scalePreview: null,
    canNewPreview: false,
    canLookup: false,
    unknownWrites: [],
    canCheckWrites: false,
    scales: [],
    corrections: { list: [], canSend: false },
  };
  const retry = run.state === 'sending' && send?.phase === 'square_failed';
  if (run.state === 'approved' || retry) {
    const problems = working ? ['This invoice is still being worked on.'] : sendProblems(deps, run, run.dryRunHash);
    const expires = approvalExpiresAt(deps, run);
    view.start = {
      retry,
      canStart: problems.length === 0,
      problems,
      hash: run.dryRunHash,
      expiresAt: when(expires),
      scales: deps.scaleNames.filter((name) => deps.writeScales.includes(name)).map((name) => ({ name, checked: retry ? (send?.scales ?? []).includes(name) : true })),
      notAllowed: deps.scaleNames.filter((name) => !deps.writeScales.includes(name)),
      replayOnly: retry && replayOnly(deps, run),
      squareItems: preview?.square.length ?? 0,
      scalePrices: preview?.scales.changes.length ?? 0,
      canRedoDryRun: run.state === 'approved' && !working,
      canStop: retry && !working && nothingInSquare(deps, run.id),
    };
  }
  const steps = scaleSteps(db, run.id);
  const push = steps.filter((x) => x.kind === 'push').at(-1);
  if (push && send?.phase === 'scale_preview') {
    if (push.preview) view.scalePreview = previewView(push.id, push.previewId, push.preview, now);
    else if (push.state === 'blocked') {
      const why = (push.result as { blockedWhy?: string } | null)?.blockedWhy ?? 'This scale change cannot be sent.';
      view.scalePreview = previewView(push.id, '', { summary: '', expiresAt: '', scales: [], mustAcknowledge: false, warnings: [], driftTokens: [], drift: [], driftCannotAck: [], leftOut: [], mayBeFrozen: [], differences: [], blockedWhy: why, digest: '' }, now);
    }
  }
  view.canNewPreview = !working && run.state === 'sending' && (send?.phase === 'square_done' || send?.phase === 'scale_preview');
  view.canLookup = !working && steps.some((x) => x.state === 'unknown');
  view.unknownWrites = squareWrites(db, run.id)
    .filter((w) => w.state === 'sending' && w.attempts > 0)
    .map((w) => ({ id: w.id, step: w.step, objects: w.objectIds, attempts: w.attempts, error: w.error }));
  view.canCheckWrites = !working && view.unknownWrites.length > 0;

  if (send) {
    const pending = pendingRows(db, run.id);
    const rs = resends(db, run.id);
    const allScales = send.allScales.length ? send.allScales : deps.scaleNames;
    const sentToScales = ['partial', 'done'].includes(send.phase) || run.state === 'partial' || run.state === 'done';
    view.scales = allScales.map((name) => {
      const mine = pending.filter((p) => p.scale === name && p.state === 'pending');
      const r = rs.find((x) => x.scale === name) ?? null;
      const settles = r ? settlesWaiting(deps, run.id, name) : [];
      const status: ScaleRow['status'] = !sentToScales ? 'waiting' : mine.length ? 'pending' : 'verified';
      return {
        name,
        targeted: send.scales.includes(name),
        status,
        statusLabel: status === 'waiting' ? 'Not sent yet' : status === 'verified' ? 'Verified' : 'Pending',
        mayBeFrozen: mine.some((p) => p.reason === 'may_be_frozen'),
        missing: mine.map((p) => ({ code: p.code, itemName: p.itemName, price: `${money(p.priceCents)} per pound`, why: REASONS[p.reason] })),
        resend: r
          ? {
              state: r.state,
              label: RESEND_LABELS[r.state],
              message: r.message,
              lookedByName: r.lookedByName,
              lookedAt: when(r.lookedAt),
              settles: settles.map((x) => previewView(x.id, x.previewId, x.preview!, now)),
              digest: settles.length ? digestOf(settles) : '',
            }
          : null,
        canLook: !working && run.state === 'partial' && mine.length > 0 && deps.writeScales.includes(name) && (!r || ['still_frozen', 'stopped', 'done', 'previewed'].includes(r.state)),
        canAcceptSettle: !working && run.state === 'partial' && settles.length > 0 && deps.writeScales.includes(name),
      };
    });
    const corrections = runCorrections(db, run.id);
    view.corrections = {
      list: corrections.map((c) => ({
        line: c.line,
        takeBack: c.stockTakeBack,
        unit: c.stockUnit,
        credit: money(c.creditCents),
        state: c.state !== 'sent' ? 'Waiting' : (send.snapshot?.folded?.foldedLines ?? []).includes(c.line) ? 'Handled in the send: that stock was never sent' : 'Taken back out in Square',
        recordedByName: c.recordedByName,
      })),
      canSend: !working && corrections.some((c) => c.state === 'pending') && ['square_done', 'scale_preview', 'sending_scales', 'done', 'partial'].includes(send.phase),
    };
  }
  return view;
}
