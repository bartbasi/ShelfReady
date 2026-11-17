// Reads old invoices in the background, one at a time, oldest first. Record only: it reads the
// photos, checks the reading and saves the lines. It never makes an invoice run, and it has no
// way to reach Square, the scales or the cards: none of those clients are handed to it.
//
// - The reader is the same as for invoice runs (src/invoice/pipeline.ts): first pass, code checks,
//   the fallback model, and the hard cost cap per invoice. Nothing waits for review. A reading
//   that needs a person is still saved, with its lines flagged.
// - Spend goes in the shared ledger before a call goes out, so the daily limit covers old and new
//   invoices and card copy together. Old invoices may use only their share of it (a setting, half
//   by default), so a backlog can never block a live invoice run. A reading starts only when its
//   worst case still fits under both the daily limit and that share; otherwise uploads wait and
//   are read later.
// - A reading over the cost cap per invoice is not sent. If a first reading was already made, its
//   lines are saved and flagged; otherwise the invoice fails with a plain message.
// - A restart in the middle of a reading does not send it again, since it may have been paid for.
//   The invoice fails with a message, and the same photos can be uploaded again.
//
// Logs carry only the invoice id and an error's name, never invoice text or a key.

import { appendAudit, SYSTEM_ACTOR } from '../db/audit.ts';
import type { Db } from '../db/db.ts';
import type { InvoiceModelClient } from '../invoice/extract.ts';
import { InvoiceInputError, readInvoice, type InvoiceFile, type ReadResult } from '../invoice/pipeline.ts';
import { buildInvoiceSettings, invoiceSettingsFrom, type InvoiceReadingSettings } from '../invoice/settings.ts';
import type { Settings } from '../settings/store.ts';
import { readStoredFile, removeStoredFile } from '../runs/files.ts';
import { filePositions, historyFromReading } from './lines.ts';
import {
  bookCutShortReads,
  historySpendSince,
  dropFiles,
  failInvoice,
  HistoryError,
  nextWaiting,
  purchaseFiles,
  readingIds,
  recordReading,
  reserveReadSpend,
  setMessage,
  settleReadSpend,
  spendSince,
  startReading,
  waitingIds,
  type ReadFacts,
} from './store.ts';

