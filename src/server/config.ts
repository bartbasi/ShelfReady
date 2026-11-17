// Server configuration. Everything about the install lives here, not in code.
// The file is JSON, by default config/local/server.json (git ignores config/local/).
// Every field is optional. A missing field takes the default below.
// This file holds no secrets. Secrets live in the encrypted settings.

import { existsSync, readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileUnder, SafeFileError } from './safe-file.ts';
import { defaultBranding, makeBranding, type Branding, type BrandingInput } from './branding.ts';
import { addressKind, hostName, httpsOrigin, isDnsName, listenAddressProblem } from './network.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export interface ScryptParams {
  /** CPU and memory cost. Must be a power of two. */
  N: number;
  r: number;
  p: number;
}

export interface ServerConfig {
  /** The loopback address the server always listens on, for use on this PC: 127.0.0.1, ::1 or localhost. */
  host: string;
  port: number;
  /**
   * The store network and tailnet addresses to listen on as well, for example ["10.0.0.20",
   * "100.64.0.20"]. TLS only. Private and tailnet addresses only, written out. Never 0.0.0.0.
   * Empty means this PC only.
   */
  listenAddresses: string[];
  /**
   * The names the server answers to besides localhost, for example ["shelfready.example.com"].
   * An address in listenAddresses may be listed too, so phones can use it directly (Phase 1).
   * Every other Host is refused (DNS rebinding). TLS only, and the certificate must cover each one.
   */
  allowedHosts: string[];
  tls: {
    enabled: boolean;
    /**
     * The full chain and the private key. Empty means the pair cert.ts installs:
     * ~/.config/shelfready/tls/current/fullchain.pem and key.pem, where current is a link that
     * cert.ts switches in one step, so the two files always change together.
     */
    certPath: string;
    keyPath: string;
    /** The renewal record cert.ts writes. Empty means status.json in the certificate folder (beside current/). */
    statusPath: string;
    /** Strict-Transport-Security max-age, sent only to the names in allowedHosts. Start short. */
    hstsMaxAgeSeconds: number;
    /** How often the server looks for a renewed certificate. It reloads it without a restart. */
    reloadCheckSeconds: number;
  };
  /** The browser origins allowed to post forms, for example https://shelfready.example.com. */
  publicOrigins: string[];
  /** Must be false: no proxy sits in front, and trusting X-Forwarded-For would let any client pick its own address. */
  trustProxy: boolean;
  dbPath: string;
  /** Must be outside the repo and outside the data folder. */
  masterKeyPath: string;
  logLevel: string;
  /** Largest form body in bytes. Invoice uploads get their own limit later. */
  bodyLimit: number;
  /**
   * Live Square (approved by Bart on November 16). Until this is true, production cannot be chosen
   * in settings and every live call is refused. Live Square also needs the setting
   * squareEnvironment set to production. With scales named, it needs live scales too, writing to
   * every scale (rule 12): see the checks in makeConfig and docs/GO-LIVE.md.
   */
  allowSquareProduction: boolean;
  passwordMinLength: number;
  scrypt: ScryptParams;
  /** Password hashes allowed to run at once. More sign ins than this at the same moment get 429. */
  maxConcurrentHashes: number;
  /** Settings and user changes need the password typed within this many minutes. */
  reauthMinutes: number;
  session: {
    /** Remember this device: fixed lifetime from sign in. */
    rememberDays: number;
    /** Without remember: signed out after this many idle minutes. */
    idleMinutes: number;
    /** Without remember: signed out after this many hours, active or not. */
    absoluteHours: number;
  };
  uploads: {
    /** Largest whole upload in bytes, checked from Content-Length before anything is read. */
    maxTotalBytes: number;
    /** Invoice uploads one person may start in an hour. */
    perUserPerHour: number;
    /** Old invoice uploads (purchase history) one person may start in an hour, apart from invoice runs. */
    historyPerUserPerHour: number;
    /** Where uploaded invoice files are kept. Empty means an uploads folder beside the database. */
    dir: string;
    /** Uploads one person may have in progress at once. */
    maxInFlightPerUser: number;
    /** Uploads in progress at once, for everyone together. */
    maxInFlight: number;
    /** Bytes of invoice files kept in any 24 hours, for everyone together. */
    maxBytesPerDay: number;
    /** Each person's share of that, so one account cannot use it all. */
    maxBytesPerUserPerDay: number;
    /** Refuse uploads when the upload folder's disk has less free space than this, in bytes. */
    minFreeBytes: number;
  };
  /** Most a whole request may take, in seconds, and how long a connection may sit idle. */
  requestTimeoutSeconds: number;
  connectionTimeoutSeconds: number;
  /** Most the request headers may take to arrive, in seconds. */
  headersTimeoutSeconds: number;
  /**
   * Most a request other than the invoice upload may take to arrive in full, headers and body, in
   * seconds. Sign in and the other forms are small, so a slow sender is cut off long before
   * requestTimeoutSeconds, which the upload needs.
   */
  formTimeoutSeconds: number;
  /** How long an idle kept-alive connection stays open, in seconds. */
  keepAliveTimeoutSeconds: number;
  /** Most a TLS handshake may take, in seconds. */
  tlsHandshakeTimeoutSeconds: number;
  /** Largest request head (request line and headers) in bytes. */
  maxHeaderBytes: number;
  /** Connections at once on each address the server listens on. */
  maxConnections: number;
  /** Connections at once from one device (one IPv4 address, or one IPv6 /64) on the store and tailnet addresses. */
  maxConnectionsPerDevice: number;
  /** On shutdown, how long requests still running on the store and tailnet addresses may take to finish, in seconds. */
  shutdownGraceSeconds: number;
  /**
   * Development only: read the catalog and stock counts from this saved catalog file instead of
   * Square, for dry runs against the read-only copy of the live catalog. Empty means Square.
   */
  devCatalogFile: string;
  /** Scale names for the dry run's scale preview. A send checks them against ScaleConnect's own list. */
  scaleNames: string[];
  /** An approved run older than this (or whose dry run is) must be dry-run again before it is sent. */
  approvalMaxAgeHours: number;
  /**
   * False: ShelfReady sends only to the dev ScaleConnect harness on this PC (127.0.0.1:18765) and
   * refuses every other address, the store's live ScaleConnect included. True: ShelfReady sends
   * only to liveScaleConnectUrl, and the ScaleConnect address in settings must be exactly that.
   * Step 10 (the FRONT test) turned it on for FRONT alone; going live turns it on for every scale.
   */
  allowLiveScaleConnect: boolean;
  /**
   * The store's live ScaleConnect MCP address, for example http://10.0.0.20:8765/mcp. Needed
   * when allowLiveScaleConnect is true. Plain http to an IPv4 address on this PC or the store
   * network, with the port written out and the path /mcp: ScaleConnect checks the Host header is
   * exactly that address and port. The token goes nowhere else.
   */
  liveScaleConnectUrl: string;
  /**
   * Set true only after Bart approves live Mailchimp changes (step 11). Until then ShelfReady may
   * read the fish email for the dry run, but never changes, copies or schedules a campaign, and
   * the checks with no invoice do not run.
   */
  allowMailchimpWrites: boolean;
  /**
   * The fish email is live. A Square sandbox send changes the fish email only when this is set on
   * purpose, for a test. Default false, and refused with live Square on. Live Square sends change
   * it on their own. Checks with no invoice follow allowMailchimpWrites alone.
   */
  mailchimpFromSandboxRuns: boolean;
  /**
   * The fish email price drift check: the checks and edits set email prices that differ from the
   * register to the register price. Default false. Its own setting, apart from
   * mailchimpFromSandboxRuns, so that test setting alone never lets a check rewrite live prices.
   * The register is the Square in use: live Square once it is on, otherwise the sandbox (a test).
   */
  mailchimpDriftCheck: boolean;
  /**
   * The scales a send may write to (CLAUDE.md rule 3: FRONT is the test scale). FRONT only by
   * default. Sends, resends and previews to any other scale are refused. allowLiveScaleConnect
   * needs this set explicitly in the config file, naming scales in scaleNames. With live Square on
   * it must name every scale in scaleNames, so a by-weight price in Square always matches every
   * scale (rule 12).
   */
  writeScales: string[];
  /** Name, colours and fonts of the app's own pages. Another store changes these to rebrand. */
  branding: Branding;
  /**
   * A JSON file holding a branding block, for example config/branding/cheese-and-crackers.json.
   * Values in `branding` here win over the file. Empty means no file. loadConfig fills in this
   * install's file when it exists and nothing else is named.
   */
  brandingFile: string;
  /** Niceness the server sets for itself at start, so invoice work yields to staff on this PC. */
  nice: number;
  throttle: {
    /** Failures per username before a lockout starts. */
    userFailures: number;
    /** Failures per IP address before a lockout starts. */
    ipFailures: number;
    /** First lockout in seconds. Each further failure doubles it. */
    baseLockSeconds: number;
    maxLockSeconds: number;
    /** Failures older than this are forgotten. */
    windowMinutes: number;
  };
}

