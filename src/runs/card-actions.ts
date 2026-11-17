// What a person does to a run's cards in review: confirm or reject a stored card that may be the
// product, edit card text, mark a written card checked, ask for copy now, leave a card out of
// the run, and (an admin) approve the cost of copy over the cap.
//
// Each one is checked here, on the server, against a fresh evaluation of this run: the product
// must be one this run updates, and the card must be the one this run shows for it (or one of the
// stored cards it suggests). An id from another run, or any other card, is refused. Every action
// is written to the audit log with the run id; the card store adds its own history.

import type { AuditActor } from '../db/audit.ts';
import { appendAudit } from '../db/audit.ts';
import { inTransaction } from '../db/db.ts';
import { checkContent, guardProblems } from '../copy/checks.ts';
import { confirmSuggestion, rejectSuggestion } from '../copy/lookup.ts';
import { checkContentShape, editCard, markCardChecked } from '../copy/store.ts';
import { cleanText } from '../copy/text.ts';
import { CopyError, type CardContent } from '../copy/types.ts';
import type { ActionDeps } from './actions.ts';
import { copyApprovalBatch, LIMIT_FIELDS, runCopyConfig, runCopySettings, type RunCard } from './card-copy.ts';
import { approveCopyBatch, requestCopy } from './copy-store.ts';
import type { Evaluation } from './evaluate.ts';
import { evaluateRun, settleRun } from './runner.ts';
import { DECIDING } from './states.ts';
import { activeJob, addEvent, clearDecision, enqueueJob, mustGetRun, RunError, setDecision, type RunRow } from './store.ts';

interface Open {
  run: RunRow;
  ev: Evaluation;
}

function open(deps: ActionDeps, runId: number): Open {
  const run = mustGetRun(deps.db, runId);
  if (!DECIDING.has(run.state)) throw new RunError('This invoice cannot be changed now.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on. Wait a moment and reload.', 409);
  return { run, ev: evaluateRun(deps, run) };
}

/** The run's card for a product it updates. Anything else is refused. */
function cardOf(o: Open, variationId: string): RunCard {
  const c = o.ev.cards.find((x) => x.variationId === variationId);
  if (!c) throw new RunError('That item has no card on this invoice.', 400);
  return c;
}

/** The stored card this run shows for the product, by the id and version the page showed. */
function shownCard(c: RunCard, cardId: string, version: string) {
  if (!c.card || String(c.card.id) !== cardId) throw new RunError('That card is not the one this invoice shows for the item. Reload the page.', 400);
  if (String(c.card.version) !== version) throw new RunError('Someone changed this card since the page was shown. Look at it again.', 409);
  return c.card;
}

function asRunError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CopyError) throw new RunError(err.message, 400);
    throw err;
  }
}

function settled(deps: ActionDeps, runId: number, actor: AuditActor): Evaluation {
  return settleRun(deps, runId, actor);
}

function catalogOf(deps: ActionDeps, run: RunRow) {
  const c = deps.catalogs.get(run.catalogSnapshotId!);
  return { index: c.index, source: c.snapshot.source };
}

/** A person says a stored card is this product. It is linked, replacing any card the product had. */
export function confirmCard(deps: ActionDeps, runId: number, actor: AuditActor, variationId: string, cardId: string): Evaluation {
  const o = open(deps, runId);
  const c = cardOf(o, variationId);
  const s = c.suggestions.find((x) => String(x.cardId) === cardId);
  if (!s) throw new RunError('That stored card is not one this invoice suggests for the item.', 400);
  inTransaction(deps.db, () => {
    asRunError(() => confirmSuggestion(deps.db, actor, catalogOf(deps, o.run), s.cardId, variationId, deps.now()));
    appendAudit(deps.db, actor, { action: 'run.card.confirm', entityType: 'run', entityId: runId, runId, details: { variationId, cardId: s.cardId } }, deps.now());
  });
  return settled(deps, runId, actor);
}

