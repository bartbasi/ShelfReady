// Matches invoice lines to Square variations.
//
// Order, for each line:
// 1. The saved mapping for this supplier (a match or a "not for resale" mark a person confirmed).
// 2. The printed UPC, exactly, against Square's UPCs.
// 3. The supplier's item number inside maker UPCs, when the supplier has that rule.
// 4. A scale code written on the line (a 4-digit number, for example in a handwritten note).
// 5. Name similarity with Square names.
//
// Each line ends as one of:
// - matched: confident, with how and why. Confident means the line may go on to pricing
//   without a person picking the item. Only these give it:
//   a. A saved mapping a person confirmed, found by the item number as printed (or the UPC or
//      description when there is no number), or with O read as 0 or I as 1. A valid printed UPC
//      must not point elsewhere: not a different UPC from the one saved, and not a UPC that
//      Square has on another variation. Then either that UPC belongs to the saved item, or the
//      description fits the saved one strongly (STRONG_FIT), no other saved item whose number
//      is one character away, or reads the same with O as 0, fits it as well, and the brand is
//      the same when both lines name one. The fit is the best over every wording a person has
//      confirmed for that item. A misread digit that lands on another saved number is caught
//      this way, and sent to the fallback model as a possible misread. An exact number whose
//      description fits only partly (REWORDED_FIT to STRONG_FIT), with no rival and no UPC
//      conflict, is a reworded line: the saved item is offered first for a person to confirm,
//      without a second reading.
//   b. A printed UPC that passes its check digit and is on exactly one Square variation, of an
//      item that is not archived, offered at the store at item and variation level, and is a
//      maker's code rather than a UPC built from a scale code.
//   c. The supplier's item number inside a maker UPC, under a rule an admin set for this
//      supplier, when exactly one active variation fits, the description fits its Square name
//      (RULE_MIN_NAME), no variation one digit away fits better, and no different valid UPC
//      is printed on the line.
// - candidates: ranked, each with plain reasons, for the manager to pick. A name, a scale
//   code read from text, or a key that could not be confirmed only ever gives candidates.
// - new_item: nothing plausible in Square.
// - not_for_resale: a person marked this supplier item as not sold (kitchen supplies). The
//   same checks as a saved match apply before it is trusted.
//
// A line that is not matched is also checked for a misread code (possibleMisread): a printed
// code that fails its check digit, one character from a code the store knows, or a key that
// points to an item the rest of the line contradicts. Reading the invoice again can fix a
// misread; it cannot add an item to Square (store/docs/DECISIONS.md).

import type { Db } from '../db/db.ts';
import type { CheckedLine, ModelInvoice, ModelLine, PackInfo } from '../invoice/types.ts';
import { itemOf, type ByWeightStatus, type CatalogIndex, type CatalogItem, type CatalogVariation, type Pricing } from './catalog.ts';
import { lineKeys, mappingsForSupplier, type LineKeys, type Mapping } from './mapping.ts';
import { lineText, PLAUSIBLE_SCORE, rankByName, sameItemSimilarity, scoreVariation, type InvoiceText, type LineText, type ScoredVariation } from './similarity.ts';
import { findSupplier, suggestSuppliers, type Supplier } from './suppliers.ts';
import { foldText, sizeTokens, withinOneEdit, words } from './text.ts';
import { checkDigitFor, itemNumberForRule, itemNumberInUpc, readUpc, type UpcItemRule, type UpcReading } from './upc.ts';

export type MatchMethod = 'saved_mapping' | 'exact_upc' | 'upc_item_number' | 'scale_code' | 'name';

export interface Candidate {
  variationId: string;
  itemId: string;
  /** The Square name the manager sees. */
  label: string;
  method: MatchMethod;
  /** 0 to 1. Key matches score 1. */
  score: number;
  reasons: string[];
}

/** What later steps need about a matched item. Read fresh from Square again before writing. */
export interface ItemFacts {
  itemName: string;
  scaleCode: string | null;
  byWeight: ByWeightStatus;
  pricing: Pricing;
  priceCents: number | null;
  /** The variation carries a maker's UPC. When false, offer the barcode scan in review. */
  hasMakerUpc: boolean;
}

