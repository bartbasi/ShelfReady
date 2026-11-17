// Importing existing cards into the store and linking them to Square in one catalog: carried
// links, then scale code, then name; sure links made at once, everything else reported. Running
// the import again changes nothing, retired cards included. Invented data only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCards } from '../src/copy/import.ts';
import { productFacts } from '../src/copy/link.ts';
import { lookupCopy, rejectSuggestion } from '../src/copy/lookup.ts';
import { editCard, getCard, linkCard, linkIn, linkTargetOf, liveCards } from '../src/copy/store.ts';
import { buildCatalogIndex } from '../src/matching/catalog.ts';
import { item, POUND, testObjects } from './matching-fixtures.ts';
import { ACTOR, CATALOG, db, imported, KEY, NOW, otherCatalog, PERSON } from './copy-fixtures.ts';

const cards = () => [
  // Sure by code: the code is still on the same cheese, and the names agree.
  imported({ code: '7101', n1: 'Smoked ', n2: 'Gouda', producer: 'Test Dairy · Testville' }),
  // Printed before the item had a code: sure by name, and the link picks up the code.
  imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' }),
  imported({ n1: 'Fennel ', n2: 'Salami', eyebrow: '02 / CURED MEAT', producer: 'Test Curing · Testville' }),
  // Packaged goods: the maker in the Square name must be in the producer line.
  imported({ n1: 'Sea Salt ', n2: 'Crackers', unit: '150 GRAMS', eyebrow: '03 / CRACKERS', producer: 'Bluecrest · Coastal Town' }),
  // A flavour that is a variation of one Square item.
  imported({ n1: 'Black Truffle ', n2: 'Chips', unit: 'EACH', eyebrow: '09 / PANTRY', producer: 'Ridgeway · Hill Town' }),
  // Close, but not the same product: a person must confirm.
  imported({ n1: 'Smoked Tavern ', n2: 'Ham', eyebrow: '02 / CURED MEAT', producer: 'Oakvale · Testville' }),
  // Nothing like it in Square.
  imported({ n1: 'Mystery ', n2: 'Nougat', unit: 'EACH', eyebrow: '10 / SWEETS', producer: 'Nobody · Nowhere' }),
];

test('cards link by code, then by name, in the catalog given, and the rest are reported', () => {
  const d = db();
  const r = importCards(d, ACTOR, CATALOG, { cards: cards() }, NOW);
  assert.equal(r.catalog, KEY);
  assert.equal(r.catalogSource, 'test');
  assert.equal(r.cards, 7);
  assert.equal(r.created, 7);
  assert.equal(r.linkedByCode, 1);
  assert.equal(r.linkedByName, 4);
  const linked = new Map(liveCards(d).flatMap((c) => c.links.map((l) => [l.variationId, { card: c, link: l }] as const)));
  assert.equal(linked.get('V_GOUDA')?.link.method, 'scale_code');
  assert.equal(linked.get('V_CHEDDAR')?.link.method, 'name');
  assert.equal(linked.get('V_CHEDDAR')?.link.catalogSource, 'test');
  assert.equal(linked.get('V_CHEDDAR')?.card.scaleCode, '7102', 'a card printed without a code takes the item’s code when linked');
  assert.ok(linked.has('V_SALAMI'));
  assert.ok(linked.has('V_CRACKER'));
  assert.ok(linked.has('V_CHIPS_TRUFFLE'));
  assert.deepEqual(r.toConfirm.map((p) => p.name), ['Smoked Tavern Ham']);
  assert.equal(r.toConfirm[0]!.candidates[0]!.variationId, 'V_HAM', 'the right item is offered first');
  assert.deepEqual(r.noCandidate.map((p) => p.name), ['Mystery Nougat']);
  assert.deepEqual(r.conflicts, []);
});

test('running the import again changes nothing, and a retired card stays retired with its rejections', () => {
  const d = db();
  const list = cards();
  importCards(d, ACTOR, CATALOG, { cards: list }, NOW);
  // A person replaces the imported cheddar card with an edited one, and turns down the tavern ham
  // card for the ham item.
  const cheddar = liveCards(d).find((c) => linkIn(c, KEY)?.variationId === 'V_CHEDDAR')!;
  const ham = liveCards(d).find((c) => c.content.n2 === 'Ham')!;
  const spare = liveCards(d).find((c) => c.content.n2 === 'Nougat')!;
  const mine = editCard(d, PERSON, spare.id, 1, { origin: 'PRODUCT OF ELSEWHERE' }, NOW);
  linkCard(d, PERSON, mine.id, { ...linkTargetOf(productFacts(CATALOG, 'V_CHEDDAR')!) }, 'person', { replace: true }, NOW);
  assert.ok(getCard(d, cheddar.id)!.retiredAt);
  rejectSuggestion(d, PERSON, CATALOG, ham.id, 'V_HAM', NOW);
  const before = liveCards(d).length;
  const again = importCards(d, ACTOR, CATALOG, { cards: list }, NOW);
  assert.equal(again.created, 0, 'no card comes back');
  assert.equal(again.retiredKept, 1);
  assert.equal(again.editedKept, 1);
  assert.equal(liveCards(d).length, before);
  assert.ok(getCard(d, cheddar.id)!.retiredAt, 'still retired');
  assert.equal(lookupCopy(d, CATALOG, 'V_HAM').suggestions.some((s) => s.card.id === ham.id), false, 'the rejection still holds: the card kept its id');
});

