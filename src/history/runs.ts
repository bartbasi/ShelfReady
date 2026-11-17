// Invoice runs in the purchase history. When a run's reading is saved, its invoice and lines are
// recorded here with source 'run', using the same line mapping and needs-check rules as old
// invoices. When a person says what arrived on a line, or marks a line not arrived after approval,
// the run's lines are worked out again, so the history shows the corrected values.
//
// This reads the run tables with plain SQL. It imports no run code, and nothing here can reach
// Square, the scales or the cards. No model is called: the run's own reading is used, and its cost
// is already in the spend ledger under the run, so nothing is booked again here.
//
// Which runs count is decided when the history is read (src/history/store.ts COUNTS and KEPT):
// every run that was read. A stopped run stays with every line marked Needs check, unless another
// copy of the same invoice is recorded, which then wins over it.

import { appendAudit, SYSTEM_ACTOR } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { normalizeInvoiceNumber } from '../invoice/checks.ts';
import { formatCents } from '../invoice/money.ts';
import type { ReadAudit } from '../invoice/pipeline.ts';
import { buildInvoiceSettings, type InvoiceReadingSettings } from '../invoice/settings.ts';
import type { CheckedReading } from '../invoice/types.ts';
import { companyKey } from '../lib/names.ts';
import { filePositions, historyFromReading, type HistoryLine } from './lines.ts';

interface RunRowLite {
  id: number;
  state: string;
  created_by: number | null;
  created_by_name: string;
  created_at: number;
  read_status: string;
  read_result: string;
}

interface StoredRead {
  status?: string;
  reading?: CheckedReading | null;
  audit?: ReadAudit;
}

/** What a person said arrived on a line (run_decisions kind 'received'). */
interface Arrived {
  arrived: 'all' | 'none' | 'some';
  pieces?: string;
  pounds?: string;
}

/** Applies what a person said arrived, and corrections after approval, to one line. */
export function applyArrival(l: HistoryLine, arrived: Arrived | undefined, correctionCents: number | null): HistoryLine {
  const printed = [l.qty, l.qtyUnit].filter(Boolean).join(' ');
  const out: HistoryLine = { ...l, notes: [...l.notes] };
  if (correctionCents !== null) {
    out.qty = '0';
    out.notes.unshift(`Marked not arrived after approval. ${correctionCents ? `Credit to claim $${formatCents(correctionCents)}. ` : ''}The invoice says ${printed || 'a quantity'}.`);
    return out;
  }
  if (!arrived || arrived.arrived === 'all') return out;
  if (arrived.arrived === 'none') {
    out.qty = '0';
    out.notes.unshift(`Staff say none arrived. The invoice says ${printed || 'a quantity'}.`);
    return out;
  }
  if (arrived.pounds) {
    out.qty = arrived.pounds;
    out.qtyUnit = 'LB';
  } else if (arrived.pieces) {
    out.qty = arrived.pieces;
    out.qtyUnit = 'PC';
  }
  out.notes.unshift(`Staff say only part arrived. The invoice says ${printed || 'a quantity'}.`);
  return out;
}

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

const money = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) / 1e6 : 0);

/**
 * Records or refreshes one run's invoice and lines from what the run holds now. A run with no
 * reading has no row. Returns true when the run has a row afterwards.
 */
