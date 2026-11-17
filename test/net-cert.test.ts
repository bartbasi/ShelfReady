// The certificate: the status the settings page reads, the install config, and scripts/net/cert.ts
// end to end with a fake acme.sh that makes test certificates with openssl and calls ShelfReady's
// deSEC hook, which talks to a fake deSEC on this PC. No network, no real token. The fake acme.sh
// fails if the token ever reaches it, and the tests check it is never printed or left on disk.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './server-helpers.ts';
import { issuedChain, opensslMissing, privateDir, selfSigned } from './net-helpers.ts';
import { readCertStatus, renewAt } from '../src/server/cert-status.ts';
import { REPO_ROOT } from '../src/server/config.ts';
import { acmeArgs, acmeEnv, checkInstalled, checkIssued, currentRelease, HOOK_SCRIPT, installedPaths, installPair, LE_PRODUCTION, LE_STAGING, makeCertConfig, readEnvFile, redact, scriptEnvironmentProblem, TEST_TOKEN_PREFIX, updateRecord, CertError } from '../scripts/net/cert-lib.ts';
import { addTxt, challengeTarget, DESEC_API, desecApi, removeTxt } from '../scripts/net/desec-dns.ts';

const NAME = 'shelfready.example.com';
// A test token: only a token starting with TEST_TOKEN_PREFIX may be sent to the fake deSEC.
const TOKEN = `${TEST_TOKEN_PREFIX}0123456789abcdefXYZ`;
const DAY = 24 * 3600_000;
const skip = opensslMissing();

// Every temp folder made here (test keys, a fake token) is removed when the file's tests end.
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
  const d = tempDir();
  made.push(d);
  return d;
}

test('the certificate status: names, issuer, renewal date, and the renewal record', { skip }, () => {
  const dir = scratch();
  const tls = privateDir(join(dir, 'tls'));
  const certPath = join(tls, 'fullchain.pem');
  const statusPath = join(tls, 'status.json');
  assert.equal(readCertStatus(certPath, statusPath, Date.now()).problem, 'No certificate is installed yet.');
  selfSigned(tls, [NAME], 90);
  const now = Date.now();
  const st = readCertStatus(certPath, statusPath, now);
  assert.equal(st.problem, undefined);
  assert.deepEqual(st.names, [NAME]);
  assert.equal(st.issuer, NAME);
  assert.equal(st.staging, false);
  assert.equal(st.due, false);
  assert.equal(st.expired, false);
  assert.ok(st.daysLeft === 89 || st.daysLeft === 90);
  // A third of the life left: 30 days before the end of a 90-day certificate.
  assert.equal(st.renewAt, renewAt(st.validFrom!, st.validTo!));
  assert.equal(st.validTo! - st.renewAt!, 30 * DAY);
  assert.equal(readCertStatus(certPath, statusPath, st.renewAt! + 1000).due, true);
  assert.equal(readCertStatus(certPath, statusPath, st.validTo! + 1000).expired, true);
  assert.equal(st.checkStale, true, 'no daily check has run');
  updateRecord(tls, { lastCheck: { at: now, ok: true, kind: 'check', ca: 'production', message: 'Not due.' } });
  const after = readCertStatus(certPath, statusPath, now + 1000);
  assert.equal(after.checkStale, false);
  assert.equal(after.record.lastCheck?.message, 'Not due.');
  assert.equal(readCertStatus(certPath, statusPath, now + 3 * DAY).checkStale, true);
  // Updating one entry keeps the others.
  updateRecord(tls, { lastDryRun: { at: now, ok: false, kind: 'dry-run', ca: 'staging', message: 'DNS did not answer.' } });
  const both = readCertStatus(certPath, statusPath, now);
  assert.equal(both.record.lastCheck?.ok, true);
  assert.equal(both.record.lastDryRun?.ok, false);
  assert.equal(statSync(join(tls, 'status.json')).mode & 0o777, 0o600);
  writeFileSync(join(tls, 'status.json'), '{ not json', { mode: 0o600 });
  assert.equal(readCertStatus(certPath, statusPath, now).recordProblem, 'The renewal record could not be read.');
  // A staging chain says so.
  const chain = issuedChain(join(dir, 'chain'), [NAME], { staging: true });
  writeFileSync(certPath, chain.fullchain);
  const staging = readCertStatus(certPath, statusPath, now);
  assert.equal(staging.staging, true);
  assert.equal(staging.issuer, "(STAGING) Let's Encrypt ((STAGING) Test Issuer E9)");
});

