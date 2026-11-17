// Prices one invoice line: cost basis, formula, rounding, override, and flags for review.
// Plain code, exact arithmetic, no model and no network. The caller passes what Square says
// today; this module never reads or writes Square.

import type { PricingSettings } from '../settings/schema.ts';
import { costBasis, DEFAULT_ALLOWANCE_BASIS, type AllowanceBasis, type BasisInput, type CostBasis, type SaleMode } from './basis.ts';
import { chooseFormula, formulaCents, formulaValue, type ChosenFormula } from './formula.ts';
import { resolveOverride, type AskAgain, type OverrideAction, type OverrideDecision, type OverrideState, type OverrideStore } from './overrides.ts';
import { toDecimalText } from './rational.ts';

/** What Square says about the matched item variation today. */
export interface SquareItemState {
  variationId: string;
  /** The current fixed price in cents. Null when there is none (for example, priced at the register). */
  priceCents: number | null;
  pricingType: 'FIXED_PRICING' | 'VARIABLE_PRICING';
  /** The variation uses the per-pound measurement unit. */
  perPound: boolean;
  /** The 4-digit scale code at the end of the item name, or null. */
  scaleCode: string | null;
}

export type PriceFlagId =
  | 'price_unclear'
  | 'needs_decision'
  | 'price_drop'
  | 'big_jump'
  | 'not_sold_by_weight'
  | 'no_current_price'
  | 'allowance'
  | 'conflict';

export interface PriceFlag {
  id: PriceFlagId;
  /** Plain words for the review screen. */
  message: string;
}

/** 'conflict': another line maps to the same variation with a different price. Nothing is sent until someone picks. */
export type PriceStatus = 'priced' | 'needs_decision' | 'no_price' | 'conflict';

export interface PricedLine {
  /** The line's number in the reading. */
  n: number;
  status: PriceStatus;
  /** The matched Square variation, or null when the line is not matched. */
  variationId: string | null;
  /** The item's scale code, when it has one. */
  scaleCode: string | null;
  cost: CostBasis;
  formula: ChosenFormula;
  /** The formula's exact result before rounding, as text. Null when there is no cost. */
  formulaValueText: string | null;
  /** The formula price in cents, after rounding. Null when there is no cost. */
  formulaCents: number | null;
  override: OverrideState;
  /** What to do with the stored override once the run is sent. */
  overrideAction: OverrideAction;
  /** The price to send to Square, the scales and the card. Null means nothing is sent. */
  newCents: number | null;
  /** Square's price today, as passed in. */
  squareCents: number | null;
  /** newCents minus squareCents, when both are known. */
  changeCents: number | null;
  /**
   * The item has a scale code but Square does not sell it by the pound at a fixed price. The
   * Square update must switch it to sold by weight, per pound, at newCents, in the same run.
   */
  switchToWeight: boolean;
  flags: PriceFlag[];
  /** Why there is no price, in plain words. Null when there is one. */
  reason: string | null;
}

export interface PriceLineInput {
  n: number;
  basis: BasisInput;
  /** The matched Square item, or null when the line is not matched yet. */
  square: SquareItemState | null;
  /** The vendor as named in settings, once the supplier is linked to one. Null for the default formula. */
  vendor: string | null;
}

export interface PricingContext {
  settings: PricingSettings;
  overrides: OverrideStore;
  /** Decisions made in review on this run, at most one per variation. */
  decisions: readonly OverrideDecision[];
  allowanceBasis?: AllowanceBasis;
  /** Prices picked in review for variations that two or more lines disagree on. */
  conflictPicks?: readonly ConflictPick[];
}

/**
 * The manager's pick when two or more lines map to one variation with different prices. Tied to
 * the prices she was shown, so a pick made on other prices is asked again.
 */
export interface ConflictPick {
  variationId: string;
  priceCents: number;
  /** The different prices she was shown, in any order. */
  shownCents: readonly number[];
  decidedBy: string;
}

