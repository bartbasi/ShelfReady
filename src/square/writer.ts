// The Square write client, for sending an approved run (Phase 1 step 7, live from November 16).
//
// - Each client is pinned to one environment: the one the run's catalog was read in. It refuses
//   every call when the environment used now (the setting, with the config switch) is another
//   one, so a run read in the sandbox can never write live, and the reverse.
// - Live Square needs both switches: allowSquareProduction in the server config and the setting
//   squareEnvironment production (docs/GO-LIVE.md, CLAUDE.md rule 4, approved November 16). Each
//   environment's origin is pinned (src/square/origins.ts).
// - Every call is checked against WRITE_CALLS before it is sent: two reads (catalog objects and
//   stock counts) and two writes (catalog upsert and inventory changes). Redirects are refused.
// - Every write body is checked here as well as where it is built (defence in depth): updates
//   only (no creates, no deletes), at most 8 variations per catalog call, never an item and its
//   own variation in one call, at most 25 inventory changes per call, no catalog_object_type,
//   occurred_at within the last 24 hours and not in the future, the store's location only.
// - Square's REST API ignores sparse_update and replaces the whole object (seen in the sandbox
//   on November 7, 2026: a variation sent with only a price lost its UPC, tracking and location
//   override). So the caller always sends full objects read just before. sparse_update is still
//   sent as true, as the cc-case-cards skill asks, but nothing depends on it.
// - A write whose reply is lost (no answer, a timeout, a 5xx) throws SquareWriteUnknown: it may or
//   may not have landed. The caller sends the same body with the same idempotency key again, and
//   Square answers with the first result instead of applying it twice.
// - The token comes from getSecret, is shape-checked and appears only in the Authorization
//   header. Errors carry Square's error codes and fixed words, never reply text.

import type { SecretName, SettingValues } from '../settings/schema.ts';
import { checkEnvironment, errorCodes, readJson, SQUARE_VERSION, SquareError, squareTokenProblem, tokenEnvironmentProblem, type InventoryCount } from './client.ts';
import { effectiveEnvironment, squareOrigin, SQUARE_LIVE_LABEL, SQUARE_SANDBOX_LABEL, type SquareEnv } from './origins.ts';

export type Json = Record<string, unknown>;

/** The only calls this client sends. */
const WRITE_CALLS: ReadonlySet<string> = new Set([
  'POST /v2/catalog/batch-retrieve',
  'POST /v2/catalog/batch-upsert',
  'POST /v2/inventory/changes/batch-create',
  'POST /v2/inventory/counts/batch-retrieve',
]);
const WRITES: ReadonlySet<string> = new Set(['POST /v2/catalog/batch-upsert', 'POST /v2/inventory/changes/batch-create']);

export const MAX_VARIATIONS_PER_CALL = 8;
export const MAX_INVENTORY_CHANGES_PER_CALL = 25;
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 3600_000;

/** A write whose reply was lost. It may or may not have landed: send the same body and key again. */
export class SquareWriteUnknown extends SquareError {
  constructor(message: string, codes: string[] = [], status: number | null = null) {
    super(message, codes, status);
    this.name = 'SquareWriteUnknown';
  }
}

export interface UpsertBody {
  idempotency_key: string;
  sparse_update: true;
  batches: [{ objects: Json[] }];
}

export interface InventoryBody {
  idempotency_key: string;
  ignore_unchanged_counts: false;
  changes: Json[];
}

export interface SquareWriteApi {
  /** The environment this client writes to, fixed when it is made. */
  readonly environment: SquareEnv;
  /** Catalog objects by id, as Square holds them now. An ITEM comes with its variations. Missing ids are left out. */
  retrieveObjects(ids: readonly string[]): Promise<Json[]>;
  batchUpsert(body: UpsertBody): Promise<{ objects: Json[] }>;
  changeInventory(body: InventoryBody): Promise<{ counts: InventoryCount[] }>;
  inventoryCounts(variationIds: readonly string[], locationId: string): Promise<InventoryCount[]>;
}

