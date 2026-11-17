// Price drift: an email price that differs from the register price (Bart, November 10). The
// register price is Square's fixed price at the store. For an item with a four-digit scale code it
// is also the scale price: rule 12 keeps Square equal to the scales, and ShelfReady never reads a
// scale for this (a read can freeze one). So an item with a scale code counts only when Square
// sells it by weight, at a fixed price per pound.
//
// Only rows Bart confirmed in the matches file are compared. Rows matched to none, rows with no
// confirmed match (oysters and clams, today), rows ShelfReady does not change (dozen, package,
// "Call"), and items Square has no usable fixed price for are left alone and listed. A fix that
// moves a price more than the big-change limit (30%, Bart, November 7), or one past the count per
// edit, is not made on its own: it is listed for a person, with a warning.

import { buildCatalogIndex, itemOf } from '../matching/catalog.ts';
import type { CatalogData } from '../square/catalog-source.ts';
import { rawVariations, variationSquareState } from '../square/variation-state.ts';
import type { MailchimpConfig } from './config.ts';
import { centsText, foldKey, parseRows, rowProblem, type PriceEdit } from './html.ts';
import type { FishMatches } from './matches.ts';

export interface RegisterPrice {
  cents: number;
  perPound: boolean;
}

export interface RegisterBook {
  /** Where the prices came from, in plain words. */
  source: string;
  /** The register price, or why there is none. */
  lookup(itemId: string, variationId: string | null): RegisterPrice | string;
}

/** The register prices in a Square catalog, at the catalog's own location. */
export function registerFromCatalog(data: CatalogData, sourceLabel: string): RegisterBook {
  const index = buildCatalogIndex({ objects: data.objects, locationId: data.locationId });
  const raw = rawVariations(data.objects);
  return {
    source: sourceLabel,
    lookup(itemId, variationId) {
      const item = index.itemById.get(itemId);
      if (!item) return 'it is not in Square.';
      const vars = index.variations.filter((v) => v.itemId === itemId && v.availableHere);
      const v = variationId ? vars.find((x) => x.id === variationId) : vars.length === 1 ? vars[0] : undefined;
      if (!v) return variationId ? 'its Square variation is not at the store.' : 'its Square item has more than one variation. Name one in the matches file.';
      if (v.pricing !== 'fixed' || v.priceCents === null || v.priceCents <= 0) return 'Square has no fixed price for it.';
      const state = variationSquareState(raw.get(v.id), data.locationId);
      if (state.locationVariable || state.locationPricing) return 'the store has its own price for it in Square.';
      const code = itemOf(index, v).scaleCode;
      if (code && !v.perPound) return `it has scale code ${code} but Square does not sell it by the pound (rule 12).`;
      return { cents: v.priceCents, perPound: v.perPound };
    },
  };
}

export interface Drift {
  /** Rows to set to the register price, with the price the email shows now. */
  fixes: Array<PriceEdit & { fromText: string }>;
  /** Rows not compared, and why. */
  notCompared: Array<{ key: string; why: string }>;
  /** Rows that differ but are not fixed on their own: too big a move, or past the count. A person checks them. */
  forPerson: Array<{ key: string; why: string }>;
}

export interface DriftLimits {
  /** A fix moving the price more than this percent is left for a person (Bart, November 7: 30). */
  percent: number;
  /** The most fixes one edit makes on its own. */
  maxCount: number;
}

/** Compares every confirmed row in the email with the register price. Pure. */
export function findDrift(html: string, matches: FishMatches, book: RegisterBook, cfg: Pick<MailchimpConfig, 'units'>, limits: DriftLimits): Drift {
  const rows = parseRows(html);
  const out: Drift = { fixes: [], notCompared: [], forPerson: [] };
  const count = new Map<string, number>();
  for (const r of rows) count.set(foldKey(r.key), (count.get(foldKey(r.key)) ?? 0) + 1);
  const perItem = new Map<string, number>();
  for (const m of matches.rows) if (m.status === 'confirmed' && m.itemId) perItem.set(m.itemId, (perItem.get(m.itemId) ?? 0) + 1);
  for (const r of rows) {
    const k = foldKey(r.key);
    const m = matches.rows.find((x) => foldKey(x.row) === k);
    const skip = (why: string): void => void out.notCompared.push({ key: r.key, why });
    if (!m || m.status === 'proposed') {
      skip('no confirmed Square match.');
      continue;
    }
    if (m.status === 'none') {
      skip('matched to no Square item.');
      continue;
    }
    if ((count.get(k) ?? 0) > 1) {
      skip('the email has more than one row with this name.');
      continue;
    }
    if ((perItem.get(m.itemId!) ?? 0) > 1) {
      skip('more than one email row is matched to this Square item.');
      continue;
    }
    const problem = rowProblem(r, cfg.units);
    if (problem) {
      skip(problem);
      continue;
    }
    const price = book.lookup(m.itemId!, m.variationId);
    if (typeof price === 'string') {
      skip(price);
      continue;
    }
    if ((cfg.units[r.unit] === 'per_pound') !== price.perPound) {
      skip(`the email sells it by the ${r.unit}, but Square ${price.perPound ? 'prices it per pound' : 'prices it per item'}.`);
      continue;
    }
    if (price.cents === r.cents) continue;
    const to = centsText(price.cents);
    const percent = (Math.abs(price.cents - r.cents!) * 100) / r.cents!;
    if (percent > limits.percent) {
      out.forPerson.push({ key: r.key, why: `the email shows ${r.priceText} and the register ${to}, a ${Math.round(percent)}% move, more than ${limits.percent}%. A person must check it before it changes.` });
    } else if (out.fixes.length >= limits.maxCount) {
      out.forPerson.push({ key: r.key, why: `the email shows ${r.priceText} and the register ${to}, but one edit fixes at most ${limits.maxCount} prices on its own. A person must check it.` });
    } else out.fixes.push({ key: r.key, toCents: price.cents, fromText: r.priceText });
  }
  return out;
}
