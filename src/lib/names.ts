// One folding for company names: suppliers as invoices print them, and vendors as typed in the
// pricing settings. Matching and pricing both use it, so a vendor formula and the names a
// supplier has used always compare the same way, and settings cannot hold two vendor lines that
// fold to one name.

/** Longest name looked at. */
const MAX_NAME = 200;

/** Words that do not tell companies apart. */
const COMPANY_WORDS = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'company', 'corp', 'corporation', 'the', 'lp', 'llp', 'plc']);

/**
 * The key two spellings of one company share. Case, spacing, accents and curly quotes are
 * folded, "&" reads as "and", punctuation other than apostrophes is dropped, and so are words
 * like Inc, Co and The. "Acme Foods, Inc." and "ACME FOODS" give "acme foods"; an apostrophe
 * stays ("jose's cafe").
 */
export function companyKey(name: string): string {
  return name
    .slice(0, MAX_NAME)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’‚‛′`]/g, "'")
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w !== '' && !COMPANY_WORDS.has(w))
    .join(' ');
}
