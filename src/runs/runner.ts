// The background job runner: one job at a time, in this process, so a run never competes with
// another for the shared store PC. The server process itself runs niced (src/server/main.ts).
//
// Jobs are rows in run_jobs, so they survive a restart. On start:
// - a queued job simply runs;
// - a job left running is queued again, unless it stopped in the middle of a model call. That
//   reading may already have been paid for, so it is not sent again on its own: the run moves to
//   "retry" and a person presses Read again.
// The manager can leave the page and come back: the run page shows the progress lines.
//
// Logs carry only the run id, the job kind and an error's name. Messages shown to people come
// from this code, never from raw errors, which can quote a request.

import type { AuditActor } from '../db/audit.ts';
import { SYSTEM_ACTOR } from '../db/audit.ts';
import type { Db } from '../db/db.ts';
import type { InvoiceModelClient } from '../invoice/extract.ts';
import { InvoiceInputError, readInvoice, type InvoiceFile, type PendingApproval } from '../invoice/pipeline.ts';
import { buildInvoiceSettings, invoiceSettingsFrom, type InvoiceReadingSettings } from '../invoice/settings.ts';
import { knownItemLookup } from '../matching/known-item.ts';
import { catalogLabelFor, type CatalogSource } from '../square/catalog-source.ts';
import { envForSource, mixedEnvironmentProblem } from '../square/origins.ts';
import type { SquareWriter } from '../square/client.ts';
import { SquareError } from '../square/client.ts';
import type { Settings } from '../settings/store.ts';
import type { RunCatalog } from './catalog-cache.ts';
import { cardBlockersFor, cardCopyStage, cardsForRun, type CardCopyStage } from './card-copy.ts';
import { interruptCalls } from './copy-store.ts';
import { bookCutShort, reserveSpend, settleSpend, spendSince } from './spend.ts';
import { evaluate, type Evaluation, type StoredReading } from './evaluate.ts';
import { readStoredFile } from './files.ts';
import { dbOverrideStore } from './overrides.ts';
import { buildPreview, type ChangePreview } from './preview.ts';
import type { SendJobs } from './send-jobs.ts';
import {
  addEvent,
  claimNextJob,
  finishJob,
  mustGetRun,
  queuedJobCount,
  runDecisions,
  runFiles,
  runningJobs,
  RunError,
  saveCatalogSnapshot,
  setState,
  toJson,
  updateRun,
  type Decision,
  SEND_JOB_KINDS,
  type Job,
  type RunRow,
  type SendJobKind,
} from './store.ts';
import { appendAudit } from '../db/audit.ts';
import { recordRunInHistory } from '../history/runs.ts';

