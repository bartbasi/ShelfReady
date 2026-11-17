// Code checks on new card copy: the limits from a fixed test config, the style rules, the guard
// against prices, phone numbers and web addresses, the cleaning of text, and what stops a card
// from printing. No network, no store data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardForPrinting, categoryWord, currentEyebrow, formatPrice, printableCard, printProblems } from '../src/copy/card.ts';
import { checkContent, copyChars, guardProblems, nameLines, normalizeContent, PER_POUND, priceTalk } from '../src/copy/checks.ts';
import { loadCopyConfig, parseEyebrow } from '../src/copy/config.ts';
import { cleanText, curlyApostrophes, designationTerms, flaggedPhrases, guardFindings, priceWords, safeUrl, unwantedDashes, urlKey } from '../src/copy/text.ts';
import type { StoredCard } from '../src/copy/types.ts';
import { countryKey } from '../src/copy/verify.ts';
import { CONFIG, content } from './copy-fixtures.ts';

// Written as numbers, so no editor or tool can turn an escape into the character itself.
const cp = (...n: number[]) => String.fromCodePoint(...n);
const EM = cp(0x2014);
const EN = cp(0x2013);
const ZWSP = cp(0x200b);
const RLO = cp(0x202e);

const L = CONFIG.limits;
const byWeight = { flagPhrases: CONFIG.guide.flagPhrases, soldByWeight: true };
const messages = (c: Parameters<typeof checkContent>[0], opts = byWeight) => checkContent(c, L, opts).map((p) => p.message);

test('the fixed test config gives limits, categories and a writing guide', () => {
  assert.equal(L.copy.maxChars, 360);
  assert.equal(L.copy.targetChars, 340);
  assert.equal(L.name.maxChars, 45);
  assert.equal(L.specLabel.maxChars, 12);
  assert.deepEqual(CONFIG.categories[0], { number: '01', word: 'CHEESE' });
  assert.equal(CONFIG.guide.curlyApostrophes, true);
  assert.deepEqual(parseEyebrow('07 / TINNED FISH'), { number: '07', word: 'TINNED FISH' });
  assert.equal(parseEyebrow('Cheese'), null);
});

test('the store config file loads as copy rules', () => {
  // Only that it loads: the values belong to the store and may change.
  const store = loadCopyConfig();
  assert.ok(store.categories.length > 0);
  assert.ok(store.guide.voice.length > 0);
});

test('a card within every limit has no problems', () => {
  assert.deepEqual(messages(content()), []);
});

test('copy over the limit says how long it is and how much to cut', () => {
  const long = 'word '.repeat(80).trim();
  const c = content({ copy: [long, 'A second paragraph.'] });
  const chars = copyChars(c.copy);
  const m = messages(c);
  assert.equal(m.length, 1);
  assert.match(m[0]!, new RegExp(`run to ${chars} characters`));
  assert.match(m[0]!, /The most is 360 \(aim for 340\)/);
  assert.match(m[0]!, new RegExp(`Cut about ${chars - 340} characters`));
});

test('copy needs exactly two paragraphs, neither empty', () => {
  assert.match(messages(content({ copy: ['Only one.'] }))[0]!, /has 1 paragraphs\. It must have 2/);
  assert.ok(messages(content({ copy: ['One.', ' '] })).some((m) => /Paragraph 2 is empty/.test(m)));
});

test('the name is checked as it wraps: at most two lines and 45 characters', () => {
  assert.deepEqual(nameLines('Hilltop Aged Cheddar', 24), ['Hilltop Aged Cheddar']);
  assert.deepEqual(nameLines('Extraordinarily Long Cave Aged Clothbound Cheddar', 24), ['Extraordinarily Long', 'Cave Aged Clothbound', 'Cheddar']);
  assert.deepEqual(messages(content({ n1: 'Cave Aged Clothbound ', n2: 'Cheddar Wheel' })), []);
  const m = messages(content({ n1: 'Extraordinarily Long Cave Aged ', n2: 'Clothbound Cheddar' }));
  assert.equal(m.length, 1);
  assert.match(m[0]!, /takes 3 lines of 24\. The most is 45 characters on 2 lines/);
});

test('producer, spec labels and spec values have their own limits', () => {
  assert.ok(messages(content({ producer: `${'P'.repeat(55)} · Place` })).some((m) => /producer line is 63 characters\. The most is 60/.test(m)));
  assert.match(messages(content({ specs: [['MILKINESSLEVEL', 'Cow’s'], ['AGE', '1 Year'], ['CUT', 'To Order']] }))[0]!, /label MILKINESSLEVEL is 14 characters\. The most is 12/);
  assert.match(messages(content({ specs: [['MILK', 'Cow’s and goat’s'], ['AGE', '1'], ['CUT', 'Wedge']] }))[0]!, /is 16 characters\. The most is 15/);
});

