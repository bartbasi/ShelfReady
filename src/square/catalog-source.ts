// Where a run gets the Square catalog and stock counts from.
//
// - squareCatalogSource: the Square API through the read client: the sandbox, or live Square once
//   both switches are on (docs/GO-LIVE.md). Its kind and label follow the environment used now.
//   A load is pinned to the environment it started in, and records it (square_sandbox or
//   square_production), so a run always knows which Square it was read in.
// - fileCatalogSource: a saved catalog JSON file, for dry runs in development against the
//   read-only copy of the live catalog (data/square/live-catalog.json, store data). It is chosen
//   by the server config (devCatalogFile), never by the browser, and it only ever reads the file.
//
// Both give the same shape, so matching, pricing and the dry run cannot tell them apart. Pages say
// which one a run used.

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { SquareReader } from './client.ts';
import { SquareError } from './client.ts';
import { catalogSourceLabel, envForSource, FILE_SOURCE_LABEL, sourceForEnv, type SquareSourceKind } from './origins.ts';

export type CatalogSourceKind = SquareSourceKind | 'file';

export interface CatalogData {
  source: CatalogSourceKind;
  locationId: string;
  /** ISO time the catalog was read. For a file, the time saved in it. */
  takenAt: string;
  objects: unknown[];
}

export interface CatalogSource {
  /** The kind a load would record now. For Square it follows the environment setting. */
  readonly kind: CatalogSourceKind;
  /** Plain words for pages: "Square sandbox" or "Square (live)". */
  readonly label: string;
  load(): Promise<CatalogData>;
  /**
   * In-stock quantity per variation at the location, as decimal text. Missing means no count.
   * expect: the kind of the run's catalog. The counts are refused if they would come from another.
   */
  counts(variationIds: readonly string[], locationId: string, expect?: CatalogSourceKind): Promise<Map<string, string>>;
}

/**
 * Words for a run's recorded catalog source. The source in use gives its own label (a test fake
 * names itself); any other recorded source gets its fixed label. For the real sources the two are
 * the same, so a dry run's label never depends on which environment is in use when it is checked.
 */
export function catalogLabelFor(current: Pick<CatalogSource, 'kind' | 'label'>, recorded: string): string {
  return recorded === current.kind ? current.label : catalogSourceLabel(recorded);
}

function inStock(list: Array<{ variationId: string; locationId: string; state: string; quantity: string }>, ids: ReadonlySet<string>, locationId: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of list) {
    if (c.state !== 'IN_STOCK' || c.locationId !== locationId || !ids.has(c.variationId)) continue;
    if (!/^-?\d{1,9}(\.\d{1,5})?$/.test(c.quantity)) continue;
    out.set(c.variationId, c.quantity);
  }
  return out;
}

export function squareCatalogSource(reader: SquareReader, locationId: () => string, now: () => number = Date.now): CatalogSource {
  return {
    get kind() {
      return sourceForEnv(reader.environment());
    },
    get label() {
      return catalogSourceLabel(sourceForEnv(reader.environment()));
    },
    async load() {
      // Every read of one load goes to the environment it started in.
      const env = reader.environment();
      const loc = locationId();
      if (!loc) throw new SquareError('No Square location id is set. An admin must set it in settings.');
      const locations = await reader.listLocations(env);
      const here = locations.find((l) => l.id === loc);
      if (!here) throw new SquareError('The Square location id in settings is not one of this Square account\'s locations.');
      if (here.status !== 'ACTIVE') throw new SquareError('The Square location in settings is not active.');
      const objects = await reader.listCatalog(env);
      return { source: sourceForEnv(env), locationId: loc, takenAt: new Date(now()).toISOString(), objects };
    },
    async counts(variationIds, loc, expect) {
      const env = expect === undefined ? reader.environment() : envForSource(expect);
      if (env === null) throw new SquareError('Stock counts come only from Square.');
      if (variationIds.length === 0) return new Map();
      const list = await reader.inventoryCounts(variationIds, loc, env);
      return inStock(list, new Set(variationIds), loc);
    },
  };
}

/** Largest catalog file read. The live copy is about 1.5 MB. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

interface FileShape {
  takenAt: string;
  locationId: string;
  objects: unknown[];
  counts: Array<{ variationId: string; locationId: string; state: string; quantity: string }>;
}

function readCatalogFile(path: string): FileShape {
  // Read only, through one descriptor, never following a symlink at the last step.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_FILE_BYTES) throw new Error('too large');
    raw = readFileSync(fd, 'utf8');
  } catch {
    throw new SquareError('The saved catalog file could not be read.');
  } finally {
    closeSync(fd);
  }
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new SquareError('The saved catalog file is not valid JSON.');
  }
  const loc = (j.location ?? {}) as Record<string, unknown>;
  const locationId = typeof loc.id === 'string' ? loc.id.slice(0, 64) : '';
  if (!Array.isArray(j.objects) || !locationId) throw new SquareError('The saved catalog file has no objects or no location.');
  const counts = (Array.isArray(j.counts) ? j.counts : []).map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 64) : '');
    return { variationId: s(o.catalog_object_id), locationId: s(o.location_id), state: s(o.state), quantity: s(o.quantity) };
  });
  const takenAt = typeof j.takenAt === 'string' && !Number.isNaN(Date.parse(j.takenAt)) ? new Date(j.takenAt).toISOString() : new Date(0).toISOString();
  return { takenAt, locationId, objects: j.objects, counts };
}

export function fileCatalogSource(path: string): CatalogSource {
  return {
    kind: 'file',
    label: FILE_SOURCE_LABEL,
    async load() {
      const f = readCatalogFile(path);
      return { source: 'file', locationId: f.locationId, takenAt: f.takenAt, objects: f.objects };
    },
    async counts(variationIds, loc, expect) {
      if (expect !== undefined && expect !== 'file') throw new SquareError('Stock counts for a Square run never come from a saved file.');
      const f = readCatalogFile(path);
      return inStock(f.counts, new Set(variationIds), loc);
    },
  };
}