export interface SquareWriteDeps {
  getSetting<K extends keyof SettingValues>(name: K): SettingValues[K];
  getSecret(name: SecretName): string | undefined;
  /** The store's Square location. Inventory writes must name it. */
  locationId: () => string;
  /** The environment this client is for: the one the run's catalog was read in. Default sandbox. */
  environment?: SquareEnv;
  /** From the server config. Live writes need it, as well as the setting. Default false. */
  allowSquareProduction?: boolean;
  /** The environment the saved token was entered for. Left out, the sandbox: live is then refused. */
  tokenEnvironment?: () => SquareEnv | null;
  /** Tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const QTY_RE = /^\d{1,9}(\.\d{1,5})?$/;

function obj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

/**
 * A refusal by this client before anything left: the request never reached Square. A write whose
 * earlier answer was lost stays unknown when this happens, since its first try may have landed.
 */
export class SquareNotSent extends SquareError {
  constructor(message: string) {
    super(message);
    this.name = 'SquareNotSent';
  }
}

function refuse(message: string): never {
  throw new SquareNotSent(`Refused before sending: ${message}`);
}

/** Why this catalog upsert must not be sent. Throws a SquareError; returns nothing when it is fine. */
export function checkUpsertBody(body: UpsertBody): void {
  const b = obj(body);
  if (!b) refuse('the catalog write has no body.');
  const keys = Object.keys(b).sort().join(',');
  if (keys !== 'batches,idempotency_key,sparse_update') refuse('the catalog write has unexpected fields.');
  if (typeof b.idempotency_key !== 'string' || !KEY_RE.test(b.idempotency_key)) refuse('the catalog write has no idempotency key.');
  if (b.sparse_update !== true) refuse('sparse_update must be true.');
  if (!Array.isArray(b.batches) || b.batches.length !== 1) refuse('a catalog write holds exactly one batch.');
  const objects = obj(b.batches[0])?.objects;
  if (!Array.isArray(objects) || objects.length === 0) refuse('the catalog batch is empty.');
  const ids = new Set<string>();
  const items = new Set<string>();
  const parentsOfVariations = new Set<string>();
  let variations = 0;
  let itemCount = 0;
  for (const raw of objects) {
    const o = obj(raw);
    if (!o) refuse('a catalog object is not an object.');
    const id = o.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) refuse('a catalog object has no Square id. This client never creates objects.');
    if (ids.has(id)) refuse('the same object is in the batch twice.');
    ids.add(id);
    if (typeof o.version !== 'number' || !Number.isSafeInteger(o.version)) refuse('a catalog object has no version, so it could overwrite a newer change.');
    if (o.is_deleted === true) refuse('a deleted object cannot be written.');
    if (o.type === 'ITEM') {
      itemCount++;
      items.add(id);
      const vars = obj(o.item_data)?.variations;
      if (!Array.isArray(vars) || vars.length === 0) refuse('an item must be sent with its variations, or Square removes them.');
      for (const v of vars) {
        const vo = obj(v);
        if (!vo || typeof vo.id !== 'string' || !ID_RE.test(vo.id) || typeof vo.version !== 'number') refuse('an item carries a variation without its id and version.');
      }
      variations += vars.length;
    } else if (o.type === 'ITEM_VARIATION') {
      variations++;
      const parent = obj(o.item_variation_data)?.item_id;
      if (typeof parent !== 'string' || !ID_RE.test(parent)) refuse('a variation has no item id.');
      parentsOfVariations.add(parent);
    } else {
      refuse('only items and item variations are written.');
    }
  }
  for (const p of parentsOfVariations) if (items.has(p)) refuse('an item and its own variation cannot go in one call.');
  if (variations > MAX_VARIATIONS_PER_CALL && !(itemCount === 1 && objects.length === 1)) refuse(`at most ${MAX_VARIATIONS_PER_CALL} variations go in one catalog call.`);
}

