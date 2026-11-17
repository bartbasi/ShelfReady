// Text helpers for matching: folding, the maker before " - ", and word lists for comparing an
// invoice description with a Square name. The scale code at the end of a name is read by
// src/lib/scale-code.ts, shared with pricing.
//
// Invoice descriptions are short, in capitals and full of trade abbreviations ("SKNLS", "OG",
// "W/"). Square names are mixed case, often "Maker - Product", and by-weight names end in a
// 4-digit scale code. Both sides go through the same steps, so a word compares equal however
// it was written.

/** Longest text compared. Longer descriptions are cut first, so no pattern sees huge input. */
const MAX_TEXT = 300;

/** Lower case, accents removed, curly quotes made straight. */
export function foldText(text: string): string {
  return text
    .slice(0, MAX_TEXT)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .toLowerCase();
}

export interface MakerSplit {
  maker: string;
  product: string;
}

/** "Maker - Product" split at the first spaced dash. A name without one has no maker. */
export function splitMaker(base: string): MakerSplit {
  const m = /^(.{1,80}?)\s+[-\u2013\u2014]\s+(.+)$/.exec(base);
  if (!m) return { maker: '', product: base.trim() };
  return { maker: m[1]!.trim(), product: m[2]!.trim() };
}

/** Words that say nothing about which product a line is. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'with', 'in', 'on', 'for', 'per', 'by', 'or', 'to', 'at',
  'de', 'di', 'del', 'della', 'des', 'du', 'la', 'le', 'les', 'el', 'da', 'do', 'y', 'e', 'et', 'al',
  'lb', 'lbs', 'oz', 'z', 'g', 'gr', 'kg', 'ml', 'l', 'ct', 'pc', 'pcs', 'pk', 'ea', 'cs', 'case', 'each',
  'piece', 'pieces', 'pack', 'bulk', 'retail', 'regular', 'item', 'avg', 'approx',
]);

/**
 * Trade abbreviations seen on distributor invoices, with what they stand for. General food
 * trade usage only, nothing about one store. A two or three letter abbreviation must be listed
 * here to count; longer ones also match as the start of a word (see wordScore in similarity.ts).
 */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  sknls: 'skinless',
  sknl: 'skinless',
  bnls: 'boneless',
  og: 'organic',
  xv: 'extra virgin',
  evoo: 'extra virgin olive oil',
  sm: 'small',
  sml: 'small',
  lg: 'large',
  lrg: 'large',
  xl: 'extra large',
  mediter: 'mediterranean',
  medit: 'mediterranean',
  rb: 'roast beef',
  fil: 'fillet',
  filet: 'fillet',
  flt: 'fillet',
  chz: 'cheese',
  chs: 'cheese',
  crkr: 'cracker',
  crkrs: 'cracker',
  bbq: 'barbecue',
  ppr: 'pepper',
  swt: 'sweet',
  hny: 'honey',
  grn: 'green',
  blk: 'black',
  wht: 'white',
  pei: 'prince edward island',
  ib: 'iberico',
  pd: 'peeled deveined',
  pbo: 'pin bone out',
  sc: 'scaled',
  iqf: '',
};

/** Spelled-out forms of a few slash abbreviations, read before the text is split into words. */
const SLASH_FORMS: ReadonlyArray<[RegExp, string]> = [
  [/\bw\//g, ' with '],
  [/\bn\/c\b/g, ' natural casing '],
  [/\bc\/o\b/g, ' cap off '],
  [/\bs\/on\b/g, ' skin on '],
  [/\bs\/off\b/g, ' skin off '],
  [/\b1\/2\b/g, ' half '],
];

/**
 * Words that describe a product without naming it ("whole", "fresh", "mini"). They count for
 * less, so a short Square name that shares only one of them is not offered.
 */
export const DESCRIPTIVE_WORDS: ReadonlySet<string> = new Set(
  ['whole', 'half', 'fresh', 'large', 'small', 'medium', 'mini', 'jumbo', 'slice', 'sliced', 'natural', 'premium', 'classic', 'original', 'organic',
   'imported', 'domestic', 'extra', 'select', 'style', 'loaf', 'log', 'tub', 'pail', 'tray', 'fillet', 'pre', 'cut', 'top'].map((w) => stem(w)),
);

/** A light stemmer: plural and past-tense endings, so "olives" meets "olive" and "smoked" meets "smoke". */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  if (/(sses|ches|shes|xes|zes|oes)$/.test(word)) return word.slice(0, -2);
  if (/(ss|us|is)$/.test(word)) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2);
  return word;
}