test('in another catalog, links carry to the items of the same name, so nothing is written again', () => {
  const d = db();
  importCards(d, ACTOR, CATALOG, { cards: cards() }, NOW);
  // A person confirmed the tavern ham card in the first catalog.
  const ham = liveCards(d).find((c) => c.content.n2 === 'Ham')!;
  linkCard(d, PERSON, ham.id, linkTargetOf(productFacts(CATALOG, 'V_HAM')!), 'person', {}, NOW);
  const other = otherCatalog();
  // Before any import there, a lookup still finds the printed cards.
  const found = lookupCopy(d, other, 'SBX_V_HAM');
  assert.equal(found.card?.id, ham.id);
  assert.equal(found.via, 'same_item');
  assert.equal(found.next, 'use');
  const r = importCards(d, ACTOR, other, { cards: cards() }, NOW);
  assert.equal(r.catalog, 'LOC_OTHER');
  assert.equal(r.linkedByCarry, 6, 'every link made in the first catalog carries, the person’s pick included');
  assert.deepEqual(r.toConfirm, []);
  assert.equal(linkIn(getCard(d, ham.id)!, 'LOC_OTHER')?.variationId, 'SBX_V_HAM');
  assert.equal(linkIn(getCard(d, ham.id)!, KEY)?.variationId, 'V_HAM', 'the first catalog’s link is kept');
});

test('two cards with the same name and no maker in Square are both left for a person', () => {
  const d = db();
  const r = importCards(
    d,
    ACTOR,
    CATALOG,
    {
      cards: [
        imported({ n1: 'Meadow ', n2: 'Brie', producer: 'Farm One · Place' }),
        imported({ n1: 'Meadow ', n2: 'Brie', producer: 'Farm Two · Place' }),
      ],
    },
    NOW,
  );
  assert.equal(r.linkedByName, 0);
  assert.equal(r.toConfirm.length, 2);
  assert.ok(r.toConfirm.every((p) => p.candidates[0]?.variationId === 'V_BRIE'));
});

test('a code given to another product since the card was printed does not link', () => {
  const d = db();
  const r = importCards(d, ACTOR, CATALOG, { cards: [imported({ code: '7103', n1: 'Blue ', n2: 'Stilton' })] }, NOW);
  assert.equal(r.linkedByCode + r.linkedByName, 0);
  const p = r.toConfirm[0]!;
  assert.equal(p.printedCode, '7103');
  assert.equal(p.candidates[0]!.variationId, 'V_BRIE');
  assert.equal(p.candidates[0]!.method, 'scale_code');
  assert.ok(p.candidates[0]!.reasons.some((x) => /given to another product/.test(x)));
  assert.equal(getCard(d, p.cardId)!.scaleCode, '7103', 'the printed code is kept on the card');
});

test('code and name pointing at different items leave the card for a person', () => {
  const d = db();
  const archived = item({ id: 'I_RES', name: 'Smoked Gouda Reserve 7105', category: 'CAT_CHEESE', archived: true, variations: [{ id: 'V_RES', cents: 2599, unit: POUND }] });
  const catalog = { index: buildCatalogIndex({ objects: [...testObjects(), archived], locationId: KEY }), source: 'test' };
  const r = importCards(
    d,
    ACTOR,
    catalog,
    {
      cards: [
        // Printed with the plain gouda's code, but named for another item, here an archived one.
        imported({ code: '7101', n1: 'Smoked Gouda ', n2: 'Reserve' }),
        // Named exactly for the brie, but printed with the ham's code.
        imported({ code: '1201', n1: 'Meadow ', n2: 'Brie', producer: 'Farm One · Place' }),
      ],
    },
    NOW,
  );
  assert.equal(r.linkedByCode + r.linkedByName, 0);
  assert.deepEqual(r.toConfirm.map((p) => p.name).sort(), ['Meadow Brie', 'Smoked Gouda Reserve']);
});

test('the sale mode must agree: a code link is refused for a card printed per pound on a unit item', () => {
  const d = db();
  const unitItem = item({ id: 'I_UNIT', name: 'Valley Blue 7104', category: 'CAT_CHEESE', variations: [{ id: 'V_UNIT', cents: 899, upc: undefined }] });
  const catalog = { index: buildCatalogIndex({ objects: [...testObjects(), unitItem], locationId: KEY }), source: 'test' };
  assert.equal(catalog.index.itemById.get('I_UNIT')!.scaleCode, '7104', 'still a code: most numbered cheeses are sold by weight');
  // The item has a code, so it counts as sold by weight; a pack card for it is refused.
  const r = importCards(d, ACTOR, catalog, { cards: [imported({ code: '7104', n1: 'Valley ', n2: 'Blue', unit: '200 GRAMS' })] }, NOW);
  assert.equal(r.linkedByCode, 0);
  assert.equal(r.toConfirm.length, 1);
});

test('a packaged card does not link to a by-weight item of the same name', () => {
  const d = db();
  const r = importCards(d, ACTOR, CATALOG, { cards: [imported({ n1: 'Fennel ', n2: 'Salami', unit: '200 GRAMS', producer: 'Test Curing · Testville' })] }, NOW);
  assert.equal(r.linkedByName, 0);
  assert.equal(r.toConfirm.length, 1);
});

test('a card that cannot be stored is refused with the reason, and the rest import', () => {
  const d = db();
  const broken = imported({ n1: 'Bad ', n2: 'Card', copy: ['Line one\nline two.'] });
  const r = importCards(d, ACTOR, CATALOG, { cards: [broken, imported({ n1: 'Hilltop Aged ', n2: 'Cheddar' })] }, NOW);
  assert.equal(r.refused.length, 1);
  assert.match(r.refused[0]!.why, /line break/);
  assert.equal(r.created, 1);
});
