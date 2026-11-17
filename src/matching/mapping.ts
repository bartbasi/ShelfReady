// The saved mapping: what each supplier item is in Square, or that the store does not sell it.
// It grows as the manager confirms matches, so the same line matches on its own next time.
//
// A row is found by the supplier and the line's key: the item number as printed when there is
// one, else the UPC, else the description. Item numbers are also compared with the letter O as
// 0 and I as 1 (normalizeItemNumber), because a model can read either way. Two real item
// numbers can differ only in that way, so a row found only through that lookalike key is
// returned apart, and the matcher confirms it by UPC or description before using it.
//
// Every confirm, change and removal is written to the audit log with the user and time.

import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { normalizeItemNumber } from '../invoice/item-number.ts';
import type { CatalogIndex } from './catalog.ts';
import { getSupplier } from './suppliers.ts';
import { foldText, words } from './text.ts';
import { readUpc } from './upc.ts';

const MAX_ITEM_NUMBER = 40;
const MAX_INVOICE_NAME = 300;
const MAX_BRAND = 80;
/** Most wordings kept per saved match. The newest are kept. */
const MAX_WORDINGS = 20;
const MAX_STORE_NAME = 255;

export type MappingKind = 'square' | 'not_for_resale';

export interface Mapping {
  id: number;
  supplierId: number;
  lineKey: string;
  itemNumber: string;
  itemKey: string;
  upcKey: string;
  invoiceName: string;
  invoiceBrand: string;
  kind: MappingKind;
  variationId: string | null;
  itemId: string | null;
  /** The name the store uses for this item: the label title by default. */
  storeName: string;
  confirmedBy: number | null;
  confirmedByName: string;
  confirmedAt: string;
  /** Every wording a person confirmed for this item, oldest first. invoiceName is the latest. */
  wordings: Wording[];
}

/** One way a supplier printed an item: its description and brand. */
export interface Wording {
  description: string;
  brand: string;
}

/** The parts of an invoice line that identify the supplier's item. */
export interface LineIdentity {
  itemNumber: string;
  upc: string;
  description: string;
  /** The brand column, when the invoice has one. */
  brand?: string;
}

export interface LineKeys {
  /** 'n:' item number, 'u:' UPC or 'd:' description. */
  lineKey: string;
  /** Item number as printed, upper case, no spaces. */
  rawItem: string;
  /** Item number with O as 0 and I as 1. */
  itemKey: string;
  /** 14-digit key of a valid printed UPC, or ''. */
  upcKey: string;
}

/** A request that cannot be saved. Safe to show. */
export class MappingError extends Error {}

/** The keys a line is saved and found under, or null when it has nothing to go by. */
export function lineKeys(line: LineIdentity): LineKeys | null {
  const rawItem = line.itemNumber.replace(/\s+/g, '').toUpperCase().slice(0, MAX_ITEM_NUMBER);
  const itemKey = rawItem === '' ? '' : normalizeItemNumber(rawItem);
  const upcKey = readUpc(line.upc).key ?? '';
  const descKey = words(line.description.split('|')[0] ?? '').join(' ').slice(0, 200);
  const lineKey = rawItem !== '' ? `n:${rawItem}` : upcKey !== '' ? `u:${upcKey}` : descKey !== '' ? `d:${descKey}` : null;
  return lineKey ? { lineKey, rawItem, itemKey, upcKey } : null;
}

interface MappingDbRow {
  id: number;
  supplier_id: number;
  line_key: string;
  item_number: string;
  item_key: string;
  upc_key: string;
  invoice_name: string;
  invoice_brand: string;
  kind: MappingKind;
  square_variation_id: string | null;
  square_item_id: string | null;
  store_name: string;
  confirmed_by: number | null;
  confirmed_by_name: string;
  confirmed_at: string;
}

