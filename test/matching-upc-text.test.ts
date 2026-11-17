// Product codes and text helpers for matching. Invented values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitTrailingCode, trailingScaleCode } from '../src/lib/scale-code.ts';
import { plainWords, sizeTokens, splitMaker, stem, withinOneEdit, words } from '../src/matching/text.ts';
import { checkUpcItemRule, itemNumberForRule, itemNumberInUpc, readUpc, scaleCodeInUpc, scaleCodeUpcKey, upcKey } from '../src/matching/upc.ts';
import { codeUpc, upcA } from './matching-fixtures.ts';

test('UPC-A, EAN-13 and GTIN-14 forms of one code share a key', () => {
  const a = upcA('00011122233');
  assert.equal(a.length, 12);
  const key = upcKey(a);
  assert.equal(key, `00${a}`);
  assert.equal(upcKey(`0${a}`), key);
  assert.equal(upcKey(`00${a}`), key);
  assert.equal(upcKey(`${a.slice(0, 6)}-${a.slice(6)}`), key, 'spaces and dashes are ignored');
  assert.equal(upcKey('96385074'), '00000096385074', 'EAN-8');
});

test('a code that fails its check digit, has the wrong length or holds letters gets no key', () => {
  const a = upcA('00011122233');
  const wrong = `${a.slice(0, 11)}${(Number(a[11]) + 1) % 10}`;
  assert.deepEqual(readUpc(wrong), { digits: wrong, key: null, problem: 'check_digit' });
  assert.equal(readUpc(a.slice(0, 11)).problem, 'bad_length');
  assert.equal(readUpc('12AB5').problem, 'not_digits');
  assert.deepEqual(readUpc('  '), { digits: '', key: null, problem: null });
  assert.equal(readUpc('1'.repeat(500)).problem, 'bad_length', 'long text is cut, then refused');
});

test('UPCs built from scale codes: seven zeros, the code, a check digit', () => {
  // The worked example in store/docs/SQUARE-NOTES.md has the same shape: code, then its check digit.
  assert.equal(codeUpc('1234'), '000000012348');
  assert.equal(scaleCodeUpcKey('1234'), '00000000012348');
  assert.equal(scaleCodeInUpc(upcKey(codeUpc('7101'))!), '7101');
  assert.equal(scaleCodeInUpc(upcKey(upcA('00011122233'))!), null);
});

test('supplier item numbers inside maker UPCs, only under the configured maker prefixes', () => {
  const rule = checkUpcItemRule({ prefixes: ['000333'], from: 7, to: 11 })!;
  assert.ok(rule);
  const key = upcKey(upcA('00033345678'))!;
  assert.equal(itemNumberInUpc(key, rule), '45678');
  assert.equal(itemNumberInUpc(upcKey(upcA('00044445678'))!, rule), null, 'another maker');
  assert.equal(itemNumberForRule('45678', rule), '45678');
  assert.equal(itemNumberForRule('678', rule), '00678', 'padded to the digit span');
  assert.equal(itemNumberForRule('123456', rule), null, 'too long for the span');
  assert.equal(itemNumberForRule('A4567', rule), null);
  for (const bad of [null, {}, { prefixes: [], from: 7, to: 11 }, { prefixes: ['000333'], from: 0, to: 11 }, { prefixes: ['000333'], from: 7, to: 12 }, { prefixes: ['0003334'], from: 7, to: 11 }, { prefixes: ['x'], from: 7, to: 11 }]) {
    assert.equal(checkUpcItemRule(bad), null, JSON.stringify(bad));
  }
});

test('the scale code is the 4-digit word at the very end of a name', () => {
  assert.deepEqual(splitTrailingCode('Gouda Smoked 7101'), { base: 'Gouda Smoked', trailing: '7101' });
  assert.deepEqual(splitTrailingCode('Soft Ripened - 8oz - 7249  '), { base: 'Soft Ripened - 8oz', trailing: '7249' });
  assert.deepEqual(splitTrailingCode('Valley Red 2021'), { base: 'Valley Red', trailing: '2021' }, 'a year looks the same here; the index decides');
  assert.equal(splitTrailingCode('Test ABC1234').trailing, null, 'inside a word');
  assert.equal(splitTrailingCode('Test 12345').trailing, null, 'five digits');
  assert.equal(splitTrailingCode('Test 7101 sliced').trailing, null, 'not at the end');
  assert.equal(splitTrailingCode('Lobster 1.25- 1.49').trailing, null);
  // One function for matching and pricing: an en dash, an em dash or a comma before the code.
  assert.equal(trailingScaleCode('Soft Cheese \u2013 1234'), '1234');
  assert.equal(trailingScaleCode('Soft Cheese \u20141234'), '1234');
  assert.equal(trailingScaleCode('Soft Cheese,1234'), '1234');
});

