// Code checks on newly written card copy, against the store's limits in its card config.
//
// They apply to generated copy only. Copy imported from the existing cards, or edited by a
// person, is never flagged for length: only the rendered clip and line checks judge it
// (store/docs/CARDS.md). The character limits stand in for the rendered line count, which is the real
// rule; src/copy/render-check.ts runs that when LibreOffice is available.
//
// The guard (money amounts, phone numbers, web addresses) is the one check that also outlives
// the retry: a generated card still caught by it is stored blocked, and cannot print until a
// person edits the finding out (src/copy/store.ts). Talk of price without an amount only goes on
// the verify list (priceTalk).

import type { CopyLimits } from './config.ts';
import { cleanText, curlyApostrophes, flaggedPhrases, guardFindings, priceWords, unwantedDashes, type GuardFinding } from './text.ts';
import type { CardContent } from './types.ts';

export type ProblemField = 'copy' | 'name' | 'producer' | 'spec' | 'unit' | 'origin' | 'style' | 'guard' | 'render';

export interface CheckProblem {
  field: ProblemField;
  /** Plain words, with the measured length and the limit, for the review screen and the retry. */
  message: string;
}

export interface NormalizeOptions {
  /** Weight goods always print PER POUND. */
  soldByWeight: boolean;
  curlyApostrophes: boolean;
}

/** The unit printed for goods sold by weight. */
export const PER_POUND = 'PER POUND';

/** The name as printed: n1 and n2 together. */
export function fullName(c: Pick<CardContent, 'n1' | 'n2'>): string {
  return `${c.n1}${c.n2}`.replace(/\s+/g, ' ').trim();
}

/**
 * Fixes code can make without changing what the card says: characters a card cannot show
 * removed, stray spaces folded, curly apostrophes, capitals where the card prints capitals, n1
 * ending in a space, a one-word name set wholly in n2, and PER POUND for weight goods.
 */
export function normalizeContent(c: CardContent, opts: NormalizeOptions): { content: CardContent; fixes: string[] } {
  const fixes: string[] = [];
  const t = (s: string) => {
    const v = cleanText(s);
    return opts.curlyApostrophes ? curlyApostrophes(v) : v;
  };
  let n1 = t(c.n1);
  let n2 = t(c.n2);
  const name = `${n1} ${n2}`.replace(/\s+/g, ' ').trim();
  if (name !== '' && !name.includes(' ')) {
    if (n1 !== '') fixes.push('A one-word name goes wholly in n2.');
    n1 = '';
    n2 = name;
  } else if (n2 === '' && name !== '') {
    const cut = name.lastIndexOf(' ');
    n1 = name.slice(0, cut);
    n2 = name.slice(cut + 1);
    fixes.push('n2 was empty, so the last word of the name moved to n2.');
  }
  if (n1 !== '') n1 = `${n1} `;
  let unit = t(c.unit).toUpperCase();
  if (opts.soldByWeight && unit !== PER_POUND) {
    if (unit !== '') fixes.push(`Sold by weight, so the unit is ${PER_POUND}, not ${unit}.`);
    unit = PER_POUND;
  }
  const content: CardContent = {
    origin: t(c.origin).toUpperCase(),
    eyebrow: t(c.eyebrow).toUpperCase(),
    n1,
    n2,
    producer: t(c.producer),
    specs: c.specs.map(([label, value]) => [t(label).toUpperCase(), t(value)]) as CardContent['specs'],
    copy: c.copy.map(t),
    unit,
  };
  return { content, fixes };
}

