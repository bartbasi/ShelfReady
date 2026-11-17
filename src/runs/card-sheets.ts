// Shelf card sheets for an invoice run (Phase 1 step 8).
//
// What goes on a sheet:
// - The run's sheet holds exactly the cards the approved dry run listed (ChangePreview.cards.cards),
//   with the text, price and code shown there. Lines where nothing arrived and cards left out are
//   not in that list, so they are never on the sheet. A card whose stored text changed after the
//   approval is refused by name: use a reprint for the new text.
// - A reprint holds the products a person picks from that same list, with the card text as it is
//   now (checked again by cardForPrinting) and the price and code the approved dry run sent.
// - Either way the price and code come from the approved preview, never from card text. A product
//   a later invoice changed is refused: its price may have moved since.
//
// When: a sheet can be made once the run is approved, so its check runs while the run is sent.
// It can be downloaded only once Square has the run's prices (the send's Square part is done), so
// the shelf never shows a price the register does not have. The approved preview is exactly what
// step 7 sends, checked against its hash, so the card prices equal Square's.
//
// The file is built with the card builder (src/cards/build.ts) and the store card config, saved
// under a random name, mode 600, in a mode 700 folder, with its SHA-256 in the database. The
// rendered checks (page count, clip, copy lines, full text) run in the background checker
// (src/runs/sheet-check.ts), never in a request. Every build, check and download is audited.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, writeSync, closeSync } from 'node:fs';
import { buildCards, cardName, sortCards } from '../cards/build.ts';
import type { CardConfig, CardRecord } from '../cards/types.ts';
import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { cardForPrinting } from '../copy/card.ts';
import { PER_POUND } from '../copy/checks.ts';
import { getCard } from '../copy/store.ts';
import { CopyError } from '../copy/types.ts';
import { runCopyConfig } from './card-copy.ts';
import { freeBytes, newStoredName, openNewFile, readStoredFile, removeStoredFile } from './files.ts';
import type { CardPreview, ChangePreview } from './preview.ts';
import { getSend, type SendPhase } from './send-store.ts';
import { addEvent, mustGetRun, runCorrections, RunError, toJson, type RunRow } from './store.ts';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface SheetDeps {
  db: Db;
  /** The folder sheets are kept in (data/card-sheets beside the database). */
  dir: string;
  /** The store card config (config/cards/<store>.json). */
  cardConfig: () => CardConfig;
  now: () => number;
  /** Limits on work a person can start. Default SHEET_LIMITS. */
  limits?: Partial<SheetLimits>;
}

export interface SheetLimits {
  /** Reprints one run may make in an hour. */
  reprintsPerHour: number;
  /** Times a person may ask for a run's checks again in an hour. */
  rechecksPerHour: number;
  /** Refuse a new sheet when the sheet folder's disk has less free space than this, in bytes. */
  minFreeBytes: number;
}

export const SHEET_LIMITS: SheetLimits = { reprintsPerHour: 10, rechecksPerHour: 10, minFreeBytes: 2 * 1024 * 1024 * 1024 };

const HOUR = 3600_000;

function limitsOf(deps: SheetDeps): SheetLimits {
  return { ...SHEET_LIMITS, ...deps.limits };
}

/** One check per run waits or runs at a time, so one run cannot fill the checker's queue. */
function refuseWhileChecking(db: Db, runId: number): void {
  const busy = db.prepare("SELECT 1 FROM card_sheets WHERE run_id = ? AND check_state IN ('queued', 'checking')").get(runId);
  if (busy) throw new RunError('A card sheet check for this invoice is still waiting or running. Wait for it to finish, then try again.', 409);
}

/** The sheet folder exists, is private, and its disk has room. */
function refuseWithoutRoom(deps: SheetDeps): void {
  try {
    ensureSheetDir(deps.dir);
  } catch (err) {
    if (err instanceof SheetDirError) throw new RunError(err.message, 500);
    throw err;
  }
  if (freeBytes(deps.dir) < limitsOf(deps).minFreeBytes) throw new RunError('The disk is nearly full, so no card sheet was made. Tell Bart.', 507);
}