/** How Square sells an item, from its state. */
export function saleModeOf(square: SquareItemState | null): SaleMode {
  if (!square) return 'unknown';
  return square.scaleCode !== null || square.perPound ? 'weight' : 'unit';
}

/** True when Square already sells the item the way a scale item must be sold: fixed price, per pound. */
export function soldByWeightInSquare(square: SquareItemState): boolean {
  return square.pricingType === 'FIXED_PRICING' && square.perPound;
}

const ASK_AGAIN: Record<AskAgain, string> = {
  formula_changed: 'The formula price changed since the last choice, so it is asked again.',
  override_changed: 'The override changed since the last choice, so it is asked again.',
  bad_price: 'The price entered could not be used. Enter a price above zero.',
};

function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** A price drop, or a rise over 50%, against Square's price today. */
function movementFlags(candidate: number | null, squareCents: number | null): PriceFlag[] {
  if (candidate === null || squareCents === null) return [];
  if (candidate < squareCents) return [{ id: 'price_drop', message: `Price goes down from ${dollars(squareCents)} to ${dollars(candidate)}.` }];
  if (candidate * 2 > squareCents * 3) {
    return [{ id: 'big_jump', message: `Price goes up more than 50%, from ${dollars(squareCents)} to ${dollars(candidate)}.` }];
  }
  return [];
}

function safeCents(c: bigint): number | null {
  return c <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(c) : null;
}

export function priceLine(input: PriceLineInput, ctx: PricingContext): PricedLine {
  const allowanceBasis = ctx.allowanceBasis ?? DEFAULT_ALLOWANCE_BASIS;
  const formula = chooseFormula(ctx.settings, input.vendor);
  const square = input.square;
  const flags: PriceFlag[] = [];
  let reason: string | null = null;

  const cost = costBasis(input.basis, saleModeOf(square), allowanceBasis);
  let fCents: number | null = null;
  let valueText: string | null = null;
  if (cost.ok) {
    const value = formulaValue(formula.formula, cost.cost);
    valueText = toDecimalText(value, 4).text;
    fCents = safeCents(formulaCents(formula.formula, cost.cost));
    if (fCents === null) reason = 'The price works out too large to use. Check the cost.';
  } else {
    reason = cost.reason;
  }
  if (cost.ok && cost.allowancePrinted) {
    const a = toDecimalText(cost.allowancePrinted, 4).text;
    flags.push({
      id: 'allowance',
      message: cost.allowanceUsed
        ? `A ${a} allowance is on this line. This price uses the cost after it, as asked.`
        : `A ${a} allowance is on this line. The price uses the regular cost before it.`,
    });
  }

  const override = square ? ctx.overrides.get(square.variationId) : null;
  const decision = square ? (ctx.decisions.find((d) => d.variationId === square.variationId) ?? null) : null;
  const outcome = resolveOverride(fCents, override, decision);
  const newCents = outcome.sendCents;

  if (outcome.state.kind === 'needs_decision') {
    const s = outcome.state;
    flags.push({
      id: 'needs_decision',
      message:
        `The formula price ${dollars(s.formulaCents)} is now above the override ${dollars(s.overrideCents)}. ` +
        'Keep the override, use the formula price, or enter a price. Nothing is sent for this item until one is picked.' +
        (s.askAgain ? ` ${ASK_AGAIN[s.askAgain]}` : ''),
    });
  }
  if (reason) {
    const extra = outcome.state.kind === 'unchecked' ? ` The override of ${dollars(outcome.state.overrideCents)} could not be checked against the formula, so nothing is sent.` : '';
    flags.unshift({ id: 'price_unclear', message: reason + extra });
  }

  const squareCents = square && square.priceCents !== null && square.priceCents > 0 ? square.priceCents : null;
  if (square && squareCents === null) {
    flags.push({ id: 'no_current_price', message: 'Square has no fixed price for this item today.' });
  }

  // Compare the price that would go out, or for a pending decision the formula price.
  flags.push(...movementFlags(newCents ?? (outcome.state.kind === 'needs_decision' ? fCents : null), squareCents));

  let switchToWeight = false;
  if (square && square.scaleCode !== null && !soldByWeightInSquare(square)) {
    switchToWeight = true;
    flags.push({
      id: 'not_sold_by_weight',
      message: `Scale code ${square.scaleCode}, but Square does not sell it by the pound at a fixed price. It must be switched to sold by weight at the new price in the same run.`,
    });
  }

  const status: PriceStatus = outcome.state.kind === 'needs_decision' ? 'needs_decision' : newCents === null ? 'no_price' : 'priced';
  return {
    n: input.n,
    variationId: square ? square.variationId : null,
    scaleCode: square ? square.scaleCode : null,
    status,
    cost,
    formula,
    formulaValueText: valueText,
    formulaCents: fCents,
    override: outcome.state,
    overrideAction: outcome.action,
    newCents,
    squareCents,
    changeCents: newCents !== null && squareCents !== null ? newCents - squareCents : null,
    switchToWeight,
    flags,
    reason,
  };
}

