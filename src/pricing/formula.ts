// Pricing formulas as data from settings:
//   price = (cost + addBefore) x multiplier + addAfter, then rounded.
// The usual one is 0 | 2 | 1.00, that is 2 x cost + 1.00. A vendor line such as 2.25 | 2 | 0
// is (cost + 2.25) x 2. Note that (cost + 1) x 2 is a different formula (1 | 2 | 0), about a
// dollar higher, and the register is built on the first one.

import { companyKey } from '../lib/names.ts';
import type { PriceFormula, PricingSettings } from '../settings/schema.ts';
import { add, cmp, mul, parseRat, toDecimalText, ZERO, type Rat } from './rational.ts';
import { applyRounding, describeRounding } from './rounding.ts';

export type FormulaSource = 'default' | 'vendor';

export interface ChosenFormula {
  source: FormulaSource;
  /** The vendor name as typed in settings, when a vendor formula was used. */
  vendor: string | null;
  formula: PriceFormula;
  /** Plain words, for example "2 x cost + 1.00, rounded up to .99". */
  text: string;
}

/** A formula amount from settings, exactly. Settings checks these on save, so a bad one is a bug. */
function amount(field: string, text: string): Rat {
  const r = parseRat(text);
  if (r === null || r.n < 0n) throw new Error(`The pricing formula has a bad ${field} value.`);
  return r;
}

export interface ParsedFormula {
  addBefore: Rat;
  multiplier: Rat;
  addAfter: Rat;
}

export function parseFormula(f: PriceFormula): ParsedFormula {
  const multiplier = amount('multiplier', f.multiplier);
  if (multiplier.n === 0n) throw new Error('The pricing formula has a zero multiplier.');
  return { addBefore: amount('add before', f.addBefore), multiplier, addAfter: amount('add after', f.addAfter) };
}

/** (cost + addBefore) x multiplier + addAfter, exactly, before rounding. */
export function formulaValue(f: PriceFormula, cost: Rat): Rat {
  const p = parseFormula(f);
  return add(mul(add(cost, p.addBefore), p.multiplier), p.addAfter);
}

/** The shelf price in whole cents: the formula, then its rounding rule. */
export function formulaCents(f: PriceFormula, cost: Rat): bigint {
  return applyRounding(f.rounding, formulaValue(f, cost));
}

function plain(r: Rat): string {
  return toDecimalText(r, 3).text;
}

/** Plain words for a formula: "2 x cost + 1.00, rounded up to .99" or "(cost + 2.25) x 2, ...". */
export function describeFormula(f: PriceFormula): string {
  const p = parseFormula(f);
  const hasBefore = cmp(p.addBefore, ZERO) !== 0;
  const hasAfter = cmp(p.addAfter, ZERO) !== 0;
  const multOne = p.multiplier.n === p.multiplier.d;
  const mult = p.multiplier.d === 1n ? p.multiplier.n.toString() : toDecimalText(p.multiplier, 3).text.replace(/0+$/, '');
  let text = hasBefore ? `(cost + ${plain(p.addBefore)})` : 'cost';
  if (!multOne) text = hasBefore ? `${text} x ${mult}` : `${mult} x ${text}`;
  if (hasAfter) text = `${text} + ${plain(p.addAfter)}`;
  return `${text}, ${describeRounding(f.rounding)}`;
}

/**
 * Folds a vendor name for comparing: case, spacing, curly quotes, accents, punctuation and
 * words like Inc. The same folding matching uses for the names a supplier prints
 * (src/lib/names.ts), so settings cannot hold "Acme" and "Acme Inc." as two vendors.
 */
export function vendorKey(name: string): string {
  return companyKey(name);
}

/** Two vendor lines in settings that are one name under vendorKey. Safe to show. */
export class VendorFormulaClash extends Error {}

/**
 * Vendor lines in settings that fold to one name, in plain words for the settings page and the
 * start of a run, or null when there are none. Settings refuse such lines when saved, but a value
 * saved before the folding changed on November 7 can still hold "Acme" and "Acme Inc.".
 */
export function vendorNameClash(settings: PricingSettings): string | null {
  const byKey = new Map<string, string[]>();
  for (const v of settings.vendors) byKey.set(vendorKey(v.vendor), [...(byKey.get(vendorKey(v.vendor)) ?? []), v.vendor]);
  const clashes = [...byKey.values()].filter((names) => names.length > 1);
  if (clashes.length === 0) return null;
  return `${clashes.map((names) => names.join(' and ')).join('; ')}: these vendor formulas in settings are now one name, since case, punctuation and words like Inc. are ignored. Keep one of each in settings before pricing.`;
}

/**
 * The formula for a vendor: its own line in settings when the name matches exactly (after
 * folding), otherwise the default. The caller passes the vendor as named in settings once a
 * supplier has been linked to it; invoice spellings are not guessed at here. When two lines in
 * settings fold to that name, it refuses with VendorFormulaClash rather than pick one.
 */
export function chooseFormula(settings: PricingSettings, vendor: string | null): ChosenFormula {
  if (vendor) {
    const key = vendorKey(vendor);
    const hits = settings.vendors.filter((v) => vendorKey(v.vendor) === key);
    if (hits.length > 1) throw new VendorFormulaClash(vendorNameClash({ ...settings, vendors: hits })!);
    const hit = hits[0];
    if (hit) return { source: 'vendor', vendor: hit.vendor, formula: hit.formula, text: describeFormula(hit.formula) };
  }
  return { source: 'default', vendor: null, formula: settings.default, text: describeFormula(settings.default) };
}

/**
 * The shelf price for a cost typed as text, in whole cents, for the settings page example.
 * Uses the same code as real pricing, so the two can never disagree.
 */
export function shelfCentsForText(f: PriceFormula, cost: string): number {
  const c = parseRat(cost);
  if (c === null || c.n < 0n) throw new Error('The example cost is not a number.');
  const cents = formulaCents(f, c);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('The example price is too large.');
  return Number(cents);
}