test('the install config is checked, and only safe variables reach acme.sh', () => {
  const ok = makeCertConfig({ domain: 'ShelfReady.Example.com', challengeAlias: 'example.dedyn.io', tokenFile: '/srv/x/acme.env', tlsDir: '/srv/x/tls', acmeHome: '/srv/x/acme' }, REPO_ROOT);
  assert.equal(ok.domain, NAME);
  assert.equal(ok.dnsHook, 'dns_shelfready', 'deSEC goes through ShelfReady\'s own hook');
  assert.equal(ok.ownHook, true);
  assert.deepEqual(ok.tokenEnv, { DEDYN_TOKEN: 'DESEC_TOKEN' });
  // With the own hook acme.sh gets paths, never the token.
  const env = acmeEnv({ ...ok, configPath: '/srv/x/cert.json' }, { DEDYN_TOKEN: TOKEN }, REPO_ROOT);
  assert.deepEqual(Object.keys(env).sort(), ['SHELFREADY_CERT_CONFIG', 'SHELFREADY_DNS_HOOK', 'SHELFREADY_NODE']);
  assert.ok(!Object.values(env).some((v) => v.includes(TOKEN)));
  assert.match(HOOK_SCRIPT, /dns_shelfready_add\(\) \{\n  "\$SHELFREADY_NODE" "\$SHELFREADY_DNS_HOOK" add "\$1" "\$2" "\$SHELFREADY_CERT_CONFIG"\n\}/);
  assert.equal(ok.acmeSh, '/usr/bin/acme.sh');
  assert.equal(ok.dnsWaitSeconds, 120);
  const bad: [unknown, RegExp][] = [
    [[], /JSON object/],
    [{ domain: NAME, tokn: 'x' }, /unknown field: tokn/],
    [{ domain: 'localhost' }, /domain must be/],
    [{ domain: '*.example.com' }, /domain must be/],
    [{ domain: NAME, challengeAlias: 'not a name' }, /challengeAlias/],
    [{ domain: NAME, dnsProvider: 'route53; rm -rf' }, /dnsProvider/],
    [{ domain: NAME, dnsProvider: 'dns_cf' }, /needs tokenEnv/],
    [{ domain: NAME, dnsProvider: 'dns_shelfready', tokenEnv: { X_TOKEN: 'DESEC_TOKEN' } }, /dnsProvider must be/],
    [{ domain: NAME, tokenEnv: { PATH: 'DESEC_TOKEN' } }, /may not set PATH/],
    [{ domain: NAME, tokenEnv: { LD_PRELOAD: 'DESEC_TOKEN' } }, /may not set LD_PRELOAD/],
    [{ domain: NAME, tokenEnv: { HTTPS_PROXY: 'DESEC_TOKEN' } }, /may not set HTTPS_PROXY/],
    [{ domain: NAME, tokenEnv: { https_proxy: 'DESEC_TOKEN' } }, /may not set https_proxy/],
    [{ domain: NAME, tokenEnv: { LE_WORKING_DIR: 'X' } }, /may not set LE_WORKING_DIR/],
    [{ domain: NAME, tokenEnv: { DEDYN_TOKEN: 'lower' } }, /must name a key/],
    [{ domain: NAME, tlsDir: join(REPO_ROOT, 'config', 'local', 'tls') }, /outside the ShelfReady folder/],
    [{ domain: NAME, tokenFile: 'relative/acme.env' }, /full path/],
    [{ domain: NAME, email: 'not an email' }, /email/],
    [{ domain: NAME, dnsWaitSeconds: 5 }, /dnsWaitSeconds/],
  ];
  for (const [input, re] of bad) assert.throws(() => makeCertConfig(input, REPO_ROOT), (e) => e instanceof CertError && re.test(e.message), JSON.stringify(input));
  const cf = makeCertConfig({ domain: NAME, dnsProvider: 'dns_cf', tokenEnv: { CF_Token: 'CF_TOKEN' } }, REPO_ROOT);
  assert.equal(cf.dnsHook, 'dns_cf');
  assert.equal(cf.ownHook, false);
  assert.deepEqual(acmeEnv(cf, { CF_Token: TOKEN }, REPO_ROOT), { CF_Token: TOKEN }, 'another acme.sh hook gets its token variables');
});

