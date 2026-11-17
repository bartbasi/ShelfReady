// Card copy in an invoice run (Phase 1 step 5 wired into step 6).
//
// Two parts:
// - The stage (createCardCopyStage), run by the background job after the reading and before
//   matching settles. It looks up stored copy for every product the run updates and writes new
//   copy where there is none (src/copy/run.ts copyForRun), one product at a time, under the cost
//   budget. Before each paid call it records "calling" (src/runs/copy-store.ts) and books the
//   call's worst case, so a restart never sends that call again on its own and never undercounts:
//   a person asks again, as for a reading. Products are written on their own in one first pass
//   per run; after that a job writes only what a person asked for or an admin approved.
// - The card list (cardsForRun), worked out with every evaluation. For each product the run
//   updates: which card prints and why it cannot yet. A card that needs a person's check, is
//   blocked by the guard, is out of limits, cannot print for this item, or has no copy, blocks
//   the run, unless a person leaves the card out of this run. Lines where nothing arrived make
//   no card at all (DECISIONS.md, What arrived).
//
// The budget (DECISIONS.md, Card copy budget): card copy has its own budget per invoice
// (cardCopyCapUsd, $5 by default), apart from the reading's cap. Every copy call of the run counts
// against it, at its worst case while under way (src/runs/spend.ts). The daily limit still covers
// readings and copy together, and copy never gets more than it has left. A card that does not fit
// waits; one admin approval covers every card still waiting, whichever limit ran out.

import type { CardRecord } from '../cards/types.ts';
import { SYSTEM_ACTOR } from '../db/audit.ts';
import type { Db } from '../db/db.ts';
import { checkContent, fullName } from '../copy/checks.ts';
import { createAnthropicCopyClient, type CopyModelClient } from '../copy/client.ts';
import { printableCard } from '../copy/card.ts';
import { loadCopyConfig, type CopyConfig } from '../copy/config.ts';
import type { RenderCheck } from '../copy/generate.ts';
import { lookupCopy, type CopyLookup } from '../copy/lookup.ts';
import { copyForRun, invoiceFactsFromLine, type CopyPlan, type RunCopyItem } from '../copy/run.ts';
import { copySettingsFrom, type CopySettings } from '../copy/settings.ts';
import { cardBlockers } from '../copy/store.ts';
import { CopyError, type CardSource, type StoredCard, type VerifyItem } from '../copy/types.ts';
import { apiKeyProblem, createInvoiceAnthropicClient, ModelCallError } from '../invoice/extract.ts';
import type { Settings } from '../settings/store.ts';
import type { RunCatalog } from './catalog-cache.ts';
import { approvalBatch, interruptCalls, markCalling, recordCopyRefusal, recordCopyResult, runCopyRows, type CopyApprovalBatch, type RunCopyRow } from './copy-store.ts';
import type { Blocker, Evaluation, LineEval } from './evaluate.ts';
import { bookCutShort, raiseReservation, reserveSpend, runSpend, settleSpend, spendSince } from './spend.ts';
import { addEvent, mustGetRun, updateRun, type Decision, type RunRow } from './store.ts';

// ---- The card copy config ----

let loaded: { cfg: CopyConfig } | { error: string } | null = null;

/** The store's copy rules (config/cards/<store>.json), read once. */
export function runCopyConfig(): { cfg: CopyConfig } | { error: string } {
  if (!loaded) {
    try {
      loaded = { cfg: loadCopyConfig() };
    } catch {
      loaded = { error: 'The card config could not be read, so no card can print. Tell Bart.' };
    }
  }
  return loaded;
}

/**
 * Copy settings from the admin's saved settings: the first-pass model, and the card copy budget
 * per invoice (cardCopyCapUsd), which is also the most one card may cost.
 */
export function runCopySettings(settings: Pick<Settings, 'getSetting'>, extra: Partial<CopySettings> = {}): CopySettings {
  return copySettingsFrom({ anthropicFirstPassModel: settings.getSetting('anthropicFirstPassModel'), invoiceCostCapUsd: settings.getSetting('cardCopyCapUsd') }, extra);
}

// ---- The card list ----

/** Problem kinds that are limits: out of them, a written card cannot print until edited. */
export const LIMIT_FIELDS: ReadonlySet<string> = new Set(['copy', 'name', 'producer', 'spec', 'unit', 'origin']);