/** One card on a sheet, in printed order. */
export interface SheetCard {
  variationId: string;
  cardId: number;
  version: number;
  title: string;
  /** The name as printed (n1 + n2). */
  name: string;
  price: string;
  unit: string;
  code: string;
}

export type SheetKind = 'run' | 'reprint';
export type CheckState = 'queued' | 'checking' | 'passed' | 'failed' | 'unchecked';

export interface CardFailure {
  page: number;
  slot: number;
  name: string;
  problems: string[];
}

/** What the rendered check found, in plain words. */
export interface SheetCheckResult {
  pages: number;
  expectedPages: number;
  pageCountOk: boolean;
  /** Cards with a real failure: cut off, too many copy lines, or words missing from the page. */
  failures: CardFailure[];
  mostCopyLines: number;
  maxCopyLines: number;
  missingFonts: string[];
}

export interface CardSheet {
  id: number;
  runId: number;
  kind: SheetKind;
  fileName: string;
  storedName: string;
  sha256: string;
  bytes: number;
  slots: number;
  cards: SheetCard[];
  dryRunHash: string;
  checkState: CheckState;
  checkResult: SheetCheckResult | null;
  checkMessage: string;
  checkedAt: number | null;
  createdByName: string;
  createdAt: number;
}

interface DbSheet {
  id: number;
  run_id: number;
  kind: SheetKind;
  file_name: string;
  stored_name: string;
  sha256: string;
  bytes: number;
  slots: number;
  cards: string;
  dry_run_hash: string;
  check_state: CheckState;
  check_result: string;
  check_message: string;
  checked_at: number | null;
  created_by_name: string;
  created_at: number;
}

function fromDb(r: DbSheet): CardSheet {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind,
    fileName: r.file_name,
    storedName: r.stored_name,
    sha256: r.sha256,
    bytes: r.bytes,
    slots: r.slots,
    cards: JSON.parse(r.cards) as SheetCard[],
    dryRunHash: r.dry_run_hash,
    checkState: r.check_state,
    checkResult: JSON.parse(r.check_result) as SheetCheckResult | null,
    checkMessage: r.check_message,
    checkedAt: r.checked_at,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
  };
}

export function runSheets(db: Db, runId: number): CardSheet[] {
  return (db.prepare('SELECT * FROM card_sheets WHERE run_id = ? ORDER BY id').all(runId) as unknown as DbSheet[]).map(fromDb);
}

export function getSheet(db: Db, id: number): CardSheet | null {
  const r = db.prepare('SELECT * FROM card_sheets WHERE id = ?').get(id) as DbSheet | undefined;
  return r ? fromDb(r) : null;
}

// ---- The sheet folder ----

/** The sheet folder cannot be used safely. Safe to show. */
export class SheetDirError extends Error {}

/** Makes the sheet folder if needed: a plain folder owned by this user, closed to everyone else. */
export function ensureSheetDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new SheetDirError('The card sheet folder is not a plain folder. Tell Bart.');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new SheetDirError('The card sheet folder belongs to another user. Tell Bart.');
  if (st.mode & 0o077) throw new SheetDirError('Others can read the card sheet folder. Tell Bart.');
}

// ---- When a sheet may be made and downloaded ----

const APPROVED_STATES: ReadonlySet<string> = new Set(['approved', 'sending', 'partial', 'done']);
const SQUARE_DONE: ReadonlySet<SendPhase> = new Set(['square_done', 'scale_preview', 'sending_scales', 'done', 'partial']);

/** The run is approved, so its cards are settled. */
export function sheetCanBeMade(run: RunRow): boolean {
  return APPROVED_STATES.has(run.state) && run.dryRun !== null && run.dryRunHash !== '';
}