test('the producer line must read Maker · Place', () => {
  assert.deepEqual(messages(content({ producer: 'Farmed · Aegean Sea' })), []);
  for (const bad of ['Hilltop Dairy', 'Hilltop · Testville · North', ' · Testville', 'Hilltop · ']) {
    assert.ok(messages(content({ producer: bad })).some((m) => /must read Maker · Place/.test(m)), bad);
  }
});

test('a long spec value fits only beside a short neighbour', () => {
  // 13 + 6 = 19, within two targets (22): fine.
  assert.deepEqual(messages(content({ specs: [['MILK', 'Cow and Sheep'], ['AGE', '1 Year'], ['CUT', 'To Order']] })), []);
  // 13 + 12 = 25: they crowd each other.
  const m = messages(content({ specs: [['MILK', 'Cow and Sheep'], ['AGE', 'Twelve Weeks'], ['CUT', 'Wedge']] }));
  assert.equal(m.length, 1);
  assert.match(m[0]!, /sit side by side and run to 25 characters together\. Neighbours may take 22 at most/);
});

test('PER POUND is refused for goods Square sells by the unit', () => {
  const unitGoods = { flagPhrases: CONFIG.guide.flagPhrases, soldByWeight: false };
  assert.ok(messages(content({ unit: 'PER POUND' }), unitGoods).some((m) => /sells this item by the unit, so the unit is the size of one package/.test(m)));
  assert.deepEqual(messages(content({ unit: '150 GRAMS' }), unitGoods), []);
});

test('dashes the store never prints and marketing words are flagged; a company name is not', () => {
  assert.ok(messages(content({ copy: [`Firm ${EM} and crumbly.`, 'Fine.'] })).some((m) => /em dash/.test(m)));
  assert.ok(messages(content({ copy: ['Firm -- and crumbly.', 'Fine.'] })).some((m) => /double hyphen/.test(m)));
  assert.ok(messages(content({ copy: [`Firm ${EN} and crumbly.`, 'Fine.'] })).some((m) => /spaced en dash/.test(m)));
  assert.deepEqual(messages(content({ copy: [`Aged 6${EN}8 months.`, 'Fine.'] })), [], 'an en dash in a range is fine');
  assert.ok(messages(content({ copy: ['An indulgent, decadent cheese.', 'Fine.'] })).some((m) => /Reads like marketing: indulgent, decadent/.test(m)));
  assert.deepEqual(flaggedPhrases('Perfectly ordinary.', ['perfect for']), []);
  assert.deepEqual(messages(content({ producer: 'Harbour Fish & Gourmet · Port Town' })), [], 'a company name on the producer line is not marketing');
});

test('the guard blocks money in any form, after NFKC', () => {
  const money = (t: string) => guardFindings(t).includes('price');
  // A full-width dollar sign and digits fold to plain ones.
  assert.ok(money(`Only ${cp(0xff04, 0xff19, 0xff0e, 0xff19, 0xff19)} today.`));
  for (const t of ['Only $9.99.', 'Yours for 9 euros.', 'Two dollars off.', 'Twenty-five cents more.', 'Just 50 cents more.', 'Ten bucks a wedge.', 'USD 12 a jar.', '2.99 a pound.', 'Now 12.50/lb.', 'Only 12.50 here.', 'Yours for 12.99.', 'Was 14.00, now 9.00.', `${cp(0x20ac)}5 a jar.`, `${cp(0x00a3)}4.`]) {
    assert.ok(money(t), t);
  }
  for (const t of ['About sixty per cent less fat.', 'Whole fish of 1.25 to 1.5 pounds.', 'Aged 2.50 years.', 'A 1.41 oz bag.', 'A tall 11.15 fl oz can.', 'Sold by the pound, cut to order.', 'Since 1750, in the same valley.', '16/20 count shrimp, 600/800 g.', 'Sixteen to twenty per pound.', '16 to 20 per pound.']) {
    assert.ok(!money(t), t);
  }
});

test('talk of price with no amount never blocks: it goes on the verify list', () => {
  // Wording of the kind the store's own cards use, invented here.
  for (const t of ['The slow drying is the reason for the price.', 'At this price it is a jar to keep open.', 'Not the stringy kind a cheap tin gives you.', 'It is priced as a cooking oil, and worth it.', 'Cheap enough to keep two in the cupboard.', 'An expensive grain, and an affordable one.']) {
    assert.deepEqual(guardFindings(t), [], t);
    assert.ok(priceWords(t).length > 0, t);
  }
  assert.deepEqual(priceWords('A sharp cheddar from Bucks County.'), [], 'Bucks with a capital is a place');
  assert.deepEqual(priceWords('About sixty per cent less fat.'), []);
  assert.deepEqual(priceTalk(content({ copy: ['At this price it keeps.', 'A cheap tin it is not.'] })).sort(), ['cheap', 'price']);
  assert.deepEqual(guardProblems(content({ copy: ['At this price it keeps.', 'A cheap tin it is not.'] })), []);
});

