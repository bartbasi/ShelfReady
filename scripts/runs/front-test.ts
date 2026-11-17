// Phase 1 step 10: one real price change on the store's FRONT scale only, through the app's own
// routes, jobs and guards, then the same change back. Square is the SANDBOX only.
//
// Each step is its own command and stops, so a person sees each result before the next:
//
//   nice -n 19 node scripts/runs/front-test.ts plan plu=NNNN cost=X.XX
//   nice -n 19 node scripts/runs/front-test.ts preview [tick-big]
//   nice -n 19 node scripts/runs/front-test.ts send ack=CODE[,CODE...] [drift=TOKEN[,TOKEN...]]
//   nice -n 19 node scripts/runs/front-test.ts restore
//   nice -n 19 node scripts/runs/front-test.ts preview
//   nice -n 19 node scripts/runs/front-test.ts send ack=CODE[,CODE...]
//   nice -n 19 node scripts/runs/front-test.ts status [preview=ID | change=ID]
//   nice -n 19 node scripts/runs/front-test.ts clean yes
//
// Where ScaleConnect is: SCALECONNECT_URL in ~/.config/shelfready/dev.env, or else the server
// config's liveScaleConnectUrl (config/local/server.json, out of git). With neither, the script
// stops before contacting anything. Either way it must be plain http to an IPv4
// address of one of this PC's own network interfaces, path /mcp, so the token never leaves this
// PC. That is checked before every call that carries the token. plan with dev uses the dev harness
// on 127.0.0.1:18765 instead (for the tests). Options may also be written with two leading dashes.
//
// What each step contacts:
// - plan: the Square sandbox (read), and ScaleConnect's scale_list_scales and scale_get_item,
//   which contact no scale.
// - preview: the app reads the invoice (a stand-in, no model call), review, dry run, approve,
//   then Send with FRONT alone. The app writes the Square sandbox first and reads it back
//   (store/docs/DECISIONS.md decision 1), then asks ScaleConnect for a preview: one read of FRONT.
// - send: the app applies that preview by id. ScaleConnect reads FRONT before writing, writes,
//   and reads it back: two reads and one write.
// - restore: like plan, back to the price the scale had before the test. No scale contact.
// - status: scale_get_change and scale_list_scales, and the app's own lookup by preview id. No
//   scale contact, and never an apply.
// - clean: nothing, unless an apply may still be running; then scale_get_change only.
//
// Rules this keeps (CLAUDE.md rules 2, 3, 5, 6 and 12; ScaleConnect's docs/MCP.md):
// - Only FRONT. The app's writeScales guard is set to FRONT alone, and this script checks again
//   that the send, the preview and the result name FRONT alone.
// - The warnings and drift are accepted only as typed on the send command, and only if they are
//   exactly what the preview showed. Nothing is acknowledged on its own.
// - No retry, no second apply. A lost reply is looked up by preview id (status).
// - may_be_frozen anywhere stops the script at once.
// - Before anything that reads a scale: scale_list_scales must show no config_changed, no
//   scales_in_use, no interrupted change, nothing unfinished on FRONT and no scale that may be
//   frozen.
// - The ScaleConnect token is read from ~/.config/shelfready/dev.env (SCALECONNECT_TOKEN) by key
//   name. It is never printed and never in argv. In the app it is stored encrypted, in a database
//   in data/front-test (mode 700), with its master key in ~/.config/shelfready/front-test-keys.
// - Text from scales, the catalog and ScaleConnect is printed quoted and escaped, or filtered.
// - A test item gets no card sheet (ScaleConnect's test item rule).
// - The invoice weight is the sandbox's stock count now, so the stock count the run sets is the
//   one it already has, and neither run changes the sandbox's stock.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createUser, findUserByUsername, setPassword } from '../../src/auth/users.ts';
import { SYSTEM_ACTOR } from '../../src/db/audit.ts';
import { trailingScaleCode } from '../../src/lib/scale-code.ts';
import { formulaCents, shelfCentsForText } from '../../src/pricing/formula.ts';
import { soldByWeightInSquare } from '../../src/pricing/price.ts';
import { fromCents } from '../../src/pricing/rational.ts';
import { perPoundUnitIds, squareItemState } from '../../src/pricing/square-state.ts';
import type { ChangePreview } from '../../src/runs/preview.ts';
import { getSend, pendingRows, scaleSteps, updateScaleStep, type ScaleStepRow } from '../../src/runs/send-store.ts';
import { addEvent, getRun, type RunRow } from '../../src/runs/store.ts';
import type { LoggedChange } from '../../src/scaleconnect/client.ts';
import { connectScaleConnect, type ScaleApi } from '../../src/scaleconnect/connection.ts';
import { listenerProblem, localIPv4, readProcNet } from '../../src/scaleconnect/live-address.ts';
import { DEV_MCP_URL, readDevConnection } from '../../src/scaleconnect/dev-connection.ts';
import { buildApp, type AppDeps } from '../../src/server/app.ts';
import { loadConfig, makeConfig } from '../../src/server/config.ts';
import type { PriceFormula } from '../../src/settings/schema.ts';
import { fakeClient, image, invoice, line, testImage } from '../../test/invoice-fixtures.ts';
import { devEnvValueOrEmpty } from '../lib/dev-env.ts';
import { sandboxFetch, sandboxSettings } from '../square/sandbox-env.ts';

type J = Record<string, any>;

const REPO = fileURLToPath(new URL('../..', import.meta.url));
/** CLAUDE.md rule 3: FRONT is the test scale. The only scale this script lets the app write. */
export const TEST_SCALE = 'FRONT';
/** Moved to src/scaleconnect/live-address.ts for the app's own live connection. */
export { listenerProblem, localIPv4 };
/** The live ScaleConnect address in the server config (config/local/server.json), or empty. */
function configLiveUrl(): string {
  return loadConfig().liveScaleConnectUrl;
}
export const DEFAULT_STATE_DIR = join(REPO, 'data', 'front-test');
const KEY_DIR = join(homedir(), '.config', 'shelfready', 'front-test-keys');
const DB_FILE = 'shelfready.sqlite3';
const SUPPLIER = 'ShelfReady FRONT Test';
const USERNAME = 'fronttest';
/** The app calls an apply never applied this long after its preview ended (src/runs/scale-push.ts). */
const NEVER_APPLIED_AFTER_MS = 5 * 60_000;

/** A refusal or a stop, with words safe to show. code: the exit code. */
export class Stop extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.name = 'Stop';
    this.code = code;
  }
}
const FROZEN_EXIT = 3;
/** The scale result did not come back. Run status. */
const NOT_KNOWN_EXIT = 4;

// ---- The saved state

export interface TestRun {
  purpose: 'change' | 'restore';
  costText: string;
  newCents: number;
  /** The invoice weight: the sandbox's stock count when planned, or 1 when it had none to use. */
  pounds: string;
  /** The sandbox's stock count when planned, as Square gave it, or null. */
  stockBefore: string | null;
  /** ScaleConnect's list price and the sandbox price when this run was planned. */
  fromScaleCents: number;
  fromSquareCents: number | null;
  invoiceNumber: string;
  plannedAt: string;
  /** Over the big-change limit: review needs its own tick (preview tick-big). */
  needsBigTick: boolean;
  runId: number | null;
  previewId: string;
}

export interface FrontState {
  version: 1;
  mode: 'dev' | 'live';
  url: string;
  plu: string;
  scaleNames: string[];
  item: { itemId: string; variationId: string; name: string; poundUnitId: string };
  original: { scaleCents: number; squareCents: number | null; squareSale: 'weight' | 'register'; stock: string | null };
  runs: TestRun[];
  /** The scales named may be frozen when the script stopped, or null. */
  frozenStop: string[] | null;
}

// ---- Hooks, for the tests

/** The Square side: the sandbox, or a fake in tests. Reads only; the app does the writes. */
export interface SquareSide {
  locationId: string;
  /** What the app's settings need to reach the sandbox. */
  settings: { values: Record<string, string>; secrets: Record<string, string> };
  findItem(plu: string, dev: boolean): Promise<{ itemId: string; variationId: string }>;
  readItem(itemId: string): Promise<J | null>;
  poundUnitId(): Promise<string>;
  /** The in-stock count at the store's location, as Square gives it, or null. */
  stockCount(variationId: string): Promise<string | null>;
}

export interface FrontTestHooks {
  out?: (line: string) => void;
  stateDir?: string;
  square?: () => SquareSide;
  /** Extra app deps (the tests' fake Square, or a clock). */
  appDeps?: Partial<AppDeps>;
  /** Wraps the app's ScaleConnect client (the tests lose an apply's reply with it). */
  wrapScaleApi?: (api: ScaleApi) => ScaleApi;
  /** Reads a dev.env key by name (tests give the token and the address). */
  readEnv?: (key: string) => string;
  /** The server config's liveScaleConnectUrl, used when dev.env names no address. Default: read it. */
  configLiveUrl?: () => string;
  /** This PC's IPv4 addresses. Default: os.networkInterfaces(). */
  localAddresses?: () => string[];
  /** The text of /proc/net/tcp and tcp6. Default: read them. */
  procNet?: () => { tcp: string; tcp6: string };
  /** This process's uid. Default: process.getuid(). */
  uid?: number;
  /** The clock for clean. Default Date.now. */
  now?: () => number;
  /** Called after the app has the person's yes and before its job runs (a test stops here, as Ctrl-C would). */
  afterAck?: () => void;
}

interface Ctx {
  out: (line: string) => void;
  stateDir: string;
  keyPath: string;
  hooks: FrontTestHooks;
  args: Args;
}

// ---- Arguments

interface Args {
  command: string;
  values: Map<string, string>;
  flags: Set<string>;
}

const VALUE_NAMES = new Set(['plu', 'cost', 'ack', 'drift', 'preview', 'change']);
const FLAG_NAMES = new Set(['dev', 'tick-big', 'again', 'yes', 'frozen-cleared']);

