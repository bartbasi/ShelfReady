// The card store: exact imported text, edits with history and audit, precedence between edited,
// imported and generated cards, links per catalog that survive an item gaining a scale code,
// the check every generated card needs, and blocked cards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAudit } from '../src/db/audit.ts';
import { productFacts } from '../src/copy/link.ts';
import {
  cardBlockers,
  cardByImportKey,
  cardHistory,
  editCard,
  getCard,
  insertGeneratedCard,
  insertImportedCard,
  linkCard,
  linkIn,
  linkTargetOf,
  liveCardForVariation,
  markCardChecked,
  needsCheck,
  reimportCard,
  syncCardCodes,
  unlinkCard,
} from '../src/copy/store.ts';
import { CopyError, type CardReview } from '../src/copy/types.ts';
import { buildCatalogIndex } from '../src/matching/catalog.ts';
import { item, POUND, testObjects } from './matching-fixtures.ts';
import { ACTOR, CATALOG, content, db, imported, KEY, NOW, otherCatalog, PERSON } from './copy-fixtures.ts';

const review = (verify: CardReview['verify'] = []): CardReview => ({
  verify,
  sources: [],
  searches: [],
  problems: [],
  uniqueSellingPoint: '',
  productIdentified: true,
  model: 'claude-sonnet-5-5',
  costUsd: 0.1,
  generatedAt: new Date(NOW).toISOString(),
});

test('an imported card keeps its exact text, with history and an audit entry', () => {
  const d = db();
  const src = imported({ n1: 'Hilltop Aged ', n2: 'Cheddar', copy: ['Exactly  as printed,  spaces and all.', 'Second.'] });
  const card = insertImportedCard(d, ACTOR, src, NOW);
  assert.equal(card.source, 'imported');
  assert.deepEqual(card.links, []);
  assert.deepEqual(card.content.copy, src.copy, 'imported text is never cleaned or changed');
  assert.equal(card.printed?.price, '$9.99', 'the printed price is kept for reference only');
  assert.equal(cardHistory(d, card.id)[0]!.change, 'created');
  assert.equal(listAudit(d, { action: 'card_import' }).length, 1);
  assert.throws(() => insertImportedCard(d, ACTOR, src, NOW), /imported under .* before/);
});

test('card history is append only', () => {
  const d = db();
  const card = insertImportedCard(d, ACTOR, imported({ n1: '', n2: 'Brie' }), NOW);
  assert.throws(() => d.prepare('UPDATE card_history SET username = ? WHERE card_id = ?').run('x', card.id), /append only/);
  assert.throws(() => d.prepare('DELETE FROM card_history WHERE card_id = ?').run(card.id), /append only/);
});

test('an edit is kept from then on, with who, when, before and after', () => {
  const d = db();
  const card = insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' }), NOW);
  const edited = editCard(d, PERSON, card.id, 1, { copy: ['A new first paragraph,\nwritten by hand.', 'Second.'] }, NOW + 1000);
  assert.equal(edited.source, 'edited');
  assert.equal(edited.firstSource, 'imported');
  assert.equal(edited.version, 2);
  assert.deepEqual(edited.content.copy, ['A new first paragraph, written by hand.', 'Second.'], 'a line break inside a paragraph becomes a space');
  const h = cardHistory(d, card.id).at(-1)!;
  assert.equal(h.change, 'edited');
  assert.equal(h.username, 'manager1');
  assert.equal(h.userId, 7);
  assert.deepEqual(Object.keys(h.before), ['copy']);
  assert.deepEqual((h.after as { copy: string[] }).copy, edited.content.copy);
  const a = listAudit(d, { action: 'card_edit' })[0]!;
  assert.equal(a.username, 'manager1');
  assert.ok(JSON.parse(a.details).before.copy);
  const again = editCard(d, PERSON, card.id, 2, { copy: edited.content.copy }, NOW + 2000);
  assert.equal(again.version, 2);
  assert.equal(cardHistory(d, card.id).length, 2);
});

test('an edit over a newer version, an edit to price or code, and a broken shape are refused', () => {
  const d = db();
  const card = insertImportedCard(d, ACTOR, imported({ n1: '', n2: 'Brie' }), NOW);
  editCard(d, PERSON, card.id, 1, { origin: 'PRODUCT OF ELSEWHERE' }, NOW);
  assert.throws(() => editCard(d, PERSON, card.id, 1, { origin: 'X' }, NOW), /changed this card since you opened it/);
  assert.throws(() => editCard(d, PERSON, card.id, 2, { price: '$1.00' } as never, NOW), /price cannot be edited/);
  assert.throws(() => editCard(d, PERSON, card.id, 2, { code: '1234' } as never, NOW), /code cannot be edited/);
  assert.throws(() => editCard(d, PERSON, card.id, 2, { specs: [['A', 'B']] as never }, NOW), /exactly three specs/);
  assert.throws(() => editCard(d, PERSON, card.id, 2, { n1: '', n2: ' ' }, NOW), /name is empty/);
});

