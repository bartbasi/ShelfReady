// The parts of scripts/net/cert.ts that tests use directly: the install config, the token file,
// the acme.sh command line and hook, checking what Let's Encrypt issued, installing it, and the
// renewal record the settings page reads. Nothing here prints a token.
//
// With deSEC, acme.sh never sees the token: it calls ShelfReady's own hook (dns_shelfready), which
// runs scripts/net/desec-dns.ts, which reads the token itself and sends it only in an HTTP header.
// acme.sh's own deSEC hook would pass it to curl on the command line, where any other user on
// this PC could read it while it runs.

import { spawn } from 'node:child_process';
import { randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import {
  closeSync,
  constants as fsc,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import { isStagingIssuer, STATUS_FILE } from '../../src/server/cert-status.ts';
import { isDnsName } from '../../src/server/network.ts';
import { loadTlsMaterial, parseChain, readSmallFile, TlsFileError } from '../../src/server/tls.ts';
import { riskyEnvironment } from '../../src/lib/risky-env.ts';

export const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
export const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

export type Ca = 'staging' | 'production';

/** A failure with words safe to print. detail is acme.sh's output with every token removed. */
export class CertError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.detail = detail;
  }
}

export interface CertConfig {
  /** The name phones use, for example shelfready.example.com. */
  domain: string;
  /** Where _acme-challenge.<domain> points by CNAME, for example example.dedyn.io. Empty: no alias. */
  challengeAlias: string;
  /** desec, or an acme.sh DNS hook name like dns_cf with its own tokenEnv. */
  dnsProvider: string;
  /** The acme.sh DNS hook. */
  dnsHook: string;
  /**
   * True for deSEC: ShelfReady's own hook writes the record and acme.sh gets no token. False for
   * another acme.sh hook, which gets the token variables in its environment.
   */
  ownHook: boolean;
  /** The config file this came from, for the hook to read again. Empty when made in code. */
  configPath: string;
  /** acme.sh variable name, then the key that holds its value in tokenFile. */
  tokenEnv: Record<string, string>;
  tokenFile: string;
  tlsDir: string;
  acmeHome: string;
  acmeSh: string;
  email: string;
  /** How long acme.sh waits after writing the TXT record before Let's Encrypt looks. */
  dnsWaitSeconds: number;
}

/** deSEC goes through ShelfReady's own hook. tokenEnv names the key in the token file it needs. */
const PROVIDERS: Record<string, { hook: string; env: Record<string, string> }> = {
  desec: { hook: 'dns_shelfready', env: { DEDYN_TOKEN: 'DESEC_TOKEN' } },
};

const KEYS = ['domain', 'challengeAlias', 'dnsProvider', 'tokenEnv', 'tokenFile', 'tlsDir', 'acmeHome', 'acmeSh', 'email', 'dnsWaitSeconds'];