export function parseArgs(argv: readonly string[]): Args {
  const [command = '', ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    let name: string;
    let value: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) value = a.slice(eq + 1);
      else if (VALUE_NAMES.has(name)) value = rest[++i];
    } else {
      const eq = a.indexOf('=');
      name = eq > 0 ? a.slice(0, eq) : a;
      if (eq > 0) value = a.slice(eq + 1);
    }
    if (VALUE_NAMES.has(name)) {
      if (value === undefined || value === '') throw new Stop(`${word(name)} needs a value, like ${word(name)}=...`, 2);
      values.set(name, value);
    } else if (FLAG_NAMES.has(name) && value === undefined) {
      flags.add(name);
    } else {
      throw new Stop(`Unknown option: ${data(name, 40)}.${name === 'url' ? ' The address now comes from SCALECONNECT_URL in dev.env, or liveScaleConnectUrl in the server config.' : ''}`, 2);
    }
  }
  return { command, values, flags };
}

// ---- Small helpers

const dollars = (c: number | null | undefined): string => (typeof c === 'number' ? `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}` : 'no price');
const priceText = (c: number): string => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
const percent = (from: number | null, to: number): string =>
  !from || from <= 0 ? 'no current price to compare' : from === to ? 'no change' : `${to > from ? 'up' : 'down'} ${Math.max(1, Math.round((Math.abs(to - from) * 100) / from))}%`;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');
const rec = (v: unknown): J => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});

/** Characters that can hide or reorder text on a terminal: DEL, the C1 controls and the direction marks. */
const HIDDEN = /[\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
const escapeChar = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Text that came from a scale, the catalog, an invoice or ScaleConnect: quoted, one line, short, escaped. */
export function data(v: unknown, max = 200): string {
  const t = typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  return JSON.stringify(t.slice(0, max)).replace(HIDDEN, escapeChar);
}

/** A ScaleConnect value that should be a plain word (a code, a scale name, a status, a token, an id). Anything else is shown quoted. */
export function word(v: unknown): string {
  return typeof v === 'string' && /^[A-Za-z0-9_:-]{1,200}$/.test(v) ? v : data(v, 80);
}

/** A line of ScaleConnect's own summary, or an error message: no quotes, but controls and direction marks escaped. */
export function plainText(v: unknown, max = 600): string {
  const t = typeof v === 'string' ? v : '';
  return t.slice(0, max).replace(/[\u0000-\u001f]/g, escapeChar).replace(HIDDEN, escapeChar);
}

/** A ScaleConnect time as local clock time, in our own words. */
function clock(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : 'an unknown time';
}

function centsOfPrice(p: unknown): number | null {
  if (typeof p !== 'string' || !/^\d{1,5}(\.\d{1,2})?$/.test(p)) return null;
  const [w, f = ''] = p.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

function parseCost(text: string): string {
  if (!/^\d{1,4}\.\d{2}$/.test(text)) throw new Stop('cost must be dollars and cents per pound, like cost=5.75.', 2);
  if (Number(text) <= 0) throw new Stop('cost must be more than zero.', 2);
  return text;
}

/** The lowest cost in whole cents that the formula prices at exactly targetCents, or null. */
export function costForPrice(f: PriceFormula, targetCents: number): string | null {
  const price = (costCents: number): number => Number(formulaCents(f, fromCents(costCents)));
  let lo = 1;
  let hi = Math.max(100, targetCents * 2);
  if (price(hi) < targetCents) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (price(mid) >= targetCents) hi = mid;
    else lo = mid + 1;
  }
  return price(lo) === targetCents ? priceText(lo) : null;
}

/**
 * The invoice weight that leaves the sandbox's stock count as it is: the count itself, when it is
 * a usable weight (more than 0, at most 200 lb, at most 3 decimals). Otherwise null.
 */
export function poundsFromStock(count: string | null): string | null {
  if (count === null || !/^\d{1,4}(\.\d+)?$/.test(count)) return null;
  const t = count.includes('.') ? count.replace(/0+$/, '').replace(/\.$/, '') : count;
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(t) || !(Number(t) > 0) || Number(t) > 200) return null;
  return t;
}

/** Cost per lb times pounds, in cents, rounded half up. */
function extensionCents(costText: string, pounds: string): number {
  const costCents = Math.round(Number(costText) * 100);
  const thousandths = Math.round(Number(pounds) * 1000);
  return Math.round((costCents * thousandths) / 1000);
}

// ---- State on disk

/** Where the test database's master key lives: outside the repo and the data folder, one per state folder. */
export function keyPathFor(stateDir: string): string {
  return join(KEY_DIR, `${createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 16)}.key`);
}

