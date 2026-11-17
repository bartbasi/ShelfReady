// Everything a person does to a run: decisions in review, reading again, approving the cost,
// the dry run and approval. Each one is checked again here, on the server, against the run's own
// saved catalog and a fresh evaluation, and written to the audit log with the run id. Nothing the
// browser sends is trusted beyond the choice itself: line numbers, ids and prices must be ones
// this run offered.

import type { AuditActor } from '../db/audit.ts';
import { appendAudit } from '../db/audit.ts';
import { inTransaction } from '../db/db.ts';
import type { CheckId } from '../invoice/types.ts';
import { confirmMapping, lineKeys, lookupMapping, MappingError, removeMapping, restoreMapping, snapshotMapping, type MappingSnapshot } from '../matching/mapping.ts';
import { addSupplierAlias, createSupplier, findSupplier, getSupplier, SupplierError, supplierKey } from '../matching/suppliers.ts';
import { normalizeInvoiceNumber } from '../invoice/checks.ts';
import { splitTrailingCode } from '../lib/scale-code.ts';
import { POUNDS_PER_UNIT, savePack, UNITS_PER_CASE } from './packs.ts';
import type { DecisionChoice } from '../pricing/overrides.ts';
import type { RunCatalog } from './catalog-cache.ts';
import { usableVariation, type Evaluation, type LineEval } from './evaluate.ts';
import { buildPreview, renamedItem, type ChangePreview } from './preview.ts';
import { evaluateRun, settleRun, type RunnerDeps } from './runner.ts';
import { DECIDING } from './states.ts';
import { recordRunInHistory } from '../history/runs.ts';
import {
  activeJob,
  addCorrection,
  addEvent,
  clearDecision,
  DECISION_KINDS,
  enqueueJob,
  mustGetRun,
  runDecisions,
  RunError,
  setDecision,
  setState,
  updateRun,
  type DecisionKind,
  type RunRow,
} from './store.ts';

export type ActionDeps = Pick<RunnerDeps, 'db' | 'settings' | 'catalogs' | 'now' | 'scaleNames' | 'bigChangePercent'> & {
  /** Words for where a run's catalog came from, for its recorded source ("Square (live)"). Part of the dry run's hash. */
  catalogLabelFor: (source: string) => string;
  /** Why a run read in this source may not go on now (another Square environment), or null. */
  sourceProblem?: (source: string) => string | null;
};

interface Open {
  run: RunRow;
  ev: Evaluation;
  catalog: RunCatalog;
}

/** A run open for decisions: in review, ready or dry run done, with no job running. */
function openForDecisions(deps: ActionDeps, runId: number): Open {
  const run = mustGetRun(deps.db, runId);
  if (!DECIDING.has(run.state)) throw new RunError('This invoice cannot be changed now.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is still being worked on. Wait a moment and reload.', 409);
  const ev = evaluateRun(deps, run);
  return { run, ev, catalog: deps.catalogs.get(run.catalogSnapshotId!) };
}

function lineOf(o: Open, n: number): LineEval {
  const l = o.ev.lines.find((x) => x.n === n);
  if (!l) throw new RunError('There is no such line on this invoice.', 404);
  return l;
}

function knownSupplierId(o: Open): number {
  if (o.ev.supplier?.status !== 'known') throw new RunError('Choose the supplier first, so the match can be saved for next time.', 409);
  return o.ev.supplier.supplier.id;
}

/**
 * The saved match this line had before this run first changed it, so an undo can put it back.
 * Null means there was none. Kept from the first pick or mark, however many follow.
 */
function previousMatch(deps: ActionDeps, runId: number, supplierId: number, l: LineEval): MappingSnapshot | null {
  const earlier = runDecisions(deps.db, runId).find((d) => (d.kind === 'pick' || d.kind === 'not_for_resale') && d.target === String(l.n) && 'previous' in d.value);
  if (earlier) return (earlier.value.previous ?? null) as MappingSnapshot | null;
  const p = l.line.line;
  const keys = lineKeys({ itemNumber: p.item_number, upc: p.upc, description: p.description, brand: p.brand });
  const m = keys ? lookupMapping(deps.db, supplierId, keys).exact : null;
  return m ? snapshotMapping(deps.db, m.id) : null;
}

