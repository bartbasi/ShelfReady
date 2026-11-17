// Case sizes and unit weights a person gave in review, saved with the line's match, so the next
// invoice that leaves them out still prices and stocks. A printed, certain pack always wins over
// a saved one; a saved value is shown on the line as "from saved match".

import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import type { CheckedLine, ModelLine } from '../invoice/types.ts';
import { lineKeys, lookupMapping } from '../matching/mapping.ts';

export interface SavedPack {
  mappingId: number;
  /** The variation it was given for. Used only while the line points there too. */
  variationId: string;
  unitsPerCase: number | null;
  poundsPerUnit: string | null;
  setByName: string;
}

export const UNITS_PER_CASE = /^[1-9][0-9]{0,3}$/;
export const POUNDS_PER_UNIT = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,4})?$/;

/** The pack saved for this supplier's line, found through the line's saved match. */
export function packForLine(db: Db, supplierId: number, line: ModelLine): SavedPack | null {
  const keys = lineKeys({ itemNumber: line.item_number, upc: line.upc, description: line.description, brand: line.brand });
  if (!keys) return null;
  const m = lookupMapping(db, supplierId, keys).exact;
  if (!m || m.kind !== 'square' || !m.variationId) return null;
  const r = db.prepare('SELECT variation_id, units_per_case, pounds_per_unit, set_by_name FROM item_mapping_packs WHERE mapping_id = ?').get(m.id) as
    | { variation_id: string; units_per_case: number | null; pounds_per_unit: string | null; set_by_name: string }
    | undefined;
  // A pack given for another item than the match now points to is not used.
  if (!r || r.variation_id !== m.variationId) return null;
  return { mappingId: m.id, variationId: r.variation_id, unitsPerCase: r.units_per_case, poundsPerUnit: r.pounds_per_unit, setByName: r.set_by_name };
}

export function savePack(db: Db, actor: AuditActor, mappingId: number, variationId: string, value: { unitsPerCase: number } | { poundsPerUnit: string }, now: number, runId?: number): void {
  inTransaction(db, () => {
    const units = 'unitsPerCase' in value ? value.unitsPerCase : null;
    const pounds = 'poundsPerUnit' in value ? value.poundsPerUnit : null;
    db.prepare(
      `INSERT INTO item_mapping_packs (mapping_id, variation_id, units_per_case, pounds_per_unit, set_by, set_by_name, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mapping_id) DO UPDATE SET variation_id = excluded.variation_id, units_per_case = excluded.units_per_case,
         pounds_per_unit = excluded.pounds_per_unit, set_by = excluded.set_by, set_by_name = excluded.set_by_name, set_at = excluded.set_at`,
    ).run(mappingId, variationId, units, pounds, actor.userId, actor.username, now);
    appendAudit(db, actor, { action: 'mapping.pack', entityType: 'item_mapping', entityId: mappingId, runId, details: { variationId, unitsPerCase: units, poundsPerUnit: pounds } }, now);
  });
}

/**
 * The line with a saved case size applied, when the invoice prices it per case and its own case
 * size is missing or uncertain. Nothing changes when the printed pack is certain.
 */
export function withSavedPack(cl: CheckedLine, saved: SavedPack | null): CheckedLine {
  if (!saved || saved.unitsPerCase === null) return cl;
  // The caller passes a pack only when the line points at the variation it was given for.
  if (cl.pack.pricePer !== 'case' || (cl.pack.sure && cl.pack.unitsPerCase !== null)) return cl;
  return { ...cl, pack: { ...cl.pack, unitsPerCase: saved.unitsPerCase, sure: true, note: `Case size from saved match: ${saved.unitsPerCase} units.` } };
}
