// Name similarity between an invoice line and Square variations. It only ranks candidates for
// a person to pick from: a name never confirms a match on its own.
//
// Each word weighs more the fewer Square items use it, so a rare cheese name counts for more
// than "cheese". Numbers and words like "fresh" or "whole" count for less. The score mixes how
// much of the Square name the line covers (most of the weight, since Square names are short and
// clean) with how much of the line's first description line the Square name explains. A maker
// word the line leaves out costs half, because invoices often leave the maker out. A brand
// printed on the line that matches the maker lifts the score; one that contradicts it lowers
// the score. Whether the line looks sold by weight nudges by-weight items up or down.

import type { PackInfo } from '../invoice/types.ts';
import { soldByWeightKind, type CatalogIndex, type CatalogItem, type CatalogVariation, type NameDoc } from './catalog.ts';
import { DESCRIPTIVE_WORDS, foldText, plainWords, stem, withinOneEdit, words } from './text.ts';

/** Lowest score worth showing a person. Below it, a line counts as a new item. */
export const PLAUSIBLE_SCORE = 0.3;

export interface LineText {
  /** Words of the first description line. */
  primary: string[];
  /** Words of the continuation lines, without origin notes and supplier references. */
  secondary: string[];
  brand: string[];
  /** true: sold by weight; false: packaged units; null: cannot tell. */
  looksByWeight: boolean | null;
}

export interface LineTextInput {
  description: string;
  brand: string;
  unit: string;
  weight: string;
  pack_size: string;
  pack?: PackInfo;
}

const WEIGHT_WORD = /(^|[^a-z])(lb|lbs|#|kg|pound)([^a-z]|$)/i;

/** Splits a description into its first line and the rest, and drops notes that are not about the product. */
export function lineText(l: LineTextInput): LineText {
  const parts = l.description.slice(0, 300).split('|').map((p) => p.trim());
  const clean = (p: string) =>
    p
      .replace(/product origin:.*$/i, ' ')
      .replace(/\bitem\s?#\s?\S+/gi, ' ')
      .replace(/\*+/g, ' ');
  const primary = words(clean(parts[0] ?? ''));
  const secondary = parts.slice(1).flatMap((p) => words(clean(p)));
  const unit = l.unit.trim().toUpperCase();
  let looksByWeight: boolean | null = null;
  if (l.pack?.pricePer === 'lb' || ['LB', 'LBS', '#', 'KG'].includes(unit) || (l.weight.trim() !== '' && !/^0*\.?0*$/.test(l.weight.trim()))) looksByWeight = true;
  else if (WEIGHT_WORD.test(l.pack_size)) looksByWeight = true;
  else if (l.pack?.pricePer === 'case' || /\d\s*(oz|z|g|ml)\b/i.test(l.pack_size)) looksByWeight = false;
  return { primary, secondary, brand: words(l.brand), looksByWeight };
}

export interface ScoredVariation {
  variation: CatalogVariation;
  item: CatalogItem;
  score: number;
  /** Plain words: why this one is offered. */
  reasons: string[];
}

function weightOf(index: CatalogIndex, w: string): number {
  const df = index.wordItemCount.get(w) ?? 0;
  // A word no Square item uses weighs like one used by three items.
  const base = Math.max(0.3, Math.log((index.itemCount + 1) / (df === 0 ? 3 : df)));
  // Sizes and counts only help tell apart items that already share a name.
  if (/\d/.test(w)) return base * 0.3;
  return DESCRIPTIVE_WORDS.has(w) ? base * 0.4 : base;
}

/**
 * How well two words match, 0 to 1. Equal words match fully. A short form of a longer word
 * ("northfi", "truff") matches at 0.85, but only when the short form is not itself a common
 * Square word, so "chip" never stands in for "chipotle". Words of 5 or more letters one letter
 * apart ("salame", "salami") match at 0.8. Numbers must be equal.
 */
function wordScore(index: CatalogIndex, a: string, b: string): number {
  if (a === b) return 1;
  if (/\d/.test(a) || /\d/.test(b)) return 0;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 4 && l.startsWith(s) && (index.wordItemCount.get(s) ?? 0) <= 1) return 0.85;
  if (s.length >= 5 && withinOneEdit(a, b)) return 0.8;
  return 0;
}

function best(index: CatalogIndex, w: string, pool: string[]): number {
  let top = 0;
  for (const p of pool) {
    const s = wordScore(index, w, p);
    if (s > top) top = s;
    if (top === 1) break;
  }
  return top;
}

/** The words of a Square name as written, for reasons a person reads. */
function shownWords(name: string, matched: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of name.split(/[\s,()/]+/)) {
    const folded = foldText(raw).replace(/[^a-z0-9.]/g, '');
    if (folded && matched.has(stem(folded)) && !out.includes(raw)) out.push(raw.replace(/[,.;:]+$/, ''));
  }
  return out;
}

