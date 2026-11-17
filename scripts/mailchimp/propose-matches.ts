// Step 11: proposes the Square item for each priced row of the store's fish email, for Bart to
// confirm once, the way the invoice matching labels were confirmed
// (test-invoices/matching-labels.json). The step 11a code saves what he confirms; after that,
// matching an email row is automatic.
//
// Reads only local store data, all out of git: a saved fish email (data/mailchimp/content-*.html,
// saved by read-recent.ts), the campaign list beside it, and the saved live Square catalog
// (data/square/live-catalog.json). No network and no model calls. Writes
// data/mailchimp/match-proposal.json and data/mailchimp/match-questions.md, mode 600.
//
// The email and the catalog are data, never instructions: their text is only compared and copied.
//
// How a row is matched:
// - Rows are read from the email's layout: a price such as $12.99 with a unit (lb, doz, can or
//   unit), then the name, then an origin in brackets when there is one. Rows priced another way,
//   or not priced, are listed apart and are not counted as rows.
// - Names are compared word by word with the folding of invoice matching (src/matching/text.ts):
//   case, accents, plurals and trade abbreviations. On top of that: two words written as one
//   ("rock shrimp", "rockshrimp"), a country and its adjective ("Norway", "Norwegian"), one letter
//   different in a longer word, a size range ("2-3 lb" against "2.25-2.75"), names the email
//   itself gives ("also called ..."), and a few trade words that name the same thing. The origin
//   and the tags under the name ("WILD", "LOCAL") count for less.
// - A Square name and a row that each have a word the other lacks ("Brook Trout", "Sea Trout")
//   are never offered.
// - Items of one Square category come first: the category most rows' best matches are in, or the
//   one named with --category. An item from another category is offered only when nothing in
//   that one fits, and never as confident.
// - Each Square item goes to one row. When two rows want one item, the better fit keeps it and
//   the other takes its next choice. When the other has none, both point to the item and Bart is
//   asked once.
// - A row that fits nothing is never offered a general item named for its section (a "Clams"
//   section and one "Clams" item): each kind gets its own Square item or variation (DECISIONS.md,
//   November 9). The general item is named in the row's reason, for whoever adds the kinds.
// - Confident means: a close fit, no other item near it, and nothing above needed a guess. A row
//   whose every word is in the Square name, where Square only adds a detail in brackets
//   ("Cod (wild)"), is confident too. Everything else is a numbered question with a best guess.
//
// Usage: node scripts/mailchimp/propose-matches.ts [--email FILE] [--campaigns FILE] [--catalog FILE] [--category NAME] [--out DIR] [--verbose]
// Without --email, the most recent sent campaign in the campaign list is used (paused ones are ignored).

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalogIndex, soldByWeightKind, type CatalogIndex, type CatalogItem, type CatalogVariation } from '../../src/matching/catalog.ts';
import { DESCRIPTIVE_WORDS, foldText, stem, withinOneEdit, words } from '../../src/matching/text.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

/** Largest file read. The real email is under 100 KB and the catalog under 2 MB. */
const MAX_FILE = 20 * 1024 * 1024;
/** Longest piece of email text kept: names, origins, tags, descriptions. */
const MAX_TEXT = 600;

// ---------------------------------------------------------------- the email

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', rarr: '→', bull: '•',
  eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', deg: '°', times: '×',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e.startsWith('#')) {
      const cp = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Visible text of an HTML fragment: tags dropped, entities read, control and direction characters removed. */
