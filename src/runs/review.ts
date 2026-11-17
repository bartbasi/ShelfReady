// View models for the run pages: everything the screens need, as plain data and plain words.
// No markup here, so the frontend engineer can restyle the pages without touching this.
// Every string from the model, the invoice or a file name is data: the templates escape it.

import type { Db } from '../db/db.ts';
import type { Attempt } from '../invoice/pipeline.ts';
import type { PricedLine } from '../pricing/price.ts';
import type { RunCatalog } from './catalog-cache.ts';
import type { Evaluation, LineEval, StoredReading } from './evaluate.ts';
import type { ChangePreview } from './preview.ts';
import { DECIDING, STATE_LABELS, type RunState } from './states.ts';
import { activeJob, runCorrections, runDecisions, runEvents, runFiles, runsWithSameFiles, type Correction, type Decision, type RunRow } from './store.ts';
import { renamedItem } from './preview.ts';
import { toDecimalText } from '../pricing/rational.ts';
import { copyApprovalBatch, runCopyConfig, type CardSuggestionView, type CopyBudget, type RunCard } from './card-copy.ts';

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

function when(ms: number | null): string {
  return ms === null ? '' : new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export interface RunHeader {
  id: number;
  state: RunState;
  stateLabel: string;
  createdByName: string;
  createdAt: string;
  message: string;
  /** Work is queued or running: the page refreshes itself. */
  working: boolean;
  canDecide: boolean;
  canReadAgain: boolean;
  canStop: boolean;
}

export function runHeader(db: Db, run: RunRow): RunHeader {
  const working = activeJob(db, run.id) !== null;
  return {
    id: run.id,
    state: run.state,
    stateLabel: working && run.state !== 'reading' ? (run.state === 'ready' || run.state === 'dry_run_done' ? 'Making the dry run' : 'Working') : STATE_LABELS[run.state],
    createdByName: run.createdByName,
    createdAt: when(run.createdAt),
    message: run.message,
    working,
    canDecide: DECIDING.has(run.state) && !working,
    canReadAgain: !working && (run.state === 'retry' || (run.state === 'review' && (run.readStatus === 'review' || run.readStatus === ''))),
    canStop: !working && !['approved', 'sending', 'done', 'partial', 'failed'].includes(run.state),
  };
}

export interface FileView {
  id: number;
  position: number;
  name: string;
  kind: string;
  bytes: number;
  /** Photos a browser can show inline. HEIF and PDF download instead. */
  inline: boolean;
}

export function filesView(db: Db, runId: number): FileView[] {
  return runFiles(db, runId).map((f) => ({ id: f.id, position: f.position, name: f.originalName, kind: f.kind, bytes: f.bytes, inline: f.kind === 'jpeg' || f.kind === 'png' || f.kind === 'webp' }));
}

export interface ProgressView {
  header: RunHeader;
  files: FileView[];
  events: Array<{ at: string; stage: string; message: string }>;
  pendingCost: { model: string; estimateUsd: string; message: string } | null;
}

export function progressView(db: Db, run: RunRow): ProgressView {
  const p = run.pendingApproval as { message?: unknown } | null;
  return {
    header: runHeader(db, run),
    files: filesView(db, run.id),
    events: runEvents(db, run.id).map((e) => ({ at: when(e.at), stage: e.stage, message: e.message })),
    pendingCost:
      run.state === 'needs_approval' && p
        ? { model: run.approvalModel, estimateUsd: run.approvalEstimateUsd, message: typeof p.message === 'string' ? p.message : 'An admin must approve the cost first.' }
        : null,
  };
}

export interface CandidateView {
  variationId: string;
  label: string;
  scorePercent: number;
  method: string;
  reasons: string[];
}

export interface LineView {
  n: number;
  anchor: string;
  printed: {
    itemNumber: string;
    upc: string;
    description: string;
    brand: string;
    pack: string;
    qtyShipped: string;
    unit: string;
    weight: string;
    unitPrice: string;
    allowance: string;
    extension: string;
  };
  flags: string[];
  outcome: LineEval['outcome'];
  outcomeLabel: string;
  match: { label: string; how: string; reasons: string[]; picked: boolean } | null;
  candidates: CandidateView[];
  possibleMisread: boolean;
  warnings: string[];
  byWeightProblems: string[];
  /** What arrived. askPounds: the line is counted in pounds (by weight), otherwise in pieces. */
  arrival: { arrived: string; source: string; toConfirm: boolean; pieces: string | null; pounds: string | null; askPounds: boolean };
  /** A case size or unit weight the person can give, and any saved one in use. */
  pack: { need: 'units_per_case' | 'pounds_per_unit'; saved: string | null } | null;
  /** A price moving more than the limit. */
  bigChange: { variationId: string; percent: number; up: boolean; overHalf: boolean; accepted: boolean; fromCents: number; toCents: number; text: string } | null;
  stock: { text: string; unit: string; how: string } | { problem: string } | null;
  price: PriceView | null;
  overrideQuestion: { variationId: string; formula: string; override: string; formulaCents: number; overrideCents: number; choice: string | null } | null;
  conflict: { variationId: string; prices: Array<{ cents: number; text: string }>; picked: number | null } | null;
  rename: { itemId: string; current: string; edited: string | null; next: string | null; scaleCode: string | null } | null;
  /** The line's card, shown in the Cards section. Null when the line makes no card. */
  card: { anchor: string; status: string } | null;
  skipped: boolean;
  notForResale: boolean;
}

export interface PriceView {
  status: PricedLine['status'];
  old: string;
  next: string;
  change: string;
  formula: string;
  formulaPrice: string;
  costHow: string;
  override: string;
  flags: string[];
  switchToWeight: boolean;
  reason: string | null;
}

const OUTCOME_LABELS: Record<LineEval['outcome'], string> = {
  send: 'Will update Square',
  nothing_arrived: 'Nothing arrived: no change',
  skipped: 'Left out of this run',
  not_for_resale: 'Not for resale',
  needs_match: 'Pick the Square item',
  new_item: 'New item: not in Square',
};

const METHOD_LABELS: Record<string, string> = {
  saved_mapping: 'saved match',
  exact_upc: 'UPC',
  upc_item_number: 'item number inside the UPC',
  scale_code: 'scale code',
  name: 'name',
};

function priceView(p: PricedLine): PriceView {
  const o = p.override;
  const override =
    o.kind === 'override'
      ? `Override ${money(o.overrideCents)} (formula ${money(o.formulaCents)})`
      : o.kind === 'needs_decision'
        ? `Override ${money(o.overrideCents)}, formula now ${money(o.formulaCents)}`
        : o.kind === 'decided'
          ? `Decided: ${o.choice.replace(/_/g, ' ')} (override ${money(o.overrideCents)}, formula ${money(o.formulaCents)})`
          : o.kind === 'unchecked'
            ? `Override ${money(o.overrideCents)}, not checked`
            : '';
  return {
    status: p.status,
    old: p.squareCents === null ? 'none' : money(p.squareCents),
    next: p.newCents === null ? 'not sent' : money(p.newCents),
    change: p.changeCents === null ? '' : `${p.changeCents >= 0 ? '+' : ''}${money(p.changeCents)}`,
    formula: p.formula.text + (p.formula.vendor ? ` (${p.formula.vendor})` : ''),
    formulaPrice: money(p.formulaCents),
    costHow: p.cost.ok ? `${p.cost.how} Cost ${p.cost.costText} per ${p.cost.per === 'lb' ? 'pound' : 'unit'}.` : '',
    override,
    flags: p.flags.map((f) => f.message),
    switchToWeight: p.switchToWeight,
    reason: p.reason,
  };
}

function lineView(l: LineEval, ev: Evaluation, decisions: readonly Decision[], canSend: boolean, cardAnchors: ReadonlyMap<string, { anchor: string; status: string }>): LineView {
  const d = (kind: string, target: string) => decisions.find((x) => x.kind === kind && x.target === target);
  const p = l.line.line;
  const m = l.match;
  const matchView =
    l.variationId !== null
      ? {
          label: l.label,
          how: l.picked ? 'picked in review' : m.status === 'matched' ? METHOD_LABELS[m.method] ?? m.method : '',
          reasons: l.picked ? [] : m.reasons,
          picked: l.picked,
        }
      : null;
  const o = l.priced?.override;
  const overrideQuestion =
    l.priced && o && (o.kind === 'needs_decision' || o.kind === 'decided') && l.variationId
      ? {
          variationId: l.variationId,
          formula: money(o.formulaCents),
          override: money(o.overrideCents),
          formulaCents: o.formulaCents,
          overrideCents: o.overrideCents,
          choice: o.kind === 'decided' ? o.choice : null,
        }
      : null;
  const conflictPrices = l.variationId ? ev.conflictPrices.get(l.variationId) : undefined;
  const picked = l.variationId ? d('conflict', l.variationId) : undefined;
  const renameD = l.itemId ? d('rename', l.itemId) : undefined;
  const edited = renameD && typeof renameD.value.name === 'string' ? renameD.value.name : null;
  const askPounds = l.variationId !== null ? l.byWeight : l.line.basis === 'weight' || l.line.pack.pricePer === 'lb';
  const ratText = (r: { n: bigint; d: bigint } | null) => (r ? toDecimalText(r, 3).text : null);
  const b = l.bigChange;
  return {
    n: l.n,
    anchor: `line-${l.n}`,
    printed: {
      itemNumber: p.item_number,
      upc: p.upc,
      description: p.description,
      brand: p.brand,
      pack: p.pack_size,
      qtyShipped: p.qty_shipped,
      unit: p.unit,
      weight: p.weight,
      unitPrice: p.unit_price,
      allowance: p.allowance,
      extension: p.extension,
    },
    flags: l.line.flags,
    outcome: l.outcome,
    outcomeLabel: OUTCOME_LABELS[l.outcome],
    match: matchView,
    candidates: l.candidates.map((c) => ({ variationId: c.variationId, label: c.label, scorePercent: Math.round(c.score * 100), method: METHOD_LABELS[c.method] ?? c.method, reasons: c.reasons })),
    possibleMisread: l.possibleMisread,
    warnings: m.warnings,
    byWeightProblems: l.byWeightProblems,
    arrival: {
      arrived: l.arrival.arrived,
      source: l.arrival.source,
      toConfirm: l.arrival.toConfirm,
      pieces: ratText(l.arrival.pieces),
      pounds: ratText(l.arrival.pounds),
      askPounds,
    },
    pack: l.packNeed
      ? {
          need: l.packNeed,
          saved: l.savedPack
            ? l.savedPack.unitsPerCase !== null
              ? `Case size from saved match: ${l.savedPack.unitsPerCase} units (set by ${l.savedPack.setByName}).`
              : `Unit weight from saved match: ${l.savedPack.poundsPerUnit} lb (set by ${l.savedPack.setByName}).`
            : null,
        }
      : null,
    bigChange:
      b && l.variationId
        ? {
            variationId: l.variationId,
            percent: b.percent,
            up: b.up,
            overHalf: b.overHalf,
            accepted: b.accepted,
            fromCents: b.fromCents,
            toCents: b.toCents,
            text: `Price goes ${b.up ? 'up' : 'down'} ${b.percent}%, from ${money(b.fromCents)} to ${money(b.toCents)}.${b.overHalf ? ' Over 50%: the scales will ask too.' : ''}`,
          }
        : null,
    stock: l.stock ? (l.stock.ok ? { text: l.stock.text, unit: l.stock.unit === 'lb' ? 'lb' : 'units', how: l.stock.how } : { problem: l.stock.problem }) : null,
    price: l.priced ? priceView(l.priced) : null,
    overrideQuestion,
    conflict: conflictPrices && l.variationId ? { variationId: l.variationId, prices: conflictPrices.map((c) => ({ cents: c, text: money(c) })), picked: typeof picked?.value.priceCents === 'number' ? picked.value.priceCents : null } : null,
    rename:
      canSend && l.outcome === 'send' && l.itemId
        ? { itemId: l.itemId, current: l.itemName, edited, next: edited ? renamedItem(l.itemName, l.scaleCode, edited) : null, scaleCode: l.scaleCode }
        : null,
    card: l.outcome === 'send' && l.variationId ? (cardAnchors.get(l.variationId) ?? null) : null,
    skipped: l.outcome === 'skipped',
    notForResale: l.outcome === 'not_for_resale',
  };
}

export interface ReviewView extends ProgressView {
  catalog: { label: string; takenAt: string };
  reading: {
    status: string;
    model: string;
    cost: string;
    reasons: string[];
    notices: string[];
    checks: Array<{ id: string; passed: boolean; blocking: boolean; message: string; details: string[] }>;
    failedChecks: Evaluation['failedChecks'];
    supplierPrinted: string;
    invoiceNumber: string;
    invoiceDate: string;
    total: string;
    attempts: Array<{ role: string; model: string; outcome: string; cost: string }>;
  } | null;
  supplier: { status: 'known'; name: string; vendor: string } | { status: 'unknown'; printed: string; suggestions: Array<{ id: number; name: string }> } | null;
  lines: LineView[];
  credits: Array<{ n: number; amount: string; reason: string }>;
  creditTotal: string;
  claim: { text: string; deadline: string | null } | null;
  catalogNotes: string[];
  stale: string[];
  vendorClash: string | null;
  blockers: Array<{ message: string; anchor: string | null }>;
  /** One card per product the run updates. Lines where nothing arrived make none. */
  cards: CardView[];
  cardsSummary: { total: number; prints: number; waiting: number; leftOut: number; canWrite: number; spent: string; budget: string };
  /** Every card waiting for a cost approval, approved together by an admin. */
  copyApproval: { model: string; totalUsd: string; fingerprint: string; count: number; why: string } | null;
  decisionsCount: number;
  /** Every decision on this run, each with an undo. */
  decisions: Array<{ kind: string; target: string; label: string; by: string; undoNote: string }>;
  /** Lines whose price moves more than the limit (percent, from the config), and how many still need their tick. */
  bigChanges: { total: number; toTick: number; percent: number };
  /** Other runs, not stopped, that hold the same files. */
  sameFiles: number[];
  dryRun: { at: string; hash: string } | null;
}

const DECISION_LABELS: Record<string, string> = {
  skip_line: 'Left out',
  pick: 'Picked',
  not_for_resale: 'Not for resale',
  received: 'What arrived',
  override: 'Override answer',
  conflict: 'Price picked',
  rename: 'New name',
  description: 'Card description',
  accept_check: 'Check accepted',
  accept_big_change: 'Big price change confirmed',
  card_skip: 'Card left out',
};

function decisionLabel(d: Decision): string {
  const v = d.value;
  const target = /^[0-9]+$/.test(d.target) ? `line ${d.target}` : d.target;
  const what =
    d.kind === 'pick'
      ? `${target}: ${String(v.label ?? v.variationId ?? '')}`
      : d.kind === 'received'
        ? `${target}: ${String(v.arrived)}${v.pieces ? ` (${String(v.pieces)} pieces)` : ''}${v.pounds ? ` (${String(v.pounds)} lb)` : ''}`
        : d.kind === 'rename'
          ? `${String(v.from ?? '')} becomes ${String(v.to ?? '')}`
          : d.kind === 'accept_check'
            ? String(v.message ?? d.target)
            : d.kind === 'accept_big_change'
              ? `${String(v.percent ?? '')}% on ${target}`
              : d.kind === 'card_skip'
                ? String(v.label ?? target)
                : target;
  return `${DECISION_LABELS[d.kind] ?? d.kind}: ${what}`;
}

export function reviewView(db: Db, run: RunRow, ev: Evaluation | null, catalog: RunCatalog | null, catalogLabel: string, budget: CopyBudget | null = null): ReviewView {
  const progress = progressView(db, run);
  const read = run.readResult as StoredReading | null;
  const decisions = runDecisions(db, run.id);
  const reading = read?.reading ?? null;
  const attempts = (read?.audit?.attempts ?? []) as unknown as Array<Pick<Attempt, 'role' | 'model' | 'outcome'> & { costUsd: number }>;
  const supplier = ev?.supplier ?? null;
  const vendorText = ev?.vendor?.status === 'one' ? `Vendor formula: ${ev.vendor.vendor}` : ev?.vendor?.status === 'ambiguous' ? ev.vendor.problem : 'Default formula';
  const credits = (ev?.credits ?? []).map((c) => ({ n: c.n, amount: c.cents === null ? 'to work out' : money(c.cents), reason: c.reason }));
  const total = (ev?.credits ?? []).reduce((s, c) => s + (c.cents ?? 0), 0);
  const cards = (ev?.cards ?? []).map((c, i) => cardView(c, i));
  const anchors = new Map(cards.map((c) => [c.variationId, { anchor: c.anchor, status: c.status }]));
  return {
    ...progress,
    catalog: { label: catalogLabel, takenAt: catalog?.snapshot.takenAt ?? '' },
    reading: read
      ? {
          status: read.status,
          model: read.audit?.finalModel ?? '',
          cost: `$${(read.audit?.totalCostUsd ?? 0).toFixed(2)}`,
          reasons: read.reviewReasons,
          notices: [...read.notices, ...(reading?.notices ?? [])].map((x) => x.message),
          checks: (reading?.checks ?? []).map((c) => ({ id: c.id, passed: c.passed, blocking: c.blocking, message: c.message, details: c.details })),
          failedChecks: ev?.failedChecks ?? [],
          supplierPrinted: reading?.invoice.supplier_name ?? '',
          invoiceNumber: reading?.invoice.invoice_number ?? '',
          invoiceDate: reading?.invoice.invoice_date ?? '',
          total: reading?.invoice.total ?? '',
          attempts: attempts.map((a) => ({ role: a.role === 'first_pass' ? 'First reading' : 'Second reading', model: a.model, outcome: a.outcome, cost: `$${(a.costUsd ?? 0).toFixed(2)}` })),
        }
      : null,
    supplier:
      supplier === null
        ? null
        : supplier.status === 'known'
          ? { status: 'known', name: supplier.supplier.name, vendor: vendorText }
          : { status: 'unknown', printed: supplier.printedName, suggestions: supplier.suggestions.map((s) => ({ id: s.id, name: s.name })) },
    lines: (ev?.lines ?? []).map((l) => lineView(l, ev!, decisions, progress.header.canDecide, anchors)),
    credits,
    creditTotal: money(total),
    claim: ev?.claim ?? null,
    catalogNotes: (ev?.catalogNotes ?? []).map((n) => n.message),
    stale: ev?.stale ?? [],
    vendorClash: ev?.vendorClash ?? null,
    blockers: (ev?.blockers ?? []).map((b) => ({ message: b.message, anchor: b.id === 'card_copy' && b.variationId ? (anchors.get(b.variationId)?.anchor ?? null) : b.line ? `line-${b.line}` : null })),
    cards,
    cardsSummary: {
      total: cards.length,
      prints: cards.filter((c) => !c.leftOut && c.waitingFor.length === 0).length,
      waiting: cards.filter((c) => !c.leftOut && c.waitingFor.length > 0).length,
      leftOut: cards.filter((c) => c.leftOut).length,
      canWrite: cards.filter((c) => c.canWrite && !c.leftOut).length,
      spent: `$${(budget?.spentUsd ?? 0).toFixed(2)}`,
      budget: budget ? budget.text : '',
    },
    copyApproval: (() => {
      const b = copyApprovalBatch(ev?.cards ?? []);
      if (!b) return null;
      const why = budget?.binding === 'daily' ? 'The daily limit for readings and card copy is what ran out.' : "This invoice's card copy budget is what ran out.";
      return { model: b.model, totalUsd: b.totalUsd, fingerprint: b.fingerprint, count: b.cards.length, why };
    })(),
    decisionsCount: decisions.length,
    decisions: decisions.map((d) => ({
      kind: d.kind,
      target: d.target,
      label: decisionLabel(d),
      by: d.decidedByName,
      undoNote:
        d.kind === 'pick' || d.kind === 'not_for_resale'
          ? d.value.previous
            ? 'Undo also puts back the saved match this supplier item had before.'
            : 'Undo also forgets the saved match for this supplier item.'
          : '',
    })),
    bigChanges: { percent: ev?.bigChangePercent ?? 0, total: ev?.bigChanges ?? 0, toTick: (ev?.lines ?? []).filter((l) => l.bigChange && !l.bigChange.accepted).length },
    sameFiles: runsWithSameFiles(db, run.id, run.createdAt - 30 * 24 * 3600_000),
    dryRun: run.dryRunAt ? { at: when(run.dryRunAt), hash: run.dryRunHash } : null,
  };
}

export interface DryRunView {
  header: RunHeader;
  preview: ChangePreview;
  square: Array<{
    label: string;
    lines: string;
    changes: string[];
    bigChange: string | null;
    lineStock: Array<{ n: number; stock: string }>;
  }>;
  /** Items whose price moves more than the limit, and the limit in percent. */
  bigChanges: number;
  bigChangePercent: number;
  /** After approval: lines marked as not arrived, waiting for step 7 to take the stock back out. */
  corrections: Array<Correction & { credit: string }>;
  scales: { names: string[]; rows: Array<{ code: string; item: string; price: string; scales: string }> };
  /** Exactly the cards that would print, with their final text. */
  cards: Array<{ title: string; source: string; version: number; printed: PrintedCardView }>;
  cardsLeftOut: Array<{ title: string; why: string }>;
  credits: Array<{ n: number; amount: string; reason: string }>;
  claim: { text: string; deadline: string | null } | null;
  leftOut: Array<{ n: number; why: string }>;
  approval: { allowed: boolean; problems: string[]; approvedBy: string; approvedAt: string };
}

export function dryRunView(db: Db, run: RunRow, problems: string[]): DryRunView | null {
  const p = run.dryRun as ChangePreview | null;
  if (!p) return null;
  return {
    header: runHeader(db, run),
    preview: p,
    square: p.square.map((s) => {
      const changes: string[] = [];
      if (s.rename) changes.push(`Name: ${s.rename.from} becomes ${s.rename.to}`);
      if (s.switchToWeight) changes.push(`Switch to sold by weight: now ${s.switchToWeight.now}. Becomes a fixed price per pound with the per-pound unit${s.switchToWeight.locationOverride ? ', at this store too' : ''}.`);
      if (s.price) changes.push(`Price: ${s.price.fromCents === null ? 'none' : money(s.price.fromCents)} becomes ${money(s.price.toCents)}${s.price.perPound ? ' per pound' : ''}`);
      if (s.tracking.turnOn) changes.push('Stock tracking: turned on first, so the count sticks');
      if (s.stock) changes.push(`Stock: ${s.stock.from ?? 'no count'} becomes ${s.stock.to} ${s.stock.unit === 'lb' ? 'lb' : 'units'} (the invoice figure)`);
      if (s.overrideAction === 'remove') changes.push('Price override: removed');
      if (s.overrideAction === 'set') changes.push('Price override: set to the price above');
      if (s.price?.locationOverride) changes.push('The store has its own price for this item: it is changed too');
      if (changes.length === 0) changes.push('No change');
      const bigChange = s.bigChange ? `Price goes ${s.bigChange.up ? 'up' : 'down'} ${s.bigChange.percent}%. Confirmed in review.${s.bigChange.overHalf ? ' Over 50%: the scales will ask too.' : ''}` : null;
      return { label: s.label, lines: s.lines.join(', '), changes, bigChange, lineStock: s.lineStock ?? [] };
    }),
    bigChanges: p.square.filter((s) => s.bigChange).length,
    bigChangePercent: p.bigChangePercent,
    corrections: runCorrections(db, run.id).map((c) => ({ ...c, credit: money(c.creditCents) })),
    scales: {
      names: p.scales.names,
      rows: p.scales.changes.map((c) => ({ code: c.code, item: c.itemName, price: `${money(c.priceCents)} per pound`, scales: c.scales.length ? c.scales.join(', ') : 'no scales listed in the config' })),
    },
    cards: (p.cards.cards ?? []).map((c) => ({ title: c.title, source: SOURCE_LABELS[c.source], version: c.version, printed: printedView(c.record) })),
    cardsLeftOut: (p.cards.leftOut ?? []).map((c) => ({ title: c.title, why: c.why })),
    credits: p.credits.map((c) => ({ n: c.n, amount: c.cents === null ? 'to work out' : money(c.cents), reason: c.reason })),
    claim: p.claim,
    leftOut: p.leftOut,
    approval: { allowed: problems.length === 0, problems, approvedBy: run.approvedByName, approvedAt: when(run.approvedAt) },
  };
}

// ---- Cards ----

export interface PrintedCardView {
  eyebrow: string;
  origin: string;
  n1: string;
  n2: string;
  producer: string;
  specs: Array<{ label: string; value: string }>;
  copy: string[];
  price: string;
  unit: string;
  code: string;
}

export interface CardView {
  anchor: string;
  variationId: string;
  label: string;
  lines: number[];
  leftOut: boolean;
  source: RunCard['source'];
  sourceLabel: string;
  /** Short words for the line and the list. */
  status: string;
  waitingFor: string[];
  /** The card as it will print, or the stored text with no price when it cannot print yet. */
  printed: PrintedCardView | null;
  cardId: number | null;
  version: number | null;
  /** The card's text now, for the edit form. Null when there is no card. */
  edit: { origin: string; eyebrow: string; n1: string; n2: string; producer: string; specs: Array<{ label: string; value: string }>; paragraphs: string[]; unit: string; categories: string[] } | null;
  needsCheck: boolean;
  checkedVersion: number;
  checkList: Array<{ kind: string; text: string; from: string }>;
  /** Pages the model used, as plain text: never links. host is the site the page is on. */
  sources: Array<{ title: string; host: string; url: string; usedFor: string }>;
  searches: Array<{ query: string; results: number; error: string }>;
  problems: string[];
  styleNotes: string[];
  blocked: string[];
  /** Who wrote it and what it cost, for a written card. */
  written: { model: string; cost: string; at: string; productIdentified: boolean; sellingPoint: string } | null;
  /** What this run spent on this card's copy. */
  runCost: string;
  suggestions: CardSuggestionView[];
  /** This card's share of the approval all waiting cards need. */
  pendingApproval: { model: string; usd: string } | null;
  copyState: string | null;
  canWrite: boolean;
  pendingLink: boolean;
}

const SOURCE_LABELS: Record<RunCard['source'], string> = {
  edited: 'Edited in the app',
  imported: 'Imported from the existing cards',
  generated: 'Written by the model',
  none: 'None yet',
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function printedView(r: { eyebrow: string; origin: string; n1: string; n2: string; producer: string; specs: ReadonlyArray<readonly [string, string]>; copy: readonly string[]; price: string; unit: string; code: string }): PrintedCardView {
  return { eyebrow: r.eyebrow, origin: r.origin, n1: r.n1, n2: r.n2, producer: r.producer, specs: r.specs.map(([label, value]) => ({ label, value })), copy: [...r.copy], price: r.price, unit: r.unit, code: r.code };
}

function cardView(c: RunCard, i: number): CardView {
  const card = c.card;
  const conf = runCopyConfig();
  const categories = 'error' in conf ? [] : conf.cfg.categories.map((x) => x.word);
  const review = card?.review ?? null;
  const status = c.leftOut
    ? 'Left out of this run'
    : c.waitingFor.length === 0
      ? 'Prints as shown'
      : !card
        ? c.copy?.state === 'needs_approval'
          ? 'Waiting for an admin to approve the cost'
          : c.copy?.state === 'calling' || c.copy?.state === 'requested' || c.copy?.state === 'approved'
            ? 'Copy is being written'
            : 'No copy yet'
        : c.needsCheck
          ? 'Needs a person to check it'
          : 'Needs a person';
  return {
    anchor: `card-${i + 1}`,
    variationId: c.variationId,
    label: c.label,
    lines: c.lines,
    leftOut: c.leftOut,
    source: c.source,
    sourceLabel: SOURCE_LABELS[c.source],
    status,
    waitingFor: c.waitingFor,
    printed: c.record
      ? printedView(c.record)
      : card
        ? printedView({ ...card.content, price: 'no price yet', code: c.soldByWeight && c.scaleCode ? c.scaleCode : '' })
        : null,
    cardId: card?.id ?? null,
    version: card?.version ?? null,
    edit: card
      ? {
          origin: card.content.origin,
          eyebrow: card.content.eyebrow,
          n1: card.content.n1.trim(),
          n2: card.content.n2,
          producer: card.content.producer,
          specs: card.content.specs.map(([label, value]) => ({ label, value })),
          paragraphs: [...card.content.copy, ...Array.from({ length: Math.max(0, 2 - card.content.copy.length) }, () => '')],
          unit: card.content.unit,
          categories,
        }
      : null,
    needsCheck: c.needsCheck,
    checkedVersion: card?.checkedVersion ?? 0,
    checkList: c.checkList.map((v) => ({ kind: v.kind, text: v.text, from: v.from === 'code' ? 'found by a check' : 'raised by the model' })),
    sources: (review?.sources ?? []).map((x) => ({ title: x.title, host: hostOf(x.url), url: x.url, usedFor: x.usedFor })),
    searches: review?.searches ?? [],
    problems: c.limitProblems,
    styleNotes: c.styleNotes,
    blocked: card?.blocked ?? [],
    written: review ? { model: review.model, cost: `$${review.costUsd.toFixed(2)}`, at: review.generatedAt.replace('T', ' ').slice(0, 16) + ' UTC', productIdentified: review.productIdentified, sellingPoint: review.uniqueSellingPoint } : null,
    runCost: `$${(c.copy?.costUsd ?? 0).toFixed(2)}`,
    suggestions: c.suggestions,
    pendingApproval: c.copy?.state === 'needs_approval' ? { model: c.copy.approvalModel, usd: c.copy.approvalUsd } : null,
    copyState: c.copy?.state ?? null,
    canWrite: c.canWrite && !c.leftOut,
    pendingLink: c.pendingLink,
  };
}