test('"Maker - Product" splits at the first spaced dash', () => {
  assert.deepEqual(splitMaker('Bluecrest - Crackers, Sea Salt'), { maker: 'Bluecrest', product: 'Crackers, Sea Salt' });
  assert.deepEqual(splitMaker('Fennel Salami'), { maker: '', product: 'Fennel Salami' });
  assert.deepEqual(splitMaker('Semi-Soft Cheese'), { maker: '', product: 'Semi-Soft Cheese' }, 'an unspaced dash is part of a word');
});

test('words: folded, abbreviations spelled out, stop words dropped, light stems', () => {
  assert.deepEqual(words('OVEN TURKEY SKNLS'), ['oven', 'turkey', 'skinless']);
  assert.deepEqual(words('SALAMI N/C 1/2'), ['salami', 'natural', 'casing', 'half']);
  assert.deepEqual(words('Olives W/ PITS 5#'), ['olive', 'pit', '5'], 'with and lb are stop words; sizes stay');
  assert.deepEqual(words('Crème Brûlée'), ['creme', 'brulee']);
  assert.deepEqual(words("Northfield’s Crackers"), words("NORTHFIELD'S CRACKERS"));
  assert.deepEqual(words('Scallops U-10'), words('Scallops U10'));
  assert.deepEqual(words('TEST CHIPS MEDITER HERB SM'), ['test', 'chip', 'mediterranean', 'herb', 'small']);
  assert.deepEqual(words('Smoked Gouda'), words('GOUDA SMOKED').reverse());
  assert.deepEqual(plainWords('SMOKED GOUDAS W/ HERBS'), ['smoked', 'goudas', 'herbs']);
  assert.equal(stem('cheeses'), 'cheese');
  assert.equal(stem('tomatoes'), 'tomato');
  assert.equal(stem('anchovies'), 'anchovy');
  assert.equal(stem('swiss'), 'swiss');
  assert.equal(stem('roasted'), 'roast');
  assert.deepEqual(words('a'.repeat(1000)).length, 1, 'long text is cut first');
});

test('one edit apart: a letter added, dropped, changed, or two neighbours swapped', () => {
  for (const [a, b] of [['salame', 'salami'], ['12345', '1245'], ['12345', '123456'], ['12345', '12354'], ['abc', 'abc']]) assert.ok(withinOneEdit(a!, b!), `${a} ${b}`);
  for (const [a, b] of [['12345', '54321'], ['12345', '123'], ['abcd', 'badc'], ['1234', '1324x']]) assert.equal(withinOneEdit(a!, b!), false, `${a} ${b}`);
});

test('sizes and counts are read the same however they are printed', () => {
  assert.deepEqual(sizeTokens('SALMON FILLET SKIN ON 2-3 LB'), ['2-3', '3lb']);
  assert.deepEqual(sizeTokens('SCALLOPS DRY U-10'), sizeTokens('Scallops dry u10'));
  assert.deepEqual(sizeTokens('SCALLOPS DRY 10/20'), ['10/20']);
  assert.deepEqual(sizeTokens('OLIVE OIL TIN 3 LTR'), ['3l']);
  assert.deepEqual(sizeTokens('SHRIMP 16/20 | **5x2# IQF'), ['16/20', '2lb', '5x2']);
  assert.deepEqual(sizeTokens('CHEESE 3#'), sizeTokens('cheese 3 lbs'));
  assert.deepEqual(sizeTokens('MOZZARELLA 250G 84PC'), ['250g', '84pc']);
  assert.deepEqual(sizeTokens('TUNA LOINS #1+ S/ON'), [], 'a grade after a number sign is not a size');
  assert.deepEqual(sizeTokens('2 LARGE EGGS'), [], 'a unit must stand alone');
});