function done(deps: ActionDeps, runId: number, actor: AuditActor): Evaluation {
  return settleRun(deps, runId, actor);
}

/** Leaves a line out of this run, or puts it back. */
export function skipLine(deps: ActionDeps, runId: number, actor: AuditActor, n: number, skip: boolean): Evaluation {
  const o = openForDecisions(deps, runId);
  lineOf(o, n);
  if (skip) setDecision(deps.db, actor, runId, 'skip_line', String(n), {}, deps.now());
  else clearDecision(deps.db, actor, runId, 'skip_line', String(n), deps.now());
  return done(deps, runId, actor);
}

/**
 * Picks the Square item for a line. It must be offered at the store in this run's catalog. The
 * pick is saved to the mapping with the line's wording and brand, so it matches on its own next time.
 */
export function pickItem(deps: ActionDeps, runId: number, actor: AuditActor, n: number, variationId: string): Evaluation {
  const o = openForDecisions(deps, runId);
  const l = lineOf(o, n);
  const supplierId = knownSupplierId(o);
  const v = usableVariation(o.catalog, variationId);
  if (!v) throw new RunError('That Square item is not in this run\'s catalog, or it is archived or not offered at this store.', 400);
  inTransaction(deps.db, () => {
    const previous = previousMatch(deps, runId, supplierId, l);
    try {
      confirmMapping(
        deps.db,
        actor,
        { supplierId, line: { itemNumber: l.line.line.item_number, upc: l.line.line.upc, description: l.line.line.description, brand: l.line.line.brand }, target: { kind: 'square', variationId: v.id }, catalog: o.catalog.index },
        deps.now(),
      );
    } catch (err) {
      if (err instanceof MappingError) throw new RunError(err.message, 400);
      throw err;
    }
    setDecision(deps.db, actor, runId, 'pick', String(n), { variationId: v.id, label: v.label, previous }, deps.now());
    clearDecision(deps.db, actor, runId, 'not_for_resale', String(n), deps.now());
    clearDecision(deps.db, actor, runId, 'skip_line', String(n), deps.now());
  });
  return done(deps, runId, actor);
}

/** Marks a line's supplier item as not for resale (kitchen supplies), for this run and next time. */
export function markNotForResale(deps: ActionDeps, runId: number, actor: AuditActor, n: number, confirmed: boolean): Evaluation {
  if (!confirmed) throw new RunError('Tick the box to confirm the store never sells this item. It is skipped on every invoice from this supplier after that.', 400);
  const o = openForDecisions(deps, runId);
  const l = lineOf(o, n);
  const supplierId = knownSupplierId(o);
  inTransaction(deps.db, () => {
    const previous = previousMatch(deps, runId, supplierId, l);
    try {
      confirmMapping(
        deps.db,
        actor,
        { supplierId, line: { itemNumber: l.line.line.item_number, upc: l.line.line.upc, description: l.line.line.description, brand: l.line.line.brand }, target: { kind: 'not_for_resale' }, catalog: o.catalog.index },
        deps.now(),
      );
    } catch (err) {
      if (err instanceof MappingError) throw new RunError(err.message, 400);
      throw err;
    }
    setDecision(deps.db, actor, runId, 'not_for_resale', String(n), { previous }, deps.now());
    clearDecision(deps.db, actor, runId, 'pick', String(n), deps.now());
    clearDecision(deps.db, actor, runId, 'skip_line', String(n), deps.now());
  });
  return done(deps, runId, actor);
}

const POUNDS = /^\d{1,5}(\.\d{1,3})?$/;
const PIECES = /^[1-9][0-9]{0,5}$/;

/**
 * What arrived on a line: all, none, or some. Some is pieces for packaged goods and pounds for
 * by-weight goods, never one for the other.
 */
