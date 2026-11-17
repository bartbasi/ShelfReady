// The dry run: exactly what approving this run would change, with nothing written anywhere.
//
// Square, per variation (cc-case-cards skill, store/docs/DECISIONS.md):
// - the price, when it changes;
// - the switch to sold by weight for any item with a scale code that is not a fixed price per
//   pound with the per-pound unit (rule 12), at the new price, including a location override
//   that takes the price at the register;
// - the name, when it was edited in review, with the scale code kept at the end;
// - stock set to the invoice figure, replacing what Square shows, with tracking turned on first
//   when it is off (turning it on without a count marks the item sold out).
// Scales: each scale code's new price, for every scale named in the config. A preview only: no
// scale is contacted in this step. Square and the scales always get the same price per pound.
// Cards: exactly the cards that would print, each with its final text, price and code, as the
// .docx builder will take them (src/copy/card.ts printableCard). A card a person left out of the
// run is listed apart. Lines where nothing arrived make no card.
//
// The hash covers what would be sent, not the stock Square shows now (sales change that), so an
// approval is tied to the exact changes the person saw.

import { createHash } from 'node:crypto';
import type { OverrideAction } from '../pricing/overrides.ts';
import type { PricedLine } from '../pricing/price.ts';
import { add, toDecimalText, ZERO, type Rat } from '../pricing/rational.ts';
import { variationSquareState } from '../square/variation-state.ts';
import type { RunCatalog } from './catalog-cache.ts';
import type { Evaluation, LineEval } from './evaluate.ts';
import type { Credit, ClaimTerms } from './inventory.ts';
import type { Decision } from './store.ts';
import { splitTrailingCode } from '../lib/scale-code.ts';
import type { CardRecord } from '../cards/types.ts';
import type { CardSource } from '../copy/types.ts';

export interface SquareChange {
  variationId: string;
  itemId: string;
  itemName: string;
  label: string;
  lines: number[];
  /**
   * locationOverride: the store's location override carries its own price or pricing type, so
   * step 7 must change it too, or the register keeps the old price (rule 12).
   */
  price: { fromCents: number | null; toCents: number; perPound: boolean; locationOverride: boolean } | null;
  /** A move over the big-change limit, confirmed in review. overHalf: the scales will warn too. */
  bigChange: { percent: number; up: boolean; overHalf: boolean } | null;
  switchToWeight: { now: string; unitId: string; locationOverride: boolean } | null;
  rename: { from: string; to: string } | null;
  tracking: { turnOn: boolean };
  stock: { from: string | null; to: string; unit: 'lb' | 'unit' } | null;
  /** What each line added to the stock, for a correction after approval. */
  lineStock: Array<{ n: number; stock: string }>;
  overrideAction: OverrideAction['kind'];
  /** The versions read now. Step 7 reads each item back and stops if they changed. */
  versions: { item: number | null; variation: number | null };
}

export interface ScaleChange {
  code: string;
  itemName: string;
  priceCents: number;
  scales: string[];
}

export interface CardPreview {
  variationId: string;
  /** The item's store name without its code (the edited name when it is renamed), for the list. */
  title: string;
  cardId: number;
  /** The card version shown. An edit or a check after the dry run changes what is approved. */
  version: number;
  source: CardSource;
  /** The card as it will print: text from the card store, price and code from pricing and Square. */
  record: CardRecord;
}

export interface ChangePreview {
  dryRun: true;
  runId: number;
  computedAt: string;
  catalog: { source: string; label: string; takenAt: string };
  square: SquareChange[];
  scales: { contacted: false; names: string[]; changes: ScaleChange[] };
  cards: { cards: CardPreview[]; leftOut: Array<{ variationId: string; title: string; why: string }> };
  credits: Credit[];
  claim: ClaimTerms | null;
  leftOut: Array<{ n: number; why: string }>;
  /** The big-change limit in force when the preview was made, in percent. */
  bigChangePercent: number;
  hash: string;
}

export interface PreviewInput {
  runId: number;
  evaluation: Evaluation;
  catalog: RunCatalog;
  catalogLabel: string;
  decisions: readonly Decision[];
  /** In-stock counts Square shows now, by variation. */
  counts: ReadonlyMap<string, string>;
  scaleNames: readonly string[];
  now: number;
  /** When this run read its catalog. */
  catalogTakenAt?: string;
}

/** The new full item name: the edited name with the item's scale code kept at the end. */
export function renamedItem(currentName: string, scaleCode: string | null, edited: string): string {
  const base = edited.replace(/\s+/g, ' ').trim();
  if (!scaleCode) return base;
  // A code typed at the end is dropped first, so it is never doubled.
  const split = splitTrailingCode(base);
  const clean = split.trailing === scaleCode ? split.base : base;
  return `${clean} ${scaleCode}`;
}

/** The card title: the edited name, else the Square name without its code. */
function cardTitle(itemName: string, rename: string | null): string {
  return splitTrailingCode(rename ?? itemName).base;
}

export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The hash of what would be sent. */
export function previewHash(p: Omit<ChangePreview, 'hash' | 'computedAt'>): string {
  const what = {
    runId: p.runId,
    square: p.square.map((s) => ({ ...s, stock: s.stock ? { to: s.stock.to, unit: s.stock.unit } : null, versions: null })),
    scales: p.scales.changes,
    cards: p.cards.cards,
    cardsLeftOut: p.cards.leftOut.map((c) => c.variationId),
  };
  return createHash('sha256').update(stableJson(what)).digest('hex');
}