test('the acme.sh command line: staging unless asked, the alias, never the token', () => {
  const c = makeCertConfig({ domain: NAME, challengeAlias: 'example.dedyn.io', tokenFile: '/srv/x/acme.env', tlsDir: '/srv/x/tls', acmeHome: '/srv/x/acme' }, REPO_ROOT);
  const staging = acmeArgs(c, { ca: 'staging', home: '/srv/x/acme', accountConf: '/srv/x/acme/run-0123456789abcdef.conf' });
  assert.equal(staging[staging.indexOf('--server') + 1], LE_STAGING);
  assert.equal(staging[staging.indexOf('--challenge-alias') + 1], 'example.dedyn.io');
  assert.equal(staging[staging.indexOf('--dns') + 1], 'dns_shelfready');
  assert.equal(staging[staging.indexOf('--keylength') + 1], 'ec-256');
  assert.ok(staging.includes('--always-force-new-domain-key'));
  const prod = acmeArgs(c, { ca: 'production', home: '/srv/x/acme', accountConf: '/srv/x/acme/run-0123456789abcdef.conf' });
  assert.equal(prod[prod.indexOf('--server') + 1], LE_PRODUCTION);
  const noAlias = acmeArgs({ ...c, challengeAlias: '' }, { ca: 'staging', home: '/h', accountConf: '/h/r.conf' });
  assert.ok(!noAlias.includes('--challenge-alias'));
  assert.equal(redact(`x ${TOKEN} y\nAuthorization: Token ${TOKEN}\nSAVED_DEDYN_TOKEN='abc'\n\x1b[31mred\x1b[0m`, { DEDYN_TOKEN: TOKEN }), "x [redacted] y\nAuthorization: Token [redacted]\nSAVED_DEDYN_TOKEN=[redacted]\nred");
});

test('the token file must be private, and its values never appear in errors', () => {
  const dir = scratch();
  const sec = privateDir(join(dir, 'secrets'));
  const file = join(sec, 'acme.env');
  writeFileSync(file, `# deSEC\nexport DESEC_TOKEN="${TOKEN}"\nOTHER = 'two words'\n\nbroken line\n`, { mode: 0o600 });
  const env = readEnvFile(file);
  assert.equal(env.get('DESEC_TOKEN'), TOKEN);
  assert.equal(env.get('OTHER'), 'two words');
  chmodSync(file, 0o644);
  assert.throws(() => readEnvFile(file), (e) => e instanceof Error && /mode 600/.test(e.message) && !e.message.includes(TOKEN));
  assert.throws(() => readEnvFile(join(sec, 'missing.env')), /no token file/);
});

test('a new certificate is checked before it is installed', { skip }, () => {
  const dir = scratch();
  const now = Date.now();
  const staging = issuedChain(join(dir, 's'), [NAME], { staging: true });
  assert.equal(checkIssued(staging.fullchain, staging.key, { domain: NAME, ca: 'staging', now }).length, 2);
  assert.throws(() => checkIssued(staging.fullchain, staging.key, { domain: NAME, ca: 'production', now }), /from staging/);
  assert.throws(() => checkIssued(staging.fullchain, staging.key, { domain: 'other.example.com', ca: 'staging', now }), /does not cover/);
  assert.throws(() => checkIssued(staging.fullchain, staging.key, { domain: NAME, ca: 'staging', now: now + 200 * DAY }), /not valid now/);
  const other = issuedChain(join(dir, 'o'), [NAME], { staging: true });
  assert.throws(() => checkIssued(staging.fullchain, other.key, { domain: NAME, ca: 'staging', now }), /do not belong together/);
  // Out of order: the issuer first.
  const pems = staging.fullchain.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/g)!;
  assert.throws(() => checkIssued(Buffer.from(pems[1] + pems[0]), staging.key, { domain: NAME, ca: 'staging', now }), /belong together|not in order/);
  // Production must chain to a root Node trusts. A test issuer is not one, unless the test says so.
  const prod = issuedChain(join(dir, 'p'), [NAME], { staging: false });
  assert.throws(() => checkIssued(prod.fullchain, prod.key, { domain: NAME, ca: 'production', now }), /trusted root/);
  assert.throws(() => checkIssued(prod.fullchain, prod.key, { domain: NAME, ca: 'staging', now }), /does not say \(STAGING\)/);
  const root = readFileSync(join(dir, 'p', 'ca.pem'), 'utf8');
  assert.equal(checkIssued(prod.fullchain, prod.key, { domain: NAME, ca: 'production', now, roots: [root] }).length, 2);
  // Installed mode 600 in a release folder only this user can open, behind the current link.
  const tls = join(dir, 'tls');
  installPair(tls, staging.fullchain, staging.key, { hosts: [NAME] });
  assert.equal(statSync(tls).mode & 0o777, 0o700);
  assert.equal(statSync(installedPaths(tls).key).mode & 0o777, 0o600);
  assert.equal(statSync(installedPaths(tls).cert).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(tls).sort(), ['current', 'releases'], 'no temporary files left');
  // A pair whose certificate does not cover the name is refused before the link moves.
  const first = currentRelease(tls);
  const wrongName = issuedChain(join(dir, 'x'), ['other.example.com'], { staging: true });
  assert.throws(() => installPair(tls, wrongName.fullchain, wrongName.key, { hosts: [NAME] }), /does not cover/);
  assert.equal(currentRelease(tls), first);
  // Releases older than the one before the current are removed.
  for (let i = 0; i < 3; i++) installPair(tls, staging.fullchain, staging.key, { hosts: [NAME] });
  assert.equal(readdirSync(join(tls, 'releases')).length, 2);
  // Once the link has switched, a later step can only warn: the new pair is installed.
  const before = currentRelease(tls);
  const result = installPair(tls, staging.fullchain, staging.key, { hosts: [NAME], afterSwitch: () => { throw new Error('disk trouble'); } });
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /^The new certificate is in place, but syncing the certificate folder failed: Error\.$/);
  assert.notEqual(currentRelease(tls), before);
  checkInstalled(installedPaths(tls), [NAME]);
  assert.deepEqual(readdirSync(join(tls, 'releases')).sort(), [before, currentRelease(tls)].sort(), 'the one in use before is kept');
});

