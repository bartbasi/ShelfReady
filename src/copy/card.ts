// A printable card: stored copy, plus the price and code from pricing and Square.
//
// - The price and the code never come from the model or from stored card text. The caller
//   passes the price pricing settled on (a priced line's newCents) or Square's price today, and
//   the item's scale code from the catalog.
// - The category number always comes from the config at print time, so numbers never repeat or
//   drift: generated cards store the category word only, and imported cards keep their word and
//   take its current number (decisions, Card category numbers). A word the config does not have
//   cannot print.
// - The unit must agree with how Square sells the item: PER POUND only for goods sold by weight,
//   a pack size only for goods sold by the unit.

import type { CardRecord } from '../cards/types.ts';
import { PER_POUND } from './checks.ts';
import { parseEyebrow, type Category } from './config.ts';
import { cardBlockers } from './store.ts';
import { CopyError, type CardContent, type StoredCard } from './types.ts';

export interface PriceAndCode {
  /** Shelf price in cents. */
  priceCents: number;
  /** The item's scale code from the Square catalog, or null. */
  scaleCode: string | null;
  /** Sold by weight in Square: the card prints PER POUND and the code in its footer. */
  soldByWeight: boolean;
}

/** Cents as the cards print them, for example $22.99. */
export function formatPrice(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new CopyError('A card needs a price above zero.');
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** The category word of an eyebrow: "03 / PASTA" and "PASTA" both give PASTA. */
export function categoryWord(eyebrow: string): string {
  const parsed = parseEyebrow(eyebrow);
  return (parsed ? parsed.word : eyebrow).trim().toUpperCase();
}

/** The eyebrow with its category's current number. known is false when the word is not in the config. */
export function currentEyebrow(eyebrow: string, categories: readonly Category[]): { eyebrow: string; known: boolean } {
  const word = categoryWord(eyebrow);
  const found = categories.find((c) => c.word === word);
  return found ? { eyebrow: `${found.number} / ${found.word}`, known: true } : { eyebrow, known: false };
}

/** Why this card text cannot print for this item, in plain words. Empty when it can. */
export function printProblems(content: CardContent, pc: Pick<PriceAndCode, 'soldByWeight'>, categories: readonly Category[]): string[] {
  const out: string[] = [];
  if (!currentEyebrow(content.eyebrow, categories).known) {
    out.push(`The category ${categoryWord(content.eyebrow) || '(none)'} is not in the card config. Add it there with the next free number, or pick a category the config has.`);
  }
  const unit = content.unit.trim().toUpperCase();
  if (pc.soldByWeight && unit !== PER_POUND) out.push(`Square sells this item by the pound, but the card's unit is ${content.unit}. Change the card's unit to PER POUND, or check the item in Square.`);
  if (!pc.soldByWeight && unit === PER_POUND) out.push('Square sells this item by the unit, but the card says PER POUND. Change the card\'s unit to the pack size, or check the item in Square.');
  return out;
}

/** The card record the .docx builder takes (src/cards/build.ts). Throws CopyError when it cannot print. */
export function printableCard(content: CardContent, pc: PriceAndCode, categories: readonly Category[]): CardRecord {
  const problems = printProblems(content, pc, categories);
  if (problems.length) throw new CopyError(problems.join(' '));
  const code = pc.soldByWeight && pc.scaleCode && /^\d{4}$/.test(pc.scaleCode) ? pc.scaleCode : '';
  return {
    code,
    price: formatPrice(pc.priceCents),
    unit: pc.soldByWeight ? PER_POUND : content.unit,
    origin: content.origin,
    eyebrow: currentEyebrow(content.eyebrow, categories).eyebrow,
    n1: content.n1,
    n2: content.n2,
    producer: content.producer,
    specs: content.specs.map(([l, v]) => [l, v]) as CardRecord['specs'],
    copy: [...content.copy],
  };
}

/** A stored card ready for the sheet, or CopyError with every reason it cannot print yet. */
export function cardForPrinting(card: StoredCard, pc: PriceAndCode, categories: readonly Category[]): CardRecord {
  const problems = [...cardBlockers(card), ...printProblems(card.content, pc, categories)];
  if (problems.length) throw new CopyError(problems.join(' '));
  return printableCard(card.content, pc, categories);
}
