// Exact decimal numbers for invoice checks. No floats are used for comparisons.
//
// A Decimal is units / 10^scale, with units a safe integer. Money is integer cents.
// The model returns numbers as text, exactly as printed, and they are parsed here
// digit by digit, so "43.21" is 4321 at scale 2 and never 43.209999.

import { MAX_NUMBER_TEXT as SHARED_MAX_NUMBER_TEXT, parseDecimalText } from '../lib/decimal.ts';

export interface Decimal {
  readonly units: number;
  readonly scale: number;
}

/** Longest text read as a number. Anything longer is not a printed invoice number. */
export const MAX_NUMBER_TEXT = SHARED_MAX_NUMBER_TEXT;

/**
 * Parses a printed number with the one shared parser (src/lib/decimal.ts). Accepts "2,345.67",
 * "-3.15", "3.15-", "(3.15)", ".00", "$12.99" and "5". Returns null for an empty string,
 * anything that is not a plain number (including digits split by spaces, "-3-" and "(-3)"),
 * text longer than MAX_NUMBER_TEXT, or a value too large to hold exactly.
 */
export function parseDecimal(text: string | null | undefined): Decimal | null {
  return parseDecimalText(text);
}

function pow10(n: number): number {
  return 10 ** n;
}

/** Divides an integer by 10^places, rounding half away from zero. Exact for safe integers. */
export function roundShift(units: number, places: number): number {
  if (places <= 0) return units * pow10(-places);
  const d = pow10(places);
  const r = units % d;
  const q = (units - r) / d;
  if (Math.abs(r) * 2 >= d) return q + Math.sign(units);
  return q;
}

/** A decimal as integer cents, rounding half away from zero beyond two places. */
export function toCents(d: Decimal): number {
  return d.scale <= 2 ? d.units * pow10(2 - d.scale) : roundShift(d.units, d.scale - 2);
}

/** Thrown when a product is too large to compute exactly. Callers turn it into a failed check. */
export class NumberTooLargeError extends Error {
  constructor() {
    super('A number is too large to multiply exactly.');
    this.name = 'NumberTooLargeError';
  }
}

/** a x b rounded to cents, half away from zero, the way invoices extend a line. */
export function mulToCents(a: Decimal, b: Decimal): number {
  const units = a.units * b.units;
  if (!Number.isSafeInteger(units)) throw new NumberTooLargeError();
  const scale = a.scale + b.scale;
  return scale <= 2 ? units * pow10(2 - scale) : roundShift(units, scale - 2);
}

/** a - b, exact. */
export function subtract(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  return { units: a.units * pow10(scale - a.scale) - b.units * pow10(scale - b.scale), scale };
}

/** Compares two decimals exactly: negative, zero or positive. */
export function compareDecimal(a: Decimal, b: Decimal): number {
  return subtract(a, b).units;
}

export function isZero(d: Decimal | null): boolean {
  return d !== null && d.units === 0;
}

/** Integer cents as text with two decimals, for example 234567 gives "2345.67". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A decimal as plain text, for example { units: 4321, scale: 2 } gives "43.21". */
export function formatDecimal(d: Decimal): string {
  if (d.scale === 0) return String(d.units);
  const sign = d.units < 0 ? '-' : '';
  const s = String(Math.abs(d.units)).padStart(d.scale + 1, '0');
  return `${sign}${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`;
}

/** Cents from printed text, or null when the text is empty or not a number. */
export function parseCents(text: string | null | undefined): number | null {
  const d = parseDecimal(text);
  return d === null ? null : toCents(d);
}

/** Dollars as a float, only for showing money and estimates. Never for checks. */
export function centsToDollars(cents: number): number {
  return cents / 100;
}