export function setArrived(deps: ActionDeps, runId: number, actor: AuditActor, n: number, arrived: string, pieces: string, pounds: string): Evaluation {
  const o = openForDecisions(deps, runId);
  const l = lineOf(o, n);
  if (arrived === 'all' || arrived === 'none') {
    setDecision(deps.db, actor, runId, 'received', String(n), { arrived }, deps.now());
  } else if (arrived === 'some') {
    // Matched lines are counted the way the item is sold. Others the way the invoice sells them.
    const byWeight = l.variationId !== null ? l.byWeight : l.line.basis === 'weight' || l.line.pack.pricePer === 'lb';
    if (byWeight) {
      const q = pounds.trim();
      if (!POUNDS.test(q) || Number(q) <= 0) throw new RunError('This is sold by weight: enter the pounds that arrived, like 4.25.', 400);
      setDecision(deps.db, actor, runId, 'received', String(n), { arrived, pounds: q }, deps.now());
    } else {
      const q = pieces.trim();
      if (!PIECES.test(q)) throw new RunError('This is sold by the piece: enter the whole number of pieces that arrived.', 400);
      setDecision(deps.db, actor, runId, 'received', String(n), { arrived, pieces: q }, deps.now());
    }
  } else {
    throw new RunError('Choose all, none or some.', 400);
  }
  return done(deps, runId, actor);
}

/**
 * A case size or the weight of one unit, for a line whose invoice leaves it out. Saved with the
 * line's match, so the next invoice uses it too. A line matched without a saved match gets one.
 */
export function setPack(deps: ActionDeps, runId: number, actor: AuditActor, n: number, input: { unitsPerCase: string; poundsPerUnit: string }): Evaluation {
  const o = openForDecisions(deps, runId);
  const l = lineOf(o, n);
  const supplierId = knownSupplierId(o);
  if (!l.variationId || !l.packNeed) throw new RunError('This line does not need a case size or a unit weight.', 400);
  let value: { unitsPerCase: number } | { poundsPerUnit: string };
  if (l.packNeed === 'units_per_case') {
    const u = input.unitsPerCase.trim();
    if (!UNITS_PER_CASE.test(u)) throw new RunError('Enter the units per case as a whole number above zero, like 12.', 400);
    value = { unitsPerCase: Number(u) };
  } else {
    const w = input.poundsPerUnit.trim();
    if (!POUNDS_PER_UNIT.test(w) || Number(w) <= 0) throw new RunError('Enter the weight of one unit in pounds, above zero, like 0.5.', 400);
    value = { poundsPerUnit: w };
  }
  inTransaction(deps.db, () => {
    const p = l.line.line;
    const identity = { itemNumber: p.item_number, upc: p.upc, description: p.description, brand: p.brand };
    const keys = lineKeys(identity);
    if (!keys) throw new RunError('This line has no item number, UPC or description to save the case size under.', 400);
    let mapping = lookupMapping(deps.db, supplierId, keys).exact;
    if (!mapping || mapping.kind !== 'square' || mapping.variationId !== l.variationId) {
      try {
        mapping = confirmMapping(deps.db, actor, { supplierId, line: identity, target: { kind: 'square', variationId: l.variationId! }, catalog: o.catalog.index }, deps.now());
      } catch (err) {
        if (err instanceof MappingError) throw new RunError(err.message, 400);
        throw err;
      }
    }
    savePack(deps.db, actor, mapping.id, l.variationId!, value, deps.now(), runId);
  });
  return done(deps, runId, actor);
}