export interface HistoryLog {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface HistoryWorkerDeps {
  db: Db;
  settings: Settings;
  /** Where old invoice files are kept. */
  dir: string;
  /** Builds the model client from the key in settings. Throws HistoryError when it cannot. */
  modelClient: () => InvoiceModelClient;
  /** Extra invoice reading settings, for tests. */
  invoiceSettings?: Partial<InvoiceReadingSettings>;
  /** Most all model calls may cost in any 24 hours, in US dollars. */
  dailyLimitUsd: () => number;
  /** The percent of the daily limit old invoices may use, 10 to 100. */
  historySharePercent: () => number;
  now: () => number;
  log: HistoryLog;
  /** Start work as soon as it is queued. Default true. Tests turn it off and call drain. */
  auto?: boolean;
  /** How long to wait before trying again when the daily limit is reached. Default 15 minutes. */
  limitRetryMs?: number;
}

export interface HistoryWorker {
  kick(): void;
  /** Reads until nothing is waiting, or the daily limit stops it. For tests. */
  drain(): Promise<void>;
  stop(): Promise<void>;
  /** Picks up what a restart left behind. Called once at start. */
  recover(): void;
}

const ENTITY = 'purchase_invoice';

const RESTARTED = 'ShelfReady restarted while reading this invoice. It may already have been paid for, so it was not read again. Upload the photos again to read it.';

const OVER_CAP = 'Only the first reading was made. A second one would cost more than the limit per invoice.';

const NOT_FINISHED = 'The reading could not be finished.';

const GENERIC = 'The invoice could not be read. Try again. If it keeps happening, tell Bart.';

/** The store's invoice reading settings, as the run code builds them, with test extras on top. */
export function readingSettings(s: Pick<Settings, 'getSetting'>, extra?: Partial<InvoiceReadingSettings>): InvoiceReadingSettings {
  const fromSettings = invoiceSettingsFrom({
    anthropicFirstPassModel: s.getSetting('anthropicFirstPassModel'),
    anthropicFallbackModel: s.getSetting('anthropicFallbackModel'),
    invoiceCostCapUsd: s.getSetting('invoiceCostCapUsd'),
  });
  return extra ? buildInvoiceSettings({ ...fromSettings, ...extra }) : fromSettings;
}

function invoiceSettings(deps: HistoryWorkerDeps): InvoiceReadingSettings {
  return readingSettings(deps.settings, deps.invoiceSettings);
}

function factsOf(result: ReadResult): ReadFacts {
  return {
    readStatus: result.status,
    models: result.audit.attempts.map((a) => a.model).join(' then '),
    finalModel: result.audit.finalModel ?? '',
    costUsd: result.audit.totalCostUsd,
    costIsEstimate: result.attempts.some((a) => a.costIsEstimate),
  };
}

/** Plain words for a result with no reading to save. Never the model's own text. */
function noReadingMessage(result: ReadResult, capUsd: number): string {
  if (result.status === 'needs_approval') {
    return `Reading this invoice could cost more than the limit of $${capUsd.toFixed(2)} per invoice, so it was not read. Upload fewer pages at a time, or ask an admin to raise the limit in settings.`;
  }
  if (result.status === 'retry') return 'This invoice could not be measured right now, so it was not read. Upload it again in a minute.';
  const kinds = result.attempts.map((a) => a.error?.kind);
  if (kinds.includes('authentication')) return 'The Claude API key was refused. An admin must check it in settings.';
  return 'The reader could not make a reading of this invoice. Check the photos are clear and upload them again.';
}

function removeFiles(dir: string, names: readonly string[]): void {
  for (const n of names) removeStoredFile(dir, n);
}

/** Why a reading must wait for the daily limit, in plain words, or null when it may start. */
export function spendWait(o: { spentUsd: number; historySpentUsd: number; limitUsd: number; sharePercent: number; capUsd: number }): string | null {
  const usd = (n: number) => `$${n.toFixed(2)}`;
  if (o.spentUsd + o.capUsd > o.limitUsd) {
    return `Waiting. Readings and card copy in the last 24 hours have cost ${usd(o.spentUsd)}. One more reading, up to ${usd(o.capUsd)}, could pass the daily limit of ${usd(o.limitUsd)}. This invoice is read once that drops.`;
  }
  const share = (o.limitUsd * o.sharePercent) / 100;
  if (o.historySpentUsd + o.capUsd > share) {
    return `Waiting. Old invoices in the last 24 hours have cost ${usd(o.historySpentUsd)}. One more reading, up to ${usd(o.capUsd)}, could pass their share of the daily limit, ${usd(share)}. This keeps room for new invoices. It is read once that drops.`;
  }
  return null;
}

/** Reads one waiting invoice. Returns false when the daily limit says to wait. */
async function readOne(deps: HistoryWorkerDeps, id: number): Promise<boolean> {
  const { db, now } = deps;
  const settings = invoiceSettings(deps);
  const since = now() - 24 * 3600_000;
  const wait = spendWait({
    spentUsd: spendSince(db, since),
    historySpentUsd: historySpendSince(db, since),
    limitUsd: deps.dailyLimitUsd(),
    sharePercent: deps.historySharePercent(),
    capUsd: settings.costCapUsd,
  });
  if (wait) {
    for (const w of waitingIds(db)) setMessage(db, w, wait, now());
    return false;
  }
  if (!startReading(db, id, now())) return true;
  let client: InvoiceModelClient;
  let files: InvoiceFile[];
  try {
    client = deps.modelClient();
    files = purchaseFiles(db, id).map((f) => ({ name: f.originalName, bytes: readStoredFile(deps.dir, f.storedName) }));
  } catch (err) {
    failInvoice(db, id, err instanceof HistoryError ? err.message : 'The invoice files could not be opened. Upload them again.', null, now());
    throw err;
  }
  // The worst case is booked before any call goes out, and replaced by the real cost after.
  const spendId = reserveReadSpend(db, id, settings.costCapUsd, now());
  let result: ReadResult;
  try {
    result = await readInvoice(files, { client, settings, now: () => new Date(now()) });
  } catch (err) {
    if (err instanceof InvoiceInputError) {
      settleReadSpend(db, spendId, 0, now());
      failInvoice(db, id, err.message, null, now());
      appendAudit(db, SYSTEM_ACTOR, { action: 'history.read_refused', entityType: ENTITY, entityId: id, details: { reason: err.message } }, now());
      return true;
    }
    // Any other failure keeps the worst case booked: the call may have been paid for.
    failInvoice(db, id, GENERIC, null, now());
    throw err;
  }
  settleReadSpend(db, spendId, result.audit.totalCostUsd, now());
  // The run log: models, checks, tokens and cost. Never the key or the images.
  appendAudit(db, SYSTEM_ACTOR, { action: 'history.read', entityType: ENTITY, entityId: id, details: JSON.parse(JSON.stringify(result.audit)) as Record<string, unknown> }, now());
  const facts = factsOf(result);
  if (!result.reading) {
    failInvoice(db, id, noReadingMessage(result, settings.costCapUsd), facts, now());
    return true;
  }
  const input = result.audit.input;
  const where = filePositions(input.kind, input.files.length, input.repeatedUploads.map((r) => r.index));
  // Over the cost cap after a first reading: that reading is saved, and every line says so.
  const extra = result.status === 'needs_approval' ? [OVER_CAP] : result.status === 'retry' ? [NOT_FINISHED] : [];
  const history = historyFromReading(result.reading, settings, where, { today: new Date(now()), extraNotes: extra });
  const outcome = recordReading(db, id, history, result.reading.invoice, facts, now());
  if (!outcome.recorded) {
    const d = outcome.duplicateOf;
    const message =
      d.source === 'run'
        ? `Already recorded from invoice run ${d.runId}. This copy was not saved.`
        : `Already recorded as old invoice ${d.id}: ${d.vendor} invoice ${d.invoiceNumber}${d.invoiceDateIso ? `, dated ${d.invoiceDateIso}` : ''}. This copy was not saved.`;
    removeFiles(deps.dir, dropFiles(db, id));
    failInvoice(db, id, message, facts, now());
    appendAudit(db, SYSTEM_ACTOR, { action: 'history.duplicate', entityType: ENTITY, entityId: id, details: { sameAs: d.id, sameRun: d.runId, vendor: d.vendor, invoiceNumber: d.invoiceNumber } }, now());
    return true;
  }
  return true;
}

export function createHistoryWorker(deps: HistoryWorkerDeps): HistoryWorker {
  const { db, now, log } = deps;
  let current: Promise<void> | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  /** Reads until nothing is waiting. Returns 'limit' when the daily limit stopped it. */
  async function loop(): Promise<'empty' | 'limit'> {
    while (!stopped) {
      let next;
      try {
        next = nextWaiting(db);
      } catch (err) {
        log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'old invoice reader could not take an invoice');
        return 'empty';
      }
      if (!next) return 'empty';
      log.info({ purchaseInvoiceId: next.id }, 'old invoice reading started');
      try {
        if (!(await readOne(deps, next.id))) return 'limit';
        log.info({ purchaseInvoiceId: next.id }, 'old invoice reading done');
      } catch (err) {
        log.error({ purchaseInvoiceId: next.id, err: err instanceof Error ? err.name : 'unknown' }, 'old invoice reading failed');
        // Whatever happened, the invoice must not stay in reading.
        try {
          const still = db.prepare("SELECT state FROM purchase_invoices WHERE id = ?").get(next.id) as { state: string } | undefined;
          if (still && (still.state === 'reading' || still.state === 'uploaded')) failInvoice(db, next.id, GENERIC, null, now());
        } catch {
          log.error({ purchaseInvoiceId: next.id }, 'could not record a failed old invoice reading');
        }
      }
    }
    return 'empty';
  }

  const start = (): void => {
    if (current || stopped) return;
    current = loop()
      .then((why) => {
        if (why === 'limit' && !stopped && deps.auto !== false && !timer) {
          timer = setTimeout(() => {
            timer = null;
            start();
          }, deps.limitRetryMs ?? 15 * 60_000);
          timer.unref();
        }
      })
      .finally(() => {
        current = null;
      });
  };

  return {
    kick() {
      if (deps.auto !== false) start();
    },
    async drain() {
      start();
      if (current) await current;
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (current) await Promise.race([current, new Promise((r) => setTimeout(r, 5000).unref())]);
    },
    recover() {
      bookCutShortReads(db, now());
      for (const id of readingIds(db)) {
        failInvoice(db, id, RESTARTED, null, now());
        appendAudit(db, SYSTEM_ACTOR, { action: 'history.read_interrupted', entityType: ENTITY, entityId: id }, now());
      }
    },
  };
}