/** Square confirmed every write of this run, so the register has the prices the cards print. */
export function squareHasRunPrices(db: Db, run: RunRow): boolean {
  if (run.state === 'done' || run.state === 'partial') return true;
  if (run.state !== 'sending') return false;
  const send = getSend(db, run.id);
  return send !== null && SQUARE_DONE.has(send.phase);
}

/**
 * Products whose new price or switch to sold by weight never reached Square in this run's send
 * (for example a send finished after the approval expired, which writes nothing new). Their cards
 * would print a price the register does not have. From the send's report, per item.
 */
export function pricesNotInSquare(db: Db, run: RunRow): Set<string> {
  const send = getSend(db, run.id);
  // Items where nothing arrived after all are left out by their own check, with its own words.
  const nothingArrived = new Set(send?.snapshot?.folded?.skipped ?? []);
  const report = send?.squareReport as { items?: Array<{ variationId?: unknown; price?: { state?: unknown } | null; switchToWeight?: { state?: unknown } | null }> } | null | undefined;
  const out = new Set<string>();
  for (const i of report?.items ?? []) {
    if (typeof i.variationId !== 'string' || nothingArrived.has(i.variationId)) continue;
    if ((i.price && i.price.state !== 'done') || (i.switchToWeight && i.switchToWeight.state !== 'done')) out.add(i.variationId);
  }
  return out;
}

/**
 * Products a later invoice changed or printed a card for, approved or sent since. Their price may
 * have moved, so this run must not print them. Returns variation id to that run's id.
 */
export function laterRunsFor(db: Db, run: RunRow, variationIds: readonly string[]): Map<string, number> {
  const want = new Set(variationIds);
  const out = new Map<string, number>();
  const rows = db
    .prepare("SELECT id, dry_run FROM runs WHERE id > ? AND state IN ('approved', 'sending', 'partial', 'done') ORDER BY id")
    .all(run.id) as Array<{ id: number; dry_run: string }>;
  for (const r of rows) {
    const p = JSON.parse(r.dry_run) as ChangePreview | null;
    if (!p) continue;
    const touched = [
      ...p.square.filter((s) => s.price || s.switchToWeight).map((s) => s.variationId),
      ...(p.cards?.cards ?? []).map((c) => c.variationId),
    ];
    for (const v of touched) if (want.has(v) && !out.has(v)) out.set(v, r.id);
  }
  return out;
}

/**
 * Products whose every line on this run was marked as not arrived after approval. Nothing of them
 * arrived, so they get no card (DECISIONS.md, What arrived). Returns variation id to the lines.
 */
export function notArrivedAfterApproval(db: Db, run: RunRow): Map<string, number[]> {
  const p = run.dryRun as ChangePreview | null;
  const out = new Map<string, number[]>();
  if (!p) return out;
  const corrected = new Set(runCorrections(db, run.id).map((c) => c.line));
  if (corrected.size === 0) return out;
  for (const sq of p.square) {
    if (sq.lines.length && sq.lines.every((n) => corrected.has(n))) out.set(sq.variationId, sq.lines);
  }
  return out;
}

/** The approved cards that still print: those whose lines were not all marked as not arrived. */
function printableApproved(db: Db, run: RunRow, p: ChangePreview): CardPreview[] {
  const gone = notArrivedAfterApproval(db, run);
  return (p.cards?.cards ?? []).filter((c) => !gone.has(c.variationId));
}

// ---- File names ----

function slug(text: string, max: number): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

interface InvoiceFacts {
  supplier: string;
  number: string;
  dateIso: string;
}

function invoiceFacts(run: RunRow): InvoiceFacts {
  const inv = (run.readResult as { reading?: { invoice?: Record<string, unknown> } } | null)?.reading?.invoice ?? {};
  const s = (k: string) => (typeof inv[k] === 'string' ? (inv[k] as string) : '');
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s('invoice_date_iso')) ? s('invoice_date_iso') : new Date(run.createdAt).toISOString().slice(0, 10);
  return { supplier: s('supplier_name'), number: s('invoice_number'), dateIso: iso };
}