/** The tick for a price moving more than the limit, tied to the two prices shown. */
export function acceptBigChange(deps: ActionDeps, runId: number, actor: AuditActor, variationId: string, shownFrom: string, shownTo: string): Evaluation {
  const o = openForDecisions(deps, runId);
  const l = o.ev.lines.find((x) => x.variationId === variationId && x.bigChange !== null);
  if (!l || !l.bigChange) throw new RunError('That item has no big price change to confirm.', 400);
  if (String(l.bigChange.fromCents) !== shownFrom || String(l.bigChange.toCents) !== shownTo) throw new RunError('The prices changed since the page was shown. Look at them again.', 409);
  setDecision(deps.db, actor, runId, 'accept_big_change', variationId, { fromCents: l.bigChange.fromCents, toCents: l.bigChange.toCents, percent: l.bigChange.percent }, deps.now());
  return done(deps, runId, actor);
}

/** Dollars typed by a person, as whole cents above zero. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, '');
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
  const [d, c = ''] = t.split('.');
  const cents = Number(d) * 100 + Number(c.padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

const CHOICES: ReadonlySet<string> = new Set(['keep_override', 'use_formula', 'enter_price']);

/**
 * The answer to a cost increase check. Tied to the formula and override prices the person saw:
 * if either has changed since the page was shown, nothing is saved and the page shows the new ones.
 */
export function decideOverride(
  deps: ActionDeps,
  runId: number,
  actor: AuditActor,
  input: { variationId: string; choice: string; price: string; shownFormulaCents: string; shownOverrideCents: string },
): Evaluation {
  const o = openForDecisions(deps, runId);
  if (!CHOICES.has(input.choice)) throw new RunError('Choose keep the override, use the formula price, or enter a price.', 400);
  const line = o.ev.lines.find((l) => l.variationId === input.variationId && l.priced && (l.priced.override.kind === 'needs_decision' || l.priced.override.kind === 'decided'));
  const state = line?.priced?.override;
  if (!state || (state.kind !== 'needs_decision' && state.kind !== 'decided')) throw new RunError('That item has no price question to answer.', 400);
  if (String(state.formulaCents) !== input.shownFormulaCents || String(state.overrideCents) !== input.shownOverrideCents) {
    throw new RunError('The prices changed since the page was shown. Look at them again and choose.', 409);
  }
  let enteredCents: number | null = null;
  if (input.choice === 'enter_price') {
    enteredCents = parseDollars(input.price);
    if (enteredCents === null) throw new RunError('Enter a price like 12.99.', 400);
  }
  setDecision(
    deps.db,
    actor,
    runId,
    'override',
    input.variationId,
    { choice: input.choice as DecisionChoice, enteredCents, formulaCents: state.formulaCents, overrideCents: state.overrideCents },
    deps.now(),
  );
  return done(deps, runId, actor);
}

/** One price for an item that two lines priced differently. Must be one of the prices shown. */
export function pickConflictPrice(deps: ActionDeps, runId: number, actor: AuditActor, variationId: string, priceCents: string): Evaluation {
  const o = openForDecisions(deps, runId);
  const shown = o.ev.conflictPrices.get(variationId);
  if (!shown) throw new RunError('That item has no price conflict to settle.', 400);
  const c = Number(priceCents);
  if (!/^\d{1,9}$/.test(priceCents) || !shown.includes(c)) throw new RunError('Pick one of the prices shown.', 400);
  setDecision(deps.db, actor, runId, 'conflict', variationId, { priceCents: c, shownCents: shown }, deps.now());
  return done(deps, runId, actor);
}

const NAME_CHARS = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]{1,200}$/u;

/**
 * A new store name for an item, sent to Square on approval. The item's scale code stays at the
 * end of the name. Only items this run will update can be renamed here.
 */
export function renameItem(deps: ActionDeps, runId: number, actor: AuditActor, itemId: string, name: string): Evaluation {
  const o = openForDecisions(deps, runId);
  const line = o.ev.lines.find((l) => l.itemId === itemId && l.outcome === 'send');
  if (!line) throw new RunError('Only items this invoice updates can be renamed here.', 400);
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!NAME_CHARS.test(clean)) throw new RunError('Enter a name of 1 to 200 plain characters.', 400);
  // Four digits at the end of a name read as a scale code, so an item without one cannot end that way.
  if (!line.scaleCode && splitTrailingCode(clean).trailing !== null) {
    throw new RunError('A name ending in four digits reads as a scale code, and this item has none. Change the end of the name.', 400);
  }
  const full = renamedItem(line.itemName, line.scaleCode, clean);
  if (full === line.itemName) {
    clearDecision(deps.db, actor, runId, 'rename', itemId, deps.now());
  } else {
    setDecision(deps.db, actor, runId, 'rename', itemId, { name: clean, from: line.itemName, to: full }, deps.now());
  }
  return done(deps, runId, actor);
}

