// The catalog index for a run, built from the run's own saved catalog and kept in memory for a
// few runs at a time. Every decision is checked against this index, never against a newer
// catalog or anything the browser sends.

import type { Db } from '../db/db.ts';
import { buildCatalogIndex, type CatalogIndex } from '../matching/catalog.ts';
import { rawVariations, type RawVariation } from '../square/variation-state.ts';
import { loadCatalogSnapshot, type StoredCatalog } from './store.ts';

export interface RunCatalog {
  snapshot: Omit<StoredCatalog, 'objects'>;
  index: CatalogIndex;
  raw: Map<string, RawVariation>;
}

const MAX_CACHED = 4;

export function createCatalogCache(db: Db): { get(snapshotId: number): RunCatalog; clear(): void } {
  const cache = new Map<number, RunCatalog>();
  return {
    get(snapshotId) {
      const hit = cache.get(snapshotId);
      if (hit) {
        cache.delete(snapshotId);
        cache.set(snapshotId, hit);
        return hit;
      }
      const s = loadCatalogSnapshot(db, snapshotId);
      const built: RunCatalog = {
        snapshot: { id: s.id, sha256: s.sha256, source: s.source, locationId: s.locationId, takenAt: s.takenAt },
        index: buildCatalogIndex({ objects: s.objects, locationId: s.locationId }),
        raw: rawVariations(s.objects),
      };
      cache.set(snapshotId, built);
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      return built;
    },
    clear() {
      cache.clear();
    },
  };
}