/** Variable names a token file may never set in acme.sh's environment: they change what runs or where it connects. */
const UNSAFE_ENV = /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|CDPATH|PS4|TMPDIR|TZ|LANG|LC_.*|LD_.*|LE_.*|ACME_.*|ACCOUNT_.*|CA_.*|CERT_.*|DOMAIN_.*|STAGE|DEBUG|NODE_.*|.*_PROXY|CURL_.*|SSL_.*|OPENSSL_.*|HTTP_HEADER|USER_AGENT)$/i;

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The real path of p, following links in the folders that exist. */
function realish(p: string): string {
  const rest: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** Checks the install config. Throws CertError with a plain message. repoRoot: paths may not be inside it. */
export function makeCertConfig(input: unknown, repoRoot: string, configPath = ''): CertConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new CertError('The certificate config must be a JSON object.');
  const v = input as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!KEYS.includes(k)) throw new CertError(`The certificate config has an unknown field: ${k}.`);
  const str = (k: string, d: string): string => {
    const x = v[k] ?? d;
    if (typeof x !== 'string') throw new CertError(`${k} must be text.`);
    return x.trim();
  };
  const domain = str('domain', '').toLowerCase();
  if (!isDnsName(domain)) throw new CertError('domain must be a host name like shelfready.example.com.');
  const challengeAlias = str('challengeAlias', '').toLowerCase();
  if (challengeAlias && !isDnsName(challengeAlias)) throw new CertError('challengeAlias must be a host name like example.dedyn.io, or left out.');
  const dnsProvider = str('dnsProvider', 'desec');
  const known = PROVIDERS[dnsProvider];
  if (!known && (!/^dns_[a-z0-9_]{1,40}$/.test(dnsProvider) || dnsProvider === 'dns_shelfready')) throw new CertError('dnsProvider must be desec, or an acme.sh DNS hook name like dns_cf.');
  let tokenEnv: Record<string, string>;
  if (v.tokenEnv === undefined) {
    if (!known) throw new CertError(`dnsProvider ${dnsProvider} needs tokenEnv: which acme.sh variable each key in the token file sets.`);
    tokenEnv = { ...known.env };
  } else {
    if (typeof v.tokenEnv !== 'object' || v.tokenEnv === null || Array.isArray(v.tokenEnv)) throw new CertError('tokenEnv must map acme.sh variable names to keys in the token file.');
    tokenEnv = {};
    for (const [name, key] of Object.entries(v.tokenEnv as Record<string, unknown>)) {
      // acme.sh hooks use names like DEDYN_TOKEN and CF_Token.
      if (!/^[A-Za-z][A-Za-z0-9_]{1,63}$/.test(name) || UNSAFE_ENV.test(name)) throw new CertError(`tokenEnv may not set ${name}.`);
      if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(key)) throw new CertError(`tokenEnv.${name} must name a key in the token file, in capitals.`);
      tokenEnv[name] = key;
    }
    if (Object.keys(tokenEnv).length === 0 || Object.keys(tokenEnv).length > 4) throw new CertError('tokenEnv must name from 1 to 4 variables.');
  }
  const path = (k: string, d: string): string => {
    const p = expandHome(str(k, d));
    if (!isAbsolute(p)) throw new CertError(`${k} must be a full path, or start with ~/.`);
    if (isInside(realish(p), realish(repoRoot))) throw new CertError(`${k} must be outside the ShelfReady folder, for example in ~/.config/shelfready.`);
    return p;
  };
  const tokenFile = path('tokenFile', '~/.config/shelfready/acme.env');
  const tlsDir = path('tlsDir', '~/.config/shelfready/tls');
  const acmeHome = path('acmeHome', '~/.config/shelfready/acme');
  const acmeSh = expandHome(str('acmeSh', '/usr/bin/acme.sh'));
  if (!isAbsolute(acmeSh)) throw new CertError('acmeSh must be a full path, like /usr/bin/acme.sh.');
  const email = str('email', '');
  if (email && !/^[^\s@"'\\]{1,64}@[A-Za-z0-9.-]{3,190}$/.test(email)) throw new CertError('email must be an email address, or left out.');
  const wait = v.dnsWaitSeconds ?? 120;
  if (!Number.isInteger(wait) || (wait as number) < 30 || (wait as number) > 900) throw new CertError('dnsWaitSeconds must be a whole number from 30 to 900.');
  return { domain, challengeAlias, dnsProvider, dnsHook: known ? known.hook : dnsProvider, ownHook: Boolean(known), configPath, tokenEnv, tokenFile, tlsDir, acmeHome, acmeSh, email, dnsWaitSeconds: wait as number };
}

export function loadCertConfig(path: string, repoRoot: string): CertConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CertError(`Cannot read the certificate config at ${path}. Write it as docs/INSTALL.md shows.`);
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CertError(`The certificate config at ${path} is not valid JSON.`);
  }
  return makeCertConfig(v, repoRoot, resolve(path));
}

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

/**
 * Reads a KEY=VALUE file of secrets. It must be a regular file owned by this user that only this
 * user can read, in a folder others cannot write to. Errors name the file or key, never a value.
 */