/** Accepts a failed check a person has checked against the paper invoice. Only some checks allow it. */
export function acceptCheck(deps: ActionDeps, runId: number, actor: AuditActor, checkId: string): Evaluation {
  const o = openForDecisions(deps, runId);
  const c = o.ev.failedChecks.find((f) => f.id === checkId);
  if (!c || !c.acceptable) throw new RunError('That check cannot be accepted by hand.', 400);
  setDecision(deps.db, actor, runId, 'accept_check', checkId as CheckId, { message: c.message }, deps.now());
  return done(deps, runId, actor);
}

/** Takes back one decision. */
export function undoDecision(deps: ActionDeps, runId: number, actor: AuditActor, kind: string, target: string): Evaluation {
  const o = openForDecisions(deps, runId);
  if (!(DECISION_KINDS as readonly string[]).includes(kind) || target.length > 100) throw new RunError('There is no such decision.', 400);
  const d = runDecisions(deps.db, runId).find((x) => x.kind === kind && x.target === target);
  if (!d) throw new RunError('There is no such decision.', 400);
  inTransaction(deps.db, () => {
    clearDecision(deps.db, actor, runId, kind as DecisionKind, target, deps.now());
    // A pick or a not-for-resale mark was also saved as the line's match. Undo puts back the match
    // the line had before (its target, wordings and pack), or forgets it when there was none.
    if ((kind === 'pick' || kind === 'not_for_resale') && d.value.previous) {
      try {
        restoreMapping(deps.db, actor, d.value.previous as MappingSnapshot, deps.now());
      } catch (err) {
        if (err instanceof MappingError) throw new RunError(err.message, 409);
        throw err;
      }
    } else if ((kind === 'pick' || kind === 'not_for_resale') && o.ev.supplier?.status === 'known') {
      const l = o.ev.lines.find((x) => String(x.n) === target);
      const p = l?.line.line;
      const keys = p ? lineKeys({ itemNumber: p.item_number, upc: p.upc, description: p.description, brand: p.brand }) : null;
      const m = keys ? lookupMapping(deps.db, o.ev.supplier.supplier.id, keys).exact : null;
      const same = m && (kind === 'pick' ? m.kind === 'square' && m.variationId === d.value.variationId : m.kind === 'not_for_resale');
      if (m && same) removeMapping(deps.db, actor, m.id, deps.now());
    }
  });
  return done(deps, runId, actor);
}

/** Joins the printed supplier name to a supplier ShelfReady knows, or adds it as a new supplier. */
export function chooseSupplier(deps: ActionDeps, runId: number, actor: AuditActor, choice: { supplierId: number } | { create: true }): Evaluation {
  const o = openForDecisions(deps, runId);
  if (o.ev.supplier?.status !== 'unknown') throw new RunError('This supplier is already known.', 409);
  const printed = o.ev.supplier.printedName;
  try {
    if ('create' in choice) {
      const s = createSupplier(deps.db, actor, printed, deps.now());
      appendAudit(deps.db, actor, { action: 'run.supplier_new', entityType: 'supplier', entityId: s.id, runId, details: { printedName: printed } }, deps.now());
      addEvent(deps.db, runId, 'supplier', `${actor.username} added ${s.name} as a new supplier.`, deps.now());
    } else {
      const s = getSupplier(deps.db, choice.supplierId);
      if (!s) throw new RunError('That supplier does not exist.', 400);
      addSupplierAlias(deps.db, actor, s.id, printed, deps.now());
      appendAudit(deps.db, actor, { action: 'run.supplier_join', entityType: 'supplier', entityId: s.id, runId, details: { printedName: printed } }, deps.now());
      addEvent(deps.db, runId, 'supplier', `${actor.username} joined "${printed}" to ${s.name}.`, deps.now());
    }
  } catch (err) {
    if (err instanceof SupplierError) throw new RunError(err.message, 400);
    throw err;
  }
  return done(deps, runId, actor);
}

