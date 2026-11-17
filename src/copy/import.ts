// Loads the cards imported from the existing card files (data/cards/imported.json, written by
// scripts/cards/import-reference.ts) into the card store, and links each to a Square variation
// in one catalog.
//
// - An import key belongs to one card for good. A new key adds a card. A newer printing of a
//   stored card replaces its text, unless a person edited it (decision 5) or the card was
//   retired: a retired card stays retired, so running the import again changes nothing else, and
//   rejections tied to the card's id still hold.
// - Links are made in the catalog given, which should be the catalog the runs use: variation ids
//   differ between the sandbox and live accounts (src/copy/store.ts). Carried links first, then
//   scale code, then name (src/copy/link.ts). A sure link is made at once. Every other card is
//   reported: with candidates for a person to confirm, with none, or in conflict with a card that
//   already holds its Square item.
// - Nothing store-specific is written here: the cards and the catalog are data.

import { cardKey, type ImportedCard } from '../cards/import.ts';
import type { AuditActor } from '../db/audit.ts';
import type { Db } from '../db/db.ts';
import type { CatalogIndex } from '../matching/catalog.ts';
import { rankByName } from '../matching/similarity.ts';
import { fullName } from './checks.ts';
import { candidatesForCard, cardLineText, carriedLinkFor, productFacts, sureLink, type LinkableCard, type LinkCandidate, type SureLink } from './link.ts';
import { cardByImportKey, catalogKey, insertImportedCard, linkCard, linkIn, linkTargetOf, liveCards, reimportCard } from './store.ts';
import { CopyError, type CardLink, type CopyCatalog, type StoredCard } from './types.ts';

export interface CardLinkProblem {
  cardId: number;
  name: string;
  producer: string;
  unit: string;
  /** The code printed on the card, or ''. */
  printedCode: string;
  why: string;
  candidates: LinkCandidate[];
}

export interface ImportReport {
  /** The catalog the links were made in: its key (Square location id) and source. */
  catalog: string;
  catalogSource: string;
  cards: number;
  created: number;
  reimported: number;
  unchanged: number;
  /** Stored cards a person edited: their text was kept. */
  editedKept: number;
  /** Cards replaced by another card before: they stay retired. */
  retiredKept: number;
  /** Cards that could not be stored, with the reason. */
  refused: Array<{ name: string; why: string }>;
  /** Linked here by carrying a link from another catalog to the item of the same name. */
  linkedByCarry: number;
  linkedByCode: number;
  linkedByName: number;
  /** Linked in this catalog by an earlier import or by a person. */
  alreadyLinked: number;
  /** Generated cards replaced by an imported card for the same product. */
  replacedGenerated: number;
  /** Not linked: candidates for a person to confirm. */
  toConfirm: CardLinkProblem[];
  /** Not linked: nothing in Square looks like this card. */
  noCandidate: CardLinkProblem[];
  /** Not linked: the sure Square item already has a card that wins. */
  conflicts: CardLinkProblem[];
}

function linkable(c: StoredCard): LinkableCard {
  return { id: c.id, content: c.content, scaleCode: c.scaleCode };
}

/** The one sure link for a card: carried from another catalog, then by code, then by name. Null if none. */
export function findSureLink(index: CatalogIndex, card: LinkableCard, others: readonly LinkableCard[], links: readonly CardLink[] = [], catalog = ''): SureLink | null {
  const carried = carriedLinkFor(index, links, catalog);
  if (carried) return carried;
  if (card.scaleCode !== '') {
    for (const item of index.byScaleCode.get(card.scaleCode) ?? []) {
      for (const v of item.variations) {
        const s = sureLink(index, card, v.id, others);
        if (s) return s;
      }
    }
  }
  for (const s of rankByName(index, cardLineText(card.content), { limit: 5 })) {
    const sure = sureLink(index, card, s.variation.id, others);
    if (sure) return sure;
  }
  return null;
}

function problem(card: StoredCard, why: string, candidates: LinkCandidate[]): CardLinkProblem {
  return { cardId: card.id, name: fullName(card.content), producer: card.content.producer, unit: card.content.unit, printedCode: card.printed?.code ?? card.scaleCode, why, candidates };
}

/** Imports the cards and links, in this catalog, what can be linked surely. Safe to run again. */
export function importCards(db: Db, actor: AuditActor, catalog: CopyCatalog, input: { cards: readonly ImportedCard[] }, now: number = Date.now()): ImportReport {
  const key = catalogKey(catalog);
  const index = catalog.index;
  const report: ImportReport = {
    catalog: key,
    catalogSource: catalog.source,
    cards: input.cards.length,
    created: 0,
    reimported: 0,
    unchanged: 0,
    editedKept: 0,
    retiredKept: 0,
    refused: [],
    linkedByCarry: 0,
    linkedByCode: 0,
    linkedByName: 0,
    alreadyLinked: 0,
    replacedGenerated: 0,
    toConfirm: [],
    noCandidate: [],
    conflicts: [],
  };
  // Live card ids in this import, once each: two entries with one key are one card, the later wins.
  const mine = new Set<number>();
  for (const c of input.cards) {
    try {
      const existing = cardByImportKey(db, cardKey(c));
      if (existing) {
        const outcome = reimportCard(db, actor, existing, c, now);
        if (outcome === 'reimported') report.reimported++;
        else if (outcome === 'unchanged') report.unchanged++;
        else if (outcome === 'edited_kept') report.editedKept++;
        else report.retiredKept++;
        if (outcome !== 'retired_kept') mine.add(existing.id);
      } else {
        mine.add(insertImportedCard(db, actor, c, now).id);
        report.created++;
      }
    } catch (err) {
      if (!(err instanceof CopyError)) throw err;
      report.refused.push({ name: fullName(c), why: err.message });
    }
  }

  const live = liveCards(db);
  // Rivals for a link are the cards not linked in this catalog yet. Cards linked by this run stay
  // in the list, so two cards that fit one item equally are both left for a person.
  const others = live.filter((c) => !linkIn(c, key)).map(linkable);
  const byId = new Map(live.map((c) => [c.id, c]));
  for (const id of mine) {
    const card = byId.get(id);
    if (!card) continue;
    if (linkIn(card, key)) {
      report.alreadyLinked++;
      continue;
    }
    const me = others.find((o) => o.id === id)!;
    const sure = findSureLink(index, me, others, card.links, key);
    if (!sure) {
      const candidates = candidatesForCard(index, me);
      if (candidates.length) report.toConfirm.push(problem(card, 'No sure match: a person must pick the Square item, or none.', candidates));
      else report.noCandidate.push(problem(card, 'Nothing in Square looks like this card.', []));
      continue;
    }
    const facts = productFacts(catalog, sure.variationId)!;
    try {
      const r = linkCard(db, actor, id, linkTargetOf(facts), sure.method, {}, now);
      if (sure.method === 'same_item') report.linkedByCarry++;
      else if (sure.method === 'scale_code') report.linkedByCode++;
      else report.linkedByName++;
      if (r.retired) report.replacedGenerated++;
    } catch (err) {
      if (!(err instanceof CopyError)) throw err;
      report.conflicts.push(problem(card, err.message, candidatesForCard(index, me)));
    }
  }
  return report;
}