export function readEnvFile(path: string): Map<string, string> {
  const dir = statSync(dirname(path), { throwIfNoEntry: false });
  if (!dir) throw new CertError(`There is no folder for the token file ${path}.`);
  if ((dir.mode & 0o022) !== 0 || (uid() !== undefined && dir.uid !== uid())) throw new CertError(`The folder holding ${path} must be yours and not writable by others. Run: chmod 700 ${dirname(path)}`);
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new CertError(`There is no token file at ${path}. Create it as docs/INSTALL.md shows.`);
    if (code === 'ELOOP') throw new CertError(`The token file at ${path} is a symbolic link. Use the real file.`);
    throw new CertError(`Cannot read the token file at ${path}.`);
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CertError(`The token file at ${path} is not a regular file.`);
    if (uid() !== undefined && st.uid !== uid()) throw new CertError(`The token file at ${path} must be owned by you.`);
    if ((st.mode & 0o077) !== 0) throw new CertError(`The token file at ${path} must be mode 600. Run: chmod 600 ${path}`);
    if (st.size > 16 * 1024) throw new CertError(`The token file at ${path} is too large.`);
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  const out = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out.set(m[1], m[2].trim().replace(/^(["'])(.*)\1$/, '$2'));
  }
  return out;
}

/** The token values acme.sh needs, by acme.sh variable name. Checks each one's shape. */
export function readTokens(c: CertConfig): Record<string, string> {
  const file = readEnvFile(c.tokenFile);
  const out: Record<string, string> = {};
  for (const [name, key] of Object.entries(c.tokenEnv)) {
    const value = file.get(key) ?? '';
    if (value === '') throw new CertError(`${key} is not set in ${c.tokenFile}.`);
    if (!/^[\x21-\x7e]{8,512}$/.test(value)) throw new CertError(`${key} in ${c.tokenFile} does not look like a token: it must be 8 to 512 characters with no spaces.`);
    out[name] = value;
  }
  return out;
}

/**
 * acme.sh must be a regular file (a link to one is fine, as Debian installs it) owned by root or
 * by this user, that no one else can change, in a folder no one else can change.
 */
export function checkAcmeSh(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new CertError(`acme.sh is not installed at ${path}. Install it: sudo apt install acme.sh`);
  }
  const owners = [0, uid()];
  for (const p of [real, dirname(real)]) {
    const st = statSync(p);
    if (!owners.includes(st.uid) || (st.mode & 0o022) !== 0) throw new CertError(`${p} can be changed by another user, so acme.sh there is not run.`);
  }
  const st = statSync(real);
  if (!st.isFile() || (st.mode & 0o100) === 0) throw new CertError(`${real} is not a program.`);
  return real;
}

/** The acme.sh command line. One explicit command for issue and renewal: nothing comes from saved state. */
export function acmeArgs(c: CertConfig, o: { ca: Ca; home: string; accountConf: string }): string[] {
  return [
    '--issue',
    '--force',
    '--server',
    o.ca === 'production' ? LE_PRODUCTION : LE_STAGING,
    '--home',
    o.home,
    '--config-home',
    o.home,
    '--cert-home',
    join(o.home, 'certs'),
    '--accountconf',
    o.accountConf,
    '--domain',
    c.domain,
    '--dns',
    c.dnsHook,
    ...(c.challengeAlias ? ['--challenge-alias', c.challengeAlias] : []),
    '--dnssleep',
    String(c.dnsWaitSeconds),
    '--keylength',
    'ec-256',
    '--always-force-new-domain-key',
    '--no-color',
    ...(c.email ? ['--accountemail', c.email] : []),
  ];
}

/**
 * Why cert.ts or desec-dns.ts must not run here, or null. They hold the deSEC token, so they refuse
 * any NODE_OPTIONS and any Node flag at all (a preload or an inspector could read it), as well as
 * the proxy, certificate and key log settings the Square client refuses (src/lib/risky-env.ts).
 */
export function scriptEnvironmentProblem(env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): string | null {
  if (env.NODE_OPTIONS) return 'NODE_OPTIONS';
  if (execArgv.length > 0) return 'a Node flag on the command line';
  const risky = riskyEnvironment(env, execArgv);
  return risky === 'flag' ? 'a Node proxy or certificate flag' : risky;
}

/**
 * Tests run a fake deSEC on this PC with a fake token that starts with this. The fake deSEC
 * address is honored only together with such a token, so a real token can never be sent there.
 */
export const TEST_TOKEN_PREFIX = 'shelfready-test-token-';

/** The fake deSEC address tests give, if it is one, and only with a test token. Otherwise null. */
export function testDesecApi(env: NodeJS.ProcessEnv, token: string | undefined): string | null {
  const url = env.SHELFREADY_TEST_DESEC_API;
  if (!url || !token || !token.startsWith(TEST_TOKEN_PREFIX)) return null;
  return /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/api\/v1$/.test(url) ? url : null;
}

/**
 * ShelfReady's acme.sh DNS hook. acme.sh finds it in its home folder (dnsapi/dns_shelfready.sh)
 * and sources it. It only runs desec-dns.ts, named by full paths in the environment.
 */
export const HOOK_SCRIPT = `#!/usr/bin/env sh
# Written by ShelfReady (scripts/net/cert.ts) on every run. acme.sh calls these to add and remove
# the DNS-01 TXT record. ShelfReady's own code writes it at deSEC and reads the token itself, so
# the token is never on a command line and never in acme.sh's settings.
dns_shelfready_add() {
  "$SHELFREADY_NODE" "$SHELFREADY_DNS_HOOK" add "$1" "$2" "$SHELFREADY_CERT_CONFIG"
}
dns_shelfready_rm() {
  "$SHELFREADY_NODE" "$SHELFREADY_DNS_HOOK" rm "$1" "$2" "$SHELFREADY_CERT_CONFIG"
}
`;

/** Writes the hook into an acme.sh home, in a folder only this user can use. */
export function writeHook(home: string): void {
  ensurePrivateDir(join(home, 'dnsapi'));
  writeAtomic(join(home, 'dnsapi', 'dns_shelfready.sh'), HOOK_SCRIPT);
}

/**
 * What acme.sh gets besides PATH, HOME and LANG. With the own hook: where node, desec-dns.ts and
 * the config are, and no token. With another acme.sh hook: the token variables.
 */
export function acmeEnv(c: CertConfig, tokens: Record<string, string>, repoRoot: string): Record<string, string> {
  if (!c.ownHook) return { ...tokens };
  if (!c.configPath) throw new CertError('The deSEC hook needs the certificate config file.');
  const env: Record<string, string> = {
    SHELFREADY_NODE: process.execPath,
    SHELFREADY_DNS_HOOK: join(repoRoot, 'scripts', 'net', 'desec-dns.ts'),
    SHELFREADY_CERT_CONFIG: c.configPath,
  };
  // Only a test, with its fake token, can point the hook at a fake deSEC on this PC.
  const test = testDesecApi(process.env, tokens.DEDYN_TOKEN);
  if (test) env.SHELFREADY_TEST_DESEC_API = test;
  return env;
}

/** Removes every token value, and anything shaped like an auth header or saved setting, from text. */
export function redact(text: string, tokens: Record<string, string>): string {
  let out = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  for (const value of Object.values(tokens)) if (value) out = out.split(value).join('[redacted]');
  out = out.replace(/(Authorization:\s*\S+\s+)\S+/gi, '$1[redacted]').replace(/^(\s*SAVED_[A-Za-z0-9_]+=).*$/gm, '$1[redacted]');
  return out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** A folder only this user can use. Made if missing. Throws if it belongs to someone else or is open to others. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new CertError(`${dir} is not a folder.`);
  if (uid() !== undefined && st.uid !== uid()) throw new CertError(`${dir} belongs to another user.`);
  if ((st.mode & 0o077) !== 0) throw new CertError(`Other users can open ${dir}. Run: chmod 700 ${dir}`);
}

/** Writes a file mode 600 under a temporary name, then renames it into place, so a reader never sees half of it. */
export function writeAtomic(path: string, bytes: Buffer | string): void {
  const tmp = `${path}.new-${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const dfd = openSync(dirname(path), fsc.O_RDONLY);
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

const DAY_MS = 24 * 3600_000;

/**
 * Checks a new certificate before it is installed: it covers the domain, fits the key, is a chain
 * in order, is valid now, and comes from the expected service. A production certificate must chain
 * to a root that Node trusts. Returns the chain. Throws CertError.
 */
export function checkIssued(fullchain: Buffer, key: Buffer, o: { domain: string; ca: Ca; now: number; roots?: readonly string[] }): X509Certificate[] {
  let chain: X509Certificate[];
  try {
    chain = parseChain(fullchain.toString('latin1'), 'the new certificate');
  } catch (err) {
    throw new CertError(err instanceof TlsFileError ? err.message : 'The new certificate could not be read.');
  }
  const leaf = chain[0];
  let pk;
  try {
    pk = createPrivateKey(key);
  } catch {
    throw new CertError('The new key could not be read.');
  }
  if (!leaf.checkPrivateKey(pk)) throw new CertError('The new certificate and key do not belong together.');
  if (!leaf.checkHost(o.domain, { subject: 'never' })) throw new CertError(`The new certificate does not cover ${o.domain}.`);
  for (let i = 0; i + 1 < chain.length; i++) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) throw new CertError('The new certificate chain is not in order.');
  }
  const from = leaf.validFromDate.getTime();
  const to = leaf.validToDate.getTime();
  if (from > o.now + 5 * 60_000 || to < o.now + DAY_MS) throw new CertError('The new certificate is not valid now.');
  if (to - from > 400 * DAY_MS) throw new CertError('The new certificate lasts longer than any Let\'s Encrypt certificate.');
  if (o.ca === 'staging') {
    if (!isStagingIssuer(leaf.issuer)) throw new CertError('A staging certificate was expected, but this one does not say (STAGING).');
    return chain;
  }
  if (isStagingIssuer(leaf.issuer)) throw new CertError('A production certificate was expected, but this one is from staging.');
  const last = chain[chain.length - 1];
  const anchored = (o.roots ?? rootCertificates).some((pem) => {
    try {
      const root = new X509Certificate(pem);
      return root.fingerprint256 === last.fingerprint256 || (last.checkIssued(root) && last.verify(root.publicKey));
    } catch {
      return false;
    }
  });
  if (!anchored) throw new CertError('The new certificate does not chain to a trusted root, so it was not installed.');
  return chain;
}

/** Where the installed pair and the renewal record are. current is a link to one release folder. */
export function installedPaths(tlsDir: string): { cert: string; key: string; status: string } {
  return { cert: join(tlsDir, 'current', 'fullchain.pem'), key: join(tlsDir, 'current', 'key.pem'), status: join(tlsDir, STATUS_FILE) };
}

/** Reads a pair from disk and checks it the way the server will. Throws CertError. */
export function checkInstalled(paths: { cert: string; key: string }, hosts: readonly string[]): void {
  try {
    loadTlsMaterial({ certPath: paths.cert, keyPath: paths.key }, hosts, []);
  } catch (err) {
    throw new CertError(`The installed certificate failed its check: ${err instanceof TlsFileError ? err.message : 'it could not be read.'}`);
  }
}

function writeNew(path: string, bytes: Buffer): void {
  const fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, fsc.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Installs a checked certificate and key so they always change together. Both are written (mode
 * 600) into a new release folder (mode 700) and read back and checked as a pair. Then one rename
 * switches the current link to that folder: the server never sees one new file with one old one.
 * A failure anywhere before the switch throws and leaves the installed pair as it was. Once the
 * switch is done the new pair is installed: what follows (syncing the folder, checking again
 * through the link, removing old release folders) can only add warnings, which are returned.
 * Old release folders are removed, keeping the one the link pointed to before.
 * afterKey and afterSwitch: tests only, to fail between the two files or after the switch.
 */
export function installPair(tlsDir: string, fullchain: Buffer, key: Buffer, o: { hosts: readonly string[]; afterKey?: () => void; afterSwitch?: () => void }): { warnings: string[] } {
  ensurePrivateDir(tlsDir);
  const releases = join(tlsDir, 'releases');
  ensurePrivateDir(releases);
  const name = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(4).toString('hex')}`;
  const dir = join(releases, name);
  mkdirSync(dir, { mode: 0o700 });
  writeNew(join(dir, 'key.pem'), key);
  o.afterKey?.();
  writeNew(join(dir, 'fullchain.pem'), fullchain);
  fsyncDir(dir);
  checkInstalled({ cert: join(dir, 'fullchain.pem'), key: join(dir, 'key.pem') }, o.hosts);
  const current = join(tlsDir, 'current');
  const st = lstatSync(current, { throwIfNoEntry: false });
  if (st && !st.isSymbolicLink()) throw new CertError(`${current} is a real folder, not a link. Move it away and try again.`);
  // Read before the switch: the folder in use until now is the one kept as the one before.
  const previous = currentRelease(tlsDir);
  const link = join(tlsDir, `current.new-${randomBytes(6).toString('hex')}`);
  symlinkSync(join('releases', name), link);
  try {
    renameSync(link, current);
  } catch {
    rmSync(link, { force: true });
    throw new CertError(`Could not switch ${current} to the new certificate.`);
  }
  const warnings: string[] = [];
  const after = (what: string, step: () => void): void => {
    try {
      step();
    } catch (err) {
      warnings.push(`The new certificate is in place, but ${what} failed: ${err instanceof CertError ? err.message : err instanceof Error ? err.name : 'unknown'}.`);
    }
  };
  after('syncing the certificate folder', () => {
    fsyncDir(tlsDir);
    o.afterSwitch?.();
  });
  after('checking it again through the current link', () => checkInstalled(installedPaths(tlsDir), o.hosts));
  after('removing old release folders', () => pruneReleases(tlsDir, name, previous));
  return { warnings };
}

/**
 * Removes every release folder but the new one and the one in use before it. Half-written folders
 * from failed installs are never kept. Leftover temporary links go too.
 */
function pruneReleases(tlsDir: string, current: string, previous: string): void {
  const releases = join(tlsDir, 'releases');
  for (const n of readdirSync(releases)) {
    if (n === current || n === previous) continue;
    if (/^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/.test(n)) rmSync(join(releases, n), { recursive: true, force: true });
  }
  for (const n of readdirSync(tlsDir)) if (/^current\.new-[0-9a-f]{12}$/.test(n)) rmSync(join(tlsDir, n), { force: true });
}

/** The release folder current points at, or '' when there is none. */
export function currentRelease(tlsDir: string): string {
  try {
    return basename(readlinkSync(join(tlsDir, 'current')));
  } catch {
    return '';
  }
}

export interface RecordEntry {
  at: number;
  ok: boolean;
  kind: 'issue' | 'renew' | 'check' | 'dry-run';
  ca: Ca | '';
  message: string;
}

/** Updates status.json beside the certificate, which the settings page reads. Holds no secret. */
export function updateRecord(tlsDir: string, patch: { lastCheck?: RecordEntry; lastRenewal?: RecordEntry; lastDryRun?: RecordEntry }): void {
  ensurePrivateDir(tlsDir);
  const path = join(tlsDir, STATUS_FILE);
  let current: Record<string, unknown> = {};
  try {
    const v = JSON.parse(readSmallFile(path, 16 * 1024).bytes.toString('utf8')) as unknown;
    if (typeof v === 'object' && v !== null && (v as { version?: unknown }).version === 1) current = v as Record<string, unknown>;
  } catch {
    // No record yet, or a damaged one: start a new one.
  }
  const out: Record<string, unknown> = { version: 1, lastCheck: current.lastCheck, lastRenewal: current.lastRenewal, lastDryRun: current.lastDryRun };
  for (const [k, e] of Object.entries(patch)) {
    if (e) out[k] = { at: new Date(e.at).toISOString(), ok: e.ok, kind: e.kind, ca: e.ca, message: e.message.slice(0, 200) };
  }
  writeAtomic(path, JSON.stringify(out, null, 2) + '\n');
}

/**
 * True while the process that wrote a lock may still be a certificate command. cert.ts refuses
 * root, so a real owner is always this user. A pid this user may not signal (EPERM) belongs to
 * someone else: a reused pid, so the lock is stale. A pid of this user counts unless /proc shows
 * it runs something other than cert.ts.
 */
function lockOwnerAlive(owner: number): boolean {
  if (!Number.isInteger(owner) || owner <= 0) return false;
  try {
    process.kill(owner, 0);
  } catch {
    // ESRCH: gone. EPERM: another user's process, so not ours.
    return false;
  }
  try {
    return readFileSync(`/proc/${owner}/cmdline`, 'latin1').includes('cert.ts');
  } catch {
    return true;
  }
}

/**
 * One certificate command at a time. The lock is a file holding the owner's pid. A lock whose
 * owner is gone, or is plainly another program, is taken over. (The cron jobs also hold a flock.)
 */
export function acquireLock(dir: string): () => void {
  ensurePrivateDir(dir);
  const path = join(dir, 'cert.lock');
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const owner = Number(readFileSync(path, 'utf8').trim());
      if (lockOwnerAlive(owner)) throw new CertError(`Another certificate command is running (pid ${owner}). If none is, delete ${path} and try again.`);
      rmSync(path, { force: true });
    }
  }
  throw new CertError('Could not take the certificate lock.');
}