/** A person says a stored card is another product. It is not suggested for this item again. */
export function rejectCard(deps: ActionDeps, runId: number, actor: AuditActor, variationId: string, cardId: string): Evaluation {
  const o = open(deps, runId);
  const c = cardOf(o, variationId);
  const s = c.suggestions.find((x) => String(x.cardId) === cardId);
  if (!s) throw new RunError('That stored card is not one this invoice suggests for the item.', 400);
  inTransaction(deps.db, () => {
    asRunError(() => rejectSuggestion(deps.db, actor, catalogOf(deps, o.run), s.cardId, variationId, deps.now()));
    appendAudit(deps.db, actor, { action: 'run.card.reject', entityType: 'run', entityId: runId, runId, details: { variationId, cardId: s.cardId } }, deps.now());
  });
  return settled(deps, runId, actor);
}

/** The card text fields a form sends. Paragraphs left empty are dropped. */
export interface CardEditInput {
  origin: string;
  eyebrow: string;
  n1: string;
  n2: string;
  producer: string;
  specs: Array<[string, string]>;
  paragraphs: string[];
  unit: string;
}

/** Longest text a form field may carry, before cleaning. The card store's own limits apply after. */
const MAX_INPUT = 2000;

/**
 * The edit as card text: every field cleaned as generated text is (src/copy/text.ts cleanText),
 * capitals where the cards print capitals, the category one the config has.
 */
export function editedContent(current: CardContent, input: CardEditInput, categoryWords: readonly string[]): CardContent {
  const t = (v: string, label: string) => {
    if (typeof v !== 'string' || v.length > MAX_INPUT) throw new RunError(`${label} is too long.`, 400);
    return cleanText(v);
  };
  let eyebrow = t(input.eyebrow, 'The category').toUpperCase();
  // The category is picked from the config. The card's own text may stay as it is.
  if (eyebrow !== current.eyebrow.toUpperCase() && !categoryWords.includes(eyebrow)) throw new RunError('Pick a category from the list.', 400);
  if (eyebrow === current.eyebrow.toUpperCase()) eyebrow = current.eyebrow;
  if (input.specs.length !== 3) throw new RunError('A card needs exactly three specs.', 400);
  const n1 = t(input.n1, 'The first part of the name');
  const next: CardContent = {
    origin: t(input.origin, 'The origin').toUpperCase(),
    eyebrow,
    n1: n1 === '' ? '' : `${n1} `,
    n2: t(input.n2, 'The second part of the name'),
    producer: t(input.producer, 'The producer'),
    specs: input.specs.map(([l, v], i) => [t(l, `Spec ${i + 1} label`).toUpperCase(), t(v, `Spec ${i + 1} value`)]) as CardContent['specs'],
    copy: input.paragraphs.map((p, i) => t(p, `Paragraph ${i + 1}`)).filter((p) => p !== ''),
    unit: t(input.unit, 'The unit').toUpperCase(),
  };
  return asRunError(() => checkContentShape(next));
}

/**
 * A person's edit of the card this run shows. Checked before it is saved:
 * - the guard: a money amount, phone number or web address is refused (a card prints its own price);
 * - the limits: an edit may not break a limit the card kept before. A card that was already out
 *   of a limit may be saved on the way to fixing it; a written card stays blocked until it fits.
 * The card store keeps the edit from now on, until the next edit (decision 5), and an edit of a
 * written card needs a new check.
 */
export function editRunCard(deps: ActionDeps, runId: number, actor: AuditActor, variationId: string, cardId: string, version: string, input: CardEditInput): Evaluation {
  const o = open(deps, runId);
  const c = cardOf(o, variationId);
  const card = shownCard(c, cardId, version);
  const conf = runCopyConfig();
  if ('error' in conf) throw new RunError(conf.error, 409);
  const cfg = conf.cfg;
  const next = editedContent(card.content, input, cfg.categories.map((x) => x.word));
  const guard = guardProblems(next);
  if (guard.length) throw new RunError(`Not saved. ${guard.map((g) => g.message).join(' ')}`, 400);
  const limits = (content: CardContent) => checkContent(content, cfg.limits, { flagPhrases: cfg.guide.flagPhrases, soldByWeight: c.soldByWeight }).filter((p) => LIMIT_FIELDS.has(p.field));
  const had = new Set(limits(card.content).map((p) => p.field));
  const added = limits(next).filter((p) => !had.has(p.field));
  if (added.length) throw new RunError(`Not saved. ${added.map((p) => p.message).join(' ')}`, 400);
  inTransaction(deps.db, () => {
    const saved = asRunError(() => editCard(deps.db, actor, card.id, card.version, next, deps.now()));
    if (saved.version !== card.version) {
      appendAudit(deps.db, actor, { action: 'run.card.edit', entityType: 'run', entityId: runId, runId, details: { variationId, cardId: card.id, version: saved.version } }, deps.now());
      addEvent(deps.db, runId, 'card_copy', `${actor.username} edited the card for ${c.label}.`, deps.now());
    }
  });
  return settled(deps, runId, actor);
}

