// Rounding a computed price to a shelf price, in exact arithmetic.
//
// "up-to-99" reproduces the function in the cc-case-cards skill, which built the register prices:
//
//   const up = c => { const x = 2*c + 1; let d = Math.ceil(x);
//                     if (d - x < 0.99) d = Math.floor(x) + 1; return +(d - 0.01).toFixed(2); };
//
// Generalized from 2 x cost + 1 to any computed price x:
//   d = ceil(x); if d - x < 0.99 then d = floor(x) + 1; price = d - 0.01.
//
// What that does: a whole dollar amount N goes to N.99, and anything else goes to the .99 just
// below the next whole dollar. So 21.00 gives 21.99 and 20.98 gives 20.99. Between N.99 and
// N+1.00 it gives N.99, a little below x: 20.995 gives 20.99, not 21.99. That is kept on
// purpose (store/docs/DECISIONS.md, "Rounding fractions of a cent").

import { ceil, cmp, floor, rat, sub, type Rat } from './rational.ts';
import type { Rounding } from '../settings/schema.ts';

const NINETY_NINE_CENTS = rat(99n, 100n);

/** The skill's rounding, on an exact value. Returns whole cents. x must not be negative. */
export function roundUpTo99(x: Rat): bigint {
  if (x.n < 0n) throw new RangeError('A price cannot be negative.');
  let d = ceil(x);
  if (cmp(sub(rat(d), x), NINETY_NINE_CENTS) < 0) d = floor(x) + 1n;
  return d * 100n - 1n;
}

/** Applies a rounding rule from settings. Returns whole cents. */
export function applyRounding(rule: Rounding, x: Rat): bigint {
  switch (rule) {
    case 'up-to-99':
      return roundUpTo99(x);
    default: {
      const never: never = rule;
      throw new Error(`Unknown rounding rule ${String(never)}.`);
    }
  }
}

/** Plain words for a rounding rule, for the review screen. */
export function describeRounding(rule: Rounding): string {
  switch (rule) {
    case 'up-to-99':
      return 'rounded up to .99';
    default:
      return 'rounded';
  }
}
