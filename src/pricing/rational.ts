// Exact rational numbers for pricing. A Rat is n / d with BigInt parts, d always positive and
// the fraction always in lowest terms. No floating point is used anywhere: a unit cost such as
// 32.23 / 12 stays exactly 3223/1200 until the final price is a whole number of cents.

import { parseDecimalText } from '../lib/decimal.ts';

export interface Rat {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

export function rat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new RangeError('Division by zero.');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
}

export const ZERO: Rat = { n: 0n, d: 1n };
export const ONE: Rat = { n: 1n, d: 1n };

export function fromInt(i: number | bigint): Rat {
  if (typeof i === 'number' && !Number.isSafeInteger(i)) throw new RangeError('Not a safe integer.');
  return { n: BigInt(i), d: 1n };
}

/** Integer cents as a Rat of dollars. */
export function fromCents(cents: number | bigint): Rat {
  return rat(typeof cents === 'bigint' ? cents : fromInt(cents).n, 100n);
}

export function add(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

export function div(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new RangeError('Division by zero.');
  return rat(a.n * b.d, a.d * b.n);
}

export function neg(a: Rat): Rat {
  return { n: -a.n, d: a.d };
}

export function abs(a: Rat): Rat {
  return a.n < 0n ? neg(a) : a;
}

/** Negative, zero or positive, exactly. */
export function cmp(a: Rat, b: Rat): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function isInteger(a: Rat): boolean {
  return a.d === 1n;
}

/** The largest integer not above a. */
export function floor(a: Rat): bigint {
  const q = a.n / a.d; // BigInt division truncates toward zero
  return a.n < 0n && q * a.d !== a.n ? q - 1n : q;
}

/** The smallest integer not below a. */
export function ceil(a: Rat): bigint {
  const q = a.n / a.d;
  return a.n > 0n && q * a.d !== a.n ? q + 1n : q;
}

/**
 * Parses printed decimal text exactly, with the one shared parser (src/lib/decimal.ts) that the
 * invoice checks use too. Returns null for empty text or anything that is not a plain number.
 */
export function parseRat(text: string | null | undefined): Rat | null {
  const d = parseDecimalText(text);
  return d === null ? null : rat(BigInt(d.units), 10n ** BigInt(d.scale));
}

/**
 * A Rat as decimal text with at least 2 and at most maxPlaces places. exact is false when the
 * value had to be rounded (half away from zero) to fit, for example 3223/1200 gives "2.6858".
 */
export function toDecimalText(a: Rat, maxPlaces = 4): { text: string; exact: boolean } {
  const negative = a.n < 0n;
  const v = abs(a);
  const scale = 10n ** BigInt(maxPlaces);
  const scaled = v.n * scale;
  let units = scaled / v.d;
  const rem = scaled - units * v.d;
  const exact = rem === 0n;
  if (rem * 2n >= v.d) units += 1n;
  const digits = units.toString().padStart(maxPlaces + 1, '0');
  const whole = maxPlaces > 0 ? digits.slice(0, -maxPlaces) : digits;
  let frac = maxPlaces > 0 ? digits.slice(-maxPlaces) : '';
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  const sign = negative && units !== 0n ? '-' : '';
  return { text: `${sign}${whole}${frac ? `.${frac}` : ''}`, exact };
}