test('an install that stops between the two files changes nothing, and a broken live pair is repaired by the next renew', { skip }, async (t) => {
  const desec = await fakeDesec();
  t.after(() => desec.close());
  const f = fakeInstall(desec.url);
  assert.equal((await f.run('issue')).status, 0);
  const paths = installedPaths(f.tls);
  const good = { cert: readFileSync(paths.cert), key: readFileSync(paths.key), release: currentRelease(f.tls) };
  // Stopped after the new key, before the new certificate: the server still reads the old pair.
  const next = issuedChain(join(f.dir, 'next'), [NAME], { staging: true });
  assert.throws(() => installPair(f.tls, next.fullchain, next.key, { hosts: [NAME], afterKey: () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(currentRelease(f.tls), good.release);
  const halfWritten = readdirSync(join(f.tls, 'releases')).find((n) => n !== good.release);
  assert.ok(halfWritten, 'the half-written folder is there until the next install');
  assert.deepEqual(readFileSync(paths.cert), good.cert);
  assert.deepEqual(readFileSync(paths.key), good.key);
  checkInstalled(paths, [NAME]);
  // Not due, and the pair is fine: the daily run does nothing.
  assert.equal((await f.run('renew', 'quiet')).status, 0);
  assert.equal(f.calls().length, 1);
  // A live pair that does not match (as an older, two-rename install could leave) counts as due.
  writeFileSync(paths.key, next.key, { mode: 0o600 });
  assert.throws(() => checkInstalled(paths, [NAME]), /do not belong together/);
  const repaired = await f.run('renew', 'quiet');
  assert.equal(repaired.status, 0, repaired.out);
  assert.match(repaired.out, /Renewing now\. The installed certificate failed its check: The certificate and the key do not belong together\./);
  assert.equal(f.calls().length, 2);
  checkInstalled(paths, [NAME]);
  assert.notEqual(currentRelease(f.tls), good.release);
  assert.equal(installedStatus(f.tls).record.lastRenewal?.kind, 'renew');
  // Kept: the new folder and the one in use before. Never the half-written one.
  assert.deepEqual(readdirSync(join(f.tls, 'releases')).sort(), [good.release, currentRelease(f.tls)].sort());
  assert.ok(!readdirSync(join(f.tls, 'releases')).includes(halfWritten!));
});

/** A fake deSEC on this PC: checks the token header, keeps the TXT records, records each request. */
interface FakeDesec {
  url: string;
  requests: { method: string; path: string; auth: string; body: string }[];
  records: Map<string, string[]>;
  refuse: boolean;
  close(): Promise<void>;
}

async function fakeDesec(): Promise<FakeDesec> {
  const state = { requests: [] as FakeDesec['requests'], records: new Map<string, string[]>(), refuse: false };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '');
      state.requests.push({ method: req.method ?? '', path: req.url ?? '', auth, body });
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (state.refuse || auth !== `Token ${TOKEN}`) return send(401, { detail: 'Invalid token.' });
      const rr = /^\/api\/v1\/domains\/([^/]+)\/rrsets\/([^/]+)\/TXT\/$/.exec(req.url ?? '');
      if (req.method === 'GET' && rr) {
        const have = state.records.get(`${rr[2]}.${rr[1]}`);
        return have ? send(200, { subname: rr[2], type: 'TXT', records: have, ttl: 3600 }) : send(404, { detail: 'Not found.' });
      }
      const bulk = /^\/api\/v1\/domains\/([^/]+)\/rrsets\/$/.exec(req.url ?? '');
      if (req.method === 'PUT' && bulk) {
        for (const set of JSON.parse(body) as { subname: string; records: string[] }[]) {
          if (set.records.length) state.records.set(`${set.subname}.${bulk[1]}`, set.records);
          else state.records.delete(`${set.subname}.${bulk[1]}`);
        }
        return send(200, JSON.parse(body));
      }
      if (req.method === 'GET' && req.url === '/api/v1/domains/') return send(200, [{ name: 'example.dedyn.io' }, { name: 'example.com' }]);
      return send(404, { detail: 'Not found.' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/api/v1`,
    get refuse() {
      return state.refuse;
    },
    set refuse(v: boolean) {
      state.refuse = v;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}

const CHALLENGE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

/**
 * A temp install with a fake acme.sh. The fake logs its arguments, fails if a token reaches its
 * environment, calls ShelfReady's hook like the real acme.sh does, and makes a test chain with
 * openssl. A config with dnsProvider dns_fake stands for another acme.sh hook, which does get
 * its token: that fake fails, printing the token, to test that cert.ts removes it.
 */
function fakeInstall(desecUrl: string, provider: 'desec' | 'dns_fake' = 'desec') {
  const dir = scratch();
  const bin = privateDir(join(dir, 'bin'));
  const log = join(dir, 'acme-calls.log');
  const fake = `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then echo "https://github.com/acmesh-official/acme.sh"; echo "v3.1.1"; exit 0; fi
echo "$*" >> '${log}'
server=''; home=''; certhome=''; conf=''; domain=''; alias=''; dns=''
while [ $# -gt 0 ]; do
  case "$1" in
    --server) server=$2; shift ;;
    --home) home=$2; shift ;;
    --cert-home) certhome=$2; shift ;;
    --accountconf) conf=$2; shift ;;
    --domain) domain=$2; shift ;;
    --challenge-alias) alias=$2; shift ;;
    --dns) dns=$2; shift ;;
  esac
  shift