/** Line decisions are keyed by line number, which a new reading can change, so they go with it. */
const LINE_KINDS: readonly DecisionKind[] = ['skip_line', 'pick', 'not_for_resale', 'received', 'accept_check'];

/** Reads the invoice again: after a retry, or after both readings failed their checks. */
export function readAgain(deps: ActionDeps, runId: number, actor: AuditActor & { userId: number }): void {
  const run = mustGetRun(deps.db, runId);
  const allowed = run.state === 'retry' || (run.state === 'review' && (run.readStatus === 'review' || run.readStatus === ''));
  if (!allowed) throw new RunError('This invoice cannot be read again now.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is already being worked on.', 409);
  // A good reading already saved (the work stopped after it) is not paid for again: only the
  // matching and pricing run again.
  if (run.state === 'retry' && (run.readStatus === 'ok' || run.readStatus === 'review')) {
    appendAudit(deps.db, actor, { action: 'run.try_again', entityType: 'run', entityId: runId, runId }, deps.now());
    addEvent(deps.db, runId, 'review', `${actor.username} asked to try again with the saved reading.`, deps.now());
    enqueueJob(deps.db, runId, 'process', actor.userId, deps.now());
    return;
  }
  inTransaction(deps.db, () => {
    for (const d of runDecisions(deps.db, runId)) if (LINE_KINDS.includes(d.kind)) clearDecision(deps.db, actor, runId, d.kind, d.target, deps.now());
    updateRun(deps.db, runId, { readStatus: '', readResult: null, pendingApproval: null, approvalModel: '', approvalEstimateUsd: '', evaluation: null, blockers: 0 }, deps.now());
    // The rejected reading leaves the purchase history until the new one is saved.
    recordRunInHistory(deps.db, runId, deps.now());
    appendAudit(deps.db, actor, { action: 'run.read_again', entityType: 'run', entityId: runId, runId }, deps.now());
    addEvent(deps.db, runId, 'reading', `${actor.username} asked to read the invoice again.`, deps.now());
    enqueueJob(deps.db, runId, 'process', actor.userId, deps.now());
  });
}

/**
 * An admin approves the cost of a reading stopped at the cap. The approval is tied to the model
 * and the worst-case estimate stored with the run; the browser only confirms them. The reading
 * then resumes from the server's own copy (src/invoice/pipeline.ts checks it again).
 */
export function approveCost(deps: ActionDeps, runId: number, actor: AuditActor & { userId: number }, shown: { model: string; estimateUsd: string }): void {
  const run = mustGetRun(deps.db, runId);
  if (run.state !== 'needs_approval' || !run.pendingApproval) throw new RunError('This invoice is not waiting for a cost approval.', 409);
  if (shown.model !== run.approvalModel || shown.estimateUsd !== run.approvalEstimateUsd) {
    throw new RunError('The cost to approve changed since the page was shown. Look at it again.', 409);
  }
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is already being worked on.', 409);
  inTransaction(deps.db, () => {
    updateRun(deps.db, runId, { costApprovedBy: actor.userId, costApprovedByName: actor.username, costApprovedAt: deps.now() }, deps.now());
    appendAudit(deps.db, actor, { action: 'run.cost_approved', entityType: 'run', entityId: runId, runId, details: { model: run.approvalModel, estimateUsd: run.approvalEstimateUsd } }, deps.now());
    addEvent(deps.db, runId, 'approval', `${actor.username} approved up to $${run.approvalEstimateUsd} with ${run.approvalModel}.`, deps.now());
    enqueueJob(deps.db, runId, 'process', actor.userId, deps.now(), { resumeApproved: true });
  });
}

