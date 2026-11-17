// The fish email as the app uses it: the client from settings, the dry run preview, the task an
// invoice send queues, the worker, and the clock that queues the checks with no invoice.
//
// Until the server config sets allowMailchimpWrites (Bart approves live Mailchimp changes), the
// dry run may read the fish email, but nothing is queued, no check runs, and the client refuses
// every change before it is sent.
//
// The checks run inside the server process, from a timer that looks every minute, rather than from
// crontab: only the server holds the settings key, and one process means two pieces of work never
// change the fish email at once. A check missed while the server was off runs when it starts again,
// as long as the email it guards is still far enough ahead (src/mailchimp/days.ts dueCheckSlot).

import { isAbsolute, join } from 'node:path';
import type { Db } from '../db/db.ts';
import type { ChangePreview } from '../runs/preview.ts';
import type { SquareReport } from '../runs/square-send.ts';
import { REPO_ROOT } from '../server/config.ts';
import type { Settings } from '../settings/store.ts';
import { createMailchimpClient, MailchimpError, setupProblem, type MailchimpApi } from './client.ts';
import { listIdMissing, loadMailchimpConfigForApp, type MailchimpConfig } from './config.ts';
import { loadMatches, type FishMatches } from './matches.ts';
import { buildMailchimpPreview, type PlannedRow } from './plan.ts';
import { addHeld, addRunTask, clearClock, getPreview, heldFor, savePreview, trackedFor } from './store.ts';
import type { RegisterBook } from './register.ts';
import { nextFishSend } from './days.ts';
import { createMailchimpWorker, lastOwnSent, type MailchimpWorker, type WorkerLog } from './worker.ts';

export interface MailchimpServiceDeps {
  db: Db;
  settings: Pick<Settings, 'getSecret'>;
  /** The folder the database is in. The matches file must be inside it. */
  dataDir: string;
  now: () => number;
  log: WorkerLog;
  cfg?: MailchimpConfig;
  /** Tests: the local Mailchimp ids file to read instead of config/local/mailchimp.json. Used only without cfg. */
  localConfigPath?: string;
  /** Tests: a fake fetch, or a fake Mailchimp on 127.0.0.1. */
  fetch?: typeof fetch;
  testOrigin?: string;
  /** From the server config allowMailchimpWrites. Off: reads only, no tasks, no checks. */
  allowWrites: boolean;
  /**
   * From the server config mailchimpFromSandboxRuns. The fish email is live, so a Square sandbox
   * send never changes it unless this is set on purpose for a test. Live Square sends queue the
   * change on their own.
   */
  allowSandboxRuns?: boolean;
  /**
   * The register prices for the drift check, or undefined when this install has none it may use
   * for the live email. The app gives it only for production Square, or the sandbox with the test
   * setting.
   */
  register?: () => Promise<RegisterBook | null>;
  /** Where the register prices come from, in plain words, for the warnings. */
  registerLabel?: string;
  /** The big-change limit in percent from settings. A larger drift fix waits for a person. */
  driftPercent?: () => number;
  auto?: boolean;
}

export interface MailchimpService {
  cfg: MailchimpConfig;
  worker: MailchimpWorker;
  /** For the dry run job: reads Mailchimp (never writes) and stores what the run would change. Never throws. */
  afterDryRun(runId: number, preview: ChangePreview): Promise<void>;
  /** Called inside the transaction that records Square as done: queues the prices Square confirmed. */
  afterSquareDone(runId: number, dryRunHash: string, report: SquareReport, catalogSource: string): void;
  /** True when a send from this catalog source may change the live fish email. */
  runChangesEmail(catalogSource: string): boolean;
  /**
   * Picks up work a restart cut short, records checks missed while off, and starts the minute
   * clock. Called by the server once it is listening (src/server/main.ts), never before.
   */
  start(): void;
  stop(): Promise<void>;
}

export function matchesPath(cfg: MailchimpConfig, dataDir: string): string {
  if (isAbsolute(cfg.matchesFile)) return cfg.matchesFile;
  // "data/..." in the config is the data folder beside the database.
  return cfg.matchesFile.startsWith('data/') ? join(dataDir, cfg.matchesFile.slice('data/'.length)) : join(REPO_ROOT, cfg.matchesFile);
}

/** The prices Square confirmed, of those the dry run planned for the fish email. */
export function confirmedRows(planned: readonly PlannedRow[], report: SquareReport): PlannedRow[] {
  return planned.filter((r) => report.items.some((i) => i.variationId === r.variationId && i.price !== null && i.price.state === 'done' && i.price.toCents === r.toCents));
}