/**
 * A plain file name: cards, supplier, invoice number and date, for example
 * cards-hilltop-provisions-12345-2026-11-06.docx. Only letters, digits and hyphens, so it is safe
 * in a header and on any disk. A reprint adds reprint and its count.
 */
export function sheetFileName(run: RunRow, kind: SheetKind, reprintNumber = 0): string {
  const f = invoiceFacts(run);
  const parts = ['cards', slug(f.supplier, 40) || 'invoice', slug(f.number, 20) || `run-${run.id}`, f.dateIso];
  if (kind === 'reprint') parts.push(`reprint-${reprintNumber}`);
  return `${parts.join('-')}.docx`;
}

// ---- Building ----

interface Entry {
  record: CardRecord;
  meta: Omit<SheetCard, 'name' | 'price' | 'unit' | 'code'>;
}

function approvedPreview(run: RunRow): ChangePreview {
  const p = run.dryRun as ChangePreview | null;
  if (!p || !run.dryRunHash || p.hash !== run.dryRunHash) throw new RunError('This invoice has no approved dry run, so it has no cards to print.', 409);
  return p;
}

function refuseLater(db: Db, run: RunRow, cards: readonly CardPreview[]): void {
  const later = laterRunsFor(db, run, cards.map((c) => c.variationId));
  if (later.size === 0) return;
  const names = cards.filter((c) => later.has(c.variationId)).map((c) => `${c.title} (invoice ${later.get(c.variationId)})`);
  throw new RunError(`A later invoice changed ${names.join(', ')}. Print ${names.length === 1 ? 'that card' : 'those cards'} from the later invoice, so the price is the current one.`, 409);
}

