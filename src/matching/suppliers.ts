// Suppliers and the names they print. One supplier can print its name several ways ("Acme
// Foods", "ACME FOODS INC."), so each name it has used is kept as an alias and found by a key.
// Two names are only joined when a person says they are the same supplier: a saved mapping
// applied to the wrong supplier would put stock on the wrong item.
//
// Names are compared with the same folding pricing uses for vendor formulas in settings
// (src/lib/names.ts). Every change is written to the audit log with the user and time.

import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { companyKey } from '../lib/names.ts';
import { checkUpcItemRule, type UpcItemRule } from './upc.ts';

const MAX_NAME = 120;

export interface Supplier {
  id: number;
  name: string;
  aliases: string[];
  upcItemRule: UpcItemRule | null;
}

/** A name a person typed or an invoice printed that cannot be used. Safe to show. */
export class SupplierError extends Error {}

/** The key two printings of one supplier's name share: "Acme Foods, Inc." and "ACME FOODS" both give "acme foods". */
export function supplierKey(name: string): string {
  return companyKey(name.slice(0, MAX_NAME));
}

function cleanName(name: string): string {
  const t = name.replace(/\s+/g, ' ').trim();
  if (t === '' || t.length > MAX_NAME || /[\p{Cc}\p{Cf}]/u.test(t)) throw new SupplierError('A supplier name must be 1 to 120 plain characters.');
  if (supplierKey(t) === '') throw new SupplierError('A supplier name needs at least one letter or digit beyond words like Inc.');
  return t;
}

interface SupplierRow {
  id: number;
  name: string;
  upc_item_rule: string;
}

function load(db: Db, row: SupplierRow): Supplier {
  const aliases = (db.prepare('SELECT alias FROM supplier_aliases WHERE supplier_id = ? ORDER BY created_at, alias').all(row.id) as { alias: string }[]).map((r) => r.alias);
  let rule: UpcItemRule | null = null;
  if (row.upc_item_rule !== '') {
    try {
      rule = checkUpcItemRule(JSON.parse(row.upc_item_rule));
    } catch {
      rule = null;
    }
  }
  return { id: row.id, name: row.name, aliases, upcItemRule: rule };
}

export function getSupplier(db: Db, id: number): Supplier | null {
  const row = db.prepare('SELECT id, name, upc_item_rule FROM suppliers WHERE id = ?').get(id) as SupplierRow | undefined;
  return row ? load(db, row) : null;
}

/** The supplier that has used this name before, or null. */
export function findSupplier(db: Db, printedName: string): Supplier | null {
  const key = supplierKey(printedName);
  if (key === '') return null;
  const row = db
    .prepare('SELECT s.id, s.name, s.upc_item_rule FROM supplier_aliases a JOIN suppliers s ON s.id = a.supplier_id WHERE a.alias_key = ?')
    .get(key) as SupplierRow | undefined;
  return row ? load(db, row) : null;
}

export function listSuppliers(db: Db): Supplier[] {
  return (db.prepare('SELECT id, name, upc_item_rule FROM suppliers ORDER BY name COLLATE NOCASE, id').all() as unknown as SupplierRow[]).map((r) => load(db, r));
}

/**
 * Known suppliers whose names look like this one, best first, for a person to confirm or reject.
 * Never used to join suppliers on its own.
 */
export function suggestSuppliers(db: Db, printedName: string, limit = 3): Supplier[] {
  const key = supplierKey(printedName);
  if (key === '') return [];
  const mine = new Set(key.split(' '));
  const rows = db.prepare('SELECT alias_key, supplier_id FROM supplier_aliases').all() as { alias_key: string; supplier_id: number }[];
  const bestBySupplier = new Map<number, number>();
  for (const r of rows) {
    const theirs = new Set(r.alias_key.split(' '));
    const shared = [...mine].filter((w) => theirs.has(w)).length;
    const score = shared / new Set([...mine, ...theirs]).size;
    const prefix = r.alias_key.startsWith(`${key} `) || key.startsWith(`${r.alias_key} `);
    const s = prefix ? Math.max(score, 0.6) : score;
    if (s >= 0.5 && s > (bestBySupplier.get(r.supplier_id) ?? 0)) bestBySupplier.set(r.supplier_id, s);
  }
  return [...bestBySupplier.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id]) => getSupplier(db, id)!)
    .filter(Boolean);
}

/** Which vendor formula in settings applies to a supplier. */
export type VendorLink =
  | { status: 'none' }
  | { status: 'one'; vendor: string }
  | { status: 'ambiguous'; vendors: string[]; problem: string };

/**
 * The vendor formula in pricing settings for this supplier. A settings vendor is this supplier
 * when its name folds to one of the names the supplier has used (the same folding settings use,
 * so two settings lines can never fold to one name). Linking a vendor whose name differs from
 * every printed name means adding that name as an alias, which a person does. When the
 * supplier's names fit more than one vendor formula, the result says so in plain words for the
 * review screen, and pricing must not pick one.
 */
