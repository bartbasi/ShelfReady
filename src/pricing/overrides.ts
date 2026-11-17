// Price overrides and the cost increase check (brief, "Price overrides").
//
// An override is a price set by a person that sticks to a Square item: later invoices keep it
// instead of the formula price. Review shows both, so an override is easy to spot and remove.
//
// Cost increase check: when a new invoice makes the formula price higher than the override,
// the line needs a decision. The manager keeps the override, switches to the formula price, or
// enters a different price. Nothing is sent for that item until she picks.
//
// A decision is tied to the two prices she saw. If either changes before the run is sent (a new
// cost, a formula change, or someone changing the override), the old decision no longer
// applies and she is asked again, told which one changed.
//
// Storage is the next step's job: OverrideStore is the interface it implements.

/** A sticky price for one Square item variation. */
export interface PriceOverride {
  variationId: string;
  priceCents: number;
  /** User id of whoever set it, for the review screen and the log. */
  setBy: string;
  /** ISO time it was set. */
  setAt: string;
  /** Why, in the person's own words. Optional. */
  note: string;
}

/** Where overrides live. Implemented with the database in the next step. */
export interface OverrideStore {
  get(variationId: string): PriceOverride | null;
}

/** An in-memory store, for tests and scripts. */
export function memoryOverrideStore(list: readonly PriceOverride[] = []): OverrideStore {
  const map = new Map(list.map((o) => [o.variationId, o]));
  return { get: (id) => map.get(id) ?? null };
}

/** Why an earlier decision does not apply and she is asked again. */
export type AskAgain = 'formula_changed' | 'override_changed' | 'bad_price';

export type DecisionChoice = 'keep_override' | 'use_formula' | 'enter_price';

/** The manager's answer to a cost increase check, for one item in one run. */
export interface OverrideDecision {
  variationId: string;
  choice: DecisionChoice;
  /** The price she typed, for enter_price. */
  enteredCents: number | null;
  /** The formula price she was shown when she chose. */
  formulaCents: number;
  /** The override price she was shown when she chose. */
  overrideCents: number;
  decidedBy: string;
}

/** What should happen to the stored override once the run is sent. */
export type OverrideAction =
  | { kind: 'none' }
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'set'; priceCents: number };

export type OverrideState =
  /** No override: the formula price is used. */
  | { kind: 'none' }
  /** An override at or above the formula price: it is used, and both are shown. */
  | { kind: 'override'; overrideCents: number; formulaCents: number }
  /** The formula price went above the override. Nothing is sent until someone picks. */
  | { kind: 'needs_decision'; overrideCents: number; formulaCents: number; askAgain: AskAgain | null }
  /** A decision was made on this run. */
  | { kind: 'decided'; overrideCents: number; formulaCents: number; choice: DecisionChoice }
  /** There is an override, but no formula price to check it against. Nothing is sent. */
  | { kind: 'unchecked'; overrideCents: number };

export interface OverrideOutcome {
  state: OverrideState;
  /** The price to send, or null when nothing is sent for this item. */
  sendCents: number | null;
  action: OverrideAction;
}

function validCents(c: number | null | undefined): c is number {
  return typeof c === 'number' && Number.isSafeInteger(c) && c > 0;
}

/**
 * Applies the override rules to one item.
 * formulaCents is null when no formula price could be worked out.
 */
export function resolveOverride(formulaCents: number | null, override: PriceOverride | null, decision: OverrideDecision | null): OverrideOutcome {
  if (!override) {
    return { state: { kind: 'none' }, sendCents: formulaCents, action: { kind: 'none' } };
  }
  const overrideCents = override.priceCents;
  if (formulaCents === null) {
    return { state: { kind: 'unchecked', overrideCents }, sendCents: null, action: { kind: 'keep' } };
  }
  if (formulaCents <= overrideCents) {
    return { state: { kind: 'override', overrideCents, formulaCents }, sendCents: overrideCents, action: { kind: 'keep' } };
  }
  const pending = (askAgain: AskAgain | null): OverrideOutcome => ({
    state: { kind: 'needs_decision', overrideCents, formulaCents, askAgain },
    sendCents: null,
    action: { kind: 'keep' },
  });
  if (decision === null || decision.variationId !== override.variationId) return pending(null);
  if (decision.overrideCents !== overrideCents) return pending('override_changed');
  if (decision.formulaCents !== formulaCents) return pending('formula_changed');
  const decided = { kind: 'decided' as const, overrideCents, formulaCents, choice: decision.choice };
  switch (decision.choice) {
    case 'keep_override':
      return { state: decided, sendCents: overrideCents, action: { kind: 'keep' } };
    case 'use_formula':
      return { state: decided, sendCents: formulaCents, action: { kind: 'remove' } };
    case 'enter_price':
      if (!validCents(decision.enteredCents)) return pending('bad_price');
      return { state: decided, sendCents: decision.enteredCents, action: { kind: 'set', priceCents: decision.enteredCents } };
  }
}
