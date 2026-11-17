// Works out where a run stands: each line's match, what arrived, the stock, the price, and what
// still blocks approval. Plain code, no network. It runs after the reading, after every decision,
// before a dry run and again at approval, always against the run's own saved catalog, so a
// decision can never point at an item the manager was not offered.
//
// What to send is decided from a priced line's status, never from its override (FOLLOWUPS).

import type { Db } from '../db/db.ts';
import type { ReadAudit, ReadStatus } from '../invoice/pipeline.ts';
import type { CheckedLine, CheckedReading, CheckId, Notice } from '../invoice/types.ts';
import { itemOf, type CatalogItem, type CatalogNote, type CatalogVariation } from '../matching/catalog.ts';
import { staleMappings } from '../matching/mapping.ts';
import { matchReading, type Candidate, type LineMatch, type SupplierMatch } from '../matching/matcher.ts';
import { vendorForSupplier, type VendorLink } from '../matching/suppliers.ts';
import { basisInputFrom } from '../pricing/basis.ts';
import { VendorFormulaClash, vendorNameClash } from '../pricing/formula.ts';
import type { DecisionChoice, OverrideDecision, OverrideStore } from '../pricing/overrides.ts';
import { priceLine, priceLines, type ConflictPick, type PricedLine, type PriceLineInput } from '../pricing/price.ts';
import { squareItemState } from '../pricing/square-state.ts';
import type { PricingSettings } from '../settings/schema.ts';
import type { RunCatalog } from './catalog-cache.ts';
import { arrivalOf, claimTerms, creditFor, stockFromLine, type Arrival, type Arrived, type ClaimTerms, type Credit, type StockResult } from './inventory.ts';
import type { Decision } from './store.ts';
import { packForLine, withSavedPack } from './packs.ts';
import { lineText, PLAUSIBLE_SCORE, rankByName } from '../matching/similarity.ts';
import { parseRat } from '../pricing/rational.ts';
import type { RunCard } from './card-copy.ts';

/** What is kept of a reading. Pending approvals are kept apart, in their own column. */
export interface StoredReading {
  status: ReadStatus;
  reading: CheckedReading | null;
  reviewReasons: string[];
  notices: Notice[];
  images: Array<{ index: number; name: string }>;
  audit: ReadAudit;
}

/** Failed checks a person may accept after looking at the paper invoice. The rest need a new upload. */
export const ACCEPTABLE_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>(['model_confidence', 'ranges', 'upc_check_digits']);
/** Checks about matching. Each unmatched line is its own blocker instead, cleared by a decision. */
const LINE_CHECKS: ReadonlySet<CheckId> = new Set<CheckId>(['misread_codes', 'known_items']);

export type BlockerId =
  | 'no_reading'
  | 'check_failed'
  | 'check_to_accept'
  | 'supplier_unknown'
  | 'vendor_ambiguous'
  | 'vendor_clash'
  | 'line_unmatched'
  | 'line_new'
  | 'arrival_unclear'
  | 'arrival_to_confirm'
  | 'stock_unknown'
  | 'big_change'
  | 'price_needs_decision'
  | 'price_none'
  | 'price_conflict'
  | 'per_pound_unit'
  | 'code_shared'
  | 'card_copy';

export interface Blocker {
  id: BlockerId;
  line?: number;
  variationId?: string;
  checkId?: CheckId;
  message: string;
}

export type LineOutcome = 'send' | 'nothing_arrived' | 'skipped' | 'not_for_resale' | 'needs_match' | 'new_item';

