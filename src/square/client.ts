// The Square read client for the app: locations, the catalog and stock counts. Nothing here can
// send a write. Writes go through src/square/writer.ts, which shares the checks below.
//
// - The environment comes only from getSetting('squareEnvironment'), and this module also checks
//   the server config's allowSquareProduction itself, so a mistake in settings cannot reach live.
//   Live Square needs both (docs/GO-LIVE.md).
// - Each environment has one pinned origin (src/square/origins.ts, the only file in src that names
//   the live host, which the pre-commit hook enforces).
// - A caller can pin the environment for a whole read (expect): a call made after the setting
//   changed is refused, so one catalog never mixes the sandbox and live.
// - Every call is checked against READ_CALLS before it is sent. Redirects are refused.
// - The token comes from getSecret, is shape-checked, and is never logged, shown or put in an
//   error. Error messages carry only Square's error codes. It is sent only to the environment it
//   was saved for (tokenEnvironment), so a live token never goes to the sandbox, and the reverse.
// - Responses are shape-checked, and paging stops at a fixed number of pages.

import type { SettingValues, SecretName } from '../settings/schema.ts';
import { riskyEnvironment } from '../lib/risky-env.ts';
import { effectiveEnvironment, squareOrigin, SQUARE_SANDBOX_ORIGIN, type SquareEnv } from './origins.ts';

export { SQUARE_SANDBOX_ORIGIN };
export type { SquareEnv };
export const SQUARE_VERSION = '2025-10-16';

/** The only calls this client sends. Each is a read, the POST included. */
const READ_CALLS: ReadonlySet<string> = new Set(['GET /v2/locations', 'GET /v2/catalog/list', 'POST /v2/inventory/counts/batch-retrieve']);

/** Catalog types read for a run. Variations come nested in each ITEM. */
export const CATALOG_TYPES = 'ITEM,CATEGORY,TAX,MEASUREMENT_UNIT';

const MAX_PAGES = 400;
/** Largest response body read, in bytes. A catalog page is far smaller. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** A Square call that did not work. The message is safe to show: no token, no response text. */
export class SquareError extends Error {
  readonly codes: string[];
  readonly status: number | null;
  constructor(message: string, codes: string[] = [], status: number | null = null) {
    super(message);
    this.name = 'SquareError';
    this.codes = codes;
    this.status = status;
  }
}

export interface SquareLocation {
  id: string;
  name: string;
  status: string;
  timezone: string;
}

export interface InventoryCount {
  variationId: string;
  locationId: string;
  state: string;
  /** Decimal text as Square gives it, for example "4.5". */
  quantity: string;
}

/** What the run pipeline reads from Square. */
export interface SquareReader {
  /** The environment the next call would use: production only with both switches on. */
  environment(): SquareEnv;
  /** expect: refuse unless the call would go to this environment. */
  listLocations(expect?: SquareEnv): Promise<SquareLocation[]>;
  listCatalog(expect?: SquareEnv): Promise<unknown[]>;
  inventoryCounts(variationIds: readonly string[], locationId: string, expect?: SquareEnv): Promise<InventoryCount[]>;
}

/**
 * Handed to the dry run only so tests can prove it is never called. The real writer is
 * SquareWriteApi in src/square/writer.ts, used only by the send job.
 */
export interface SquareWriter {
  batchUpsertCatalog(objects: readonly unknown[]): Promise<unknown>;
  batchChangeInventory(changes: readonly unknown[]): Promise<unknown>;
}