export function defaultConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 3000,
    listenAddresses: [],
    allowedHosts: [],
    // Five minutes of HSTS at first. Raise it once HTTPS has worked for a while (docs/INSTALL.md).
    tls: { enabled: false, certPath: '', keyPath: '', statusPath: '', hstsMaxAgeSeconds: 300, reloadCheckSeconds: 60 },
    publicOrigins: [],
    trustProxy: false,
    dbPath: join(REPO_ROOT, 'data', 'shelfready.sqlite3'),
    masterKeyPath: join(homedir(), '.config', 'shelfready', 'master.key'),
    logLevel: 'info',
    bodyLimit: 64 * 1024,
    allowSquareProduction: false,
    passwordMinLength: 12,
    // About 100 ms per hash on this PC. 128 * N * r bytes of memory: 32 MiB.
    scrypt: { N: 2 ** 15, r: 8, p: 1 },
    maxConcurrentHashes: 4,
    reauthMinutes: 15,
    session: { rememberDays: 30, idleMinutes: 120, absoluteHours: 12 },
    throttle: { userFailures: 5, ipFailures: 20, baseLockSeconds: 30, maxLockSeconds: 15 * 60, windowMinutes: 60 },
    // A phone photo of a page is 3 to 6 MB, so 40 MB holds a long invoice with room to spare.
    uploads: { maxTotalBytes: 40 * 1024 * 1024, perUserPerHour: 20, historyPerUserPerHour: 60, dir: '', maxInFlightPerUser: 1, maxInFlight: 3, maxBytesPerDay: 1024 * 1024 * 1024, maxBytesPerUserPerDay: 300 * 1024 * 1024, minFreeBytes: 2 * 1024 * 1024 * 1024 },
    requestTimeoutSeconds: 300,
    connectionTimeoutSeconds: 60,
    headersTimeoutSeconds: 15,
    formTimeoutSeconds: 20,
    keepAliveTimeoutSeconds: 10,
    tlsHandshakeTimeoutSeconds: 10,
    maxHeaderBytes: 8192,
    maxConnections: 500,
    maxConnectionsPerDevice: 8,
    shutdownGraceSeconds: 10,
    devCatalogFile: '',
    scaleNames: [],
    approvalMaxAgeHours: 24,
    allowLiveScaleConnect: false,
    liveScaleConnectUrl: '',
    allowMailchimpWrites: false,
    mailchimpFromSandboxRuns: false,
    mailchimpDriftCheck: false,
    writeScales: ['FRONT'],
    branding: defaultBranding(),
    brandingFile: '',
    nice: 10,
  };
}