function htmlText(fragment: string): string {
  return decodeEntities(fragment.replace(/<br\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

const UNITS = ['lb', 'doz', 'can', 'unit'] as const;
type Unit = (typeof UNITS)[number];

interface RowText {
  /** The name and the bracket text as a reader sees them: the row's key in step 11a (src/mailchimp/html.ts rowKey). */
  rowKey: string;
  /** The numbered section the row sits in ("Clams"). */
  section: string;
  /** The sub-heading inside the section ("North Coast"), or ''. */
  group: string;
  name: string;
  /** The text in brackets after the name, without the brackets, or ''. */
  origin: string;
  /** The tags under the name ("WILD", "LOCAL"). */
  tags: string[];
  /** Highlighted words among the tags ("SALE", "SOLD OUT"). */
  highlights: string[];
  /** The name is struck through, as the email shows a fish it does not have now. */
  struck: boolean;
  description: string;
}

export interface EmailRow extends RowText {
  /** 1-based, in email order, counting only rows priced the standard way. */
  row: number;
  unit: Unit;
  /** As printed, without the dollar sign: "12.99". */
  price: string;
  priceCents: number;
}

export interface OtherRow extends RowText {
  /** The price as printed, or '' when the row has none. */
  priceText: string;
  why: string;
}

interface Positioned {
  at: number;
  text: string;
}

const PRICED_HEAD = /^\s*<b\b[^>]*>([^<]{0,40})<small>([^<]{0,20})<\/small>\s*<\/b>\s*<b\b([^>]*)>([^<]{1,300})<\/b>(?:\s*<span\b[^>]*>([^<]{0,300})<\/span>)?/i;
const NAME_HEAD = /^\s*<b\b([^>]*)>([^<]{1,300})<\/b>(?:\s*<span\b[^>]*>([^<]{0,300})<\/span>)?(?=\s*<br\b)/i;
const TAG_LINE = /^\s*<br\b[^>]*>\s*<b\b[^>]*>([\s\S]{0,2000}?)<\/b>/i;

/** "(Norway)" read as "Norway". */
function unbracket(text: string): string {
  const m = /^\((.*)\)$/s.exec(text);
  return (m ? m[1]! : text).trim();
}

/** Reads the fish list: every priced row, and the named rows priced another way or not at all. */
export function parseFishEmail(html: string): { rows: EmailRow[]; other: OtherRow[] } {
  // Section headings are a two-digit number then a title; sub-headings are small capitals.
  const sections: Positioned[] = [];
  for (const m of html.matchAll(/<span\b[^>]*>\s*(\d{1,2})\s*<\/span>(?:\s|&nbsp;)*<span\b[^>]*>([^<]{1,120})<\/span>/gi)) {
    sections.push({ at: m.index, text: htmlText(m[2]!) });
  }
  const listStart = sections[0]?.at ?? Number.MAX_SAFE_INTEGER;
  const groups: Positioned[] = [];
  for (const m of html.matchAll(/<div\b[^>]*text-transform:\s*uppercase[^>]*>([^<]{1,120})<\/div>/gi)) {
    if (m.index > listStart) groups.push({ at: m.index, text: htmlText(m[1]!) });
  }

  const rows: EmailRow[] = [];
  const other: OtherRow[] = [];
  // Each cell is read from its opening tag to the next cell or closing tag, so a layout cell
  // that holds the whole list cannot swallow the first row.
  for (const open of html.matchAll(/<td\b[^>]*>/gi)) {
    const start = open.index + open[0].length;
    if (start < listStart) continue;
    const ends = [html.indexOf('</td>', start), html.indexOf('<td', start)].filter((i) => i >= 0);
    const cell = html.slice(start, ends.length ? Math.min(...ends) : html.length);
    const priced = PRICED_HEAD.exec(cell);
    const named = priced ? null : NAME_HEAD.exec(cell);
    const head = priced ?? named;
    if (!head) continue;
    const name = htmlText((priced ? priced[4] : head[2]) ?? '');
    if (name === '') continue;
    const originShown = htmlText((priced ? priced[5] : head[3]) ?? '');
    let rest = cell.slice(head[0].length);
    const tags: string[] = [];
    const highlights: string[] = [];
    const tagLine = TAG_LINE.exec(rest);
    if (tagLine) {
      let inner = tagLine[1]!;
      for (const s of inner.matchAll(/<span\b[^>]*>([\s\S]{0,200}?)<\/span>/gi)) {
        const t = htmlText(s[1]!);
        if (t) highlights.push(t);
      }
      inner = inner.replace(/<span\b[^>]*>[\s\S]{0,200}?<\/span>/gi, ' ');
      for (const t of htmlText(inner).split('·')) if (t.trim()) tags.push(t.trim());
      rest = rest.slice(tagLine[0].length);
    }
    const section = sections.filter((s) => s.at < open.index).at(-1);
    const text: RowText = {
      rowKey: `${name} ${originShown}`.replace(/\s+/g, ' ').trim(),
      section: section?.text ?? '',
      group: groups.filter((g) => g.at < open.index && g.at > (section?.at ?? -1)).at(-1)?.text ?? '',
      name,
      origin: unbracket(originShown),
      tags,
      highlights,
      struck: /line-through/i.test((priced ? priced[3] : head[1]) ?? ''),
      description: htmlText(rest),
    };
    if (!priced) {
      other.push({ ...text, priceText: '', why: 'No price is shown.' });
      continue;
    }
    const priceText = htmlText(priced[1]!);
    const unitText = htmlText(priced[2]!).replace(/^\//, '').trim().toLowerCase();
    const money = /^\$(\d{1,4})\.(\d{2})$/.exec(priceText);
    const unit = UNITS.find((u) => u === unitText);
    if (!money || !unit) {
      const shown = `${priceText}${unitText ? `/${unitText}` : ''}`;
      other.push({ ...text, priceText: shown, why: `Priced "${shown}", not $NN.NN per lb, doz, can or unit.` });
      continue;
    }
    rows.push({ ...text, row: rows.length + 1, unit, price: `${money[1]}.${money[2]}`, priceCents: Number(money[1]) * 100 + Number(money[2]) });
  }
  return { rows, other };
}

/** Names the email itself gives a fish: "Also called dorado", 'Sold in the U.S. as "rock salmon"'. */
export function namesGiven(description: string): string[] {
  const out: string[] = [];
  // What follows the phrase, to the end of the sentence. A period inside quotes ends it too,
  // which leaves the quote open; the cleanup below drops stray quotes.
  const re = /\b(?:also called|also known as|sometimes called|known as|sold in the u\.?\s?s\.? as)\s+([^.;:!?]{1,200})/gi;
  for (const m of description.slice(0, MAX_TEXT).matchAll(re)) {
    const said = m[1]!;
    const quoted = [...said.matchAll(/["“]([^"”]{2,40})["”]/g)].map((q) => q[1]!);
    const parts = quoted.length ? quoted : said.split(/,|\bor\b|\band\b/i);
    for (const p of parts) {
      const t = p.replace(/["“”.,]/g, ' ').replace(/\s+/g, ' ').trim();
      if (t && t.split(' ').length <= 4 && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- words

/** A country and the adjective for it read as one word. General language, nothing about the store. */
const PLACE_FORMS: Readonly<Record<string, string>> = {
  mexican: 'mexico', canadian: 'canada', icelandic: 'iceland', alaskan: 'alaska', japanese: 'japan', hawaiian: 'hawaii',
  scottish: 'scotland', norwegian: 'norway', chilean: 'chile', american: 'usa', us: 'usa', faroese: 'faroe', danish: 'denmark',
  irish: 'ireland', spanish: 'spain', italian: 'italy', french: 'france', portuguese: 'portugal', peruvian: 'peru',
  ecuadorian: 'ecuador', vietnamese: 'vietnam', thai: 'thailand', chinese: 'china', korean: 'korea', australian: 'australia',
};

/** Trade words that can name the same thing, as pairs of stems. A match through one is offered, never confident. */
const RELATED: ReadonlyArray<readonly [string, string]> = [['trimming', 'scrap']];

/** Size words. They describe more than they name, and two different ones are worth a question. */
const SIZE_WORDS: ReadonlySet<string> = new Set(['small', 'medium', 'large', 'jumbo', 'huge', 'massive', 'colossal', 'giant', 'very', 'extra'].map(stem));
/** Words that count for less and never make a contradiction: descriptive words, sizes and "grade". */
const LOOSE_WORDS: ReadonlySet<string> = new Set([...DESCRIPTIVE_WORDS, ...SIZE_WORDS, stem('grade')]);

/** The places of PLACE_FORMS, as compared. */
const PLACES: ReadonlySet<string> = new Set(Object.values(PLACE_FORMS));

function canon(w: string): string {
  return PLACE_FORMS[w] ?? w;
}

/** Stems for comparing, with place adjectives folded to the place. */
function stemsOf(text: string): string[] {
  return words(text).map(canon);
}

/** The words as written, folded, stop words kept: for spotting two words written as one. */
function rawWords(text: string): string[] {
  return foldText(text).replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/** The words of a text, as written, that compare as these stems. For showing a person. */
function shown(stems: string[], text: string): string[] {
  const written = text.split(/[\s,()/&:]+/).map((w) => w.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  const out: string[] = [];
  for (const s of stems) {
    const w = written.find((x) => stemsOf(x).includes(s)) ?? s;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Folded raw words shown as written in the text ("big eye" from "Big Eye Tuna"). */
function shownRaw(raws: string[], text: string): string {
  const written = text.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
  return raws.map((r) => written.find((w) => rawWords(w).join('') === r) ?? r).join(' ');
}

type Range = readonly [number, number];

const RANGE = /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*(?:lbs?\b|#|pounds?\b)?/i;
const PLUS = /(\d+(?:\.\d+)?)\s*\+\s*(?:lbs?\b|#|pounds?\b)?/i;
/** A count per pound, as shrimp are sold ("21/25"). Not compared: Square names leave it out. */
const COUNT = /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/;

/** Takes a size range and a count out of a name, so their numbers are compared as sizes, not as words. */
function takeSizes(text: string): { text: string; range: Range | null } {
  let t = text;
  let range: Range | null = null;
  const r = RANGE.exec(t);
  if (r && Number(r[1]) < Number(r[2]) && Number(r[2]) <= 100) {
    range = [Number(r[1]), Number(r[2])];
    t = `${t.slice(0, r.index)} ${t.slice(r.index + r[0].length)}`;
  } else {
    // "5+ lb": read as 5 to 10 lb, so it overlaps no range that ends below 5.
    const p = PLUS.exec(t);
    if (p && Number(p[1]) > 0 && Number(p[1]) <= 100) {
      range = [Number(p[1]), Number(p[1]) * 2];
      t = `${t.slice(0, p.index)} ${t.slice(p.index + p[0].length)}`;
    }
  }
  const c = COUNT.exec(t);
  if (c && Number(c[1]) < Number(c[2])) t = `${t.slice(0, c.index)} ${t.slice(c.index + c[0].length)}`;
  return { text: t, range };
}

interface Side {
  /** The text as written, for showing words to a person. */
  text: string;
  stems: string[];
  raws: string[];
  range: Range | null;
}

function side(text: string): Side {
  const { text: t, range } = takeSizes(text);
  return { text, stems: stemsOf(t), raws: rawWords(t), range };
}

/** One way to read a row: its own name, or a name the email gives it. */
interface RowReading {
  main: Side;
  /** Origin stems: they confirm a Square word but are never required. */
  origin: string[];
  /** Tag stems ("wild", "usa"), the same. */
  tags: string[];
  /** The name the email gives, when this reading uses one. */
  alias: string | null;
}

/** A Square variation as compared. */
interface Doc {
  item: CatalogItem;
  variation: CatalogVariation;
  /** The name a person sees, with the variation when it tells them apart. */
  label: string;
  maker: Set<string>;
  /** The bracketed parts of the Square name ("(wild)"): a detail, not the product. */
  brackets: string[];
  bracketStems: Set<string>;
  main: Side;
  /** In the category matched first. Set once that category is known (useCategory). */
  inCategory: boolean;
  /** The item's first category, for showing a person, or ''. */
  category: string;
  categories: string[];
}

// ---------------------------------------------------------------- comparing

interface Join {
  /** The word written as one. */
  one: string;
  /** The same written as two or three words. */
  parts: string;
}

interface Fit {
  score: number;
  /** Row words neither matched nor loose. */
  rowLeft: string[];
  /** Square words neither matched nor loose nor the maker's. */
  docLeft: string[];
  /** Square words outside brackets that nothing on the row explains. */
  docExtra: string[];
  /** Bracketed parts of the Square name with a word nothing on the row explains. */
  bracketsLeft: string[];
  /** Square words matched only by the row's origin or tags. */
  byOrigin: string[];
  byTags: string[];
  joins: Join[];
  /** [row word, Square word] pairs one letter apart. */
  spelled: Array<[string, string]>;
  /** [row word, Square word] pairs of related trade words. */
  related: Array<[string, string]>;
  /** Share of the two size ranges that overlap, when both sides give one. */
  rangeFit: number | null;
  /** The two names read as the same text. */
  sameName: boolean;
}

interface Weights {
  of(stem: string): number;
}

function makeWeights(docs: Doc[], itemCount: number): Weights {
  const perItem = new Map<string, Set<string>>();
  for (const d of docs) {
    const set = perItem.get(d.item.id) ?? new Set<string>();
    for (const w of d.main.stems) set.add(w);
    perItem.set(d.item.id, set);
  }
  const df = new Map<string, number>();
  for (const set of perItem.values()) for (const w of set) df.set(w, (df.get(w) ?? 0) + 1);
  return {
    of(w: string): number {
      const n = df.get(w) ?? 0;
      const base = Math.max(0.3, Math.log((itemCount + 1) / (n === 0 ? 3 : n)));
      if (/\d/.test(w)) return base * 0.3;
      return LOOSE_WORDS.has(w) ? base * 0.4 : base;
    },
  };
}

/** Marks words of one side matched by two or three neighbouring words of the other ("skatewing", "skate wing"). */
function joinWords(one: Side, credit: number[], parts: Side, partsCredit: number[], joins: Join[]): void {
  for (let i = 0; i < one.stems.length; i++) {
    if (credit[i]! > 0 || /\d/.test(one.stems[i]!)) continue;
    for (let span = 2; span <= 3 && credit[i] === 0; span++) {
      for (let j = 0; j + span <= parts.raws.length && credit[i] === 0; j++) {
        const run = parts.raws.slice(j, j + span);
        const glued = run.join('');
        if (glued.length < 5 || (glued !== one.stems[i] && canon(stem(glued)) !== one.stems[i])) continue;
        credit[i] = 1;
        joins.push({ one: shown([one.stems[i]!], one.text)[0]!, parts: shownRaw(run, parts.text) });
        for (const p of run) {
          for (const s of stemsOf(p)) {
            const k = parts.stems.findIndex((o, n) => o === s && partsCredit[n] === 0);
            if (k >= 0) partsCredit[k] = 1;
          }
        }
      }
    }
  }
}

function folded(text: string): string {
  return foldText(text).replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function compare(row: RowReading, doc: Doc, weights: Weights): Fit {
  const r = row.main.stems;
  const d = doc.main.stems;
  const rc = r.map(() => 0);
  const dc = d.map(() => 0);
  const joins: Join[] = [];
  const spelled: Array<[string, string]> = [];
  const related: Array<[string, string]> = [];
  // 1. Equal words.
  for (let j = 0; j < d.length; j++) {
    const i = r.findIndex((w, k) => rc[k] === 0 && w === d[j]);
    if (i >= 0) rc[i] = dc[j] = 1;
  }
  // 2. Two or three words written as one, either way round.
  joinWords(row.main, rc, doc.main, dc, joins);
  joinWords(doc.main, dc, row.main, rc, joins);
  // 3. One letter different in a longer word ("arctic", "artic").
  for (let i = 0; i < r.length; i++) {
    if (rc[i]! > 0 || r[i]!.length < 5 || /\d/.test(r[i]!)) continue;
    const j = d.findIndex((w, k) => dc[k] === 0 && w.length >= 5 && !/\d/.test(w) && withinOneEdit(w, r[i]!));
    if (j >= 0) {
      rc[i] = dc[j] = 0.8;
      spelled.push([r[i]!, d[j]!]);
    }
  }
  // 4. Trade words that can name the same thing.
  for (let i = 0; i < r.length; i++) {
    if (rc[i]! > 0) continue;
    const j = d.findIndex((w, k) => dc[k] === 0 && RELATED.some(([a, b]) => (a === r[i] && b === w) || (b === r[i] && a === w)));
    if (j >= 0) {
      rc[i] = dc[j] = 0.7;
      related.push([r[i]!, d[j]!]);
    }
  }
  // 5. Square words the origin or the tags confirm.
  const byOrigin: string[] = [];
  const byTags: string[] = [];
  for (let j = 0; j < d.length; j++) {
    if (dc[j]! > 0) continue;
    const w = d[j]!;
    const near = (list: string[]) => list.includes(w) || (w.length >= 5 && list.some((x) => x.length >= 5 && withinOneEdit(x, w)));
    if (near(row.origin)) {
      dc[j] = 0.6;
      byOrigin.push(w);
    } else if (near(row.tags)) {
      dc[j] = 0.6;
      byTags.push(w);
    }
  }

  let have = 0;
  let total = 0;
  d.forEach((w, j) => {
    const wt = weights.of(w);
    have += wt * dc[j]!;
    // A maker word the row leaves out costs half: the email names the fish, not the brand.
    total += dc[j]! > 0 || !doc.maker.has(w) ? wt : wt * 0.5;
  });
  const recall = total > 0 ? have / total : 0;
  let rowHave = 0;
  let rowTotal = 0;
  r.forEach((w, i) => {
    const wt = weights.of(w);
    rowHave += wt * rc[i]!;
    rowTotal += wt;
  });
  const precision = rowTotal > 0 ? rowHave / rowTotal : 0;
  let score = 0.6 * recall + 0.4 * precision;

  let rangeFit: number | null = null;
  if (row.main.range && doc.main.range) {
    const [a, b] = row.main.range;
    const [c, e] = doc.main.range;
    rangeFit = Math.max(0, Math.min(b, e) - Math.max(a, c)) / (Math.max(b, e) - Math.min(a, c));
    score += rangeFit >= 0.8 ? 0.05 : rangeFit === 0 ? -0.3 : 0;
  }
  const loose = (w: string) => LOOSE_WORDS.has(w);
  const unmatched = d.filter((_, j) => dc[j] === 0);
  return {
    score,
    rowLeft: r.filter((w, i) => rc[i] === 0 && !loose(w)),
    docLeft: d.filter((w, j) => dc[j] === 0 && !loose(w) && !doc.maker.has(w)),
    docExtra: d.filter((w, j) => dc[j] === 0 && !loose(w) && !/\d/.test(w) && !doc.bracketStems.has(w)),
    bracketsLeft: doc.brackets.filter((b) => stemsOf(b).some((s) => unmatched.includes(s))),
    byOrigin,
    byTags,
    joins,
    spelled,
    related,
    rangeFit,
    sameName: folded(row.main.text) === folded(doc.main.text),
  };
}

// ---------------------------------------------------------------- candidates

type Flag =
  | 'alias'
  | 'related'
  | 'other_category'
  | 'not_available'
  | 'shared'
  | 'close_second'
  | 'size_partial'
  | 'size_differs'
  | 'size_words'
  | 'extra_words';

interface Candidate {
  doc: Doc;
  score: number;
  fit: Fit;
  reading: RowReading;
  flags: Set<Flag>;
}

/** Lowest score offered at all. */
const PLAUSIBLE = 0.45;
/** Lowest score called confident, with no flag and a clear lead. */
const CONFIDENT = 0.8;
/** Lowest score called confident when every row word is in the Square name and Square only adds a bracketed detail. */
const CONFIDENT_FULL = 0.55;
/** How far ahead of the next item a confident match must be. */
const LEAD = 0.15;
/** Lowest score shown as another choice. */
const SHOWN_CHOICE = 0.55;

function sizeWordsOf(stems: string[]): string[] {
  return [...new Set(stems.filter((w) => SIZE_WORDS.has(w)))].sort();
}

function candidateFor(row: EmailRow | OtherRow, reading: RowReading, doc: Doc, weights: Weights): Candidate | null {
  const fit = compare(reading, doc, weights);
  // Each side has a word the other lacks: a different product, however much else is shared.
  if (fit.rowLeft.length > 0 && fit.docLeft.length > 0) return null;
  if (fit.score <= 0) return null;
  const flags = new Set<Flag>();
  let score = fit.score;
  const v = doc.variation;
  const unit = 'unit' in row ? row.unit : null;
  // Sold the way the row is sold: by the pound, or by the piece.
  if (unit === 'lb') score += soldByWeightKind(doc.item) ? 0.03 : -0.03;
  else if (unit) score += v.perPound ? -0.03 : v.pricing === 'fixed' ? 0.03 : 0;
  // The same price, on the same footing, is good evidence.
  if ('priceCents' in row && v.pricing === 'fixed' && v.priceCents === row.priceCents && (row.unit === 'lb') === v.perPound) score += 0.05;
  if (!doc.inCategory) {
    score *= 0.85;
    flags.add('other_category');
  }
  if (doc.item.archived || !doc.item.availableHere || !v.availableHere) {
    score *= 0.7;
    flags.add('not_available');
  }
  if (reading.alias) {
    score *= 0.9;
    flags.add('alias');
  }
  if (fit.related.length) flags.add('related');
  if (fit.rangeFit === 0) flags.add('size_differs');
  else if (fit.rangeFit !== null && fit.rangeFit < 0.8) flags.add('size_partial');
  const rs = sizeWordsOf(reading.main.stems);
  const ds = sizeWordsOf(doc.main.stems);
  if (rs.length && ds.length && rs.join() !== ds.join()) {
    flags.add('size_words');
    score -= 0.1;
  }
  if (fit.docExtra.length) flags.add('extra_words');
  score = Math.max(0, Math.min(1, score));
  if (score < PLAUSIBLE) return null;
  return { doc, score, fit, reading, flags };
}

function readingsOf(row: RowText): RowReading[] {
  const origin = stemsOf(row.origin);
  const tags = row.tags.flatMap(stemsOf);
  const own: RowReading = { main: side(row.name), origin, tags, alias: null };
  return [own, ...namesGiven(row.description).map((a) => ({ main: side(a), origin, tags, alias: a }))];
}

/** Every plausible Square variation for a row, best first, one per variation. */
function rank(row: EmailRow | OtherRow, docs: Doc[], weights: Weights): Candidate[] {
  const best = new Map<string, Candidate>();
  for (const reading of readingsOf(row)) {
    for (const doc of docs) {
      const c = candidateFor(row, reading, doc, weights);
      const had = best.get(doc.variation.id);
      if (c && (!had || c.score > had.score)) best.set(doc.variation.id, c);
    }
  }
  const all = [...best.values()].sort((a, b) => b.score - a.score || a.doc.label.localeCompare(b.doc.label));
  // Another category only when nothing in the main category fits as well.
  const topInCategory = all.find((c) => c.doc.inCategory);
  return topInCategory ? all.filter((c) => c.doc.inCategory || c.score > topInCategory.score + 0.2) : all;
}

/**
 * The one general item of the main category named for a section, such as a "Clams" item for a
 * "Clams" section, or null. Never offered as a match: it is named so the kinds can be added.
 */
function sectionItem(section: string, docs: Doc[]): Doc | null {
  const want = [...new Set(stemsOf(section))].sort().join(' ');
  if (want === '') return null;
  const found = docs.filter((d) => d.inCategory && [...new Set(d.main.stems)].sort().join(' ') === want);
  return found.length === 1 ? found[0]! : null;
}

// ---------------------------------------------------------------- output shapes

interface SquareFacts {
  itemId: string;
  variationId: string;
  squareName: string;
  variationName: string;
  category: string;
  /** The 4-digit code at the end of the Square name, when it counts as a scale code. */
  scaleCode: string | null;
  /** The code the variation's UPC is built from, when it is built from one. */
  upcBuiltFromCode: string | null;
  /** "12.99", or null when Square has no price (taken at the register). */
  squarePrice: string | null;
  /** fixed, or variable: the price is taken at the register. */
  squarePricing: 'fixed' | 'variable' | 'other';
  /** lb: Square's per-pound unit. each: no unit. other: some other unit. */
  squareUnit: 'lb' | 'each' | 'other';
  /** Fixed price per pound with the per-pound unit (CLAUDE.md rule 12). */
  soldByWeight: boolean;
  /** Why an item with a scale code is not sold by weight, as the catalog check words it. */
  byWeightProblems: string[];
}

type Confidence = 'high' | 'medium' | 'low' | 'none';

interface Alternative {
  variationId: string;
  squareName: string;
  score: number;
  /** The row this item is proposed for instead, if any. */
  proposedFor: string | null;
  flags: Flag[];
}

interface RowProposal {
  row: number;
  rowKey: string;
  section: string;
  group: string;
  emailName: string;
  origin: string;
  unit: Unit;
  price: string;
  tags: string[];
  highlights: string[];
  struck: boolean;
  proposal: SquareFacts | null;
  /**
   * For a row with no item: the one general item Square has for the row's whole section, if any.
   * Never a match: each kind gets its own item or variation (DECISIONS.md, November 9).
   */
  sectionItem: { itemId: string; variationId: string; squareName: string } | null;
  confidence: Confidence;
  /** True when this can go in the list Bart confirms all at once. */
  sure: boolean;
  /** The origin in brackets helped pick the item, so it is shown beside the name. */
  originUsed: boolean;
  score: number | null;
  reason: string;
  flags: Flag[];
  alternatives: Alternative[];
  /** Price or unit differences between the email and Square. Listed, not judged. */
  differences: string[];
  /** Things about the Square item worth knowing, such as a scale code that only the barcode carries. */
  squareNotes: string[];
  /** The number of the line about this row in match-questions.md. */
  question: number | null;
}

function money(cents: number | null): string | null {
  return cents === null ? null : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function facts(doc: Doc): SquareFacts {
  const v = doc.variation;
  return {
    itemId: doc.item.id,
    variationId: v.id,
    squareName: doc.label,
    variationName: v.name,
    category: doc.category,
    scaleCode: doc.item.scaleCode,
    upcBuiltFromCode: v.upcFromScaleCode,
    squarePrice: v.pricing === 'variable' ? null : money(v.priceCents),
    squarePricing: v.pricing,
    squareUnit: v.perPound ? 'lb' : v.measurementUnitId === '' ? 'each' : 'other',
    soldByWeight: v.pricing === 'fixed' && v.perPound && v.priceCents !== null,
    byWeightProblems: doc.item.byWeight.problems,
  };
}

const UNIT_WORD: Readonly<Record<Unit, string>> = { lb: 'per lb', doz: 'per dozen', can: 'per can', unit: 'per unit' };

function squarePriceWords(f: SquareFacts): string {
  if (f.squarePricing === 'variable') return 'Square takes the price at the register';
  if (f.squarePrice === null) return 'Square has no price set';
  return `Square $${f.squarePrice} ${f.squareUnit === 'lb' ? 'per lb' : f.squareUnit === 'each' ? 'each' : 'per the unit set in Square'}`;
}

/** The price or unit difference between a row and its Square item, in plain words, or null. */
function priceDifference(row: EmailRow, f: SquareFacts): string | null {
  const byPound = row.unit === 'lb';
  const same = f.squarePricing === 'fixed' && f.squarePrice === row.price && byPound === (f.squareUnit === 'lb') && f.squareUnit !== 'other';
  // A per-pound row on an item priced at the register is the November 6 switch, counted apart.
  if (same || (f.squarePricing === 'variable' && byPound)) return null;
  return `Email $${row.price} ${UNIT_WORD[row.unit]}. ${squarePriceWords(f)}.`;
}

// ---------------------------------------------------------------- reasons in plain words

function quote(list: string[]): string {
  const q = list.map((w) => `"${w}"`);
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

function shownRange(r: Range | null): string {
  return r ? `${r[0]} to ${r[1]} lb` : 'no size';
}

/** Why a candidate is offered, in plain words. category: the Square category matched first. */
function reasonFor(c: Candidate, category: string): string {
  const f = c.fit;
  const rowText = c.reading.main.text;
  const sq = c.doc.main.text;
  const parts: string[] = [];
  if (c.reading.alias) parts.push(`The email says it is also called ${c.reading.alias}.`);
  for (const p of f.related) parts.push(`The email says "${shown([p[0]], rowText)[0]}" where Square says "${shown([p[1]], sq)[0]}".`);
  for (const j of f.joins) parts.push(`One name writes "${j.one}", the other "${j.parts}".`);
  for (const p of f.spelled) parts.push(`Square spells it "${shown([p[1]], sq)[0]}".`);
  if (c.flags.has('size_partial') || c.flags.has('size_differs')) {
    parts.push(`The sizes ${c.flags.has('size_partial') ? 'overlap only in part' : 'differ'}: ${shownRange(c.reading.main.range)} on the email, ${shownRange(c.doc.main.range)} in Square.`);
  } else if (f.rangeFit !== null) parts.push('Same size range.');
  if (c.flags.has('size_words')) {
    const sizes = (s: Side) => shown([...new Set(s.stems.filter((w) => SIZE_WORDS.has(w)))], s.text).join(' ');
    parts.push(`The sizes are named differently: "${sizes(c.reading.main)}" on the email, "${sizes(c.doc.main)}" in Square.`);
  }
  if (f.docExtra.length) parts.push(`Square adds ${quote(shown(f.docExtra, sq))}.`);
  if (f.bracketsLeft.length) parts.push(`Square adds ${quote(f.bracketsLeft.map((b) => `(${b})`))}.`);
  // Worth saying only when the origin or tags tell items apart: a detail in brackets, or a place.
  const telling = (w: string) => c.doc.bracketStems.has(w) || PLACES.has(w);
  const byOrigin = f.byOrigin.filter(telling);
  const byTags = f.byTags.filter(telling);
  if (byOrigin.length || byTags.length) {
    const fitting = shown([...byOrigin, ...byTags], sq);
    parts.push(`Square's ${quote(fitting)} ${fitting.length > 1 ? 'fit' : 'fits'} the email's ${byOrigin.length ? 'origin' : 'tags'}${byOrigin.length && byTags.length ? ' and tags' : ''}.`);
  }
  if (f.rowLeft.length && !c.reading.alias) parts.push(`Square leaves out ${quote(shown(f.rowLeft, rowText))}.`);
  if (c.flags.has('other_category')) parts.push(c.doc.category ? `It is in ${c.doc.category}, not ${category}.` : 'It has no category in Square.');
  if (c.flags.has('not_available')) parts.push('It is archived, or not offered at the store, in Square.');
  if (parts.length === 0) parts.push(f.sameName ? 'Same name.' : 'Same words.');
  return parts.join(' ');
}

// ---------------------------------------------------------------- main

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function readText(path: string): string {
  if (statSync(path).size > MAX_FILE) throw new Error(`${basename(path)} is larger than expected. Stopping.`);
  return readFileSync(path, 'utf8');
}

interface CampaignInfo {
  id: string;
  title: string;
  status: string;
  sendTime: string;
}

function readCampaigns(path: string): CampaignInfo[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readText(path)) as { campaigns?: unknown[] };
  const out: CampaignInfo[] = [];
  for (const c of raw.campaigns ?? []) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const settings = (o.settings ?? {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' && /^[a-z0-9]{6,20}$/.test(o.id) ? o.id : '';
    if (!id) continue;
    out.push({
      id,
      title: htmlText(String(settings.title ?? '')).slice(0, 120),
      status: String(o.status ?? '').replace(/[^a-z_]/g, '').slice(0, 20),
      sendTime: String(o.send_time || o.create_time || '').replace(/[^0-9T:+\-Z.]/g, '').slice(0, 30),
    });
  }
  return out;
}

function writePrivate(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const p = join(dir, name);
  writeFileSync(p, text, { mode: 0o600 });
  chmodSync(p, 0o600);
  return p;
}

/** Every Square variation, ready to compare. All count as in the main category until useCategory. */
function buildDocs(index: CatalogIndex): Doc[] {
  const docs: Doc[] = [];
  for (const item of index.items) {
    const brackets = [...item.baseName.matchAll(/\(([^)]{1,80})\)/g)].map((m) => m[1]!.trim()).filter(Boolean);
    for (const v of item.variations) {
      const variationWords = v.label === item.name.trim() ? '' : ` ${v.name}`;
      docs.push({
        item,
        variation: v,
        label: v.label.trim(),
        maker: new Set(stemsOf(item.maker)),
        brackets,
        bracketStems: new Set(brackets.flatMap(stemsOf)),
        main: side(`${item.maker ? `${item.maker} ` : ''}${item.product}${variationWords}`),
        inCategory: true,
        category: item.categoryNames[0] ?? '',
        categories: item.categoryNames,
      });
    }
  }
  return docs;
}

/**
 * The category matched first: the one named, or else the category most rows' best fits are in.
 * Returns its name as Square spells it, or null when no item is in it.
 */
function useCategory(named: string | undefined, rows: EmailRow[], docs: Doc[], weights: Weights): string | null {
  let want = named ? folded(named) : '';
  if (!want) {
    const tally = new Map<string, number>();
    for (const r of rows) for (const c of rank(r, docs, weights)[0]?.doc.categories ?? []) tally.set(folded(c), (tally.get(folded(c)) ?? 0) + 1);
    want = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
  }
  for (const d of docs) d.inCategory = d.categories.some((n) => folded(n) === want);
  return docs.flatMap((d) => d.categories).find((n) => folded(n) === want) ?? null;
}

interface Assigned {
  row: EmailRow;
  ranked: Candidate[];
  chosen: Candidate | null;
}

/**
 * Gives each Square variation to the row that fits it best, best fits first. A row whose every
 * choice went to rows that fit better shares its first choice. A row with no choice has none.
 */
function assign(rows: EmailRow[], ranked: Map<number, Candidate[]>): Map<number, Assigned> {
  const out = new Map<number, Assigned>();
  const taken = new Set<string>();
  const pairs = rows.flatMap((r) => (ranked.get(r.row) ?? []).map((c) => ({ r, c })));
  pairs.sort((a, b) => b.c.score - a.c.score || a.r.row - b.r.row);
  for (const { r, c } of pairs) {
    if (out.has(r.row) || taken.has(c.doc.variation.id)) continue;
    taken.add(c.doc.variation.id);
    out.set(r.row, { row: r, ranked: ranked.get(r.row) ?? [], chosen: c });
  }
  for (const r of rows) {
    if (out.has(r.row)) continue;
    const list = ranked.get(r.row) ?? [];
    const first = list[0];
    out.set(r.row, { row: r, ranked: list, chosen: first ? { ...first, flags: new Set([...first.flags]) } : null });
  }
  // Every row of an item more than one row points to is asked about together.
  const users = new Map<string, number>();
  for (const a of out.values()) if (a.chosen) users.set(a.chosen.doc.variation.id, (users.get(a.chosen.doc.variation.id) ?? 0) + 1);
  for (const a of out.values()) if (a.chosen && users.get(a.chosen.doc.variation.id)! > 1) a.chosen.flags.add('shared');
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A proposal for every row, with its confidence, reason, other choices and price differences. */
function proposeAll(rows: EmailRow[], docs: Doc[], weights: Weights, category: string): RowProposal[] {
  const ranked = new Map<number, Candidate[]>();
  for (const r of rows) ranked.set(r.row, rank(r, docs, weights));
  const assigned = assign(rows, ranked);
  const chosenFor = new Map<string, number[]>();
  for (const a of assigned.values()) if (a.chosen) chosenFor.set(a.chosen.doc.variation.id, [...(chosenFor.get(a.chosen.doc.variation.id) ?? []), a.row.row]);
  const nameOf = (n: number) => rows[n - 1]!.rowKey;

  return rows.map((r) => {
    const a = assigned.get(r.row)!;
    const c = a.chosen;
    const others = a.ranked.filter((x) => !c || x.doc.variation.id !== c.doc.variation.id);
    // A rival is another item near this row's choice. An item another row fits better, while this
    // row fits its own choice better, is that row's and no rival.
    const rival = c
      ? others.find((x) => {
          const owners = (chosenFor.get(x.doc.variation.id) ?? []).filter((o) => o !== r.row);
          const ownerFitsBetter = owners.some((o) => (assigned.get(o)!.chosen?.score ?? 0) >= x.score + 0.05);
          const sizeMismatch = (x.flags.has('size_words') || x.flags.has('size_differs')) && !c.flags.has('size_words') && !c.flags.has('size_differs');
          return !(ownerFitsBetter && c.score >= x.score + 0.05) && !sizeMismatch;
        })
      : undefined;
    if (c && rival && c.score - rival.score < LEAD) c.flags.add('close_second');

    const flags = c ? [...c.flags].sort() : [];
    const fullFit = !!c && c.fit.rowLeft.length === 0 && c.fit.docExtra.length === 0;
    let confidence: Confidence = 'none';
    if (c) confidence = flags.length === 0 && (c.score >= CONFIDENT || (fullFit && c.score >= CONFIDENT_FULL)) ? 'high' : c.score >= 0.6 ? 'medium' : 'low';

    const general = c ? null : sectionItem(r.section, docs);
    let reason: string;
    if (general) {
      reason = `No Square item for this kind. Square has one ${general.label} item for the whole ${r.section} section, not one per kind.`;
    } else if (!c) {
      const near = nearestNames(r, docs, weights);
      reason = near.length ? `No Square item fits. Searched all of Square. Names sharing a word: ${near.join('; ')}.` : 'No Square item fits. Searched all of Square: no name shares a word with it.';
    } else {
      reason = reasonFor(c, category);
      const sharers = (chosenFor.get(c.doc.variation.id) ?? []).filter((n) => n !== r.row);
      if (sharers.length) reason += ` ${sharers.length === 1 ? `"${nameOf(sharers[0]!)}" also points to it.` : `${sharers.length} other rows also point to it.`}`;
      // A rival that is another row's guess shows among the other choices instead.
      const rivalOwned = !!rival && (chosenFor.get(rival.doc.variation.id) ?? []).some((o) => o !== r.row);
      if (c.flags.has('close_second') && rival && !rivalOwned) reason += ` ${rival.doc.label} fits nearly as well.`;
    }
    const f = c ? facts(c.doc) : null;
    const diff = f ? priceDifference(r, f) : null;
    return {
      row: r.row,
      rowKey: r.rowKey,
      section: r.section,
      group: r.group,
      emailName: r.name,
      origin: r.origin,
      unit: r.unit,
      price: r.price,
      tags: r.tags,
      highlights: r.highlights,
      struck: r.struck,
      proposal: f,
      sectionItem: general ? { itemId: general.item.id, variationId: general.variation.id, squareName: general.label } : null,
      confidence,
      sure: confidence === 'high',
      originUsed: !!c && c.fit.byOrigin.length > 0,
      score: c ? round(c.score) : null,
      reason,
      flags,
      alternatives: others.slice(0, 3).map((x) => {
        const owner = (chosenFor.get(x.doc.variation.id) ?? []).find((o) => o !== r.row);
        return { variationId: x.doc.variation.id, squareName: x.doc.label, score: round(x.score), proposedFor: owner ? nameOf(owner) : null, flags: [...x.flags].sort() };
      }),
      differences: diff ? [diff] : [],
      squareNotes: [
        ...(f && f.byWeightProblems.length ? [`Has scale code ${f.scaleCode} but is not sold by weight in Square.`] : []),
        ...(f && !f.scaleCode && f.upcBuiltFromCode ? [`The Square name has no scale code, but its barcode is built from ${f.upcBuiltFromCode}.`] : []),
      ],
      question: null,
    };
  });
}

/** Square names that share a word with the row, for "searched, found nothing". */
function nearestNames(row: EmailRow, docs: Doc[], weights: Weights): string[] {
  const want = new Set(side(row.name).stems.filter((w) => !LOOSE_WORDS.has(w) && !/\d/.test(w)));
  const scored: Array<[string, number]> = [];
  for (const d of docs) {
    const shared = [...new Set(d.main.stems.filter((w) => want.has(w)))];
    if (shared.length) scored.push([d.label, shared.reduce((s, w) => s + weights.of(w), 0) + (d.inCategory ? 1 : 0)]);
  }
  return [...new Map(scored.sort((a, b) => b[1] - a[1])).keys()].slice(0, 3);
}

interface OtherProposal {
  rowKey: string;
  section: string;
  group: string;
  emailName: string;
  origin: string;
  priceText: string;
  why: string;
  proposal: SquareFacts | null;
  score: number | null;
  reason: string;
}

interface WithoutRow {
  itemId: string;
  squareName: string;
  variations: Array<{ variationId: string; name: string; squarePrice: string | null }>;
  scaleCode: string | null;
  upcBuiltFromCode: string | null;
  squarePricing: SquareFacts['squarePricing'];
  squareUnit: SquareFacts['squareUnit'];
  soldByWeight: boolean;
  /** An email row without a standard price that seems to be this item. */
  onEmailWithoutStandardPrice: string | null;
  /** The email section this general item is named for, and how many rows of kinds it has. */
  forSection: { section: string; rows: number } | null;
}

async function main(): Promise<void> {
  const mcDir = join(repo, 'data/mailchimp');
  const campaignsPath = arg('--campaigns') ?? join(mcDir, 'campaigns.json');
  const catalogPath = arg('--catalog') ?? join(repo, 'data/square/live-catalog.json');
  const outDir = arg('--out') ?? mcDir;
  const campaigns = readCampaigns(campaignsPath);
  let emailPath = arg('--email');
  if (!emailPath) {
    const latest = campaigns
      .filter((c) => c.status === 'sent' && existsSync(join(mcDir, `content-${c.id}.html`)))
      .sort((a, b) => b.sendTime.localeCompare(a.sendTime))[0];
    if (!latest) throw new Error('No saved sent campaign found. Run scripts/mailchimp/read-recent.ts first, or pass --email.');
    emailPath = join(mcDir, `content-${latest.id}.html`);
  }
  if (!existsSync(emailPath)) throw new Error(`No email at ${emailPath}.`);
  if (!existsSync(catalogPath)) throw new Error(`No catalog at ${catalogPath}. Run scripts/square/snapshot-live.ts first.`);
  const campaignId = /content-([a-z0-9]{6,20})\.html$/.exec(emailPath)?.[1] ?? '';
  const campaign = campaigns.find((c) => c.id === campaignId);

  const { rows, other } = parseFishEmail(readText(emailPath));
  if (rows.length === 0) throw new Error('No priced rows found in the email. Has its layout changed?');
  const raw = JSON.parse(readText(catalogPath)) as { objects: unknown[]; location?: { id?: string }; takenAt?: string };
  const index = buildCatalogIndex({ objects: raw.objects, locationId: raw.location?.id ?? '' });
  const docs = buildDocs(index);
  const weights = makeWeights(docs, index.itemCount);
  const category = useCategory(arg('--category'), rows, docs, weights);
  if (!category) throw new Error(arg('--category') ? `No Square item is in the category "${arg('--category')}".` : 'No category holds the best matches. Name one with --category.');

  const proposals = proposeAll(rows, docs, weights, category);

  // Rows priced another way, or not at all: a best guess only, for reference.
  const otherOut: OtherProposal[] = other.map((o) => {
    const c = rank(o, docs, weights).find((x) => !x.flags.has('size_differs'));
    return {
      rowKey: o.rowKey,
      section: o.section,
      group: o.group,
      emailName: o.name,
      origin: o.origin,
      priceText: o.priceText,
      why: o.why,
      proposal: c ? facts(c.doc) : null,
      score: c ? round(c.score) : null,
      reason: c ? reasonFor(c, category) : 'No Square item fits by name.',
    };
  });

  // Items of the main category no row points to.
  const used = new Set(proposals.flatMap((p) => (p.proposal ? [p.proposal.variationId] : [])));
  const onOther = new Map(otherOut.flatMap((o) => (o.proposal ? [[o.proposal.itemId, o.emailName] as const] : [])));
  const withoutRow: WithoutRow[] = index.items
    .filter((i) => docs.some((d) => d.item === i && d.inCategory) && i.variations.every((v) => !used.has(v.id)))
    .map((i) => {
      const f = facts(docs.find((d) => d.item === i)!);
      const kinds = proposals.filter((p) => p.sectionItem?.itemId === i.id);
      return {
        itemId: i.id,
        squareName: i.name.trim(),
        variations: i.variations.map((v) => ({ variationId: v.id, name: v.name, squarePrice: v.pricing === 'variable' ? null : money(v.priceCents) })),
        scaleCode: f.scaleCode,
        upcBuiltFromCode: f.upcBuiltFromCode,
        squarePricing: f.squarePricing,
        squareUnit: f.squareUnit,
        soldByWeight: f.soldByWeight,
        onEmailWithoutStandardPrice: onOther.get(i.id) ?? null,
        forSection: kinds.length ? { section: kinds[0]!.section, rows: kinds.length } : null,
      };
    })
    .sort((a, b) => a.squareName.localeCompare(b.squareName));

  // A barcode built from a code another item's name ends in.
  const codeOwners = new Map(index.items.filter((i) => i.scaleCode).map((i) => [i.scaleCode!, i.name.trim()] as const));
  const clashes = [
    ...new Map(
      docs
        .filter((d) => d.inCategory && d.variation.upcFromScaleCode && d.variation.upcFromScaleCode !== d.item.scaleCode && codeOwners.has(d.variation.upcFromScaleCode))
        .map((d) => [d.variation.id, `${d.label}: its barcode is built from ${d.variation.upcFromScaleCode}, the code at the end of ${codeOwners.get(d.variation.upcFromScaleCode!)}.`] as const),
    ).values(),
  ];

  const counts = {
    rows: rows.length,
    confident: proposals.filter((p) => p.sure).length,
    unsure: proposals.filter((p) => p.proposal && !p.sure).length,
    noSquareItem: proposals.filter((p) => !p.proposal).length,
    categoryItems: index.items.filter((i) => docs.some((d) => d.item === i && d.inCategory)).length,
    categoryItemsWithoutRow: withoutRow.length,
    otherRows: otherOut.length,
  };
  const md = questions({ proposals, other: otherOut, withoutRow, clashes, campaign, emailPath, catalogTakenAt: raw.takenAt ?? '', category });
  const proposal = {
    about: 'Proposed Square match for each priced row of the fish email, for Bart to confirm. Made by scripts/mailchimp/propose-matches.ts. Store data: never commit.',
    madeAt: new Date().toISOString(),
    email: { file: relative(repo, emailPath), campaignId, title: campaign?.title ?? '', sendTime: campaign?.sendTime ?? '' },
    catalog: { file: relative(repo, catalogPath), takenAt: raw.takenAt ?? '', category },
    counts,
    rows: proposals,
    otherRows: otherOut,
    categoryItemsWithoutRow: withoutRow,
    dataNotes: clashes,
  };
  const jsonPath = writePrivate(outDir, 'match-proposal.json', `${JSON.stringify(proposal, null, 2)}\n`);
  const mdPath = writePrivate(outDir, 'match-questions.md', md);
  console.log(`Rows: ${counts.rows}. Confident ${counts.confident}, unsure ${counts.unsure}, no Square item ${counts.noSquareItem}.`);
  console.log(`${category} items: ${counts.categoryItems}, with no row: ${counts.categoryItemsWithoutRow}. Rows priced another way or not at all: ${counts.otherRows}.`);
  console.log(`Wrote ${jsonPath} and ${mdPath}.`);
  if (process.argv.includes('--verbose')) {
    for (const p of proposals) {
      console.log(`${String(p.row).padStart(2)} ${p.confidence.padEnd(6)} ${String(p.score ?? '').padEnd(4)} ${p.rowKey} -> ${p.proposal?.squareName ?? '-'}  [${p.flags.join(',')}] ${p.reason} | alt: ${p.alternatives.map((x) => `${x.squareName} ${x.score}${x.proposedFor ? ` (${x.proposedFor})` : ''}`).join('; ')}`);
    }
  }
}

// ---------------------------------------------------------------- the questions for Bart

function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
}

function rowLabel(p: { emailName: string; origin: string }): string {
  return `${p.emailName}${p.origin ? ` (${p.origin})` : ''}`;
}

function priceLabel(p: RowProposal): string {
  return `$${p.price}/${p.unit}`;
}

function priceSpan(list: RowProposal[]): string {
  const cents = list.map((p) => Math.round(Number(p.price) * 100));
  const lo = Math.min(...cents);
  const hi = Math.max(...cents);
  return lo === hi ? `$${money(lo)}` : `$${money(lo)} to $${money(hi)}`;
}

interface QuestionInput {
  proposals: RowProposal[];
  other: OtherProposal[];
  withoutRow: WithoutRow[];
  clashes: string[];
  campaign: CampaignInfo | undefined;
  emailPath: string;
  catalogTakenAt: string;
  category: string;
}

/** The plain summary for Bart. Numbers run through the whole page so he can answer by number. */
function questions(q: QuestionInput): string {
  const { proposals } = q;
  const lines: string[] = [];
  let n = 0;
  const sure = proposals.filter((p) => p.sure);
  const unsure = proposals.filter((p) => p.proposal && !p.sure);
  const none = proposals.filter((p) => !p.proposal);
  const sent = q.campaign?.sendTime ? `, sent ${longDate(q.campaign.sendTime)}` : '';
  lines.push('# Fish email matches to confirm');
  lines.push('');
  lines.push(`Email: "${q.campaign?.title || basename(q.emailPath)}"${sent}. It has ${proposals.length} priced rows.`);
  lines.push(`Square: the copy of the live catalog from ${longDate(q.catalogTakenAt) || 'earlier'}.`);
  lines.push('Each email row is matched to its Square item once. After you confirm, ShelfReady uses the match every time.');
  lines.push(`Answer by number, for example: "1 to ${sure.length} yes. ${sure.length + 1} yes. ${sure.length + 2} no."`);
  lines.push('');

  lines.push(`## Confident matches (1 to ${sure.length})`);
  lines.push('');
  lines.push('Say "all yes", or give the numbers that are wrong.');
  lines.push('');
  for (const p of sure) {
    p.question = ++n;
    const f = p.proposal!;
    const showOrigin = p.origin !== '' && p.originUsed;
    const same = /^Same name\./.test(p.reason);
    lines.push(`${n}. ${showOrigin ? rowLabel(p) : p.emailName} → ${same ? `same name${f.scaleCode ? ` (${f.scaleCode})` : ''}` : f.squareName}`);
  }
  lines.push('');

  const firstUnsure = n + 1;
  lines.push(`## Not sure (${unsure.length} rows)`);
  lines.push('');
  lines.push('My best guess comes first. Say yes, or name the right item.');
  lines.push('');
  const done = new Set<number>();
  for (const p of unsure) {
    if (done.has(p.row)) continue;
    const f = p.proposal!;
    const group = p.flags.includes('shared') ? unsure.filter((x) => x.proposal?.variationId === f.variationId) : [p];
    n++;
    for (const g of group) {
      done.add(g.row);
      g.question = n;
    }
    if (group.length > 1) {
      const names = group.map((g) => `${g.emailName} (${priceLabel(g)})`).join(', ');
      lines.push(`${n}. ${group.length} rows point to ${f.squareName}: ${names}. Square has one item that fits ${group.length === 2 ? 'both' : 'them all'}. Best guess: ${group.length === 2 ? 'both go' : 'all go'} to it.`);
    } else {
      // Another choice whose size plainly differs is left out, unless this row's own sizes are in doubt.
      const sizesInDoubt = p.flags.includes('size_words') || p.flags.includes('size_partial');
      const alts = p.alternatives
        .filter((x) => x.score >= SHOWN_CHOICE && !x.flags.includes('size_differs') && (sizesInDoubt || !x.flags.includes('size_words')))
        .slice(0, 2)
        .map((x) => `${x.squareName}${x.proposedFor ? ` (my guess for ${x.proposedFor})` : ''}`);
      lines.push(`${n}. ${rowLabel(p)}, ${priceLabel(p)}. Best guess: ${f.squareName}. ${p.reason}${alts.length ? ` Other choices: ${alts.join('; ')}.` : ''}`);
    }
  }
  lines.push('');

  lines.push(`## Rows with no Square item (${none.length} rows)`);
  lines.push('');
  lines.push(`I searched all of Square, not just ${q.category}. Say if one is in Square under another name.`);
  lines.push('');
  // Three or more rows of one section with no item (the kinds of one shellfish) take one line.
  const bySection = new Map<string, RowProposal[]>();
  for (const p of none) bySection.set(p.section, [...(bySection.get(p.section) ?? []), p]);
  const listed = new Set<number>();
  for (const p of none) {
    if (listed.has(p.row)) continue;
    const same = bySection.get(p.section) ?? [p];
    const group = same.length >= 3 ? same : [p];
    n++;
    for (const g of group) {
      listed.add(g.row);
      g.question = n;
    }
    if (group.length === 1) {
      lines.push(`${n}. ${rowLabel(p)}, ${priceLabel(p)}${p.section ? `, under "${p.section}"` : ''}.`);
      continue;
    }
    const units = [...new Set(group.map((g) => g.unit))];
    const prices = group.map((g) => `${g.emailName} ($${g.price}${units.length > 1 ? `/${g.unit}` : ''})`).join(', ');
    const general = p.sectionItem ? ` Square has one ${p.sectionItem.squareName} item for them all, not one per kind.` : '';
    lines.push(`${n}. ${p.section}: ${group.length} rows${units.length === 1 ? `, ${UNIT_WORD[units[0]!]}` : ''}. ${prices}.${general}`);
  }
  if (none.some((p) => p.unit === 'doz')) {
    lines.push('');
    lines.push('Your November 9 decision gives each kind sold by the dozen its own Square item or variation. Until those exist, ShelfReady leaves the per-dozen rows alone.');
  }
  lines.push('');

  lines.push('## Price or unit differences');
  lines.push('');
  lines.push('Listed only, not judged.');
  lines.push('');
  const diffs = proposals.filter((p) => p.proposal && p.differences.length > 0);
  const grouped = new Map<string, RowProposal[]>();
  for (const p of diffs) {
    const key = p.question !== null && p.question >= firstUnsure && p.flags.includes('shared') ? `q${p.question}` : `r${p.row}`;
    grouped.set(key, [...(grouped.get(key) ?? []), p]);
  }
  for (const list of grouped.values()) {
    const p = list[0]!;
    const f = p.proposal!;
    if (list.length > 1) lines.push(`- The ${list.length} rows of number ${p.question}: email ${UNIT_WORD[p.unit]}, ${priceSpan(list)}. ${squarePriceWords(f)}.`);
    else lines.push(`- ${p.emailName} (see ${p.question}) → ${f.squareName}: ${p.differences[0]}`);
  }
  const atRegister = proposals.filter((p) => p.proposal?.squarePricing === 'variable' && p.unit === 'lb');
  if (atRegister.length) {
    lines.push(`- ${atRegister.length} other rows are priced per lb on the email, and their Square item takes the price at the register. Your November 6 decision already switches these to sold by weight.`);
  }
  const noCode = [...new Map(proposals.filter((p) => p.proposal && !p.proposal.scaleCode && p.proposal.upcBuiltFromCode).map((p) => [p.proposal!.variationId, p.proposal!])).values()];
  if (noCode.length) {
    lines.push(`- ${noCode.length} matched Square items have no scale code at the end of the name, though the barcode is built from one: ${noCode.map((f) => `${f.squareName} (${f.upcBuiltFromCode})`).join(', ')}.`);
  }
  for (const c of q.clashes) lines.push(`- ${c}`);
  lines.push('');

  lines.push(`## ${q.category} items in Square with no email row (${q.withoutRow.length})`);
  lines.push('');
  lines.push(
    `${q.withoutRow
      .map((w) => {
        const sizes = w.variations.length > 1 ? ` (${w.variations.length} sizes)` : '';
        const onEmail = w.onEmailWithoutStandardPrice ? ` (on the email as "${w.onEmailWithoutStandardPrice}", without a standard price)` : '';
        const general = w.forSection ? ` (one item for the ${w.forSection.rows} kinds under "${w.forSection.section}")` : '';
        return `${w.squareName}${sizes}${onEmail}${general}`;
      })
      .join('; ')}.`,
  );
  lines.push('');

  if (q.other.length) {
    lines.push(`## Rows left out: no standard price (${q.other.length})`);
    lines.push('');
    for (const o of q.other) lines.push(`- ${rowLabel(o)}. ${o.why}${o.proposal ? ` Closest Square item: ${o.proposal.squareName}.` : ' No Square item fits by name.'}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'Failed.');
    process.exitCode = 1;
  });
}