function scoreDoc(index: CatalogIndex, t: LineText, doc: NameDoc): ScoredVariation | null {
  const linePool = [...t.primary, ...t.secondary, ...t.brand];
  if (linePool.length === 0) return null;
  let have = 0;
  let total = 0;
  let named = false;
  const matched = new Set<string>();
  // An unmatched maker word costs half: invoices often leave the maker out.
  const credit = (w: string, missingCost: number) => {
    const weight = weightOf(index, w);
    let s = best(index, w, t.primary);
    if (s < 1) s = Math.max(s, 0.6 * best(index, w, t.secondary), best(index, w, t.brand));
    if (s > 0) {
      matched.add(w);
      if (!/\d/.test(w)) named = true;
    }
    total += s > 0 ? weight : weight * missingCost;
    have += s * weight;
  };
  for (const w of new Set(doc.makerWords)) credit(w, 0.5);
  for (const w of new Set(doc.productWords)) credit(w, 1);
  // Numbers alone never make a candidate.
  if (total === 0 || !named) return null;
  const recall = have / total;

  const itemPool = [...doc.makerWords, ...doc.productWords];
  let pHave = 0;
  let pTotal = 0;
  for (const w of new Set(t.primary)) {
    const weight = weightOf(index, w);
    pTotal += weight;
    pHave += best(index, w, itemPool) * weight;
  }
  const precision = pTotal > 0 ? pHave / pTotal : 0;
  let score = 0.6 * recall + 0.4 * precision;

  const reasons: string[] = [];
  const shown = shownWords(doc.variation.label, matched);
  if (shown.length) reasons.push(`Shares the words ${shown.join(', ')}.`);
  if (t.brand.length) {
    const brandHit = t.brand.some((b) => best(index, b, itemPool) >= 0.85);
    if (brandHit) {
      score += 0.1;
      reasons.push('The brand on the invoice is in the Square name.');
    } else if (doc.makerWords.length) {
      score *= 0.8;
      reasons.push('The brand on the invoice is not the maker in the Square name.');
    }
  }
  const byWeight = soldByWeightKind(doc.item);
  if (t.looksByWeight === true) {
    score += byWeight ? 0.05 : -0.05;
    if (byWeight) reasons.push('Sold by weight, like this line.');
  } else if (t.looksByWeight === false && byWeight) {
    score -= 0.05;
  }
  if (doc.item.archived || !doc.item.availableHere || !doc.variation.availableHere) {
    score *= 0.7;
    reasons.push(doc.item.archived ? 'Archived in Square.' : 'Not offered at this store location in Square.');
  }
  return { variation: doc.variation, item: doc.item, score: Math.max(0, Math.min(1, score)), reasons };
}

/** Square variations ranked by name similarity, best first, at or above minScore. */
export function rankByName(index: CatalogIndex, t: LineText, opts: { limit?: number; minScore?: number } = {}): ScoredVariation[] {
  const limit = opts.limit ?? 5;
  const min = opts.minScore ?? PLAUSIBLE_SCORE;
  const scored: ScoredVariation[] = [];
  for (const doc of index.docs) {
    const s = scoreDoc(index, t, doc);
    if (s && s.score >= min) scored.push(s);
  }
  scored.sort((a, b) => b.score - a.score || a.variation.label.localeCompare(b.variation.label));
  return scored.slice(0, limit);
}

/** A line's text as an invoice prints it: the description (continuation lines after " | ") and the brand. */
export interface InvoiceText {
  description: string;
  brand: string;
}

interface Tok {
  plain: string;
  stem: string;
}

function toks(text: string): Tok[] {
  return plainWords(text).map((p) => ({ plain: p, stem: stem(p) }));
}