export interface SquareReaderDeps {
  getSetting<K extends keyof SettingValues>(name: K): SettingValues[K];
  getSecret(name: SecretName): string | undefined;
  /** From the server config. Checked here as well as in settings. */
  allowSquareProduction: boolean;
  /**
   * The environment the saved token was entered for (Settings.squareTokenEnvironment). Left out,
   * the token counts as the sandbox's, so live Square is refused unless a caller says otherwise.
   */
  tokenEnvironment?: () => SquareEnv | null;
  /** Tests pass a fake. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Why a token cannot be used, in words that never repeat it. Null when its shape is fine. */
export function squareTokenProblem(token: unknown): string | null {
  if (typeof token !== 'string' || token === '') return 'No Square access token is set. An admin must add it in settings.';
  if (!/^EAAA[A-Za-z0-9_-]{16,196}$/.test(token)) return 'The Square access token in settings does not look like one. An admin must enter it again.';
  return null;
}

/** The environment used now. getSetting already locks production; this checks the config again. */
export function currentEnvironment(deps: Pick<SquareReaderDeps, 'getSetting' | 'allowSquareProduction'>): SquareEnv {
  return effectiveEnvironment(deps.getSetting('squareEnvironment'), deps.allowSquareProduction);
}

/** The origin for the environment used now, refusing when it is not the one expected. */
function environmentOrigin(deps: SquareReaderDeps, expect: SquareEnv | undefined): string {
  const env = currentEnvironment(deps);
  if (expect !== undefined && env !== expect) {
    throw new SquareError('The Square environment in settings changed while ShelfReady was reading. Nothing read was kept. Try again.');
  }
  return squareOrigin(env);
}

/**
 * Why the saved token must not go to this environment, or null. Words safe to show; the token is
 * never in them. Left out, the token's environment counts as the sandbox.
 */
export function tokenEnvironmentProblem(tokenEnvironment: (() => SquareEnv | null) | undefined, env: SquareEnv): string | null {
  let saved: SquareEnv | null;
  try {
    saved = tokenEnvironment ? tokenEnvironment() : 'sandbox';
  } catch {
    return 'The Square access token in settings is damaged. An admin must enter it again.';
  }
  if (saved === null) return 'No Square access token is set. An admin must add it in settings.';
  if (saved === env) return null;
  const name = (e: SquareEnv) => (e === 'production' ? 'Square (live)' : 'the Square sandbox');
  return `The Square access token in settings was entered for ${name(saved)}, not ${name(env)}, so it is not sent. An admin must enter the token for ${name(env)} in the same save as the environment.`;
}

/** Refuses to call out while a proxy, certificate or key log setting is on (src/lib/risky-env.ts). */
export function checkEnvironment(): void {
  const risky = riskyEnvironment();
  if (risky === 'flag') throw new SquareError('ShelfReady will not call Square while Node runs with a proxy or certificate flag. The token must go straight to Square.');
  if (risky) throw new SquareError(`ShelfReady will not call Square while ${risky} is set. The token must go straight to Square.`);
}

export function errorCodes(json: unknown): string[] {
  const errs = (json as { errors?: unknown })?.errors;
  if (!Array.isArray(errs)) return [];
  return errs
    .slice(0, 10)
    .map((e) => String((e as { code?: unknown })?.code ?? '').replace(/[^A-Z0-9_]/g, '').slice(0, 60))
    .filter((c) => c !== '');
}

/** Reads the reply while counting bytes, and stops reading as soon as it passes the cap. */
export async function readJson(res: Response): Promise<unknown> {
  const tooLarge = () => new SquareError('Square sent a reply too large to read.');
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function asArray(v: unknown, what: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new SquareError(`Square sent ${what} in an unexpected shape.`);
  return v;
}

function asCursor(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > 2048 || /[\s\u0000-\u001f]/.test(v)) throw new SquareError('Square sent a page cursor in an unexpected shape.');
  return v;
}

function text(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

export function createSquareReader(deps: SquareReaderDeps): SquareReader {
  const doFetch = deps.fetch ?? fetch;

  async function send(method: 'GET' | 'POST', path: string, query: Record<string, string>, body: unknown, expect: SquareEnv | undefined): Promise<unknown> {
    checkEnvironment();
    const origin = environmentOrigin(deps, expect);
    const url = new URL(path, origin);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (url.origin !== origin) throw new SquareError('Refusing to call anything but Square.');
    const call = `${method} ${url.pathname}`;
    if (!READ_CALLS.has(call)) throw new SquareError(`Refusing ${call}: it is not a read call this client allows.`);
    if (method === 'GET' && body !== undefined) throw new SquareError('A GET call takes no body.');
    const bound = tokenEnvironmentProblem(deps.tokenEnvironment, currentEnvironment(deps));
    if (bound) throw new SquareError(bound);
    const token = deps.getSecret('squareAccessToken');
    const problem = squareTokenProblem(token);
    if (problem) throw new SquareError(problem);
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // The error can quote the request, so only fixed words go out.
      throw new SquareError(`Could not reach Square for ${call}. Check the network and try again.`);
    }
    const json = await readJson(res);
    const codes = errorCodes(json);
    if (res.status === 401) throw new SquareError('Square refused the access token. An admin must check it in settings.', codes, 401);
    if (!res.ok || codes.length) {
      throw new SquareError(`Square ${call} did not work (HTTP ${res.status})${codes.length ? `: ${codes.join(', ')}` : ''}.`, codes, res.status);
    }
    if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new SquareError(`Square ${call} sent a reply in an unexpected shape.`);
    return json;
  }

  return {
    environment: () => currentEnvironment(deps),

    async listLocations(expect) {
      const r = (await send('GET', '/v2/locations', {}, undefined, expect)) as { locations?: unknown };
      return asArray(r.locations, 'locations').map((l) => {
        const o = (l ?? {}) as Record<string, unknown>;
        return { id: text(o.id, 64), name: text(o.name), status: text(o.status, 20), timezone: text(o.timezone, 64) };
      });
    },

    async listCatalog(expect) {
      const out: unknown[] = [];
      let cursor = '';
      let pages = 0;
      do {
        if (++pages > MAX_PAGES) throw new SquareError('The Square catalog has more pages than expected. Stopping.');
        const r = (await send('GET', '/v2/catalog/list', cursor ? { types: CATALOG_TYPES, cursor } : { types: CATALOG_TYPES }, undefined, expect)) as { objects?: unknown; cursor?: unknown };
        out.push(...asArray(r.objects, 'catalog objects'));
        cursor = asCursor(r.cursor);
      } while (cursor);
      return out;
    },

    async inventoryCounts(variationIds, locationId, expect) {
      if (!/^[A-Za-z0-9]{4,64}$/.test(locationId)) throw new SquareError('The Square location id in settings does not look like one.');
      const ids = [...new Set(variationIds)];
      for (const id of ids) if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new SquareError('A catalog id does not look like a Square id.');
      const out: InventoryCount[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        let cursor = '';
        let pages = 0;
        do {
          if (++pages > MAX_PAGES) throw new SquareError('Square sent more pages of stock counts than expected. Stopping.');
          const body: Record<string, unknown> = { catalog_object_ids: ids.slice(i, i + 500), location_ids: [locationId] };
          if (cursor) body.cursor = cursor;
          const r = (await send('POST', '/v2/inventory/counts/batch-retrieve', {}, body, expect)) as { counts?: unknown; cursor?: unknown };
          for (const c of asArray(r.counts, 'stock counts')) {
            const o = (c ?? {}) as Record<string, unknown>;
            out.push({ variationId: text(o.catalog_object_id, 64), locationId: text(o.location_id, 64), state: text(o.state, 40), quantity: text(o.quantity, 40) });
          }
          cursor = asCursor(r.cursor);
        } while (cursor);
      }
      return out;
    },
  };
}
