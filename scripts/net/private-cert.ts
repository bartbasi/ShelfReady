// The private store certificate, for Phase 1: ShelfReady on store Wi-Fi only (store/docs/DECISIONS.md,
// November 9). It makes a store CA and a server certificate signed by it, then destroys the CA
// key, so nothing can ever be signed with it again. Steps for the store PC: docs/INSTALL.md,
// Phase 1.
//
//   node scripts/net/private-cert.ts make shelfready.example.com
//   node scripts/net/private-cert.ts status
//
// make takes the names (and, only for the fallback where phones must use the bare address, the
// store address) the certificate covers. When a certificate is already installed, add the word
// replace: the phones must then install the new store CA. Add "days <n>" for a shorter life (at
// most 397) and "dir <folder>" for another certificate folder (tests).
//
// The store CA: P-256, CA:TRUE with pathlen 0, key usage keyCertSign and cRLSign, and critical
// Name Constraints that permit only these names and addresses. The server certificate: P-256,
// SHA-256, those names and addresses as subject alternative names, serverAuth, digitalSignature,
// CA:FALSE, at most 397 days. The CA key lives only in a RAM-backed folder (tmpfs) for the seconds
// it takes, then is overwritten and deleted: it is never written to a file on disk, though tmpfs
// pages can be swapped out briefly. Ctrl-C, a hang-up or a kill wipes it too, and a later run
// removes this user's folders left by a run that could not clean up. The pair is installed as
// cert.ts installs one (a release folder and the current link), so the server picks it up without
// a restart. ca.crt, the public store CA, goes in the certificate folder.

import { execFile, type ChildProcess } from 'node:child_process';
import { randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import { closeSync, constants as fsc, fstatSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, writeSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_TLS_DIR, REPO_ROOT } from '../../src/server/config.ts';
import { PRIVATE_CA_ORG, readCertStatus } from '../../src/server/cert-status.ts';
import { isDnsName, listenAddressProblem } from '../../src/server/network.ts';
import { CertError, ensurePrivateDir, installedPaths, installPair, scriptEnvironmentProblem } from './cert-lib.ts';

/** Apple refuses TLS certificates that last longer than 398 days from public CAs; stay under it for all. */
export const MAX_DAYS = 397;
const DAY_MS = 24 * 3600_000;
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const TMPFS_MAGIC = 0x01021994;
const RAM_PREFIX = 'shelfready-ca-';
/** A run takes seconds. A folder of ours older than this was left by a run that could not clean up. */
const STALE_MS = 10 * 60_000;

const USAGE = `Usage: node scripts/net/private-cert.ts <command> [words]
  make <name> [address]   Make the private store certificate for that name and install it.
                          Add the store address only for the fallback where phones use it.
                          Add: replace (when one is installed), days <n> (at most ${MAX_DAYS}).
  status                  Show the installed certificate and the store CA's fingerprint.
Add "dir <folder>" to use another certificate folder (default ~/.config/shelfready/tls).`;

const say = (line = ''): void => void process.stdout.write(`${line}\n`);

export interface Targets {
  names: string[];
  ips: string[];
}

/** Sorts the words into host names and store or tailnet IPv4 addresses. Throws CertError. */
export function parseTargets(words: readonly string[]): Targets {
  const names: string[] = [];
  const ips: string[] = [];
  for (const raw of words) {
    const w = raw.toLowerCase();
    if (isIPv4(w)) {
      const problem = listenAddressProblem(w);
      if (problem) throw new CertError(`${w} cannot be in the store certificate: only store network or tailnet addresses can.`);
      ips.push(w);
    } else if (isDnsName(w)) {
      names.push(w);
    } else {
      throw new CertError(`${raw} is not a host name or an IPv4 address.`);
    }
  }
  const all = [...names, ...ips];
  if (all.length === 0) throw new CertError('Name what the certificate covers, for example: make shelfready.example.com');
  if (all.length > 4) throw new CertError('A store certificate covers at most 4 names and addresses.');
  if (new Set(all).size !== all.length) throw new CertError('A name or address is listed twice.');
  return { names, ips };
}

/** What the Name Constraints list. Only checked names and addresses reach the config. */
function permitted(t: Targets): string {
  return [...t.names.map((n) => `permitted;DNS:${n}`), ...t.ips.map((ip) => `permitted;IP:${ip}/255.255.255.255`)].join(', ');
}

/** The openssl config for the store CA. cn: the name phones show for it. */
export function caConfig(t: Targets, cn: string): string {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    `O = ${PRIVATE_CA_ORG}`,
    `CN = ${cn}`,
    '[ca_ext]',
    'basicConstraints = critical, CA:TRUE, pathlen:0',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    `nameConstraints = critical, ${permitted(t)}`,
    '',
  ].join('\n');
}

