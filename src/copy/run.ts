// Card copy for one invoice run: the lookup for every matched product, then new copy for the
// ones with none, under the run's cost cap. This is what the run's card copy stage calls
// (src/runs/card-copy.ts); it decides nothing about Square or the scales.
//
// - What arrived (decisions, November 7): a line where nothing arrived gets no new card. A line
//   whose arrival is not settled yet is looked up, but no copy is written for it until it is.
// - A product with a stored card that may match (next: 'confirm') gets no new copy until a person
//   has looked: confirming would make the spend a waste.
// - The run's copy is done only when every card that will print needs nothing more from a person:
//   a generated card always does (a check of its current version), and so does a blocked one.

import type { ModelLine } from '../invoice/types.ts';
import type { Arrival } from '../runs/inventory.ts';
import { generateCopy, type CopyApproval, type CopyDeps, type CopyResult } from './generate.ts';
import { lookupCopy, type CopyLookup } from './lookup.ts';
import { cardBlockers } from './store.ts';
import { CopyError, type CopyCatalog, type InvoiceFacts, type ProductFacts } from './types.ts';

/**
 * What arrived of a line, exactly as the run resolves it (src/runs/inventory.ts Arrival): all,
 * some, none, or unclear until a person says.
 */
export type LineArrival = Arrival['arrived'];

export interface RunCopyItem {
  variationId: string;
  /** What the invoice line printed, or null when the product came from elsewhere. */
  invoice: InvoiceFacts | null;
  arrived: LineArrival;
}

export type RunCopyState =
  | 'stored'
  | 'confirm'
  | 'generated'
  | 'review'
  | 'needs_approval'
  | 'failed'
  | 'not_in_catalog'
  | 'not_generated'
  | 'not_arrived';

export interface RunCopyLine {
  variationId: string;
  label: string;
  state: RunCopyState;
  lookup: CopyLookup | null;
  generated: CopyResult | null;
  /** Why this line's card cannot print yet: a check, a block, a pick. Empty when it can. */
  waitingFor: string[];
}

export interface RunCopyOutcome {
  lines: RunCopyLine[];
  spentUsd: number;
  /** done: every card that will print needs nothing more from a person. */
  status: 'done' | 'needs_review';
  /** Plain words for the progress page. */
  message: string;
}

/** The invoice facts the copy model gets from one reading line. */
export function invoiceFactsFromLine(line: Pick<ModelLine, 'description' | 'brand' | 'pack_size' | 'units_per_pack' | 'origin'>, supplier: string): InvoiceFacts {
  return { supplier, description: line.description, brand: line.brand, packSize: line.pack_size, unitsPerPack: line.units_per_pack, origin: line.origin };
}

/**
 * What the caller allows for one product with no copy: auto (write it, under the run's total),
 * skip (do not write it now), or write it under an admin's approval of an amount.
 */
export type CopyPlan = 'auto' | 'skip' | { approval: CopyApproval };

export interface CopyForRunOptions {
  totalCapUsd: number;
  generate: boolean;
  /** Per product. Default auto. */
  plan?: (variationId: string) => CopyPlan;
  /** Called just before a product's copy is written, so the caller can record that a paid call is under way. */
  onStart?: (product: ProductFacts) => void;
  /** Called just before each paid call of a product with the worst case it may have cost so far. */
  onReserve?: (product: ProductFacts, worstUsd: number) => void;
  /** Called with each product's result, as soon as it is known. */
  onDone?: (product: ProductFacts, result: CopyResult) => void;
}

/**
 * Looks up copy for each product once (two lines of one product are one card), then writes new
 * copy where there is none, if generate is true, one product at a time under totalCapUsd. A
 * product counts as arrived when any of its lines did. A product written under an admin's
 * approval uses the approved amount instead of what is left of the total.
 */