/** Prices many lines with one context. */
/** The price a line would send, or for a pending override decision its formula price. */
function candidateOf(p: PricedLine): number | null {
  return p.newCents ?? (p.status === 'needs_decision' ? p.formulaCents : null);
}

function sameSet(a: readonly number[], b: readonly number[]): boolean {
  const x = [...new Set(a)].sort((m, n) => m - n);
  const y = [...new Set(b)].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Prices many lines with one context, then checks lines that map to the same variation. When
 * they would give it different prices, every one of those lines is blocked as a conflict until
 * the manager picks a price for the item. A pick sets the price sent this run only; it does not
 * change a stored override (that is the override decision's job).
 */
export function priceLines(inputs: readonly PriceLineInput[], ctx: PricingContext): PricedLine[] {
  const lines = inputs.map((i) => priceLine(i, ctx));
  const groups = new Map<string, PricedLine[]>();
  for (const l of lines) {
    if (l.variationId !== null && candidateOf(l) !== null) groups.set(l.variationId, [...(groups.get(l.variationId) ?? []), l]);
  }
  for (const [variationId, group] of groups) {
    const prices = [...new Set(group.map((l) => candidateOf(l)!))].sort((a, b) => a - b);
    if (prices.length < 2) continue;
    const others = (l: PricedLine) => {
      const ns = group.filter((g) => g !== l).map((g) => g.n);
      return `${ns.length > 1 ? 'lines' : 'line'} ${ns.join(', ')}`;
    };
    const shown = prices.map(dollars).join(', ');
    const pick = (ctx.conflictPicks ?? []).find((c) => c.variationId === variationId);
    const usable = pick !== undefined && Number.isSafeInteger(pick.priceCents) && pick.priceCents > 0 && sameSet(pick.shownCents, prices);
    for (const l of group) {
      let flags: PriceFlag[];
      if (usable) {
        // The pick settles the price, so the pending override question and the old movement go.
        flags = l.flags.filter((f) => f.id !== 'needs_decision' && f.id !== 'price_drop' && f.id !== 'big_jump');
        l.status = 'priced';
        l.newCents = pick.priceCents;
        l.changeCents = l.squareCents !== null ? pick.priceCents - l.squareCents : null;
        flags.push(...movementFlags(pick.priceCents, l.squareCents));
        flags.push({ id: 'conflict', message: `This line and ${others(l)} gave this item different prices (${shown}). ${dollars(pick.priceCents)} was picked.` });
      } else {
        l.status = 'conflict';
        l.newCents = null;
        l.changeCents = null;
        flags = [...l.flags];
        const again = pick !== undefined ? ' The earlier pick was made on other prices or could not be used, so it is asked again.' : '';
        flags.push({
          id: 'conflict',
          message: `This line and ${others(l)} are the same Square item with different prices (${shown}). Pick one price for the item. Nothing is sent for it until then.${again}`,
        });
      }
      l.flags = flags;
    }
  }
  return lines;
}
