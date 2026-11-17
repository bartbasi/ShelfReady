// Read-only access to the LIVE Square account, for copying the catalog into
// data/ (store data, out of git). Square personal tokens cannot be limited to
// reading, so this module is the limit:
//   - it exports only three fixed read functions, never a general sender;
//   - each builds its own URL from known parts, and the private sender checks
//     the parsed URL against READ_CALLS before anything is sent;
//   - the token is loaded and shape-checked here, never passed in.
// The pre-commit hook refuses any other staged file that names the live token
// key or the live Square host, so new code cannot go around this module.
import { devEnvValue, devEnvValueOrEmpty } from '../lib/dev-env.ts';

const LIVE = 'https://connect.squareup.com';
const SQUARE_VERSION = '2025-10-16';

/** The only calls this module sends. Each is a read, the POST included. */
const READ_CALLS: ReadonlySet<string> = new Set([
  'GET /v2/locations',
  'GET /v2/catalog/list',
  'POST /v2/inventory/counts/batch-retrieve',
]);

function liveToken(): string {
  for (const v of ['NODE_TLS_REJECT_UNAUTHORIZED', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[v]) throw new Error(`Refusing to run with ${v} set: the live token must go straight to Square.`);
  }
  const token = devEnvValue('SQUARE_LIVE_READONLY_TOKEN');
  if (!/^EAAA[A-Za-z0-9_-]{16,196}$/.test(token)) {
    throw new Error('SQUARE_LIVE_READONLY_TOKEN in dev.env does not look like a Square access token. Check that line.');
  }
  if (token === devEnvValueOrEmpty('SQUARE_SANDBOX_ACCESS_TOKEN')) {
    throw new Error('SQUARE_LIVE_READONLY_TOKEN is the same as the sandbox token. Check dev.env.');
  }
  return token;
}

async function send(method: 'GET' | 'POST', url: URL, body?: unknown): Promise<any> {
  if (url.origin !== LIVE) throw new Error('Refusing to call anything but live Square');
  const call = `${method} ${url.pathname}`;
  if (!READ_CALLS.has(call)) throw new Error(`Refusing ${call}: not a read call this module allows`);
  if (method === 'GET' && body !== undefined) throw new Error('A GET call takes no body');
  const res = await fetch(url, {
    method,
    redirect: 'error',
    headers: { Authorization: `Bearer ${liveToken()}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.errors?.length) {
    const errs = (json.errors ?? []).map((e: any) => String(e.code).replace(/[^A-Z0-9_]/g, '')).join(', ');
    throw new Error(`Square ${call} failed (HTTP ${res.status}) ${errs}`);
  }
  return json;
}

/** Checks the token before any call, so a bad token fails before anything is sent. */
export function checkLiveToken(): void {
  liveToken();
}

export async function listLocations(): Promise<any[]> {
  return (await send('GET', new URL('/v2/locations', LIVE))).locations ?? [];
}

/** One page of the catalog. `types` is a comma list of catalog object types. */
export async function catalogPage(types: string, cursor: string): Promise<{ objects: any[]; cursor: string }> {
  if (!/^[A-Z_]+(,[A-Z_]+)*$/.test(types)) throw new Error('Bad catalog types');
  const url = new URL('/v2/catalog/list', LIVE);
  url.searchParams.set('types', types);
  if (cursor) url.searchParams.set('cursor', cursor);
  const r = await send('GET', url);
  return { objects: r.objects ?? [], cursor: r.cursor ?? '' };
}

/** One page of stock counts for up to 500 variations at one location. */
export async function countsPage(variationIds: string[], locationId: string, cursor: string): Promise<{ counts: any[]; cursor: string }> {
  if (variationIds.length === 0 || variationIds.length > 500) throw new Error('Pass 1 to 500 variation ids');
  const body: Record<string, unknown> = { catalog_object_ids: variationIds, location_ids: [locationId] };
  if (cursor) body.cursor = cursor;
  const r = await send('POST', new URL('/v2/inventory/counts/batch-retrieve', LIVE), body);
  return { counts: r.counts ?? [], cursor: r.cursor ?? '' };
}