/** Asks for a dry run. Only when nothing blocks. */
export function requestDryRun(deps: ActionDeps, runId: number, actor: AuditActor & { userId: number }): void {
  const o = openForDecisions(deps, runId);
  if (o.run.state !== 'ready' && o.run.state !== 'dry_run_done') throw new RunError('Settle everything in review before a dry run.', 409);
  if (o.ev.blockers.length > 0) {
    settleRun(deps, runId, actor);
    throw new RunError('Something still needs a person before a dry run.', 409);
  }
  enqueueJob(deps.db, runId, 'dry_run', actor.userId, deps.now());
  appendAudit(deps.db, actor, { action: 'run.dry_run_requested', entityType: 'run', entityId: runId, runId }, deps.now());
  addEvent(deps.db, runId, 'dry_run', `${actor.username} asked for a dry run.`, deps.now());
}

/** Every reason approval is refused right now, in plain words. Empty means it may be approved. */
export function approvalProblems(deps: ActionDeps, run: RunRow, postedHash: string | null): string[] {
  const out: string[] = [];
  if (run.state !== 'dry_run_done') out.push(run.state === 'approved' ? 'This invoice is already approved.' : 'Make a dry run first. Approval needs the dry run that shows every change.');
  if (activeJob(deps.db, run.id)) out.push('This invoice is still being worked on.');
  if (run.catalogSnapshotId === null || !run.dryRun) return out.length ? out : ['There is no dry run to approve.'];
  const ev = evaluateRun(deps, run);
  for (const b of ev.blockers) out.push(b.message);
  const twin = sameInvoiceApproved(deps, run, ev);
  if (twin !== null) out.push(`Invoice ${twin} from the same supplier with the same invoice number is already approved. Approving this one would add the stock twice.`);
  if (postedHash !== null && postedHash !== run.dryRunHash) out.push('The dry run changed since the page was shown. Look at it again.');
  const mixed = deps.sourceProblem?.(deps.catalogs.get(run.catalogSnapshotId).snapshot.source) ?? null;
  if (mixed) out.push(mixed);
  if (ev.blockers.length === 0 && run.state === 'dry_run_done') {
    const stored = run.dryRun as ChangePreview;
    const counts = new Map(stored.square.filter((s) => s.stock?.from).map((s) => [s.variationId, s.stock!.from!]));
    const again = buildPreview({
      runId: run.id,
      evaluation: ev,
      catalog: deps.catalogs.get(run.catalogSnapshotId),
      catalogLabel: deps.catalogLabelFor(deps.catalogs.get(run.catalogSnapshotId).snapshot.source),
      decisions: runDecisions(deps.db, run.id),
      counts,
      scaleNames: deps.scaleNames,
      now: deps.now(),
    });
    if (again.hash !== run.dryRunHash) out.push('Something changed since the dry run (a setting, a price override or a saved match). Make the dry run again.');
  }
  return out;
}

/** Approves the exact preview the person saw. Sending it is src/runs/square-send.ts. */
export function approveRun(deps: ActionDeps, runId: number, actor: AuditActor & { userId: number }, postedHash: string): void {
  inTransaction(deps.db, () => {
    const run = mustGetRun(deps.db, runId);
    const problems = approvalProblems(deps, run, postedHash);
    if (problems.length) throw new RunError(`Not approved. ${problems[0]}`, 409);
    setState(deps.db, runId, 'approved', {
      now: deps.now(),
      actor,
      message: `Approved by ${actor.username}. Press Send to send it to Square, then the scales.`,
      fields: { approvedBy: actor.userId, approvedByName: actor.username, approvedAt: deps.now() },
    });
    appendAudit(deps.db, actor, { action: 'run.approve', entityType: 'run', entityId: runId, runId, details: { previewHash: run.dryRunHash } }, deps.now());
    addEvent(deps.db, runId, 'approval', `${actor.username} approved the dry run.`, deps.now());
  });
}