export interface CardSuggestionView {
  cardId: number;
  name: string;
  producer: string;
  unit: string;
  source: CardSource;
  firstParagraph: string;
  reasons: string[];
}

export interface RunCard {
  variationId: string;
  label: string;
  /** The run's lines for this product. */
  lines: number[];
  /** A person left this card out of the run. */
  leftOut: boolean;
  /** Where the card's text comes from now, or none when there is no card yet. */
  source: CardSource | 'none';
  card: StoredCard | null;
  via: CopyLookup['via'];
  /** A sure link found now, saved when the run is sent (step 7). */
  pendingLink: boolean;
  suggestions: CardSuggestionView[];
  /** The card as it will print, with the price and code from pricing and Square. Null when it cannot. */
  record: CardRecord | null;
  priceCents: number | null;
  scaleCode: string | null;
  soldByWeight: boolean;
  /** Why the card cannot print yet. Empty when it prints as shown. */
  waitingFor: string[];
  /** Limits a written card still breaks. */
  limitProblems: string[];
  /** Style notes on a written card. They do not block. */
  styleNotes: string[];
  /** What a person checks before printing: generated cards only. */
  checkList: VerifyItem[];
  needsCheck: boolean;
  /** Where the product's new copy stands in this run, if anything was asked or written. */
  copy: RunCopyRow | null;
  /** True when what arrived is not settled for any of its lines. */
  arrivalUnclear: boolean;
  /** A person may ask for copy now: no card, nothing queued or under way. */
  canWrite: boolean;
}

function decided(decisions: readonly Decision[], kind: string, target: string): boolean {
  return decisions.some((d) => d.kind === kind && d.target === target);
}

function suggestionView(s: CopyLookup['suggestions'][number]): CardSuggestionView {
  return {
    cardId: s.card.id,
    name: fullName(s.card.content),
    producer: s.card.content.producer,
    unit: s.card.content.unit,
    source: s.card.source,
    firstParagraph: s.card.content.copy[0] ?? '',
    reasons: s.reasons,
  };
}

const WRITABLE: ReadonlySet<string> = new Set(['failed', 'interrupted', 'needs_approval']);

function noCopyReason(row: RunCopyRow | null): string[] {
  if (!row) return ['No copy yet. Write it now, or leave the card out of this run.'];
  switch (row.state) {
    case 'requested':
    case 'approved':
      return ['Copy is queued to be written.'];
    case 'calling':
      return ['Copy is being written now.'];
    case 'needs_approval':
      return [`Writing it could cost up to $${row.approvalUsd} with ${row.approvalModel}, more than the cap has left. An admin must approve that amount, or leave the card out of this run.`];
    case 'interrupted':
      return row.reasons.length ? row.reasons : ['ShelfReady restarted while writing this card. Press Write copy now to try once more.'];
    case 'failed':
      return [...row.reasons.slice(0, 3), 'Write it again, or leave the card out of this run.'];
    default:
      return ['No copy yet. Write it now, or leave the card out of this run.'];
  }
}

/**
 * Every card the run would print, one per product it updates, with why each cannot print yet.
 * Reads only: nothing is linked, written or called.
 */