export function vendorForSupplier(supplier: Supplier, settingsVendors: readonly string[]): VendorLink {
  const mine = new Set(supplier.aliases.map(supplierKey));
  const hits = settingsVendors.filter((v) => mine.has(supplierKey(v)));
  if (hits.length === 0) return { status: 'none' };
  if (hits.length === 1) return { status: 'one', vendor: hits[0]! };
  return {
    status: 'ambiguous',
    vendors: hits,
    problem: `Ambiguous vendor formula: ${hits.join(', ')} in settings all fit ${supplier.name}. Remove or rename all but one before pricing this supplier.`,
  };
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

/** Adds a supplier under the name an invoice printed. Refuses a name another supplier already uses. */
export function createSupplier(db: Db, actor: AuditActor, printedName: string, now: number = Date.now()): Supplier {
  const name = cleanName(printedName);
  return inTransaction(db, () => {
    if (findSupplier(db, name)) throw new SupplierError(`A supplier already uses the name ${name}.`);
    const res = db.prepare('INSERT INTO suppliers (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, iso(now), iso(now));
    const id = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO supplier_aliases (alias_key, supplier_id, alias, created_at) VALUES (?, ?, ?, ?)').run(supplierKey(name), id, name, iso(now));
    appendAudit(db, actor, { action: 'supplier.create', entityType: 'supplier', entityId: id, details: { name } }, now);
    return getSupplier(db, id)!;
  });
}

/** Records that a supplier also prints its name this way. A person must have said so. */
export function addSupplierAlias(db: Db, actor: AuditActor, supplierId: number, printedName: string, now: number = Date.now()): Supplier {
  const alias = cleanName(printedName);
  return inTransaction(db, () => {
    const s = getSupplier(db, supplierId);
    if (!s) throw new SupplierError('That supplier does not exist.');
    const owner = findSupplier(db, alias);
    if (owner && owner.id !== supplierId) throw new SupplierError(`The name ${alias} already belongs to ${owner.name}.`);
    if (owner) return s;
    db.prepare('INSERT INTO supplier_aliases (alias_key, supplier_id, alias, created_at) VALUES (?, ?, ?, ?)').run(supplierKey(alias), supplierId, alias, iso(now));
    db.prepare('UPDATE suppliers SET updated_at = ? WHERE id = ?').run(iso(now), supplierId);
    appendAudit(db, actor, { action: 'supplier.alias_add', entityType: 'supplier', entityId: supplierId, details: { alias } }, now);
    return getSupplier(db, supplierId)!;
  });
}

/** Removes one name from a supplier. The last name cannot be removed. */
export function removeSupplierAlias(db: Db, actor: AuditActor, supplierId: number, printedName: string, now: number = Date.now()): Supplier {
  const key = supplierKey(printedName);
  return inTransaction(db, () => {
    const s = getSupplier(db, supplierId);
    if (!s) throw new SupplierError('That supplier does not exist.');
    const row = db.prepare('SELECT alias FROM supplier_aliases WHERE alias_key = ? AND supplier_id = ?').get(key, supplierId) as { alias: string } | undefined;
    if (!row) throw new SupplierError('That supplier does not use this name.');
    if (s.aliases.length <= 1) throw new SupplierError('A supplier must keep at least one name.');
    db.prepare('DELETE FROM supplier_aliases WHERE alias_key = ?').run(key);
    db.prepare('UPDATE suppliers SET updated_at = ? WHERE id = ?').run(iso(now), supplierId);
    appendAudit(db, actor, { action: 'supplier.alias_remove', entityType: 'supplier', entityId: supplierId, details: { alias: row.alias } }, now);
    return getSupplier(db, supplierId)!;
  });
}

/** Sets or clears where this supplier's item number sits inside maker UPCs. */
export function setSupplierUpcRule(db: Db, actor: AuditActor, supplierId: number, rule: UpcItemRule | null, now: number = Date.now()): Supplier {
  const checked = rule === null ? null : checkUpcItemRule(rule);
  if (rule !== null && checked === null) throw new SupplierError('The UPC rule needs maker prefixes and digit positions between 1 and 11.');
  return inTransaction(db, () => {
    const s = getSupplier(db, supplierId);
    if (!s) throw new SupplierError('That supplier does not exist.');
    const text = checked ? JSON.stringify(checked) : '';
    db.prepare('UPDATE suppliers SET upc_item_rule = ?, updated_at = ? WHERE id = ?').run(text, iso(now), supplierId);
    appendAudit(db, actor, { action: 'supplier.upc_rule', entityType: 'supplier', entityId: supplierId, details: { from: s.upcItemRule, to: checked } }, now);
    return getSupplier(db, supplierId)!;
  });
}
