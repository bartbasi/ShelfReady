// Cost basis: per pound, per unit, per case divided by units, allowances, and lines that must
// not be priced. Invented numbers only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePack, type PackFields } from '../src/invoice/pack.ts';
import { costBasis, type BasisInput, type CostFound } from '../src/pricing/basis.ts';
import { rat } from '../src/pricing/rational.ts';

function line(unitPrice: string, pack: Partial<PackFields>, allowance = ''): BasisInput {
  return {
    unitPrice,
    allowance,
    pack: parsePack({ packSize: '', unitsPerPack: '', unit: '', priceUnit: '', catchWeight: false, ...pack }),
  };
}

function found(b: ReturnType<typeof costBasis>): CostFound {
  assert.ok(b.ok, b.ok ? '' : b.reason);
  return b;
}

test('by the unit: case price divided by the units per case, kept exact', () => {
  const b = found(costBasis(line('32.23', { packSize: '12/5.3Z', unit: 'CS' }), 'unit'));
  assert.equal(b.per, 'unit');
  assert.deepEqual(b.cost, rat(3223n, 1200n));
  assert.equal(b.costText, '2.6858');
  assert.equal(b.costExact, false);
  assert.equal(b.unitsPerCase, 12);
  assert.match(b.how, /Case price 32\.23, 12 units per case, about 2\.6858 each/);
});

test('three-part packs multiply, and a units column wins over the pack text', () => {
  assert.deepEqual(found(costBasis(line('48.00', { packSize: '4/6/11.', unit: 'CS' }), 'unit')).cost, rat(2n));
  assert.deepEqual(found(costBasis(line('30.00', { packSize: '6/8 OZ', unitsPerPack: '10', unit: 'CS' }), 'unit')).cost, rat(3n));
});

test('a unit price is already per unit, even with a pack printed beside it', () => {
  const b = found(costBasis(line('4.15', { packSize: '2/CS', unit: 'EA' }), 'unit'));
  assert.deepEqual(b.cost, rat(415n, 100n));
  assert.equal(b.costText, '4.15');
  assert.equal(b.costExact, true);
});

test('by the pound: a catch weight line uses its price per pound', () => {
  const b = found(costBasis(line('7.43', { unit: 'EA', catchWeight: true }), 'weight'));
  assert.equal(b.per, 'lb');
  assert.deepEqual(b.cost, rat(743n, 100n));
  assert.match(b.how, /Price per pound 7\.43/);
  assert.equal(found(costBasis(line('9.10', { unit: 'LB' }), 'unknown')).per, 'lb');
});

test('an allowance does not lower the cost by default; net is only an explicit option', () => {
  const regular = found(costBasis(line('20.50', { packSize: '1/CS', unit: 'CS' }, '3.50'), 'unit'));
  assert.deepEqual(regular.cost, rat(41n, 2n), 'the regular cost before the allowance');
  assert.equal(regular.allowanceUsed, null);
  assert.deepEqual(regular.allowancePrinted, rat(7n, 2n));
  assert.match(regular.how, /Price per unit|Case price 20\.50,/);
  assert.doesNotMatch(regular.how, /less/);
  const net = found(costBasis(line('20.50', { packSize: '1/CS', unit: 'CS' }, '3.50'), 'unit', 'net'));
  assert.deepEqual(net.cost, rat(17n));
  assert.deepEqual(net.allowanceUsed, rat(7n, 2n));
  assert.match(net.how, /20\.50 less 3\.50 allowance = 17\.00/);
  const negativeAllowance = found(costBasis(line('20.50', { packSize: '1/CS', unit: 'CS' }, '-3.50'), 'unit', 'net'));
  assert.deepEqual(negativeAllowance.cost, rat(17n), 'printed as a minus, same meaning');
  const zero = found(costBasis(line('20.50', { packSize: '1/CS', unit: 'CS' }, '.00'), 'unit'));
  assert.equal(zero.allowancePrinted, null);
  const eatsAll = costBasis(line('3.00', { packSize: '1/CS', unit: 'CS' }, '3.00'), 'unit', 'net');
  assert.equal(eatsAll.ok, false, 'on net, an allowance equal to the price leaves no cost');
  assert.deepEqual(found(costBasis(line('3.00', { packSize: '1/CS', unit: 'CS' }, '3.00'), 'unit')).cost, rat(3n));
});

test('unclear or missing information gives no price and a plain reason', () => {
  const cases: Array<[BasisInput, 'weight' | 'unit' | 'unknown', RegExp]> = [
    [line('10.00', {}), 'unknown', /Not clear whether the price is per case/],
    [line('', { unit: 'EA' }), 'unit', /No unit price/],
    [line('abc', { unit: 'EA' }), 'unit', /No unit price/],
    [line('24.00', { unit: 'CS' }), 'unit', /case size is not printed|units per case/],
    [line('24.00', { packSize: '12/BUNDLE OF JOY', unit: 'CS' }), 'unit', /unusual/],
    [line('24.00', { packSize: '8 OZ', unit: 'CS' }), 'unit', /Only a size is printed/],
    [line('6.00', { packSize: '1/CS', unit: 'CS' }), 'weight', /sells this by the pound, but the invoice price is not per pound/],
    [line('6.00', { unit: 'LB' }), 'unit', /by the pound, but Square sells it by the unit/],
    [line('0.00', { unit: 'EA' }), 'unit', /zero or less/],
    [line('-4.00', { unit: 'EA' }), 'unit', /zero or less/],
  ];
  for (const [input, sale, reason] of cases) {
    const b = costBasis(input, sale);
    assert.equal(b.ok, false, JSON.stringify(input));
    if (!b.ok) assert.match(b.reason, reason);
  }
});