done
if [ "$dns" = dns_fake ]; then
  echo "SAVED_FAKE_TOKEN='$FAKE_TOKEN'" >> "$conf"
  echo "error with Authorization: Token $FAKE_TOKEN"; echo "the token was $FAKE_TOKEN"; exit 1
fi
if env | grep -q '${TOKEN}'; then echo "the token reached acme.sh"; exit 3; fi
. "$home/dnsapi/dns_shelfready.sh"
dns_shelfready_add "_acme-challenge.$alias" '${CHALLENGE}' || { echo "Error add txt for domain:_acme-challenge.$alias"; exit 1; }
d="$certhome/\${domain}_ecc"
mkdir -p "$d"; cd "$d"
case "$server" in *staging*) org="(STAGING) Let's Encrypt"; cn="(STAGING) Test Issuer E9" ;; *) org="Let's Encrypt"; cn="Test Issuer E9" ;; esac
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.pem -days 3650 -subj "/C=US/O=$org/CN=$cn" 2>/dev/null
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout "$domain.key" -out leaf.csr -subj "/CN=$domain" 2>/dev/null
echo "subjectAltName=DNS:$domain" > ext.cnf
openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 90 -out leaf.pem -extfile ext.cnf 2>/dev/null
cat leaf.pem ca.pem > fullchain.cer
dns_shelfready_rm "_acme-challenge.$alias" '${CHALLENGE}' || true
echo "Cert success."
`;
  writeFileSync(join(bin, 'acme.sh'), fake, { mode: 0o700 });
  const secrets = privateDir(join(dir, 'secrets'));
  writeFileSync(join(secrets, 'acme.env'), `DESEC_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const tls = join(dir, 'tls');
  const acme = join(dir, 'acme');
  const cfg = join(dir, 'cert.json');
  const providerFields = provider === 'desec' ? { dnsProvider: 'desec' } : { dnsProvider: 'dns_fake', tokenEnv: { FAKE_TOKEN: 'DESEC_TOKEN' } };
  writeFileSync(cfg, JSON.stringify({ domain: NAME, challengeAlias: 'example.dedyn.io', ...providerFields, tokenFile: join(secrets, 'acme.env'), tlsDir: tls, acmeHome: acme, acmeSh: join(bin, 'acme.sh'), dnsWaitSeconds: 30 }));
  // cert.ts reads the server config too (allowedHosts). A config of its own, never this PC's.
  const serverJson = join(dir, 'server.json');
  writeFileSync(serverJson, '{}');
  // Not spawnSync: the fake deSEC answers from this test process, which must keep running.
  const run = (...words: string[]): Promise<{ status: number | null; out: string }> =>
    new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, SHELFREADY_TEST_DESEC_API: desecUrl, SHELFREADY_CONFIG: serverJson };
      delete env.NODE_OPTIONS;
      const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'net', 'cert.ts'), ...words, 'config', cfg], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (status) => resolve({ status, out }));
    });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { run, dir, tls, acme, calls, serverJson };
}

/** Every file under dir, read as text. */
function allText(dir: string): string {
  if (!existsSync(dir)) return '';
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name), 'latin1'))
    .join('\n');
}

const fingerprint = (path: string): string => new X509Certificate(readFileSync(path)).fingerprint256;
const installedStatus = (tls: string) => readCertStatus(installedPaths(tls).cert, installedPaths(tls).status, Date.now());

