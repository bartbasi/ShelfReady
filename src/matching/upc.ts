// Product codes as matching keys.
//
// A UPC-A, an EAN-13 and a GTIN-14 for the same product differ only by leading zeros, so every
// valid code is keyed as 14 digits padded with zeros. A code that fails its check digit gets no
// key: it was misread, or it is a mistake in the data, and it must not match anything by chance.
//
// By-weight items in Square often carry a UPC built from their scale code: seven zeros, the
// code, then a check digit (code 1234 gives 000000012348). That is not a maker's UPC, and the
// scale code itself always comes from the end of the item name, never from the UPC.

import { gtinCheckDigitValid } from '../invoice/checks.ts';

/** Longest code text looked at. Real codes are 14 digits at most, plus a few spaces or dashes. */
const MAX_CODE_TEXT = 40;

export type UpcProblem = 'not_digits' | 'bad_length' | 'check_digit';

export interface UpcReading {
  /** Digits only, spaces and dashes removed. Empty when nothing was printed. */
  digits: string;
  /** 14-digit key when the code is a valid GTIN, otherwise null. */
  key: string | null;
  /** Why there is no key. Null when the code is valid or empty. */
  problem: UpcProblem | null;
}

/** Reads a printed or stored code: 8, 12, 13 or 14 digits with a valid check digit. */
export function readUpc(text: string): UpcReading {
  const digits = text.slice(0, MAX_CODE_TEXT).replace(/[\s-]/g, '');
  if (digits === '') return { digits, key: null, problem: null };
  if (!/^\d+$/.test(digits)) return { digits, key: null, problem: 'not_digits' };
  if (![8, 12, 13, 14].includes(digits.length)) return { digits, key: null, problem: 'bad_length' };
  if (!gtinCheckDigitValid(digits)) return { digits, key: null, problem: 'check_digit' };
  return { digits, key: digits.padStart(14, '0'), problem: null };
}

/** The 14-digit key of a valid code, or null. */
export function upcKey(text: string): string | null {
  return readUpc(text).key;
}

/** The check digit that makes body plus that digit a valid GTIN. */
export function checkDigitFor(body: string): number {
  let sum = 0;
  const digits = body.split('').map(Number).reverse();
  digits.forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1);
  });
  return (10 - (sum % 10)) % 10;
}

/** The UPC Square uses for a scale code: seven zeros, the code, a check digit. As a 14-digit key. */
export function scaleCodeUpcKey(code: string): string {
  const body = `0000000${code}`;
  return `${body}${checkDigitFor(body)}`.padStart(14, '0');
}

/** The scale code a key was built from, or null when the key is a real maker's code. */
export function scaleCodeInUpc(key: string): string | null {
  const m = /^000000000(\d{4})\d$/.exec(key);
  return m ? m[1]! : null;
}

/**
 * Where a supplier's own item number sits inside a maker's UPC, for suppliers whose importer
 * labels carry it. Positions are 1-based, inclusive, counted on the 12-digit UPC-A. Only codes
 * that start with one of the maker prefixes count, since the same digits in another maker's
 * code mean nothing.
 */
export interface UpcItemRule {
  prefixes: string[];
  from: number;
  to: number;
}

/** Checks a rule from settings or the database. Returns null when it cannot be used. */
export function checkUpcItemRule(raw: unknown): UpcItemRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = r.from;
  const to = r.to;
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 1 || to > 11 || from > to) return null;
  if (!Array.isArray(r.prefixes) || r.prefixes.length === 0 || r.prefixes.length > 20) return null;
  const prefixes: string[] = [];
  for (const p of r.prefixes) {
    if (typeof p !== 'string' || !/^\d{1,10}$/.test(p) || p.length >= from) return null;
    prefixes.push(p);
  }
  return { prefixes, from, to };
}

/** The supplier item number a UPC carries under a rule, or null when the rule does not apply. */
export function itemNumberInUpc(key: string, rule: UpcItemRule): string | null {
  if (!key.startsWith('00')) return null;
  const upcA = key.slice(2);
  if (!rule.prefixes.some((p) => upcA.startsWith(p))) return null;
  return upcA.slice(rule.from - 1, rule.to);
}

/** The item number padded the way the rule stores it, or null when it cannot fit. */
export function itemNumberForRule(itemNumber: string, rule: UpcItemRule): string | null {
  const t = itemNumber.replace(/\s+/g, '');
  const width = rule.to - rule.from + 1;
  if (!/^\d+$/.test(t) || t.length > width) return null;
  return t.padStart(width, '0');
}
