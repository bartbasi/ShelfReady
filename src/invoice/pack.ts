// Pack parsing: what a line's price is for, and how many sellable units are in a case.
// From the cc-case-cards skill: "12/5.3Z" is 12 units, "4/6/11." is 24, "1/18Z" is 1.
// Only the pack fields are parsed, never the description, where "21/25" is a shrimp
// size grade and "1/2" is a half.
//
// What the price is per matters as much as the count. A price per piece with "2/CS" printed
// beside it is already per sellable unit: dividing it by 2 would halve the cost. So pricePer is
// worked out first, and when it is unclear the line is flagged rather than guessed.

import type { PackInfo, PricePer } from './types.ts';

/** Longest pack text parsed. Real pack texts are short; longer text is not trusted. */
const MAX_PACK_TEXT = 40;

const WEIGHT_UNITS = new Set(['LB', 'LBS', '#', 'KG', 'POUND', 'POUNDS']);
const CASE_UNITS = new Set(['CS', 'CASE', 'BX', 'BOX']);
const EACH_UNITS = new Set(['EA', 'EACH', 'PC', 'PCS', 'PIECE', 'UN', 'UNIT', 'BG', 'BAG', 'BTL', 'JAR', 'TUB', 'PK', 'PKG']);

// Bounded patterns: no part can repeat without limit, so a long input cannot make them slow.
const THREE_PART = /^(\d{1,4}) {0,3}\/ {0,3}(\d{1,4}) {0,3}\/ {0,3}(\S[^\n]{0,30})$/;
const TWO_PART = /^(\d{1,4}) {0,3}\/ {0,3}(\S[^\n]{0,30})$/;
const SIZE = /^\d{0,6}(\.\d{1,4})? {0,3}[A-Za-z#]{0,10}\.?$/;

function unitWord(text: string): string {
  return text.trim().toUpperCase().replace(/[^A-Z#]/g, '').slice(0, 10);
}

function positiveInt(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,4}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** What the unit price is per, from the printed price unit, then the quantity unit. */
export function pricePerFor(unit: string, priceUnit: string, catchWeight: boolean): PricePer {
  if (catchWeight) return 'lb';
  for (const word of [unitWord(priceUnit), unitWord(unit)]) {
    if (word === '') continue;
    if (WEIGHT_UNITS.has(word)) return 'lb';
    if (CASE_UNITS.has(word)) return 'case';
    if (EACH_UNITS.has(word)) return 'unit';
  }
  return 'unclear';
}

export interface PackFields {
  packSize: string;
  /** The separate "Qty/Pack" column, when the invoice has one. */
  unitsPerPack: string;
  /** Unit of the shipped quantity, for example CS, EA, LB. */
  unit: string;
  /** Unit the price is per, when printed. */
  priceUnit: string;
  /** The line is priced by its catch weight. */
  catchWeight: boolean;
}

/** What one line's price is for, and how many units a case holds. */
export function parsePack(f: PackFields): PackInfo {
  const pricePer = pricePerFor(f.unit, f.priceUnit, f.catchWeight);
  const tooLong = f.packSize.length > MAX_PACK_TEXT;
  const pack = tooLong ? '' : f.packSize.trim();
  const unclear = 'Not clear whether the price is per case, per unit or per pound. Check before pricing.';

  let unitsPerCase: number | null = null;
  let unitSize = pack;
  let packSure = true;
  let packNote = tooLong ? 'The pack text is too long to read. Check the units per case.' : '';
  const column = f.unitsPerPack.length <= 6 ? positiveInt(f.unitsPerPack) : null;
  const three = pack ? THREE_PART.exec(pack) : null;
  const two = pack && !three ? TWO_PART.exec(pack) : null;
  if (column !== null) {
    unitsPerCase = column;
  } else if (three) {
    unitsPerCase = Number(three[1]) * Number(three[2]);
    unitSize = three[3]!.trim();
  } else if (two) {
    const rest = two[2]!.trim();
    unitsPerCase = Number(two[1]);
    if (/^(CS|CASE)$/i.test(rest)) unitSize = '';
    else if (SIZE.test(rest)) unitSize = rest;
    else {
      unitSize = rest;
      packSure = false;
      packNote = `Pack "${pack}" is unusual. Check the units per case.`;
    }
    if (unitsPerCase === 0) unitsPerCase = null;
  } else if (pack) {
    packSure = false;
    packNote = SIZE.test(pack)
      ? `Only a size is printed ("${pack}"). Check the units per case.`
      : `Pack "${pack}" not understood. Check the units per case.`;
  }

  switch (pricePer) {
    case 'lb':
      return { pricePer, unitsPerCase, unitSize, sure: true, note: 'Priced by the pound.' };
    case 'unit':
      // Already per sellable unit. A pack count printed beside it is for reference only.
      return { pricePer, unitsPerCase: unitsPerCase ?? 1, unitSize, sure: !tooLong, note: packNote };
    case 'case':
      if (unitsPerCase === null) {
        return { pricePer, unitsPerCase: null, unitSize, sure: false, note: packNote || 'The price is per case, but the case size is not printed. Check the units per case.' };
      }
      return { pricePer, unitsPerCase, unitSize, sure: packSure && !tooLong, note: packNote };
    case 'unclear':
      return { pricePer, unitsPerCase, unitSize, sure: false, note: unclear };
  }
}