export function cardsForRun(db: Db, runId: number, catalog: RunCatalog, ev: Evaluation, decisions: readonly Decision[]): RunCard[] {
  const conf = runCopyConfig();
  const rows = runCopyRows(db, runId);
  const groups = new Map<string, LineEval[]>();
  for (const l of ev.lines) {
    if (l.outcome !== 'send' || !l.variationId) continue;
    groups.set(l.variationId, [...(groups.get(l.variationId) ?? []), l]);
  }
  const out: RunCard[] = [];
  for (const [variationId, ls] of groups) {
    const first = ls[0]!;
    const priced = ls.map((l) => l.priced).find((p) => p && p.newCents !== null) ?? first.priced;
    const priceCents = priced?.newCents ?? priced?.squareCents ?? null;
    const arrivalUnclear = ls.every((l) => l.arrival.arrived === 'unclear');
    const row = rows.get(variationId) ?? null;
    const card: RunCard = {
      variationId,
      label: first.label,
      lines: ls.map((l) => l.n),
      leftOut: decided(decisions, 'card_skip', variationId),
      source: 'none',
      card: null,
      via: null,
      pendingLink: false,
      suggestions: [],
      record: null,
      priceCents,
      scaleCode: first.scaleCode,
      soldByWeight: first.byWeight,
      waitingFor: [],
      limitProblems: [],
      styleNotes: [],
      checkList: [],
      needsCheck: false,
      copy: row,
      arrivalUnclear,
      canWrite: false,
    };
    out.push(card);
    if ('error' in conf) {
      card.waitingFor.push(conf.error);
      continue;
    }
    const cfg = conf.cfg;
    let lookup: CopyLookup;
    try {
      lookup = lookupCopy(db, { index: catalog.index, source: catalog.snapshot.source }, variationId);
    } catch (err) {
      if (!(err instanceof CopyError)) throw err;
      card.waitingFor.push(err.message);
      continue;
    }
    card.via = lookup.via;
    card.pendingLink = lookup.pendingLink !== null;
    card.suggestions = lookup.suggestions.map(suggestionView);
    if (lookup.next === 'confirm') card.waitingFor.push('A stored card may be this product. Confirm it, or say it is another product.');
    const stored = lookup.card;
    if (!stored) {
      card.canWrite = lookup.next === 'generate' && !arrivalUnclear && (!row || WRITABLE.has(row.state) || row.state === 'written' || row.state === 'review');
      if (lookup.next === 'generate') card.waitingFor.push(...(arrivalUnclear ? ['What arrived is not settled, so no copy is written yet.'] : noCopyReason(row)));
      continue;
    }
    card.card = stored;
    card.source = stored.source;
    card.needsCheck = stored.firstSource === 'generated' && stored.checkedVersion !== stored.version;
    card.checkList = stored.review?.verify ?? [];
    card.waitingFor.push(...cardBlockers(stored));
    // Limits hold for copy the model wrote, whoever edited it since. Imported copy and a person's
    // edits of it are judged by the rendered checks only (store/docs/CARDS.md, Copy limits).
    if (stored.firstSource === 'generated') {
      const found = checkContent(stored.content, cfg.limits, { flagPhrases: cfg.guide.flagPhrases, soldByWeight: first.byWeight });
      card.limitProblems = found.filter((p) => LIMIT_FIELDS.has(p.field)).map((p) => p.message);
      card.styleNotes = found.filter((p) => p.field === 'style').map((p) => p.message);
      if (card.limitProblems.length) card.waitingFor.push(`Out of limits: ${card.limitProblems.join(' ')}`);
    }
    if (priceCents !== null && priceCents > 0) {
      try {
        card.record = printableCard(stored.content, { priceCents, scaleCode: first.scaleCode, soldByWeight: first.byWeight }, cfg.categories);
      } catch (err) {
        if (!(err instanceof CopyError)) throw err;
        card.waitingFor.push(err.message);
      }
    }
  }
  return out;
}

/** The cards still waiting for a cost approval, as the one batch an admin approves. Null when none waits. */
export function copyApprovalBatch(cards: readonly RunCard[]): CopyApprovalBatch | null {
  return approvalBatch(cards.filter((c) => !c.leftOut && !c.card && c.copy?.state === 'needs_approval').map((c) => c.copy!));
}

/** The blockers the card list adds to an evaluation. A card left out blocks nothing. */
export function cardBlockersFor(cards: readonly RunCard[]): Blocker[] {
  return cards
    .filter((c) => !c.leftOut && c.waitingFor.length > 0)
    .map((c) => ({ id: 'card_copy' as const, line: c.lines[0], variationId: c.variationId, message: `Card for ${c.label}: ${c.waitingFor.join(' ')}` }));
}

// ---- The stage ----

export interface CardCopyResult {
  status: 'done' | 'needs_review' | 'skipped';
  /** Plain words for the progress page. */
  message: string;
}

export interface CardCopyContext {
  db: Db;
  settings: Settings;
  catalogs: { get(snapshotId: number): RunCatalog };
  now: () => number;
  /** Most all readings and copy together may cost in any 24 hours, in US dollars. */
  dailyCapUsd: number;
  /** The run's evaluation now, without the card list (the runner's evaluate). */
  evaluate: (run: RunRow) => Evaluation;
}

export type CardCopyStage = (input: { runId: number }, ctx: CardCopyContext) => Promise<CardCopyResult>;

