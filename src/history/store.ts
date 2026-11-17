// Database access for old invoices (migration 12). Old invoices are recorded only: this file
// touches the purchase_* tables, the shared upload rate table and the model spend ledger, and
// nothing that belongs to invoice runs, Square, the scales or the cards.
//
// Every upload, reading, refusal and removal is written to the audit log with who and when.

import { appendAudit, SYSTEM_ACTOR, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { recordUploadAttemptOf, storedUploadBytesSince, uploadAttemptsOfSince } from '../db/uploads.ts';
import { normalizeInvoiceNumber } from '../invoice/checks.ts';
import type { UploadKind } from '../invoice/images.ts';
import { companyKey } from '../lib/names.ts';
import type { HistoryLine, HistoryReading } from './lines.ts';

/** A refusal with words safe to show. */
export class HistoryError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'HistoryError';
    this.status = status;
  }
  get statusCode(): number {
    return this.status;
  }
}

export type PurchaseState = 'uploaded' | 'reading' | 'done' | 'failed';

export type PurchaseSource = 'old' | 'run';

export interface PurchaseInvoice {
  id: number;
  /** old: uploaded here, record only. run: the lines of an invoice run. */
  source: PurchaseSource;
  /** The invoice run, for source run. */
  runId: number | null;
  state: PurchaseState;
  createdBy: number | null;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  vendor: string;
  invoiceNumber: string;
  invoiceDate: string;
  invoiceDateIso: string;
  totalCents: number | null;
  readStatus: string;
  models: string;
  finalModel: string;
  costUsd: number;
  costIsEstimate: boolean;
  /** Problems with the whole invoice that flag every line. */
  checks: string[];
  /** Facts about the whole invoice that do not change a line. */
  notes: string[];
  lineCount: number;
  needsCheckCount: number;
  message: string;
  /** A run that was read and then stopped. Its lines all need a check. Known only in the list. */
  runStopped: boolean;
}

export interface PurchaseFile {
  id: number;
  position: number;
  storedName: string;
  originalName: string;
  kind: UploadKind;
  bytes: number;
  sha256: string;
}

export interface NewFile {
  storedName: string;
  originalName: string;
  kind: UploadKind;
  bytes: number;
  sha256: string;
}

export interface PurchaseLineRow extends HistoryLine {
  id: number;
}

interface DbInvoice {
  id: number;
  source: PurchaseSource;
  run_id: number | null;
  state: PurchaseState;
  created_by: number | null;
  created_by_name: string;
  created_at: number;
  updated_at: number;
  vendor: string;
  invoice_number: string;
  invoice_date: string;
  invoice_date_iso: string;
  total_cents: number | null;
  read_status: string;
  models: string;
  final_model: string;
  cost_usd: number;
  cost_is_estimate: number;
  checks: string;
  notes: string;
  line_count: number;
  needs_check_count: number;
  message: string;
  run_state?: string | null;
}

function fromDb(r: DbInvoice): PurchaseInvoice {
  return {
    id: r.id,
    source: r.source,
    runId: r.run_id,
    state: r.state,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    vendor: r.vendor,
    invoiceNumber: r.invoice_number,
    invoiceDate: r.invoice_date,
    invoiceDateIso: r.invoice_date_iso,
    totalCents: r.total_cents,
    readStatus: r.read_status,
    models: r.models,
    finalModel: r.final_model,
    costUsd: Number(r.cost_usd) || 0,
    costIsEstimate: r.cost_is_estimate === 1,
    checks: stringList(r.checks),
    notes: stringList(r.notes),
    lineCount: r.line_count,
    needsCheckCount: r.needs_check_count,
    message: r.message,
    runStopped: r.source === 'run' && r.run_state === 'failed',
  };
}

const ENTITY = 'purchase_invoice';

/** Old invoices that still count: waiting, being read, or recorded. A failed one does not. */
const LIVE = "state IN ('uploaded', 'reading', 'done')";

/** Another old invoice that still counts and holds a file with this hash, or null. */
export function invoiceWithSameFile(db: Db, sha256s: readonly string[]): number | null {
  for (const h of sha256s) {
    const r = db.prepare(`SELECT p.id FROM purchase_files f JOIN purchase_invoices p ON p.id = f.invoice_id WHERE f.sha256 = ? AND p.${LIVE} ORDER BY p.id LIMIT 1`).get(h) as { id: number } | undefined;
    if (r) return r.id;
  }
  return null;
}