test('each field is checked on its own: a year ending the copy and the unit after it are not a price', () => {
  const c = content({ copy: ['A farmhouse cheddar.', 'The dairy has made it since 1902.'], unit: 'PER POUND' });
  assert.deepEqual(guardProblems(c), []);
  const can = content({ copy: ['A soft drink.', 'Still number one in its own country.'], unit: 'PER CAN', specs: [['STYLE', 'Soft Drink'], ['SINCE', '1901'], ['SIZE', '11.15 fl oz']] });
  assert.deepEqual(guardProblems(can), []);
});

test('the guard finds phone numbers and web addresses, including short links and look-alike dots', () => {
  for (const t of ['Call (217) 555-0123.', 'Ring 217.555.0123.', 'Dial +44 20 7946 0958.', 'Text 2175550123.']) assert.ok(guardFindings(t).includes('phone'), t);
  for (const t of ['AOC since 1958, PDO since 1996.', 'Founded 1958-1996 as a farm.']) assert.ok(!guardFindings(t).includes('phone'), t);
  for (const t of ['See hilltop.example for more.', 'Read bit.ly/abc.', 'Read t.co/x.', 'Visit www.hilltop.', 'Go to https://x', `Visit hilltop${cp(0x3002)}example now.`, `Visit hilltop${cp(0xff0e)}example now.`, 'Write to someone@hilltop.example.']) {
    assert.ok(guardFindings(t).includes('link'), t);
  }
  for (const t of ['Made in St. Agur, e.g. in caves, i.e. cool ones.', 'D.O.P. and I.G.P. are designations.', 'Version 2.0 of the recipe.']) assert.ok(!guardFindings(t).includes('link'), t);
  assert.deepEqual(guardProblems(content()).length, 0);
  assert.ok(guardProblems(content({ producer: 'Hilltop · hilltop.example' })).some((p) => /a web address/.test(p.message)));
});

test('cleanText keeps letters, marks, numbers, punctuation, symbols and the plain space only', () => {
  const kept = `Caf${cp(0x00e9)} d${cp(0x2019)}Affinois${cp(0x00b7)} e${cp(0x0301)}`;
  assert.equal(cleanText(kept), kept.normalize('NFC'), 'a combining accent is kept, composed by NFC');
  assert.equal(cleanText(` a${ZWSP}${RLO}b \n c `), 'ab c');
  const hidden = [0xe0041, 0xfe0f, 0xe0100, 0x3164, 0x115f, 0xffa0, 0x034f, 0xfdd0, 0xfffe, 0xe000, 0x00ad].map((n) => cp(n)).join('');
  assert.equal(cleanText(`x${hidden}y`), 'xy', 'tag characters, variation selectors, fillers, noncharacters and private use go');
  assert.equal(cleanText(`x${String.fromCharCode(0xd800)}y`), 'xy', 'a lone surrogate goes');
  assert.equal(cleanText(`x${cp(0x00a0)}y${cp(0x3000)}z`), 'x y z', 'other spaces become a plain space');
});

test('normalizing fixes what code can fix safely', () => {
  const { content: c, fixes } = normalizeContent(
    content({ n1: 'Cheddar', n2: '', unit: 'each', origin: 'product of testland', eyebrow: 'cheese', specs: [['milk', "Cow's"], ['age', '1 Year'], ['cut', 'To Order']], copy: [`It${ZWSP} is  firm.\nVery.`, 'Fine.'] }),
    { soldByWeight: true, curlyApostrophes: true },
  );
  assert.equal(c.n1, '');
  assert.equal(c.n2, 'Cheddar', 'a one-word name goes wholly in n2');
  assert.equal(c.unit, PER_POUND, 'weight goods always print PER POUND');
  assert.equal(c.origin, 'PRODUCT OF TESTLAND');
  assert.equal(c.eyebrow, 'CHEESE');
  assert.deepEqual(c.specs[0], ['MILK', `Cow${cp(0x2019)}s`]);
  assert.equal(c.copy[0], 'It is firm. Very.', 'invisible characters, breaks and double spaces are gone');
  assert.ok(fixes.some((f) => /one-word name/.test(f)));
  assert.ok(fixes.some((f) => /PER POUND, not EACH/.test(f)));
  const split = normalizeContent(content({ n1: 'Smoked Gouda', n2: '' }), { soldByWeight: false, curlyApostrophes: false }).content;
  assert.deepEqual([split.n1, split.n2], ['Smoked ', 'Gouda']);
  const spaced = normalizeContent(content({ n1: 'Smoked', n2: 'Gouda' }), { soldByWeight: false, curlyApostrophes: false }).content;
  assert.equal(spaced.n1, 'Smoked ', 'n1 always ends in a space');
});

