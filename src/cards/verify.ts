// The two checks the cc-case-cards skill requires before a sheet is delivered.
//
// 1. Page count: slots divided by four, exactly. More means something overflowed.
// 2. Clip check: for each card, the last few words of its final paragraph must
//    appear in that page's extracted text. Punctuation is stripped from both
//    sides and the comparison is per page. A page's text interleaves the two
//    columns, so each word is looked up on its own, never as a phrase.
//
// Two stricter checks are added, because the clip check alone misses a line
// that is only half hidden. LibreOffice draws the top half of an eleventh
// line at the bottom of the panel, and pdftotext still extracts its words.
// 3. Copy lines: the copy's rendered line count (from word boxes) must not
//    exceed what the panel holds: (row height - top and bottom padding -
//    paragraph gaps) / line height, rounded down. Ten lines for two paragraphs.
// 4. Full text: every word of every card on the page (name, producer, specs,
//    all copy) must be on that page as often as the cards use it.
import { cardName } from './build.ts';
import { minCardPitchPt, pdfPageCount, pdfPageCountAsync, pdfPageText, pdfPageTextAsync, pdfWords, pdfWordsAsync, textLines, wordsByCard, type PageWords, type WordBox } from './render.ts';
import type { CardConfig, CardRecord } from './types.ts';

/** How many trailing words of the final paragraph the clip check looks for. */
export const CLIP_WORDS = 4;