/** Why this inventory write must not be sent. Throws a SquareError; returns nothing when it is fine. */
export function checkInventoryBody(body: InventoryBody, locationId: string, now: number): void {
  const b = obj(body);
  if (!b) refuse('the inventory write has no body.');
  const keys = Object.keys(b).sort().join(',');
  if (keys !== 'changes,idempotency_key,ignore_unchanged_counts') refuse('the inventory write has unexpected fields.');
  if (typeof b.idempotency_key !== 'string' || !KEY_RE.test(b.idempotency_key)) refuse('the inventory write has no idempotency key.');
  if (b.ignore_unchanged_counts !== false) refuse('ignore_unchanged_counts must be false.');
  if (!Array.isArray(b.changes) || b.changes.length === 0) refuse('the inventory write is empty.');
  if (b.changes.length > MAX_INVENTORY_CHANGES_PER_CALL) refuse(`at most ${MAX_INVENTORY_CHANGES_PER_CALL} inventory changes go in one call.`);
  if (!ID_RE.test(locationId)) refuse('no store location is set.');
  if (JSON.stringify(b.changes).includes('catalog_object_type')) refuse('catalog_object_type is read only on inventory writes.');
  for (const raw of b.changes) {
    const c = obj(raw);
    let d: Json | null = null;
    if (c?.type === 'PHYSICAL_COUNT') {
      d = obj(c.physical_count);
      if (!d || d.state !== 'IN_STOCK' || Object.keys(c).length !== 2) refuse('a stock count must set IN_STOCK.');
    } else if (c?.type === 'ADJUSTMENT') {
      d = obj(c.adjustment);
      if (!d || d.from_state !== 'IN_STOCK' || d.to_state !== 'WASTE' || Object.keys(c).length !== 2) refuse('a stock correction moves stock from IN_STOCK to WASTE only.');
      if (Number(d.quantity) <= 0) refuse('a stock correction must take out more than zero.');
    } else {
      refuse('only stock counts and stock corrections are written.');
    }
    if (typeof d.catalog_object_id !== 'string' || !ID_RE.test(d.catalog_object_id)) refuse('an inventory change has no variation id.');
    if (d.location_id !== locationId) refuse('an inventory change names another location.');
    if (typeof d.quantity !== 'string' || !QTY_RE.test(d.quantity)) refuse('an inventory change has a quantity Square cannot take.');
    const at = typeof d.occurred_at === 'string' ? Date.parse(d.occurred_at) : NaN;
    if (!Number.isFinite(at) || at > now + 1000 || at < now - DAY_MS + 60_000) refuse('occurred_at must be current, within the last 24 hours and not in the future.');
  }
}

function asArray(v: unknown, what: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new SquareError(`Square sent ${what} in an unexpected shape.`);
  return v;
}

