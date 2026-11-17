// Price overrides in the database, as pricing's OverrideStore. Step 6 reads them. Applying a run's
// override actions (keep, remove, set) happens when the run is sent, in step 7.

import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import type { OverrideStore, PriceOverride } from '../pricing/overrides.ts';

export function dbOverrideStore(db: Db): OverrideStore {
  const stmt = db.prepare('SELECT variation_id, price_cents, note, set_by_name, set_at FROM price_overrides WHERE variation_id = ?');
  return {
    get(variationId) {
      const r = stmt.get(variationId) as { variation_id: string; price_cents: number; note: string; set_by_name: string; set_at: number } | undefined;
      if (!r) return null;
      return { variationId: r.variation_id, priceCents: r.price_cents, note: r.note, setBy: r.set_by_name, setAt: new Date(r.set_at).toISOString() } satisfies PriceOverride;
    },
  };
}

/** Sets or replaces an override. Used by tests now, and by step 7 and Phase 2. */
export function setPriceOverride(db: Db, actor: AuditActor, variationId: string, priceCents: number, note: string, now: number, runId?: number): void {
  if (!Number.isSafeInteger(priceCents) || priceCents <= 0) throw new Error('An override price must be a whole number of cents above zero.');
  inTransaction(db, () => {
    const before = db.prepare('SELECT price_cents FROM price_overrides WHERE variation_id = ?').get(variationId) as { price_cents: number } | undefined;
    db.prepare(
      `INSERT INTO price_overrides (variation_id, price_cents, note, set_by, set_by_name, set_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(variation_id) DO UPDATE SET price_cents = excluded.price_cents, note = excluded.note, set_by = excluded.set_by,
         set_by_name = excluded.set_by_name, set_at = excluded.set_at`,
    ).run(variationId, priceCents, note.slice(0, 200), actor.userId, actor.username, now);
    appendAudit(db, actor, { action: 'override.set', entityType: 'square_variation', entityId: variationId, runId, details: { from: before?.price_cents ?? null, to: priceCents } }, now);
  });
}

/** Removes an override, if there is one. Used when a sent run's decision was to use the formula price. */
export function removePriceOverride(db: Db, actor: AuditActor, variationId: string, now: number, runId?: number): boolean {
  return inTransaction(db, () => {
    const before = db.prepare('SELECT price_cents FROM price_overrides WHERE variation_id = ?').get(variationId) as { price_cents: number } | undefined;
    if (!before) return false;
    db.prepare('DELETE FROM price_overrides WHERE variation_id = ?').run(variationId);
    appendAudit(db, actor, { action: 'override.remove', entityType: 'square_variation', entityId: variationId, runId, details: { from: before.price_cents } }, now);
    return true;
  });
}
