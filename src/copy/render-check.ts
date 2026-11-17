// The rendered check for new copy: builds a sheet with the card builder (src/cards/build.ts),
// converts it with LibreOffice under nice 19, one conversion at a time (src/cards/render.ts),
// and runs the skill's checks on it (src/cards/verify.ts). The rendered line count is the real
// limit; the character limits only stand in for it.
//
// One conversion takes a few seconds, so generate.ts runs it only on a card that already passes
// the code checks, at most twice per card. The real fonts must be installed (docs/INSTALL.md, Fonts for the card check):
// without them the check means nothing, so it refuses to report.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCards } from '../cards/build.ts';
import { DEFAULT_WORK_ROOT, docxToPdf, pdfFonts } from '../cards/render.ts';
import type { CardConfig, CardRecord } from '../cards/types.ts';
import { checkSheetPdf } from '../cards/verify.ts';
import { currentEyebrow, formatPrice } from './card.ts';
import { PER_POUND } from './checks.ts';
import type { Category } from './config.ts';
import type { RenderCheck } from './generate.ts';

export interface RenderedCard {
  copyLines: number;
  maxCopyLines: number;
  /** The last words of the copy are missing from the page: the panel cut them off. */
  clipped: boolean;
  /** Words of the card missing from its page. */
  shortWords: string[];
}

/** A price as wide as most, for checking layout only. It never reaches a printed card. */
const LAYOUT_PRICE_CENTS = 9999;

/** Renders the cards in the order given and checks each. Throws when the real fonts are missing. */
export async function renderCards(cards: readonly CardRecord[], cfg: CardConfig, workRoot: string = DEFAULT_WORK_ROOT): Promise<RenderedCard[]> {
  mkdirSync(workRoot, { recursive: true });
  const dir = mkdtempSync(join(workRoot, 'copy-check-'));
  try {
    const built = await buildCards(cards, cfg, { sort: false });
    const docx = join(dir, 'check.docx');
    writeFileSync(docx, built.buffer, { mode: 0o600 });
    const pdf = await docxToPdf(docx, dir, { workRoot });
    const fonts = pdfFonts(pdf).map((f) => f.replace(/\s/g, ''));
    const missing = [cfg.fonts.display, cfg.fonts.body].map((f) => f.replace(/\s/g, '')).filter((f) => !fonts.some((n) => n.startsWith(f)));
    if (missing.length) throw new Error(`The rendered check needs the real fonts, and ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not installed. See docs/INSTALL.md, Fonts for the card check.`);
    const slots = built.layout.map((c, i) => (i < cards.length ? c : null));
    const r = checkSheetPdf(pdf, slots, cfg);
    return cards.map((_, i) => {
      const c = r.cards.find((x) => (x.page - 1) * 4 + (x.slot - 1) === i);
      if (!c) return { copyLines: 0, maxCopyLines: 0, clipped: true, shortWords: [] };
      return { copyLines: c.copyLines, maxCopyLines: c.maxCopyLines, clipped: c.missingTail.length > 0, shortWords: c.shortWords };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A RenderCheck for generate.ts: one card on its own sheet. */
export function renderCheckFor(cfg: CardConfig, categories: readonly Category[], workRoot: string = DEFAULT_WORK_ROOT): RenderCheck {
  return async (content, product) => {
    // Built directly, not through printableCard: the layout check must run even on a card that
    // cannot print yet (a category not in the config), since the printed lines do not depend on it.
    const card: CardRecord = {
      code: product.soldByWeight && product.scaleCode ? product.scaleCode : '',
      price: formatPrice(LAYOUT_PRICE_CENTS),
      unit: product.soldByWeight ? PER_POUND : content.unit,
      origin: content.origin,
      eyebrow: currentEyebrow(content.eyebrow, categories).eyebrow,
      n1: content.n1,
      n2: content.n2,
      producer: content.producer,
      specs: content.specs,
      copy: content.copy,
    };
    const [r] = await renderCards([card], cfg, workRoot);
    return r ? { copyLines: r.copyLines, maxCopyLines: r.maxCopyLines, clipped: r.clipped } : null;
  };
}
