// Supplier item numbers as matching keys. A model can read the letter O as zero or the letter I
// as one, and the same invoice line can come back either way on different runs, so lookups in
// the saved mapping (step 3) should use this key, never the raw text. Scoring against the
// ground truth still compares the exact text.

/**
 * A key for looking up an item number: no spaces, upper case, letter O as zero, letter I as one.
 * Other characters, dashes included, are kept.
 */
export function normalizeItemNumber(text: string): string {
  return text.replace(/\s+/g, '').toUpperCase().replace(/O/g, '0').replace(/I/g, '1');
}

/** True when two item numbers are the same key, so a lookup by either finds the other. */
export function sameItemNumber(a: string, b: string): boolean {
  const ka = normalizeItemNumber(a);
  return ka !== '' && ka === normalizeItemNumber(b);
}