test('the deSEC hook writes only the challenge record, keeps other values, and sends the token only in its header', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const records = new Map<string, string[]>();
  const fakeFetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const path = url.replace('https://desec.io/api/v1', '');
    if (init.method === 'GET' && path === '/domains/') return Response.json([{ name: 'example.com' }, { name: 'shelfready.example.com' }]);
    const m = /^\/domains\/([^/]+)\/rrsets\/([^/]+)\/TXT\/$/.exec(path);
    if (init.method === 'GET' && m) return records.has(`${m[2]}.${m[1]}`) ? Response.json({ records: records.get(`${m[2]}.${m[1]}`) }) : new Response('', { status: 404 });
    const b = /^\/domains\/([^/]+)\/rrsets\/$/.exec(path);
    if (init.method === 'PUT' && b) {
      for (const set of JSON.parse(String(init.body)) as { subname: string; records: string[] }[]) {
        if (set.records.length) records.set(`${set.subname}.${b[1]}`, set.records);
        else records.delete(`${set.subname}.${b[1]}`);
      }
      return Response.json([]);
    }
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const d = { token: TOKEN, api: DESEC_API, fetch: fakeFetch };
  const aliased = { domain: NAME, challengeAlias: 'example.dedyn.io' };
  assert.deepEqual(challengeTarget('_acme-challenge.example.dedyn.io.', aliased), { zone: 'example.dedyn.io', subname: '_acme-challenge' });
  for (const bad of ['example.dedyn.io', '_acme-challenge.other.dedyn.io', 'www.example.dedyn.io', '_acme-challenge.shelfready.example.com']) {
    assert.throws(() => challengeTarget(bad, aliased), /Refusing to write/, bad);
  }
  records.set('_acme-challenge.example.dedyn.io', ['"older-value-from-another-order-123"']);
  await addTxt(d, '_acme-challenge.example.dedyn.io', CHALLENGE, aliased);
  assert.deepEqual(records.get('_acme-challenge.example.dedyn.io'), ['"older-value-from-another-order-123"', `"${CHALLENGE}"`]);
  await removeTxt(d, '_acme-challenge.example.dedyn.io', CHALLENGE, aliased);
  assert.deepEqual(records.get('_acme-challenge.example.dedyn.io'), ['"older-value-from-another-order-123"']);
  await assert.rejects(addTxt(d, '_acme-challenge.example.dedyn.io', 'bad value; rm', aliased), /does not look like/);
  // Without an alias, the longest deSEC domain the name ends with.
  await addTxt(d, `_acme-challenge.${NAME}`, CHALLENGE, { domain: NAME, challengeAlias: '' });
  assert.deepEqual(records.get('_acme-challenge.shelfready.example.com'), [`"${CHALLENGE}"`]);
  for (const s of seen) {
    assert.equal((s.init.headers as Record<string, string>).Authorization, `Token ${TOKEN}`);
    assert.equal(s.init.redirect, 'error');
    assert.ok(!s.url.includes(TOKEN) && !String(s.init.body ?? '').includes(TOKEN));
  }
  const refused = { ...d, fetch: (async () => new Response('', { status: 401 })) as unknown as typeof fetch };
  await assert.rejects(addTxt(refused, '_acme-challenge.example.dedyn.io', CHALLENGE, aliased), (e) => e instanceof CertError && /refused the token/.test(e.message) && !e.message.includes(TOKEN));
  // Only a fake deSEC on this PC may stand in, by its exact shape, and only with a test token: a
  // real token always goes to deSEC.
  const fake = { SHELFREADY_TEST_DESEC_API: 'http://127.0.0.1:4000/api/v1' };
  assert.equal(desecApi(fake, TOKEN), 'http://127.0.0.1:4000/api/v1');
  assert.equal(desecApi(fake, 'a-real-looking-token-0123456789'), DESEC_API);
  for (const other of ['https://evil.example/api/v1', 'http://127.0.0.1.evil.example:80/api/v1', 'http://10.0.0.5:80/api/v1']) assert.equal(desecApi({ SHELFREADY_TEST_DESEC_API: other }, TOKEN), DESEC_API, other);
  // The scripts that hold the token refuse any preload, flag or proxy setting.
  assert.equal(scriptEnvironmentProblem({}, []), null);
  assert.equal(scriptEnvironmentProblem({ NODE_OPTIONS: '--max-old-space-size=100' }, []), 'NODE_OPTIONS');
  assert.equal(scriptEnvironmentProblem({}, ['--inspect']), 'a Node flag on the command line');
  for (const v of ['NODE_USE_SYSTEM_CA', 'OPENSSL_CONF', 'SSL_CERT_FILE', 'NODE_TLS_REJECT_UNAUTHORIZED']) assert.equal(scriptEnvironmentProblem({ [v]: '1' }, []), v);
});