test('text helpers: URLs, designations, dashes and countries', () => {
  assert.equal(curlyApostrophes("Cow's"), `Cow${cp(0x2019)}s`);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://user:pw@example.com/x'), null);
  assert.equal(safeUrl('https://example.com/page#part'), 'https://example.com/page');
  assert.equal(urlKey('https://www.Example.com/a/b/'), urlKey('https://example.com/a/b'));
  assert.deepEqual(designationTerms('A D.O.P. cheese and an IGP one, a Protected Designation of Origin.').sort(), ['DOP', 'IGP', 'protected designation'].sort());
  assert.deepEqual(designationTerms('dop is not a word here, nor is Dopamine'), []);
  assert.deepEqual(unwantedDashes(`a${EM}b -- c`), ['an em dash', 'a double hyphen']);
  assert.equal(countryKey('PRODUCT OF USA'), 'usa');
  assert.equal(countryKey('United States of America (the)'), 'usa');
  assert.equal(countryKey('PRODUCT OF WISCONSIN'), 'usa');
  assert.equal(countryKey('United States (Wisconsin)'), 'usa');
  assert.equal(countryKey(`T${cp(0x00fc)}rkiye`), countryKey('PRODUCT OF TURKEY'));
  assert.equal(countryKey('MADE IN HOLLAND'), countryKey('Netherlands'));
  assert.notEqual(countryKey('PRODUCT OF GREECE'), countryKey(`T${cp(0x00fc)}rkiye`));
});

test('a printable card takes price and code from the caller and the category number from the config', () => {
  const c = content({ eyebrow: '03 / PASTA', unit: '500 GRAMS' });
  const unit = printableCard(c, { priceCents: 999, scaleCode: null, soldByWeight: false }, CONFIG.categories);
  assert.equal(unit.price, '$9.99');
  assert.equal(unit.code, '');
  assert.equal(unit.unit, '500 GRAMS');
  assert.equal(unit.eyebrow, '04 / PASTA', 'an imported card takes its word’s current number');
  const weight = printableCard(content({ eyebrow: 'CHEESE' }), { priceCents: 2299, scaleCode: '7102', soldByWeight: true }, CONFIG.categories);
  assert.equal(weight.eyebrow, '01 / CHEESE', 'a generated card stores the word only');
  assert.equal(weight.code, '7102');
  assert.equal(weight.unit, PER_POUND);
  assert.equal(formatPrice(5), '$0.05');
  assert.throws(() => formatPrice(0), /price above zero/);
  assert.equal(categoryWord('12 / SEAFOOD'), 'SEAFOOD');
  assert.deepEqual(currentEyebrow('BAKERY', CONFIG.categories), { eyebrow: 'BAKERY', known: false });
});

test('a card cannot print with an unknown category or a unit that contradicts Square', () => {
  assert.throws(() => printableCard(content({ eyebrow: 'BAKERY' }), { priceCents: 999, scaleCode: null, soldByWeight: true }, CONFIG.categories), /category BAKERY is not in the card config/);
  assert.match(printProblems(content({ unit: 'PER POUND' }), { soldByWeight: false }, CONFIG.categories).join(' '), /sells this item by the unit, but the card says PER POUND/);
  assert.match(printProblems(content({ unit: 'PER 8 OZ' }), { soldByWeight: true }, CONFIG.categories).join(' '), /sells this item by the pound, but the card's unit is PER 8 OZ/);
});

test('a generated card cannot print until a person checks this version, and a blocked one until it is edited', () => {
  const base: StoredCard = {
    id: 1,
    links: [],
    scaleCode: '',
    nameKey: '',
    importKey: '',
    source: 'generated',
    firstSource: 'generated',
    content: content(),
    printed: null,
    review: null,
    blocked: [],
    version: 1,
    checkedVersion: 0,
    retiredAt: null,
    createdAt: '',
    updatedAt: '',
  };
  const pc = { priceCents: 1999, scaleCode: null, soldByWeight: true };
  assert.throws(() => cardForPrinting(base, pc, CONFIG.categories), /A person must check this version/);
  assert.equal(cardForPrinting({ ...base, checkedVersion: 1 }, pc, CONFIG.categories).price, '$19.99');
  assert.throws(() => cardForPrinting({ ...base, checkedVersion: 1, blocked: ['a price'] }, pc, CONFIG.categories), /Blocked until edited: a price/);
  assert.equal(cardForPrinting({ ...base, source: 'imported', firstSource: 'imported' }, pc, CONFIG.categories).price, '$19.99', 'imported cards need no check');
});