export interface LineEval {
  n: number;
  line: CheckedLine;
  match: LineMatch;
  outcome: LineOutcome;
  /** The variation this line will update, when it is matched or picked. */
  variationId: string | null;
  itemId: string | null;
  label: string;
  itemName: string;
  scaleCode: string | null;
  /** The item is sold by weight in ShelfReady's terms (a scale code, or the per-pound unit). */
  byWeight: boolean;
  byWeightProblems: string[];
  /** A person picked the item in review, instead of the automatic match. */
  picked: boolean;
  candidates: Candidate[];
  possibleMisread: boolean;
  arrival: Arrival;
  stock: StockResult | null;
  credit: Credit | null;
  priced: PricedLine | null;
  /** A pack value saved with the match and used on this line. */
  savedPack: { unitsPerCase: number | null; poundsPerUnit: string | null; setByName: string } | null;
  /** What the person can enter to make the line price and stock: a case size or a unit weight. */
  packNeed: 'units_per_case' | 'pounds_per_unit' | null;
  /** A price moving more than the limit from today's Square price, which needs its own tick. */
  bigChange: { percent: number; up: boolean; overHalf: boolean; fromCents: number; toCents: number; accepted: boolean } | null;
}

export interface Evaluation {
  readStatus: ReadStatus | '';
  supplier: SupplierMatch | null;
  vendor: VendorLink | null;
  lines: LineEval[];
  blockers: Blocker[];
  failedChecks: Array<{ id: CheckId; message: string; details: string[]; acceptable: boolean; accepted: boolean }>;
  credits: Credit[];
  claim: ClaimTerms | null;
  /** The single per-pound unit in the catalog, or null when there is none or more than one. */
  perPoundUnitId: string | null;
  catalogNotes: CatalogNote[];
  stale: string[];
  vendorClash: string | null;
  /** For each variation that lines disagree on, the different prices they would give, lowest first. */
  conflictPrices: Map<string, number[]>;
  /** Lines whose price moves more than the limit, ticked or not. */
  bigChanges: number;
  /** The limit, in percent, from the server config. */
  bigChangePercent: number;
  /** The cards the run would print, one per product it updates. Filled in by the runner's evaluateRun. */
  cards: RunCard[];
}

export interface EvaluateInput {
  db: Db;
  read: StoredReading | null;
  catalog: RunCatalog;
  decisions: readonly Decision[];
  pricing: PricingSettings;
  overrides: OverrideStore;
  /** A price moving more than this percent needs its own tick (server config, bigChangePercent). */
  bigChangePercent: number;
}

function decisionMap(decisions: readonly Decision[]): Map<string, Decision> {
  return new Map(decisions.map((d) => [`${d.kind}:${d.target}`, d]));
}

/** Offered at the store and not archived. A pick must be one of these. */
export function usableVariation(catalog: RunCatalog, id: string): CatalogVariation | null {
  const v = catalog.index.variationById.get(id);
  if (!v) return null;
  const item = itemOf(catalog.index, v);
  return !item.archived && item.availableHere && v.availableHere ? v : null;
}

function arrivedFrom(d: Decision | undefined): Arrived | null {
  if (!d) return null;
  const a = d.value.arrived;
  if (a === 'all' || a === 'none') return { arrived: a };
  if (a === 'some') {
    const pieces = typeof d.value.pieces === 'string' ? d.value.pieces : undefined;
    const pounds = typeof d.value.pounds === 'string' ? d.value.pounds : undefined;
    return { arrived: 'some', pieces, pounds };
  }
  return null;
}

function overrideDecisions(decisions: readonly Decision[]): OverrideDecision[] {
  const out: OverrideDecision[] = [];
  for (const d of decisions) {
    if (d.kind !== 'override') continue;
    const v = d.value;
    if (typeof v.choice !== 'string' || typeof v.formulaCents !== 'number' || typeof v.overrideCents !== 'number') continue;
    out.push({
      variationId: d.target,
      choice: v.choice as DecisionChoice,
      enteredCents: typeof v.enteredCents === 'number' ? v.enteredCents : null,
      formulaCents: v.formulaCents,
      overrideCents: v.overrideCents,
      decidedBy: d.decidedByName,
    });
  }
  return out;
}

function conflictPicks(decisions: readonly Decision[]): ConflictPick[] {
  const out: ConflictPick[] = [];
  for (const d of decisions) {
    if (d.kind !== 'conflict') continue;
    const v = d.value;
    if (typeof v.priceCents !== 'number' || !Array.isArray(v.shownCents)) continue;
    out.push({ variationId: d.target, priceCents: v.priceCents, shownCents: v.shownCents.filter((x): x is number => typeof x === 'number'), decidedBy: d.decidedByName });
  }
  return out;
}