export interface RunnerLog {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface RunnerDeps {
  db: Db;
  settings: Settings;
  uploadDir: string;
  scaleNames: readonly string[];
  /** The catalog source the server config chose. */
  catalogSource: CatalogSource;
  catalogs: { get(snapshotId: number): RunCatalog };
  /** Builds the model client from the key in settings. Throws RunError when it cannot. */
  modelClient: () => InvoiceModelClient;
  /** Extra invoice reading settings, for tests. */
  invoiceSettings?: Partial<InvoiceReadingSettings>;
  /** Handed to the dry run only to prove it never calls it. Sending uses `send` below. */
  squareWriter?: SquareWriter;
  /** The jobs that send a run to Square and the scales (src/runs/send-jobs.ts). */
  send?: SendJobs;
  /**
   * After a dry run is worked out: reads the fish email in Mailchimp and stores what the run would
   * change there (src/mailchimp/service.ts). Reads only, and never throws.
   */
  afterDryRun?: (runId: number, preview: ChangePreview) => Promise<void>;
  cardCopy?: CardCopyStage;
  /** Most all readings and card copy together may cost in any 24 hours, in US dollars. Past it, an admin approves. */
  dailyReadingCapUsd: number;
  /** A price moving more than this percent needs its own tick. From the server config. */
  bigChangePercent: number;
  now: () => number;
  log: RunnerLog;
  /** Start work as soon as it is queued. Default true. Tests turn it off and call drain. */
  auto?: boolean;
}

export interface Runner {
  /** Starts work if any is queued and nothing is running. */
  kick(): void;
  /** Runs until the queue is empty. For tests. */
  drain(): Promise<void>;
  stop(): Promise<void>;
  /** Picks up jobs a restart left behind. Called once at start. */
  recover(): void;
}

const isSendJob = (kind: string): kind is SendJobKind => (SEND_JOB_KINDS as readonly string[]).includes(kind);

const READ_SCALES_AGAIN = 'ShelfReady restarted while reading the scales. A read can freeze a scale, so it was not run again on its own. Press the button again when ready.';

const READ_AGAIN = 'ShelfReady restarted while reading this invoice. That reading may already have been paid for, so it was not sent again. Press Read again to try once more.';

function invoiceSettings(deps: RunnerDeps): InvoiceReadingSettings {
  const s = deps.settings;
  const fromSettings = invoiceSettingsFrom({
    anthropicFirstPassModel: s.getSetting('anthropicFirstPassModel'),
    anthropicFallbackModel: s.getSetting('anthropicFallbackModel'),
    invoiceCostCapUsd: s.getSetting('invoiceCostCapUsd'),
  });
  // Extra settings (tests) win over the saved ones.
  return deps.invoiceSettings ? buildInvoiceSettings({ ...fromSettings, ...deps.invoiceSettings }) : fromSettings;
}

/** The run's evaluation without the card list: matching, what arrived, stock and pricing. */
function evaluateLines(deps: Pick<RunnerDeps, 'db' | 'settings' | 'catalogs' | 'bigChangePercent'>, run: RunRow, decisions: Decision[]): Evaluation {
  if (run.catalogSnapshotId === null) throw new RunError('This invoice has no catalog yet.', 409);
  return evaluate({
    db: deps.db,
    read: run.readResult as StoredReading | null,
    catalog: deps.catalogs.get(run.catalogSnapshotId),
    decisions,
    pricing: deps.settings.getSetting('pricing'),
    overrides: dbOverrideStore(deps.db),
    bigChangePercent: deps.bigChangePercent,
  });
}

/**
 * Works out the run's evaluation from what is stored now, with the cards it would print. A card
 * that cannot print yet blocks like any other item (src/runs/card-copy.ts).
 */
export function evaluateRun(deps: Pick<RunnerDeps, 'db' | 'settings' | 'catalogs' | 'bigChangePercent'>, run: RunRow): Evaluation {
  const decisions = runDecisions(deps.db, run.id);
  const ev = evaluateLines(deps, run, decisions);
  if (!ev.lines.length) return ev;
  ev.cards = cardsForRun(deps.db, run.id, deps.catalogs.get(run.catalogSnapshotId!), ev, decisions);
  ev.blockers.push(...cardBlockersFor(ev.cards));
  return ev;
}

/** Stores an evaluation and moves the run to review or ready to match it. */
export function settleRun(deps: Pick<RunnerDeps, 'db' | 'settings' | 'catalogs' | 'now' | 'bigChangePercent'>, runId: number, actor: AuditActor, note?: string): Evaluation {
  const run = mustGetRun(deps.db, runId);
  const ev = evaluateRun(deps, run);
  const to = ev.blockers.length === 0 ? 'ready' : 'review';
  setState(deps.db, runId, to, {
    now: deps.now(),
    actor,
    message: note ?? (to === 'ready' ? 'Nothing blocks. Make a dry run to see every change.' : `${ev.blockers.length} ${ev.blockers.length === 1 ? 'thing needs' : 'things need'} a person.`),
    // A change after a dry run makes that preview out of date.
    fields: { evaluation: summaryOf(ev), blockers: ev.blockers.length, dryRun: null, dryRunHash: '', dryRunAt: null },
  });
  return ev;
}

/** What a run list needs, without the whole reading. */
function summaryOf(ev: Evaluation): unknown {
  return {
    blockers: ev.blockers.map((b) => ({ id: b.id, line: b.line ?? null, message: b.message })),
    lines: ev.lines.map((l) => ({ n: l.n, outcome: l.outcome, variationId: l.variationId, status: l.priced?.status ?? null, newCents: l.priced?.newCents ?? null })),
  };
}

async function loadFiles(deps: RunnerDeps, runId: number): Promise<InvoiceFile[]> {
  return runFiles(deps.db, runId).map((f) => ({ name: f.originalName, bytes: readStoredFile(deps.uploadDir, f.storedName) }));
}

async function processJob(deps: RunnerDeps, job: Job): Promise<void> {
  const { db, now } = deps;
  const actor = SYSTEM_ACTOR;
  let run = mustGetRun(db, job.runId);
  const pending = run.pendingApproval as (PendingApproval & { dailyCap?: boolean }) | null;
  const approvedDaily = job.resumeApproved && run.readStatus === 'needs_approval' && pending?.dailyCap === true;
  const resuming = job.resumeApproved && run.readStatus === 'needs_approval' && !approvedDaily;
  const reread = run.readStatus === '' || resuming || approvedDaily;

  // 1. The catalog this run is matched against. Kept for the life of the run.
  if (run.catalogSnapshotId === null) {
    addEvent(db, run.id, 'catalog', `Reading the catalog from the ${deps.catalogSource.label}.`, now());
    const data = await deps.catalogSource.load();
    const id = saveCatalogSnapshot(db, data, now());
    updateRun(db, run.id, { catalogSnapshotId: id, catalogTakenAt: data.takenAt }, now());
    addEvent(db, run.id, 'catalog', `Catalog read: ${data.objects.length} objects, taken ${data.takenAt}.`, now());
    run = mustGetRun(db, run.id);
  }
  const catalog = deps.catalogs.get(run.catalogSnapshotId!);

  // 2. The reading.
  if (reread) {
    // The rolling 24 hour spend cap, from the costs in the run log. An admin's approval of this
    // run (for either cap) lets it go on.
    const settings = invoiceSettings(deps);
    if (!job.resumeApproved) {
      // Readings and card copy share the daily limit. The reading starts only when its worst case
      // still fits under it, so one reading never takes the day past the limit.
      const spent = spendSince(db, now() - 24 * 3600_000);
      if (spent + settings.costCapUsd > deps.dailyReadingCapUsd) {
        const message = `Readings and card copy in the last 24 hours have cost $${spent.toFixed(2)}. Reading this invoice, up to $${settings.costCapUsd.toFixed(2)}, could pass the daily limit of $${deps.dailyReadingCapUsd.toFixed(2)}. An admin must approve before this invoice is read.`;
        updateRun(
          db,
          run.id,
          {
            readStatus: 'needs_approval',
            pendingApproval: { dailyCap: true, spentUsd: spent, capUsd: deps.dailyReadingCapUsd, message },
            approvalModel: 'daily limit',
            approvalEstimateUsd: spent.toFixed(2),
            costApprovedBy: null,
            costApprovedByName: '',
            costApprovedAt: null,
          },
          now(),
        );
        setState(db, run.id, 'needs_approval', { now: now(), actor: SYSTEM_ACTOR, message });
        addEvent(db, run.id, 'reading', message, now());
        return;
      }
    }
    const client = deps.modelClient();
    const files = await loadFiles(deps, run.id);
    run = setState(db, run.id, 'reading', { now: now(), actor, message: 'Reading the invoice.' });
    addEvent(db, run.id, 'reading', resuming ? `Reading again with ${run.approvalModel}, approved by ${run.costApprovedByName}.` : `Reading with ${settings.firstPassModel}.`, now());
    const resume = resuming ? (pending as PendingApproval) : undefined;
    // The reading's worst case is booked before any call goes out, and replaced by its real cost
    // when it returns, so a restart in the middle never leaves the daily limit counting less than
    // may have been spent. A resumed reading's earlier attempts were booked by their own job.
    const prior = resume ? Math.max(0, Number(resume.spentUsd) || 0) : 0;
    const worst = resume ? Math.max(Number(resume.estimateUsd) || 0, settings.costCapUsd - prior) : settings.costCapUsd;
    const spendId = reserveSpend(db, { runId: run.id, kind: 'read', usd: worst }, now());
    let result: Awaited<ReturnType<typeof readInvoice>>;
    try {
      result = await readInvoice(files, { client, settings, now: () => new Date(now()), knownItem: knownItemLookup({ db, index: catalog.index }) }, resume ? { resume, approvedOverCap: true } : {});
    } catch (err) {
      // Files refused before any call cost nothing. Any other failure keeps the worst case booked.
      if (err instanceof InvoiceInputError) settleSpend(db, spendId, 0, now());
      throw err;
    }
    settleSpend(db, spendId, result.audit.totalCostUsd - prior, now());
    const stored: StoredReading = { status: result.status, reading: result.reading, reviewReasons: result.reviewReasons, notices: result.notices, images: result.images, audit: result.audit };
    const approval = result.approval;
    updateRun(
      db,
      run.id,
      {
        readStatus: result.status,
        readResult: stored,
        pendingApproval: approval,
        approvalModel: approval?.model ?? '',
        approvalEstimateUsd: approval ? approval.estimateUsd.toFixed(2) : '',
        ...(approval ? { costApprovedBy: null, costApprovedByName: '', costApprovedAt: null } : {}),
      },
      now(),
    );
    // The purchase history gets this invoice's lines from this same reading: no second call, and
    // no second booking of its cost. A failure there never stops the run.
    if (!recordRunInHistory(db, run.id, now(), settings) && result.reading) deps.log.error({ runId: run.id }, 'could not record the run in the purchase history');
    // The run log: models, checks passed and failed, tokens and cost. Never the key or the images.
    appendAudit(db, actor, { action: 'run.read', entityType: 'run', entityId: run.id, runId: run.id, details: JSON.parse(toJson(result.audit)) as Record<string, unknown> }, now());
    const models = result.audit.attempts.map((a) => a.model).join(' then ') || 'no model';
    addEvent(db, run.id, 'reading', `Read with ${models}: ${result.status}. Cost about $${result.audit.totalCostUsd.toFixed(2)}.`, now());
    if (result.status === 'needs_approval') {
      setState(db, run.id, 'needs_approval', { now: now(), actor, message: approval?.message ?? 'An admin must approve the cost first.' });
      return;
    }
    if (result.status === 'retry') {
      setState(db, run.id, 'retry', { now: now(), actor, message: result.reviewReasons[0] ?? 'The invoice could not be read now. Try again in a minute.' });
      return;
    }
  }

  // 3. Card copy: stored copy looked up, new copy written where there is none, under the cap.
  const copy = await (deps.cardCopy ?? cardCopyStage)(
    { runId: run.id },
    { db, settings: deps.settings, catalogs: deps.catalogs, now, dailyCapUsd: deps.dailyReadingCapUsd, evaluate: (r) => evaluateLines(deps, r, runDecisions(db, r.id)) },
  );
  addEvent(db, run.id, 'card_copy', copy.message, now());

  // 4. Matching, pricing and what blocks.
  const ev = settleRun(deps, run.id, actor);
  addEvent(db, run.id, 'review', ev.blockers.length === 0 ? 'Matched and priced. Nothing blocks.' : `Matched and priced. ${ev.blockers.length} ${ev.blockers.length === 1 ? 'item needs' : 'items need'} a person.`, now());
}

async function dryRunJob(deps: RunnerDeps, job: Job): Promise<void> {
  const { db, now } = deps;
  const run = mustGetRun(db, job.runId);
  if (run.state !== 'ready' && run.state !== 'dry_run_done') throw new RunError('A dry run needs an invoice with nothing blocking.', 409);
  const ev = evaluateRun(deps, run);
  if (ev.blockers.length > 0) {
    settleRun(deps, run.id, SYSTEM_ACTOR, 'Something changed, and it needs a person before a dry run.');
    return;
  }
  const catalog = deps.catalogs.get(run.catalogSnapshotId!);
  // A run read in one Square environment never gets counts, or a dry run, from the other.
  const current = deps.catalogSource.kind;
  if (current !== 'file' && envForSource(catalog.snapshot.source) !== null && current !== catalog.snapshot.source) {
    throw new RunError(mixedEnvironmentProblem(catalog.snapshot.source, envForSource(current)!) ?? 'This invoice was read in another Square environment.', 409);
  }
  const ids = [...new Set(ev.lines.filter((l) => l.outcome === 'send' && l.variationId).map((l) => l.variationId!))];
  addEvent(db, run.id, 'dry_run', 'Dry run: reading stock counts. Nothing is written.', now());
  // Counts come from the same kind of source the catalog came from, never the other Square.
  const counts = deps.catalogSource.kind === catalog.snapshot.source ? await deps.catalogSource.counts(ids, catalog.index.locationId, catalog.snapshot.source) : new Map<string, string>();
  const preview: ChangePreview = buildPreview({
    runId: run.id,
    evaluation: ev,
    catalog,
    catalogLabel: catalogLabelFor(deps.catalogSource, catalog.snapshot.source),
    decisions: runDecisions(db, run.id),
    counts,
    scaleNames: deps.scaleNames,
    now: now(),
  });
  if (deps.afterDryRun) await deps.afterDryRun(run.id, preview);
  setState(db, run.id, 'dry_run_done', {
    now: now(),
    actor: SYSTEM_ACTOR,
    message: 'Dry run done. Nothing was sent to Square or the scales.',
    fields: { dryRun: preview, dryRunHash: preview.hash, dryRunAt: now(), blockers: 0 },
  });
  appendAudit(
    db,
    SYSTEM_ACTOR,
    {
      action: 'run.dry_run',
      entityType: 'run',
      entityId: run.id,
      runId: run.id,
      details: { hash: preview.hash, squareChanges: preview.square.length, scaleChanges: preview.scales.changes.length, cards: preview.cards.cards.length, wrote: 'nothing' },
    },
    now(),
  );
  addEvent(db, run.id, 'dry_run', `Dry run done: ${preview.square.length} Square ${preview.square.length === 1 ? 'item' : 'items'}, ${preview.scales.changes.length} scale ${preview.scales.changes.length === 1 ? 'price' : 'prices'}, ${preview.cards.cards.length} ${preview.cards.cards.length === 1 ? 'card' : 'cards'}. Nothing was written.`, now());
}

/** Plain words for a job that failed, safe to show. */
function failureText(err: unknown): string {
  if (err instanceof RunError || err instanceof SquareError || err instanceof InvoiceInputError) return err.message;
  return 'Something went wrong. Try again. If it keeps happening, tell Bart.';
}

export function createRunner(deps: RunnerDeps): Runner {
  const { db, now, log } = deps;
  let current: Promise<void> | null = null;
  let stopped = false;

  async function runJob(job: Job): Promise<void> {
    log.info({ runId: job.runId, job: job.kind }, 'job started');
    try {
      if (job.kind === 'process') await processJob(deps, job);
      else if (job.kind === 'dry_run') await dryRunJob(deps, job);
      else if (isSendJob(job.kind)) {
        if (!deps.send) throw new RunError('Sending is not set up in this ShelfReady.');
        await deps.send.run(job);
      }
      finishJob(db, job.id, 'done', now());
      log.info({ runId: job.runId, job: job.kind }, 'job done');
    } catch (err) {
      const text = failureText(err);
      finishJob(db, job.id, 'failed', now(), text);
      log.error({ runId: job.runId, job: job.kind, err: err instanceof Error ? err.name : 'unknown' }, 'job failed');
      try {
        const run = mustGetRun(db, job.runId);
        addEvent(db, run.id, job.kind, `Stopped: ${text}`, now());
        if (job.kind === 'process') {
          // Bad files need a new upload. Anything else can be tried again. Whatever state the run
          // was in, it ends in one a person can act on, with the reason shown.
          const to = err instanceof InvoiceInputError ? 'failed' : 'retry';
          const stage = run.readStatus === '' ? 'before the reading' : 'after the reading was saved';
          const message = `Stopped ${stage}: ${text}`;
          try {
            if (run.state !== to) setState(db, run.id, to, { now: now(), actor: SYSTEM_ACTOR, message });
            else updateRun(db, run.id, { message }, now());
          } catch {
            updateRun(db, run.id, { message }, now());
          }
        } else if (job.kind === 'dry_run') {
          updateRun(db, run.id, { message: `The dry run stopped: ${text}` }, now());
        } else {
          updateRun(db, run.id, { message: `Sending stopped: ${text}` }, now());
        }
      } catch {
        log.error({ runId: job.runId }, 'could not record a failed job');
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      let job: Job | null;
      try {
        job = claimNextJob(db, now());
      } catch (err) {
        // A database error here must not stop the runner for good. The next kick tries again.
        log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'job runner could not take a job');
        return;
      }
      if (!job) return;
      try {
        await runJob(job);
      } catch (err) {
        log.error({ runId: job.runId, err: err instanceof Error ? err.name : 'unknown' }, 'job runner error');
        return;
      }
    }
  }

  const start = (): void => {
    if (current || stopped) return;
    current = loop().finally(() => {
      current = null;
    });
  };

  const runner: Runner = {
    kick() {
      if (deps.auto !== false) start();
    },
    async drain() {
      while (!stopped) {
        start();
        if (current) await current;
        if (queuedJobCount(db) === 0) return;
      }
    },
    async stop() {
      stopped = true;
      if (current) await Promise.race([current, new Promise((r) => setTimeout(r, 5000).unref())]);
    },
    recover() {
      // Calls cut short: their worst case stays booked, and card copy calls are never sent again
      // on their own. A person asks again.
      bookCutShort(db, now());
      interruptCalls(db, null, now());
      for (const job of runningJobs(db)) {
        const run = mustGetRun(db, job.runId);
        // A reading already stored is safe to pick up from. Only a model call that was in flight is not.
        const notStored = run.readStatus === '' || (job.resumeApproved && run.readStatus === 'needs_approval');
        const midReading = job.kind === 'process' && run.state === 'reading' && notStored;
        if (isSendJob(job.kind) && !(deps.send?.safeToRepeat(job.kind) ?? false)) {
          finishJob(db, job.id, 'interrupted', now(), 'restarted while reading the scales');
          updateRun(db, run.id, { message: READ_SCALES_AGAIN }, now());
          addEvent(db, run.id, 'restart', READ_SCALES_AGAIN, now());
        } else if (midReading) {
          finishJob(db, job.id, 'interrupted', now(), 'restarted while reading');
          setState(db, run.id, 'retry', { now: now(), actor: SYSTEM_ACTOR, message: READ_AGAIN });
          addEvent(db, run.id, 'restart', READ_AGAIN, now());
        } else {
          db.prepare("UPDATE run_jobs SET state = 'queued', started_at = NULL WHERE id = ?").run(job.id);
          addEvent(db, run.id, 'restart', 'ShelfReady restarted. This work picks up again.', now());
        }
      }
    },
  };
  return runner;
}
