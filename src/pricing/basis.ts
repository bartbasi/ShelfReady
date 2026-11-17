// Cost basis: what one sellable unit costs, before the formula. From the cc-case-cards skill:
// sold by the pound, the cost per pound; sold by the unit, the case price divided by the units
// per case. The reading's PackInfo already says whether a line's price is per case, per unit or
// per pound, or that it is unclear. Anything unclear gives no price and a plain reason, never a
// guess.
//
// Allowances. Invoices print "Less Allowance" amounts against a line's unit price. Bart decided
// (store/docs/DECISIONS.md, "Allowances (November 7)") that a temporary allowance does not lower the
// shelf price: pricing uses the regular cost before the allowance, so prices stay steady and
// the deal is extra margin. The invoice checks still add lines up at the net amount. 'net'
// exists only as an explicit option and is never the default.

import type { CheckedLine, PackInfo } from '../invoice/types.ts';
import { abs, cmp, div, fromInt, mul, parseRat, sub, toDecimalText, ZERO, type Rat } from './rational.ts';

/** How Square sells the item: by the pound (a scale code, or the per-pound unit), by the unit, or not known yet. */
export type SaleMode = 'weight' | 'unit' | 'unknown';

/** Whether a per-case allowance lowers the cost the formula sees. */
export type AllowanceBasis = 'net' | 'gross';
export const DEFAULT_ALLOWANCE_BASIS: AllowanceBasis = 'gross';

export interface BasisInput {
  /** The unit price as printed. */
  unitPrice: string;
  /** The allowance as printed, against the same unit as the price. Empty when none. */
  allowance: string;
  pack: PackInfo;
  /**
   * Pounds in one sellable unit, as a person gave it in review (saved with the match), for a line
   * the invoice prices by the pound when Square sells the item by the unit. Decimal text.
   */
  poundsPerUnit?: string;
}

export function basisInputFrom(cl: CheckedLine, poundsPerUnit?: string): BasisInput {
  return { unitPrice: cl.line.unit_price, allowance: cl.line.allowance, pack: cl.pack, ...(poundsPerUnit ? { poundsPerUnit } : {}) };
}

export interface CostFound {
  ok: true;
  /** What the cost is for: one pound or one sellable unit. */
  per: 'lb' | 'unit';
  /** Exact cost of one pound or one unit. */
  cost: Rat;
  /** The cost as text, 4 places at most. */
  costText: string;
  /** False when costText is rounded for display (the exact value is still used). */
  costExact: boolean;
  /** Plain words on how the cost was worked out, for the review screen. */
  how: string;
  /** The allowance taken off the price, when there was one and the net cost was used. */
  allowanceUsed: Rat | null;
  /** An allowance printed on the line, used or not. */
  allowancePrinted: Rat | null;
  unitsPerCase: number | null;
}

export interface CostMissing {
  ok: false;
  /** Plain words for the review screen. */
  reason: string;
}

export type CostBasis = CostFound | CostMissing;

function text(r: Rat): string {
  return toDecimalText(r, 4).text;
}

/** The cost of one sellable unit or pound for a line, or a plain reason there is none. */
export function costBasis(input: BasisInput, sale: SaleMode, allowanceBasis: AllowanceBasis = DEFAULT_ALLOWANCE_BASIS): CostBasis {
  const price = parseRat(input.unitPrice);
  if (price === null) return { ok: false, reason: 'No unit price was read for this line.' };
  const printed = parseRat(input.allowance);
  const allowance = printed !== null && printed.n !== 0n ? abs(printed) : null;
  const useAllowance = allowance !== null && allowanceBasis === 'net';
  const net = useAllowance ? sub(price, allowance) : price;
  const priceText = useAllowance ? `${text(price)} less ${text(allowance)} allowance = ${text(net)}` : text(price);
  const pack = input.pack;

  if (pack.pricePer === 'unclear') {
    return { ok: false, reason: 'Not clear whether the price is per case, per unit or per pound. Check the line before pricing.' };
  }
  if (sale === 'weight' && pack.pricePer !== 'lb') {
    return { ok: false, reason: 'Square sells this by the pound, but the invoice price is not per pound. The cost per pound is needed.' };
  }
  const lbPerUnit = parseRat(input.poundsPerUnit);
  const unitWeight = sale === 'unit' && pack.pricePer === 'lb' && lbPerUnit !== null && cmp(lbPerUnit, ZERO) > 0 ? lbPerUnit : null;
  if (sale === 'unit' && pack.pricePer === 'lb' && unitWeight === null) {
    return { ok: false, reason: 'The invoice prices this by the pound, but Square sells it by the unit. The weight of one unit is needed.' };
  }

  let cost: Rat;
  let per: 'lb' | 'unit';
  let how: string;
  let unitsPerCase: number | null = null;
  switch (pack.pricePer) {
    case 'lb':
      if (unitWeight !== null) {
        // Sold by the unit: one unit costs its weight times the price per pound.
        per = 'unit';
        cost = mul(net, unitWeight);
        const each = toDecimalText(cost, 4);
        how = `Price per pound ${priceText}, ${text(unitWeight)} lb per unit (from the saved match), ${each.exact ? '' : 'about '}${each.text} each.`;
        break;
      }
      per = 'lb';
      cost = net;
      how = `Price per pound ${priceText}.`;
      break;
    case 'unit':
      if (!pack.sure) return { ok: false, reason: pack.note || 'The pack on this line could not be read. Check it before pricing.' };
      per = 'unit';
      cost = net;
      how = `Price per unit ${priceText}.`;
      break;
    case 'case': {
      if (pack.unitsPerCase === null || !Number.isSafeInteger(pack.unitsPerCase) || pack.unitsPerCase < 1) {
        return { ok: false, reason: pack.note || 'The price is per case, but the units per case are not known. Check the pack.' };
      }
      if (!pack.sure) return { ok: false, reason: pack.note || 'The units per case are not certain. Check the pack.' };
      per = 'unit';
      unitsPerCase = pack.unitsPerCase;
      cost = div(net, fromInt(unitsPerCase));
      const each = toDecimalText(cost, 4);
      how = `Case price ${priceText}, ${unitsPerCase} units per case, ${each.exact ? '' : 'about '}${each.text} each.`;
      break;
    }
  }

  if (cmp(cost, ZERO) <= 0) {
    return { ok: false, reason: 'The cost works out to zero or less. Check the price and any allowance.' };
  }
  const shown = toDecimalText(cost, 4);
  return {
    ok: true,
    per,
    cost,
    costText: shown.text,
    costExact: shown.exact,
    how,
    allowanceUsed: useAllowance ? allowance : null,
    allowancePrinted: allowance,
    unitsPerCase,
  };
}