/** Drops notes that are not about the product: origin lines, supplier references, asterisks. */
function cleanPart(p: string): string {
  return p
    .replace(/product origin:.*$/i, ' ')
    .replace(/\bitem\s?#\s?\S+/gi, ' ')
    .replace(/\*+/g, ' ');
}

/** A brand word names the maker, which a supplier's products share, so it counts for little. */
const BRAND_FACTOR = 0.3;

/**
 * Weighted share of words two texts have in common. Each word counts once per side, weighted
 * by how few Square items use it, at full weight for sizes and numbers (5 LB and 10 LB are two
 * products) and at BRAND_FACTOR for words of the brand. Words must be equal after folding and
 * stemming: no short forms and no spelling slips, since a supplier prints one item the same way
 * each time. A word read as two ("ROSEMARYCRISPS", "ROSEMARY CRISPS") still counts.
 */
function overlap(index: CatalogIndex, a: Tok[], b: Tok[], brand: Set<string>): number {
  const usedA = a.map(() => false);
  const usedB = b.map(() => false);
  for (let i = 0; i < a.length; i++) {
    const j = b.findIndex((t, k) => !usedB[k] && t.stem === a[i]!.stem);
    if (j >= 0) usedA[i] = usedB[j] = true;
  }
  const joins = (x: Tok[], ux: boolean[], y: Tok[], uy: boolean[]) => {
    for (let i = 0; i < x.length; i++) {
      if (ux[i]) continue;
      for (const span of [2, 3]) {
        for (let j = 0; j + span <= y.length && !ux[i]; j++) {
          if (uy.slice(j, j + span).some(Boolean)) continue;
          const joined = y.slice(j, j + span).map((t) => t.plain).join('');
          if (joined === x[i]!.plain || stem(joined) === x[i]!.stem) {
            ux[i] = true;
            for (let k = j; k < j + span; k++) uy[k] = true;
          }
        }
      }
    }
  };
  joins(a, usedA, b, usedB);
  joins(b, usedB, a, usedA);
  const weight = (w: string) => {
    const df = index.wordItemCount.get(w) ?? 0;
    const base = Math.max(0.3, Math.log((index.itemCount + 1) / (df === 0 ? 3 : df)));
    return brand.has(w) ? base * BRAND_FACTOR : base;
  };
  let have = 0;
  let total = 0;
  for (const [side, used] of [
    [a, usedA],
    [b, usedB],
  ] as const) {
    const seen = new Map<string, boolean>();
    side.forEach((t, i) => seen.set(t.stem, (seen.get(t.stem) ?? false) || used[i]!));
    for (const [w, hit] of seen) {
      total += weight(w);
      if (hit) have += weight(w);
    }
  }
  return total > 0 ? have / total : 0;
}

/**
 * How sure we can be that two invoice lines from one supplier are the same product, 0 to 1.
 * Used to confirm a line against the saved match it was found by, and to compare it with saved
 * items whose numbers are one character away. The brand counts a little, so two makers'
 * "sea salt crackers" differ. The first description lines are compared, and the whole
 * descriptions too, and the better of the two is kept, since a reading may or may not split
 * continuation lines. The same printing, whatever its spacing: 1. On the real invoices,
 * different products of one supplier stay under 0.8, and a reading that drops a word, such as
 * a size, falls between 0.6 and 0.85.
 */
export function sameItemSimilarity(index: CatalogIndex, a: InvoiceText, b: InvoiceText): number {
  // The same text with different spacing or punctuation ("VARZI BULK", "VARZIBULK") is the same
  // printing, unless both lines name a brand and the brands differ.
  const compact = (t: string) => foldText(t).replace(/[^a-z0-9]+/g, '');
  const brandsAgree = compact(a.brand) === '' || compact(b.brand) === '' || compact(a.brand) === compact(b.brand);
  const firstText = (t: InvoiceText) => cleanPart(t.description.split('|')[0] ?? '');
  const wholeText = (t: InvoiceText) => t.description.split('|').map(cleanPart).join(' ');
  if (brandsAgree && compact(firstText(a)) !== '' && (compact(firstText(a)) === compact(firstText(b)) || compact(wholeText(a)) === compact(wholeText(b)))) return 1;
  const brand = new Set([...toks(a.brand), ...toks(b.brand)].map((t) => t.stem));
  const first = (t: InvoiceText) => [...toks(cleanPart(t.description.split('|')[0] ?? '')), ...toks(t.brand)];
  const whole = (t: InvoiceText) => [...toks(t.description.split('|').map(cleanPart).join(' ')), ...toks(t.brand)];
  const fa = first(a);
  const fb = first(b);
  if (fa.length === 0 || fb.length === 0) return fa.length === fb.length ? 1 : 0;
  return Math.max(overlap(index, fa, fb, brand), overlap(index, whole(a), whole(b), brand));
}

/** The name score of one variation for a line, as rankByName would give it. 0 when nothing is shared. */
export function scoreVariation(index: CatalogIndex, t: LineText, variationId: string): number {
  const doc = index.docByVariation.get(variationId);
  return doc ? (scoreDoc(index, t, doc)?.score ?? 0) : 0;
}