/** A person has checked this version of a card the model wrote. Only a signed-in person can. */
export function checkRunCard(deps: ActionDeps, runId: number, actor: AuditActor, variationId: string, cardId: string, version: string, confirmed: boolean): Evaluation {
  if (actor.userId === null) throw new RunError('Only a person can check a card.', 403);
  if (!confirmed) throw new RunError('Tick the box to confirm you checked every item on the list against the sources and the package.', 400);
  const o = open(deps, runId);
  const c = cardOf(o, variationId);
  const card = shownCard(c, cardId, version);
  if (!c.needsCheck) throw new RunError('This card needs no check.', 400);
  inTransaction(deps.db, () => {
    asRunError(() => markCardChecked(deps.db, actor, card.id, card.version, deps.now()));
    appendAudit(deps.db, actor, { action: 'run.card.check', entityType: 'run', entityId: runId, runId, details: { variationId, cardId: card.id, version: card.version } }, deps.now());
    addEvent(deps.db, runId, 'card_copy', `${actor.username} checked the card for ${c.label}.`, deps.now());
  });
  return settled(deps, runId, actor);
}

/**
 * Asks for new copy for one product, or for every product with none ('all'). The background job
 * writes it under the cost cap; over the cap it waits for an admin.
 */
export function writeCardCopy(deps: ActionDeps, runId: number, actor: AuditActor & { userId: number }, variationId: string | 'all'): void {
  const o = open(deps, runId);
  const targets = variationId === 'all' ? o.ev.cards.filter((c) => c.canWrite && !c.leftOut) : [cardOf(o, variationId)];
  if (targets.length === 0) throw new RunError('No card needs copy written now.', 400);
  for (const c of targets) if (!c.canWrite) throw new RunError(c.arrivalUnclear ? 'Say what arrived first.' : 'This card has copy, or copy for it is already queued.', 400);
  inTransaction(deps.db, () => {
    for (const c of targets) requestCopy(deps.db, actor, runId, c.variationId, deps.now());
    addEvent(deps.db, runId, 'card_copy', `${actor.username} asked for card copy for ${targets.length === 1 ? targets[0]!.label : `${targets.length} items`}.`, deps.now());
    enqueueJob(deps.db, runId, 'process', actor.userId, deps.now());
  });
}

/** Leaves a product's card out of this run, or puts it back. A card left out does not print and blocks nothing. */
export function leaveCardOut(deps: ActionDeps, runId: number, actor: AuditActor, variationId: string, leaveOut: boolean): Evaluation {
  const o = open(deps, runId);
  const c = cardOf(o, variationId);
  if (leaveOut) setDecision(deps.db, actor, runId, 'card_skip', variationId, { label: c.label }, deps.now());
  else clearDecision(deps.db, actor, runId, 'card_skip', variationId, deps.now());
  return settled(deps, runId, actor);
}

/**
 * An admin approves every card still waiting for a cost approval, in one action (DECISIONS.md,
 * Card copy budget). Tied to the model, the total and the list of cards stored with the run; the
 * browser only repeats them. The route needs the admin role and a recent password. The
 * background job then writes each card under its own approved amount, past the invoice's copy
 * budget and the daily limit for those cards only.
 */
export function approveCardCosts(deps: ActionDeps, runId: number, actor: AuditActor & { userId: number }, shown: { model: string; totalUsd: string; fingerprint: string }): void {
  const o = open(deps, runId);
  const batch = copyApprovalBatch(o.ev.cards);
  inTransaction(deps.db, () => {
    approveCopyBatch(deps.db, actor, runId, batch, shown, runCopySettings(deps.settings).model, deps.now());
    const n = batch!.cards.length;
    addEvent(deps.db, runId, 'approval', `${actor.username} approved up to $${shown.totalUsd} with ${shown.model} for ${n === 1 ? 'one card' : `${n} cards`}.`, deps.now());
    enqueueJob(deps.db, runId, 'process', actor.userId, deps.now());
  });
}
