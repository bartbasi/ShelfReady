// Text helpers for card copy: cleaning text that came from the model, the web or a person,
// checking URLs, and finding protected designation terms, unwanted dashes, prices, phone numbers
// and web addresses. No store data here.
//
// Special characters are built from their code point numbers, so no editor or tool can turn an
// escape into the character itself.

import { words } from '../matching/text.ts';

/** Longest single field accepted from the model. Anything longer means something went wrong. */
export const MAX_FIELD = 2000;
/** Longest URL kept. */
const MAX_URL = 500;

const cp = (...n: number[]) => String.fromCodePoint(...n);

/** Every kind of space and line break, which a card cell shows as one plain space at most. */
const SPACE_LIKE = /[\s\p{Z}]+/gu;
/** Letters, marks, numbers, punctuation, symbols and the plain space: all a card may hold. */
const ALLOWED = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;
/**
 * Characters that show nothing even though they pass ALLOWED: Hangul fillers, variation
 * selectors, the combining grapheme joiner, Mongolian free variation selectors and the like.
 * Tag characters, private use, noncharacters and lone surrogates already fail ALLOWED.
 */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * NFC, every space and line break made one plain space, then only letters, marks, numbers,
 * punctuation, symbols and the plain space kept, minus anything that shows nothing. Runs of
 * spaces folded, ends trimmed. Used on everything the model writes, on every edit, and on any
 * card text before it goes into a prompt.
 */
export function cleanText(text: string): string {
  let out = '';
  for (const ch of String(text).normalize('NFC').replace(SPACE_LIKE, ' ')) {
    if (ALLOWED.test(ch) && !IGNORABLE.test(ch)) out += ch;
  }
  return out.replace(/ {2,}/g, ' ').trim();
}

const QUOTES = new RegExp(`[${cp(0x2018, 0x2019, 0x201a, 0x201b, 0x2032)}]`, 'g');

/** Lower case with accents removed, for comparing words. Unlike the matching fold, it never cuts the text. */
export function foldCopy(text: string): string {
  return String(text).normalize('NFKD').replace(/\p{M}/gu, '').replace(QUOTES, "'").toLowerCase();
}

/** The URL as an absolute http or https address with no login in it, or null. */
export function safeUrl(text: string): string | null {
  const t = cleanText(text);
  if (t === '' || t.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.hostname === '') return null;
  u.hash = '';
  return u.href;
}

/** A key two spellings of one page share: host without www, path without a trailing slash, query kept. */
export function urlKey(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the path as it was
  }
  return `${host}${path.normalize('NFC').replace(/\/+$/, '')}${u.search}`;
}

/** Protected designation abbreviations, in capitals as printed. "D.O.P." counts too. */
const DESIGNATION_ABBR = /\b(D\.?O\.?P|I\.?G\.?P|A\.?O\.?P|A\.?O\.?C|D\.?O\.?C\.?G|D\.?O\.?C|D\.?O\.?Q|I\.?G\.?T|P\.?D\.?O|P\.?G\.?I|S\.?T\.?G|T\.?S\.?G)(?![A-Za-z])/gu;
/** The same written out, in English, French, Spanish and Italian. */
const DESIGNATION_WORDS = /protected (designation|geographical indication)|appellation d.origine|denominaci[oó]n de origen|denominazione di origine|indicazione geografica/giu;

/** The designation terms a text uses: abbreviations upper case without dots, phrases lower case. */
export function designationTerms(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text).matchAll(DESIGNATION_ABBR)) out.add(m[1]!.replace(/\./g, ''));
  for (const m of String(text).matchAll(DESIGNATION_WORDS)) out.add(foldCopy(m[0]));
  return [...out];
}

const EM_DASH = cp(0x2014);
const SPACED_EN_DASH = new RegExp(`\\s${cp(0x2013)}\\s`);

/** Dashes the store does not print: the em dash, a double hyphen, and a spaced en dash used as one. */
export function unwantedDashes(text: string): string[] {
  const found: string[] = [];
  if (text.includes(EM_DASH)) found.push('an em dash');
  if (text.includes('--')) found.push('a double hyphen');
  if (SPACED_EN_DASH.test(text)) found.push('a spaced en dash');
  return found;
}

const STRAIGHT_APOSTROPHE = /'/g;
const CURLY_APOSTROPHE = cp(0x2019);

/** Straight apostrophes made curly, as the existing cards print them. */
export function curlyApostrophes(text: string): string {
  return text.replace(STRAIGHT_APOSTROPHE, CURLY_APOSTROPHE);
}

/** The folded, stemmed words of a product name, for linking a card by name. */
export function nameKeyOf(name: string): string {
  return words(name).join(' ');
}

/** The flagged phrases a text uses, matched as whole words after folding. */
export function flaggedPhrases(text: string, phrases: readonly string[]): string[] {
  const folded = ` ${foldCopy(text).replace(/[^a-z0-9]+/g, ' ')} `;
  return phrases.filter((p) => {
    const key = foldCopy(p).replace(/[^a-z0-9]+/g, ' ').trim();
    return key !== '' && folded.includes(` ${key} `);
  });
}