/** The openssl config for the server certificate. */
export function serverConfig(t: Targets): string {
  return [
    '[req]',
    'distinguished_name = dn',
    'prompt = no',
    '[dn]',
    `CN = ${t.names[0] ?? t.ips[0]}`,
    '[srv_ext]',
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${[...t.names.map((n) => `DNS:${n}`), ...t.ips.map((ip) => `IP:${ip}`)].join(', ')}`,
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always',
    '',
  ].join('\n');
}

/** The RAM-backed (tmpfs) folders the CA key may use, in order. */
/**
 * The RAM-backed (tmpfs) folders the CA key may use, in order. Tests give their own folder in
 * SHELFREADY_TEST_RAM_DIR, so they never see another run's work folders; it must still be a tmpfs
 * folder that is this user's and private to it, and then it is the only one used.
 */
function ramBases(): string[] {
  const isTmpfs = (b: string): boolean => {
    try {
      return statfsSync(b).type === TMPFS_MAGIC;
    } catch {
      return false;
    }
  };
  const test = process.env.SHELFREADY_TEST_RAM_DIR;
  if (test) {
    const st = isAbsolute(test) ? lstatSync(test, { throwIfNoEntry: false }) : undefined;
    const ours = st && st.isDirectory() && st.uid === (typeof process.getuid === 'function' ? process.getuid() : st.uid) && (st.mode & 0o077) === 0;
    if (!ours || !isTmpfs(test)) throw new CertError('SHELFREADY_TEST_RAM_DIR must be a private tmpfs folder of yours.');
    return [test];
  }
  return [process.env.XDG_RUNTIME_DIR, '/dev/shm'].filter((b): b is string => Boolean(b) && isTmpfs(b!));
}

/** Tests only (with SHELFREADY_TEST_RAM_DIR): how long to wait once the CA key exists, so a test can interrupt there. */
function testPauseMs(): number {
  const ms = Number(process.env.SHELFREADY_TEST_PAUSE_MS ?? 0);
  return process.env.SHELFREADY_TEST_RAM_DIR && Number.isInteger(ms) && ms > 0 && ms <= 10_000 ? ms : 0;
}

/**
 * What a signal handler needs to clean up: the work folder holding the CA key, the openssl run in
 * progress, and whether the new pair is already installed. main() sets the handlers before any
 * of these exist, so a signal at any point of make is handled.
 */
const active: { work?: string; child?: ChildProcess; installed: boolean } = { installed: false };

/**
 * A new folder, mode 700, on a RAM-backed file system (tmpfs), for the CA key. Refuses to go on
 * without one: the CA key must never be written to a file on disk.
 */
export function ramFolder(): string {
  const base = ramBases()[0];
  if (!base) throw new CertError('No RAM-backed folder (tmpfs) was found for the store CA key, so nothing was made. It must never be written to a file on disk.');
  return mkdtempSync(join(base, RAM_PREFIX));
}

/** Overwrites a file with zeros, then deletes it. Never follows a link. */
function wipe(path: string): void {
  try {
    const fd = openSync(path, fsc.O_WRONLY | fsc.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size;
      if (size > 0) writeSync(fd, Buffer.alloc(size), 0, size, 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Already gone, or not a plain file.
  }
  rmSync(path, { force: true });
}

/** Wipes every plain file in a work folder, then removes the folder. */
function wipeFolder(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (lstatSync(p).isFile()) wipe(p);
    }
  } catch {
    // Gone already.
  }
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes work folders this user left in the RAM folders when a run could not clean up (a power
 * cut, a SIGKILL). Only real folders, owned by this user, named like ours and older than a run
 * can take; links are never followed. Returns how many were removed.
 */
export function removeStaleRamFolders(now = Date.now()): number {
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  let removed = 0;
  for (const base of ramBases()) {
    let names: string[] = [];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(RAM_PREFIX) || !/^[A-Za-z0-9]{6}$/.test(name.slice(RAM_PREFIX.length))) continue;
      const p = join(base, name);
      try {
        const st = lstatSync(p);
        if (!st.isDirectory() || st.uid !== uid || now - st.mtimeMs < STALE_MS) continue;
      } catch {
        continue;
      }
      wipeFolder(p);
      removed++;
    }
  }
  return removed;
}

/** Runs openssl with its own config only, never the system's. Rejects with a CertError holding its last words. */
function openssl(args: string[], cwd: string, step: string, running: { child?: ChildProcess }): Promise<string> {
  return new Promise((resolveRun, reject) => {
    running.child = execFile(
      'openssl',
      args,
      { cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', OPENSSL_CONF: '/dev/null', HOME: cwd, LANG: 'C' }, encoding: 'utf8', timeout: 60_000 },
      (err, stdout, stderr) => {
        running.child = undefined;
        if (!err) return resolveRun(stdout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new CertError('openssl is not installed. Install it: sudo apt install openssl'));
        const last = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        reject(new CertError(`openssl could not ${step}.${last ? ` It said: ${last}` : ''}`));
      },
    );
  });
}

const serial = (): string => {
  const b = randomBytes(16);
  b[0] = (b[0] & 0x7f) | 0x10;
  return `0x${b.toString('hex')}`;
};

export interface PrivatePair {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  /** The store CA's SHA-256 fingerprint, as phones show it. */
  fingerprint: string;
}

const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * Makes the store CA and the server certificate, checks both, and destroys the CA key. Returns
 * the public CA, the server certificate and its key. Throws CertError. While it runs, Ctrl-C, a
 * hang-up or a kill stops openssl, wipes the work folder (the CA key with it) and exits.
 */
export async function makePrivatePair(t: Targets, days: number, now = new Date()): Promise<PrivatePair> {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new CertError(`days must be a whole number from 1 to ${MAX_DAYS}.`);
  const work = ramFolder();
  active.work = work;
  const running = active;
  try {
    const cn = `ShelfReady store CA ${now.toISOString().slice(0, 10)} ${randomBytes(2).toString('hex')}`;
    const write = (name: string, text: string): void => {
      const fd = openSync(join(work, name), fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
    };
    write('ca.cnf', caConfig(t, cn));
    write('srv.cnf', serverConfig(t));
    await openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'ca.key'], work, 'make the CA key', running);
    const pause = testPauseMs();
    if (pause) await new Promise((r) => setTimeout(r, pause));
    // The CA outlives the server certificate by a day, and no more: its key is gone anyway.
    await openssl(['req', '-x509', '-new', '-key', 'ca.key', '-sha256', '-days', String(days + 1), '-set_serial', serial(), '-config', 'ca.cnf', '-extensions', 'ca_ext', '-out', 'ca.crt'], work, 'make the store CA', running);
    await openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'srv.key'], work, 'make the server key', running);
    await openssl(['req', '-new', '-key', 'srv.key', '-config', 'srv.cnf', '-out', 'srv.csr'], work, 'make the certificate request', running);
    await openssl(['x509', '-req', '-in', 'srv.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', serial(), '-days', String(days), '-sha256', '-extfile', 'srv.cnf', '-extensions', 'srv_ext', '-out', 'srv.crt'], work, 'sign the server certificate', running);
    // The CA key's work is done.
    wipe(join(work, 'ca.key'));
    const extensions = await openssl(['x509', '-in', 'ca.crt', '-noout', '-ext', 'basicConstraints,keyUsage,nameConstraints'], work, 'read the store CA back', running);
    const pair = { ca: readFileSync(join(work, 'ca.crt')), cert: readFileSync(join(work, 'srv.crt')), key: readFileSync(join(work, 'srv.key')) };
    checkPair(pair, t, days, extensions);
    return { ...pair, fingerprint: new X509Certificate(pair.ca).fingerprint256 };
  } finally {
    wipeFolder(work);
    active.work = undefined;
  }
}

/**
 * Ctrl-C, a hang-up or a kill during make: stop openssl, wipe the CA key's work folder, say
 * whether anything was installed, and exit. Set before make starts, so no moment is missed.
 */
function handleSignals(): void {
  const onSignal = (sig: NodeJS.Signals): void => {
    active.child?.kill('SIGKILL');
    if (active.work) wipeFolder(active.work);
    say(
      active.installed
        ? `Stopped (${sig}) after the new certificate was installed. Run the status command to check it.`
        : `Stopped (${sig}). The store CA key was wiped and nothing was installed.`,
    );
    process.exit(130);
  };
  for (const s of SIGNALS) process.on(s, onSignal);
}

/**
 * Checks what openssl made before anything is installed: the CA is a P-256 CA limited to these
 * names, the server certificate is a P-256 serverAuth certificate for them, signed by it, with
 * its key, and no longer than allowed.
 */
export function checkPair(p: { ca: Buffer; cert: Buffer; key: Buffer }, t: Targets, days: number, caExtensions: string): void {
  const ca = new X509Certificate(p.ca);
  const leaf = new X509Certificate(p.cert);
  const fail = (what: string): never => {
    throw new CertError(`The new store certificate failed its check: ${what}.`);
  };
  if (!ca.ca) fail('the store CA is not a CA');
  if (leaf.ca) fail('the server certificate is a CA');
  for (const c of [ca, leaf]) if (c.publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') fail('a key is not P-256');
  if (!ca.verify(ca.publicKey)) fail('the store CA is not signed by its own key');
  if (!leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) fail('the server certificate is not signed by the store CA');
  if (!leaf.checkPrivateKey(createPrivateKey(p.key))) fail('the server key does not belong to the certificate');
  if (!(leaf.keyUsage ?? []).includes(SERVER_AUTH)) fail('the server certificate is not for TLS servers (serverAuth)');
  for (const n of t.names) if (!leaf.checkHost(n, { subject: 'never' })) fail(`it does not cover ${n}`);
  for (const ip of t.ips) if (!leaf.checkIP(ip)) fail(`it does not cover ${ip}`);
  const life = leaf.validToDate.getTime() - leaf.validFromDate.getTime();
  if (life > days * DAY_MS + 60_000 || life > MAX_DAYS * DAY_MS + 60_000) fail('the server certificate lasts too long');
  if (ca.validToDate.getTime() < leaf.validToDate.getTime()) fail('the store CA ends before the server certificate');
  if (!/Basic Constraints: critical\s+CA:TRUE, pathlen:0/.test(caExtensions)) fail('the store CA is not limited to signing server certificates (pathlen 0)');
  if (!/Name Constraints: critical\s+Permitted:/.test(caExtensions)) fail('the store CA has no critical name constraints');
  for (const n of t.names) if (!caExtensions.includes(`DNS:${n}`)) fail(`the name constraints leave out ${n}`);
  for (const ip of t.ips) if (!caExtensions.includes(`IP:${ip}/255.255.255.255`)) fail(`the name constraints leave out ${ip}`);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function utc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** The make command line for these names, for messages. */
function makeCommand(names: readonly string[]): string {
  return `node scripts/net/private-cert.ts make ${names.join(' ')} replace`;
}

/**
 * Makes and installs the private store certificate. hooks: tests only. afterInstall runs between
 * installing the pair and putting the new ca.crt in place, to stop a run there; log takes the lines.
 */
export async function make(tlsDir: string, t: Targets, days: number, replace: boolean, hooks: { afterInstall?: () => void; log?: (line: string) => void } = {}): Promise<number> {
  const log = hooks.log ?? say;
  const stale = removeStaleRamFolders();
  if (stale > 0) log(`Removed ${stale} work folder${stale === 1 ? '' : 's'} left by an earlier run that could not clean up.`);
  const paths = installedPaths(tlsDir);
  const st = readCertStatus(paths.cert, paths.status, Date.now());
  if (!st.problem && !replace) {
    log(
      st.privateStore
        ? `FAILED: A private store certificate is already installed, valid until ${utc(st.validTo!)}. A new one means installing its store CA on both phones again. To go ahead, add the word replace.`
        : `FAILED: Another certificate is installed (issued by ${st.issuer}). To replace it with a private store certificate, add the word replace.`,
    );
    return 1;
  }
  const pair = await makePrivatePair(t, days);
  ensurePrivateDir(tlsDir);
  // A new CA file left by a run that stopped halfway is never used.
  for (const name of readdirSync(tlsDir)) if (/^ca\.crt\.new-[0-9a-f]{12}$/.test(name)) rmSync(join(tlsDir, name), { force: true });
  // The new CA file waits beside the old one until the new pair is in use.
  const caNew = join(tlsDir, `ca.crt.new-${randomBytes(6).toString('hex')}`);
  const fd = openSync(caNew, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, pair.ca);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  let warnings: string[];
  try {
    warnings = installPair(tlsDir, pair.cert, pair.key, { hosts: [...t.names, ...t.ips] }).warnings;
  } catch (err) {
    rmSync(caNew, { force: true });
    throw err;
  }
  active.installed = true;
  hooks.afterInstall?.();
  renameSync(caNew, join(tlsDir, 'ca.crt'));
  const leaf = new X509Certificate(pair.cert);
  log(`Made and installed the private store certificate for ${[...t.names, ...t.ips].join(' and ')}.`);
  log(`Valid until ${utc(leaf.validToDate.getTime())}. Make a new one before then (the settings page and check.sh warn 30 days ahead).`);
  for (const w of warnings) log(`WARN ${w}`);
  log(`The store CA for the phones: ${join(tlsDir, 'ca.crt')}`);
  log('Its SHA-256 fingerprint, to check on each phone before trusting it:');
  log(`  ${pair.fingerprint}`);
  log('The store CA key was destroyed, so nothing else can ever be signed with it.');
  log('The server picks up the new certificate within a minute, without a restart.');
  return 0;
}

function status(tlsDir: string): number {
  const paths = installedPaths(tlsDir);
  const st = readCertStatus(paths.cert, paths.status, Date.now());
  if (st.problem) {
    say(st.problem);
    return 1;
  }
  say(`${st.privateStore ? 'Private store certificate' : 'Certificate'} for ${st.names.join(', ')}, issued by ${st.issuer}.`);
  say(`Valid until ${utc(st.validTo!)} (${st.expired ? 'ended' : `${st.daysLeft} days left`}).`);
  let ca: X509Certificate;
  try {
    ca = new X509Certificate(readFileSync(join(tlsDir, 'ca.crt')));
  } catch {
    if (st.privateStore) say(`FAIL there is no readable ca.crt beside it. Run: ${makeCommand(st.names)}`);
    else say('No store CA file (ca.crt) here.');
    return st.privateStore ? 1 : 0;
  }
  const leaf = new X509Certificate(readFileSync(paths.cert));
  const signed = leaf.checkIssued(ca) && leaf.verify(ca.publicKey);
  say(`Store CA ${ca.subject.replace(/\n/g, ', ')}, valid until ${utc(ca.validToDate.getTime())}.`);
  say(`Its SHA-256 fingerprint: ${ca.fingerprint256}`);
  if (signed) {
    say('OK   the installed certificate was signed by this store CA');
    return 0;
  }
  // A make that stopped between installing the pair and writing ca.crt leaves this.
  say(`FAIL the installed certificate was not signed by this store CA, so phones cannot be given the right one. Run: ${makeCommand(st.names)}`);
  return st.privateStore ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    say('Do not run this as root. Run it as the user who runs ShelfReady.');
    return 2;
  }
  // This process holds the store CA key for a moment, so nothing may be loaded into it or watch it.
  const problem = scriptEnvironmentProblem();
  if (problem) {
    say(`Not running while ${problem} is set. Run it plainly: node scripts/net/private-cert.ts`);
    return 2;
  }
  process.umask(0o077);
  const words = [...argv];
  const take = (word: string): string | undefined => {
    const i = words.indexOf(word);
    if (i < 0) return undefined;
    const v = words[i + 1];
    words.splice(i, 2);
    return v ?? '';
  };
  const dir = take('dir');
  const daysWord = take('days');
  const replace = words.includes('replace');
  if (replace) words.splice(words.indexOf('replace'), 1);
  const [command, ...rest] = words;
  if (dir === '' || daysWord === '' || (command !== 'make' && command !== 'status') || (command === 'status' && (rest.length > 0 || replace || daysWord !== undefined))) {
    say(USAGE);
    return 2;
  }
  const tlsDir = resolve(dir ?? DEFAULT_TLS_DIR);
  if (isInside(tlsDir, REPO_ROOT)) {
    say('FAILED: the certificate folder must be outside the ShelfReady folder, for example ~/.config/shelfready/tls.');
    return 2;
  }
  try {
    if (command === 'status') return status(tlsDir);
    const days = daysWord === undefined ? MAX_DAYS : Number(daysWord);
    // Before anything that could hold the CA key exists.
    handleSignals();
    return await make(tlsDir, parseTargets(rest), days, replace);
  } catch (err) {
    say(`FAILED: ${err instanceof CertError ? err.message : `an unexpected error (${err instanceof Error ? err.name : 'unknown'}).`}`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