function lineCandidates(m: LineMatch): { candidates: Candidate[]; misread: boolean } {
  if (m.status === 'candidates') return { candidates: m.candidates, misread: m.possibleMisread };
  if (m.status === 'new_item') return { candidates: [], misread: m.possibleMisread };
  // The automatic match is offered again, so a line marked not for resale or left out can take it.
  if (m.status === 'matched') return { candidates: [m.match], misread: false };
  return { candidates: [], misread: false };
}

const DOLLARS = (c: number): string => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

export function evaluate(input: EvaluateInput): Evaluation {
  const { catalog, db } = input;
  const index = catalog.index;
  const blockers: Blocker[] = [];
  const reading = input.read?.reading ?? null;
  const dmap = decisionMap(input.decisions);
  const perPound = [...index.perPoundUnitIds];
  const perPoundUnitId = perPound.length === 1 ? perPound[0]! : null;
  const vendorClash = vendorNameClash(input.pricing);
  const stale = staleMappings(db, index).map((s) => s.message);

  const base: Evaluation = {
    readStatus: input.read?.status ?? '',
    supplier: null,
    vendor: null,
    lines: [],
    blockers,
    failedChecks: [],
    credits: [],
    claim: null,
    perPoundUnitId,
    catalogNotes: [],
    stale,
    vendorClash,
    conflictPrices: new Map(),
    bigChanges: 0,
    bigChangePercent: input.bigChangePercent,
    cards: [],
  };
  if (!reading) {
    blockers.push({ id: 'no_reading', message: 'There is no reading of this invoice to check. Read it again, or upload a clearer copy.' });
    return base;
  }

  // Failed checks. Matching checks become line blockers below.
  for (const c of reading.failed) {
    if (LINE_CHECKS.has(c.id)) continue;
    const acceptable = ACCEPTABLE_CHECKS.has(c.id);
    const accepted = acceptable && dmap.has(`accept_check:${c.id}`);
    base.failedChecks.push({ id: c.id, message: c.message, details: c.details, acceptable, accepted });
    if (!acceptable) {
      blockers.push({ id: 'check_failed', checkId: c.id, message: `${c.message} Upload the invoice again, or a clearer photo. A person cannot accept this one.` });
    } else if (!accepted) {
      blockers.push({ id: 'check_to_accept', checkId: c.id, message: `${c.message} Check it against the paper invoice, then accept it.` });
    }
  }

  const match = matchReading({ db, index }, reading);
  base.supplier = match.supplier;
  if (match.supplier.status === 'unknown') {
    blockers.push({ id: 'supplier_unknown', message: `The supplier "${match.supplier.printedName}" is new to ShelfReady. Join it to a supplier you know, or add it as a new one.` });
  }
  let vendor: string | null = null;
  let vendorBlocked = false;
  if (match.supplier.status === 'known') {
    const link = vendorForSupplier(match.supplier.supplier, input.pricing.vendors.map((v) => v.vendor));
    base.vendor = link;
    if (link.status === 'one') vendor = link.vendor;
    if (link.status === 'ambiguous') {
      vendorBlocked = true;
      blockers.push({ id: 'vendor_ambiguous', message: `${link.problem} Nothing is sent for this supplier until an admin fixes settings.` });
    }
  }

  // Lines.
  const lines: LineEval[] = [];
  const supplierId = match.supplier.status === 'known' ? match.supplier.supplier.id : null;
  for (const printedLine of reading.lines) {
    const m = match.lines.find((x) => x.n === printedLine.n)!;
    const pick = dmap.get(`pick:${printedLine.n}`);
    const pickedVar = pick && typeof pick.value.variationId === 'string' ? usableVariation(catalog, pick.value.variationId) : null;
    const lineVariation = pickedVar?.id ?? (m.status === 'matched' ? m.match.variationId : null);
    // A case size or unit weight saved with the match fills in what the invoice left out, but
    // only while the line points at the item it was given for.
    const found = supplierId !== null ? packForLine(db, supplierId, printedLine.line) : null;
    const saved = found && found.variationId === lineVariation ? found : null;
    const cl = withSavedPack(printedLine, saved);
    const ppuText = saved?.poundsPerUnit ?? null;
    const ppu = ppuText ? parseRat(ppuText) : null;
    const { candidates, misread } = lineCandidates(m);
    const arrival = arrivalOf(cl, arrivedFrom(dmap.get(`received:${cl.n}`)));
    const le: LineEval = {
      n: cl.n,
      line: cl,
      match: m,
      outcome: 'send',
      variationId: null,
      itemId: null,
      label: '',
      itemName: '',
      scaleCode: null,
      byWeight: false,
      byWeightProblems: [],
      picked: false,
      candidates,
      possibleMisread: misread,
      arrival,
      stock: null,
      credit: null,
      priced: null,
      savedPack: saved ? { unitsPerCase: saved.unitsPerCase, poundsPerUnit: saved.poundsPerUnit, setByName: saved.setByName } : null,
      packNeed: null,
      bigChange: null,
    };
    lines.push(le);
    // The credit is worked out in the unit the line is sold in, once the item is known.
    const settleCredit = (byWeight: boolean) => {
      le.credit = creditFor(cl, arrival, byWeight, ppu);
      if (le.credit) base.credits.push(le.credit);
    };
    if (arrival.toConfirm) {
      blockers.push({
        id: 'arrival_to_confirm',
        line: cl.n,
        message: `Line ${cl.n}: ${cl.flags[0] ?? 'a note on the line says what arrived.'} Confirm what arrived: all, none or some.`,
      });
    } else if (arrival.arrived === 'unclear') {
      blockers.push({ id: 'arrival_unclear', line: cl.n, message: `Line ${cl.n}: it is not clear what arrived. Say all, none or some.` });
    }

    const lineByWeight = cl.basis === 'weight' || cl.pack.pricePer === 'lb';
    if (dmap.has(`skip_line:${cl.n}`)) {
      le.outcome = 'skipped';
      settleCredit(lineByWeight);
      continue;
    }
    if (dmap.has(`not_for_resale:${cl.n}`) || (!pickedVar && m.status === 'not_for_resale')) {
      le.outcome = 'not_for_resale';
      // Offer likely items by name, so a wrong mark can be replaced by a pick.
      if (le.candidates.length === 0) {
        le.candidates = rankByName(index, lineText({ ...cl.line, pack: cl.pack }), { limit: 5, minScore: PLAUSIBLE_SCORE })
          .filter((x) => usableVariation(catalog, x.variation.id))
          .map((x) => ({ variationId: x.variation.id, itemId: x.item.id, label: x.variation.label, method: 'name' as const, score: x.score, reasons: x.reasons }));
      }
      settleCredit(lineByWeight);
      continue;
    }
    let v: CatalogVariation | null = pickedVar;
    if (v) le.picked = true;
    else if (m.status === 'matched') v = index.variationById.get(m.match.variationId) ?? null;
    if (!v) {
      settleCredit(lineByWeight);
      le.outcome = m.status === 'new_item' ? 'new_item' : 'needs_match';
      if (le.outcome === 'new_item') {
        blockers.push({
          id: 'line_new',
          line: cl.n,
          message: `Line ${cl.n}: no Square item looks like it${misread ? ', and its code may be misread' : ''}. Pick the item, mark it not for resale, or leave it out of this run. New items are added to Square by hand.`,
        });
      } else {
        blockers.push({ id: 'line_unmatched', line: cl.n, message: `Line ${cl.n}: pick the Square item${misread ? ' (its code may be misread, so check the paper)' : ''}, mark it not for resale, or leave it out of this run.` });
      }
      continue;
    }
    const item: CatalogItem = itemOf(index, v);
    le.variationId = v.id;
    le.itemId = item.id;
    le.label = v.label;
    le.itemName = item.name;
    le.scaleCode = item.scaleCode;
    le.byWeight = item.scaleCode !== null || v.perPound;
    le.byWeightProblems = item.byWeight.required && !item.byWeight.ok ? item.byWeight.problems : [];
    settleCredit(le.byWeight);
    if (!le.byWeight && cl.pack.pricePer === 'case' && (cl.pack.unitsPerCase === null || !cl.pack.sure)) le.packNeed = 'units_per_case';
    if (!le.byWeight && cl.pack.pricePer === 'lb' && ppu === null) le.packNeed = 'pounds_per_unit';
    if (saved?.unitsPerCase && !le.byWeight && cl.pack.pricePer === 'case') le.packNeed = 'units_per_case';
    if (saved?.poundsPerUnit && !le.byWeight && cl.pack.pricePer === 'lb') le.packNeed = 'pounds_per_unit';
    // Nothing arrived: today's price stays, and Square, the scales and the cards are left alone.
    if (arrival.arrived === 'none') {
      le.outcome = 'nothing_arrived';
      continue;
    }
    le.stock = arrival.arrived === 'unclear' ? null : stockFromLine(cl, le.byWeight, arrival, ppu);
    if (le.stock && !le.stock.ok) {
      const fix =
        le.packNeed === 'units_per_case'
          ? 'Enter the units per case below, or leave the line out of this run.'
          : le.packNeed === 'pounds_per_unit'
            ? 'Enter the weight of one unit below, or leave the line out of this run.'
            : arrival.arrived === 'some'
              ? ''
              : le.byWeight
                ? 'Enter the pounds that arrived, or leave the line out of this run.'
                : 'Leave the line out of this run, or check the invoice.';
      blockers.push({ id: 'stock_unknown', line: cl.n, message: `Line ${cl.n}: ${le.stock.problem} ${fix}`.trim() });
    }
    if (item.scaleCode && (index.byScaleCode.get(item.scaleCode)?.length ?? 0) > 1) {
      blockers.push({ id: 'code_shared', line: cl.n, message: `Line ${cl.n}: scale code ${item.scaleCode} ends more than one Square item name, so the scale price would be ambiguous. Fix the names in Square, or leave the line out.` });
    }
  }
  base.lines = lines;

  // Pricing, for lines that will be sent.
  const toPrice = lines.filter((l) => l.outcome === 'send' && l.variationId !== null);
  const inputs: PriceLineInput[] = toPrice.map((l) => {
    const raw = catalog.raw.get(l.variationId!);
    const v = index.variationById.get(l.variationId!)!;
    // The raw objects decide location pricing exactly as pricing reads it. A variation stored
    // apart from its item has no raw copy here, so its indexed values are used instead.
    const square = raw
      ? squareItemState(raw.item, raw.variation, index.locationId, index.perPoundUnitIds, l.scaleCode)
      : { variationId: v.id, priceCents: v.pricing === 'variable' ? null : v.priceCents, pricingType: v.pricing === 'variable' ? ('VARIABLE_PRICING' as const) : ('FIXED_PRICING' as const), perPound: v.perPound, scaleCode: l.scaleCode };
    return { n: l.n, basis: basisInputFrom(l.line, l.savedPack?.poundsPerUnit ?? undefined), square, vendor };
  });
  let priced: PricedLine[] = [];
  try {
    // An ambiguous vendor formula sends nothing for the supplier, so nothing is priced either.
    if (!vendorBlocked) priced = priceLines(inputs, { settings: input.pricing, overrides: input.overrides, decisions: overrideDecisions(input.decisions), conflictPicks: conflictPicks(input.decisions) });
  } catch (err) {
    if (!(err instanceof VendorFormulaClash)) throw err;
    vendorBlocked = true;
    blockers.push({ id: 'vendor_clash', message: `${err.message} Nothing is sent for this supplier until an admin fixes settings.` });
  }
  // The prices each line would give on its own, so a conflict pick is checked against exactly
  // the prices the manager was shown.
  if (!vendorBlocked && priced.some((p) => p.status === 'conflict' || p.flags.some((f) => f.id === 'conflict'))) {
    const ctx = { settings: input.pricing, overrides: input.overrides, decisions: overrideDecisions(input.decisions) };
    const byVar = new Map<string, Set<number>>();
    for (const i of inputs) {
      const one = priceLine(i, ctx);
      const c = one.newCents ?? (one.status === 'needs_decision' ? one.formulaCents : null);
      if (one.variationId && c !== null) byVar.set(one.variationId, new Set([...(byVar.get(one.variationId) ?? []), c]));
    }
    for (const [v, set] of byVar) if (set.size > 1) base.conflictPrices.set(v, [...set].sort((a, b) => a - b));
  }
  for (const p of priced) {
    const le = lines.find((l) => l.n === p.n)!;
    le.priced = p;
    if (vendorBlocked) continue;
    if (p.status === 'needs_decision') blockers.push({ id: 'price_needs_decision', line: p.n, variationId: p.variationId ?? undefined, message: `Line ${p.n}: ${p.flags.find((f) => f.id === 'needs_decision')?.message ?? 'pick a price.'}` });
    else if (p.status === 'no_price') blockers.push({ id: 'price_none', line: p.n, message: `Line ${p.n}: no price could be worked out. ${p.reason ?? ''} Leave the line out, or check the invoice.`.trim() });
    else if (p.status === 'conflict') {
      const shown = (p.variationId && base.conflictPrices.get(p.variationId)) || [];
      blockers.push({
        id: 'price_conflict',
        line: p.n,
        variationId: p.variationId ?? undefined,
        message: `Line ${p.n}: another line is the same Square item at a different price${shown.length ? ` (${shown.map(DOLLARS).join(', ')})` : ''}. Pick one price.`,
      });
    }
    if (p.switchToWeight && perPoundUnitId === null) {
      blockers.push({
        id: 'per_pound_unit',
        line: p.n,
        message: `Line ${p.n}: this item must be switched to sold by weight, but the catalog has ${perPound.length === 0 ? 'no' : 'more than one'} per-pound unit. Fix that in Square first.`,
      });
    }
  }

  // Big price moves need their own tick, tied to the two prices shown (DECISIONS.md, November 7).
  for (const le of lines) {
    const p = le.priced;
    if (vendorBlocked || !p || p.status !== 'priced' || p.newCents === null || p.squareCents === null || p.squareCents <= 0) continue;
    const diff = p.newCents - p.squareCents;
    if (Math.abs(diff) * 100 <= p.squareCents * input.bigChangePercent) continue;
    const tick = le.variationId ? dmap.get(`accept_big_change:${le.variationId}`) : undefined;
    const accepted = tick !== undefined && tick.value.fromCents === p.squareCents && tick.value.toCents === p.newCents;
    // Rounded up, so a 30.4 percent move never reads 30% beside "more than 30%".
    le.bigChange = { percent: Math.ceil((Math.abs(diff) * 100) / p.squareCents), up: diff > 0, overHalf: diff * 2 > p.squareCents, fromCents: p.squareCents, toCents: p.newCents, accepted };
    base.bigChanges++;
    if (!accepted) {
      blockers.push({
        id: 'big_change',
        line: le.n,
        variationId: le.variationId ?? undefined,
        message: `Line ${le.n}: the price goes ${diff > 0 ? 'up' : 'down'} ${le.bigChange.percent}%, from ${DOLLARS(p.squareCents)} to ${DOLLARS(p.newCents)}. Tick it to confirm.`,
      });
    }
  }

  const ids = new Set(lines.map((l) => l.itemId).filter(Boolean));
  base.catalogNotes = index.notes.filter((n) => n.itemIds.some((id) => ids.has(id)));
  base.claim = claimTerms(reading.invoice);
  // One blocker per line and kind is enough.
  const seen = new Set<string>();
  base.blockers = blockers.filter((b) => {
    const k = `${b.id}:${b.line ?? ''}:${b.checkId ?? ''}:${b.variationId ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return base;
}