test('a newer printing replaces an unedited imported card, never an edited or retired one', () => {
  const d = db();
  const first = imported({ n1: '', n2: 'Brie' });
  const card = insertImportedCard(d, ACTOR, first, NOW);
  assert.equal(reimportCard(d, ACTOR, card, first, NOW), 'unchanged');
  const newer = { ...first, copy: ['Newer wording.', 'Second.'], source: { ...first.source, file: 'newer.docx' } };
  assert.equal(reimportCard(d, ACTOR, card, newer, NOW), 'reimported');
  assert.deepEqual(getCard(d, card.id)!.content.copy, ['Newer wording.', 'Second.']);
  const edited = editCard(d, PERSON, card.id, 2, { copy: ['By hand.', 'Second.'] }, NOW);
  assert.equal(reimportCard(d, ACTOR, edited, { ...newer, copy: ['Even newer.', 'Second.'] }, NOW), 'edited_kept');
  assert.deepEqual(getCard(d, card.id)!.content.copy, ['By hand.', 'Second.']);
  assert.equal(reimportCard(d, ACTOR, { ...edited, retiredAt: new Date(NOW).toISOString() }, newer, NOW), 'retired_kept');
});

test('precedence: an imported card replaces a generated one, not the other way round, and an edit beats both', () => {
  const d = db();
  const p = productFacts(CATALOG, 'V_CHEDDAR')!;
  const target = linkTargetOf(p);
  const gen = insertGeneratedCard(d, ACTOR, { product: p, content: content(), review: review(), blocked: [], auditDetails: { model: 'claude-sonnet-5-5' } }, NOW);
  assert.equal(linkIn(gen, KEY)?.method, 'generated');
  assert.throws(() => insertGeneratedCard(d, ACTOR, { product: p, content: content(), review: review(), blocked: [], auditDetails: {} }, NOW), /already has a card/);

  const imp = insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' }), NOW);
  const r = linkCard(d, ACTOR, imp.id, target, 'name', {}, NOW);
  assert.equal(r.retired?.id, gen.id, 'the generated card is retired, not deleted');
  assert.ok(getCard(d, gen.id)!.retiredAt);
  assert.deepEqual(getCard(d, gen.id)!.links, [], 'a retired card has no links');
  assert.equal(liveCardForVariation(d, KEY, 'V_CHEDDAR')!.id, imp.id);

  const imp2 = insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop ', n2: 'Cheddar', producer: 'Other · Place' }), NOW);
  assert.throws(() => linkCard(d, ACTOR, imp2.id, target, 'name', {}, NOW), CopyError);
  const edited = editCard(d, PERSON, imp2.id, 1, { origin: 'PRODUCT OF ELSEWHERE' }, NOW);
  assert.equal(edited.source, 'edited');
  const r2 = linkCard(d, PERSON, imp2.id, target, 'person', {}, NOW);
  assert.equal(r2.retired?.id, imp.id);
  assert.deepEqual(cardHistory(d, gen.id).map((h) => h.change), ['created', 'retired']);
  assert.equal(listAudit(d, { action: 'card_retire' }).length, 2);
});