test('cert.ts issues a test certificate through acme.sh and the deSEC hook, installs it privately, and acme.sh never sees the token', { skip }, async (t) => {
  const desec = await fakeDesec();
  t.after(() => desec.close());
  const f = fakeInstall(desec.url);
  const issued = await f.run('issue');
  assert.equal(issued.status, 0, issued.out);
  assert.match(issued.out, /Issued and installed\./);
  assert.match(issued.out, /a test certificate from staging/);
  const calls = f.calls();
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`--server ${LE_STAGING.replace(/[./]/g, '\\$&')}`));
  assert.match(calls[0], /--domain shelfready\.example\.com --dns dns_shelfready --challenge-alias example\.dedyn\.io/);
  assert.match(calls[0], /--accountconf \S+\/acme\/run-[0-9a-f]{16}\.conf/);
  // The hook wrote the record at the alias, with the token in the header only, then removed it.
  const puts = desec.requests.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 2);
  assert.ok(puts.every((r) => r.path === '/api/v1/domains/example.dedyn.io/rrsets/' && r.auth === `Token ${TOKEN}`));
  assert.deepEqual(JSON.parse(puts[0].body), [{ subname: '_acme-challenge', type: 'TXT', ttl: 3600, records: [`"${CHALLENGE}"`] }]);
  assert.deepEqual(JSON.parse(puts[1].body)[0].records, []);
  assert.equal(desec.records.size, 0);
  assert.equal(statSync(f.tls).mode & 0o777, 0o700);
  assert.equal(statSync(installedPaths(f.tls).key).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.tls, 'releases', currentRelease(f.tls))).mode & 0o777, 0o700);
  assert.equal(statSync(f.acme).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.acme, 'dnsapi', 'dns_shelfready.sh')).mode & 0o777, 0o600);
  const st = installedStatus(f.tls);
  assert.equal(st.staging, true);
  assert.equal(st.record.lastRenewal?.kind, 'issue');
  assert.equal(st.record.lastRenewal?.ok, true);
  assert.equal(st.record.lastRenewal?.ca, 'staging');
  assert.ok(!issued.out.includes(TOKEN));
  assert.ok(!calls[0].includes(TOKEN));
  assert.ok(!allText(f.acme).includes(TOKEN));
  assert.ok(!allText(f.tls).includes(TOKEN));
  assert.ok(!readdirSync(f.acme).some((n) => n.startsWith('run-')));
  assert.ok(!existsSync(join(f.acme, 'cert.lock')), 'the lock is released');

  // Not due: acme.sh is not called, the daily check is recorded, and quiet prints nothing.
  const quiet = await f.run('renew', 'quiet');
  assert.equal(quiet.status, 0, quiet.out);
  assert.equal(quiet.out, '');
  assert.equal(f.calls().length, 1);
  assert.match(installedStatus(f.tls).record.lastCheck?.message ?? '', /^Not due\. Renewal starts \d{4}-\d{2}-\d{2}\.$/);

  // renew now: renews from the same service (staging) and installs the new one.
  const before = fingerprint(installedPaths(f.tls).cert);
  const now = await f.run('renew', 'now');
  assert.equal(now.status, 0, now.out);
  assert.equal(f.calls().length, 2);
  assert.match(f.calls()[1], /acme-staging/);
  assert.notEqual(fingerprint(installedPaths(f.tls).cert), before);
  assert.equal(installedStatus(f.tls).record.lastRenewal?.kind, 'renew');

  // The renewal dry run: its own acme.sh folder, staging, nothing installed.
  const installed = readFileSync(installedPaths(f.tls).cert);
  const dry = await f.run('renew', 'dry-run');
  assert.equal(dry.status, 0, dry.out);
  assert.match(f.calls()[2], /--home \S+\/acme\/dry-run /);
  assert.match(f.calls()[2], /acme-staging/);
  assert.deepEqual(readFileSync(installedPaths(f.tls).cert), installed);
  assert.equal(installedStatus(f.tls).record.lastDryRun?.ok, true);
  assert.ok(!existsSync(join(f.acme, 'dry-run', 'certs', `${NAME}_ecc`)), 'the test certificate is removed');
});

test('cert.ts refuses a production certificate that does not chain to a trusted root, and installs nothing', { skip }, async (t) => {
  const desec = await fakeDesec();
  t.after(() => desec.close());
  const f = fakeInstall(desec.url);
  assert.equal((await f.run('issue')).status, 0);
  const installed = readFileSync(installedPaths(f.tls).cert);
  const prod = await f.run('issue', 'production');
  assert.equal(prod.status, 1);
  assert.match(prod.out, /does not chain to a trusted root/);
  assert.match(f.calls()[1], /acme-v02\.api\.letsencrypt\.org/);
  assert.deepEqual(readFileSync(installedPaths(f.tls).cert), installed);
  const rec = installedStatus(f.tls).record.lastRenewal;
  assert.equal(rec?.ok, false);
  assert.equal(rec?.ca, 'production');
});

