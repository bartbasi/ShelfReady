// The lookup order for a product on a run: edited copy, then imported copy, then generated copy
// already stored, then new copy (decision 5). The lookup only reads; links are saved on request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productFacts } from '../src/copy/link.ts';
import { confirmSuggestion, lookupCopy, rejectSuggestion, saveLookupLink } from '../src/copy/lookup.ts';
import { cardHistory, editCard, getCard, insertGeneratedCard, insertImportedCard, linkCard, linkIn, linkTargetOf, liveCards } from '../src/copy/store.ts';
import type { CardReview } from '../src/copy/types.ts';
import { buildCatalogIndex } from '../src/matching/catalog.ts';
import { item, POUND, testObjects } from './matching-fixtures.ts';
import { ACTOR, CATALOG, content, db, imported, KEY, NOW, PERSON } from './copy-fixtures.ts';

const review: CardReview = {
  verify: [],
  sources: [],
  searches: [],
  problems: [],
  uniqueSellingPoint: '',
  productIdentified: true,
  model: 'claude-sonnet-5-5',
  costUsd: 0.1,
  generatedAt: new Date(NOW).toISOString(),
};

test('a product with no stored copy needs new copy', () => {
  const r = lookupCopy(db(), CATALOG, 'V_CHEDDAR');
  assert.equal(r.card, null);
  assert.equal(r.next, 'generate');
  assert.equal(r.product.label, 'Hilltop Aged Cheddar 7102');
  assert.equal(r.product.catalog, KEY);
  assert.throws(() => lookupCopy(db(), CATALOG, 'V_NOT_THERE'), /not in the catalog/);
});

test('a linked imported card is used as it is, with its exact text', () => {
  const d = db();
  const src = imported({ n1: 'Hilltop Aged ', n2: 'Cheddar', copy: ['Exactly as printed.', 'Second.'] });
  const card = insertImportedCard(d, ACTOR, src, NOW);
  linkCard(d, ACTOR, card.id, linkTargetOf(productFacts(CATALOG, 'V_CHEDDAR')!), 'name', {}, NOW);
  const r = lookupCopy(d, CATALOG, 'V_CHEDDAR');
  assert.equal(r.next, 'use');
  assert.equal(r.via, 'variation');
  assert.deepEqual(r.card!.content.copy, src.copy);
});

test('an unlinked card that surely names the product is found, and its link saved only on request', () => {
  const d = db();
  const card = insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' }), NOW);
  const r = lookupCopy(d, CATALOG, 'V_CHEDDAR');
  assert.equal(r.next, 'use');
  assert.equal(r.via, 'name');
  assert.deepEqual(r.pendingLink, { cardId: card.id, method: 'name' });
  assert.deepEqual(getCard(d, card.id)!.links, [], 'the lookup writes nothing');
  saveLookupLink(d, ACTOR, r, NOW);
  const again = lookupCopy(d, CATALOG, 'V_CHEDDAR');
  assert.equal(again.via, 'variation');
  assert.equal(again.card!.id, card.id);
});

test('imported copy wins over generated copy already stored; saving the link retires the generated card', () => {
  const d = db();
  const p = productFacts(CATALOG, 'V_CHEDDAR')!;
  const gen = insertGeneratedCard(d, ACTOR, { product: p, content: content(), review, blocked: [], auditDetails: {} }, NOW);
  assert.equal(lookupCopy(d, CATALOG, 'V_CHEDDAR').card!.id, gen.id, 'with nothing better, the generated card is used');
  const imp = insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' }), NOW);
  const r = lookupCopy(d, CATALOG, 'V_CHEDDAR');
  assert.equal(r.card!.id, imp.id);
  const saved = saveLookupLink(d, ACTOR, r, NOW)!;
  assert.equal(saved.retired!.id, gen.id);
  assert.deepEqual(liveCards(d).map((c) => c.id), [imp.id]);
});

test('edited copy wins over imported copy', () => {
  const d = db();
  const p = productFacts(CATALOG, 'V_CHEDDAR')!;
  const gen = insertGeneratedCard(d, ACTOR, { product: p, content: content(), review, blocked: [], auditDetails: {} }, NOW);
  const edited = editCard(d, PERSON, gen.id, 1, { copy: ['Rewritten by hand.', 'Second.'] }, NOW);
  insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' }), NOW);
  const r = lookupCopy(d, CATALOG, 'V_CHEDDAR');
  assert.equal(r.card!.id, edited.id);
  assert.equal(r.card!.source, 'edited');
  assert.equal(r.next, 'use');
  assert.deepEqual(r.suggestions, []);
});

test('a card that may be the product is suggested; a person confirms it or says no, and a no is remembered', () => {
  const d = db();
  const maybe = insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar Reserve' }), NOW);
  const r = lookupCopy(d, CATALOG, 'V_CHEDDAR');
  assert.equal(r.card, null);
  assert.equal(r.next, 'confirm');
  assert.deepEqual(r.suggestions.map((s) => s.card.id), [maybe.id]);
  rejectSuggestion(d, PERSON, CATALOG, maybe.id, 'V_CHEDDAR', NOW);
  rejectSuggestion(d, PERSON, CATALOG, maybe.id, 'V_CHEDDAR', NOW);
  assert.equal(lookupCopy(d, CATALOG, 'V_CHEDDAR').next, 'generate');
  const d2 = db();
  const card2 = insertImportedCard(d2, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar Reserve' }), NOW);
  confirmSuggestion(d2, PERSON, CATALOG, card2.id, 'V_CHEDDAR', NOW);
  const linked = lookupCopy(d2, CATALOG, 'V_CHEDDAR');
  assert.equal(linked.card!.id, card2.id);
  assert.equal(linkIn(linked.card!, KEY)?.method, 'person');
  assert.equal(cardHistory(d2, card2.id).at(-1)!.username, 'manager1');
});

test('a code suggestion whose sale mode differs says so', () => {
  const d = db();
  // Printed with the gouda's code, but as a pack, and under another name.
  insertImportedCard(d, ACTOR, imported({ code: '7101', n1: 'Dutch ', n2: 'Wedge', unit: '200 GRAMS' }), NOW);
  const r = lookupCopy(d, CATALOG, 'V_GOUDA');
  assert.equal(r.next, 'confirm');
  assert.ok(r.suggestions[0]!.reasons.some((x) => /prints 200 GRAMS, but Square sells this item by the pound/.test(x)));
});

test('a card linked before its item had a code is still found after the code appears', () => {
  const d = db();
  const at = (name: string) => ({ index: buildCatalogIndex({ objects: [...testObjects(), item({ id: 'I_NEW', name, category: 'CAT_CHEESE', variations: [{ id: 'V_NEW', cents: 1999, unit: POUND }] })], locationId: KEY }), source: 'test' });
  const card = insertImportedCard(d, ACTOR, imported({ n1: 'Valley ', n2: 'Blue' }), NOW);
  saveLookupLink(d, ACTOR, lookupCopy(d, at('Valley Blue'), 'V_NEW'), NOW);
  const r = lookupCopy(d, at('Valley Blue 7104'), 'V_NEW');
  assert.equal(r.card!.id, card.id);
  assert.equal(r.via, 'variation');
});

test('a card printed with a code, unlinked, is found by that code when the names agree', () => {
  const d = db();
  const card = insertImportedCard(d, ACTOR, imported({ code: '7101', n1: 'Smoked ', n2: 'Gouda' }), NOW);
  const r = lookupCopy(d, CATALOG, 'V_GOUDA');
  assert.equal(r.card!.id, card.id);
  assert.equal(r.via, 'scale_code');
});