/** Old invoices one person uploaded since the given time. */
export function purchaseUploadsSince(db: Db, userId: number, since: number): number {
  return (db.prepare("SELECT count(*) AS n FROM purchase_invoices WHERE source = 'old' AND created_by = ? AND created_at >= ?").get(userId, since) as { n: number }).n;
}

/** Bytes of invoice files kept since then, invoice runs and old invoices together (src/db/uploads.ts). */
export function storedBytesSince(db: Db, since: number, userId?: number): number {
  return storedUploadBytesSince(db, since, userId);
}

/** Old invoice upload attempts have their own hourly limit, apart from invoice runs. */
export function recordAttempt(db: Db, userId: number, now: number): void {
  recordUploadAttemptOf(db, 'history', userId, now);
}

export function attemptsSince(db: Db, userId: number, since: number): number {
  return uploadAttemptsOfSince(db, 'history', userId, since);
}

/**
 * Saves a new old invoice with its files, waiting for the reader. Refuses a photo that is already
 * part of an old invoice that counts, and a person over the hourly rate.
 */
export function createPurchaseInvoice(db: Db, actor: AuditActor & { userId: number }, files: readonly NewFile[], now: number, maxPerHour = Infinity): number {
  return inTransaction(db, () => {
    if (purchaseUploadsSince(db, actor.userId, now - 3600_000) >= maxPerHour) throw new HistoryError('You have uploaded a lot of invoices in the last hour. Wait a while and try again.', 429);
    const same = invoiceWithSameFile(db, files.map((f) => f.sha256));
    if (same !== null) {
      appendAudit(db, actor, { action: 'history.duplicate_photo', entityType: ENTITY, entityId: same, details: { files: files.map((f) => ({ name: f.originalName, sha256: f.sha256 })) } }, now);
      throw new HistoryError(`That photo was already uploaded, as old invoice ${same}. It was not uploaded again.`, 409);
    }
    const res = db.prepare("INSERT INTO purchase_invoices (state, created_by, created_by_name, created_at, updated_at, message) VALUES ('uploaded', ?, ?, ?, ?, ?)").run(actor.userId, actor.username, now, now, 'Waiting to be read.');
    const id = Number(res.lastInsertRowid);
    const ins = db.prepare('INSERT INTO purchase_files (invoice_id, position, stored_name, original_name, kind, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    files.forEach((f, i) => ins.run(id, i + 1, f.storedName, f.originalName, f.kind, f.bytes, f.sha256, now));
    appendAudit(
      db,
      actor,
      { action: 'history.upload', entityType: ENTITY, entityId: id, details: { recordOnly: true, files: files.map((f) => ({ name: f.originalName, kind: f.kind, bytes: f.bytes, sha256: f.sha256 })) } },
      now,
    );
    return id;
  });
}

export function getPurchaseInvoice(db: Db, id: number): PurchaseInvoice | null {
  const r = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(id) as DbInvoice | undefined;
  return r ? fromDb(r) : null;
}

/**
 * Every old invoice and every run that was read is in the history. A run has a row only once it
 * has a reading, so a run whose files could not be used shows nothing. A run that was read but
 * never sent counts: the invoice was received. A run that was read and then stopped (state
 * failed: a person stopped it, or it was set aside as a twin) counts too, with every line marked
 * Needs check (src/history/export.ts), but any other copy of the same invoice wins over it.
 */
const COUNTS = "(p.source = 'old' OR r.state IS NOT NULL)";

/** A copy that refuses a new old invoice, and that an old invoice defers to: not a stopped run. */
const NOT_STOPPED = "(p.source = 'old' OR (r.state IS NOT NULL AND r.state <> 'failed'))";

/** Said on every line of a stopped run. */
export const STOPPED_REASON = 'This invoice run was stopped. Check whether the goods arrived.';

/** Newest first: old invoices and every invoice run that was read, stopped ones included. */
export function listPurchaseInvoices(db: Db, limit = 500): PurchaseInvoice[] {
  return (
    db.prepare(`SELECT p.*, r.state AS run_state FROM purchase_invoices p LEFT JOIN runs r ON r.id = p.run_id WHERE ${COUNTS} ORDER BY p.created_at DESC, p.id DESC LIMIT ?`).all(limit) as unknown as DbInvoice[]
  ).map(fromDb);
}

export function purchaseFiles(db: Db, invoiceId: number): PurchaseFile[] {
  const rows = db.prepare('SELECT * FROM purchase_files WHERE invoice_id = ? ORDER BY position').all(invoiceId) as Array<{
    id: number;
    position: number;
    stored_name: string;
    original_name: string;
    kind: UploadKind;
    bytes: number;
    sha256: string;
  }>;
  return rows.map((r) => ({ id: r.id, position: r.position, storedName: r.stored_name, originalName: r.original_name, kind: r.kind, bytes: r.bytes, sha256: r.sha256 }));
}

interface DbLine {
  id: number;
  n: number;
  page: number;
  file_position: number;
  item_number: string;
  upc: string;
  description: string;
  brand: string;
  product: string;
  pack_size: string;
  units_per_pack: string;
  pack: string;
  qty_shipped: string;
  unit: string;
  weight: string;
  unit_price: string;
  price_unit: string;
  allowance: string;
  extension: string;
  qty: string;
  qty_unit: string;
  price_per: string;
  extension_cents: number | null;
  printed_status: string;
  confidence: string;
  confidence_note: string;
  needs_check: number;
  reasons: string;
  notes: string;
}

function stringList(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function lineFromDb(r: DbLine): PurchaseLineRow {
  return {
    id: r.id,
    n: r.n,
    page: r.page,
    filePosition: r.file_position,
    itemNumber: r.item_number,
    upc: r.upc,
    description: r.description,
    brand: r.brand,
    product: r.product,
    packSize: r.pack_size,
    unitsPerPack: r.units_per_pack,
    pack: r.pack,
    qtyShipped: r.qty_shipped,
    unit: r.unit,
    weight: r.weight,
    unitPrice: r.unit_price,
    priceUnit: r.price_unit,
    allowance: r.allowance,
    extension: r.extension,
    qty: r.qty,
    qtyUnit: r.qty_unit,
    pricePer: r.price_per,
    extensionCents: r.extension_cents,
    printedStatus: r.printed_status,
    confidence: r.confidence,
    confidenceNote: r.confidence_note,
    needsCheck: r.needs_check === 1,
    reasons: stringList(r.reasons),
    notes: stringList(r.notes),
  };
}

export function purchaseLines(db: Db, invoiceId: number): PurchaseLineRow[] {
  return (db.prepare('SELECT * FROM purchase_lines WHERE invoice_id = ? ORDER BY n').all(invoiceId) as unknown as DbLine[]).map(lineFromDb);
}

/** The oldest old invoice waiting to be read. */
export function nextWaiting(db: Db): PurchaseInvoice | null {
  const r = db.prepare("SELECT * FROM purchase_invoices WHERE state = 'uploaded' ORDER BY id LIMIT 1").get() as DbInvoice | undefined;
  return r ? fromDb(r) : null;
}

export function waitingIds(db: Db): number[] {
  return (db.prepare("SELECT id FROM purchase_invoices WHERE state = 'uploaded' ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

export function readingIds(db: Db): number[] {
  return (db.prepare("SELECT id FROM purchase_invoices WHERE state = 'reading' ORDER BY id").all() as Array<{ id: number }>).map((r) => r.id);
}

export function setMessage(db: Db, id: number, message: string, now: number): void {
  db.prepare('UPDATE purchase_invoices SET message = ?, updated_at = ? WHERE id = ?').run(message, now, id);
}

/** Moves a waiting invoice to reading. False when it was not waiting (removed meanwhile). */
export function startReading(db: Db, id: number, now: number): boolean {
  const res = db.prepare("UPDATE purchase_invoices SET state = 'reading', message = 'Reading the invoice.', updated_at = ? WHERE id = ? AND state = 'uploaded'").run(now, id);
  return Number(res.changes) === 1;
}

export interface ReadFacts {
  readStatus: '' | 'ok' | 'review' | 'needs_approval' | 'retry';
  models: string;
  finalModel: string;
  costUsd: number;
  costIsEstimate: boolean;
}

const money = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) / 1e6 : 0);

/** Ends an invoice as failed, with words safe to show. */
export function failInvoice(db: Db, id: number, message: string, facts: ReadFacts | null, now: number): void {
  if (facts) {
    db.prepare("UPDATE purchase_invoices SET state = 'failed', message = ?, read_status = ?, models = ?, final_model = ?, cost_usd = ?, cost_is_estimate = ?, updated_at = ? WHERE id = ?").run(
      message,
      facts.readStatus,
      facts.models,
      facts.finalModel,
      money(facts.costUsd),
      facts.costIsEstimate ? 1 : 0,
      now,
      id,
    );
  } else {
    db.prepare("UPDATE purchase_invoices SET state = 'failed', message = ?, updated_at = ? WHERE id = ?").run(message, now, id);
  }
}

/**
 * The recorded invoice with the same vendor and invoice number that refuses a new old invoice, or
 * null: an invoice run that was not stopped first, then an old invoice. A stopped run does not
 * refuse it; the old invoice then wins over that run in the download.
 */
export function recordedDuplicate(db: Db, vendor: string, invoiceNumber: string, exceptId: number): PurchaseInvoice | null {
  const vk = companyKey(vendor);
  const nk = normalizeInvoiceNumber(invoiceNumber);
  if (vk === '' || nk === '') return null;
  const r = db
    .prepare(
      `SELECT p.* FROM purchase_invoices p LEFT JOIN runs r ON r.id = p.run_id
       WHERE p.state = 'done' AND p.vendor_key = ? AND p.invoice_number_key = ? AND p.id <> ? AND ${NOT_STOPPED}
       ORDER BY p.source = 'run' DESC, p.id LIMIT 1`,
    )
    .get(vk, nk, exceptId) as DbInvoice | undefined;
  return r ? fromDb(r) : null;
}

/** For an old invoice: the invoice run that counts and has the same vendor and number, or null. */
export function runCopyOf(db: Db, inv: PurchaseInvoice): number | null {
  if (inv.source !== 'old' || inv.state !== 'done') return null;
  const vk = companyKey(inv.vendor);
  const nk = normalizeInvoiceNumber(inv.invoiceNumber);
  if (vk === '' || nk === '') return null;
  const r = db
    .prepare(`SELECT p.run_id AS id FROM purchase_invoices p JOIN runs r ON r.id = p.run_id WHERE p.source = 'run' AND p.vendor_key = ? AND p.invoice_number_key = ? AND r.state <> 'failed' ORDER BY p.run_id DESC LIMIT 1`)
    .get(vk, nk) as { id: number } | undefined;
  return r ? r.id : null;
}

export type RecordOutcome = { recorded: true } | { recorded: false; duplicateOf: PurchaseInvoice };

/**
 * Saves the reading's lines and marks the invoice done, in one transaction. When the same vendor
 * and invoice number is already recorded, nothing is saved and the duplicate is returned.
 */
export function recordReading(db: Db, id: number, reading: HistoryReading, rawReading: unknown, facts: ReadFacts, now: number): RecordOutcome {
  return inTransaction(db, () => {
    const dup = recordedDuplicate(db, reading.vendor, reading.invoiceNumber, id);
    if (dup) return { recorded: false, duplicateOf: dup };
    const ins = db.prepare(
      `INSERT INTO purchase_lines (invoice_id, n, page, file_position, item_number, upc, description, brand, product, pack_size, units_per_pack, pack,
        qty_shipped, unit, weight, unit_price, price_unit, allowance, extension, qty, qty_unit, price_per, extension_cents, printed_status, confidence,
        confidence_note, needs_check, reasons, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of reading.lines) {
      ins.run(
        id,
        l.n,
        l.page,
        l.filePosition,
        l.itemNumber,
        l.upc,
        l.description,
        l.brand,
        l.product,
        l.packSize,
        l.unitsPerPack,
        l.pack,
        l.qtyShipped,
        l.unit,
        l.weight,
        l.unitPrice,
        l.priceUnit,
        l.allowance,
        l.extension,
        l.qty,
        l.qtyUnit,
        l.pricePer,
        l.extensionCents,
        l.printedStatus,
        l.confidence,
        l.confidenceNote,
        l.needsCheck ? 1 : 0,
        JSON.stringify(l.reasons),
        JSON.stringify(l.notes),
      );
    }
    const flagged = reading.lines.filter((l) => l.needsCheck).length;
    const message = reading.lines.length === 0 ? 'Read, but no product lines were found. Check the photos.' : flagged ? `Recorded. ${flagged} ${flagged === 1 ? 'line needs' : 'lines need'} a check against the photo.` : 'Recorded.';
    db.prepare(
      `UPDATE purchase_invoices SET state = 'done', vendor = ?, vendor_key = ?, invoice_number = ?, invoice_number_key = ?, invoice_date = ?, invoice_date_iso = ?,
        total_cents = ?, read_status = ?, models = ?, final_model = ?, cost_usd = ?, cost_is_estimate = ?, checks = ?, notes = ?, reading = ?, line_count = ?,
        needs_check_count = ?, message = ?, updated_at = ? WHERE id = ?`,
    ).run(
      reading.vendor,
      companyKey(reading.vendor),
      reading.invoiceNumber,
      normalizeInvoiceNumber(reading.invoiceNumber),
      reading.invoiceDate,
      reading.invoiceDateIso,
      reading.totalCents,
      facts.readStatus,
      facts.models,
      facts.finalModel,
      money(facts.costUsd),
      facts.costIsEstimate ? 1 : 0,
      JSON.stringify(reading.invoiceFlags),
      JSON.stringify(reading.invoiceNotes),
      JSON.stringify(rawReading ?? null),
      reading.lines.length,
      flagged,
      message,
      now,
      id,
    );
    return { recorded: true };
  });
}

/**
 * Removes an old invoice, its lines and its file records, for a wrong upload. Returns the stored
 * file names so the caller deletes the files. The audit line keeps what was removed.
 */
export function removePurchaseInvoice(db: Db, actor: AuditActor, id: number, now: number): string[] {
  return inTransaction(db, () => {
    const inv = getPurchaseInvoice(db, id);
    if (!inv) throw new HistoryError('There is no such old invoice.', 404);
    if (inv.source === 'run') throw new HistoryError(`This one is invoice run ${inv.runId}. It leaves the history only if that run is stopped.`, 409);
    if (inv.state === 'reading') throw new HistoryError('This invoice is being read right now. Wait for it to finish, then remove it.', 409);
    const files = purchaseFiles(db, id);
    db.prepare('DELETE FROM purchase_invoices WHERE id = ?').run(id);
    appendAudit(
      db,
      actor,
      {
        action: 'history.remove',
        entityType: ENTITY,
        entityId: id,
        details: {
          state: inv.state,
          vendor: inv.vendor,
          invoiceNumber: inv.invoiceNumber,
          invoiceDate: inv.invoiceDateIso || inv.invoiceDate,
          lines: inv.lineCount,
          uploadedBy: inv.createdByName,
          uploadedAt: new Date(inv.createdAt).toISOString(),
          files: files.map((f) => ({ name: f.originalName, sha256: f.sha256 })),
        },
      },
      now,
    );
    return files.map((f) => f.storedName);
  });
}

/** Drops the file records of an invoice (a refused duplicate). Returns the stored names. */
export function dropFiles(db: Db, id: number): string[] {
  const files = purchaseFiles(db, id);
  db.prepare('DELETE FROM purchase_files WHERE invoice_id = ?').run(id);
  return files.map((f) => f.storedName);
}

// Model spend. The same ledger as invoice runs, so the daily limit covers both.

/** Writes a reading's worst case before it goes out. Returns the ledger row id. */
export function reserveReadSpend(db: Db, invoiceId: number, usd: number, now: number): number {
  const res = db
    .prepare("INSERT INTO model_spend (run_id, source, purchase_invoice_id, kind, variation_id, state, usd, estimate, at, updated_at) VALUES (NULL, 'history', ?, 'read', '', 'reserved', ?, 1, ?, ?)")
    .run(invoiceId, money(usd), now, now);
  return Number(res.lastInsertRowid);
}

/** Replaces the reservation with the real cost. */
export function settleReadSpend(db: Db, spendId: number, usd: number, now: number): void {
  db.prepare("UPDATE model_spend SET state = 'booked', usd = ?, estimate = 0, updated_at = ? WHERE id = ?").run(money(usd), now, spendId);
}

/** Books an old invoice's reservation left by a restart at its worst case. */
export function bookCutShortReads(db: Db, now: number): number {
  const rows = db.prepare("SELECT id, purchase_invoice_id AS pid, usd FROM model_spend WHERE state = 'reserved' AND source = 'history'").all() as Array<{ id: number; pid: number | null; usd: number }>;
  for (const r of rows) {
    db.prepare("UPDATE model_spend SET state = 'booked', estimate = 1, updated_at = ? WHERE id = ?").run(now, r.id);
    appendAudit(db, SYSTEM_ACTOR, { action: 'history.spend_cut_short', entityType: ENTITY, entityId: r.pid ?? '', details: { bookedUsd: r.usd, costIsEstimate: true } }, now);
  }
  return rows.length;
}

/** What all model calls have cost, or may have, since the given time: readings, old and new, and card copy. */
export function spendSince(db: Db, since: number): number {
  const r = db.prepare('SELECT coalesce(sum(usd), 0) AS usd FROM model_spend WHERE at >= ?').get(since) as { usd: number };
  return Number(r.usd) || 0;
}

/** What old invoice readings alone have cost, or may have, since the given time, removed ones included. */
export function historySpendSince(db: Db, since: number): number {
  const r = db.prepare("SELECT coalesce(sum(usd), 0) AS usd FROM model_spend WHERE source = 'history' AND at >= ?").get(since) as { usd: number };
  return Number(r.usd) || 0;
}

// The spreadsheet

export interface ExportRow {
  source: PurchaseSource;
  /** The old invoice number, or the run number for a run. */
  sourceId: number;
  /** A run that was read and then stopped: every line needs a check. */
  stopped: boolean;
  /** The purchase_invoices row, and when it was recorded: later recorded wins a tie on date. */
  invoiceId: number;
  recordedAt: number;
  /** The vendor folded, so two spellings of one vendor group together. */
  vendorKey: string;
  vendor: string;
  invoiceDateIso: string;
  invoiceDate: string;
  invoiceNumber: string;
  line: PurchaseLineRow;
}

/**
 * The invoices the spreadsheet uses: one copy of each invoice. Of copies that share a vendor and
 * an invoice number, the highest rank wins, then the newer one:
 *   3 a run that was approved or sent,
 *   2 any other run that was not stopped,
 *   1 an old invoice,
 *   0 a run that was stopped.
 * Invoices with no vendor or number read are all kept.
 */
const KEPT = `
  WITH cand AS (
    SELECT p.id, p.vendor_key AS vk, p.invoice_number_key AS nk,
      CASE
        WHEN p.source = 'old' THEN 1
        WHEN r.state = 'failed' THEN 0
        WHEN r.state IN ('approved', 'sending', 'partial', 'done') THEN 3
        ELSE 2
      END AS rank
    FROM purchase_invoices p LEFT JOIN runs r ON r.id = p.run_id
    WHERE p.state = 'done' AND ${COUNTS}
  ),
  kept AS (
    SELECT c.id FROM cand c
    WHERE c.vk = '' OR c.nk = '' OR NOT EXISTS (
      SELECT 1 FROM cand d WHERE d.id <> c.id AND d.vk = c.vk AND d.nk = c.nk AND (d.rank > c.rank OR (d.rank = c.rank AND d.id > c.id))
    )
  )`;

/**
 * Lines of every invoice the spreadsheet uses, oldest invoice first. With from or to, only
 * invoices whose date was read and falls in that range, both ends included.
 */
export function exportRows(db: Db, range: { from?: string; to?: string } = {}, limit = 1_000_000): ExportRow[] {
  const where = ['p.id IN (SELECT id FROM kept)'];
  const args: string[] = [];
  if (range.from) {
    where.push("p.invoice_date_iso <> '' AND p.invoice_date_iso >= ?");
    args.push(range.from);
  }
  if (range.to) {
    where.push("p.invoice_date_iso <> '' AND p.invoice_date_iso <= ?");
    args.push(range.to);
  }
  const rows = db
    .prepare(
      `${KEPT}
       SELECT l.*, p.source AS p_source, p.id AS p_id, p.run_id AS p_run, r.state AS p_run_state, p.created_at AS p_created, p.vendor_key AS p_vendor_key, p.vendor AS p_vendor, p.invoice_date_iso AS p_date_iso, p.invoice_date AS p_date, p.invoice_number AS p_number
       FROM purchase_lines l JOIN purchase_invoices p ON p.id = l.invoice_id LEFT JOIN runs r ON r.id = p.run_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.invoice_date_iso = '', p.invoice_date_iso, p.vendor COLLATE NOCASE, p.invoice_number, p.id, l.n
       LIMIT ?`,
    )
    .all(...args, limit) as unknown as Array<
    DbLine & { p_source: PurchaseSource; p_id: number; p_run: number | null; p_run_state: string | null; p_created: number; p_vendor_key: string; p_vendor: string; p_date_iso: string; p_date: string; p_number: string }
  >;
  return rows.map((r) => ({
    source: r.p_source,
    sourceId: r.p_source === 'run' ? r.p_run! : r.p_id,
    stopped: r.p_source === 'run' && r.p_run_state === 'failed',
    invoiceId: r.p_id,
    recordedAt: r.p_created,
    vendorKey: r.p_vendor_key,
    vendor: r.p_vendor,
    invoiceDateIso: r.p_date_iso,
    invoiceDate: r.p_date,
    invoiceNumber: r.p_number,
    line: lineFromDb(r),
  }));
}
