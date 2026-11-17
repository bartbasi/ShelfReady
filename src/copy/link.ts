// Linking stored cards to Square variations, with the matching tools (src/matching).
//
// Links are per catalog: Square variation ids differ between the sandbox and live accounts.
// A link is made without a person only when it is sure:
// - Carried: the card is linked in another catalog to an item whose name exactly one live item
//   here has too (the sandbox holds copies of the live items under the same names).
// - By code: exactly one Square item ends in the card's code, it has one variation to price (or
//   one per-pound variation), it is live here, the sale mode agrees, no other card claims that
//   code, and the names still agree, since a code can be reused for another product after a
//   card was printed. Alike is not enough when the card's name fits another item exactly (a card
//   printed with the wrong code).
// - By name: the card's name and the Square name have the same product words (a maker word the
//   card puts in its producer line counts), the maker agrees, the sale mode agrees (per pound or
//   packaged), any sizes agree, and no other Square variation or unlinked card fits as well. A
//   card whose printed code is on another item today is never linked by name: code and name
//   disagree, so a person decides.
// Anything less is a candidate for a person to confirm, ranked by the same name score the
// matcher uses (rankByName and scoreVariation in src/matching/similarity.ts).

import { itemOf, soldByWeightKind, type CatalogIndex, type NameDoc } from '../matching/catalog.ts';
import { lineText, PLAUSIBLE_SCORE, rankByName, scoreVariation, type LineText } from '../matching/similarity.ts';
import { sizeTokens, words } from '../matching/text.ts';
import { fullName, PER_POUND } from './checks.ts';
import { catalogKey } from './store.ts';
import { foldCopy } from './text.ts';
import type { CardContent, CardLink, CopyCatalog, ProductFacts } from './types.ts';

/** What linking needs to know about a card. */
export interface LinkableCard {
  /** The stored card id, when it has one. */
  id?: number;
  content: CardContent;
  /** The code printed on the card or seen since, or ''. */
  scaleCode: string;
}

export interface SureLink {
  variationId: string;
  method: 'scale_code' | 'name' | 'same_item';
  reasons: string[];
}

export interface LinkCandidate {
  variationId: string;
  label: string;
  /** Name score, 0 to 1. */
  score: number;
  method: 'scale_code' | 'name';
  reasons: string[];
}

/** Facts about a Square variation for the copy step. Null when the catalog has no such variation. */
export function productFacts(catalog: CopyCatalog, variationId: string): ProductFacts | null {
  const index = catalog.index;
  const v = index.variationById.get(variationId);
  if (!v) return null;
  const item = itemOf(index, v);
  return {
    catalog: catalogKey(catalog),
    catalogSource: catalog.source,
    variationId: v.id,
    itemId: item.id,
    itemName: item.name,
    label: v.label,
    baseName: item.baseName,
    maker: item.maker,
    product: item.product,
    variationName: v.label === item.name.trim() ? '' : v.name,
    scaleCode: item.scaleCode,
    soldByWeight: soldByWeightKind(item),
    categoryNames: [...item.categoryNames],
    archived: item.archived,
    availableHere: item.availableHere && v.availableHere,
  };
}

/** The maker part of a producer line: the text before the middle dot. */
export function producerMaker(producer: string): string {
  return (producer.split('·')[0] ?? '').trim();
}

export function cardSoldByWeight(content: CardContent): boolean {
  return content.unit.trim().toUpperCase() === PER_POUND;
}

/** A card read as if it were an invoice line, so the matcher's name score applies to it. */
export function cardLineText(content: CardContent): LineText {
  const byWeight = cardSoldByWeight(content);
  return lineText({ description: fullName(content), brand: producerMaker(content.producer), unit: byWeight ? 'LB' : '', weight: '', pack_size: byWeight ? '' : content.unit });
}

/** The name score of a card against one variation, as the matcher would give it. */
export function cardScore(index: CatalogIndex, content: CardContent, variationId: string): number {
  return scoreVariation(index, cardLineText(content), variationId);
}

/**
 * True when the card names the same product as the Square variation: every card name word is a
 * Square product word, and every Square product word is in the card's name or the maker part
 * of its producer line.
 */
function sameProduct(content: CardContent, doc: NameDoc): boolean {
  const cardWords = new Set(words(fullName(content)));
  const makerWords = new Set(words(producerMaker(content.producer)));
  const squareWords = new Set(doc.productWords);
  if (cardWords.size === 0 || squareWords.size === 0) return false;
  for (const w of cardWords) if (!squareWords.has(w)) return false;
  for (const w of squareWords) if (!cardWords.has(w) && !makerWords.has(w)) return false;
  return true;
}

/** The Square name's maker, when it has one, appears in the card's producer line. */
function makerAgrees(content: CardContent, doc: NameDoc): boolean {
  if (doc.makerWords.length === 0) return true;
  const producerWords = new Set(words(content.producer));
  return doc.makerWords.some((w) => producerWords.has(w));
}

function saleModeAgrees(content: CardContent, doc: NameDoc): boolean {
  return cardSoldByWeight(content) === soldByWeightKind(doc.item);
}

/** Sizes printed on both sides agree. A side with no size says nothing. */
function sizesAgree(content: CardContent, doc: NameDoc): boolean {
  const a = sizeTokens(content.unit);
  const b = sizeTokens(doc.variation.label);
  return a.length === 0 || b.length === 0 || a.some((t) => b.includes(t));
}

function nameFits(content: CardContent, doc: NameDoc): boolean {
  return sameProduct(content, doc) && makerAgrees(content, doc) && saleModeAgrees(content, doc) && sizesAgree(content, doc);
}

