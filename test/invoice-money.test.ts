// Exact decimal parsing and rounding for invoice checks. Invented numbers only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCents, formatDecimal, mulToCents, NumberTooLargeError, parseCents, parseDecimal, roundShift, subtract, toCents } from '../src/invoice/money.ts';

test('parses printed numbers exactly, with commas, signs and brackets', () => {
  assert.deepEqual(parseDecimal('2,345.67'), { units: 234567, scale: 2 });
  assert.deepEqual(parseDecimal('37.19'), { units: 3719, scale: 2 });
  assert.deepEqual(parseDecimal('5'), { units: 5, scale: 0 });
  assert.deepEqual(parseDecimal('.00'), { units: 0, scale: 2 });
  assert.deepEqual(parseDecimal('$12.99'), { units: 1299, scale: 2 });
  assert.deepEqual(parseDecimal('-3.15'), { units: -315, scale: 2 });
  assert.deepEqual(parseDecimal('3.15-'), { units: -315, scale: 2 });
  assert.deepEqual(parseDecimal('(3.15)'), { units: -315, scale: 2 });
  assert.deepEqual(parseDecimal(' 2.50 '), { units: 250, scale: 2 });
});

test('refuses text that is not a plain number, or is too long or too large', () => {
  for (const bad of ['', '   ', 'abc', '1,23.4', '1.2.3', '12a', '-', '.', '1.1234567', '9'.repeat(25), '12345678901234567']) {
    assert.equal(parseDecimal(bad), null, bad);
  }
  assert.equal(parseDecimal('9'.repeat(40_000)), null);
  assert.equal(parseDecimal(null), null);
  assert.equal(parseCents(''), null);
});

test('refuses digits split by spaces, stray minus signs and minus signs in brackets', () => {
  for (const bad of ['12 5.30', '1 234.00', '-3-', '(-3)', '--3', '-(3)', '(3)-', '$$3']) {
    assert.equal(parseDecimal(bad), null, bad);
  }
  assert.deepEqual(parseDecimal('$ 12.99'), { units: 1299, scale: 2 }, 'a space beside a symbol is fine');
  assert.deepEqual(parseDecimal('3.15 -'), { units: -315, scale: 2 });
  assert.deepEqual(parseDecimal('$-3.15'), { units: -315, scale: 2 });
});

test('rounds half away from zero, using integers only', () => {
  assert.equal(roundShift(5, 1), 1);
  assert.equal(roundShift(-5, 1), -1);
  assert.equal(roundShift(4, 1), 0);
  assert.equal(toCents(parseDecimal('0.005')!), 1);
  assert.equal(toCents(parseDecimal('-0.005')!), -1);
  assert.equal(toCents(parseDecimal('1.234')!), 123);
  assert.equal(toCents(parseDecimal('7')!), 700);
});

test('extends a line the way an invoice does', () => {
  // weight x price per lb, with a half cent rounded up
  assert.equal(mulToCents(parseDecimal('2.50')!, parseDecimal('1.13')!), 283);
  assert.equal(mulToCents(parseDecimal('1.50')!, parseDecimal('3.33')!), 500);
  assert.equal(mulToCents(parseDecimal('3.21')!, parseDecimal('4.56')!), 1464);
  assert.equal(mulToCents(parseDecimal('7')!, parseDecimal('2.35')!), 1645);
  assert.equal(mulToCents(parseDecimal('-2')!, parseDecimal('1.005')!), -201);
});

test('a product too large to hold exactly is refused with its own error', () => {
  assert.throws(() => mulToCents(parseDecimal('999999999999.99')!, parseDecimal('99999.99')!), NumberTooLargeError);
});

test('sums that floats get wrong come out exact', () => {
  const a = parseCents('0.10')!;
  const b = parseCents('0.20')!;
  assert.equal(a + b, 30);
  assert.deepEqual(subtract(parseDecimal('12.40')!, parseDecimal('1.15')!), { units: 1125, scale: 2 });
});

test('formats cents and decimals as plain text', () => {
  assert.equal(formatCents(234567), '2345.67');
  assert.equal(formatCents(-315), '-3.15');
  assert.equal(formatCents(5), '0.05');
  assert.equal(formatDecimal({ units: 4321, scale: 2 }), '43.21');
  assert.equal(formatDecimal({ units: -5, scale: 3 }), '-0.005');
});