test('when deSEC refuses or acme.sh fails, the reason is shown without the token, and recorded', { skip }, async (t) => {
  const desec = await fakeDesec();
  t.after(() => desec.close());
  desec.refuse = true;
  const f = fakeInstall(desec.url);
  const r = await f.run('issue');
  assert.equal(r.status, 1);
  assert.match(r.out, /acme\.sh did not get a certificate/);
  assert.match(r.out, /deSEC refused the token/);
  assert.ok(!r.out.includes(TOKEN));
  assert.equal(installedStatus(f.tls).record.lastRenewal?.ok, false);
  // Nothing to renew yet: the daily run says so and fails.
  const renew = await f.run('renew', 'quiet');
  assert.equal(renew.status, 1);
  assert.match(renew.out, /No certificate is installed/);
  // Another acme.sh hook gets its token; when it prints it, cert.ts removes it, and acme.sh's saved copy is deleted.
  const g = fakeInstall(desec.url, 'dns_fake');
  const leak = await g.run('issue');
  assert.equal(leak.status, 1);
  assert.match(leak.out, /Authorization: Token \[redacted\]/);
  assert.match(leak.out, /the token was \[redacted\]/);
  assert.ok(!leak.out.includes(TOKEN));
  assert.ok(!allText(g.acme).includes(TOKEN));
});

test('cert.ts runs one at a time, refuses an open token file, and checks its words', { skip }, async (t) => {
  const desec = await fakeDesec();
  t.after(() => desec.close());
  const f = fakeInstall(desec.url);
  mkdirSync(f.acme, { recursive: true, mode: 0o700 });
  // A living certificate command holds the lock (a stand-in whose command line names cert.ts).
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'cert.ts'], { stdio: 'ignore' });
  t.after(() => holder.kill());
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync(join(f.acme, 'cert.lock'), String(holder.pid));
  const locked = await f.run('issue');
  assert.equal(locked.status, 1);
  assert.match(locked.out, new RegExp(`Another certificate command is running \\(pid ${holder.pid}\\)\\. If none is, delete \\S+cert\\.lock`));
  assert.equal(f.calls().length, 0);
  assert.match(installedStatus(f.tls).record.lastRenewal?.message ?? '', /Another certificate command is running/, 'recorded too');
  holder.kill();
  // A lock whose pid is now some other program of ours (here, this test) is taken over, as is one
  // whose pid belongs to another user (pid 1, root's: a real owner is always this user) and a dead one.
  writeFileSync(join(f.acme, 'cert.lock'), String(process.pid));
  assert.equal((await f.run('issue')).status, 0);
  writeFileSync(join(f.acme, 'cert.lock'), '1');
  assert.equal((await f.run('renew', 'now')).status, 0);
  writeFileSync(join(f.acme, 'cert.lock'), '999999999');
  assert.equal((await f.run('renew', 'now')).status, 0);
  chmodSync(join(f.dir, 'secrets', 'acme.env'), 0o644);
  const open = await f.run('renew', 'now');
  assert.equal(open.status, 1);
  assert.match(open.out, /must be mode 600/);
  assert.ok(!open.out.includes(TOKEN));
  // Recorded, so the settings page shows why the renewal failed.
  assert.match(installedStatus(f.tls).record.lastCheck?.message ?? '', /must be mode 600/);
  assert.equal((await f.run('renew', 'sideways')).status, 2);
  assert.equal((await f.run('issue', 'now')).status, 2);
  assert.equal((await f.run('renew', 'now', 'dry-run')).status, 2);
});

test('cert.ts will not get a certificate the server would refuse: allowedHosts must hold only the domain', { skip }, async (t) => {
  const desec = await fakeDesec();
  t.after(() => desec.close());
  const f = fakeInstall(desec.url);
  // The Phase 1 address fallback left in place.
  writeFileSync(f.serverJson, JSON.stringify({ tls: { enabled: true }, listenAddresses: ['10.0.0.5'], allowedHosts: [NAME, '10.0.0.5'] }));
  const refused = await f.run('issue');
  assert.equal(refused.status, 1);
  assert.match(refused.out, /allowedHosts in the server config lists 10\.0\.0\.5, which a certificate for shelfready\.example\.com does not cover, so the server would refuse it\. Remove it from allowedHosts first/);
  assert.equal(f.calls().length, 0, 'Let\'s Encrypt was never asked');
  assert.match(installedStatus(f.tls).record.lastRenewal?.message ?? '', /Remove it from allowedHosts first/, 'recorded for the settings page');
  // With the address taken out, it goes ahead.
  writeFileSync(f.serverJson, JSON.stringify({ tls: { enabled: true }, listenAddresses: ['10.0.0.5'], allowedHosts: [NAME] }));
  assert.equal((await f.run('issue')).status, 0);
});
