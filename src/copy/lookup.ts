// Which copy a product on an invoice run uses (decision 5): edited copy, then imported copy, then
// generated copy already stored, then new copy.
//
// Links are per catalog (src/copy/store.ts). A card linked only in another catalog is still
// found here: by its link carried to the item of the same name, or by code or name like any card
// not linked here, so a run against another catalog never skips a printed card and pays for
// new copy.
//
// lookupCopy only reads. A sure link it finds is returned as pendingLink, for the run to save with
// saveLookupLink when it is sent. Cards that may be the product, but not surely, come back as
// suggestions, only when they would win over what is stored: a person confirms one
// (confirmSuggestion) or says it is another product (rejectSuggestion), which is remembered so it
// is not asked again.

import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { cardScore, cardSoldByWeight, carriedLink, productFacts, sureLink, type LinkableCard } from './link.ts';
import { catalogKey, getCard, linkCard, linkIn, linkTargetOf, liveCardForVariation, liveCards, PRECEDENCE, type LinkResult } from './store.ts';
import { CopyError, type CopyCatalog, type ProductFacts, type StoredCard } from './types.ts';

/** Lowest name score for suggesting a stored card on a run. Higher than the matcher's, to keep runs quiet. */
export const SUGGEST_SCORE = 0.5;
/** Most suggestions shown for one product. */
const MAX_SUGGESTIONS = 3;

export interface CardSuggestion {
  card: StoredCard;
  method: 'scale_code' | 'name' | 'same_item';
  score: number;
  reasons: string[];
}

export interface CopyLookup {
  product: ProductFacts;
  /** The card to print, or null when none is known for sure. */
  card: StoredCard | null;
  via: 'variation' | 'scale_code' | 'name' | 'same_item' | null;
  /** A sure link found now and not saved yet. Save it with saveLookupLink when the run is sent. */
  pendingLink: { cardId: number; method: 'scale_code' | 'name' | 'same_item' } | null;
  /** Stored cards that may be this product and would win over what was found. */
  suggestions: CardSuggestion[];
  /** use: the card (a generated one still needs a person's check). confirm: a person looks at the suggestions first. generate: nothing is stored. */
  next: 'use' | 'confirm' | 'generate';
}

function linkable(c: StoredCard): LinkableCard {
  return { id: c.id, content: c.content, scaleCode: c.scaleCode };
}

function rejected(db: Db, catalog: string, variationId: string): Set<number> {
  const rows = db.prepare('SELECT card_id FROM card_link_rejections WHERE catalog = ? AND variation_id = ?').all(catalog, variationId) as Array<{ card_id: number }>;
  return new Set(rows.map((r) => r.card_id));
}

/** Finds the copy for one matched Square variation. Throws CopyError when the catalog has no such variation. */
export function lookupCopy(db: Db, catalog: CopyCatalog, variationId: string): CopyLookup {
  const product = productFacts(catalog, variationId);
  if (!product) throw new CopyError('That Square item is not in the catalog.');
  const key = catalogKey(catalog);
  const index = catalog.index;
  const linked = liveCardForVariation(db, key, variationId);
  // An edited or imported card linked to the product is used as it is.
  if (linked && linked.source !== 'generated') return { product, card: linked, via: 'variation', pendingLink: null, suggestions: [], next: 'use' };

  const floor = linked ? PRECEDENCE[linked.source] : 0;
  const live = liveCards(db);
  // Rivals are cards not linked in this catalog: a card linked to another item here is not a
  // candidate, and the one linked to this item is what a better card would replace.
  const notHere = live.filter((c) => !linkIn(c, key));
  const others = notHere.map(linkable);
  const no = rejected(db, key, variationId);
  const sure: CardSuggestion[] = [];
  const maybe: CardSuggestion[] = [];
  for (const c of notHere) {
    if (PRECEDENCE[c.source] <= floor || no.has(c.id)) continue;
    const s = carriedLink(index, c.links, variationId, key) ?? sureLink(index, linkable(c), variationId, others);
    if (s) {
      sure.push({ card: c, method: s.method, score: 1, reasons: s.reasons });
      continue;
    }
    const byCode = c.scaleCode !== '' && c.scaleCode === product.scaleCode;
    const saleModeAgrees = cardSoldByWeight(c.content) === product.soldByWeight;
    const score = Math.round(cardScore(index, c.content, variationId) * 100) / 100;
    if (byCode || (score >= SUGGEST_SCORE && saleModeAgrees)) {
      const reasons = byCode ? [`Printed with scale code ${c.scaleCode}, the code this item has now, but the names differ.`] : [`The names are alike (score ${score}).`];
      if (!saleModeAgrees) reasons.push(product.soldByWeight ? `The card prints ${c.content.unit}, but Square sells this item by the pound.` : 'The card prints PER POUND, but Square sells this item by the unit.');
      maybe.push({ card: c, method: byCode ? 'scale_code' : 'name', score, reasons });
    }
  }
  const rank = (a: CardSuggestion, b: CardSuggestion) => PRECEDENCE[b.card.source] - PRECEDENCE[a.card.source] || b.score - a.score || a.card.id - b.card.id;
  sure.sort(rank);
  maybe.sort(rank);
  const best = sure[0];
  if (best) {
    const better = maybe.filter((m) => PRECEDENCE[m.card.source] > PRECEDENCE[best.card.source]).slice(0, MAX_SUGGESTIONS);
    return { product, card: best.card, via: best.method, pendingLink: { cardId: best.card.id, method: best.method }, suggestions: better, next: better.length ? 'confirm' : 'use' };
  }
  const suggestions = maybe.slice(0, MAX_SUGGESTIONS);
  if (linked) return { product, card: linked, via: 'variation', pendingLink: null, suggestions, next: suggestions.length ? 'confirm' : 'use' };
  return { product, card: null, via: null, pendingLink: null, suggestions, next: suggestions.length ? 'confirm' : 'generate' };
}

/** Saves the sure link a lookup found. A generated card it replaces is retired. */
export function saveLookupLink(db: Db, actor: AuditActor, lookup: CopyLookup, now: number = Date.now()): LinkResult | null {
  if (!lookup.pendingLink) return null;
  return linkCard(db, actor, lookup.pendingLink.cardId, linkTargetOf(lookup.product), lookup.pendingLink.method, {}, now);
}

/** A person confirms that a stored card is this product. It replaces whatever card the product had here. */
export function confirmSuggestion(db: Db, actor: AuditActor, catalog: CopyCatalog, cardId: number, variationId: string, now: number = Date.now()): LinkResult {
  const p = productFacts(catalog, variationId);
  if (!p) throw new CopyError('That Square item is not in the catalog.');
  return linkCard(db, actor, cardId, linkTargetOf(p), 'person', { replace: true }, now);
}

/** A person says a stored card is not this product in this catalog, so it is not suggested for it again. */
export function rejectSuggestion(db: Db, actor: AuditActor, catalog: CopyCatalog, cardId: number, variationId: string, now: number = Date.now()): void {
  const key = catalogKey(catalog);
  inTransaction(db, () => {
    if (!getCard(db, cardId)) throw new CopyError('That card no longer exists.');
    const res = db
      .prepare('INSERT OR IGNORE INTO card_link_rejections (card_id, catalog, variation_id, rejected_by, rejected_by_name, rejected_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(cardId, key, variationId, actor.userId, actor.username, new Date(now).toISOString());
    if (Number(res.changes) > 0) appendAudit(db, actor, { action: 'card_link_rejected', entityType: 'card', entityId: cardId, details: { catalog: key, variationId } }, now);
  });
}