function nowState(p: PricedLine | null, locationVariable: boolean): string {
  if (locationVariable) return 'the price is taken at the register at this store';
  if (!p) return 'not sold by weight';
  return p.squareCents === null ? 'no fixed price per pound' : 'not a fixed price per pound with the per-pound unit';
}

export function buildPreview(input: PreviewInput): ChangePreview {
  const { evaluation: ev, catalog } = input;
  const loc = catalog.index.locationId;
  const renames = new Map<string, string>();
  for (const d of input.decisions) {
    if (d.kind === 'rename' && typeof d.value.name === 'string') renames.set(d.target, d.value.name);
  }

  const groups = new Map<string, LineEval[]>();
  for (const l of ev.lines) {
    if (l.outcome !== 'send' || !l.variationId) continue;
    groups.set(l.variationId, [...(groups.get(l.variationId) ?? []), l]);
  }

  const square: SquareChange[] = [];
  const scales: ScaleChange[] = [];
  const cards: CardPreview[] = [];
  const cardsLeftOut: ChangePreview['cards']['leftOut'] = [];
  const renamedItems = new Set<string>();
  for (const [variationId, ls] of groups) {
    const first = ls[0]!;
    const p = ls.map((l) => l.priced).find((x) => x && x.newCents !== null) ?? first.priced;
    const state = variationSquareState(catalog.raw.get(variationId), loc);
    const toCents = p?.newCents ?? null;
    const switching = p?.switchToWeight === true;
    const priceChanges = toCents !== null && (switching || toCents !== p!.squareCents);
    let stockTotal: Rat = ZERO;
    let stockUnit: 'lb' | 'unit' = first.byWeight ? 'lb' : 'unit';
    let stockOk = true;
    for (const l of ls) {
      if (l.stock?.ok) {
        stockTotal = add(stockTotal, l.stock.quantity);
        stockUnit = l.stock.unit;
      } else stockOk = false;
    }
    const editedName = first.itemId && !renamedItems.has(first.itemId) ? renames.get(first.itemId) : undefined;
    const newName = editedName !== undefined ? renamedItem(first.itemName, first.scaleCode, editedName) : null;
    if (first.itemId && newName !== null) renamedItems.add(first.itemId);
    const big = ls.map((l) => l.bigChange).find((b) => b !== null) ?? null;
    const stock = stockOk ? { from: input.counts.get(variationId) ?? null, to: toDecimalText(stockTotal, stockUnit === 'lb' ? 3 : 0).text, unit: stockUnit } : null;
    square.push({
      variationId,
      itemId: first.itemId!,
      itemName: first.itemName,
      label: first.label,
      lines: ls.map((l) => l.n),
      price: priceChanges ? { fromCents: p!.squareCents, toCents: toCents!, perPound: first.byWeight, locationOverride: state.locationPricing } : null,
      bigChange: priceChanges && big ? { percent: big.percent, up: big.up, overHalf: big.overHalf } : null,
      switchToWeight: switching && ev.perPoundUnitId ? { now: nowState(p, state.locationVariable), unitId: ev.perPoundUnitId, locationOverride: state.locationPricing } : null,
      rename: newName !== null && newName !== first.itemName ? { from: first.itemName, to: newName } : null,
      tracking: { turnOn: stock !== null && !state.tracked },
      stock,
      lineStock: ls.filter((l) => l.stock?.ok).map((l) => ({ n: l.n, stock: l.stock!.ok ? l.stock!.text : '' })),
      overrideAction: p?.overrideAction.kind ?? 'none',
      versions: { item: state.itemVersion, variation: state.variationVersion },
    });
    if (first.scaleCode && toCents !== null && (priceChanges || switching)) {
      scales.push({ code: first.scaleCode, itemName: newName ?? first.itemName, priceCents: toCents, scales: [...input.scaleNames] });
    }
    const title = cardTitle(first.itemName, newName);
    const rc = ev.cards.find((c) => c.variationId === variationId);
    if (rc?.leftOut) cardsLeftOut.push({ variationId, title, why: 'Left out of this run by a person.' });
    else if (rc?.card && rc.record && rc.waitingFor.length === 0) cards.push({ variationId, title, cardId: rc.card.id, version: rc.card.version, source: rc.card.source, record: rc.record });
    else cardsLeftOut.push({ variationId, title, why: rc ? `Cannot print yet: ${rc.waitingFor.join(' ') || 'no card.'}` : 'No card looked up.' });
  }

  const leftOut = ev.lines
    .filter((l) => l.outcome !== 'send')
    .map((l) => ({
      n: l.n,
      why:
        l.outcome === 'skipped'
          ? 'Left out of this run in review.'
          : l.outcome === 'not_for_resale'
            ? 'Not for resale.'
            : l.outcome === 'nothing_arrived'
              ? 'Nothing arrived, so nothing changes for it.'
              : 'Not matched.',
    }));

  const body: Omit<ChangePreview, 'hash'> = {
    dryRun: true,
    runId: input.runId,
    computedAt: new Date(input.now).toISOString(),
    catalog: { source: catalog.snapshot.source, label: input.catalogLabel, takenAt: input.catalogTakenAt || catalog.snapshot.takenAt },
    square,
    scales: { contacted: false, names: [...input.scaleNames], changes: scales },
    cards: { cards, leftOut: cardsLeftOut },
    credits: ev.credits,
    claim: ev.claim,
    leftOut,
    bigChangePercent: ev.bigChangePercent,
  };
  return { ...body, hash: previewHash(body) };
}