// ---- Prices, phone numbers and web addresses ----
//
// A card prints its price in its own row, from pricing. Copy that carries a money amount, a phone
// number or a web address is wrong at best, and at worst text a web page planted: those block.
// Talk of price without an amount ("at this price", "cheap", "priced as an ingredient") is plain
// shop talk on the store's own cards, so it only goes on the verify list. Each field is checked on
// its own, so a year at the end of one field and the next field's words cannot make a price. The
// text is folded with NFKC first, so full-width digits, letter-like symbols and other look-alikes
// count as the plain characters they look like.

/** The ideographic full stop, which NFKC leaves alone, read as a dot. */
const IDEOGRAPHIC_STOP = new RegExp(cp(0x3002), 'g');

function guardFold(text: string): string {
  return String(text).normalize('NFKC').replace(IDEOGRAPHIC_STOP, '.').replace(SPACE_LIKE, ' ');
}

/** Units and words that make a number a measure, not money. */
const MEASURE_AFTER = String.raw`\s*(?:%|percent|per cent|fl\.?\s?oz\b|fluid ounces?\b|lbs?\b|pounds?\b|kg\b|kilos?\b|kilograms?\b|grams?\b|g\b|mg\b|oz\b|ounces?\b|ml\b|cl\b|dl\b|l\b|litres?\b|liters?\b|pints?\b|quarts?\b|gallons?\b|inch(?:es)?\b|ft\b|feet\b|cm\b|mm\b|metres?\b|meters?\b|years?\b|months?\b|weeks?\b|days?\b|hours?\b|minutes?\b|degrees?\b|${cp(0x00b0)}|ct\b|count\b|pieces?\b|pcs\b|slices?\b|servings?\b|calories\b|kcal\b|abv\b)`;
const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
/** Currency words. "per cent" is a share, not money. */
const CURRENCY_WORD = String.raw`(?:dollars?|bucks|usd|eur|euros?|gbp|pence|quid|yen|(?<!\bper )cents?)`;
const MONEY_PATTERNS: readonly RegExp[] = [
  // Any currency sign, in any form NFKC folds to one.
  /\p{Sc}/u,
  // A number, in digits or words, then a currency word: "9 dollars", "fifty cents", "twenty-five euros".
  new RegExp(String.raw`(?:\d[\d.,]*|\b${NUMBER_WORD}(?:-${NUMBER_WORD})?)\s*${CURRENCY_WORD}\b`, 'iu'),
  // A currency code before a number: "USD 9", "EUR 4.50".
  /\b(?:usd|eur|gbp)\s*\d/iu,
  // An amount with cents for a weight: "2.99 a pound", "12.50/lb". A count per pound is a size.
  /\d+[.,]\d{2}\s*(?:a|per|each|\/)\s*(?:pound|lb|lbs|kilo|kg|ounce|oz)\b/iu,
  // A bare amount with cents ("9.99"), unless a measure or a range follows it ("1.25 to 1.5 pounds").
  // A full stop or comma right after it still counts ("Yours for 12.99."), but not a longer number.
  new RegExp(String.raw`(?<![\d.,])\d{1,4}[.,]\d{2}(?!\d|[.,]\d)(?!${MEASURE_AFTER})(?!\s*(?:to|or|-|${cp(0x2013)})\s*\d)`, 'iu'),
];
const PHONE_PATTERNS: readonly RegExp[] = [
  // North American: (217) 555 0123, 217-555-0123, +1 217 555 0123.
  /(?:\+?1[\s.-]*)?(?:\(\s*\d{3}\s*\)|\b\d{3})[\s.-]*\d{3}[\s.-]+\d{4}\b/u,
  // International: a plus sign, then at least 8 digits.
  /\+\s*\d(?:[\s().-]*\d){7,}/u,
  // Ten or more digits in a row.
  /\d{10,}/u,
];
const LINK_PATTERNS: readonly RegExp[] = [
  /:\/\//u,
  /\bwww\./iu,
  // Any dotted host, short links and email addresses included: example.com, bit.ly/x, t.co.
  /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}\b/iu,
];
/** Talk of price with no amount. Only for the verify list. */
const PRICE_WORDS = /\b(?:prices?|priced|pricing|discount(?:ed)?|on sale|sale price|special offer|bargain|cheap(?:er|est|ly)?|costs? only|affordable|inexpensive|expensive|dollars?|euros?|(?<!\bper )cents?)\b/gu;

export type GuardFinding = 'price' | 'phone' | 'link';

/** Whether one field carries a money amount, a phone number or a web address, after NFKC. These block. */
export function guardFindings(text: string): GuardFinding[] {
  const t = guardFold(text);
  const out: GuardFinding[] = [];
  if (MONEY_PATTERNS.some((re) => re.test(t))) out.push('price');
  if (PHONE_PATTERNS.some((re) => re.test(t))) out.push('phone');
  if (LINK_PATTERNS.some((re) => re.test(t))) out.push('link');
  return out;
}

/** Talk of price in one field, in lower case, for the verify list. It never blocks. */
export function priceWords(text: string): string[] {
  const t = guardFold(text);
  const found = new Set<string>();
  for (const m of t.toLowerCase().matchAll(PRICE_WORDS)) found.add(m[0]);
  // "bucks" counts only in lower case: with a capital it is a place name (Bucks County).
  if (/\bbucks\b/u.test(t)) found.add('bucks');
  return [...found];
}