function toMapping(r: MappingDbRow, wordings: Wording[] = []): Mapping {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    lineKey: r.line_key,
    itemNumber: r.item_number,
    itemKey: r.item_key,
    upcKey: r.upc_key,
    invoiceName: r.invoice_name,
    invoiceBrand: r.invoice_brand,
    kind: r.kind,
    variationId: r.square_variation_id,
    itemId: r.square_item_id,
    storeName: r.store_name,
    confirmedBy: r.confirmed_by,
    confirmedByName: r.confirmed_by_name,
    confirmedAt: r.confirmed_at,
    wordings,
  };
}

/** The confirmed wordings of the given rows, oldest first, keyed by row id. */
function wordingsOf(db: Db, rows: MappingDbRow[]): Map<number, Wording[]> {
  const out = new Map<number, Wording[]>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const found = db
    .prepare(`SELECT mapping_id, description, brand FROM item_mapping_wordings WHERE mapping_id IN (${ids.map(() => '?').join(',')}) ORDER BY confirmed_at, rowid`)
    .all(...ids) as { mapping_id: number; description: string; brand: string }[];
  for (const w of found) out.set(w.mapping_id, [...(out.get(w.mapping_id) ?? []), { description: w.description, brand: w.brand }]);
  return out;
}

function withWordings(db: Db, rows: MappingDbRow[]): Mapping[] {
  const all: Mapping[] = [];
  // In slices, so a large mapping never makes one query with too many parameters.
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    const w = wordingsOf(db, part);
    for (const r of part) all.push(toMapping(r, w.get(r.id) ?? []));
  }
  return all;
}

export function getMapping(db: Db, id: number): Mapping | null {
  const r = db.prepare('SELECT * FROM item_mappings WHERE id = ?').get(id) as MappingDbRow | undefined;
  return r ? withWordings(db, [r])[0]! : null;
}

export function mappingsForSupplier(db: Db, supplierId: number): Mapping[] {
  return withWordings(db, db.prepare('SELECT * FROM item_mappings WHERE supplier_id = ? ORDER BY id').all(supplierId) as unknown as MappingDbRow[]);
}

export interface MappingLookup {
  /** The row saved under exactly this line's key. */
  exact: Mapping | null;
  /** Rows whose item number matches only with O read as 0 or I as 1. Confirm before use. */
  lookalikes: Mapping[];
}

export function lookupMapping(db: Db, supplierId: number, keys: LineKeys): MappingLookup {
  const exactRow = db.prepare('SELECT * FROM item_mappings WHERE supplier_id = ? AND line_key = ?').get(supplierId, keys.lineKey) as MappingDbRow | undefined;
  const lookalikes =
    keys.itemKey === ''
      ? []
      : withWordings(db, db.prepare('SELECT * FROM item_mappings WHERE supplier_id = ? AND item_key = ? AND line_key <> ? ORDER BY id').all(supplierId, keys.itemKey, keys.lineKey) as unknown as MappingDbRow[]);
  return { exact: exactRow ? withWordings(db, [exactRow])[0]! : null, lookalikes };
}

export type MappingTarget = { kind: 'square'; variationId: string; storeName?: string } | { kind: 'not_for_resale' };