function privateDir(dir: string): void {
  if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Stop(`${dir} is a symlink. Refusing to use it.`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function statePath(ctx: Ctx): string {
  return join(ctx.stateDir, 'state.json');
}

function loadState(ctx: Ctx): FrontState | null {
  const p = statePath(ctx);
  if (!existsSync(p)) return null;
  const s = JSON.parse(readFileSync(p, 'utf8')) as FrontState;
  if (s.version !== 1 || !/^\d{4}$/.test(s.plu) || (s.mode !== 'dev' && s.mode !== 'live')) throw new Stop(`${p} is not a state file this script wrote.`);
  return s;
}

function mustState(ctx: Ctx): FrontState {
  const s = loadState(ctx);
  if (!s) throw new Stop('No test is planned. Start with plan.');
  return s;
}

function saveState(ctx: Ctx, s: FrontState): void {
  privateDir(ctx.stateDir);
  const tmp = `${statePath(ctx)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, statePath(ctx));
}

/** One command at a time on a state folder. */
function lock(ctx: Ctx): () => void {
  privateDir(ctx.stateDir);
  const p = join(ctx.stateDir, 'command.lock');
  let fd: number;
  try {
    fd = openSync(p, 'wx', 0o600);
  } catch {
    let owner = 0;
    try {
      owner = Number(readFileSync(p, 'utf8'));
    } catch {
      owner = 0;
    }
    let alive = false;
    try {
      if (owner > 0) process.kill(owner, 0);
      alive = owner > 0;
    } catch {
      alive = false;
    }
    if (alive) throw new Stop('Another front-test command is running. Wait for it to finish.');
    unlinkSync(p);
    fd = openSync(p, 'wx', 0o600);
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => rmSync(p, { force: true });
}

const current = (s: FrontState): TestRun => {
  const r = s.runs.at(-1);
  if (!r) throw new Stop('No test run is planned. Start with plan.');
  return r;
};

// ---- ScaleConnect: where, and the token

interface Connection {
  url: string;
  token: string;
  allowLive: boolean;
}

/** The live token from dev.env by key name. Never printed. */
export function liveToken(read: (key: string) => string = devEnvValueOrEmpty): string {
  let v: string;
  try {
    v = read('SCALECONNECT_TOKEN');
  } catch (e) {
    throw new Stop(`Cannot read ~/.config/shelfready/dev.env: ${plainText(e instanceof Error ? e.message : 'unknown error')} Nothing was contacted.`);
  }
  if (!v) throw new Stop('SCALECONNECT_TOKEN is not in ~/.config/shelfready/dev.env yet. Add that line (the file stays mode 600), then run this again. Nothing was contacted.');
  if (v.length < 20 || v.length > 512 || /\s/.test(v)) throw new Stop('SCALECONNECT_TOKEN in dev.env does not look like a ScaleConnect token. Check that line. Nothing was contacted.');
  return v;
}

/**
 * Why the token may not go to this live address, or null. Only plain http to an IPv4 address of
 * one of this PC's interfaces, path /mcp, nothing else in it: the token never leaves this PC.
 */
export function liveUrlProblem(url: string, local: readonly string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'The ScaleConnect address is not a full address like http://10.0.0.20:8765/mcp.';
  }
  if (u.protocol !== 'http:') return 'The ScaleConnect address must start with http:// and name this PC.';
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/mcp') return 'The ScaleConnect address must end in /mcp, with nothing else after it.';
  if (!isIPv4(u.hostname)) return 'The ScaleConnect address must be an IPv4 address of this PC, not a name.';
  if (!local.includes(u.hostname)) return 'The ScaleConnect address is not an address of this PC, so the token could leave it.';
  if (u.href === DEV_MCP_URL) return 'That is the dev harness address. Use plan with dev for it.';
  return null;
}

function liveAddress(ctx: Ctx): string {
  let v = '';
  try {
    v = (ctx.hooks.readEnv ?? devEnvValueOrEmpty)('SCALECONNECT_URL');
  } catch (e) {
    throw new Stop(`Cannot read ~/.config/shelfready/dev.env: ${plainText(e instanceof Error ? e.message : 'unknown error')} Nothing was contacted.`);
  }
  if (v) return v;
  try {
    v = (ctx.hooks.configLiveUrl ?? configLiveUrl)();
  } catch (e) {
    throw new Stop(`Cannot read the server config: ${plainText(e instanceof Error ? e.message : 'unknown error')} Nothing was contacted.`);
  }
  if (!v) throw new Stop('No ScaleConnect address: set SCALECONNECT_URL in ~/.config/shelfready/dev.env, or liveScaleConnectUrl in config/local/server.json. Nothing was contacted.');
  return v;
}

/** Throws unless this connection may carry the token. Called before every call that sends it. */
function checkTarget(ctx: Ctx, c: Connection): void {
  const problem = c.allowLive ? liveUrlProblem(c.url, (ctx.hooks.localAddresses ?? localIPv4)()) : c.url === DEV_MCP_URL ? null : 'The dev connection names an address other than the dev harness.';
  if (problem) throw new Stop(`${problem} Nothing was sent.`, 2);
  // The address names this PC, but not the program on it. Only a listener we own may get the token.
  const u = new URL(c.url);
  const tables = (ctx.hooks.procNet ?? readProcNet)();
  const owner = listenerProblem(tables, u.hostname, Number(u.port || 80), ctx.hooks.uid ?? process.getuid?.() ?? -1);
  if (owner) throw new Stop(`${owner} Nothing was sent.`, 2);
}

async function connection(ctx: Ctx, mode: 'dev' | 'live', planned?: string): Promise<Connection> {
  let c: Connection;
  if (mode === 'dev') {
    const conn = await readDevConnection();
    if (!conn || conn.url !== DEV_MCP_URL) throw new Stop('The dev ScaleConnect harness is not running. Start it: scripts/dev-scaleconnect/dev-sc.sh start');
    c = { url: conn.url, token: conn.token, allowLive: false };
  } else {
    const url = liveAddress(ctx);
    // The address is checked before the token is even read.
    checkTarget(ctx, { url, token: '', allowLive: true });
    c = { url: new URL(url).href, token: liveToken(ctx.hooks.readEnv), allowLive: true };
  }
  if (planned !== undefined && planned !== c.url) throw new Stop('The ScaleConnect address changed since this test was planned. Nothing was sent. Put it back, or run clean yes and plan again.');
  return c;
}

/** The app's connection options for this script's address: live pinned to the address checked above. */
function connectOptions(ctx: Ctx, c: Connection): Parameters<typeof connectScaleConnect>[0] {
  return {
    url: c.url,
    token: c.token,
    allowLive: c.allowLive,
    liveUrl: c.allowLive ? c.url : '',
    clientName: 'shelfready-front-test',
    listenerHooks: { localAddresses: ctx.hooks.localAddresses, procNet: ctx.hooks.procNet, uid: ctx.hooks.uid },
  };
}

/** The script's own ScaleConnect calls: only those that contact no scale. */
interface ScaleReads {
  listScales(): Promise<J>;
  getItem(plu: string): Promise<J>;
  getChange(target: { previewId: string } | { changeId: string }): Promise<LoggedChange>;
  close(): Promise<void>;
}

async function withReads<T>(ctx: Ctx, c: Connection, fn: (r: ScaleReads) => Promise<T>): Promise<T> {
  checkTarget(ctx, c);
  const api = await connectScaleConnect(connectOptions(ctx, c));
  const r: ScaleReads = {
    listScales: async () => (await api.listScales()).data as J,
    getItem: async (plu) => (await api.getItem({ plu })).data as J,
    getChange: (t) => api.getChange(t),
    close: () => api.close(),
  };
  try {
    return await fn(r);
  } finally {
    await r.close().catch(() => undefined);
  }
}

// ---- Checks on ScaleConnect's list (no scale contact)

export interface ListCheck {
  frozen: string[];
  problems: string[];
  names: string[];
}

/**
 * What scale_list_scales says against this test. beforeChange: the change has not been sent yet,
 * so no scale may have anything unfinished for this code either.
 */
export function checkScaleList(list: J, o: { plu: string; beforeChange: boolean; scaleNames?: string[] }): ListCheck {
  const rows = arr(list.unfinished).map(rec);
  const scales = arr(list.scales).map(rec);
  const names = scales.map((x) => (typeof x.name === 'string' ? x.name : '')).filter((n) => n);
  const frozen = [...new Set([...strs(list.scales_may_be_frozen), ...rows.filter((r) => r.may_be_frozen === true).map((r) => String(r.scale))])];
  const problems: string[] = [];
  if (list.config_changed === true) problems.push('ScaleConnect says its config changed since it started (config_changed). It refuses previews and applies until a person restarts it.');
  if (list.scales_in_use === true) problems.push('Something is using the scales now (scales_in_use). Try again when it has finished.');
  const interrupted = strs(list.interrupted_change_ids);
  if (interrupted.length) problems.push(`ScaleConnect has ${interrupted.length} change(s) that stopped without finishing. A person must resolve them first.`);
  if (rows.some((r) => r.kind === 'list_failed')) problems.push('ScaleConnect could not build its list of unfinished changes (list_failed), so it cannot be read as all clear.');
  const front = scales.find((x) => x.name === TEST_SCALE);
  if (!front) problems.push(`ScaleConnect lists no scale named ${TEST_SCALE}.`);
  else if (front.write_enabled !== true) problems.push(`${TEST_SCALE} has writes off in ScaleConnect.`);
  const onFront = rows.filter((r) => r.scale === TEST_SCALE);
  if (onFront.length) problems.push(`${TEST_SCALE} has ${onFront.length} unfinished change(s) in ScaleConnect's list (codes ${onFront.map((r) => word(r.plu)).join(', ')}). The test needs ${TEST_SCALE} clear first.`);
  if (o.beforeChange) {
    const mine = rows.filter((r) => r.plu === o.plu && r.scale !== TEST_SCALE);
    if (mine.length) problems.push(`Code ${o.plu} has unfinished changes on ${[...new Set(mine.map((r) => word(r.scale)))].join(', ')}. Pick another item, or settle those first.`);
  }
  if (o.scaleNames && [...names].sort().join(',') !== [...o.scaleNames].sort().join(',')) {
    problems.push(`ScaleConnect now lists the scales ${names.map(word).join(', ') || 'none'}, not ${o.scaleNames.map(word).join(', ')} as when the test was planned.`);
  }
  return { frozen, problems, names };
}

function frozenWords(out: (l: string) => void, scales: string[]): void {
  out('');
  out(`STOP. ${scales.map(word).join(', ')} MAY BE FROZEN.`);
  out('Do not read or write that scale again, and do not retry anything.');
  out('Someone must look at it, and reboot it if it needs that.');
  out('After that, only a compare of that scale alone clears it (scale_compare_scales with scales set to that one scale). This script never does that.');
}

/** Stops at once when a scale may be frozen, and remembers it in the state. */
function stopIfFrozen(ctx: Ctx, s: FrontState | null, scales: string[]): void {
  if (!scales.length) return;
  frozenWords(ctx.out, scales);
  if (s) {
    s.frozenStop = [...new Set([...(s.frozenStop ?? []), ...scales])];
    saveState(ctx, s);
  }
  throw new Stop(`${scales.map(word).join(', ')} may be frozen. Stopped.`, FROZEN_EXIT);
}

/** Before any step that reads or writes a scale: the list must be clear, and nothing frozen. */
async function precheck(ctx: Ctx, s: FrontState, c: Connection, beforeChange: boolean): Promise<void> {
  if (s.frozenStop && !ctx.args.flags.has('frozen-cleared')) {
    throw new Stop(`This test stopped because ${s.frozenStop.map(word).join(', ')} may have been frozen. Once a person has looked at it and a compare of it alone has answered, run this again with frozen-cleared.`);
  }
  const list = await withReads(ctx, c, (r) => r.listScales());
  const check = checkScaleList(list, { plu: s.plu, beforeChange, scaleNames: s.scaleNames });
  stopIfFrozen(ctx, s, check.frozen);
  if (check.problems.length) throw new Stop(`Not sent. ${check.problems.join(' ')} Nothing was read or written on any scale.`);
  if (s.frozenStop) {
    s.frozenStop = null;
    saveState(ctx, s);
  }
}

// ---- Square: the sandbox

function sandboxSide(): SquareSide {
  const { token, locationId } = sandboxSettings();
  const sq = (method: 'GET' | 'POST', path: string, body?: unknown) => sandboxFetch(token, method, path, body);
  const list = async (types: string): Promise<J[]> => {
    const all: J[] = [];
    for (let cursor = ''; ; ) {
      const q = new URLSearchParams({ types });
      if (cursor) q.set('cursor', cursor);
      const r = await sq('GET', `/v2/catalog/list?${q}`);
      all.push(...((r.objects as J[]) ?? []));
      if (!r.cursor) break;
      cursor = r.cursor as string;
    }
    return all;
  };
  return {
    locationId,
    settings: { values: { squareEnvironment: 'sandbox', squareLocationId: locationId }, secrets: { squareAccessToken: token } },
    async findItem(plu, dev) {
      const ids = JSON.parse(readFileSync(join(REPO, 'data/square/sandbox-ids.json'), 'utf8')) as { items: Record<string, { name: string; item: string; variation: string }> };
      const hits = Object.values(ids.items).filter((x) => typeof x?.name === 'string' && trailingScaleCode(x.name) === plu).map((x) => ({ itemId: x.item, variationId: x.variation }));
      if (dev) {
        // The dev harness codes are on send-local.ts's own dev items, not on seeded store items.
        for (const o of await list('ITEM')) {
          const name = String(o.item_data?.name ?? '');
          if (!o.is_deleted && name.startsWith('ShelfReady Dev ') && trailingScaleCode(name) === plu) hits.push({ itemId: o.id, variationId: o.item_data.variations?.[0]?.id });
        }
      }
      if (hits.length !== 1) throw new Stop(`The sandbox has ${hits.length} items for code ${plu}, so the test cannot tell which one to use.${hits.length ? '' : ' Pick a code from data/square/sandbox-ids.json.'}`);
      return hits[0]!;
    },
    async readItem(itemId) {
      const r = await sq('POST', '/v2/catalog/batch-retrieve', { object_ids: [itemId] });
      return ((r.objects as J[]) ?? []).find((o) => o.id === itemId) ?? null;
    },
    async poundUnitId() {
      const ids = [...perPoundUnitIds(await list('MEASUREMENT_UNIT'))];
      if (ids.length !== 1) throw new Stop(`The sandbox has ${ids.length} per-pound units; it must have exactly one.`);
      return ids[0]!;
    },
    async stockCount(variationId) {
      const r = await sq('POST', '/v2/inventory/counts/batch-retrieve', { catalog_object_ids: [variationId], location_ids: [locationId], states: ['IN_STOCK'] });
      const c = ((r.counts as J[]) ?? []).find((x) => x.catalog_object_id === variationId && x.state === 'IN_STOCK');
      return typeof c?.quantity === 'string' ? c.quantity : null;
    },
  };
}

interface SquareNow {
  name: string;
  cents: number | null;
  sale: 'weight' | 'register' | 'piece';
  words: string;
}

async function squareNow(sq: SquareSide, s: Pick<FrontState, 'plu' | 'item'>): Promise<SquareNow> {
  const it = await sq.readItem(s.item.itemId);
  if (!it || it.is_deleted) throw new Stop('The sandbox item is gone. Nothing was sent.');
  const v = arr(it.item_data?.variations).map(rec).find((x) => x.id === s.item.variationId);
  if (!v) throw new Stop('The sandbox item no longer has that variation. Nothing was sent.');
  const st = squareItemState(it, v, sq.locationId, new Set([s.item.poundUnitId]), s.plu);
  const sale = soldByWeightInSquare(st) ? 'weight' : st.pricingType === 'VARIABLE_PRICING' ? 'register' : 'piece';
  const name = String(it.item_data?.name ?? '');
  const words =
    sale === 'weight' ? `${dollars(st.priceCents)} per lb, sold by weight` : sale === 'register' ? 'price taken at the register, not sold by weight' : `${dollars(st.priceCents)} each, not per lb`;
  return { name, cents: sale === 'register' ? null : st.priceCents, sale, words };
}

const stockWords = (count: string | null): string => (count === null ? 'no count' : `${data(count, 20)} lb`);

// ---- The app

const skippedCopy = async () => ({ status: 'skipped' as const, message: 'Card copy is skipped for the FRONT test. A test item gets no card.' });

function invoiceFor(s: FrontState, r: TestRun) {
  const d = new Date(r.plannedAt);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ext = priceText(extensionCents(r.costText, r.pounds));
  return invoice({
    supplier_name: SUPPLIER,
    invoice_number: r.invoiceNumber,
    invoice_date: `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(2, 4)}`,
    invoice_date_iso: iso,
    images: [image({ invoice_number: r.invoiceNumber })],
    lines: [line({ item_number: `FT${s.plu}`, description: `FRONT TEST ${s.plu}`, unit: 'LB', qty_shipped: '1', weight: r.pounds, unit_price: r.costText, extension: ext })],
    total: ext,
  });
}

interface Session {
  app: Awaited<ReturnType<typeof buildApp>>;
  post(url: string, fields?: Record<string, string>): Promise<{ status: number; error: string; location: string }>;
  upload(seed: number): Promise<number>;
  drain(): Promise<void>;
  close(): Promise<void>;
}

async function openApp(ctx: Ctx, s: FrontState, c: Connection, sq: SquareSide): Promise<Session> {
  // The app sends the token wherever settings point, so the same check comes first.
  checkTarget(ctx, c);
  const config = makeConfig({
    dbPath: join(ctx.stateDir, DB_FILE),
    masterKeyPath: ctx.keyPath,
    scaleNames: s.scaleNames,
    // The app's own guard: sends, previews and settles may write to FRONT alone.
    writeScales: [TEST_SCALE],
    allowLiveScaleConnect: s.mode === 'live',
    liveScaleConnectUrl: s.mode === 'live' ? c.url : '',
    logLevel: 'silent',
  });
  if (config.writeScales.length !== 1 || config.writeScales[0] !== TEST_SCALE) throw new Stop('The config would let the app write to a scale other than FRONT. Refusing.');
  privateDir(KEY_DIR);
  const r = s.runs.at(-1);
  const inv = r ? invoiceFor(s, r) : invoice();
  const deps: AppDeps = {
    modelClient: fakeClient({ 'claude-sonnet-5-5': [{ json: inv }], 'claude-opus-5-5': [{ json: inv }] }),
    startRunner: false,
    cardCopy: skippedCopy,
    ...ctx.hooks.appDeps,
  };
  // The app's own connections go through here too, so the address and listener check runs
  // before each one. connectScaleConnect keeps the app's own address guard.
  const wrap = ctx.hooks.wrapScaleApi ?? ((api: ScaleApi) => api);
  deps.scaleApi = async () => {
    checkTarget(ctx, c);
    return wrap(await connectScaleConnect(connectOptions(ctx, c)));
  };
  const app = await buildApp(config, deps);
  try {
    app.shelf.settings.update({ values: { ...sq.settings.values, scaleConnectUrl: c.url }, secrets: { ...sq.settings.secrets, scaleConnectToken: c.token } }, SYSTEM_ACTOR);
    // A fresh password each time, never stored: the test user signs in once per command.
    const password = randomBytes(18).toString('base64url');
    const existing = findUserByUsername(app.shelf.db, USERNAME);
    if (existing) await setPassword(app.shelf.db, existing.id, password, { scrypt: config.scrypt, minLength: 12, actor: SYSTEM_ACTOR, byAdmin: false });
    else await createUser(app.shelf.db, { username: USERNAME, role: 'manager', password, mustChangePassword: false }, { scrypt: config.scrypt, minLength: 12, actor: SYSTEM_ACTOR });
    const origin = config.publicOrigins[0]!;
    const loginPage = await app.inject({ method: 'GET', url: '/login' });
    const loginCookie = loginPage.cookies.find((x) => x.name === 'sr_login')!.value;
    const loginCsrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!;
    const signedIn = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { origin, cookie: `sr_login=${loginCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ _csrf: loginCsrf, username: USERNAME, password }).toString(),
    });
    const session = signedIn.cookies.find((x) => x.name === 'sr_session');
    if (!session) throw new Stop('The test user could not sign in to the app.');
    const cookie = `sr_session=${session.value}`;
    const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).body)![1]!;
    const post = async (url: string, fields: Record<string, string> = {}) => {
      const res = await app.inject({ method: 'POST', url, headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ _csrf: csrf, ...fields }).toString() });
      const error = /<p class="error"[^>]*>([^<]*)/.exec(res.body)?.[1] ?? '';
      return { status: res.statusCode, error, location: String(res.headers.location ?? '') };
    };
    const upload = async (seed: number): Promise<number> => {
      const boundary = '----shelfreadyfronttest';
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="front-test.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
        await testImage(seed),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const up = await app.inject({ method: 'POST', url: '/runs', headers: { cookie, origin, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
      if (up.statusCode !== 303) throw new Stop(`The app refused the invoice upload (HTTP ${up.statusCode}).`);
      return Number(String(up.headers.location).split('/').pop());
    };
    return { app, post, upload, drain: () => app.shelf.runner.drain(), close: () => app.close() };
  } catch (e) {
    await app.close();
    throw e;
  }
}

function openJobs(sess: Session): string[] {
  return (sess.app.shelf.db.prepare("SELECT kind FROM run_jobs WHERE state IN ('queued', 'running')").all() as Array<{ kind: string }>).map((r) => r.kind);
}

function pushStep(sess: Session, runId: number): ScaleStepRow | undefined {
  return scaleSteps(sess.app.shelf.db, runId).filter((x) => x.kind === 'push').at(-1);
}

function runRow(sess: Session, runId: number): RunRow {
  const r = getRun(sess.app.shelf.db, runId);
  if (!r) throw new Stop(`Run ${runId} is not in the test database.`);
  return r;
}

/** may_be_frozen anywhere in a kept preview. */
function previewFrozen(p: ScaleStepRow['preview']): string[] {
  if (!p) return [];
  const out = new Set([...p.mayBeFrozen, ...p.leftOut]);
  if (p.warnings.some((w) => w.mayBeFrozen) || /MAY BE FROZEN/.test(p.summary)) out.add(TEST_SCALE);
  return [...out];
}

// ---- plan and restore

async function planCommon(ctx: Ctx, s: FrontState, c: Connection, sq: SquareSide, purpose: 'change' | 'restore', costText: string | null): Promise<void> {
  const out = ctx.out;
  const list = await withReads(ctx, c, (r) => r.listScales());
  const check = checkScaleList(list, { plu: s.plu, beforeChange: purpose === 'change', scaleNames: s.scaleNames.length ? s.scaleNames : undefined });
  stopIfFrozen(ctx, purpose === 'restore' ? s : null, check.frozen);
  if (check.problems.length) throw new Stop(`Not planned. ${check.problems.join(' ')} Nothing was read or written on any scale.`);
  if (!s.scaleNames.length) s.scaleNames = check.names;
  const item = rec((await withReads(ctx, c, (r) => r.getItem(s.plu))).item);
  const scaleCents = centsOfPrice(item.price);
  if (scaleCents === null) throw new Stop(`ScaleConnect's list has no usable price for code ${s.plu}. Pick another item.`);
  const sqNow = await squareNow(sq, s);
  if (sqNow.sale === 'piece') throw new Stop(`${data(sqNow.name)} is sold ${sqNow.words} in the sandbox. A scale item must be sold by weight (rule 12), or take its price at the register so the run switches it. Pick another item.`);
  const stockBefore = await sq.stockCount(s.item.variationId);
  const pounds = poundsFromStock(stockBefore);

  // Square and the scales follow the store formula from the app's settings. From here on the
  // test database exists, so a stop before the plan is saved needs a clean.
  const sess = await openApp(ctx, s, c, sq);
  let formula: PriceFormula;
  let bigPercent: number;
  try {
    formula = (sess.app.shelf.settings.getSetting('pricing') as { default: PriceFormula }).default;
    bigPercent = Number(sess.app.shelf.settings.getSetting('bigChangePercent'));
  } finally {
    await sess.close();
  }
  const cleanFirst = (e: unknown): never => {
    const msg = e instanceof Error ? plainText(e.message) : 'unknown error';
    throw new Stop(purpose === 'change' ? `${msg} Run clean yes before planning again.` : msg, e instanceof Stop ? e.code : 1);
  };
  let run: TestRun;
  try {
    if (purpose === 'change') {
      s.original = { scaleCents, squareCents: sqNow.cents, squareSale: sqNow.sale, stock: stockBefore };
      if (!costForPrice(formula, scaleCents)) {
        throw new Stop(`The scale price now is ${dollars(scaleCents)}, which the store formula cannot give from any cost, so the restore could not put it back through the app. Pick an item whose price ends in .99.`);
      }
    }
    const cost = purpose === 'change' ? costText! : costForPrice(formula, s.original.scaleCents);
    if (!cost) throw new Stop(`The store formula cannot give ${dollars(s.original.scaleCents)} from any cost, so the restore cannot go through the app.`);
    const newCents = shelfCentsForText(formula, cost);
    if (newCents === scaleCents && purpose === 'change') throw new Stop(`A cost of $${cost} gives ${dollars(newCents)}, the price the scale has now. Pick a cost that changes it.`);
    const squareBase = sqNow.cents;
    run = {
      purpose,
      costText: cost,
      newCents,
      pounds: pounds ?? '1',
      stockBefore,
      fromScaleCents: scaleCents,
      fromSquareCents: sqNow.cents,
      invoiceNumber: `FT-${s.plu}-${purpose === 'change' ? 'C' : 'R'}-${Date.now().toString(36).toUpperCase()}`,
      plannedAt: new Date().toISOString(),
      needsBigTick: squareBase !== null && squareBase > 0 && Math.abs(newCents - squareBase) * 100 > bigPercent * squareBase,
      runId: null,
      previewId: '',
    };
    s.runs.push(run);
    saveState(ctx, s);
  } catch (e) {
    return cleanFirst(e);
  }

  const others = check.names.filter((n) => n !== TEST_SCALE).map(word);
  out(purpose === 'change' ? `FRONT test planned for code ${s.plu}. Nothing was sent, and no scale was contacted.` : `Restore planned for code ${s.plu}. Nothing was sent, and no scale was contacted.`);
  out(`ScaleConnect: ${s.mode === 'live' ? `the store ScaleConnect on this PC, ${word(new URL(s.url).host)}` : 'the dev harness on this PC'}. Square: the sandbox only.`);
  out('');
  out(`Square sandbox item: ${data(sqNow.name)}`);
  out(`  Now: ${sqNow.words}.`);
  if (sqNow.sale === 'register') out('  The run switches it to sold by weight, a fixed price per lb (rule 12). The restore keeps it sold by weight.');
  out(`Scale price in ScaleConnect's list: ${dollars(scaleCents)} per lb. Description: ${data(item.description)}`);
  if (sqNow.cents !== null && sqNow.cents !== scaleCents) out(`  The sandbox and the scale differ now. After this run both have ${dollars(run.newCents)}.`);
  if (purpose === 'restore' && (s.original.squareSale !== 'weight' || s.original.squareCents !== s.original.scaleCents)) {
    out(`  Before the test the sandbox had ${s.original.squareSale === 'register' ? 'the price taken at the register' : dollars(s.original.squareCents)}. The restore sets it to the scale's original price, ${dollars(s.original.scaleCents)} per lb, sold by weight, as rule 12 needs.`);
  }
  out(`Invoice cost: $${run.costText} per lb, ${run.pounds} lb. The store formula gives ${dollars(run.newCents)} per lb.`);
  out(`New price: ${dollars(run.newCents)} per lb. Scale: ${percent(scaleCents, run.newCents)}. Square: ${percent(sqNow.cents, run.newCents)}.`);
  if (run.needsBigTick) out(`That is over the ${bigPercent}% limit, so review needs its own tick. Run preview with tick-big once Bart agrees.`);
  if (Math.abs(run.newCents - scaleCents) * 2 > scaleCents) out('That is more than 50% from the scale price, so ScaleConnect will warn (price_change_large).');
  out(
    pounds
      ? `Stock: the run sets the sandbox count to ${run.pounds} lb, which is what it shows now, so the stock does not change.`
      : `Stock: the sandbox shows ${stockWords(stockBefore)} for it, which cannot be an invoice weight, so the run sets the count to 1 lb. The restore does not put the old count back.`,
  );
  out('');
  out(`Only ${TEST_SCALE} will be written. ${others.join(' and ')} will be left out and listed as missing the change.`);
  out('The expected result is partial. That is right for a test on one scale.');
  out('No card sheet is made. A test item gets no label.');
  out('');
  out('Next: preview. It writes the Square sandbox, reads it back, then asks ScaleConnect for a preview. That reads FRONT once and writes nothing to any scale.');
}

async function plan(ctx: Ctx): Promise<void> {
  if (loadState(ctx)) throw new Stop('A test is already planned here. Use status, or clean yes to start over.');
  if (existsSync(join(ctx.stateDir, DB_FILE))) throw new Stop('A test database is here from a plan that did not finish. Run clean yes, then plan again.');
  const plu = ctx.args.values.get('plu') ?? '';
  if (!/^\d{4}$/.test(plu)) throw new Stop('plu must be the 4 digit scale code, like plu=7015.', 2);
  const cost = parseCost(ctx.args.values.get('cost') ?? '');
  const dev = ctx.args.flags.has('dev');
  const mode = dev ? 'dev' : 'live';
  const c = await connection(ctx, mode);
  const sq = (ctx.hooks.square ?? sandboxSide)();
  const found = await sq.findItem(plu, dev);
  const poundUnitId = await sq.poundUnitId();
  const it = await sq.readItem(found.itemId);
  if (!it) throw new Stop('The sandbox item could not be read.');
  const s: FrontState = {
    version: 1,
    mode,
    url: c.url,
    plu,
    scaleNames: [],
    item: { itemId: found.itemId, variationId: found.variationId, name: String(it.item_data?.name ?? ''), poundUnitId },
    original: { scaleCents: 0, squareCents: null, squareSale: 'weight', stock: null },
    runs: [],
    frozenStop: null,
  };
  privateDir(ctx.stateDir);
  await planCommon(ctx, s, c, sq, 'change', cost);
}

async function restore(ctx: Ctx): Promise<void> {
  const s = mustState(ctx);
  if (current(s).purpose === 'restore') {
    if (current(s).runId !== null) throw new Stop('The restore is already under way. Use preview, send or status.');
    // Planned but not started: plan it again from what Square and the scales show now.
    s.runs.pop();
  }
  const last = current(s);
  const c = await connection(ctx, s.mode, s.url);
  const sq = (ctx.hooks.square ?? sandboxSide)();
  const nothingSent = 'Nothing from the change reached Square or a scale, so there is nothing to put back. Run clean yes to end the test.';
  if (last.runId === null) throw new Stop(nothingSent);
  const sess = await openApp(ctx, s, c, sq);
  try {
    const step = pushStep(sess, last.runId);
    const run = runRow(sess, last.runId);
    if (['uploaded', 'reading', 'needs_approval', 'retry', 'review', 'ready', 'dry_run_done', 'approved', 'failed'].includes(run.state)) throw new Stop(nothingSent);
    if (step && ['acknowledged', 'applying', 'unknown'].includes(step.state)) throw new Stop('The change to FRONT has no known result yet. Run status first. Nothing was planned.');
    if (step?.state === 'previewed' && Date.parse(step.preview?.expiresAt ?? '') > Date.now()) throw new Stop('The change to FRONT is waiting for a yes. Send it, or let its preview end, before the restore.');
    if (getSend(sess.app.shelf.db, last.runId)?.phase === 'sending_square') throw new Stop('The change is still being written to the Square sandbox. Run status first.');
  } finally {
    await sess.close();
  }
  await planCommon(ctx, s, c, sq, 'restore', null);
}

// ---- preview

async function preview(ctx: Ctx): Promise<void> {
  const out = ctx.out;
  const s = mustState(ctx);
  const r = current(s);
  const c = await connection(ctx, s.mode, s.url);
  const sq = (ctx.hooks.square ?? sandboxSide)();
  await precheck(ctx, s, c, r.purpose === 'change');
  const sess = await openApp(ctx, s, c, sq);
  try {
    const jobs = openJobs(sess);
    if (jobs.length) throw new Stop(`The app still has work queued (${jobs.map(word).join(', ')}). Run status first. Nothing was sent.`);
    const db = sess.app.shelf.db;
    const ok = async (url: string, fields: Record<string, string> = {}) => {
      const res = await sess.post(url, fields);
      if (res.status !== 303) throw new Stop(`The app refused ${url.replace(/^\/runs\/\d+\//, '')} (HTTP ${res.status}). ${plainText(res.error)}`.trim());
      await sess.drain();
    };
    if (r.runId === null) {
      r.runId = await sess.upload(r.purpose === 'change' ? 11 : 12);
      saveState(ctx, s);
      await sess.drain();
    }
    const runId = r.runId;
    let run = runRow(sess, runId);
    const ev = () => (runRow(sess, runId).evaluation ?? { lines: [], blockers: [] }) as J;
    if (['review', 'ready'].includes(run.state)) {
      if (arr(ev().blockers).some((b) => rec(b).id === 'supplier_unknown')) await ok(`/runs/${runId}/supplier`, { create: '1' });
      const l1 = rec(arr(ev().lines)[0]);
      if (l1.variationId !== s.item.variationId) await ok(`/runs/${runId}/lines/1/pick`, { variationId: s.item.variationId });
      await ok(`/runs/${runId}/cards/leave-out`, { variationId: s.item.variationId, leaveOut: '1' });
      const big = rec(rec(arr(ev().lines)[0]).bigChange);
      if (big.percent !== undefined && big.accepted !== true) {
        if (!ctx.args.flags.has('tick-big')) throw new Stop(`The price moves ${Number(big.percent)}%, over the big-change limit. Once Bart agrees, run preview tick-big. Nothing was sent.`);
        await ok(`/runs/${runId}/big-change`, { variationId: s.item.variationId, fromCents: String(big.fromCents), toCents: String(big.toCents) });
      }
      run = runRow(sess, runId);
      if (run.state !== 'ready') {
        const why = arr(ev().blockers).map((b) => plainText(rec(b).message)).filter((m) => m);
        throw new Stop(`The run is not ready for a dry run. The app says: ${why.join(' | ') || plainText(run.message)}. Nothing was sent.`);
      }
      await ok(`/runs/${runId}/dry-run`);
      run = runRow(sess, runId);
    }
    if (run.state === 'dry_run_done') {
      checkDryRun(s, r, run.dryRun as ChangePreview);
      printDryRun(ctx, s, r, run.dryRun as ChangePreview);
      await ok(`/runs/${runId}/approve`, { hash: run.dryRunHash });
      run = runRow(sess, runId);
    }
    if (run.state === 'approved') {
      checkDryRun(s, r, run.dryRun as ChangePreview);
      // The second check, beside the app's writeScales guard: FRONT alone is chosen.
      const fields: Record<string, string> = { hash: run.dryRunHash, [`scale_${TEST_SCALE}`]: '1' };
      if (Object.keys(fields).filter((k) => k.startsWith('scale_')).join() !== `scale_${TEST_SCALE}`) throw new Stop('Refusing: the send would name a scale other than FRONT.');
      // The run sets the stock count to the weight planned from the count then. If it moved, stop.
      const stockNow = await sq.stockCount(s.item.variationId);
      const same = stockNow === null || r.stockBefore === null ? stockNow === r.stockBefore : Number(stockNow) === Number(r.stockBefore);
      if (!same) {
        throw new Stop(`The sandbox stock count moved since the plan (${stockWords(r.stockBefore)} then, ${stockWords(stockNow)} now), so the run would overwrite it. Nothing was sent. ${r.purpose === 'change' ? 'Run clean yes, then plan again.' : 'Run restore again to plan it with the count now.'}`);
      }
      out(`Run ${runId} is approved. Sending to the Square sandbox, then asking ScaleConnect for a preview of ${TEST_SCALE} alone.`);
      await ok(`/runs/${runId}/send/start`, fields);
    } else if (run.state === 'sending') {
      const step = pushStep(sess, runId);
      const send = getSend(db, runId);
      if (send?.phase !== 'scale_preview') throw new Stop(`The send is at ${word(send?.phase ?? 'an unknown point')}: ${plainText(run.message)} Run status.`);
      if (step && previewFrozen(step.preview).length) stopIfFrozen(ctx, s, previewFrozen(step.preview));
      if (!ctx.args.flags.has('again')) {
        throw new Stop(`A scale preview already exists for this run${step ? ` (${word(step.state)})` : ''}. A new one reads FRONT again. Once Bart agrees, run preview again.`);
      }
      out('Asking ScaleConnect for a new preview. It reads FRONT once.');
      await ok(`/runs/${runId}/send/scale-preview`);
    } else {
      throw new Stop(`Run ${runId} is ${word(run.state)}: ${plainText(run.message)} Nothing was sent. Run status.`);
    }

    // What came back.
    run = runRow(sess, runId);
    const send = getSend(db, runId);
    if (send?.phase !== 'scale_preview') {
      out(`The send stopped at ${word(send?.phase ?? 'an unknown point')}. The app says: ${plainText(send?.message ?? run.message)}`);
      throw new Stop('No scale preview was made.');
    }
    const sqAfter = await squareNow(sq, s);
    const squareOk = sqAfter.sale === 'weight' && sqAfter.cents === r.newCents;
    out('');
    out('Square sandbox, written by the app and read back:');
    out(`  ${data(sqAfter.name)}: was ${r.fromSquareCents === null ? 'priced at the register' : `${dollars(r.fromSquareCents)}`}. Now ${sqAfter.words}.`);
    if (!squareOk) out(`  The sandbox should be ${dollars(r.newCents)} per lb, sold by weight. It is not. The scale must not get a price Square does not have (rule 12).`);
    const step = pushStep(sess, runId);
    if (!step) {
      out(`No preview was stored. The app says: ${plainText(send.message)}`);
      throw new Stop('No scale preview was made. Nothing was written on any scale.');
    }
    stopIfFrozen(ctx, s, previewFrozen(step.preview));
    r.previewId = step.previewId;
    saveState(ctx, s);
    const why = printPreview(ctx, s, r, step, squareOk);
    if (why) throw new Stop(`This preview must not be sent: ${why} Nothing was written on any scale.`);
  } finally {
    await sess.close();
  }
}

function checkDryRun(s: FrontState, r: TestRun, p: ChangePreview): void {
  const sqc = p.square;
  const sc = p.scales.changes;
  const sqOk = sqc.length === 1 && sqc[0]!.variationId === s.item.variationId && sqc[0]!.price?.toCents === r.newCents;
  const scOk = sc.length === 1 && sc[0]!.code === s.plu && sc[0]!.priceCents === r.newCents;
  if (p.cards.cards.length) throw new Stop('The dry run would print a card. A test item gets no card. Nothing was sent.');
  if (!sqOk || !scOk) {
    throw new Stop(`The dry run is not the one planned change (Square: ${sqc.length} item(s), scales: ${sc.map((x) => `${word(x.code)} ${dollars(x.priceCents)}`).join(', ') || 'none'}; planned ${s.plu} ${dollars(r.newCents)}). Nothing was sent.`);
  }
}

function printDryRun(ctx: Ctx, s: FrontState, r: TestRun, p: ChangePreview): void {
  const sqc = p.square[0]!;
  const stock = sqc.stock ? `, stock ${stockWords(sqc.stock.from)} to ${data(sqc.stock.to, 20)} ${word(sqc.stock.unit)}` : '';
  ctx.out(`Dry run (nothing written): Square ${data(sqc.label)} to ${dollars(sqc.price?.toCents)} per lb${sqc.switchToWeight ? ', switched to sold by weight' : ''}${stock}. Scales: code ${s.plu} to ${dollars(r.newCents)}. Cards: ${p.cards.cards.length}.`);
}

/** Prints the preview. Returns why it must not be sent, or '' when it may be (with Bart's yes). */
function printPreview(ctx: Ctx, s: FrontState, r: TestRun, step: ScaleStepRow, squareOk: boolean): string {
  const out = ctx.out;
  const p = step.preview;
  out('');
  out(`Scale preview from ScaleConnect. Nothing is written on any scale yet. Preview id: ${word(step.previewId || 'none')}.`);
  if (!p || step.state === 'blocked') {
    out(`It cannot be sent. ${plainText(p?.blockedWhy ?? '')}`.trim());
    return 'ScaleConnect or the app blocked it.';
  }
  out(`  Scales it would write: ${p.scales.map(word).join(', ') || 'none'}.`);
  for (const d of p.differences) if (d.fields) out(`  Code ${data(d.plu, 10)}: ${data(d.fields, 300)}`);
  const alone = p.scales.length === 1 && p.scales[0] === TEST_SCALE;
  const priced = p.newPrices?.[s.plu] === priceText(r.newCents) && Object.keys(p.newPrices ?? {}).length === 1;
  const noChange = p.warnings.some((w) => w.code === 'no_change') || !p.differences.some((d) => d.fields);
  out(`  Warnings (${p.warnings.length}):`);
  for (const w of p.warnings) out(`    ${word(w.code)}${w.requiresAck ? ', needs a yes' : ''}. ScaleConnect's words: ${data(w.message, 400)}`);
  if (!p.warnings.length) out('    none');
  out(`  Drift (${p.drift.length}):`);
  for (const d of p.drift) out(`    ${word(d.scale)} code ${data(d.plu, 10)}: ${data(d.text, 300)} Token: ${word(d.token)}`);
  if (!p.drift.length) out('    none');
  for (const d of p.driftCannotAck) out(`  Cannot be accepted: ${data(d, 300)}`);
  out(`  It ends at ${clock(p.expiresAt)}. Send before then, or run preview again, which reads FRONT again.`);
  out(`  ${TEST_SCALE} was read once for this preview.${/needed a second try/.test(p.summary) ? ' The read needed a second try, so that was two reads.' : ''}`);
  out('ScaleConnect\'s summary:');
  for (const l of p.summary.split('\n')) out(`  | ${plainText(l)}`);
  out('');
  out('Labels: no card sheet. A test item gets no label.');
  out('');
  if (noChange) return `ScaleConnect's list already has ${dollars(r.newCents)} for code ${s.plu}, so ${TEST_SCALE} needs nothing. The Square sandbox has ${dollars(r.newCents)}. Run status.`;
  if (!alone) return `it would write to ${p.scales.map(word).join(', ') || 'no scale'}, not ${TEST_SCALE} alone.`;
  if (!priced) return `it does not put ${dollars(r.newCents)} on code ${s.plu} alone.`;
  if (!squareOk) return 'the Square sandbox does not have the new price, sold by weight.';
  const acks = [...new Set(p.warnings.map((w) => w.code))];
  const safe = [...acks, ...p.driftTokens].every((x) => /^[A-Za-z0-9_:-]{1,200}$/.test(x));
  if (!safe) return 'a warning code or drift token has characters that cannot be typed safely. Look at it in ScaleConnect.';
  out('Next, once Bart says yes to every warning and difference above:');
  out(`  send ack=${acks.length ? acks.join(',') : 'none'}${p.driftTokens.length ? ` drift=${p.driftTokens.join(',')}` : ''}`);
  out('Ask Bart before running this.');
  return '';
}

// ---- send

/** The acknowledgements typed must be exactly what the preview showed. */
export function ackProblem(p: NonNullable<ScaleStepRow['preview']>, ackArg: string, driftArg: string): string | null {
  const typed = ackArg === 'none' ? [] : ackArg.split(',').map((x) => x.trim()).filter((x) => x);
  const shown = [...new Set(p.warnings.map((w) => w.code))].sort();
  const got = [...new Set(typed)].sort();
  if (got.join(',') !== shown.join(',')) return `The warnings typed (${got.map(word).join(', ') || 'none'}) are not exactly the ones the preview showed (${shown.map(word).join(', ') || 'none'}). Nothing was sent.`;
  const tokens = [...new Set(driftArg.split(',').map((x) => x.trim()).filter((x) => x))].sort();
  const wanted = [...new Set(p.driftTokens)].sort();
  if (tokens.join(',') !== wanted.join(',')) return `The drift tokens typed are not exactly the ${wanted.length} the preview showed. Nothing was sent.`;
  return null;
}

async function send(ctx: Ctx): Promise<void> {
  const out = ctx.out;
  const s = mustState(ctx);
  const r = current(s);
  if (r.runId === null) throw new Stop('Run preview first.');
  const ackArg = ctx.args.values.get('ack');
  if (!ackArg) throw new Stop('Type the warnings Bart accepted: ack=CODE,CODE (or ack=none). They must be exactly the ones the preview showed.', 2);
  const c = await connection(ctx, s.mode, s.url);
  const sq = (ctx.hooks.square ?? sandboxSide)();
  const sess = await openApp(ctx, s, c, sq);
  try {
    const jobs = openJobs(sess);
    if (jobs.length) throw new Stop(`The app still has work queued (${jobs.map(word).join(', ')}). Run status first. Nothing was sent.`);
    const runId = r.runId;
    const step = pushStep(sess, runId);
    const send = getSend(sess.app.shelf.db, runId);
    if (!step || !step.preview) throw new Stop('There is no scale preview. Run preview.');
    if (['acknowledged', 'applying', 'unknown'].includes(step.state)) throw new Stop('This preview was already sent, and its result is not known here yet. Run status. It is never sent twice.');
    if (step.state !== 'previewed' || send?.phase !== 'scale_preview') throw new Stop(`This preview is ${word(step.state)}, so it cannot be sent. ${plainText(step.preview.blockedWhy)} Run status, or preview again.`.replace(/\s+/g, ' '));
    if (step.previewId !== r.previewId) throw new Stop('The preview in the app is not the one shown last. Run preview again to see it.');
    const p = step.preview;
    stopIfFrozen(ctx, s, previewFrozen(p));
    if (Date.parse(p.expiresAt) <= Date.now() || !Number.isFinite(Date.parse(p.expiresAt))) throw new Stop('This preview has ended (ScaleConnect keeps one for 15 minutes). Run preview again once Bart agrees: it reads FRONT again. Nothing was sent.');
    // The second check, beside the app's writeScales guard.
    if (p.scales.length !== 1 || p.scales[0] !== TEST_SCALE || send.scales.length !== 1 || send.scales[0] !== TEST_SCALE) throw new Stop(`Refusing: this preview would write to ${p.scales.map(word).join(', ')}, not ${TEST_SCALE} alone. Nothing was sent.`);
    if (p.newPrices?.[s.plu] !== priceText(r.newCents) || Object.keys(p.newPrices ?? {}).length !== 1) throw new Stop(`Refusing: this preview does not put ${dollars(r.newCents)} on code ${s.plu} alone. Nothing was sent.`);
    const problem = ackProblem(p, ackArg, ctx.args.values.get('drift') ?? '');
    if (problem) throw new Stop(problem);
    // Rule 12: the scale gets this price only if Square sells the item by weight at the same price.
    const sqNow = await squareNow(sq, s);
    if (sqNow.sale !== 'weight' || sqNow.cents !== r.newCents) throw new Stop(`Refusing: the sandbox item is ${sqNow.words}, not ${dollars(r.newCents)} per lb sold by weight, so the scale would not match it. Nothing was sent.`);
    await precheck(ctx, s, c, r.purpose === 'change');

    const fields: Record<string, string> = { stepId: String(step.id), ack: p.mustAcknowledge ? p.digest : '' };
    p.driftTokens.forEach((t, i) => (fields[`drift_${i}`] = t));
    out(`Sending preview ${word(step.previewId)} to ${TEST_SCALE}. ScaleConnect reads FRONT, writes it, and reads it back. This can take a few minutes.`);
    const res = await sess.post(`/runs/${runId}/send/scales`, fields);
    if (res.status !== 303) throw new Stop(`The app refused the send (HTTP ${res.status}). ${plainText(res.error)} Nothing was sent.`.trim());
    ctx.hooks.afterAck?.();
    await sess.drain();
    await report(ctx, s, r, sess, sq, c);
  } finally {
    await sess.close();
  }
}

/** Scales, Square and labels, each on its own (ScaleConnect's three-part rule). Throws a Stop when anything is not as expected. */
async function report(ctx: Ctx, s: FrontState, r: TestRun, sess: Session, sq: SquareSide, c: Connection): Promise<void> {
  const out = ctx.out;
  const runId = r.runId!;
  const step = pushStep(sess, runId)!;
  const run = runRow(sess, runId);
  const result = rec(step.result);
  out('');
  if (step.state === 'unknown' || step.state === 'applying' || step.state === 'acknowledged') {
    out('Scales: RESULT NOT KNOWN YET. The answer did not come back.');
    out('The change may still be running. It can take minutes. ShelfReady never sends it twice.');
    out(`Run status in a minute. It asks ScaleConnect for preview ${word(step.previewId)} and contacts no scale.`);
    out('Square and the labels wait until the scale result is known.');
    throw new Stop('', NOT_KNOWN_EXIT);
  }
  if (step.state === 'refused') {
    if (result.kind === 'never_applied') {
      out(`Scales: NEVER APPLIED. ScaleConnect has no apply for preview ${word(step.previewId)}, and that preview has ended, so it can never run now. No scale changed.`);
    } else {
      out(`Scales: NOT SENT. ${plainText(run.message)}`);
      out('Nothing was written on any scale.');
    }
    out(`Square already has ${dollars(r.newCents)}. Bart decides what next: preview again (it reads FRONT again), or restore.`);
    throw new Stop('', 1);
  }
  const statuses = rec(result.statuses);
  const frozen = strs(result.mayBeFrozen);
  const pending = pendingRows(sess.app.shelf.db, runId).filter((x) => x.state === 'pending');
  const frontOk = statuses[TEST_SCALE] === 'verified' && !pending.some((x) => x.scale === TEST_SCALE);
  const headline = !frontOk
    ? `${word(step.state).toUpperCase()}, and ${TEST_SCALE} did NOT confirm the new price.`
    : step.state === 'partial'
      ? `PARTIAL. ${TEST_SCALE} confirmed it. That is the expected result for a test on ${TEST_SCALE} alone.`
      : 'SUCCESS on every scale. That is not expected for a FRONT-only test: check KITCHEN and COUNTER.';
  out(`Scales: ${headline}`);
  for (const name of s.scaleNames) {
    const pend = pending.filter((x) => x.scale === name);
    const leftOut = name !== TEST_SCALE && pend.length > 0 && pend.every((x) => x.reason === 'not_targeted');
    const st = typeof statuses[name] === 'string' ? word(statuses[name]) : leftOut ? 'left out of this test, nothing sent. It keeps the price it had' : 'not in the result';
    const why = pend.length ? ` Pending in the app: ${pend.map((x) => `code ${word(x.code)} ${dollars(x.priceCents)} (${word(x.reason)})`).join(', ')}.` : '';
    out(`  ${word(name)}: ${st}.${name === TEST_SCALE && frontOk ? ' Confirmed by reading it back.' : ''}${why}`);
  }
  if (typeof result.changeId === 'string' && result.changeId) out(`  ScaleConnect change id: ${word(result.changeId)}.`);
  out(`  ${TEST_SCALE} reads for this send: one before writing and one to read it back, with one write.`);
  const sqNow = await squareNow(sq, s);
  const squareOk = sqNow.sale === 'weight' && sqNow.cents === r.newCents;
  out(`Square sandbox: ${data(sqNow.name)}: ${sqNow.words}.${squareOk ? ` It matches the price sent to ${TEST_SCALE}.` : ` It should be ${dollars(r.newCents)} per lb, sold by weight, and it is NOT.`} The app wrote it in the preview step, before the scales.`);
  out('Labels: none. A test item gets no card sheet.');
  const list = await withReads(ctx, c, (x) => x.listScales());
  const rows = arr(list.unfinished).map(rec);
  out('');
  out('ScaleConnect\'s list now (no scale contacted):');
  const others = s.scaleNames.filter((n) => n !== TEST_SCALE);
  for (const name of s.scaleNames) {
    const mine = rows.filter((x) => x.scale === name);
    out(`  ${word(name)}: ${mine.length ? mine.map((x) => `code ${data(x.plu, 10)} ${word(x.kind)}${x.catalog_took_it === false ? ', catalog did not take it' : ''}${x.may_be_frozen === true ? ', MAY BE FROZEN' : ''}`).join('; ') : 'nothing unfinished'}.`);
  }
  stopIfFrozen(ctx, s, [...new Set([...frozen, ...checkScaleList(list, { plu: s.plu, beforeChange: false }).frozen])]);
  if (!frontOk || !squareOk) {
    out('');
    throw new Stop(`${!frontOk ? `${TEST_SCALE} did not confirm the new price. ` : ''}${!squareOk ? 'The Square sandbox does not match. ' : ''}This step is not done. Bart decides what next.`, 1);
  }
  r.previewId = step.previewId;
  saveState(ctx, s);
  out('');
  if (r.purpose === 'change') {
    out(`Next: restore, to plan putting ${TEST_SCALE} and the sandbox back to ${dollars(s.original.scaleCents)}.`);
    return;
  }
  const otherWords = others.map(word);
  out(`The restore is done on ${TEST_SCALE}. ${otherWords.join(' and ')} were never sent either change.`);
  const left = rows.filter((x) => others.includes(String(x.scale)));
  out(left.length ? `${left.length} row(s) on ${otherWords.join(' and ')} are left in ScaleConnect's list, shown above.` : `Nothing is left on ${otherWords.join(' or ')} in ScaleConnect's list.`);
  out(`Even so, ${otherWords.join(' and ')} still hold the record from before the test, and ScaleConnect's list now has a newer timestamp for code ${s.plu}. The next time code ${s.plu} is changed with a read, they may show drift in the time alone. That will need a person's yes, or a settle, then.`);
  const stockNow = await sq.stockCount(s.item.variationId);
  out(`Square sandbox stock: ${stockWords(s.original.stock)} before the test, ${stockWords(stockNow)} now.${s.original.squareSale === 'register' ? ' The item stays sold by weight, as rule 12 needs, though it took its price at the register before.' : ''}`);
  out(`Tools the lead would use to settle any row${left.length ? '' : ' that shows up later'} (this script does not):`);
  out('  scale_list_scales: each row, its kind and its repeat. Contacts no scale.');
  out('  scale_compare_scales with scales set to that one scale: reads it once. Rows where it already holds the catalog record end, with nothing written.');
  out('  scale_preview_settle_drift with that scale, the code and take catalog: reads it, and shows the settle.');
  out('  scale_apply_changes with that preview id and the yes a person gives: reads, writes, reads back.');
  out('  scale_get_change with the preview id if a reply is lost. Never apply again.');
}

// ---- status

async function status(ctx: Ctx): Promise<void> {
  const out = ctx.out;
  const s = loadState(ctx);
  const previewArg = ctx.args.values.get('preview');
  const changeArg = ctx.args.values.get('change');
  for (const v of [previewArg, changeArg]) if (v !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Stop('That id does not look like a ScaleConnect id.', 2);
  if (!s && !previewArg && !changeArg) throw new Stop('No test is planned here. Give preview=ID or change=ID (and dev for the dev harness).');
  const c = s ? await connection(ctx, s.mode, s.url) : await connection(ctx, ctx.args.flags.has('dev') ? 'dev' : 'live');
  let exit = 0;

  if (s) {
    out(`Test for code ${s.plu} on ${TEST_SCALE} (${s.mode === 'live' ? 'store ScaleConnect' : 'dev harness'}). Original scale price ${dollars(s.original.scaleCents)}.`);
    if (s.frozenStop) out(`This test stopped because ${s.frozenStop.map(word).join(', ')} may be frozen.`);
    const sq = (ctx.hooks.square ?? sandboxSide)();
    const sess = await openApp(ctx, s, c, sq);
    const db = sess.app.shelf.db;
    const now = ctx.hooks.appDeps?.now ?? Date.now;
    try {
      for (const r of s.runs) {
        if (r.runId === null) {
          out(`  ${r.purpose}: planned, ${dollars(r.newCents)}. Not started.`);
          continue;
        }
        let step = pushStep(sess, r.runId);
        if (step && (step.state === 'acknowledged' || step.state === 'applying')) {
          // Cut short (Ctrl-C, a crash). From here it is only ever looked up by preview id, never applied.
          updateScaleStep(db, step.id, { state: 'unknown' }, now());
          addEvent(db, r.runId, 'scales', `front-test status: preview ${word(step.previewId)} was cut short. It is only looked up from now on, never sent.`, now());
          out(`  ${r.purpose}: the send of preview ${word(step.previewId)} was cut short. It is only looked up from now on, never sent.`);
          step = pushStep(sess, r.runId);
        }
        if (step?.state === 'unknown') {
          const jobs = openJobs(sess);
          // A lookup asks ScaleConnect by preview id and contacts no scale. The step is unknown, so
          // the app's send_scales job only looks it up too.
          if (jobs.length && jobs.every((k) => k === 'scale_lookup' || k === 'send_scales')) {
            await sess.drain();
          } else if (!jobs.length) {
            const res = await sess.post(`/runs/${r.runId}/send/lookup`);
            if (res.status === 303) await sess.drain();
          } else {
            out(`  The app has work queued (${jobs.map(word).join(', ')}) that may read a scale. Not run from status.`);
          }
          step = pushStep(sess, r.runId);
        }
        const run = runRow(sess, r.runId);
        const send = getSend(db, r.runId);
        out(`  ${r.purpose}: run ${r.runId} is ${word(run.state)}${send ? `, send ${word(send.phase)}` : ''}. ${data(run.message, 300)}`);
        if (!step) continue;
        const res = rec(step.result);
        const st = Object.entries(rec(res.statuses)).map(([k, v]) => `${word(k)} ${word(v)}`).join(', ');
        out(`    Scale step: ${word(step.state)}, preview ${word(step.previewId || 'none')}${st ? `, ${st}` : ''}${typeof res.changeId === 'string' ? `, change ${word(res.changeId)}` : ''}.`);
        if (step.state === 'unknown') {
          const ends = Date.parse(step.preview?.expiresAt ?? '');
          out(`    ScaleConnect has no result for it yet.${Number.isFinite(ends) ? ` If none comes, it counts as never applied after ${clock(new Date(ends + NEVER_APPLIED_AFTER_MS).toISOString())}. Run status again then.` : ''}`);
          exit = NOT_KNOWN_EXIT;
        }
        if (r === s.runs.at(-1) && ['success', 'partial', 'failed', 'refused'].includes(step.state)) {
          try {
            await report(ctx, s, r, sess, sq, c);
          } catch (e) {
            if (!(e instanceof Stop) || e.code === FROZEN_EXIT) throw e;
            if (e.message) out(e.message);
            exit = exit || e.code;
          }
        }
      }
    } finally {
      await sess.close();
    }
  }

  await withReads(ctx, c, async (rd) => {
    const target = changeArg ? { changeId: changeArg } : previewArg ? { previewId: previewArg } : s?.runs.at(-1)?.previewId ? { previewId: s.runs.at(-1)!.previewId } : null;
    if (target) {
      const logged = await rd.getChange(target);
      const d = logged.data as J;
      out(`ScaleConnect's log for ${'changeId' in target ? `change ${target.changeId}` : `preview ${target.previewId}`}: ${word(logged.kind)}${d.outcome ? `, outcome ${word(d.outcome)}` : ''}.`);
      for (const [k, v] of Object.entries(rec(d.scale_statuses))) out(`  ${word(k)}: ${word(v)}`);
      const fz = strs(d.scales_may_be_frozen);
      if (fz.length) stopIfFrozen(ctx, s, fz);
    }
    const list = await rd.listScales();
    const check = checkScaleList(list, { plu: s?.plu ?? '', beforeChange: false });
    out(`ScaleConnect's list (no scale contacted): config_changed ${list.config_changed === true ? 'YES' : 'no'}, scales_in_use ${list.scales_in_use === true ? 'YES' : 'no'}, may be frozen: ${check.frozen.map(word).join(', ') || 'none'}.`);
    const rows = arr(list.unfinished).map(rec);
    if (!rows.length) out('  Nothing unfinished.');
    for (const x of rows) out(`  Not finished: ${word(x.scale)} code ${data(x.plu, 10)} ${word(x.kind)}${x.catalog_took_it === false ? ', catalog did not take it' : ''}${x.may_be_frozen === true ? ', MAY BE FROZEN' : ''}.`);
    stopIfFrozen(ctx, s, check.frozen);
  });
  if (exit) throw new Stop('', exit);
}

// ---- clean

/** Push and settle steps whose apply may have left: applying or unknown. acknowledged never left. */
function stepsMaybeInFlight(dbPath: string): Array<{ previewId: string; expiresAt: string }> {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT preview_id, preview FROM scale_steps WHERE state IN ('applying', 'unknown')").all() as Array<{ preview_id: string; preview: string }>;
    return rows.map((x) => ({ previewId: x.preview_id, expiresAt: String((JSON.parse(x.preview) as { expiresAt?: unknown } | null)?.expiresAt ?? '') }));
  } finally {
    db.close();
  }
}

async function clean(ctx: Ctx): Promise<void> {
  if (!ctx.args.flags.has('yes')) throw new Stop('clean removes this test\'s database and its key. Run clean yes to do it.', 2);
  const s = loadState(ctx);
  const inFlight = stepsMaybeInFlight(join(ctx.stateDir, DB_FILE));
  if (inFlight.length) {
    // Only then is ScaleConnect asked, by preview id. Nothing else here contacts anything.
    if (!s) throw new Stop('An apply may still be running, and there is no plan to say where ScaleConnect is. Nothing was removed.');
    const c = await connection(ctx, s.mode, s.url);
    const now = (ctx.hooks.now ?? Date.now)();
    await withReads(ctx, c, async (rd) => {
      for (const x of inFlight) {
        const logged = await rd.getChange({ previewId: x.previewId });
        const ends = Date.parse(x.expiresAt);
        const settled = ['success', 'partial', 'failed'].includes(logged.kind) || (logged.kind === 'not_applied' && Number.isFinite(ends) && now > ends + NEVER_APPLIED_AFTER_MS);
        if (!settled) throw new Stop(`Preview ${word(x.previewId)} may still be running on the scales. Run status first. Nothing was removed.`);
      }
    });
  }
  rmSync(ctx.stateDir, { recursive: true, force: true });
  rmSync(ctx.keyPath, { force: true });
  ctx.out('Removed the test database, its state and its key.');
}

// ---- main

export async function frontTest(argv: readonly string[], hooks: FrontTestHooks = {}): Promise<number> {
  const out = hooks.out ?? ((l: string) => console.log(l));
  let unlock: (() => void) | null = null;
  try {
    const args = parseArgs(argv);
    const stateDir = resolve(hooks.stateDir ?? DEFAULT_STATE_DIR);
    const ctx: Ctx = { out, stateDir, keyPath: keyPathFor(stateDir), hooks, args };
    const commands: Record<string, (c: Ctx) => Promise<void>> = { plan, preview, send, restore, status, clean };
    const fn = commands[args.command];
    if (!fn) throw new Stop('Commands: plan, preview, send, restore, status, clean. See the top of scripts/runs/front-test.ts.', 2);
    unlock = lock(ctx);
    await fn(ctx);
    return 0;
  } catch (e) {
    if (e instanceof Stop) {
      if (e.message) out(e.message);
      return e.code;
    }
    // Errors from the app and the clients carry words safe to show; the token is never in them.
    out(`Stopped: ${plainText(e instanceof Error ? e.message : 'unknown error')}`);
    return 1;
  } finally {
    unlock?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  process.exit(await frontTest(process.argv.slice(2)));
}