/** Reads a branding file. It holds no secrets and is never large. It must sit in config/branding or config/local. */
function readBrandingFile(path: string): BrandingInput {
  let text: string;
  try {
    text = readFileUnder(path, [join(REPO_ROOT, 'config', 'branding'), join(REPO_ROOT, 'config', 'local')], { min: 2, max: 64 * 1024 }).bytes.toString('utf8');
  } catch (err) {
    if (err instanceof SafeFileError && err.problem === 'outside') throw new Error(`The branding file must be inside config/branding or config/local: ${path}.`);
    throw new Error(`Cannot read the branding file at ${path}.`);
  }
  try {
    const v = JSON.parse(text) as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    return v as BrandingInput;
  } catch {
    throw new Error(`The branding file at ${path} is not a JSON object.`);
  }
}

/** The second wins, one level of colours and fonts at a time. */
function mergeBranding(a: BrandingInput | undefined, b: BrandingInput | undefined): BrandingInput {
  return {
    ...a,
    ...b,
    colors: { ...a?.colors, ...b?.colors },
    fonts: { display: { ...a?.fonts?.display, ...b?.fonts?.display }, body: { ...a?.fonts?.body, ...b?.fonts?.body } },
  };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type ConfigInput = DeepPartial<ServerConfig>;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function absPath(p: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(REPO_ROOT, e);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** An origin as a browser writes it: the port is left out when it is the scheme's default. */
function originOf(scheme: 'http' | 'https', name: string, port: number): string {
  if (scheme === 'https') return httpsOrigin(name, port);
  return port === 80 ? `http://${name}` : `http://${name}:${port}`;
}

/** Where cert.ts installs the certificate, and where the server looks when the config names no file. */
export const DEFAULT_TLS_DIR = join(homedir(), '.config', 'shelfready', 'tls');

/** Checks the listening, Host and TLS parts of the config. Throws with a plain message. */
function checkNetwork(c: ServerConfig, dataDir: string): void {
  if (typeof c.tls.enabled !== 'boolean') throw new Error('tls.enabled must be true or false.');
  if (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535) throw new Error('port must be a whole number from 0 to 65535.');
  // The server always listens on this PC. Other machines reach it only through listenAddresses,
  // and only with TLS, so a wildcard address can never be configured.
  if (typeof c.host !== 'string' || !isLoopback(c.host)) {
    throw new Error(
      c.tls.enabled
        ? 'host must be a loopback address (127.0.0.1, ::1 or localhost). Put store network and tailnet addresses in listenAddresses.'
        : 'Without TLS the server binds to 127.0.0.1 only. Turn on tls and use listenAddresses for other addresses.',
    );
  }
  if (!Array.isArray(c.listenAddresses) || c.listenAddresses.length > 8) throw new Error('listenAddresses must be a list of up to 8 addresses.');
  for (const a of c.listenAddresses) {
    const problem = listenAddressProblem(a);
    if (problem) throw new Error(problem);
  }
  if (new Set(c.listenAddresses).size !== c.listenAddresses.length) throw new Error('listenAddresses lists an address twice.');
  if (c.listenAddresses.length > 0 && !c.tls.enabled) throw new Error('Without TLS the server binds to 127.0.0.1 only. Turn on tls before adding listenAddresses.');
  if (!Array.isArray(c.allowedHosts) || c.allowedHosts.length > 8) throw new Error('allowedHosts must be a list of up to 8 host names.');
  c.allowedHosts = c.allowedHosts.map((h) => (typeof h === 'string' ? h.toLowerCase().replace(/\.$/, '') : h));
  for (const h of c.allowedHosts) {
    // A bare address only if the server listens on it: a phone that types it reached us there.
    if (isDnsName(h) || (typeof h === 'string' && isIPv4(h) && c.listenAddresses.includes(h))) continue;
    throw new Error(`allowedHosts entries must be host names like shelfready.example.com, or an address in listenAddresses, not ${String(h)}.`);
  }
  if (c.allowedHosts.length > 0 && !c.tls.enabled) throw new Error('allowedHosts needs tls on. Without TLS the server answers only on this PC.');
  if (c.listenAddresses.length > 0 && c.allowedHosts.length === 0) {
    throw new Error('listenAddresses needs allowedHosts: the name phones use, which the certificate covers.');
  }
  c.tls.certPath = absPath(c.tls.certPath || join(DEFAULT_TLS_DIR, 'current', 'fullchain.pem'));
  c.tls.keyPath = absPath(c.tls.keyPath || join(DEFAULT_TLS_DIR, 'current', 'key.pem'));
  // The record sits in the certificate folder: beside current/ in the layout cert.ts makes.
  const certDir = dirname(c.tls.certPath);
  c.tls.statusPath = absPath(c.tls.statusPath || join(basename(certDir) === 'current' ? dirname(certDir) : certDir, 'status.json'));
  if (isInside(c.tls.keyPath, REPO_ROOT) || isInside(c.tls.keyPath, dataDir)) {
    throw new Error('tls.keyPath must be outside the ShelfReady folder and the data folder, for example in ~/.config/shelfready/tls.');
  }
  const { hstsMaxAgeSeconds: hsts, reloadCheckSeconds: reload } = c.tls;
  if (!Number.isInteger(hsts) || hsts < 0 || hsts > 63072000) throw new Error('tls.hstsMaxAgeSeconds must be a whole number of seconds from 0 to 63072000 (two years).');
  if (!Number.isInteger(reload) || reload < 1 || reload > 86400) throw new Error('tls.reloadCheckSeconds must be a whole number from 1 to 86400.');
  for (const k of ['headersTimeoutSeconds', 'formTimeoutSeconds', 'keepAliveTimeoutSeconds', 'tlsHandshakeTimeoutSeconds'] as const) {
    if (typeof c[k] !== 'number' || !(c[k] > 0) || c[k] > 600) throw new Error(`${k} must be more than 0 and at most 600.`);
  }
  if (c.headersTimeoutSeconds > c.requestTimeoutSeconds || c.formTimeoutSeconds > c.requestTimeoutSeconds) {
    throw new Error('headersTimeoutSeconds and formTimeoutSeconds must not be more than requestTimeoutSeconds.');
  }
  if (!Number.isInteger(c.maxHeaderBytes) || c.maxHeaderBytes < 2048 || c.maxHeaderBytes > 65536) throw new Error('maxHeaderBytes must be a whole number from 2048 to 65536.');
  if (!Number.isInteger(c.maxConnections) || c.maxConnections < 1 || c.maxConnections > 10000) throw new Error('maxConnections must be a whole number from 1 to 10000.');
  if (!Number.isInteger(c.maxConnectionsPerDevice) || c.maxConnectionsPerDevice < 1 || c.maxConnectionsPerDevice > c.maxConnections) {
    throw new Error('maxConnectionsPerDevice must be a whole number from 1 to maxConnections.');
  }
  if (typeof c.shutdownGraceSeconds !== 'number' || !(c.shutdownGraceSeconds > 0) || c.shutdownGraceSeconds > 60) throw new Error('shutdownGraceSeconds must be more than 0 and at most 60.');
  // ShelfReady is never behind a proxy. Trusting X-Forwarded-For would let any client choose the
  // address the sign-in throttle and the logs see.
  if (c.trustProxy !== false) throw new Error('trustProxy must be false. ShelfReady is not run behind a proxy.');
}

/**
 * The dev harness address, as src/scaleconnect/dev-connection.ts names it (DEV_MCP_URL; a test
 * keeps the two equal). Written out here so the config loads nothing that can reach a scale: the
 * purchase history pages load this file, and must reach no ScaleConnect code.
 */
export const DEV_HARNESS_MCP_URL = 'http://127.0.0.1:18765/mcp';

/**
 * Why a live ScaleConnect address cannot be used, or null. Plain http (ScaleConnect serves no TLS)
 * to an IPv4 address on this PC or the store network, the port written out, the path /mcp, and
 * nothing else in it. ScaleConnect refuses any Host header but exactly address:port.
 */
export function liveScaleConnectUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'liveScaleConnectUrl must be a full address like http://10.0.0.20:8765/mcp.';
  }
  if (u.protocol !== 'http:') return 'liveScaleConnectUrl must start with http://. ScaleConnect serves plain http on the store network.';
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/mcp') return 'liveScaleConnectUrl must end in /mcp, with no login, query or fragment.';
  if (!isIPv4(u.hostname) || !isStoreAddress(u.hostname)) return 'liveScaleConnectUrl must name an IPv4 address on this PC or the store network (10.x, 172.16 to 172.31, 192.168/16 or 127.x), not a host name.';
  if (u.port === '') return 'liveScaleConnectUrl must write out the port, for example :8765. ScaleConnect checks the Host header names it.';
  if (u.href === DEV_HARNESS_MCP_URL) return 'liveScaleConnectUrl is the dev harness address. Leave allowLiveScaleConnect off to use the dev harness.';
  return null;
}