export interface CardCopyStageOptions {
  /** The copy model client. Default: the Claude API with the key in settings, built only when a card is written. */
  client?: () => CopyModelClient;
  /** The copy rules. Default: the store's card config. */
  config?: () => CopyConfig;
  /** Extra copy settings, for tests. */
  settings?: Partial<CopySettings>;
  /** The rendered check (src/copy/render-check.ts). Off by default: the sheet check runs in step 8. */
  renderCheck?: RenderCheck | null;
}

/** The client from the key in settings. Throws ModelCallError with words safe to show. */
function settingsClient(settings: Settings): CopyModelClient {
  let key: string | undefined;
  try {
    key = settings.getSecret('anthropicApiKey');
  } catch {
    throw new ModelCallError('authentication', 'The Claude API key in settings is damaged. An admin must enter it again.', null, null);
  }
  const problem = apiKeyProblem(key);
  if (problem) throw new ModelCallError('authentication', `${problem} An admin must set it in settings.`, null, null);
  return createAnthropicCopyClient(createInvoiceAnthropicClient(key!));
}

/** A client built on first use, so a run with nothing to write never needs the key. */
function lazyClient(build: () => CopyModelClient): CopyModelClient {
  let real: CopyModelClient | null = null;
  const get = () => (real ??= build());
  return {
    countTokens: (req) => get().countTokens(req),
    call: (req) => get().call(req),
  };
}

export interface CopyBudget {
  /** What copy may still spend now, in US dollars. */
  usd: number;
  /** Which limit is the lower one now: the invoice's copy budget, or the daily limit. */
  binding: 'invoice' | 'daily';
  spentUsd: number;
  capUsd: number;
  dailyLeftUsd: number;
  text: string;
}

/**
 * What the run may still spend on copy now (DECISIONS.md, Card copy budget): the copy budget
 * per invoice, less every copy call this run made (booked, or reserved at its worst case), and
 * never more than the daily limit has left after all readings and copy in the last 24 hours.
 */
export function copyBudget(db: Db, runId: number, capUsd: number, dailyCapUsd: number, now: number): CopyBudget {
  const spentUsd = runSpend(db, runId, 'copy');
  const runLeft = capUsd - spentUsd;
  const dailyLeftUsd = dailyCapUsd - spendSince(db, now - 24 * 3600_000);
  const binding = dailyLeftUsd < runLeft ? 'daily' : 'invoice';
  const usd = Math.max(0, Math.min(runLeft, dailyLeftUsd));
  const text =
    binding === 'daily'
      ? `The daily limit of $${dailyCapUsd.toFixed(2)} for readings and card copy together has $${Math.max(0, dailyLeftUsd).toFixed(2)} left, less than this invoice's card copy budget.`
      : `This invoice's card copy budget of $${capUsd.toFixed(2)} has $${Math.max(0, runLeft).toFixed(2)} left ($${spentUsd.toFixed(2)} spent).`;
  return { usd, binding, spentUsd, capUsd, dailyLeftUsd, text };
}

