// The one parser for printed decimal numbers. Invoice checks (src/invoice/money.ts) and pricing
// (src/pricing/rational.ts) both use it, so a number means the same thing everywhere.
//
// Accepted: "2,345.67", "$12.99", "$ 12.99", "-3.15", "+4", "-$3.15", "$-3.15", "3.15-",
// "3.15 -", "(3.15)", "($3.15)", "$(3.15)", ".00", "5." and "5".
// Refused, because each is a misreading rather than a number: digits split by spaces
// ("12 5.30"), more than one minus sign ("-3-"), a minus inside brackets ("(-3)"), commas in
// the wrong places, more than one dollar sign, more than 6 decimal places, more than
// MAX_NUMBER_TEXT characters after trimming, and digits that do not fit a safe integer.
// No floating point is involved: the digits are read as an integer and a decimal scale.

/** Longest text read as a number, after trimming. Anything longer is not a printed invoice number. */
export const MAX_NUMBER_TEXT = 24;

/** Most decimal places read. */
export const MAX_DECIMAL_PLACES = 6;

/** A parsed number: units / 10^scale, with units a safe integer. Zero is never negative. */
export interface ParsedDecimal {
  readonly units: number;
  readonly scale: number;
}

/** A plain number: thousands commas only in the right places. */
const NUM = String.raw`(?<num>\d{1,3}(?:,\d{3})+(?:\.\d*)?|\d+(?:\.\d*)?|\.\d+)`;
/** "(3.15)", "($3.15)" or "$(3.15)": negative. */
const BRACKETS = new RegExp(String.raw`^\$?\(\$?${NUM}\)$`);
/** "3.15-" or "$3.15-": negative. */
const TRAILING = new RegExp(String.raw`^\$?${NUM}-$`);
/** "3.15", "-3.15", "+3.15", "$3.15", "-$3.15", "$-3.15". */
const LEADING = new RegExp(String.raw`^\$?[-+]?\$?${NUM}$`);

/** Parses printed decimal text exactly. Returns null for empty text or anything not a plain number. */
export function parseDecimalText(text: string | null | undefined): ParsedDecimal | null {
  if (text === null || text === undefined) return null;
  const raw = String(text);
  if (raw.length > MAX_NUMBER_TEXT * 4) return null; // bounds the work below
  // Spaces may sit beside a symbol ("$ 12.99", "3.15 -"), never between digits.
  const s = raw.trim().replace(/\s*([$()+-])\s*/g, '$1');
  if (s === '' || s.length > MAX_NUMBER_TEXT || /\s/.test(s) || (s.match(/\$/g) ?? []).length > 1) return null;
  let negative: boolean;
  let m = BRACKETS.exec(s);
  if (m) negative = true;
  else if ((m = TRAILING.exec(s))) negative = true;
  else if ((m = LEADING.exec(s))) negative = s.replace('$', '').startsWith('-');
  else return null;
  const [whole = '', frac = ''] = m.groups!.num!.replace(/,/g, '').split('.');
  if (frac.length > MAX_DECIMAL_PLACES) return null;
  const units = Number((whole + frac).replace(/^0+(?=\d)/, '') || '0');
  if (!Number.isSafeInteger(units)) return null;
  return { units: negative && units !== 0 ? -units : units, scale: frac.length };
}