export async function copyForRun(deps: CopyDeps, catalog: CopyCatalog, items: readonly RunCopyItem[], opts: CopyForRunOptions): Promise<RunCopyOutcome> {
  // One entry per product: arrived if any line arrived, unclear if none did but one is unclear.
  const rank: Record<LineArrival, number> = { all: 3, some: 3, unclear: 2, none: 1 };
  const products = new Map<string, RunCopyItem>();
  for (const item of items) {
    const prev = products.get(item.variationId);
    if (!prev || rank[item.arrived] > rank[prev.arrived]) products.set(item.variationId, { ...item, invoice: item.invoice ?? prev?.invoice ?? null });
  }
  const lines: RunCopyLine[] = [];
  let spentUsd = 0;
  for (const item of products.values()) {
    const line = (label: string, state: RunCopyState, lookup: CopyLookup | null, generated: CopyResult | null, waitingFor: string[] = []): void => {
      lines.push({ variationId: item.variationId, label, state, lookup, generated, waitingFor });
    };
    if (item.arrived === 'none') {
      line(item.variationId, 'not_arrived', null, null);
      continue;
    }
    let lookup: CopyLookup;
    try {
      lookup = lookupCopy(deps.db, catalog, item.variationId);
    } catch (err) {
      if (!(err instanceof CopyError)) throw err;
      line(item.variationId, 'not_in_catalog', null, null, ['The item is not in the catalog.']);
      continue;
    }
    const label = lookup.product.label;
    if (lookup.next === 'use') line(label, 'stored', lookup, null, lookup.card ? cardBlockers(lookup.card) : []);
    else if (lookup.next === 'confirm') line(label, 'confirm', lookup, null, ['A stored card may be this product: a person picks it, or none.']);
    else if (!opts.generate) line(label, 'not_generated', lookup, null, ['No copy has been written yet.']);
    else if (item.arrived === 'unclear') line(label, 'not_generated', lookup, null, ['What arrived is not settled, so no copy was written yet.']);
    else if ((opts.plan?.(item.variationId) ?? 'auto') === 'skip') line(label, 'not_generated', lookup, null, ['No copy has been written yet.']);
    else {
      const plan = opts.plan?.(item.variationId) ?? 'auto';
      opts.onStart?.(lookup.product);
      const product = lookup.product;
      const onReserve = opts.onReserve ? (usd: number) => opts.onReserve!(product, usd) : undefined;
      const r =
        typeof plan === 'object'
          ? await generateCopy(deps, product, item.invoice, { approval: plan.approval, onReserve })
          : await generateCopy(deps, product, item.invoice, { budgetUsd: Math.max(0, opts.totalCapUsd - spentUsd), onReserve });
      spentUsd += r.costUsd;
      opts.onDone?.(lookup.product, r);
      const state: RunCopyState = r.status === 'written' ? 'generated' : r.status;
      line(label, state, lookup, r, r.card ? cardBlockers(r.card) : r.reasons);
    }
  }
  const count = (s: RunCopyState) => lines.filter((l) => l.state === s).length;
  const waiting = lines.filter((l) => l.state !== 'not_arrived' && l.waitingFor.length > 0).length;
  const parts = [
    [count('stored'), 'stored'],
    [count('generated'), 'written new'],
    [count('confirm'), 'with a stored card to confirm'],
    [count('review'), 'for review'],
    [count('needs_approval'), 'waiting for cost approval'],
    [count('failed'), 'that could not be written'],
    [count('not_generated'), 'with no copy yet'],
    [count('not_in_catalog'), 'not in the catalog'],
    [count('not_arrived'), 'that did not arrive, so no card'],
  ]
    .filter(([n]) => (n as number) > 0)
    .map(([n, what]) => `${n} ${what}`);
  return {
    lines,
    spentUsd,
    status: waiting === 0 ? 'done' : 'needs_review',
    message: `Card copy: ${parts.length ? parts.join(', ') : 'no products'}${waiting ? `; ${waiting} waiting for a person` : ''}${spentUsd > 0 ? `, $${spentUsd.toFixed(2)} spent` : ''}.`,
  };
}