/**
 * The words of a text, folded, abbreviations spelled out, stop words dropped and stemmed.
 * Numbers stay ("1.25", "16/20" becomes "16" and "20") since sizes can tell two items apart.
 */
export function words(text: string): string[] {
  return plainWords(text).map(stem);
}

/** The same words as words(), before stemming. Used to spot two words read as one. */
export function plainWords(text: string): string[] {
  let t = foldText(text);
  for (const [re, to] of SLASH_FORMS) t = t.replace(re, to);
  t = t.replace(/&/g, ' and ').replace(/(\d)#/g, '$1 lb ').replace(/'s\b/g, 's').replace(/'/g, '');
  // Letters and digits run together ("u10", "9oz", "1lb") are two words.
  t = t.replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2');
  const out: string[] = [];
  for (const raw of t.split(/[^a-z0-9.]+/)) {
    const w = raw.replace(/^\.+|\.+$/g, '');
    if (w === '' || (w.includes('.') && !/^\d+\.\d+$/.test(w))) {
      for (const part of w.split('.')) pushWord(out, part);
      continue;
    }
    pushWord(out, w);
  }
  return out;
}

function pushWord(out: string[], w: string): void {
  if (w === '' || /^[a-z]$/.test(w)) return;
  const expanded = Object.hasOwn(ABBREVIATIONS, w) ? ABBREVIATIONS[w]! : w;
  for (const part of expanded.split(' ')) {
    if (part === '' || STOP_WORDS.has(part)) continue;
    out.push(part);
  }
}

/** True when a and b differ by at most one letter added, dropped, changed or two swapped. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let first = -1;
    let diffs = 0;
    for (let i = 0; i < la; i++) {
      if (a[i] !== b[i]) {
        if (diffs === 0) first = i;
        diffs++;
        if (diffs > 2) return false;
      }
    }
    if (diffs === 1) return true;
    // Two neighbours swapped.
    return diffs === 2 && first + 1 < la && a[first] === b[first + 1] && a[first + 1] === b[first];
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) {
      i++;
      j++;
    } else {
      if (skipped) return false;
      skipped = true;
      j++;
    }
  }
  return true;
}

/** Unit spellings read as one: 3#, 3 LB and 3 LBS are all 3lb. */
const SIZE_UNITS: Readonly<Record<string, string>> = { lb: 'lb', lbs: 'lb', '#': 'lb', oz: 'oz', z: 'oz', g: 'g', gr: 'g', kg: 'kg', ltr: 'l', l: 'l', ml: 'ml', ct: 'ct', pc: 'pc', pcs: 'pc' };

/**
 * The sizes and counts printed in a description, folded: ranges and counts ("2-3", "10/20",
 * "5x2"), a grade like "U10" or "U-10", and a number before a unit ("3#", "8 OZ", "1 LTR",
 * "250G", "84PC"). Two printings of one product carry the same ones; a pack change does not.
 */
export function sizeTokens(text: string): string[] {
  const t = foldText(text).replace(/\s+/g, ' ');
  const out = new Set<string>();
  for (const m of t.matchAll(/(\d+(?:\.\d+)?) ?([-/x]) ?(\d+(?:\.\d+)?)/g)) out.add(`${m[1]}${m[2]}${m[3]}`);
  for (const m of t.matchAll(/(?:^|[^a-z0-9])u ?[-/]? ?(\d+)(?![\d.])/g)) out.add(`u${m[1]}`);
  for (const m of t.matchAll(/(\d+(?:\.\d+)?) ?(lbs|lb|oz|z|gr|g|kg|ltr|ml|l|ct|pcs|pc|#)(?![a-z])/g)) out.add(`${m[1]}${SIZE_UNITS[m[2]!]}`);
  return [...out].sort();
}