async function storeSheet(deps: SheetDeps, actor: AuditActor, run: RunRow, kind: SheetKind, entries: Entry[], fileName: string): Promise<CardSheet> {
  const { db, now } = deps;
  refuseWhileChecking(db, run.id);
  refuseWithoutRoom(deps);
  // Sorted as the builder sorts (category, then name), kept with what each card is.
  const byRecord = new Map(entries.map((e) => [e.record, e.meta]));
  const sorted = sortCards(entries.map((e) => e.record));
  const built = await buildCards(sorted, deps.cardConfig(), { sort: false });
  const cards: SheetCard[] = sorted.map((r) => ({ ...byRecord.get(r)!, name: cardName(r), price: r.price, unit: r.unit, code: r.code }));
  const sha256 = createHash('sha256').update(built.buffer).digest('hex');
  const storedName = newStoredName();
  const fd = openNewFile(deps.dir, storedName);
  try {
    writeSync(fd, built.buffer);
  } finally {
    closeSync(fd);
  }
  try {
    const id = inTransaction(db, () => {
      if (kind === 'run' && db.prepare("SELECT 1 FROM card_sheets WHERE run_id = ? AND kind = 'run'").get(run.id)) {
        throw new RunError('The card sheet for this invoice is already made.', 409);
      }
      const res = db
        .prepare(
          `INSERT INTO card_sheets (run_id, kind, file_name, stored_name, sha256, bytes, slots, cards, dry_run_hash, check_state, created_by, created_by_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
        )
        .run(run.id, kind, fileName, storedName, sha256, built.buffer.length, built.slots, toJson(cards), run.dryRunHash, actor.userId, actor.username, now(), now());
      const sheetId = Number(res.lastInsertRowid);
      appendAudit(
        db,
        actor,
        {
          action: 'cards.sheet.build',
          entityType: 'card_sheet',
          entityId: sheetId,
          runId: run.id,
          details: { kind, fileName, sha256, bytes: built.buffer.length, slots: built.slots, cards: cards.map((c) => ({ variationId: c.variationId, cardId: c.cardId, version: c.version, price: c.price, code: c.code })) },
        },
        now(),
      );
      addEvent(db, run.id, 'card_sheet', `${actor.username} made ${kind === 'run' ? 'the card sheet' : 'a reprint'}: ${cards.length} ${cards.length === 1 ? 'card' : 'cards'} on ${built.sheets} ${built.sheets === 1 ? 'page' : 'pages'} (sha256 ${sha256.slice(0, 12)}). The check runs next.`, now());
      return sheetId;
    });
    return getSheet(db, id)!;
  } catch (err) {
    removeStoredFile(deps.dir, storedName);
    throw err;
  }
}

/** Every card on the run's approved list, as approved. Refuses a card whose stored text moved since. */
export async function buildRunSheet(deps: SheetDeps, runId: number, actor: AuditActor): Promise<CardSheet> {
  const run = mustGetRun(deps.db, runId);
  if (!sheetCanBeMade(run)) throw new RunError('The card sheet is made once this invoice is approved.', 409);
  if (runSheets(deps.db, runId).some((s) => s.kind === 'run')) throw new RunError('The card sheet for this invoice is already made.', 409);
  const p = approvedPreview(run);
  const cards = printableApproved(deps.db, run, p);
  if (cards.length === 0) throw new RunError('The approved dry run has no cards to print (lines marked as not arrived make none).', 409);
  // Each card must still be the version that was approved.
  const moved = cards.filter((c) => {
    const now = getCard(deps.db, c.cardId);
    return !now || now.retiredAt !== null || now.version !== c.version;
  });
  if (moved.length) {
    throw new RunError(`The card for ${moved.map((c) => c.title).join(', ')} changed after this invoice was approved. Make a reprint for ${moved.length === 1 ? 'it' : 'them'} instead, which uses the text as it is now.`, 409);
  }
  refuseLater(deps.db, run, cards);
  const entries: Entry[] = cards.map((c) => ({ record: structuredClone(c.record), meta: { variationId: c.variationId, cardId: c.cardId, version: c.version, title: c.title } }));
  return storeSheet(deps, actor, run, 'run', entries, sheetFileName(run, 'run'));
}

/** The price in cents from a card's printed price, for example $22.99. */
function centsOf(price: string): number {
  const m = /^\$(\d+)\.(\d{2})$/.exec(price);
  if (!m) throw new RunError('A card on the approved dry run has no price it can print. Make a new dry run.', 409);
  return Number(m[1]) * 100 + Number(m[2]);
}

/**
 * A reprint of the products picked from the approved list (by their place in it), with the card
 * text as it is now and the approved price and code. Each card is checked again for printing.
 */
export async function buildReprint(deps: SheetDeps, runId: number, actor: AuditActor, picks: readonly number[]): Promise<CardSheet> {
  const run = mustGetRun(deps.db, runId);
  if (!sheetCanBeMade(run)) throw new RunError('A reprint can be made once this invoice is approved.', 409);
  const p = approvedPreview(run);
  const list = p.cards?.cards ?? [];
  const chosen = [...new Set(picks)].filter((i) => Number.isInteger(i) && i >= 0 && i < list.length).map((i) => list[i]!);
  if (chosen.length === 0) throw new RunError('Pick at least one card to reprint.', 400);
  const made = (deps.db.prepare("SELECT count(*) AS n FROM card_sheets WHERE run_id = ? AND kind = 'reprint' AND created_at >= ?").get(runId, deps.now() - HOUR) as { n: number }).n;
  if (made >= limitsOf(deps).reprintsPerHour) throw new RunError(`This invoice has had ${made} reprints in the last hour. Wait a while and try again.`, 429);
  const gone = notArrivedAfterApproval(deps.db, run);
  const notArrived = chosen.filter((c) => gone.has(c.variationId));
  if (notArrived.length) throw new RunError(`Not reprinted. Nothing arrived for ${notArrived.map((c) => c.title).join(', ')}: ${notArrived.length === 1 ? 'its line was' : 'their lines were'} marked as not arrived, so no card prints.`, 409);
  const unsent = chosen.filter((c) => pricesNotInSquare(deps.db, run).has(c.variationId));
  if (unsent.length) throw new RunError(`Not reprinted. Square never got the new price for ${unsent.map((c) => c.title).join(', ')}, so no card prints for ${unsent.length === 1 ? 'it' : 'them'} from this invoice.`, 409);
  refuseLater(deps.db, run, chosen);
  const conf = runCopyConfig();
  if ('error' in conf) throw new RunError(conf.error, 500);
  const entries: Entry[] = [];
  const problems: string[] = [];
  for (const c of chosen) {
    const stored = getCard(deps.db, c.cardId);
    if (!stored) {
      problems.push(`${c.title}: its card is missing.`);
      continue;
    }
    try {
      const record = cardForPrinting(stored, { priceCents: centsOf(c.record.price), scaleCode: c.record.code || null, soldByWeight: c.record.unit === PER_POUND }, conf.cfg.categories);
      entries.push({ record, meta: { variationId: c.variationId, cardId: stored.id, version: stored.version, title: c.title } });
    } catch (err) {
      if (!(err instanceof CopyError)) throw err;
      problems.push(`${c.title}: ${err.message}`);
    }
  }
  if (problems.length) throw new RunError(`Not reprinted. ${problems.join(' ')}`, 409);
  const n = runSheets(deps.db, runId).filter((s) => s.kind === 'reprint').length + 1;
  return storeSheet(deps, actor, run, 'reprint', entries, sheetFileName(run, 'reprint', n));
}

// ---- The check, as stored ----

/** Takes the oldest queued sheet and marks it checking, in one step. */
export function claimNextCheck(db: Db, now: number): CardSheet | null {
  return inTransaction(db, () => {
    const r = db.prepare("SELECT * FROM card_sheets WHERE check_state = 'queued' ORDER BY id LIMIT 1").get() as DbSheet | undefined;
    if (!r) return null;
    db.prepare("UPDATE card_sheets SET check_state = 'checking', updated_at = ? WHERE id = ?").run(now, r.id);
    return fromDb({ ...r, check_state: 'checking' });
  });
}

export function queuedChecks(db: Db): number {
  return (db.prepare("SELECT count(*) AS n FROM card_sheets WHERE check_state = 'queued'").get() as { n: number }).n;
}

/** A check cut short by a restart runs again: it only reads the file. */
export function requeueInterrupted(db: Db, now: number): number {
  return Number(db.prepare("UPDATE card_sheets SET check_state = 'queued', updated_at = ? WHERE check_state = 'checking'").run(now).changes);
}

export function recordCheck(db: Db, actor: AuditActor, sheet: CardSheet, outcome: { state: 'passed' | 'failed' | 'unchecked'; result: SheetCheckResult | null; message: string }, now: number): void {
  inTransaction(db, () => {
    db.prepare('UPDATE card_sheets SET check_state = ?, check_result = ?, check_message = ?, checked_at = ?, updated_at = ? WHERE id = ?').run(
      outcome.state,
      toJson(outcome.result),
      outcome.message.slice(0, 1000),
      now,
      now,
      sheet.id,
    );
    appendAudit(
      db,
      actor,
      {
        action: 'cards.sheet.check',
        entityType: 'card_sheet',
        entityId: sheet.id,
        runId: sheet.runId,
        details: { state: outcome.state, pages: outcome.result?.pages ?? null, expectedPages: outcome.result?.expectedPages ?? null, failures: outcome.result?.failures.map((f) => f.name) ?? [], sha256: sheet.sha256 },
      },
      now,
    );
    addEvent(db, sheet.runId, 'card_sheet', `Card sheet check (${sheet.fileName}): ${outcome.state === 'passed' ? 'passed' : outcome.state === 'failed' ? 'failed' : 'not checked'}. ${outcome.message}`, now);
  });
}

/** A person asks for the check again, for example after installing LibreOffice. */
export function requestRecheck(deps: SheetDeps, runId: number, sheetId: number, actor: AuditActor): void {
  const sheet = getSheet(deps.db, sheetId);
  if (!sheet || sheet.runId !== runId) throw new RunError('There is no such card sheet on this invoice.', 404);
  if (sheet.checkState === 'queued' || sheet.checkState === 'checking') throw new RunError('The check is already waiting or running.', 409);
  refuseWhileChecking(deps.db, runId);
  const asked = (deps.db.prepare("SELECT count(*) AS n FROM audit_log WHERE run_id = ? AND action = 'cards.sheet.recheck' AND at >= ?").get(runId, new Date(deps.now() - HOUR).toISOString()) as { n: number }).n;
  if (asked >= limitsOf(deps).rechecksPerHour) throw new RunError(`The checks for this invoice were asked for ${asked} times in the last hour. Wait a while and try again.`, 429);
  inTransaction(deps.db, () => {
    deps.db.prepare("UPDATE card_sheets SET check_state = 'queued', updated_at = ? WHERE id = ?").run(deps.now(), sheet.id);
    appendAudit(deps.db, actor, { action: 'cards.sheet.recheck', entityType: 'card_sheet', entityId: sheet.id, runId }, deps.now());
  });
}

// ---- Download ----

/** Why this sheet cannot be downloaded now, or null when it can. */
export function downloadRefusal(db: Db, run: RunRow, sheet: CardSheet): string | null {
  if (sheet.checkState === 'queued' || sheet.checkState === 'checking') return 'The check is still running. The download opens when it is done.';
  if (sheet.checkState === 'failed') {
    const names = sheet.checkResult?.failures.map((f) => f.name).filter(Boolean) ?? [];
    return `The check failed${names.length ? ` for ${names.join(', ')}` : ''}. ${sheet.checkMessage}`.trim();
  }
  if (!squareHasRunPrices(db, run)) return 'The download opens once Square has this invoice\'s prices, so the shelf never shows a price the register does not have. Send the invoice first.';
  const missing = sheet.cards.filter((c) => pricesNotInSquare(db, run).has(c.variationId));
  if (missing.length) {
    return `Square never got the new price for ${missing.map((c) => c.title).join(', ')}, so ${missing.length === 1 ? 'its card' : 'their cards'} would show a price the register does not have. Make a reprint of the other cards.`;
  }
  if (sheet.dryRunHash !== run.dryRunHash) return 'This sheet was made from an older dry run. Make a reprint.';
  const gone = notArrivedAfterApproval(db, run);
  const notArrived = sheet.cards.filter((c) => gone.has(c.variationId));
  if (notArrived.length) {
    return `Nothing arrived for ${notArrived.map((c) => c.title).join(', ')}: marked as not arrived after this sheet was made, so ${notArrived.length === 1 ? 'its card' : 'their cards'} must not print. Make a reprint of the other cards.`;
  }
  // A later invoice may have repriced a product since this sheet was made.
  const later = laterRunsFor(db, run, sheet.cards.map((c) => c.variationId));
  if (later.size) {
    const names = sheet.cards.filter((c) => later.has(c.variationId)).map((c) => `${c.title} (invoice ${later.get(c.variationId)})`);
    return `A later invoice changed ${names.join(', ')} since this sheet was made, so its price may be old. Print ${names.length === 1 ? 'that card' : 'those cards'} from the later invoice, and reprint the others here.`;
  }
  return null;
}

/** The file for a download, checked against its stored hash. Audited. */
export function downloadSheet(deps: SheetDeps, runId: number, sheetId: number, actor: AuditActor): { buffer: Buffer; fileName: string; warning: string } {
  const run = mustGetRun(deps.db, runId);
  const sheet = getSheet(deps.db, sheetId);
  if (!sheet || sheet.runId !== runId) throw new RunError('There is no such card sheet on this invoice.', 404);
  const refusal = downloadRefusal(deps.db, run, sheet);
  if (refusal) throw new RunError(refusal, 409);
  let buffer: Buffer;
  try {
    buffer = readStoredFile(deps.dir, sheet.storedName);
  } catch {
    throw new RunError('The card sheet file is missing. Make a reprint.', 410);
  }
  if (createHash('sha256').update(buffer).digest('hex') !== sheet.sha256) throw new RunError('The card sheet file has changed since it was made, so it is not offered. Tell Bart.', 500);
  appendAudit(deps.db, actor, { action: 'cards.sheet.download', entityType: 'card_sheet', entityId: sheet.id, runId, details: { fileName: sheet.fileName, sha256: sheet.sha256, checkState: sheet.checkState } }, deps.now());
  return { buffer, fileName: sheet.fileName, warning: sheet.checkState === 'unchecked' ? sheet.checkMessage : '' };
}

// ---- The view for the pages ----

export interface SheetRowView {
  id: number;
  kind: SheetKind;
  label: string;
  fileName: string;
  cards: number;
  pages: number;
  madeBy: string;
  madeAt: string;
  hash: string;
  checkState: CheckState;
  checkLabel: string;
  checkMessage: string;
  failures: Array<{ where: string; name: string; problems: string[] }>;
  /** The download path, or null with the reason. */
  download: string | null;
  refusal: string | null;
  /** The check can be asked for again. */
  canRecheck: boolean;
  names: string[];
}

export interface SheetSectionView {
  runId: number;
  /** False before approval: the section says when the sheet comes. */
  canMake: boolean;
  /** The run's own sheet is not made yet. */
  canMakeRunSheet: boolean;
  approvedCards: number;
  squareDone: boolean;
  sheets: SheetRowView[];
  /** The approved cards a reprint can pick from, by their place in the list. */
  reprintChoices: Array<{ index: number; title: string; price: string; unit: string }>;
  /** Approved cards that no longer print: every line was marked as not arrived after approval. */
  notArrived: Array<{ title: string; lines: number[] }>;
}

const CHECK_LABELS: Record<CheckState, string> = {
  queued: 'Check waiting',
  checking: 'Checking now',
  passed: 'Check passed',
  failed: 'Check failed',
  unchecked: 'Not checked',
};

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function sheetSection(db: Db, run: RunRow): SheetSectionView {
  const canMake = sheetCanBeMade(run);
  const p = canMake ? (run.dryRun as ChangePreview) : null;
  const all = p?.cards?.cards ?? [];
  const gone = canMake ? notArrivedAfterApproval(db, run) : new Map<string, number[]>();
  const list = all.filter((c) => !gone.has(c.variationId));
  const sheets = runSheets(db, run.id);
  let reprints = 0;
  return {
    runId: run.id,
    canMake,
    canMakeRunSheet: canMake && list.length > 0 && !sheets.some((s) => s.kind === 'run'),
    approvedCards: list.length,
    squareDone: squareHasRunPrices(db, run),
    sheets: sheets.map((s) => {
      const refusal = downloadRefusal(db, run, s);
      return {
        id: s.id,
        kind: s.kind,
        label: s.kind === 'run' ? 'Card sheet' : `Reprint ${++reprints}`,
        fileName: s.fileName,
        cards: s.cards.length,
        pages: s.slots / 4,
        madeBy: s.createdByName,
        madeAt: when(s.createdAt),
        hash: s.sha256.slice(0, 12),
        checkState: s.checkState,
        checkLabel: CHECK_LABELS[s.checkState],
        checkMessage: s.checkMessage,
        failures: (s.checkResult?.failures ?? []).map((f) => ({ where: `Page ${f.page}, card ${f.slot}`, name: f.name, problems: f.problems })),
        download: refusal ? null : `/runs/${run.id}/card-sheets/${s.id}`,
        refusal,
        canRecheck: s.checkState === 'unchecked' || s.checkState === 'failed',
        names: s.cards.map((c) => c.title),
      };
    }),
    // Places in the full approved list, which is what a reprint form posts.
    reprintChoices: canMake ? all.flatMap((c, index) => (gone.has(c.variationId) ? [] : [{ index, title: c.title, price: c.record.price, unit: c.record.unit }])) : [],
    notArrived: all.filter((c) => gone.has(c.variationId)).map((c) => ({ title: c.title, lines: gone.get(c.variationId)! })),
  };
}
