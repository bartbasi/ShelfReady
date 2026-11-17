// The HTTPS certificate: Let's Encrypt through acme.sh, proved with a DNS-01 TXT record at deSEC,
// found by way of the _acme-challenge CNAME (the challenge alias). acme.sh calls ShelfReady's own
// hook, so ShelfReady's code writes the record and acme.sh never sees the deSEC token. Runs as
// Bart, never root. Reads config/local/cert.json and the token from ~/.config/shelfready/acme.env.
// Never prints the token. Steps for the store PC: docs/INSTALL.md.
//
//   node scripts/net/cert.ts preflight          check the config, token, acme.sh and DNS; changes nothing
//   node scripts/net/cert.ts issue              a test certificate from the staging service, installed
//   node scripts/net/cert.ts issue production   the real certificate, installed
//   node scripts/net/cert.ts renew              renew if due; the daily cron job adds the word quiet
//   node scripts/net/cert.ts renew now          renew even if not due
//   node scripts/net/cert.ts renew dry-run      a renewal test against staging; installs nothing
//   node scripts/net/cert.ts status             the installed certificate and the last results
//
// Add the words "config <file>" to use another install config. The server picks up a new
// certificate within a minute, without a restart.

import { Resolver, lookup } from 'node:dns/promises';
import { closeSync, constants as fsc, openSync, rmSync, statSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { addressKind } from '../../src/server/network.ts';
import { readCertStatus, type CertStatus, type RenewalEntry } from '../../src/server/cert-status.ts';
import { readSmallFile } from '../../src/server/tls.ts';
import { loadConfig, REPO_ROOT } from '../../src/server/config.ts';
import {
  acmeArgs,
  acmeEnv,
  acmeOutputFiles,
  acquireLock,
  CertError,
  checkAcmeSh,
  checkInstalled,
  checkIssued,
  ensurePrivateDir,
  installedPaths,
  installPair,
  loadCertConfig,
  readTokens,
  redact,
  removeRunConfs,
  runAcme,
  scriptEnvironmentProblem,
  updateRecord,
  writeHook,
  type RecordEntry,
  type Ca,
  type CertConfig,
} from './cert-lib.ts';

const USAGE = `Usage: node scripts/net/cert.ts <command> [words]
  preflight            Check the config, the token file, acme.sh and DNS. Changes nothing.
  issue                Get a test certificate from the Let's Encrypt staging service and install it.
  issue production     Get the real certificate and install it.
  renew                Renew if due (the daily job adds: quiet).
  renew now            Renew even if not due.
  renew dry-run        Test renewal against staging. Installs nothing.
  status               Show the installed certificate and the last results.
Add "config <file>" to use another install config (default config/local/cert.json).`;

/** Long enough for the DNS wait, Let's Encrypt's checks and a slow network. */
const ACME_TIMEOUT_MS = 20 * 60_000;

const say = (line = ''): void => void process.stdout.write(`${line}\n`);

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function time(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function entryLine(e: RenewalEntry | undefined): string {
  return e ? `${time(e.at)}, ${e.ok ? 'worked' : 'did not work'}${e.ca ? ` (${e.ca})` : ''}. ${e.message}` : 'not yet';
}

/** Gets a certificate from acme.sh into its own folder and returns the files. Throws CertError. */
async function obtain(c: CertConfig, ca: Ca, home: string, tokens: Record<string, string>): Promise<{ fullchain: Buffer; key: Buffer }> {
  const acmeSh = checkAcmeSh(c.acmeSh);
  ensurePrivateDir(home);
  removeRunConfs(home);
  if (c.ownHook) writeHook(home);
  // acme.sh saves a DNS hook's token in its settings file. This run gets a settings file of its
  // own, deleted at the end, so no token stays anywhere but acme.env.
  const accountConf = join(home, `run-${randomBytes(8).toString('hex')}.conf`);
  closeSync(openSync(accountConf, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600));
  try {
    const out = acmeOutputFiles(home, c.domain);
    rmSync(out.dir, { recursive: true, force: true });
    const run = await runAcme(acmeSh, acmeArgs(c, { ca, home, accountConf }), acmeEnv(c, tokens, REPO_ROOT), ACME_TIMEOUT_MS);
    if (run.code !== 0) throw new CertError(`acme.sh did not get a certificate (exit code ${run.code}).`, redact(run.output, tokens));
    try {
      return { fullchain: readSmallFile(out.fullchain, 64 * 1024).bytes, key: readSmallFile(out.key, 16 * 1024).bytes };
    } catch {
      throw new CertError('acme.sh finished but left no certificate where expected.', redact(run.output, tokens));
    }
  } finally {
    rmSync(accountConf, { force: true });
  }
}

/** Fixed words for any failure. A message from elsewhere could quote a file, so only CertError's own words pass. */
function failureMessage(err: unknown): string {
  return err instanceof CertError ? err.message : `An unexpected error stopped it (${err instanceof Error ? err.name : 'unknown'}).`;
}

/** Records a failure where the settings page shows it. Best effort: a failure to record is only printed. */
function recordFailure(c: CertConfig, fields: Partial<Record<'lastCheck' | 'lastRenewal' | 'lastDryRun', RecordEntry>>): void {
  try {
    updateRecord(c.tlsDir, fields);
  } catch {
    say('The failure could not be written to the renewal record either.');
  }
}

function printFailure(err: CertError): void {
  say(`FAILED: ${err.message}`);
  if (err.detail) {
    say('The last lines from acme.sh (tokens removed):');
    for (const line of err.detail.trim().split('\n').slice(-40)) say(`  ${line}`);
  }
}

function printCert(st: CertStatus, certPath: string): void {
  say(`Certificate: ${certPath}`);
  if (st.problem) {
    say(`  ${st.problem}`);
    return;
  }
  say(`  Names: ${st.names.join(', ')}`);
  say(`  Issued by: ${st.issuer}${st.staging ? ' (a test certificate from staging: phones will not trust it)' : ''}`);
  say(`  Valid until: ${time(st.validTo!)} (${st.expired ? 'ended' : `${st.daysLeft} days left`})`);
  say(`  Next renewal: ${st.due ? 'due now' : day(st.renewAt!)}`);
}

/**
 * The hosts the server answers to (allowedHosts in its config) that a Let's Encrypt certificate
 * for c.domain alone would not cover, for example the store address kept from Phase 1. The server
 * would refuse such a certificate. Empty when the server config cannot be read: that is for the
 * server to report.
 */
export function uncoveredHosts(c: CertConfig): string[] {
  try {
    return loadConfig().allowedHosts.filter((h) => h !== c.domain);
  } catch {
    return [];
  }
}

function uncoveredMessage(c: CertConfig, extra: readonly string[]): string {
  return `allowedHosts in the server config lists ${extra.join(', ')}, which a certificate for ${c.domain} does not cover, so the server would refuse it. Remove ${extra.length === 1 ? 'it' : 'them'} from allowedHosts first (docs/INSTALL.md, moving to Phase 2).`;
}

async function getAndInstall(c: CertConfig, ca: Ca, kind: 'issue' | 'renew'): Promise<number> {
  say(`Asking Let's Encrypt ${ca === 'staging' ? 'staging (test certificates)' : 'production'} for a certificate for ${c.domain}.`);
  say(`This takes a few minutes: acme.sh waits ${c.dnsWaitSeconds} seconds for the DNS record to spread.`);
  let warnings: string[] = [];
  try {
    // Before anything is asked of Let's Encrypt: the server must be able to use what comes back.
    const extra = uncoveredHosts(c);
    if (extra.length) throw new CertError(uncoveredMessage(c, extra));
    // Inside the try, so a token file problem is recorded where the settings page shows it.
    const got = await obtain(c, ca, c.acmeHome, readTokens(c));
    checkIssued(got.fullchain, got.key, { domain: c.domain, ca, now: Date.now() });
    warnings = installPair(c.tlsDir, got.fullchain, got.key, { hosts: [c.domain] }).warnings;
  } catch (err) {
    // Every failure is recorded, not only the expected ones.
    const entry: RecordEntry = { at: Date.now(), ok: false, kind, ca, message: failureMessage(err) };
    recordFailure(c, kind === 'renew' ? { lastRenewal: entry, lastCheck: entry } : { lastRenewal: entry });
    printFailure(err instanceof CertError ? err : new CertError(entry.message));
    return 1;
  }
  // Once the link is switched the new pair is in use: a later step can only warn.
  const done = kind === 'issue' ? 'Issued and installed.' : 'Renewed and installed.';
  const entry = { at: Date.now(), ok: true, kind, ca, message: warnings.length ? `${done} ${warnings[0]}` : done } as const;
  // A new certificate counts as the latest check too: the daily job takes over from here.
  updateRecord(c.tlsDir, { lastRenewal: entry, lastCheck: entry });
  say(done);
  for (const w of warnings) say(`WARN ${w}`);
  const paths = installedPaths(c.tlsDir);
  printCert(readCertStatus(paths.cert, paths.status, Date.now()), paths.cert);
  say('The server picks up the new certificate within a minute, without a restart.');
  return 0;
}

async function renew(c: CertConfig, words: Set<string>): Promise<number> {
  const quiet = words.has('quiet');
  const paths = installedPaths(c.tlsDir);
  const st = readCertStatus(paths.cert, paths.status, Date.now());
  if (st.problem) {
    const message = 'No certificate is installed to renew. Run the issue command first.';
    updateRecord(c.tlsDir, { lastCheck: { at: Date.now(), ok: false, kind: 'check', ca: '', message } });
    say(`FAILED: ${message}`);
    return 1;
  }
  // The private store certificate (Phase 1) is made by hand, never renewed here.
  if (st.privateStore) {
    if (!quiet) say('The private store certificate is installed. It is not renewed here: see docs/INSTALL.md, Phase 1. To change to a Let\'s Encrypt certificate, use the issue command.');
    return 0;
  }
  // Renew from the same service that issued the installed one, so a test setup stays a test.
  const ca: Ca = st.staging ? 'staging' : 'production';
  // A pair the server would refuse (a key that does not match, a missing key, a key others can
  // read) is due now, whatever the date says.
  let broken = '';
  try {
    checkInstalled(paths, [c.domain]);
  } catch (err) {
    broken = failureMessage(err);
  }
  if (broken) say(`Renewing now. ${broken}`);
  if (!words.has('now') && !st.due && !broken) {
    updateRecord(c.tlsDir, { lastCheck: { at: Date.now(), ok: true, kind: 'check', ca, message: `Not due. Renewal starts ${day(st.renewAt!)}.` } });
    if (!quiet) say(`Not due yet. Renewal starts ${day(st.renewAt!)}; the certificate is valid until ${time(st.validTo!)}.`);
    return 0;
  }
  return getAndInstall(c, ca, 'renew');
}

/** Proves renewal works end to end against staging, in a separate acme.sh folder. Installs nothing. */
async function dryRun(c: CertConfig): Promise<number> {
  const home = join(c.acmeHome, 'dry-run');
  say(`Renewal test: asking Let's Encrypt staging for a test certificate for ${c.domain}. Nothing is installed.`);
  let result: { ok: boolean; message: string };
  try {
    const got = await obtain(c, 'staging', home, readTokens(c));
    checkIssued(got.fullchain, got.key, { domain: c.domain, ca: 'staging', now: Date.now() });
    result = { ok: true, message: 'The renewal test worked: DNS, the token and Let\'s Encrypt all answered.' };
  } catch (err) {
    result = { ok: false, message: failureMessage(err) };
    printFailure(err instanceof CertError ? err : new CertError(result.message));
  } finally {
    rmSync(acmeOutputFiles(home, c.domain).dir, { recursive: true, force: true });
  }
  updateRecord(c.tlsDir, { lastDryRun: { at: Date.now(), ok: result.ok, kind: 'dry-run', ca: 'staging', message: result.message } });
  if (result.ok) say(result.message);
  return result.ok ? 0 : 1;
}

function status(c: CertConfig): number {
  const paths = installedPaths(c.tlsDir);
  const st = readCertStatus(paths.cert, paths.status, Date.now());
  printCert(st, paths.cert);
  say(`Last renewal: ${entryLine(st.record.lastRenewal)}`);
  say(`Last daily check: ${entryLine(st.record.lastCheck)}`);
  say(`Last renewal test: ${entryLine(st.record.lastDryRun)}`);
  if (st.recordProblem) say(st.recordProblem);
  if (st.problem) return 1;
  // The same check the server makes at start and on each reload.
  try {
    checkInstalled(paths, [c.domain]);
    say('OK   the key and certificate belong together, and only you can read the key');
    return 0;
  } catch (err) {
    say(`FAIL ${failureMessage(err)} The daily renewal replaces it.`);
    return 1;
  }
}

async function preflight(c: CertConfig): Promise<number> {
  let fails = 0;
  const ok = (m: string): void => say(`OK   ${m}`);
  const warn = (m: string): void => say(`WARN ${m}`);
  const fail = (m: string): void => {
    fails++;
    say(`FAIL ${m}`);
  };
  say(`Domain ${c.domain}, DNS ${c.dnsProvider}${c.challengeAlias ? `, challenge alias ${c.challengeAlias}` : ''}.`);
  say(`Certificate folder ${c.tlsDir}; acme.sh folder ${c.acmeHome}.`);
  const extra = uncoveredHosts(c);
  if (extra.length) fail(uncoveredMessage(c, extra));
  else ok(`the server config's allowedHosts fit a certificate for ${c.domain}`);
  try {
    const real = checkAcmeSh(c.acmeSh);
    const v = await runAcme(real, ['--version'], {}, 15_000);
    ok(`acme.sh ${/v\d+\.\d+\.\d+/.exec(v.output)?.[0] ?? '(version unknown)'} at ${c.acmeSh}`);
  } catch (err) {
    fail(err instanceof CertError ? err.message : 'acme.sh could not be checked.');
  }
  let tokens: Record<string, string> = {};
  try {
    tokens = readTokens(c);
    ok(`token file ${c.tokenFile}: ${Object.values(c.tokenEnv).join(', ')} set, mode 600`);
  } catch (err) {
    fail(err instanceof CertError ? err.message : 'The token file could not be read.');
  }
  if (!c.ownHook) {
    warn(`acme.sh's own ${c.dnsHook} hook gets the token, and most such hooks pass it to curl on the command line, where other users on this PC can see it while it runs.`);
  }
  for (const dir of [c.tlsDir, c.acmeHome]) {
    const s = statSync(dir, { throwIfNoEntry: false });
    if (!s) ok(`${dir} will be made, mode 700`);
    else if (s.isDirectory() && (s.mode & 0o077) === 0) ok(`${dir} is private (mode 700)`);
    else fail(`${dir} must be a folder only you can open. Run: chmod 700 ${dir}`);
  }

  const pub = new Resolver({ timeout: 4000, tries: 2 });
  pub.setServers(['1.1.1.1', '9.9.9.9']);
  let publicA: string[] = [];
  try {
    publicA = await pub.resolve4(c.domain);
    const notLocal = publicA.filter((a) => !['private', 'tailnet'].includes(addressKind(a)));
    if (notLocal.length) warn(`${c.domain} points at ${notLocal.join(', ')}, a public address. It should be the store PC's address.`);
    else ok(`public DNS: ${c.domain} points at ${publicA.join(', ')}`);
  } catch {
    fail(`public DNS has no address for ${c.domain} yet. Add the A record (docs/INSTALL.md).`);
  }
  try {
    const local = (await lookup(c.domain, { all: true, family: 4 })).map((r) => r.address);
    if (publicA.length && local.join(',') !== publicA.join(',')) warn(`this PC's DNS says ${local.join(', ')} but public DNS says ${publicA.join(', ')}.`);
    else ok(`this PC's DNS: ${c.domain} is ${local.join(', ')}`);
  } catch {
    warn(`this PC's DNS cannot find ${c.domain}. The router may block names that point at store addresses (DNS rebind protection). See docs/INSTALL.md.`);
  }
  if (c.challengeAlias) {
    const want = `_acme-challenge.${c.challengeAlias}`;
    try {
      const got = (await pub.resolveCname(`_acme-challenge.${c.domain}`)).map((n) => n.toLowerCase().replace(/\.$/, ''));
      if (got.includes(want)) ok(`_acme-challenge.${c.domain} is a CNAME to ${want}`);
      else fail(`_acme-challenge.${c.domain} points at ${got.join(', ')}, not ${want}.`);
    } catch {
      fail(`public DNS has no CNAME for _acme-challenge.${c.domain} yet. It must point at ${want}.`);
    }
  }
  // A CAA record on the name or a parent must allow Let's Encrypt, or it will refuse.
  const labels = c.domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join('.');
    let records: { issue?: string }[] = [];
    try {
      records = await pub.resolveCaa(name);
    } catch {
      records = [];
    }
    const issuers = records.filter((r) => typeof r.issue === 'string').map((r) => r.issue!.toLowerCase());
    if (records.length === 0 || issuers.length === 0) continue;
    if (issuers.some((v) => v.startsWith('letsencrypt.org'))) ok(`CAA on ${name} allows Let's Encrypt`);
    else fail(`CAA on ${name} does not allow Let's Encrypt (it allows ${issuers.join(', ')}). Add a CAA record for letsencrypt.org.`);
    break;
  }

  if (c.dnsProvider === 'desec' && tokens.DEDYN_TOKEN) {
    const risky = scriptEnvironmentProblem();
    if (risky) {
      fail(`not calling deSEC while ${risky} is set: the token must stay in this process and go straight to deSEC.`);
    } else {
      try {
        const res = await fetch('https://desec.io/api/v1/domains/', {
          headers: { Authorization: `Token ${tokens.DEDYN_TOKEN}`, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status === 401 || res.status === 403) fail('deSEC refused the token. Check DESEC_TOKEN in the token file.');
        else if (!res.ok) fail(`deSEC answered with status ${res.status}.`);
        else {
          const names = ((await res.json()) as { name?: unknown }[]).map((d) => String(d.name ?? '').toLowerCase());
          const zone = c.challengeAlias || names.find((n) => c.domain === n || c.domain.endsWith(`.${n}`)) || '';
          if (zone && names.includes(zone)) ok(`deSEC accepts the token and holds ${zone}`);
          else fail(`the token works, but deSEC has no domain ${c.challengeAlias || `for ${c.domain}`} in this account.`);
        }
      } catch {
        fail('deSEC could not be reached.');
      }
    }
  }
  say(fails === 0 ? 'Ready to issue a certificate.' : `${fails} problem${fails === 1 ? '' : 's'} to fix first.`);
  return fails === 0 ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    say('Do not run this as root. Run it as the user who runs ShelfReady.');
    return 2;
  }
  // This process reads the deSEC token, so nothing may be loaded into it or watch it.
  const problem = scriptEnvironmentProblem();
  if (problem) {
    say(`Not running while ${problem} is set. Run it plainly: node scripts/net/cert.ts`);
    return 2;
  }
  process.umask(0o077);
  try {
    setPriority(19);
  } catch {
    // Already as low as it goes.
  }
  const words = [...argv];
  let configPath = join(REPO_ROOT, 'config', 'local', 'cert.json');
  const ci = words.indexOf('config');
  if (ci >= 0) {
    if (!words[ci + 1]) {
      say(USAGE);
      return 2;
    }
    configPath = words[ci + 1];
    words.splice(ci, 2);
  }
  const [command, ...rest] = words;
  const extra = new Set(rest);
  const allowed: Record<string, string[]> = { preflight: [], status: [], issue: ['production'], renew: ['now', 'quiet', 'dry-run'] };
  if (!command || !(command in allowed) || rest.some((w) => !allowed[command].includes(w)) || (extra.has('dry-run') && extra.has('now'))) {
    say(USAGE);
    return 2;
  }
  let c: CertConfig;
  try {
    c = loadCertConfig(configPath, REPO_ROOT);
  } catch (err) {
    if (!(err instanceof CertError)) throw err;
    say(`FAILED: ${err.message}`);
    return 2;
  }
  if (command === 'preflight') return preflight(c);
  if (command === 'status') return status(c);
  let release: (() => void) | undefined;
  try {
    release = acquireLock(c.acmeHome);
    if (command === 'issue') return await getAndInstall(c, extra.has('production') ? 'production' : 'staging', 'issue');
    return extra.has('dry-run') ? await dryRun(c) : await renew(c, extra);
  } catch (err) {
    // Anything not recorded already (the lock, an unexpected error) is recorded here.
    const entry: RecordEntry = { at: Date.now(), ok: false, kind: command === 'issue' ? 'issue' : extra.has('dry-run') ? 'dry-run' : 'check', ca: '', message: failureMessage(err) };
    recordFailure(c, command === 'issue' ? { lastRenewal: entry } : extra.has('dry-run') ? { lastDryRun: entry } : { lastCheck: entry });
    printFailure(err instanceof CertError ? err : new CertError(entry.message));
    return 1;
  } finally {
    release?.();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // Unexpected errors print their class only: a message could quote a file's contents.
      say(`FAILED: an unexpected error (${err instanceof Error ? err.name : 'unknown'}).`);
      process.exit(1);
    },
  );
}