export function createCardCopyStage(opts: CardCopyStageOptions = {}): CardCopyStage {
  return async ({ runId }, ctx) => {
    const { db, now } = ctx;
    // A call still marked under way was cut short by a restart: never sent again on its own, and
    // its worst case stays counted.
    bookCutShort(db, now(), { runId, kind: 'copy' });
    const cut = interruptCalls(db, runId, now());
    if (cut) addEvent(db, runId, 'card_copy', `${cut} card ${cut === 1 ? 'call was' : 'calls were'} cut short by a restart and not sent again. Press Write copy now to try once more.`, now());
    const run = mustGetRun(db, runId);
    if (run.catalogSnapshotId === null || !run.readResult) return { status: 'skipped', message: 'Card copy: nothing to look up yet.' };
    let config: CopyConfig;
    let settings: CopySettings;
    try {
      const c = opts.config ? { cfg: opts.config() } : runCopyConfig();
      if ('error' in c) throw new CopyError(c.error);
      config = c.cfg;
      settings = runCopySettings(ctx.settings, opts.settings);
    } catch (err) {
      return { status: 'needs_review', message: `Card copy was not looked up: ${err instanceof CopyError ? err.message : 'the copy settings are not usable. An admin must check them.'}` };
    }
    const ev = ctx.evaluate(run);
    const decisions = db.prepare("SELECT target FROM run_decisions WHERE run_id = ? AND kind = 'card_skip'").all(runId) as Array<{ target: string }>;
    const leftOut = new Set(decisions.map((d) => d.target));
    const supplier = ev.supplier?.status === 'known' ? ev.supplier.supplier.name : ev.supplier?.status === 'unknown' ? ev.supplier.printedName : '';
    const items: RunCopyItem[] = ev.lines
      .filter((l) => l.outcome === 'send' && l.variationId && !leftOut.has(l.variationId))
      .map((l) => ({ variationId: l.variationId!, invoice: invoiceFactsFromLine(l.line.line, supplier), arrived: l.arrival.arrived }));
    if (items.length === 0) return { status: 'done', message: 'Card copy: no products to look up yet.' };

    const rows = runCopyRows(db, runId);
    // The automatic first pass runs once per run. After it, a job writes only the products a
    // person asked for, or whose cost an admin approved.
    const auto = !run.copyAutoDone;
    // With no cards stored at all, the existing cards were not imported yet: writing copy on its
    // own would pay for products that already have a printed card. Only a person's request goes.
    const storeEmpty = (db.prepare('SELECT count(*) AS n FROM cards WHERE retired_at IS NULL').get() as { n: number }).n === 0;
    if (storeEmpty && auto) addEvent(db, runId, 'card_copy', 'No cards are stored yet, so no copy is written on its own. Import the existing cards first (scripts/cards/import-reference.ts, then scripts/copy/import-cards.ts), or press Write copy now on a card.', now());
    const plan = (variationId: string): CopyPlan => {
      const row = rows.get(variationId);
      if (!row) return auto && !storeEmpty ? 'auto' : 'skip';
      if (row.state === 'requested') return 'auto';
      if (row.state === 'approved') return { approval: { model: row.approvalModel, approvedUsd: Number(row.approvalUsd), approvedBy: row.approvedByName } };
      return 'skip';
    };
    const budget = copyBudget(db, runId, settings.costCapUsd, ctx.dailyCapUsd, now());
    const catalog = ctx.catalogs.get(run.catalogSnapshotId);
    const reserved = new Map<string, number>();
    const outcome = await copyForRun(
      {
        db,
        client: lazyClient(opts.client ?? (() => settingsClient(ctx.settings))),
        settings,
        config,
        actor: SYSTEM_ACTOR,
        now,
        renderCheck: opts.renderCheck ?? null,
      },
      { index: catalog.index, source: catalog.snapshot.source },
      items,
      {
        totalCapUsd: budget.usd,
        generate: true,
        plan,
        onStart: (p) => {
          markCalling(db, runId, p.variationId, now());
          addEvent(db, runId, 'card_copy', `Writing card copy for ${p.label} with ${settings.model}.`, now());
        },
        onReserve: (p, usd) => {
          const id = reserved.get(p.variationId);
          if (id === undefined) reserved.set(p.variationId, reserveSpend(db, { runId, kind: 'copy', variationId: p.variationId, usd }, now()));
          else raiseReservation(db, id, usd, now());
        },
        onDone: (p, r) => {
          // The worst case booked before the call is replaced by the cost the API reported.
          const id = reserved.get(p.variationId);
          if (id !== undefined) settleSpend(db, id, r.costUsd, now());
          else if (r.costUsd > 0) settleSpend(db, reserveSpend(db, { runId, kind: 'copy', variationId: p.variationId, usd: r.costUsd }, now()), r.costUsd, now());
          reserved.delete(p.variationId);
          if (r.status === 'failed' && r.attempts.length === 0) recordCopyRefusal(db, runId, p.variationId, r.reasons, now());
          else recordCopyResult(db, SYSTEM_ACTOR, runId, p.variationId, r, now());
          if (r.status === 'needs_approval') addEvent(db, runId, 'card_copy', `${p.label}: ${r.reasons[0] ?? 'over the cap.'} ${budget.text}`, now());
        },
      },
    );
    if (auto) updateRun(db, runId, { copyAutoDone: 1 }, now());
    return { status: outcome.status, message: outcome.message };
  };
}

/** The stage the runner uses when none is given: the Claude API with the key in settings. */
export const cardCopyStage: CardCopyStage = createCardCopyStage();