export function createMailchimpService(deps: MailchimpServiceDeps): MailchimpService {
  // A local ids file that is not right leaves Mailchimp not set up, with the reason shown, and
  // the rest of the app working.
  const loaded = deps.cfg ? { cfg: deps.cfg, problem: null } : loadMailchimpConfigForApp(deps.localConfigPath);
  const cfg = loaded.cfg;
  if (loaded.problem) deps.log.warn?.({}, 'fish email: config/local/mailchimp.json is not right, so Mailchimp counts as not set up');
  const keyOpts = { key: () => deps.settings.getSecret('mailchimpApiKey'), testOrigin: deps.testOrigin };
  // The list id in git is a placeholder: until config/local/mailchimp.json names the real list,
  // Mailchimp counts as not set up, the same as with no key.
  const notSetUp = (): string | null =>
    loaded.problem ?? (listIdMissing(cfg) ? 'The fish list id is not set. Add it to config/local/mailchimp.json and restart ShelfReady.' : setupProblem(keyOpts));
  const api = (): MailchimpApi => {
    const problem = notSetUp();
    if (problem) throw new MailchimpError('setup', problem);
    return createMailchimpClient({ ...keyOpts, fetch: deps.fetch, now: deps.now, allowWrites: deps.allowWrites });
  };
  const matches = (): FishMatches => loadMatches(matchesPath(cfg, deps.dataDir), deps.dataDir);
  const worker = createMailchimpWorker({ db: deps.db, cfg, api, now: deps.now, log: deps.log, auto: deps.auto, matches, register: deps.register, driftPercent: deps.driftPercent });
  let timer: NodeJS.Timeout | null = null;
  // A live Square send ('square_production', with allowSquareProduction on) changes the fish email
  // whenever Mailchimp writes are on. A sandbox send changes the live email only with
  // mailchimpFromSandboxRuns, set on purpose for a test (the config refuses it with live Square on).
  const sandboxOn = (source: string): boolean => deps.allowSandboxRuns === true && source === 'square_sandbox';
  const runChangesEmail = (source: string): boolean => deps.allowWrites && (source === 'square_production' || sandboxOn(source));

  return {
    cfg,
    worker,
    async afterDryRun(runId, preview) {
      try {
        const problem = notSetUp();
        const p = await buildMailchimpPreview(
          {
            cfg,
            api: problem ? null : api(),
            setupProblem: problem ?? '',
            matches,
            now: deps.now(),
            tracked: (day) => trackedFor(deps.db, day)?.campaignId ?? null,
            held: (day) => heldFor(deps.db, day, deps.now()).rows.length,
            register: deps.register,
            driftPercent: deps.driftPercent,
            source: async (a) => {
              const last = await lastOwnSent(deps.db, cfg, a, deps.now());
              if (last.problem) throw new MailchimpError('refused', last.problem);
              return last.source;
            },
          },
          preview,
        );
        if (p && deps.allowWrites && sandboxOn(preview.catalog.source)) {
          p.warning = 'Test setting on (mailchimpFromSandboxRuns): sending this Square sandbox invoice WILL change the live fish email that customers get.';
        }
        if (p && deps.allowWrites && deps.register) {
          const drift = `Drift check on (mailchimpDriftCheck): every fish email edit and check sets email prices to the register prices from ${deps.registerLabel ?? 'Square'}.`;
          p.warning = p.warning ? `${p.warning} ${drift}` : drift;
        }
        if (p && !p.problem && !runChangesEmail(preview.catalog.source)) {
          p.problem = deps.allowWrites
            ? 'This invoice is matched against the Square sandbox, so sending it does not change the live fish email. This shows what would change.'
            : 'Mailchimp changes are off in this install (allowMailchimpWrites in the server config), so the fish email will not change on send. This shows what would change.';
        }
        if (p) savePreview(deps.db, runId, preview.hash, p, deps.now());
      } catch (err) {
        deps.log.error({ runId, err: err instanceof Error ? err.name : 'unknown' }, 'mailchimp preview failed');
      }
    },
    runChangesEmail,
    afterSquareDone(runId, dryRunHash, report, catalogSource) {
      if (!runChangesEmail(catalogSource)) return;
      const p = getPreview(deps.db, runId, dryRunHash);
      if (!p) return;
      const rows = confirmedRows(p.planned, report);
      if (!rows.length) return;
      if (sandboxOn(catalogSource)) deps.log.warn?.({ runId }, 'fish email change queued from a Square sandbox send (mailchimpFromSandboxRuns)');
      // Held until they are in a fish email: the next one, or a later one if this misses the cutoff.
      const send = nextFishSend(deps.now(), cfg);
      addHeld(deps.db, runId, send.day, rows, deps.now());
      addRunTask(deps.db, runId, rows, send, deps.now());
      setImmediate(() => worker.kick());
    },
    start() {
      if (timer) return;
      worker.recover();
      // No checks while Mailchimp changes are off: each would only fail. The clock is forgotten,
      // so turning them on later raises no alerts for the time they were off.
      if (!deps.allowWrites) {
        clearClock(deps.db);
        return;
      }
      if (deps.allowSandboxRuns) deps.log.warn?.({}, 'mailchimpFromSandboxRuns is on: sending a Square sandbox invoice changes the live fish email');
      if (deps.register) deps.log.warn?.({}, `mailchimpDriftCheck is on: fish email edits and checks set live email prices to the register prices from ${deps.registerLabel ?? 'Square'}`);
      worker.catchUp();
      if (deps.auto === false) return;
      worker.tick();
      timer = setInterval(() => worker.tick(), 60_000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await worker.stop();
    },
  };
}