function text(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function counts(list: unknown[]): InventoryCount[] {
  return list.map((c) => {
    const o = obj(c) ?? {};
    return { variationId: text(o.catalog_object_id, 64), locationId: text(o.location_id, 64), state: text(o.state, 40), quantity: text(o.quantity, 40) };
  });
}

export function createSquareWriteApi(deps: SquareWriteDeps): SquareWriteApi {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const pinned: SquareEnv = deps.environment === 'production' ? 'production' : 'sandbox';
  const allowLive = deps.allowSquareProduction === true;
  const origin = squareOrigin(pinned);

  async function send(path: string, body: unknown): Promise<Json> {
    // Everything up to the fetch is a local refusal: nothing reaches Square.
    try {
      checkEnvironment();
    } catch (err) {
      throw new SquareNotSent(err instanceof Error ? err.message : 'Refused before sending.');
    }
    // Live only with both switches on, and only for a client made for live. The environment used
    // now must be the one this client was made for: a run never mixes the two.
    if (pinned === 'production' && !allowLive) throw new SquareNotSent('Writes to live Square are refused. The server config does not allow live Square (allowSquareProduction).');
    const nowEnv = effectiveEnvironment(deps.getSetting('squareEnvironment'), allowLive);
    if (nowEnv !== pinned) {
      throw new SquareNotSent(`This send is for ${pinned === 'production' ? SQUARE_LIVE_LABEL : SQUARE_SANDBOX_LABEL}, but ShelfReady now uses ${nowEnv === 'production' ? SQUARE_LIVE_LABEL : SQUARE_SANDBOX_LABEL}. Nothing was sent. A run never mixes the two.`);
    }
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new SquareNotSent('Refusing to call anything but Square.');
    const call = `POST ${url.pathname}`;
    if (!WRITE_CALLS.has(call) || url.search !== '') throw new SquareNotSent(`Refusing ${call}: it is not a call this client allows.`);
    const write = WRITES.has(call);
    // The token goes only to the environment it was entered for.
    const bound = tokenEnvironmentProblem(deps.tokenEnvironment, pinned);
    if (bound) throw new SquareNotSent(bound);
    let token: string | undefined;
    try {
      token = deps.getSecret('squareAccessToken');
    } catch {
      throw new SquareNotSent('The Square access token in settings is damaged. An admin must enter it again.');
    }
    const problem = squareTokenProblem(token);
    if (problem) throw new SquareNotSent(problem);
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // The error can quote the request, so only fixed words go out.
      if (write) throw new SquareWriteUnknown(`Square did not answer ${call}. It may or may not have landed.`);
      throw new SquareError(`Could not reach Square for ${call}. Check the network and try again.`);
    }
    let json: unknown;
    try {
      json = await readJson(res);
    } catch (err) {
      if (write && res.ok) throw new SquareWriteUnknown(`Square's answer to ${call} could not be read. It may or may not have landed.`);
      throw err;
    }
    const codes = errorCodes(json);
    if (res.status === 401) throw new SquareError('Square refused the access token. An admin must check it in settings.', codes, 401);
    if (write && (res.status >= 500 || res.status === 408)) throw new SquareWriteUnknown(`Square had a problem with ${call} (HTTP ${res.status}). It may or may not have landed.`, codes, res.status);
    if (!res.ok || codes.length) throw new SquareError(`Square ${call} did not work (HTTP ${res.status})${codes.length ? `: ${codes.join(', ')}` : ''}.`, codes, res.status);
    const o = obj(json);
    if (!o) {
      if (write) throw new SquareWriteUnknown(`Square's answer to ${call} was not in the expected shape. It may or may not have landed.`);
      throw new SquareError(`Square ${call} sent a reply in an unexpected shape.`);
    }
    return o;
  }

  return {
    environment: pinned,

    async retrieveObjects(ids) {
      const unique = [...new Set(ids)];
      for (const id of unique) if (!ID_RE.test(id)) throw new SquareError('A catalog id does not look like a Square id.');
      const out: Json[] = [];
      for (let i = 0; i < unique.length; i += 100) {
        const r = await send('/v2/catalog/batch-retrieve', { object_ids: unique.slice(i, i + 100), include_related_objects: false });
        for (const o of asArray(r.objects, 'catalog objects')) {
          const j = obj(o);
          if (j) out.push(j);
        }
      }
      return out;
    },

    async batchUpsert(body) {
      checkUpsertBody(body);
      const r = await send('/v2/catalog/batch-upsert', body);
      return { objects: asArray(r.objects, 'catalog objects').map((o) => obj(o) ?? {}) };
    },

    async changeInventory(body) {
      checkInventoryBody(body, deps.locationId(), now());
      const r = await send('/v2/inventory/changes/batch-create', body);
      return { counts: counts(asArray(r.counts, 'stock counts')) };
    },

    async inventoryCounts(variationIds, locationId) {
      if (!ID_RE.test(locationId)) throw new SquareError('The Square location id does not look like one.');
      const ids = [...new Set(variationIds)];
      for (const id of ids) if (!ID_RE.test(id)) throw new SquareError('A catalog id does not look like a Square id.');
      const out: InventoryCount[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        let cursor = '';
        let pages = 0;
        do {
          if (++pages > 50) throw new SquareError('Square sent more pages of stock counts than expected. Stopping.');
          const body: Json = { catalog_object_ids: ids.slice(i, i + 500), location_ids: [locationId] };
          if (cursor) body.cursor = cursor;
          const r = await send('/v2/inventory/counts/batch-retrieve', body);
          out.push(...counts(asArray(r.counts, 'stock counts')));
          const c = r.cursor;
          cursor = typeof c === 'string' && c.length <= 2048 && !/[\s\u0000-\u001f]/.test(c) ? c : '';
        } while (cursor);
      }
      return out;
    },
  };
}