export function refreshRunHistory(db: Db, runId: number, now: number, settings: InvoiceReadingSettings = buildInvoiceSettings()): boolean {
  return inTransaction(db, () => {
    const run = db.prepare('SELECT id, state, created_by, created_by_name, created_at, read_status, read_result FROM runs WHERE id = ?').get(runId) as RunRowLite | undefined;
    const stored = run ? parse<StoredRead>(run.read_result) : null;
    const reading = stored?.reading ?? null;
    const existing = db.prepare("SELECT id FROM purchase_invoices WHERE source = 'run' AND run_id = ?").get(runId) as { id: number } | undefined;
    if (!run || !reading || !Array.isArray(reading.lines) || !reading.invoice) {
      if (existing) db.prepare('DELETE FROM purchase_invoices WHERE id = ?').run(existing.id);
      return false;
    }
    const input = stored?.audit?.input;
    const where = input ? filePositions(input.kind, input.files.length, (input.repeatedUploads ?? []).map((r) => r.index)) : () => 0;
    // The date window is measured from when the run was uploaded, so a refresh gives the same answer.
    const history = historyFromReading(reading, settings, where, { today: new Date(run.created_at) });
    const arrived = new Map<number, Arrived>();
    for (const d of db.prepare("SELECT target, value FROM run_decisions WHERE run_id = ? AND kind = 'received'").all(runId) as Array<{ target: string; value: string }>) {
      const v = parse<Arrived>(d.value);
      if (v && /^[1-9][0-9]{0,3}$/.test(d.target)) arrived.set(Number(d.target), v);
    }
    const corrections = new Map<number, number>();
    for (const c of db.prepare('SELECT line, credit_cents FROM run_corrections WHERE run_id = ?').all(runId) as Array<{ line: number; credit_cents: number }>) corrections.set(c.line, c.credit_cents);
    const lines = history.lines.map((l) => applyArrival(l, arrived.get(l.n), corrections.has(l.n) ? corrections.get(l.n)! : null));

    const audit = stored?.audit;
    const models = audit ? audit.attempts.map((a) => a.model).join(' then ') : '';
    const flagged = lines.filter((l) => l.needsCheck).length;
    const message = lines.length === 0 ? 'Read, but no product lines were found.' : flagged ? `Recorded from invoice run ${runId}. ${flagged} ${flagged === 1 ? 'line needs' : 'lines need'} a check.` : `Recorded from invoice run ${runId}.`;
    const fields = [
      history.vendor,
      companyKey(history.vendor),
      history.invoiceNumber,
      normalizeInvoiceNumber(history.invoiceNumber),
      history.invoiceDate,
      history.invoiceDateIso,
      history.totalCents,
      ['ok', 'review', 'needs_approval', 'retry'].includes(run.read_status) ? run.read_status : '',
      models,
      audit?.finalModel ?? '',
      // Shown on the page only. The ledger has this cost under the run already.
      money(audit?.totalCostUsd ?? 0),
      JSON.stringify(history.invoiceFlags),
      JSON.stringify(history.invoiceNotes),
      lines.length,
      flagged,
      message,
      now,
    ] as const;
    let id: number;
    if (existing) {
      id = existing.id;
      db.prepare('DELETE FROM purchase_lines WHERE invoice_id = ?').run(id);
      db.prepare(
        `UPDATE purchase_invoices SET vendor = ?, vendor_key = ?, invoice_number = ?, invoice_number_key = ?, invoice_date = ?, invoice_date_iso = ?, total_cents = ?,
          read_status = ?, models = ?, final_model = ?, cost_usd = ?, checks = ?, notes = ?, line_count = ?, needs_check_count = ?, message = ?, updated_at = ? WHERE id = ?`,
      ).run(...fields, id);
    } else {
      const res = db
        .prepare(
          `INSERT INTO purchase_invoices (source, run_id, state, created_by, created_by_name, created_at, vendor, vendor_key, invoice_number, invoice_number_key, invoice_date,
            invoice_date_iso, total_cents, read_status, models, final_model, cost_usd, checks, notes, line_count, needs_check_count, message, updated_at)
           VALUES ('run', ?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(runId, run.created_by, run.created_by_name, run.created_at, ...fields);
      id = Number(res.lastInsertRowid);
      appendAudit(db, SYSTEM_ACTOR, { action: 'history.run_recorded', entityType: 'purchase_invoice', entityId: id, runId, details: { lines: lines.length } }, now);
    }
    const ins = db.prepare(
      `INSERT INTO purchase_lines (invoice_id, n, page, file_position, item_number, upc, description, brand, product, pack_size, units_per_pack, pack,
        qty_shipped, unit, weight, unit_price, price_unit, allowance, extension, qty, qty_unit, price_per, extension_cents, printed_status, confidence,
        confidence_note, needs_check, reasons, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of lines) {
      ins.run(id, l.n, l.page, l.filePosition, l.itemNumber, l.upc, l.description, l.brand, l.product, l.packSize, l.unitsPerPack, l.pack, l.qtyShipped, l.unit, l.weight, l.unitPrice, l.priceUnit, l.allowance, l.extension, l.qty, l.qtyUnit, l.pricePer, l.extensionCents, l.printedStatus, l.confidence, l.confidenceNote, l.needsCheck ? 1 : 0, JSON.stringify(l.reasons), JSON.stringify(l.notes));
    }
    return true;
  });
}

/**
 * The same, for the run code to call. A failure here is caught and reported as false, so the
 * purchase history can never stop a run, a decision or a correction.
 */
export function recordRunInHistory(db: Db, runId: number, now: number, settings?: InvoiceReadingSettings): boolean {
  try {
    return refreshRunHistory(db, runId, now, settings);
  } catch {
    return false;
  }
}

/**
 * Records every run that has a reading and no row yet. Run once at start, with the store's
 * reading settings. Returns how many.
 */
export function backfillRuns(db: Db, now: number, settings?: InvoiceReadingSettings): number {
  const ids = (
    db
      .prepare("SELECT r.id FROM runs r WHERE r.read_status <> '' AND json_type(r.read_result, '$.reading') = 'object' AND NOT EXISTS (SELECT 1 FROM purchase_invoices p WHERE p.run_id = r.id) ORDER BY r.id")
      .all() as Array<{ id: number }>
  ).map((r) => r.id);
  let n = 0;
  for (const id of ids) if (recordRunInHistory(db, id, now, settings)) n++;
  return n;
}