/** Loopback or a private IPv4 range. Tailscale is left out: the scales are on the store network only. */
function isStoreAddress(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Live Square and live scales go together (Bart, November 16): a by-weight item's Square price
 * must match every scale (CLAUDE.md rule 12), so with scales named, live Square needs live
 * ScaleConnect writing to every one of them. Throws with a plain message.
 */
function checkLiveSwitches(c: ServerConfig): void {
  if (typeof c.liveScaleConnectUrl !== 'string') throw new Error('liveScaleConnectUrl must be text.');
  if (c.allowLiveScaleConnect) {
    if (!c.liveScaleConnectUrl) throw new Error('allowLiveScaleConnect needs liveScaleConnectUrl: the store ScaleConnect address, for example http://10.0.0.20:8765/mcp.');
    const problem = liveScaleConnectUrlProblem(c.liveScaleConnectUrl);
    if (problem) throw new Error(problem);
    c.liveScaleConnectUrl = new URL(c.liveScaleConnectUrl).href;
    const unknown = c.writeScales.filter((n) => !c.scaleNames.includes(n));
    if (unknown.length) throw new Error(`writeScales names ${unknown.join(', ')}, which scaleNames does not list. List every scale in scaleNames, as ScaleConnect reports them.`);
  } else if (c.liveScaleConnectUrl !== '') {
    throw new Error('liveScaleConnectUrl is set but allowLiveScaleConnect is off. Remove it, or turn live scales on.');
  }
  if (!c.allowSquareProduction) return;
  if (c.devCatalogFile) throw new Error('devCatalogFile is for development only. Remove it before turning on live Square (allowSquareProduction).');
  if (c.mailchimpFromSandboxRuns) throw new Error('mailchimpFromSandboxRuns is a sandbox test setting. Turn it off before turning on live Square (allowSquareProduction).');
  if (c.scaleNames.length === 0) return;
  if (!c.allowLiveScaleConnect) {
    throw new Error('Live Square needs the live scales too (allowLiveScaleConnect), so a price sold by weight in Square always matches the scales. Turn both on together.');
  }
  const all = [...new Set(c.scaleNames)].sort().join(',');
  if ([...new Set(c.writeScales)].sort().join(',') !== all) {
    throw new Error(`Live Square needs writeScales to name every scale in scaleNames (${c.scaleNames.join(', ')}), so a price sold by weight goes to every scale in the same run.`);
  }
}

/**
 * Merges input over the defaults and checks the result. Throws with a plain message.
 * allowVerboseLogs is for tests only: trace and debug logs can carry raw request bytes.
 */
export function makeConfig(input: ConfigInput = {}, opts: { allowVerboseLogs?: boolean } = {}): ServerConfig {
  const d = defaultConfig();
  const c: ServerConfig = {
    ...d,
    ...input,
    tls: { ...d.tls, ...input.tls },
    scrypt: { ...d.scrypt, ...input.scrypt },
    session: { ...d.session, ...input.session },
    throttle: { ...d.throttle, ...input.throttle },
    uploads: { ...d.uploads, ...input.uploads },
    publicOrigins: input.publicOrigins ?? d.publicOrigins,
    listenAddresses: input.listenAddresses ?? d.listenAddresses,
    allowedHosts: input.allowedHosts ?? d.allowedHosts,
    scaleNames: input.scaleNames ?? d.scaleNames,
    writeScales: input.writeScales ?? d.writeScales,
    // Checked and given absolute font paths just below.
    branding: d.branding,
  } as ServerConfig;
  if (c.brandingFile) c.brandingFile = absPath(c.brandingFile);
  c.branding = makeBranding(mergeBranding(c.brandingFile ? readBrandingFile(c.brandingFile) : undefined, input.branding), absPath);
  c.dbPath = absPath(c.dbPath);
  c.uploads.dir = c.uploads.dir ? absPath(c.uploads.dir) : join(dirname(c.dbPath), 'uploads');
  if (c.devCatalogFile) c.devCatalogFile = absPath(c.devCatalogFile);
  if (!Number.isInteger(c.uploads.maxTotalBytes) || c.uploads.maxTotalBytes < 1024) throw new Error('uploads.maxTotalBytes must be a whole number of bytes.');
  if (!Number.isInteger(c.uploads.perUserPerHour) || c.uploads.perUserPerHour < 1) throw new Error('uploads.perUserPerHour must be at least 1.');
  if (!Number.isInteger(c.uploads.historyPerUserPerHour) || c.uploads.historyPerUserPerHour < 1 || c.uploads.historyPerUserPerHour > 1000) {
    throw new Error('uploads.historyPerUserPerHour must be a whole number from 1 to 1000.');
  }
  for (const k of ['maxInFlightPerUser', 'maxInFlight', 'maxBytesPerDay'] as const) {
    if (!Number.isInteger(c.uploads[k]) || c.uploads[k] < 1) throw new Error(`uploads.${k} must be a whole number of at least 1.`);
  }
  if (!Number.isInteger(c.uploads.minFreeBytes) || c.uploads.minFreeBytes < 0) throw new Error('uploads.minFreeBytes must be a whole number of bytes.');
  if (!(c.requestTimeoutSeconds > 0) || !(c.connectionTimeoutSeconds > 0)) throw new Error('requestTimeoutSeconds and connectionTimeoutSeconds must be more than 0.');
  // These moved into the admin settings, so there is one place to change them.
  for (const moved of ['dailyReadingCapUsd', 'bigChangePercent']) {
    if (moved in (input as Record<string, unknown>)) throw new Error(`${moved} is now an admin setting. Remove it from the config file and change it on the Settings page.`);
  }
  if (!Number.isInteger(c.uploads.maxBytesPerUserPerDay) || c.uploads.maxBytesPerUserPerDay < 1) throw new Error('uploads.maxBytesPerUserPerDay must be a whole number of at least 1.');
  if (!Array.isArray(c.scaleNames) || c.scaleNames.length > 20 || !c.scaleNames.every((n) => typeof n === 'string' && /^[A-Za-z0-9 _-]{1,32}$/.test(n))) {
    throw new Error('scaleNames must be a list of up to 20 short names (letters, digits, spaces, _ and -).');
  }
  if (!(c.approvalMaxAgeHours > 0 && c.approvalMaxAgeHours <= 24)) throw new Error('approvalMaxAgeHours must be more than 0 and at most 24 (Square refuses stock counts older than a day).');
  if (typeof c.allowLiveScaleConnect !== 'boolean') throw new Error('allowLiveScaleConnect must be true or false.');
  if (typeof c.allowMailchimpWrites !== 'boolean') throw new Error('allowMailchimpWrites must be true or false.');
  if (typeof c.mailchimpFromSandboxRuns !== 'boolean') throw new Error('mailchimpFromSandboxRuns must be true or false.');
  if (typeof c.mailchimpDriftCheck !== 'boolean') throw new Error('mailchimpDriftCheck must be true or false.');
  if (typeof c.allowSquareProduction !== 'boolean') throw new Error('allowSquareProduction must be true or false.');
  if (!Array.isArray(c.writeScales) || c.writeScales.length > 20 || !c.writeScales.every((n) => typeof n === 'string' && /^[A-Za-z0-9 _-]{1,32}$/.test(n))) {
    throw new Error('writeScales must be a list of up to 20 short scale names.');
  }
  if (c.allowLiveScaleConnect && (input.writeScales === undefined || c.writeScales.length === 0)) {
    throw new Error('allowLiveScaleConnect needs writeScales set in the config file, naming the only scales a send may write to (FRONT for the test).');
  }
  checkLiveSwitches(c);
  if (!Number.isInteger(c.nice) || c.nice < 0 || c.nice > 19) throw new Error('nice must be a whole number from 0 to 19.');
  c.masterKeyPath = absPath(c.masterKeyPath);
  checkNetwork(c, dirname(c.dbPath));
  const { N, r, p } = c.scrypt;
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) throw new Error('scrypt.N must be a power of two.');
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) throw new Error('scrypt.r and scrypt.p must be at least 1.');
  if (c.passwordMinLength < 8) throw new Error('passwordMinLength must be at least 8.');
  if (!['fatal', 'error', 'warn', 'info', 'silent'].includes(c.logLevel) && !(opts.allowVerboseLogs && ['debug', 'trace'].includes(c.logLevel))) {
    throw new Error('logLevel must be fatal, error, warn, info or silent. debug and trace can log raw request bytes.');
  }
  if (!Number.isInteger(c.maxConcurrentHashes) || c.maxConcurrentHashes < 1) throw new Error('maxConcurrentHashes must be at least 1.');
  if (!(c.reauthMinutes > 0)) throw new Error('reauthMinutes must be more than 0.');
  if (c.publicOrigins.length === 0) {
    const scheme = c.tls.enabled ? 'https' : 'http';
    const loopback = c.host === '::1' ? ['[::1]', 'localhost'] : c.host === 'localhost' ? ['localhost', '127.0.0.1', '[::1]'] : ['127.0.0.1', 'localhost'];
    c.publicOrigins = [...c.allowedHosts.map((h) => httpsOrigin(h, c.port)), ...loopback.map((h) => originOf(scheme, h, c.port))];
  }
  for (const o of c.publicOrigins) {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`publicOrigins has an entry that is not a URL: ${o}`);
    }
    if (u.origin !== o) throw new Error(`publicOrigins entries must be bare origins like https://host:port, not ${o}`);
    // Forms may come only from pages this server itself serves.
    const name = hostName(u.host);
    const ours = name !== null && (c.allowedHosts.includes(name) || name === 'localhost' || addressKind(name.replace(/^\[|\]$/g, '')) === 'loopback');
    if (!ours) throw new Error(`publicOrigins may name only this PC or a name in allowedHosts, not ${o}`);
    if (c.tls.enabled && u.protocol !== 'https:') throw new Error(`With TLS on, publicOrigins must be https, not ${o}`);
  }
  return c;
}

/** True when cookies must carry the Secure flag: always when TLS is on. */
export function cookiesSecure(c: ServerConfig): boolean {
  return c.tls.enabled;
}

/** Reads the config file named by SHELFREADY_CONFIG, or config/local/server.json if it exists. */
export function loadConfig(file = process.env.SHELFREADY_CONFIG): ServerConfig {
  const path = file ? absPath(file) : join(REPO_ROOT, 'config', 'local', 'server.json');
  let input: ConfigInput = {};
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (file || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read the config file at ${path}.`);
  }
  if (text !== undefined) {
    try {
      input = JSON.parse(text) as ConfigInput;
    } catch {
      throw new Error(`The config file at ${path} is not valid JSON.`);
    }
  }
  // This install's look, unless the config names another file.
  const installBranding = join(REPO_ROOT, 'config', 'branding', 'cheese-and-crackers.json');
  if (input.brandingFile === undefined && existsSync(installBranding)) input.brandingFile = installBranding;
  return makeConfig(input);
}