interface LineBase {
  /** Line number in the reading. */
  n: number;
  /** Plain words: why the line ended as it did. */
  reasons: string[];
  /** Plain words: problems to show in review (for example an item that must be sold by weight). */
  warnings: string[];
  /** What a confirmation would be saved under. Null when the line has nothing to go by. */
  keys: LineKeys | null;
}

export interface MatchedLine extends LineBase {
  status: 'matched';
  method: MatchMethod;
  match: Candidate;
  facts: ItemFacts;
  mappingId: number | null;
}

export interface CandidatesLine extends LineBase {
  status: 'candidates';
  candidates: Candidate[];
  possibleMisread: boolean;
}

export interface NewItemLine extends LineBase {
  status: 'new_item';
  possibleMisread: boolean;
}

export interface NotForResaleLine extends LineBase {
  status: 'not_for_resale';
  mappingId: number;
}

export type LineMatch = MatchedLine | CandidatesLine | NewItemLine | NotForResaleLine;

export type SupplierMatch = { status: 'known'; supplier: Supplier } | { status: 'unknown'; printedName: string; suggestions: Supplier[] };

export interface MatchContext {
  db: Db;
  index: CatalogIndex;
}

export interface InvoiceMatch {
  supplier: SupplierMatch;
  lines: LineMatch[];
}

/** Most candidates shown for one line. */
const MAX_CANDIDATES = 5;
/**
 * How well a line's description must fit the one saved with a match before the saved item
 * number alone is trusted. Different products of one supplier rarely reach it; the same
 * product printed the same way scores about 1 (see sameItemSimilarity).
 */
export const STRONG_FIT = 0.85;
/**
 * Below this fit, a saved row found by its exact number is taken as a possible misread. Between
 * this and STRONG_FIT the supplier has most likely reworded the item: the saved item is offered
 * first for a person to confirm, with no second reading, since a second reading cannot change
 * the wording. The confirmed wording is then saved, so it matches on its own next time.
 */
export const REWORDED_FIT = 0.5;
/** A saved item one character away that fits within this much of the saved row is a rival. */
const RIVAL_MARGIN = 0.02;
/** A saved item number one character away counts as a misread only with this much description agreement. */
const NEAR_CODE_MIN_SIMILARITY = 0.5;
/** The name score a variation found through the supplier's UPC rule needs before it is matched. */
export const RULE_MIN_NAME = 0.6;
/** A scale code found in the description counts only when the names share at least this much. */
const SCALE_CODE_NAME_FLOOR = 0.15;

export function resolveSupplier(db: Db, printedName: string): SupplierMatch {
  const s = findSupplier(db, printedName);
  return s ? { status: 'known', supplier: s } : { status: 'unknown', printedName, suggestions: suggestSuppliers(db, printedName) };
}

/** Offered at the store and not archived, at item and variation level. */
function usable(index: CatalogIndex, v: CatalogVariation): boolean {
  const item = itemOf(index, v);
  return !item.archived && item.availableHere && v.availableHere;
}

function unusableReason(index: CatalogIndex, v: CatalogVariation): string {
  const item = itemOf(index, v);
  if (item.archived) return 'The Square item is archived.';
  return item.availableHere ? 'This variation is not offered at this store location.' : 'The Square item is not offered at this store location.';
}

function factsOf(index: CatalogIndex, v: CatalogVariation): ItemFacts {
  const item = itemOf(index, v);
  return {
    itemName: item.name,
    scaleCode: item.scaleCode,
    byWeight: item.byWeight,
    pricing: v.pricing,
    priceCents: v.priceCents,
    hasMakerUpc: v.upcKey !== null && v.upcFromScaleCode === null,
  };
}

function candidateOf(v: CatalogVariation, method: MatchMethod, score: number, reasons: string[]): Candidate {
  return { variationId: v.id, itemId: v.itemId, label: v.label, method, score, reasons };
}

function byWeightWarnings(index: CatalogIndex, v: CatalogVariation): string[] {
  const item = itemOf(index, v);
  if (!item.byWeight.required || item.byWeight.ok) return [];
  return [`${item.name} has scale code ${item.scaleCode}, so it must be sold by weight in Square: ${item.byWeight.problems.join(' ')}`];
}