/** Stops a run that will not be sent. Allowed before approval. */
export function stopRun(deps: ActionDeps, runId: number, actor: AuditActor): void {
  const run = mustGetRun(deps.db, runId);
  if (['approved', 'sending', 'done', 'partial', 'failed'].includes(run.state)) throw new RunError('This invoice cannot be stopped now.', 409);
  if (activeJob(deps.db, runId)) throw new RunError('This invoice is being worked on. Wait for it to finish, then stop it.', 409);
  setState(deps.db, runId, 'failed', { now: deps.now(), actor, message: `Stopped by ${actor.username}. Nothing was sent.` });
}

/** Another approved run of the same supplier and invoice number, or null. */
export function sameInvoiceApproved(deps: Pick<ActionDeps, 'db'>, run: RunRow, ev: Evaluation): number | null {
  const read = run.readResult as { reading?: { invoice?: { invoice_number?: string; supplier_name?: string } } } | null;
  const number = normalizeInvoiceNumber(String(read?.reading?.invoice?.invoice_number ?? ''));
  if (!number) return null;
  const mine = ev.supplier?.status === 'known' ? ev.supplier.supplier.id : null;
  const myKey = supplierKey(String(read?.reading?.invoice?.supplier_name ?? ''));
  const rows = deps.db
    .prepare(
      `SELECT id, coalesce(json_extract(read_result, '$.reading.invoice.invoice_number'), '') AS num,
         coalesce(json_extract(read_result, '$.reading.invoice.supplier_name'), '') AS supplier
       FROM runs WHERE id <> ? AND state IN ('approved', 'sending', 'done', 'partial')`,
    )
    .all(run.id) as Array<{ id: number; num: string; supplier: string }>;
  for (const r of rows) {
    if (normalizeInvoiceNumber(String(r.num)) !== number) continue;
    const theirs = findSupplier(deps.db, String(r.supplier));
    if ((mine !== null && theirs?.id === mine) || supplierKey(String(r.supplier)) === myKey) return r.id;
  }
  return null;
}

/**
 * After approval: a line found not to have arrived. Records the stock to take back out of Square
 * and the credit to claim, with who and when. If the run has not been sent yet, the send folds it
 * into the stock count instead (and sends nothing at all for an item where nothing arrived);
 * otherwise the send takes the stock back out (src/runs/square-send.ts).
 */
export function markNotArrived(deps: ActionDeps, runId: number, actor: AuditActor, n: number, confirmed: boolean): void {
  if (!confirmed) throw new RunError('Tick the box to confirm this line did not arrive.', 400);
  const run = mustGetRun(deps.db, runId);
  if (!['approved', 'sending', 'done', 'partial'].includes(run.state)) throw new RunError('Only an approved invoice is corrected this way. Before approval, set What arrived on the line.', 409);
  const preview = run.dryRun as ChangePreview | null;
  const read = run.readResult as { reading?: { lines?: Array<{ n: number; extensionCents: number | null }> } } | null;
  const line = read?.reading?.lines?.find((l) => l.n === n);
  if (!preview || !line) throw new RunError('There is no such line on this invoice.', 404);
  const change = preview.square.find((c) => c.lines.includes(n));
  const stock = change?.lineStock.find((x) => x.n === n) ?? null;
  const credited = preview.credits.find((c) => c.n === n)?.cents ?? 0;
  const ext = line.extensionCents ?? 0;
  const credit = Math.max(0, ext - credited);
  if (!stock && credit === 0) throw new RunError('Nothing arrived on that line already, so there is nothing to correct.', 409);
  addCorrection(
    deps.db,
    actor,
    runId,
    { line: n, variationId: change?.variationId ?? '', stockTakeBack: stock?.stock ?? '', stockUnit: stock ? (change!.stock?.unit ?? 'unit') : '', creditCents: credit },
    deps.now(),
  );
}