test('links are per catalog: one card can hold a link in each, and a link records its catalog source', () => {
  const d = db();
  const other = otherCatalog();
  const card = insertImportedCard(d, ACTOR, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' }), NOW);
  linkCard(d, ACTOR, card.id, linkTargetOf(productFacts(CATALOG, 'V_CHEDDAR')!), 'name', {}, NOW);
  linkCard(d, ACTOR, card.id, linkTargetOf(productFacts(other, 'SBX_V_CHEDDAR')!), 'name', {}, NOW);
  const now = getCard(d, card.id)!;
  assert.deepEqual(now.links.map((l) => [l.catalog, l.catalogSource, l.variationId]).sort(), [
    ['LOC_OTHER', 'square_sandbox', 'SBX_V_CHEDDAR'],
    ['LOC_TEST', 'test', 'V_CHEDDAR'],
  ]);
  assert.equal(liveCardForVariation(d, 'LOC_OTHER', 'SBX_V_CHEDDAR')!.id, card.id);
  assert.equal(liveCardForVariation(d, 'LOC_OTHER', 'V_CHEDDAR'), null, 'an id from one catalog means nothing in another');
  unlinkCard(d, PERSON, card.id, 'LOC_OTHER', NOW);
  assert.deepEqual(getCard(d, card.id)!.links.map((l) => l.catalog), ['LOC_TEST']);
});

test('a link by variation survives the item gaining a scale code, and the code is recorded', () => {
  const d = db();
  const at = (name: string) => ({ index: buildCatalogIndex({ objects: [...testObjects(), item({ id: 'I_NEW', name, category: 'CAT_CHEESE', variations: [{ id: 'V_NEW', cents: 1999, unit: POUND }] })], locationId: KEY }), source: 'test' });
  const before = at('Valley Blue');
  const card = insertImportedCard(d, ACTOR, imported({ n1: 'Valley ', n2: 'Blue' }), NOW);
  const p = productFacts(before, 'V_NEW')!;
  assert.equal(p.scaleCode, null);
  linkCard(d, ACTOR, card.id, linkTargetOf(p), 'name', {}, NOW);
  assert.equal(getCard(d, card.id)!.scaleCode, '');
  const sync = syncCardCodes(d, ACTOR, at('Valley Blue 7104'), NOW);
  assert.equal(sync.updated, 1);
  const now = getCard(d, card.id)!;
  assert.equal(linkIn(now, KEY)?.variationId, 'V_NEW', 'the link is kept');
  assert.equal(now.scaleCode, '7104');
  assert.equal(cardHistory(d, card.id).at(-1)!.change, 'code_seen');
  const gone = syncCardCodes(d, ACTOR, CATALOG, NOW);
  assert.deepEqual(gone.missing.map((m) => m.cardId), [card.id]);
  assert.equal(linkIn(getCard(d, card.id)!, KEY)?.variationId, 'V_NEW');
});

test('every generated card needs a check of its current version, even with an empty verify list', () => {
  const d = db();
  const p = productFacts(CATALOG, 'V_BRIE')!;
  const gen = insertGeneratedCard(d, ACTOR, { product: p, content: content({ n1: 'Meadow ', n2: 'Brie' }), review: review([]), blocked: [], auditDetails: {} }, NOW);
  assert.equal(gen.review!.verify.length, 0);
  assert.equal(needsCheck(gen), true, 'an empty verify list proves nothing');
  assert.match(cardBlockers(gen).join(' '), /A person must check this version/);
  const checked = markCardChecked(d, PERSON, gen.id, 1, NOW);
  assert.equal(needsCheck(checked), false);
  assert.deepEqual(cardBlockers(checked), []);
  const edited = editCard(d, PERSON, gen.id, 1, { origin: 'PRODUCT OF ELSEWHERE' }, NOW);
  assert.equal(needsCheck(edited), true, 'an edit makes a new version to check');
  assert.throws(() => markCardChecked(d, PERSON, gen.id, 1, NOW), /changed this card/);
  const imp = insertImportedCard(d, ACTOR, imported({ n1: '', n2: 'Brie' }), NOW);
  assert.equal(needsCheck(imp), false, 'imported cards were printed before and need no check');
});

test('a blocked card stays blocked until an edit removes the finding', () => {
  const d = db();
  const p = productFacts(CATALOG, 'V_BRIE')!;
  const bad = content({ n1: 'Meadow ', n2: 'Brie', copy: ['Call (217) 555-0123 to order.', 'Second.'] });
  const gen = insertGeneratedCard(d, ACTOR, { product: p, content: bad, review: review(), blocked: ['The card has a phone number on it.'], auditDetails: {} }, NOW);
  assert.match(cardBlockers(gen).join(' '), /Blocked until edited/);
  const stillBad = editCard(d, PERSON, gen.id, 1, { copy: ['Call 217 555 0123 to order.', 'Second.'] }, NOW);
  assert.equal(stillBad.blocked.length, 1, 'the number is still there');
  const fixed = editCard(d, PERSON, gen.id, 2, { copy: ['Ask at the counter.', 'Second.'] }, NOW);
  assert.deepEqual(fixed.blocked, []);
  assert.deepEqual((cardHistory(d, gen.id).at(-1)!.after as { blocked: string[] }).blocked, []);
  // A person's own edit on a card that was never blocked is trusted as written.
  const imp = insertImportedCard(d, ACTOR, imported({ n1: '', n2: 'Brie' }), NOW);
  assert.deepEqual(editCard(d, PERSON, imp.id, 1, { copy: ['See the case.', 'Second.'] }, NOW).blocked, []);
});

test('a catalog with no Square location id is refused, since its links could not be told apart', () => {
  const none = { index: buildCatalogIndex({ objects: testObjects(), locationId: '' }), source: 'file' };
  assert.throws(() => productFacts(none, 'V_CHEDDAR'), /no Square location id/);
});

test('an import key belongs to one card for good, retired or not', () => {
  const d = db();
  const src = imported({ n1: '', n2: 'Brie' });
  const card = insertImportedCard(d, ACTOR, src, NOW);
  d.prepare('UPDATE cards SET retired_at = ? WHERE id = ?').run(new Date(NOW).toISOString(), card.id);
  assert.equal(cardByImportKey(d, card.importKey)!.id, card.id);
  assert.throws(() => insertImportedCard(d, ACTOR, src, NOW), /imported under .* before/);
});