/** Strips punctuation, folds case and splits into words. */
export function words(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    // pdftotext joins a word hyphenated at a line end ("no-" + "boil" becomes
    // "noboil"), so hyphenated compounds are joined on both sides.
    .replace(/([\p{L}\p{N}])[-‐‑]\s*(?=[\p{L}\p{N}])/gu, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

const bag = (ws: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const w of ws) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
};

export interface CardCheck {
  page: number;
  slot: number;
  name: string;
  /** The words the clip check looked for. */
  tail: string[];
  /** Skill clip check: tail words missing from the page. Empty means pass. */
  missingTail: string[];
  /** Stricter check: words short on the page, across all cards on it. */
  shortWords: string[];
  /** Rendered copy lines, counting a partly hidden last line. */
  copyLines: number;
  /** Lines the copy panel holds for this card's paragraph count. */
  maxCopyLines: number;
}

export interface SheetCheck {
  slots: number;
  expectedPages: number;
  pages: number;
  pageCountOk: boolean;
  cards: CardCheck[];
  clipOk: boolean;
  copyLinesOk: boolean;
  fullTextOk: boolean;
}

/** Lines that fit in the exact-height copy panel for a card with `paragraphs` paragraphs. */
export function maxCopyLines(cfg: CardConfig, paragraphs: number): number {
  const b = cfg.blocks.copy;
  const room = cfg.geometry.rowHeights[cfg.geometry.exactRow] - b.margins.top - b.margins.bottom - b.paragraphAfter * (paragraphs - 1);
  return Math.floor(room / b.line);
}

/**
 * Counts the copy's rendered lines among a card's word boxes. Copy is the
 * only text in its size and font, so its box height is the most common
 * height among words that belong to the copy; lines of that height whose
 * words all come from the copy are its lines.
 */
export function countCopyLines(card: CardRecord, boxes: WordBox[]): number {
  const text = card.copy.join(' ');
  // Word boxes keep a line-end hyphen split ("no-" then "boil"), so accept the parts too.
  const copyWords = new Set([...words(text), ...words(text.replace(/[-‐‑]/g, ' '))]);
  const mine = boxes.filter((b) => words(b.text).some((w) => copyWords.has(w)));
  if (mine.length === 0) return 0;
  const heights = bag(mine.map((b) => (b.y1 - b.y0).toFixed(1)));
  const h = Number([...heights].sort((a, b) => b[1] - a[1])[0][0]);
  return textLines(boxes).filter(
    (line) => line.every((b) => Math.abs(b.y1 - b.y0 - h) < 0.3) && line.every((b) => words(b.text).every((w) => copyWords.has(w))),
  ).length;
}

/** What poppler read from a rendered sheet: the page count, word boxes per page, text per page. */
export interface RenderedSheet {
  pages: number;
  boxes: PageWords[];
  /** The text of each page checked, page 1 first. */
  text: string[];
}

/** Runs the checks on a PDF of the given slots (null for blank padding). Blocks: for scripts. */
export function checkSheetPdf(pdf: string, slots: Array<CardRecord | null>, cfg: CardConfig): SheetCheck {
  const pages = pdfPageCount(pdf);
  const n = Math.min(pages, slots.length / 4);
  return checkRendered({ pages, boxes: pdfWords(pdf), text: Array.from({ length: n }, (_, p) => pdfPageText(pdf, p + 1)) }, slots, cfg);
}

/** The same checks, with poppler run in child processes, so the server never blocks. */
export async function checkSheetPdfAsync(pdf: string, slots: Array<CardRecord | null>, cfg: CardConfig): Promise<SheetCheck> {
  const pages = await pdfPageCountAsync(pdf);
  const n = Math.min(pages, slots.length / 4);
  const boxes = await pdfWordsAsync(pdf);
  const text: string[] = [];
  for (let p = 0; p < n; p++) text.push(await pdfPageTextAsync(pdf, p + 1));
  return checkRendered({ pages, boxes, text }, slots, cfg);
}

/** The checks on what poppler read. No programs run here. */
export function checkRendered(rendered: RenderedSheet, slots: Array<CardRecord | null>, cfg: CardConfig): SheetCheck {
  const expectedPages = slots.length / 4;
  const pages = rendered.pages;
  const boxes = rendered.boxes;
  const cards: CardCheck[] = [];
  for (let p = 0; p < Math.min(pages, expectedPages); p++) {
    const byCard = wordsByCard(boxes[p] ?? { width: 0, height: 0, words: [] }, minCardPitchPt(cfg.geometry.rowHeights, cfg.geometry.gutter));
    const pageWords = words(rendered.text[p] ?? '');
    const onPage = new Set(pageWords);
    const have = bag(pageWords);
    const four = slots.slice(p * 4, p * 4 + 4);
    const need = bag(
      four.flatMap((c) => (c ? words([c.origin, c.eyebrow, c.n1 + c.n2, c.producer, ...c.specs.flat(), ...c.copy, c.price, c.unit, c.code].join(' ')) : [])),
    );
    const short = [...need].filter(([w, n]) => (have.get(w) ?? 0) < n).map(([w]) => w);
    four.forEach((c, i) => {
      if (!c) return;
      const last = c.copy[c.copy.length - 1] ?? '';
      const tail = words(last).slice(-CLIP_WORDS);
      // Every word the card prints, price, unit, code, origin and category included, so a hidden
      // price or code fails the card, not only the page count.
      const mine = new Set(words([c.origin, c.eyebrow, c.n1 + c.n2, c.producer, ...c.specs.flat(), ...c.copy, c.price, c.unit, c.code].join(' ')));
      cards.push({
        page: p + 1,
        slot: i + 1,
        name: cardName(c),
        tail,
        missingTail: tail.filter((w) => !onPage.has(w)),
        shortWords: short.filter((w) => mine.has(w)),
        copyLines: countCopyLines(c, byCard[i]),
        maxCopyLines: maxCopyLines(cfg, c.copy.length),
      });
    });
  }
  return {
    slots: slots.length,
    expectedPages,
    pages,
    pageCountOk: pages === expectedPages,
    cards,
    clipOk: pages >= expectedPages && cards.every((c) => c.missingTail.length === 0),
    copyLinesOk: cards.every((c) => c.copyLines <= c.maxCopyLines),
    fullTextOk: cards.every((c) => c.shortWords.length === 0),
  };
}