/** Removes per-run acme.sh settings files left by a run that was killed. They can hold a token. */
export function removeRunConfs(home: string): void {
  for (const name of readdirSync(home)) if (/^run-[0-9a-f]{16}\.conf$/.test(name)) rmSync(join(home, name), { force: true });
}

export interface AcmeRun {
  code: number;
  output: string;
}

/**
 * Runs acme.sh with only the environment it needs: a fixed PATH, HOME, LANG and extra (from
 * acmeEnv). Nothing else from this process's environment reaches it (no proxy settings, no keys).
 */
export function runAcme(acmeSh: string, args: readonly string[], extra: Record<string, string>, timeoutMs: number): Promise<AcmeRun> {
  return new Promise((resolveRun) => {
    const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8', ...extra };
    const child = spawn(acmeSh, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (b: Buffer): void => {
      if (size < 1024 * 1024) chunks.push(b);
      size += b.length;
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    // acme.sh runs in its own process group (curl, sleep and openssl under it), so a timeout or a
    // Ctrl-C here stops all of it, and the lock and per-run settings file are still cleaned up.
    const stopGroup = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(stopGroup, timeoutMs);
    process.on('SIGINT', stopGroup);
    process.on('SIGTERM', stopGroup);
    const done = (): void => {
      clearTimeout(timer);
      process.off('SIGINT', stopGroup);
      process.off('SIGTERM', stopGroup);
    };
    child.on('error', () => {
      done();
      resolveRun({ code: 127, output: 'acme.sh could not be started.' });
    });
    child.on('close', (code, signal) => {
      done();
      const tail = signal ? `\nacme.sh was stopped (${signal}).` : '';
      resolveRun({ code: code ?? 1, output: Buffer.concat(chunks).toString('utf8') + tail });
    });
  });
}

/** Where acme.sh leaves the certificate and key for an EC key under --cert-home. */
export function acmeOutputFiles(home: string, domain: string): { fullchain: string; key: string; dir: string } {
  const dir = join(home, 'certs', `${domain}_ecc`);
  return { dir, fullchain: join(dir, 'fullchain.cer'), key: join(dir, `${domain}.key`) };
}