export interface ConfirmInput {
  supplierId: number;
  line: LineIdentity;
  target: MappingTarget;
  /** The catalog the choice was made from. A Square target must be in it. */
  catalog: CatalogIndex;
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function oneLine(text: string, max: number): string {
  return text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** What the audit log keeps about a row: enough to see what it was, nothing secret. */
function auditView(m: Pick<Mapping, 'kind' | 'variationId' | 'storeName' | 'invoiceName' | 'invoiceBrand' | 'itemNumber' | 'upcKey'>): Record<string, unknown> {
  return { kind: m.kind, variationId: m.variationId, storeName: m.storeName, invoiceName: m.invoiceName, invoiceBrand: m.invoiceBrand, itemNumber: m.itemNumber, upc: m.upcKey };
}

/** One printing of an item, folded, with spaces and punctuation removed: the same wording twice gives one key. */
export function wordingKey(w: Wording): string {
  const compact = (t: string) => foldText(t).replace(/[^a-z0-9]+/g, '');
  return `${compact(w.description)}|${compact(w.brand)}`;
}

/** Keeps a wording a person confirmed, and at most MAX_WORDINGS of them per saved match, the newest. */
function addWording(db: Db, actor: AuditActor, mappingId: number, w: Wording, now: number): void {
  db.prepare(
    `INSERT INTO item_mapping_wordings (mapping_id, wording_key, description, brand, confirmed_by, confirmed_by_name, confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mapping_id, wording_key) DO NOTHING`,
  ).run(mappingId, wordingKey(w), w.description, w.brand, actor.userId, actor.username, iso(now));
  db.prepare(
    `DELETE FROM item_mapping_wordings WHERE mapping_id = ? AND rowid NOT IN
       (SELECT rowid FROM item_mapping_wordings WHERE mapping_id = ? ORDER BY confirmed_at DESC, rowid DESC LIMIT ?)`,
  ).run(mappingId, mappingId, MAX_WORDINGS);
}

/**
 * Saves what a person chose for a line: a Square variation, or not for resale. Creates the row,
 * or changes the one saved under the same key. The line's wording is kept with the match, so a
 * supplier that prints one item several ways needs each wording confirmed once. Confirming the
 * same choice for a new wording adds the wording; a different choice starts the wordings again,
 * since the old ones were confirmed for the old choice. Saving the same choice and wording again
 * changes nothing.
 */
export function confirmMapping(db: Db, actor: AuditActor, input: ConfirmInput, now: number = Date.now()): Mapping {
  const keys = lineKeys(input.line);
  if (!keys) throw new MappingError('This line has no item number, UPC or description to save the match under.');
  let variationId: string | null = null;
  let itemId: string | null = null;
  let storeName = '';
  if (input.target.kind === 'square') {
    const v = input.catalog.variationById.get(input.target.variationId);
    if (!v) throw new MappingError('That Square item is not in the catalog. Refresh the catalog and pick again.');
    variationId = v.id;
    itemId = v.itemId;
    storeName = oneLine(input.target.storeName ?? '', MAX_STORE_NAME) || v.label;
  }
  const invoiceName = oneLine(input.line.description, MAX_INVOICE_NAME);
  const invoiceBrand = oneLine(input.line.brand ?? '', MAX_BRAND);
  const wording: Wording = { description: invoiceName, brand: invoiceBrand };
  const itemNumber = oneLine(input.line.itemNumber, MAX_ITEM_NUMBER);
  const next = { kind: input.target.kind, variationId, storeName, invoiceName, invoiceBrand, itemNumber, upcKey: keys.upcKey };
  return inTransaction(db, () => {
    if (!getSupplier(db, input.supplierId)) throw new MappingError('That supplier does not exist.');
    const existing = lookupMapping(db, input.supplierId, keys).exact;
    if (existing) {
      const sameChoice = existing.kind === next.kind && existing.variationId === next.variationId;
      const rowSame = sameChoice && existing.storeName === next.storeName && existing.itemNumber === next.itemNumber && existing.upcKey === next.upcKey;
      const known = existing.wordings.some((w) => wordingKey(w) === wordingKey(wording));
      if (rowSame && known) return existing;
      db.prepare(
        `UPDATE item_mappings SET item_number = ?, item_key = ?, upc_key = ?, invoice_name = ?, invoice_brand = ?, kind = ?, square_variation_id = ?,
         square_item_id = ?, store_name = ?, confirmed_by = ?, confirmed_by_name = ?, confirmed_at = ? WHERE id = ?`,
      ).run(itemNumber, keys.itemKey, keys.upcKey, invoiceName, invoiceBrand, next.kind, variationId, itemId, storeName, actor.userId, actor.username, iso(now), existing.id);
      if (!sameChoice) {
        db.prepare('DELETE FROM item_mapping_wordings WHERE mapping_id = ?').run(existing.id);
        // A case size given for the old item is not the new item's.
        db.prepare('DELETE FROM item_mapping_packs WHERE mapping_id = ?').run(existing.id);
      }
      addWording(db, actor, existing.id, wording, now);
      if (rowSame) {
        appendAudit(db, actor, { action: 'mapping.wording_add', entityType: 'item_mapping', entityId: existing.id, details: { supplierId: input.supplierId, wording } }, now);
      } else {
        appendAudit(db, actor, { action: 'mapping.change', entityType: 'item_mapping', entityId: existing.id, details: { supplierId: input.supplierId, from: auditView(existing), to: next } }, now);
      }
      return getMapping(db, existing.id)!;
    }
    const res = db
      .prepare(
        `INSERT INTO item_mappings (supplier_id, line_key, item_number, item_key, upc_key, invoice_name, invoice_brand, kind, square_variation_id,
         square_item_id, store_name, confirmed_by, confirmed_by_name, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.supplierId, keys.lineKey, itemNumber, keys.itemKey, keys.upcKey, invoiceName, invoiceBrand, next.kind, variationId, itemId, storeName, actor.userId, actor.username, iso(now));
    const id = Number(res.lastInsertRowid);
    addWording(db, actor, id, wording, now);
    appendAudit(db, actor, { action: 'mapping.confirm', entityType: 'item_mapping', entityId: id, details: { supplierId: input.supplierId, to: next } }, now);
    return getMapping(db, id)!;
  });
}

/** Changes the store name a mapping carries, for example after the label title is edited. */
export function setMappingStoreName(db: Db, actor: AuditActor, id: number, storeName: string, now: number = Date.now()): Mapping {
  const name = oneLine(storeName, MAX_STORE_NAME);
  return inTransaction(db, () => {
    const m = getMapping(db, id);
    if (!m) throw new MappingError('That saved match does not exist.');
    if (m.kind !== 'square') throw new MappingError('An item marked not for resale has no store name.');
    if (name === '') throw new MappingError('The store name cannot be empty.');
    if (name === m.storeName) return m;
    db.prepare('UPDATE item_mappings SET store_name = ?, confirmed_by = ?, confirmed_by_name = ?, confirmed_at = ? WHERE id = ?').run(name, actor.userId, actor.username, iso(now), id);
    appendAudit(db, actor, { action: 'mapping.change', entityType: 'item_mapping', entityId: id, details: { supplierId: m.supplierId, from: auditView(m), to: { ...auditView(m), storeName: name } } }, now);
    return getMapping(db, id)!;
  });
}

/** Removes a saved match. The line will need a person again next time. */
export function removeMapping(db: Db, actor: AuditActor, id: number, now: number = Date.now()): void {
  inTransaction(db, () => {
    const m = getMapping(db, id);
    if (!m) throw new MappingError('That saved match does not exist.');
    db.prepare('DELETE FROM item_mappings WHERE id = ?').run(id);
    appendAudit(db, actor, { action: 'mapping.remove', entityType: 'item_mapping', entityId: id, details: { supplierId: m.supplierId, from: auditView(m) } }, now);
  });
}

export type StaleKind = 'missing' | 'archived' | 'not_offered_here';

export interface StaleMapping {
  mapping: Mapping;
  kind: StaleKind;
  /** Plain words for a refresh report. */
  message: string;
}

/**
 * Saved matches that point at a Square variation the given catalog no longer has (deleted or
 * gone), or whose item is archived or not offered at the store. For a report after the
 * catalog is refreshed, so a person can pick again before the next invoice needs it.
 */
export function staleMappings(db: Db, catalog: CatalogIndex): StaleMapping[] {
  const rows = withWordings(db, db.prepare("SELECT * FROM item_mappings WHERE kind = 'square' ORDER BY supplier_id, id").all() as unknown as MappingDbRow[]);
  const out: StaleMapping[] = [];
  for (const m of rows) {
    const v = m.variationId ? catalog.variationById.get(m.variationId) : undefined;
    const item = v ? catalog.itemById.get(v.itemId) : undefined;
    const what = `${m.itemNumber || m.invoiceName || 'a supplier item'} (saved as ${m.storeName || 'unknown'})`;
    if (!v || !item) out.push({ mapping: m, kind: 'missing', message: `${what}: the Square item is no longer in the catalog.` });
    else if (item.archived) out.push({ mapping: m, kind: 'archived', message: `${what}: the Square item is archived.` });
    else if (!item.availableHere || !v.availableHere) out.push({ mapping: m, kind: 'not_offered_here', message: `${what}: the Square item is not offered at this store location.` });
  }
  return out;
}


/** Everything about one saved match, kept so a later undo can put it back exactly. */
export interface MappingSnapshot {
  row: Record<string, string | number | null>;
  wordings: Array<Record<string, string | number | null>>;
  pack: Record<string, string | number | null> | null;
}

const ROW_FIELDS = [
  'item_number',
  'item_key',
  'upc_key',
  'invoice_name',
  'invoice_brand',
  'kind',
  'square_variation_id',
  'square_item_id',
  'store_name',
  'confirmed_by',
  'confirmed_by_name',
  'confirmed_at',
] as const;

export function snapshotMapping(db: Db, id: number): MappingSnapshot | null {
  const row = db.prepare('SELECT * FROM item_mappings WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
  if (!row) return null;
  const wordings = db
    .prepare('SELECT wording_key, description, brand, confirmed_by, confirmed_by_name, confirmed_at FROM item_mapping_wordings WHERE mapping_id = ? ORDER BY rowid')
    .all(id) as Array<Record<string, string | number | null>>;
  const pack = (db.prepare('SELECT variation_id, units_per_case, pounds_per_unit, set_by, set_by_name, set_at FROM item_mapping_packs WHERE mapping_id = ?').get(id) ?? null) as Record<
    string,
    string | number | null
  > | null;
  return { row, wordings, pack };
}

/**
 * Puts a saved match back as a snapshot recorded it: its target, store name, wordings and pack.
 * The row must still exist under the same id, supplier and key. Audited as a restore.
 */
export function restoreMapping(db: Db, actor: AuditActor, snap: MappingSnapshot, now: number = Date.now()): Mapping {
  return inTransaction(db, () => {
    const id = Number(snap.row.id);
    const current = getMapping(db, id);
    if (!current || current.supplierId !== Number(snap.row.supplier_id) || current.lineKey !== snap.row.line_key) {
      throw new MappingError('The saved match to put back is no longer there.');
    }
    db.prepare(`UPDATE item_mappings SET ${ROW_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...ROW_FIELDS.map((f) => snap.row[f] ?? null), id);
    db.prepare('DELETE FROM item_mapping_wordings WHERE mapping_id = ?').run(id);
    const ins = db.prepare(
      'INSERT INTO item_mapping_wordings (mapping_id, wording_key, description, brand, confirmed_by, confirmed_by_name, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const w of snap.wordings) ins.run(id, w.wording_key, w.description, w.brand, w.confirmed_by, w.confirmed_by_name, w.confirmed_at);
    db.prepare('DELETE FROM item_mapping_packs WHERE mapping_id = ?').run(id);
    const p = snap.pack;
    if (p) {
      db.prepare('INSERT INTO item_mapping_packs (mapping_id, variation_id, units_per_case, pounds_per_unit, set_by, set_by_name, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        p.variation_id,
        p.units_per_case,
        p.pounds_per_unit,
        p.set_by,
        p.set_by_name,
        p.set_at,
      );
    }
    const restored = getMapping(db, id)!;
    appendAudit(db, actor, { action: 'mapping.restore', entityType: 'item_mapping', entityId: id, details: { supplierId: restored.supplierId, from: auditView(current), to: auditView(restored), pack: p ? { unitsPerCase: p.units_per_case, poundsPerUnit: p.pounds_per_unit } : null } }, now);
    return restored;
  });
}