/** The name broken into lines of at most perLine characters, word by word. A longer word sits alone. */
export function nameLines(name: string, perLine: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const w of name.split(/\s+/).filter(Boolean)) {
    if (line === '') line = w;
    else if (line.length + 1 + w.length <= perLine) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Characters as the limits count them: the paragraphs joined by one space, spaces included. */
export function copyChars(copy: readonly string[]): number {
  return copy.join(' ').length;
}

/** Every text field of a card, for checks that look at all of it. */
export function allText(c: CardContent): string {
  return cardFields(c).join(' \n ');
}

/** Each text field of a card on its own: the name as printed, each spec label and value, each paragraph. */
export function cardFields(c: CardContent): string[] {
  return [c.origin, c.eyebrow, fullName(c), c.producer, ...c.specs.flat(), ...c.copy, c.unit];
}

const GUARD_WORDS = { price: 'a money amount', phone: 'a phone number', link: 'a web address' } as const;

/**
 * Money amounts, phone numbers and web addresses, each field checked on its own, so the end of
 * one field and the start of the next cannot make one. A card prints its own price.
 */
export function guardProblems(c: CardContent): CheckProblem[] {
  const found = new Set<GuardFinding>();
  for (const field of cardFields(c)) for (const g of guardFindings(field)) found.add(g);
  return (['price', 'phone', 'link'] as const)
    .filter((g) => found.has(g))
    .map((g) => ({ field: 'guard' as const, message: `The card has ${GUARD_WORDS[g]} on it. Leave it off: a card prints its own price and nothing else of the kind.` }));
}

/** Talk of price with no amount ("at this price", "cheap"), field by field. It never blocks: it goes on the verify list. */
export function priceTalk(c: CardContent): string[] {
  const found = new Set<string>();
  for (const field of cardFields(c)) for (const w of priceWords(field)) found.add(w);
  return [...found];
}

/** The producer line as the store writes it: the maker, one middle dot, then the place. */
const PRODUCER_FORMAT = /^[^·]*\S · \S[^·]*$/u;

/** Every limit and style rule a newly written card breaks. Empty means it is within all of them. */
export function checkContent(c: CardContent, limits: CopyLimits, opts: { flagPhrases: readonly string[]; soldByWeight: boolean }): CheckProblem[] {
  const out: CheckProblem[] = [];
  const L = limits;

  // The two paragraphs.
  if (c.copy.length !== L.copy.paragraphs) out.push({ field: 'copy', message: `The copy has ${c.copy.length} paragraphs. It must have ${L.copy.paragraphs}.` });
  c.copy.forEach((p, i) => {
    if (p.trim() === '') out.push({ field: 'copy', message: `Paragraph ${i + 1} is empty.` });
  });
  const chars = copyChars(c.copy);
  if (chars > L.copy.maxChars) {
    out.push({
      field: 'copy',
      message: `The paragraphs run to ${chars} characters with spaces. The most is ${L.copy.maxChars} (aim for ${L.copy.targetChars}). Cut about ${chars - L.copy.targetChars} characters.`,
    });
  }

  // The name: n1 and n2 set together, wrapping onto a second line at most.
  const name = fullName(c);
  if (name === '') out.push({ field: 'name', message: 'The name is empty.' });
  const lines = nameLines(name, L.name.oneLineChars);
  if (name.length > L.name.maxChars || lines.length > L.name.maxLines) {
    out.push({
      field: 'name',
      message: `The name "${name}" is ${name.length} characters and takes ${lines.length} lines of ${L.name.oneLineChars}. The most is ${L.name.maxChars} characters on ${L.name.maxLines} lines.`,
    });
  }

  if (c.producer === '') out.push({ field: 'producer', message: 'The producer line is empty.' });
  else {
    if (c.producer.length > L.producer.maxChars) out.push({ field: 'producer', message: `The producer line is ${c.producer.length} characters. The most is ${L.producer.maxChars}.` });
    if (!PRODUCER_FORMAT.test(c.producer)) out.push({ field: 'producer', message: `The producer line "${c.producer}" must read Maker · Place, with one middle dot between them.` });
  }

  // Three specs, each value centred in a third of the card.
  c.specs.forEach(([label, value], i) => {
    const n = i + 1;
    if (label === '') out.push({ field: 'spec', message: `Spec ${n} has no label.` });
    else if (label.length > L.specLabel.maxChars) out.push({ field: 'spec', message: `Spec label ${label} is ${label.length} characters. The most is ${L.specLabel.maxChars}.` });
    if (value === '') out.push({ field: 'spec', message: `Spec ${n} (${label || 'no label'}) has no value.` });
    else if (value.length > L.specValue.maxChars) {
      out.push({ field: 'spec', message: `Spec value "${value}" is ${value.length} characters. The most is ${L.specValue.maxChars} (aim for ${L.specValue.targetChars}).` });
    }
  });
  // A value longer than the target spills out of its third. It fits only while its neighbour is
  // short enough to leave room: the two together no longer than two targets.
  for (let i = 0; i < 2; i++) {
    const a = c.specs[i]![1];
    const b = c.specs[i + 1]![1];
    const room = 2 * L.specValue.targetChars;
    if ((a.length > L.specValue.targetChars || b.length > L.specValue.targetChars) && a.length + b.length > room && a.length <= L.specValue.maxChars && b.length <= L.specValue.maxChars) {
      out.push({ field: 'spec', message: `Spec values "${a}" and "${b}" sit side by side and run to ${a.length + b.length} characters together. Neighbours may take ${room} at most.` });
    }
  }

  if (c.unit === '') out.push({ field: 'unit', message: 'The unit is empty.' });
  else if (!opts.soldByWeight && c.unit === PER_POUND) {
    out.push({ field: 'unit', message: 'Square sells this item by the unit, so the unit is the size of one package, not PER POUND.' });
  }
  if (c.origin === '') out.push({ field: 'origin', message: 'The origin line is empty.' });

  // Style: dashes the store never prints, and words that read like marketing. Marketing words
  // are looked for in what the card says about the product, not in the producer line, where a
  // company's own name can hold one ("Gourmet").
  for (const d of unwantedDashes(allText(c))) out.push({ field: 'style', message: `The card uses ${d}. Use a full stop or a comma instead.` });
  const flagged = flaggedPhrases([c.n1, c.n2, ...c.specs.map((s) => s[1]), ...c.copy].join(' \n '), opts.flagPhrases);
  if (flagged.length) out.push({ field: 'style', message: `Reads like marketing: ${flagged.join(', ')}. Say something specific instead.` });
  out.push(...guardProblems(c));
  return out;
}
