// Exact arithmetic, the skill's rounding and formulas as data. Invented numbers only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PriceFormula, PricingSettings } from '../src/settings/schema.ts';
import { add, ceil, cmp, div, floor, fromInt, isInteger, mul, parseRat, rat, sub, toDecimalText, type Rat } from '../src/pricing/rational.ts';
import { roundUpTo99 } from '../src/pricing/rounding.ts';
import { parseDecimal } from '../src/invoice/money.ts';
import { chooseFormula, describeFormula, formulaCents, formulaValue, shelfCentsForText, vendorKey } from '../src/pricing/formula.ts';

// The function from the cc-case-cards skill, copied character for character.
const up = (c: number) => { const x = 2*c + 1; let d = Math.ceil(x);
                  if (d - x < 0.99) d = Math.floor(x) + 1; return +(d - 0.01).toFixed(2); };

// The same rule for any computed price x, still in floating point, as the skill would run it.
const upX = (x: number) => { let d = Math.ceil(x);
                  if (d - x < 0.99) d = Math.floor(x) + 1; return +(d - 0.01).toFixed(2); };

const STD: PriceFormula = { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' };
const ADD_FIRST: PriceFormula = { addBefore: '1.00', multiplier: '2', addAfter: '0.00', rounding: 'up-to-99' };
const VENDOR: PriceFormula = { addBefore: '2.25', multiplier: '2', addAfter: '0.00', rounding: 'up-to-99' };

function r(text: string): Rat {
  const v = parseRat(text);
  assert.ok(v, text);
  return v;
}

/** A small seeded generator, so a failure can be reproduced. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decimalText(units: number, places: number): string {
  if (places === 0) return String(units);
  const s = String(units).padStart(places + 1, '0');
  return `${s.slice(0, -places)}.${s.slice(-places)}`;
}

test('parses decimal text exactly, in every printed form', () => {
  assert.deepEqual(parseRat('32.23'), rat(3223n, 100n));
  assert.deepEqual(parseRat('$1,234.50'), rat(123450n, 100n));
  assert.deepEqual(parseRat('$ 12.99'), rat(1299n, 100n));
  assert.deepEqual(parseRat('.5'), rat(1n, 2n));
  assert.deepEqual(parseRat('5.'), rat(5n));
  assert.deepEqual(parseRat('3.15-'), rat(-315n, 100n));
  assert.deepEqual(parseRat('3.15 -'), rat(-315n, 100n));
  assert.deepEqual(parseRat('$-3.15'), rat(-315n, 100n));
  assert.deepEqual(parseRat('(3.15)'), rat(-315n, 100n));
  assert.deepEqual(parseRat('0.000001'), rat(1n, 1_000_000n));
  assert.deepEqual(parseRat(`  ${'1'.repeat(15)}  `), rat(BigInt('1'.repeat(15))), 'spaces are trimmed before the length check');
  for (const bad of ['', ' ', 'abc', '1.2.3', '1,23.4', '.', '-', '$', '()', '0.0000001', '9'.repeat(25), '9007199254740993', null, undefined]) {
    assert.equal(parseRat(bad as string), null, String(bad));
  }
});

test('refuses digits split by spaces, stray minus signs and minus signs in brackets', () => {
  for (const bad of ['12 5.30', '1 234.00', '-3-', '(-3)', '--3', '-(3)', '3--', '(3)-', '+-3', '12-5', '$$3', '$3$']) {
    assert.equal(parseRat(bad), null, bad);
  }
});

test('agrees with the invoice checks parser on every form both accept', () => {
  const forms = ['2,345.67', '37.19', '5', '.00', '$12.99', '$ 12.99', '-3.15', '3.15-', '(3.15)', ' 2.50 ', '+4', '-$3.15', '$-3.15', '($3.15)', '$(3.15)', '5.', '0.000001', '12,345,678.9', '999999999999999'];
  for (const f of forms) {
    const d = parseDecimal(f);
    assert.ok(d, `invoice parser accepts ${f}`);
    assert.deepEqual(parseRat(f), rat(BigInt(d.units), 10n ** BigInt(d.scale)), f);
  }
  const rand = mulberry32(7);
  for (let i = 0; i < 5000; i++) {
    const text = decimalText(Math.floor(rand() * 1e9), Math.floor(rand() * 7));
    const d = parseDecimal(text)!;
    assert.deepEqual(parseRat(text), rat(BigInt(d.units), 10n ** BigInt(d.scale)), text);
  }
});

test('rational arithmetic is exact and stays in lowest terms', () => {
  const each = div(r('32.23'), fromInt(12));
  assert.deepEqual(each, rat(3223n, 1200n));
  assert.deepEqual(mul(each, fromInt(12)), rat(3223n, 100n));
  assert.deepEqual(add(r('0.1'), r('0.2')), r('0.3'));
  assert.deepEqual(sub(r('0.3'), r('0.1')), r('0.2'));
  assert.equal(cmp(r('20.995'), r('20.99')), 1);
  assert.equal(floor(r('-1.5')), -2n);
  assert.equal(ceil(r('-1.5')), -1n);
  assert.equal(floor(r('7')), 7n);
  assert.equal(ceil(r('7.0001')), 8n);
  assert.ok(isInteger(r('5.000')));
  assert.throws(() => div(r('1'), r('0')), RangeError);
  assert.throws(() => rat(1n, 0n), RangeError);
});

test('shows a value as text, saying when it had to round', () => {
  assert.deepEqual(toDecimalText(rat(3223n, 1200n)), { text: '2.6858', exact: false });
  assert.deepEqual(toDecimalText(r('3.223')), { text: '3.223', exact: true });
  assert.deepEqual(toDecimalText(r('5')), { text: '5.00', exact: true });
  assert.deepEqual(toDecimalText(r('-0.00001')), { text: '0.00', exact: false });
  assert.deepEqual(toDecimalText(rat(2n, 3n), 2), { text: '0.67', exact: false });
});

test('rounding edges: whole dollars, N.99, N.995, N.999, zero, tiny and huge', () => {
  const cases: Array<[string, bigint, string]> = [
    ['0', 99n, 'zero goes to 0.99'],
    ['0.001', 99n, 'a tenth of a cent goes to 0.99'],
    ['0.99', 99n, 'already .99 stays'],
    ['1', 199n, 'a whole dollar goes up to the next .99'],
    ['20.98', 2099n, 'just under .99 goes up'],
    ['20.99', 2099n, '.99 stays'],
    ['20.991', 2099n, 'between .99 and the dollar comes down to .99, as the skill does'],
    ['20.995', 2099n, '20.995 gives 20.99, as decided'],
    ['20.999', 2099n, 'still 20.99'],
    ['20.999999', 2099n, 'still 20.99'],
    ['21', 2199n, '21.00 gives 21.99'],
    ['21.000001', 2199n, 'just over a dollar goes to that dollar .99'],
    ['20.01', 2099n, 'one cent over a dollar'],
    ['20.001', 2099n, 'a tenth of a cent over a dollar'],
  ];
  for (const [x, cents, why] of cases) assert.equal(roundUpTo99(r(x)), cents, `${x}: ${why}`);
  assert.equal(roundUpTo99(rat(1234567890123456785n, 10n)), 12345678901234567899n, 'huge values stay exact');
  assert.equal(roundUpTo99(rat(1n, 3n)), 99n);
  assert.equal(roundUpTo99(rat(62999n, 3000n)), 2099n, '20.99966... gives 20.99');
  assert.throws(() => roundUpTo99(r('-0.01')), RangeError);
});

test('the default formula agrees with the skill function on table cases', () => {
  const cases: Array<[string, number]> = [
    ['10.00', 2199],
    ['9.99', 2099],
    ['9.995', 2099],
    ['9.9975', 2099],
    ['9.9995', 2099],
    ['10.0005', 2199],
    ['10.005', 2199],
    ['0', 199],
    ['0.001', 199],
    ['0.5', 299],
    ['3.223', 799],
    ['123456.78', 24691499],
  ];
  for (const [cost, cents] of cases) {
    assert.equal(Number(formulaCents(STD, r(cost))), cents, cost);
    assert.equal(Math.round(up(Number(cost)) * 100), cents, `skill function, ${cost}`);
  }
});

test('property: the default formula equals the skill function on many float-safe costs', () => {
  const rand = mulberry32(20261107);
  for (let i = 0; i < 20000; i++) {
    const places = Math.floor(rand() * 5); // 0 to 4 decimal places
    const units = Math.floor(rand() * 10 ** (Math.floor(rand() * 7) + 1)); // up to 10 million units
    const cost = decimalText(units, places);
    const exact = Number(formulaCents(STD, r(cost)));
    const skill = Math.round(up(Number(cost)) * 100);
    assert.equal(exact, skill, `cost ${cost}`);
  }
});

test('property: any formula equals the generalized skill rule on float-safe inputs', () => {
  const rand = mulberry32(42);
  let compared = 0;
  for (let i = 0; i < 20000; i++) {
    const cost = decimalText(Math.floor(rand() * 2_000_000), Math.floor(rand() * 5));
    const f: PriceFormula = {
      addBefore: decimalText(Math.floor(rand() * 1000), 2),
      multiplier: decimalText(1000 + Math.floor(rand() * 3000), 3),
      addAfter: decimalText(Math.floor(rand() * 1000), 2),
      rounding: 'up-to-99',
    };
    const x = formulaValue(f, r(cost));
    // A whole-dollar result is given to the float rule exactly. Otherwise the float result must
    // sit on the same side of every whole dollar as the exact one, which these inputs guarantee.
    const xf = isInteger(x) ? Number(x.n) : (Number(cost) + Number(f.addBefore)) * Number(f.multiplier) + Number(f.addAfter);
    assert.equal(Math.floor(xf), Number(floor(x)), `float-safe guard, cost ${cost}`);
    assert.equal(Number(formulaCents(f, r(cost))), Math.round(upX(xf) * 100), `cost ${cost} with ${JSON.stringify(f)}`);
    compared++;
  }
  assert.equal(compared, 20000);
});

test('exact arithmetic avoids a float trap the skill function would fall into', () => {
  // (0.70 + 0.10) x 10 is exactly 8, a whole dollar, so 8.99. In floats it is 7.999999999999999.
  const f: PriceFormula = { addBefore: '0.10', multiplier: '10', addAfter: '0.00', rounding: 'up-to-99' };
  assert.equal(Number(formulaCents(f, r('0.70'))), 899);
  assert.equal(Math.round(upX((0.7 + 0.1) * 10) * 100), 799, 'the float version lands a dollar low');
});

test('2 x cost + 1 and (cost + 1) x 2 are different formulas, and the vendor formula is its own', () => {
  assert.equal(Number(formulaCents(STD, r('10'))), 2199);
  assert.equal(Number(formulaCents(ADD_FIRST, r('10'))), 2299);
  assert.equal(Number(formulaCents(VENDOR, r('10'))), 2499);
  const each = div(r('32.23'), fromInt(12)); // 2.68583...
  assert.equal(Number(formulaCents(STD, each)), 699, '6.3716... goes to 6.99');
  assert.equal(Number(formulaCents(ADD_FIRST, each)), 799, '7.3716... goes to 7.99');
  assert.equal(Number(formulaCents(VENDOR, each)), 999, '9.8716... goes to 9.99');
  assert.equal(describeFormula(STD), '2 x cost + 1.00, rounded up to .99');
  assert.equal(describeFormula(ADD_FIRST), '(cost + 1.00) x 2, rounded up to .99');
  assert.equal(describeFormula(VENDOR), '(cost + 2.25) x 2, rounded up to .99');
  assert.equal(describeFormula({ ...STD, multiplier: '2.5' }), '2.5 x cost + 1.00, rounded up to .99');
  assert.equal(describeFormula({ ...STD, multiplier: '1', addAfter: '3.00' }), 'cost + 3.00, rounded up to .99');
});

test('a vendor formula is chosen by exact name after folding, otherwise the default', () => {
  const settings: PricingSettings = { default: STD, vendors: [{ vendor: "Example Cheese Cellars", formula: VENDOR }] };
  assert.equal(chooseFormula(settings, null).source, 'default');
  assert.equal(chooseFormula(settings, 'Other Foods').source, 'default');
  const hit = chooseFormula(settings, '  example   CHEESE cellars ');
  assert.equal(hit.source, 'vendor');
  assert.equal(hit.vendor, 'Example Cheese Cellars');
  assert.equal(hit.text, '(cost + 2.25) x 2, rounded up to .99');
  assert.equal(chooseFormula(settings, 'Example Cheese').source, 'default', 'no partial matches');
  assert.equal(vendorKey('José’s  Café'), "jose's cafe");
});

test('the settings page example goes through the same code', () => {
  assert.equal(shelfCentsForText(STD, '9.9975'), 2099);
  assert.equal(shelfCentsForText(VENDOR, '10.00'), 2499);
  assert.throws(() => shelfCentsForText(STD, 'ten'));
  assert.throws(() => shelfCentsForText(STD, '-1'));
  assert.throws(() => formulaCents({ ...STD, multiplier: '0' }, r('1')), /zero multiplier/);
});