function shortDate(isoText: string): string {
  return isoText.slice(0, 10);
}

/** Standalone 4-digit numbers on a line: in handwritten or printed notes, or in the description. */
function codesOnLine(line: ModelLine): { code: string; fromNote: boolean }[] {
  const out = new Map<string, boolean>();
  const scan = (text: string, fromNote: boolean) => {
    const s = text.slice(0, 300);
    for (const m of s.matchAll(/(^|[^\w#./-])(\d{4})(?![\w./-])/g)) {
      const before = s.slice(Math.max(0, m.index - 6), m.index + m[1]!.length).toLowerCase();
      if (/(item|no\.?|#)\s*$/.test(before)) continue;
      out.set(m[2]!, (out.get(m[2]!) ?? false) || fromNote);
    }
  };
  scan(line.description, false);
  for (const a of line.annotations) scan(a.text, true);
  return [...out.entries()].map(([code, fromNote]) => ({ code, fromNote }));
}

/** The supplier item number each variation's UPC carries under a rule, for variations that carry one. */
function numbersUnderRule(index: CatalogIndex, rule: UpcItemRule): { v: CatalogVariation; number: string }[] {
  const out: { v: CatalogVariation; number: string }[] = [];
  for (const v of index.variations) {
    const number = v.upcKey ? itemNumberInUpc(v.upcKey, rule) : null;
    if (number) out.push({ v, number });
  }
  return out;
}

export type LineMatcher = (line: ModelLine, n: number, pack?: PackInfo) => LineMatch;

/** A matcher for the lines of one invoice from one supplier (null when the supplier is not known yet). */
export function createLineMatcher(ctx: MatchContext, supplier: Supplier | null): LineMatcher {
  const { db, index } = ctx;
  let savedRows: Mapping[] | null = null;
  const saved = () => (savedRows ??= supplier ? mappingsForSupplier(db, supplier.id) : []);
  let ruleNumbers: { v: CatalogVariation; number: string }[] | null = null;

  return (line, n, pack) => {
    const keys = lineKeys({ itemNumber: line.item_number, upc: line.upc, description: line.description, brand: line.brand });
    const upc = readUpc(line.upc);
    const upcVars = upc.key ? (index.byUpc.get(upc.key) ?? []) : [];
    const text = lineText({ ...line, pack });
    const printed: InvoiceText = { description: line.description, brand: line.brand };
    let ranking: ScoredVariation[] | null = null;
    const nameRanking = () => (ranking ??= rankByName(index, text, { limit: MAX_CANDIDATES * 2, minScore: 0 }));
    const reasons: string[] = [];
    const warnings: string[] = [];
    const pool = new Map<string, Candidate>();
    let misread: string | null = null;
    const offer = (c: Candidate) => {
      const had = pool.get(c.variationId);
      if (!had) pool.set(c.variationId, c);
      else pool.set(c.variationId, { ...had, score: Math.max(had.score, c.score), method: had.score >= c.score ? had.method : c.method, reasons: [...new Set([...had.reasons, ...c.reasons])] });
    };
    const matched = (v: CatalogVariation, method: MatchMethod, why: string[], mappingId: number | null): MatchedLine => ({
      n,
      status: 'matched',
      method,
      match: candidateOf(v, method, 1, why),
      facts: factsOf(index, v),
      mappingId,
      reasons: [...reasons, ...why],
      warnings: [...warnings, ...byWeightWarnings(index, v)],
      keys,
    });

    // 1. Saved mapping.
    let exactSaved = false;
    if (supplier && keys) {
      const rows = saved();
      const exact = rows.find((m) => m.lineKey === keys.lineKey) ?? null;
      exactSaved = exact !== null;
      const near =
        keys.itemKey === ''
          ? []
          : rows.filter((m) => m.itemKey !== '' && m.lineKey !== keys.lineKey && (m.itemKey === keys.itemKey || withinOneEdit(m.itemKey, keys.itemKey)));
      const pick = pickSavedRow(index, printed, { text, line, pack, ranking: nameRanking }, line.item_number.trim(), keys, exact, near, upcVars);
      reasons.push(...pick.notes);
      for (const o of pick.offers) {
        const v = o.m.variationId ? index.variationById.get(o.m.variationId) : undefined;
        if (v) offer(candidateOf(v, 'saved_mapping', round(o.score), [o.why]));
        else if (o.m.kind === 'not_for_resale') reasons.push(`Item ${o.m.itemNumber || 'this line'} (${o.m.invoiceName}) is saved as not for resale.`);
      }
      if (pick.misread) misread = pick.misread;
      const row = pick.row;
      if (row) {
        const who = `Saved by ${row.confirmedByName || 'someone'} on ${shortDate(row.confirmedAt)}.`;
        if (row.kind === 'not_for_resale') {
          return { n, status: 'not_for_resale', mappingId: row.id, reasons: [...reasons, `Marked not for resale. ${who}`], warnings, keys };
        }
        const v = row.variationId ? index.variationById.get(row.variationId) : undefined;
        if (!v) {
          warnings.push(`A saved match points to a Square item that is no longer in the catalog (${row.storeName || 'unknown name'}). Pick again.`);
        } else if (!usable(index, v)) {
          offer(candidateOf(v, 'saved_mapping', 1, [`Saved match. ${who}`, unusableReason(index, v)]));
        } else {
          return matched(v, 'saved_mapping', [`Saved match. ${who}`], row.id);
        }
      }
    }

    // 2. The printed UPC, exactly.
    if (upc.key) {
      const only = upcVars.length === 1 ? upcVars[0]! : null;
      if (only && usable(index, only) && !only.upcFromScaleCode && onlyOffer(pool, only.id)) {
        return matched(only, 'exact_upc', ['The printed UPC is on this Square item, and on no other.'], null);
      }
      for (const v of upcVars) {
        const why = ['The printed UPC is on this Square item.'];
        if (upcVars.length > 1) why.push(`${upcVars.length} Square items carry this UPC, so a person must pick.`);
        if (v.upcFromScaleCode) why.push('This UPC is built from a scale code, not a maker code.');
        if (!usable(index, v)) why.push(unusableReason(index, v));
        offer(candidateOf(v, 'exact_upc', 1, why));
      }
    } else {
      // Some invoices print a UPC-A without its leading zero or without its check digit.
      const { zero, check } = elevenDigitForms(upc);
      for (const v of zero ? (index.byUpc.get(zero) ?? []) : []) offer(candidateOf(v, 'exact_upc', 0.95, ["With a leading zero, the printed code is this Square item's UPC."]));
      for (const v of check ? (index.byUpc.get(check) ?? []) : []) offer(candidateOf(v, 'exact_upc', 0.95, ["With its check digit added, the printed code is this Square item's UPC."]));
    }

    // 3. The supplier's item number inside a maker UPC, cross-checked by the description, by
    //    the numbers one digit away and by any UPC printed on the line.
    const rule = supplier?.upcItemRule ?? null;
    const want = rule && keys && keys.rawItem !== '' ? itemNumberForRule(keys.rawItem, rule) : null;
    if (rule && want) {
      ruleNumbers ??= numbersUnderRule(index, rule);
      const asRead = line.item_number.trim();
      const where = `digits ${rule.from} to ${rule.to}`;
      const hits = ruleNumbers.filter((r) => r.number === want).map((r) => r.v);
      const only = hits.length === 1 ? hits[0]! : null;
      const fit = only ? scoreVariation(index, text, only.id) : 0;
      const closer = ruleNumbers
        .filter((r) => r.number !== want && withinOneEdit(r.number, want))
        .map((r) => ({ ...r, fit: scoreVariation(index, text, r.v.id) }))
        .filter((r) => r.fit >= RULE_MIN_NAME && r.fit > fit);
      const printedDiffers = only !== null && upc.key !== null && only.upcKey !== upc.key;
      if (only && usable(index, only) && onlyOffer(pool, only.id) && fit >= RULE_MIN_NAME && closer.length === 0 && !printedDiffers) {
        return matched(only, 'upc_item_number', [`Item number ${asRead} is ${where} of this Square item's UPC, and the description fits its name.`], null);
      }
      for (const v of hits) {
        const why = [`Item number ${asRead} is ${where} of this Square item's UPC.`];
        if (hits.length > 1) why.push(`${hits.length} Square items fit, so a person must pick.`);
        if (scoreVariation(index, text, v.id) < RULE_MIN_NAME) why.push('The description does not fit this Square name well enough to confirm it.');
        if (upc.key && v.upcKey !== upc.key) why.push('The UPC printed on the invoice is a different code.');
        if (!usable(index, v)) why.push(unusableReason(index, v));
        offer(candidateOf(v, 'upc_item_number', 1, why));
      }
      for (const r of closer) offer(candidateOf(r.v, 'upc_item_number', round(r.fit), [`Item number ${r.number}, one character from ${asRead}, is in this Square item's UPC, and the description fits it.`]));
      if (printedDiffers) misread ??= "The printed UPC differs from the UPC this item number points to in Square, so one of them may be misread.";
      else if (closer.length) misread ??= `Item number ${asRead} is one character from ${closer[0]!.number}, whose Square item fits the description better, so the number may be misread.`;
    }

    // 4 and 5. A scale code on the line, and names.
    const byName = nameRanking();
    const nameScore = new Map(byName.map((s) => [s.variation.id, s]));
    for (const { code, fromNote } of codesOnLine(line)) {
      for (const item of index.byScaleCode.get(code) ?? []) {
        for (const v of item.variations) {
          const s = nameScore.get(v.id)?.score ?? 0;
          if (!fromNote && s < SCALE_CODE_NAME_FLOOR) continue;
          const why = [`The invoice shows ${code}, the scale code at the end of this Square name.`];
          if ((index.byScaleCode.get(code)?.length ?? 0) > 1) why.push(`${index.byScaleCode.get(code)!.length} Square items end in ${code}.`);
          offer(candidateOf(v, 'scale_code', Math.min(1, 0.6 + s), why));
        }
      }
    }
    for (const s of byName) {
      if (s.score >= namesFloor(text)) offer(candidateOf(s.variation, 'name', round(s.score), s.reasons));
    }

    misread ??= misreadReason(index, line, printed, keys, upc, exactSaved ? [] : saved());
    const candidates = [...pool.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label)).slice(0, MAX_CANDIDATES);
    if (misread) reasons.push(misread);
    if (candidates.length) {
      reasons.push(candidates.some((c) => c.method !== 'name') ? 'A code points to an item, but it could not be confirmed. Pick the right one.' : 'Only the name suggests these items. Pick the right one, or mark it new.');
      return { n, status: 'candidates', candidates, possibleMisread: misread !== null, reasons, warnings, keys };
    }
    reasons.push('No Square item has this code or a name like this one.');
    return { n, status: 'new_item', possibleMisread: misread !== null, reasons, warnings, keys };
  };
}

/**
 * For an 11-digit printed code, the keys it would have as a UPC-A with its leading zero put
 * back, and with its check digit added. Both null for any other code.
 */
function elevenDigitForms(upc: UpcReading): { zero: string | null; check: string | null } {
  if (upc.problem !== 'bad_length' || upc.digits.length !== 11) return { zero: null, check: null };
  return { zero: readUpc(`0${upc.digits}`).key, check: readUpc(`${upc.digits}${checkDigitFor(upc.digits)}`).key };
}

/** An 11-digit code that is a Square UPC once its leading zero or check digit is put back. */
function explainedByElevenDigits(index: CatalogIndex, upc: UpcReading): boolean {
  const { zero, check } = elevenDigitForms(upc);
  return (zero !== null && index.byUpc.has(zero)) || (check !== null && index.byUpc.has(check));
}

/** True when nothing else has been offered: no saved row or other code points elsewhere. */
function onlyOffer(pool: Map<string, Candidate>, variationId: string): boolean {
  return [...pool.keys()].every((id) => id === variationId);
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The lowest name score offered. Lines with no words to compare get none. */
function namesFloor(t: LineText): number {
  return t.primary.length + t.secondary.length === 0 ? Infinity : PLAUSIBLE_SCORE;
}

/** A saved row offered to the person, with its name score so it ranks with the other candidates. */
interface SavedOffer {
  m: Mapping;
  score: number;
  why: string;
}

interface SavedPick {
  /** The saved row to use, or null. */
  row: Mapping | null;
  /** Saved rows that could not be confirmed, offered to the person instead. */
  offers: SavedOffer[];
  notes: string[];
  misread: string | null;
}

/** What a line needs for weighing its saved rows by name. */
interface NameContext {
  /** The line's words, for name scores. */
  text: LineText;
  /** The line's fields, to score a saved wording the same way. */
  line: ModelLine;
  pack: PackInfo | undefined;
  /** Square variations ranked by name for the line. */
  ranking: () => ScoredVariation[];
}

/**
 * Chooses the saved row for a line, if one can be trusted (see the header, point a).
 * near holds the supplier's other saved rows whose item number is one character from the
 * line's, or reads the same with O as 0 or I as 1. upcVars are the Square variations carrying
 * the printed UPC. Rows it cannot trust are offered with their real name scores.
 */
function pickSavedRow(
  index: CatalogIndex,
  printed: InvoiceText,
  names: NameContext,
  asRead: string,
  keys: LineKeys,
  exact: Mapping | null,
  near: Mapping[],
  upcVars: CatalogVariation[],
): SavedPick {
  const upcSays = (m: Mapping): 'same' | 'differs' | 'unknown' => {
    if (keys.upcKey === '') return 'unknown';
    if (m.upcKey === keys.upcKey || (m.variationId !== null && upcVars.some((v) => v.id === m.variationId))) return 'same';
    return m.upcKey !== '' || upcVars.length > 0 ? 'differs' : 'unknown';
  };
  const fit = (m: Mapping) => bestFit(index, printed, m);
  const name = (m: Mapping) => m.itemNumber || 'this line';
  const lookalike = (m: Mapping) => m.itemKey === keys.itemKey;
  const nameScore = (m: Mapping) => (m.variationId ? scoreVariation(index, names.text, m.variationId) : 0);
  const offerOf = (m: Mapping): SavedOffer => ({ m, score: nameScore(m), why: `Saved for item ${name(m)} as ${closestWording(index, printed, m).description || m.storeName}.` });

  // The row to test: the exact one, else the best fitting lookalike.
  let row = exact;
  if (!row) {
    const lookalikes = near.filter(lookalike);
    if (lookalikes.length === 0) return { row: null, offers: [], notes: [], misread: null };
    row = lookalikes.reduce((a, b) => (fit(b) > fit(a) ? b : a));
  }
  const rivals = near.filter((m) => m.id !== row.id);
  const u = upcSays(row);
  if (u === 'differs') {
    return {
      row: null,
      offers: [offerOf(row)],
      notes: [`The printed UPC does not belong to the Square item saved for item ${name(row)}.`],
      misread: 'The printed UPC points away from the item saved for this item number, so a code may be misread.',
    };
  }
  const readAs = row.lineKey === keys.lineKey ? [] : [`Item number read as ${asRead}; saved as ${row.itemNumber}. They differ only by O and 0 or I and 1.`];
  if (u === 'same') return { row, offers: [], notes: [...readAs, 'The printed UPC confirms the saved item.'], misread: null };
  const s = fit(row);
  const better = rivals.filter((m) => upcSays(m) === 'same' || (upcSays(m) === 'unknown' && fit(m) >= s - RIVAL_MARGIN));
  if (better.length) {
    const how = better.map((m) => `${name(m)} (${lookalike(m) ? 'reads the same with O as 0 or I as 1' : 'one character away'})`).join(', ');
    return {
      row: null,
      offers: [row, ...better].map(offerOf),
      notes: [...readAs, `Saved item ${how} fits the description as well as item ${name(row)}. Pick the right one. If the items differ only by O and 0 or I and 1, check the letter.`],
      misread: `The item number may be misread: saved item ${name(better[0]!)} is one character away and fits the description as well.`,
    };
  }
  if (s < STRONG_FIT) {
    if (s >= REWORDED_FIT && row.lineKey === keys.lineKey) return reworded(index, printed, names, row, offerOf(row));
    return {
      row: null,
      offers: [offerOf(row)],
      notes: [...readAs, `The description is not close enough to the one saved for item ${name(row)} (${row.invoiceName}) to trust the number alone.`],
      misread: 'The description does not clearly fit the item saved for this number, so the number may be misread.',
    };
  }
  if (!wordingsOf(row).some((w) => !brandsDiffer(printed.brand, w.brand))) {
    // The same description under another brand: most likely a substitute, which a second
    // reading cannot settle. A person looks.
    return {
      row: null,
      offers: [offerOf(row)],
      notes: [...readAs, `The brand on the invoice (${printed.brand.trim()}) differs from the one saved for item ${name(row)} (${row.invoiceBrand}). Check it is the same product.`],
      misread: null,
    };
  }
  return { row, offers: [], notes: readAs, misread: null };
}

/**
 * An exact item number whose description only partly fits the saved wordings. Usually the
 * supplier reworded the item, which a second reading cannot change, so a person confirms it.
 * But a new sibling product (another flavour) read with a saved neighbour's number looks the
 * same. So the line's words are also scored against Square names: when another variation now
 * outranks the saved item by name, did not outrank it for the wording a person confirmed, and
 * carries in its name a word the line has newly (the flavour that changed, not a size), the
 * line points to that other item. Then the number may be misread, and it is flagged.
 * Either way the saved item keeps its real name score, and the words that changed are shown.
 */
function reworded(index: CatalogIndex, printed: InvoiceText, names: NameContext, row: Mapping, offer: SavedOffer): SavedPick {
  const itemName = row.itemNumber || 'this line';
  const before = closestWording(index, printed, row);
  const changes = wordChanges(before.description, printed.description);
  if (row.kind !== 'square' || !row.variationId) {
    return { row: null, offers: [], notes: [`Item ${itemName} is worded differently from before (${before.description}). ${changes}It is saved as not for resale; confirm that, or pick an item.`], misread: null };
  }
  const savedNow = offer.score;
  const thenText = lineText({ ...names.line, description: before.description, brand: before.brand, pack: names.pack });
  const savedThen = scoreVariation(index, thenText, row.variationId);
  // Words the line has that the confirmed wording did not, numbers aside ("PAPRIKA", not "10").
  const was = new Set(words(before.description.split('|')[0] ?? ''));
  const fresh = words(printed.description.split('|')[0] ?? '').filter((w) => !was.has(w) && !/\d/.test(w));
  const names_ = (id: string) => {
    const doc = index.docByVariation.get(id);
    return doc ? [...doc.makerWords, ...doc.productWords] : [];
  };
  const outranks = names
    .ranking()
    .filter(
      (c) =>
        c.variation.id !== row.variationId &&
        c.score > savedNow + 0.005 &&
        scoreVariation(index, thenText, c.variation.id) <= savedThen &&
        fresh.some((w) => names_(c.variation.id).includes(w)),
    );
  const savedLabel = index.variationById.get(row.variationId)?.label ?? row.storeName;
  if (outranks.length) {
    const top = outranks[0]!.variation.label;
    return {
      row: null,
      offers: [offer],
      notes: [`Item ${itemName} is worded differently from before (${before.description}), and the words fit ${top} better than the saved item, ${savedLabel}. ${changes}`.trim()],
      misread: `The item number may be misread: the line fits ${top} better than the item saved for ${itemName}.`,
    };
  }
  return {
    row: null,
    offers: [offer],
    notes: [`Item ${itemName} is worded differently from before (${before.description}). ${changes}If it is still ${savedLabel}, confirm it, and the new wording is saved.`],
    misread: null,
  };
}

/** The words of two descriptions' first lines that differ, as printed. Empty when none do. */
function wordChanges(before: string, now: string): string {
  const split = (t: string) => (t.split('|')[0] ?? '').split(/[\s,;]+/).map((w) => w.trim()).filter((w) => w !== '');
  const key = (w: string) => foldText(w).replace(/[^a-z0-9]+/g, '');
  const was = split(before);
  const is = split(now);
  const added = is.filter((w) => key(w) !== '' && !was.some((x) => key(x) === key(w))).slice(0, 6);
  const dropped = was.filter((w) => key(w) !== '' && !is.some((x) => key(x) === key(w))).slice(0, 6);
  const parts: string[] = [];
  if (added.length) parts.push(`New words: ${added.join(', ')}.`);
  if (dropped.length) parts.push(`Words no longer printed: ${dropped.join(', ')}.`);
  return parts.length ? `${parts.join(' ')} ` : '';
}

/** The confirmed wording of a saved match that this line is closest to. */
function closestWording(index: CatalogIndex, printed: InvoiceText, m: Mapping): InvoiceText {
  let best: InvoiceText = wordingsOf(m)[0]!;
  let top = -1;
  for (const w of wordingsOf(m)) {
    const f = sameItemSimilarity(index, printed, w);
    if (f > top) {
      top = f;
      best = w;
    }
  }
  return best;
}

/** The wordings a person confirmed for a saved match (its latest one when none are stored). */
function wordingsOf(m: Mapping): InvoiceText[] {
  return m.wordings.length ? m.wordings : [{ description: m.invoiceName, brand: m.invoiceBrand }];
}

/**
 * A wording whose sizes or counts differ from the line's ("2-3 LB" against "3-4 LB") stays
 * under STRONG_FIT however well the other words fit, since numbers weigh little and a sibling
 * size is another product. Such a line goes to the reworded branch: a person confirms the pack
 * change once, and that wording is saved.
 */
const SIZE_CHANGE_CAP = STRONG_FIT - 0.01;

/** How well a line fits a saved match: the best over every wording a person confirmed for it. */
function bestFit(index: CatalogIndex, printed: InvoiceText, m: Mapping): number {
  const sizes = sizeTokens(printed.description).join(' ');
  let top = 0;
  for (const w of wordingsOf(m)) {
    const f = sameItemSimilarity(index, printed, w);
    top = Math.max(top, sizeTokens(w.description).join(' ') === sizes ? f : Math.min(f, SIZE_CHANGE_CAP));
  }
  return top;
}

/** Both lines name a brand and the brands differ, allowing for one cut short ("NORTHFI", "NORTHFIELD"). */
function brandsDiffer(a: string, b: string): boolean {
  const ca = foldText(a).replace(/[^a-z0-9]+/g, '');
  const cb = foldText(b).replace(/[^a-z0-9]+/g, '');
  return ca !== '' && cb !== '' && !ca.startsWith(cb) && !cb.startsWith(ca);
}

/**
 * Why an unmatched line's code looks misread, or null. saved holds the supplier's saved rows
 * for a number that is not saved itself; a saved number's neighbours were already weighed when
 * its row was checked, so the caller passes none for it.
 */
function misreadReason(index: CatalogIndex, line: ModelLine, printed: InvoiceText, keys: LineKeys | null, upc: UpcReading, saved: Mapping[]): string | null {
  if (upc.problem === 'check_digit') return `The printed code ${upc.digits} fails its check digit, so a digit was probably misread.`;
  const unknownCode = upc.key === null || !index.byUpc.has(upc.key);
  if (/^\d{7,15}$/.test(upc.digits) && unknownCode && !explainedByElevenDigits(index, upc)) {
    const near = index.upcDigits.find((u) => u !== upc.digits && u.padStart(14, '0') !== upc.digits.padStart(14, '0') && withinOneEdit(u, upc.digits));
    if (near) return `The printed code ${upc.digits} is one digit away from a UPC in Square (${near}), so a digit may be misread.`;
  }
  if (keys && keys.itemKey !== '') {
    for (const m of saved) {
      if (m.itemKey === '' || m.lineKey === keys.lineKey || !withinOneEdit(m.itemKey, keys.itemKey)) continue;
      if (bestFit(index, printed, m) >= NEAR_CODE_MIN_SIMILARITY) {
        return `Item number ${line.item_number.trim()} is one character from saved item ${m.itemNumber}, and the descriptions match, so the number may be misread.`;
      }
    }
  }
  return null;
}

/** Matches every line of a checked reading. */
export function matchReading(ctx: MatchContext, reading: { invoice: ModelInvoice; lines: CheckedLine[] }): InvoiceMatch {
  const supplier = resolveSupplier(ctx.db, reading.invoice.supplier_name);
  const match = createLineMatcher(ctx, supplier.status === 'known' ? supplier.supplier : null);
  return { supplier, lines: reading.lines.map((cl) => match(cl.line, cl.n, cl.pack)) };
}