function liveHere(doc: NameDoc): boolean {
  return !doc.item.archived && doc.item.availableHere && doc.variation.availableHere;
}

/**
 * Whether a card and a variation are surely one product, and how, or null when a person must
 * confirm. others: every other card that could claim the same variation (the rest of the import
 * and the live store), so two cards that fit equally well are both left for a person.
 */
export function sureLink(index: CatalogIndex, card: LinkableCard, variationId: string, others: readonly LinkableCard[]): SureLink | null {
  const doc = index.docByVariation.get(variationId);
  if (!doc || !liveHere(doc)) return null;
  const item = doc.item;
  const code = card.scaleCode;
  const isMe = (o: LinkableCard) => o === card || (o.id !== undefined && o.id === card.id);
  if (code !== '' && item.scaleCode === code) {
    const sharers = index.byScaleCode.get(code) ?? [];
    const pricedHere = item.variations.length === 1 ? item.variations : item.variations.filter((v) => v.perPound);
    const otherClaims = others.some((o) => o.scaleCode === code && !isMe(o));
    // The names agree when they name the same product, or when they are alike and the card's
    // name does not fit some other item exactly, archived or not (a card printed with the wrong
    // code, or for a product since archived).
    const namesAgree =
      sameProduct(card.content, doc) ||
      (cardScore(index, card.content, variationId) >= PLAUSIBLE_SCORE && !index.docs.some((o) => o.variation.id !== variationId && nameFits(card.content, o)));
    // The sale mode must agree too: a card printed PER POUND is not for an item sold by the unit.
    if (sharers.length === 1 && pricedHere.length === 1 && pricedHere[0]!.id === variationId && !otherClaims && namesAgree && saleModeAgrees(card.content, doc)) {
      return { variationId, method: 'scale_code', reasons: [`The card and ${doc.variation.label} share scale code ${code}, and the names agree.`] };
    }
    return null;
  }
  // The card's printed code is on another item today: the code and the name disagree.
  if (code !== '' && (index.byScaleCode.get(code)?.length ?? 0) > 0) return null;
  if (!nameFits(card.content, doc)) return null;
  // No other variation may fit this card as well, and no other card may fit this variation.
  for (const other of index.docs) {
    if (other.variation.id !== variationId && liveHere(other) && nameFits(card.content, other)) return null;
  }
  for (const o of others) {
    if (!isMe(o) && nameFits(o.content, doc)) return null;
  }
  return { variationId, method: 'name', reasons: [`The card and ${doc.variation.label} name the same product, with the same maker and sale mode.`] };
}

const labelKey = (label: string) => foldCopy(label).replace(/[^a-z0-9]+/g, ' ').trim();

/** Live variations by folded label, built once per catalog index. */
const byLabelCache = new WeakMap<CatalogIndex, Map<string, NameDoc[]>>();
function liveByLabel(index: CatalogIndex): Map<string, NameDoc[]> {
  let m = byLabelCache.get(index);
  if (!m) {
    m = new Map();
    for (const d of index.docs) {
      if (!liveHere(d)) continue;
      const k = labelKey(d.variation.label);
      if (k !== '') m.set(k, [...(m.get(k) ?? []), d]);
    }
    byLabelCache.set(index, m);
  }
  return m;
}

/**
 * A link made in another catalog, carried to this one: the card is linked there to a variation
 * whose label exactly one live variation here has too. The sandbox holds copies of the live items
 * under the same names, so a link a person confirmed once is not asked again. Null otherwise.
 */
export function carriedLinkFor(index: CatalogIndex, links: readonly CardLink[], catalog: string): SureLink | null {
  for (const l of links) {
    if (l.catalog === catalog) continue;
    const same = liveByLabel(index).get(labelKey(l.label)) ?? [];
    if (same.length === 1) {
      return { variationId: same[0]!.variation.id, method: 'same_item', reasons: [`Linked to ${l.label} in another catalog, and this is the one item here with that name.`] };
    }
  }
  return null;
}

/** carriedLinkFor, for one variation: the carried link when it lands on this variation, else null. */
export function carriedLink(index: CatalogIndex, links: readonly CardLink[], variationId: string, catalog: string): SureLink | null {
  const c = carriedLinkFor(index, links, catalog);
  return c && c.variationId === variationId ? c : null;
}

/** Square variations a card may belong to, best first: items ending in its code, then by name. */
export function candidatesForCard(index: CatalogIndex, card: LinkableCard, limit = 5): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  const seen = new Set<string>();
  if (card.scaleCode !== '') {
    for (const item of index.byScaleCode.get(card.scaleCode) ?? []) {
      for (const v of item.variations) {
        seen.add(v.id);
        const score = cardScore(index, card.content, v.id);
        const reasons = [`Ends in scale code ${card.scaleCode}, the code printed on the card.`];
        if (score < PLAUSIBLE_SCORE) reasons.push('The names share little: the code may have been given to another product since.');
        if (item.archived) reasons.push('Archived in Square.');
        out.push({ variationId: v.id, label: v.label, score: Math.round(score * 100) / 100, method: 'scale_code', reasons });
      }
    }
  }
  for (const s of rankByName(index, cardLineText(card.content), { limit: limit + out.length })) {
    if (seen.has(s.variation.id)) continue;
    seen.add(s.variation.id);
    out.push({ variationId: s.variation.id, label: s.variation.label, score: Math.round(s.score * 100) / 100, method: 'name', reasons: s.reasons });
  }
  return out.slice(0, limit);
}
