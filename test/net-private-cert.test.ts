// Phase 1: the private store certificate (scripts/net/private-cert.ts), the bare store address as
// a host, and the Phase 1 crontab. Every certificate is made in a temp folder, never in
// ~/.config/shelfready, and the store CA key is checked to be gone.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkServerIdentity, connect as tlsConnect } from 'node:tls';
import { ADMIN_PW, addUser, csrfFrom, form, makeApp, tempDir, type TestApp } from './server-helpers.ts';
import { opensslMissing, privateDir } from './net-helpers.ts';
import { caConfig, make, MAX_DAYS, parseTargets, removeStaleRamFolders, serverConfig } from '../scripts/net/private-cert.ts';
import { certificateSection, type NetworkView } from '../src/server/views/pages.ts';
import { CertError, installedPaths } from '../scripts/net/cert-lib.ts';
import { readCertStatus } from '../src/server/cert-status.ts';
import { makeConfig, REPO_ROOT } from '../src/server/config.ts';
import { listenAll } from '../src/server/listen.ts';

const NAME = 'shelfready.example.com';
const IP = '10.0.0.5';
const DAY = 24 * 3600_000;
// This file's own RAM folder for the CA key's work folders, so it never sees another run's.
const ramBase = [process.env.XDG_RUNTIME_DIR, '/dev/shm'].find((b) => {
  try {
    return Boolean(b) && statfsSync(b!).type === 0x01021994;
  } catch {
    return false;
  }
});
const skip = opensslMissing() || (ramBase ? false : 'no tmpfs folder for the store CA key');
const RAM = ramBase ? mkdtempSync(join(ramBase, 'sr-test-')) : '';
if (RAM) process.env.SHELFREADY_TEST_RAM_DIR = RAM;

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
  if (RAM) rmSync(RAM, { recursive: true, force: true });
});
function scratch(): string {
  const d = tempDir();
  made.push(d);
  return d;
}

/** Runs private-cert.ts as Bart would, with no NODE_OPTIONS. */
function run(...words: string[]): { status: number | null; out: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'net', 'private-cert.ts'), ...words], { env, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const openssl = (...args: string[]): string => execFileSync('openssl', args, { encoding: 'utf8', env: { PATH: process.env.PATH, OPENSSL_CONF: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] });

/** The tmpfs folders the CA key may pass through, and what is in them that looks like ours. */
function ramLeftovers(): string[] {
  return RAM ? readdirSync(RAM).filter((n) => n.startsWith('shelfready-ca-')) : [];
}

/** Every file under dir, read as text, each once (the current link leads to a release folder again). */
function allText(dir: string): { path: string; text: string }[] {
  const seen = new Set<string>();
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => realpathSync(join(e.parentPath, e.name)))
    .filter((p) => !seen.has(p) && seen.add(p))
    .map((p) => ({ path: p, text: readFileSync(p, 'latin1') }));
}

test('the store CA is name constrained and its key is gone; the server certificate is what phones accept', { skip }, () => {
  const tls = join(scratch(), 'tls');
  const before = ramLeftovers();
  const r = run('make', NAME, IP, 'dir', tls);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(ramLeftovers(), before, 'nothing is left in the RAM folder');
  const paths = installedPaths(tls);
  const ca = new X509Certificate(readFileSync(join(tls, 'ca.crt')));
  const leaf = new X509Certificate(readFileSync(paths.cert));
  // The fingerprint printed for the phones is the store CA's.
  assert.match(r.out, new RegExp(`\\n  ${ca.fingerprint256}\\n`));
  // The CA: P-256, a CA that may sign only end certificates, only for these two names.
  const caText = openssl('x509', '-in', join(tls, 'ca.crt'), '-noout', '-text');
  assert.match(caText, /Public Key Algorithm: id-ecPublicKey[\s\S]*NIST CURVE: P-256/);
  assert.match(caText, /Signature Algorithm: ecdsa-with-SHA256/);
  assert.match(caText, /X509v3 Basic Constraints: critical\s+CA:TRUE, pathlen:0/);
  assert.match(caText, /X509v3 Key Usage: critical\s+Certificate Sign, CRL Sign/);
  assert.match(caText, /X509v3 Name Constraints: critical\s+Permitted:\s+DNS:shelfready\.example\.com\s+IP:10\.0\.0\.5\/255\.255\.255\.255/);
  assert.match(ca.subject, /^O=ShelfReady private store CA\nCN=ShelfReady store CA \d{4}-\d{2}-\d{2} [0-9a-f]{4}$/);
  // The server certificate: P-256, SHA-256, both names, serverAuth, no CA, at most 397 days.
  const leafText = openssl('x509', '-in', paths.cert, '-noout', '-text');
  assert.match(leafText, /NIST CURVE: P-256/);
  assert.match(leafText, /Signature Algorithm: ecdsa-with-SHA256/);
  assert.match(leafText, /X509v3 Basic Constraints: critical\s+CA:FALSE/);
  assert.match(leafText, /X509v3 Key Usage: critical\s+Digital Signature\n/);
  assert.match(leafText, /X509v3 Extended Key Usage:\s+TLS Web Server Authentication\n/);
  assert.equal(leaf.subjectAltName, `DNS:${NAME}, IP Address:${IP}`);
  const life = leaf.validToDate.getTime() - leaf.validFromDate.getTime();
  assert.ok(life <= MAX_DAYS * DAY + 60_000 && life >= (MAX_DAYS - 1) * DAY, `lasts ${life / DAY} days`);
  assert.ok(ca.validToDate >= leaf.validToDate && ca.validToDate.getTime() - leaf.validToDate.getTime() < 2 * DAY, 'the CA outlives it by about a day');
  assert.ok(leaf.verify(ca.publicKey));
  // openssl's own path check, name and address included.
  assert.match(openssl('verify', '-CAfile', join(tls, 'ca.crt'), '-verify_hostname', NAME, paths.cert), /: OK/);
  assert.match(openssl('verify', '-CAfile', join(tls, 'ca.crt'), '-verify_ip', IP, paths.cert), /: OK/);
  // Files: a private release folder, the key and certificate mode 600, ca.crt beside current.
  assert.equal(statSync(tls).mode & 0o777, 0o700);
  assert.equal(statSync(join(tls, 'releases', readdirSync(join(tls, 'releases'))[0])).mode & 0o777, 0o700);
  assert.equal(statSync(paths.key).mode & 0o777, 0o600);
  assert.equal(statSync(paths.cert).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(tls).sort(), ['ca.crt', 'current', 'releases']);
  // The only private key anywhere is the server's: the store CA key is gone.
  const keys = allText(tls).filter((f) => f.text.includes('PRIVATE KEY'));
  assert.equal(keys.length, 1);
  assert.equal(keys[0].path, realpathSync(paths.key));
  assert.ok(leaf.checkPrivateKey(createPrivateKey(keys[0].text)), 'and it is the server key, not the CA key');
  assert.match(r.out, /The store CA key was destroyed/);
  // The settings page and cert.ts know it as the private store certificate.
  const st = readCertStatus(paths.cert, paths.status, Date.now());
  assert.equal(st.privateStore, true);
  assert.deepEqual(st.names, [NAME, IP]);
  assert.equal(st.due, false);
  assert.equal(st.checkStale, false);
});

test('name constraints stop the store CA from vouching for anything else', { skip }, () => {
  // The same CA config, with a key the test keeps, signing names outside the constraints.
  const dir = privateDir(join(scratch(), 'nc'));
  const t = { names: [NAME], ips: [IP] };
  writeFileSync(join(dir, 'ca.cnf'), caConfig(t, 'Test store CA'));
  openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', join(dir, 'ca.key'));
  openssl('req', '-x509', '-new', '-key', join(dir, 'ca.key'), '-sha256', '-days', '30', '-config', join(dir, 'ca.cnf'), '-extensions', 'ca_ext', '-out', join(dir, 'ca.crt'));
  openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', join(dir, 'leaf.key'));
  const sign = (label: string, targets: { names: string[]; ips: string[] }): string => {
    writeFileSync(join(dir, `${label}.cnf`), serverConfig(targets));
    openssl('req', '-new', '-key', join(dir, 'leaf.key'), '-config', join(dir, `${label}.cnf`), '-out', join(dir, `${label}.csr`));
    openssl('x509', '-req', '-in', join(dir, `${label}.csr`), '-CA', join(dir, 'ca.crt'), '-CAkey', join(dir, 'ca.key'), '-set_serial', '0x1234', '-days', '30', '-sha256', '-extfile', join(dir, `${label}.cnf`), '-extensions', 'srv_ext', '-out', join(dir, `${label}.crt`));
    const v = spawnSync('openssl', ['verify', '-CAfile', join(dir, 'ca.crt'), join(dir, `${label}.crt`)], { encoding: 'utf8', env: { PATH: process.env.PATH, OPENSSL_CONF: '/dev/null' } });
    return `${v.stdout}${v.stderr}`;
  };
  assert.match(sign('ours', t), /: OK/);
  assert.match(sign('bank', { names: ['bank.example'], ips: [] }), /permitted subtree violation/);
  assert.match(sign('sub', { names: ['evil.shelfready.example.com.evil.example'], ips: [] }), /permitted subtree violation/);
  assert.match(sign('otherip', { names: [], ips: ['10.0.0.6'] }), /permitted subtree violation/);
});

test('make refuses a second certificate without replace, odd names and too long a life', { skip }, () => {
  const tls = join(scratch(), 'tls');
  assert.equal(run('make', NAME, IP, 'dir', tls).status, 0);
  const first = new X509Certificate(readFileSync(join(tls, 'ca.crt'))).fingerprint256;
  const again = run('make', NAME, IP, 'dir', tls);
  assert.equal(again.status, 1);
  assert.match(again.out, /already installed, valid until .* add the word replace/);
  const replaced = run('make', NAME, IP, 'dir', tls, 'replace');
  assert.equal(replaced.status, 0, replaced.out);
  const second = new X509Certificate(readFileSync(join(tls, 'ca.crt')));
  assert.notEqual(second.fingerprint256, first, 'a new store CA');
  const leaf = new X509Certificate(readFileSync(installedPaths(tls).cert));
  assert.ok(leaf.verify(second.publicKey), 'the installed certificate is signed by the new CA');
  assert.equal(readdirSync(join(tls, 'releases')).length, 2, 'the one before is kept, no more');
  // Odd words.
  for (const [words, re] of [
    [['8.8.8.8'], /only store network or tailnet addresses/],
    [['localhost'], /not a host name or an IPv4 address/],
    [[NAME, NAME], /listed twice/],
    [['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', IP], /at most 4/],
    [[], /Name what the certificate covers/],
  ] as const) {
    assert.throws(() => parseTargets(words), (e) => e instanceof CertError && re.test(e.message), JSON.stringify(words));
  }
  const long = run('make', NAME, IP, 'dir', join(scratch(), 'tls'), 'days', '398');
  assert.equal(long.status, 1);
  assert.match(long.out, /days must be a whole number from 1 to 397/);
  assert.equal(run('make', NAME, 'dir', join(REPO_ROOT, 'config', 'local', 'tls')).status, 2, 'never inside the ShelfReady folder');
  const status = run('status', 'dir', tls);
  assert.equal(status.status, 0, status.out);
  assert.match(status.out, /^Private store certificate for shelfready\.example\.com, 10\.0\.0\.5/);
  assert.match(status.out, new RegExp(`Its SHA-256 fingerprint: ${second.fingerprint256}`));
  assert.match(status.out, /OK {3}the installed certificate was signed by this store CA/);
});

/** Adds an admin and signs in through the bare address's origin. */
async function adminCookie(s: TestApp): Promise<string> {
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const page = await s.app.inject({ method: 'GET', url: '/login', headers: { host: `${IP}:8443` } });
  const login = page.cookies.find((c) => c.name === '__Host-sr_login')?.value;
  const res = await s.app.inject({
    method: 'POST',
    url: '/login',
    headers: { host: `${IP}:8443`, origin: `https://${IP}:8443`, cookie: `__Host-sr_login=${login}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ _csrf: csrfFrom(page.body), username: 'bart', password: ADMIN_PW }),
  });
  return `__Host-sr_session=${res.cookies.find((c) => c.name === '__Host-sr_session')?.value}`;
}

test('the server answers the name and the bare address with the private certificate; HSTS only for the name', { skip }, async (t) => {
  const tls = join(scratch(), 'tls');
  assert.equal(run('make', NAME, IP, 'dir', tls).status, 0);
  const paths = installedPaths(tls);
  const s = await makeApp({ tls: { enabled: true, certPath: paths.cert, keyPath: paths.key }, listenAddresses: [IP], allowedHosts: [NAME, IP], port: 8443 });
  t.after(() => s.close());
  assert.equal(s.config.tls.statusPath, paths.status);
  const byIp = await s.app.inject({ method: 'GET', url: '/login', headers: { host: `${IP}:8443` } });
  assert.equal(byIp.statusCode, 200);
  assert.equal(byIp.headers['strict-transport-security'], undefined, 'no HSTS for a bare address');
  const byName = await s.app.inject({ method: 'GET', url: '/login', headers: { host: `${NAME}:8443` } });
  assert.equal(byName.headers['strict-transport-security'], 'max-age=300');
  assert.equal((await s.app.inject({ method: 'GET', url: '/login', headers: { host: '10.0.0.6:8443' } })).statusCode, 421, 'another address is refused');
  // Sign in through the address: its https origin is allowed.
  const page = await s.app.inject({ method: 'GET', url: '/settings', headers: { host: `${IP}:8443`, cookie: await adminCookie(s) } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /This is the private store certificate, made on this PC\./);
  assert.match(page.body, /<dt>Names<\/dt><dd>shelfready\.example\.com, 10\.0\.0\.5<\/dd>/);
  // The test app's clock is fixed a few days before the certificate starts, so only the shape is checked.
  assert.match(page.body, /<dt>Valid until<\/dt><dd>\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(\d+ days left\)<\/dd>/);
  assert.doesNotMatch(page.body, /renewal|Let&#39;s Encrypt|Next renewal/i);
  assert.doesNotMatch(page.body, /—|–|--/);
});

test('a phone that trusts the store CA accepts the certificate for the name and the address, and nothing else', { skip }, async (t) => {
  const tls = join(scratch(), 'tls');
  assert.equal(run('make', NAME, IP, 'dir', tls).status, 0);
  const paths = installedPaths(tls);
  // Listening on loopback only; the client checks the names the way a phone does.
  const s = await makeApp({ tls: { enabled: true, certPath: paths.cert, keyPath: paths.key }, allowedHosts: [NAME], port: 0 });
  t.after(() => s.close());
  await listenAll(s.app);
  const port = (s.app.server.address() as { port: number }).port;
  const ca = readFileSync(join(tls, 'ca.crt'));
  const peer = await new Promise<ReturnType<ReturnType<typeof tlsConnect>['getPeerX509Certificate']>>((resolve, reject) => {
    const sock = tlsConnect({ host: '127.0.0.1', port, servername: NAME, ca }, () => {
      const cert = sock.getPeerX509Certificate();
      sock.destroy();
      resolve(cert);
    });
    sock.once('error', reject);
  });
  assert.ok(peer);
  const legacy = peer!.toLegacyObject();
  assert.equal(checkServerIdentity(NAME, legacy), undefined);
  assert.equal(checkServerIdentity(IP, legacy), undefined);
  assert.ok(checkServerIdentity('evil.example', legacy) instanceof Error);
  assert.ok(checkServerIdentity('10.0.0.6', legacy) instanceof Error);
  // Without the store CA the same connection is refused, as on a phone that has not installed it.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const sock = tlsConnect({ host: '127.0.0.1', port, servername: NAME }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', reject);
    }),
  );
});

test('a bare address may be an allowed host only if the server listens on it', () => {
  const tlsOn = { enabled: true, certPath: '/x/fullchain.pem', keyPath: '/x/key.pem' };
  const c = makeConfig({ tls: tlsOn, listenAddresses: [IP], allowedHosts: [NAME, IP], port: 8443 });
  assert.deepEqual(c.allowedHosts, [NAME, IP]);
  assert.deepEqual(c.publicOrigins, [`https://${NAME}:8443`, `https://${IP}:8443`, 'https://127.0.0.1:8443', 'https://localhost:8443']);
  assert.throws(() => makeConfig({ tls: tlsOn, listenAddresses: [IP], allowedHosts: [NAME, '10.0.0.6'] }), /or an address in listenAddresses/);
  assert.throws(() => makeConfig({ tls: tlsOn, listenAddresses: [IP], allowedHosts: ['8.8.8.8'] }), /or an address in listenAddresses/);
  // An address alone is enough for phones on store Wi-Fi.
  assert.deepEqual(makeConfig({ tls: tlsOn, listenAddresses: [IP], allowedHosts: [IP] }).allowedHosts, [IP]);
});

test('cert.ts leaves the private store certificate alone, and the Phase 1 crontab has no renewal lines', { skip }, () => {
  const dir = scratch();
  const tls = join(dir, 'tls');
  assert.equal(run('make', NAME, IP, 'dir', tls).status, 0);
  const release = readdirSync(join(tls, 'releases'));
  const cfg = join(dir, 'cert.json');
  writeFileSync(cfg, JSON.stringify({ domain: NAME, challengeAlias: 'example.dedyn.io', tokenFile: join(dir, 'acme.env'), tlsDir: tls, acmeHome: join(dir, 'acme'), acmeSh: join(dir, 'no-acme.sh') }));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_OPTIONS;
  const renew = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'net', 'cert.ts'), 'renew', 'now', 'config', cfg], { env, encoding: 'utf8' });
  assert.equal(renew.status, 0, renew.stdout);
  assert.match(renew.stdout, /The private store certificate is installed\. It is not renewed here/);
  assert.deepEqual(readdirSync(join(tls, 'releases')), release, 'nothing changed');
  // The crontab: start and keep-alive only, unless there is a Let's Encrypt config.
  const crontab = (certConfig: string): string =>
    spawnSync('sh', [join(REPO_ROOT, 'scripts', 'net', 'service.sh'), 'crontab'], { env: { ...env, SHELFREADY_NODE: process.execPath, SHELFREADY_CERT_CONFIG: certConfig }, encoding: 'utf8' }).stdout;
  const phase1 = crontab(join(dir, 'none.json'));
  assert.deepEqual(
    phase1.trim().split('\n').map((l) => l.split(' ')[0]),
    ['#', '@reboot', '*/5'],
  );
  assert.doesNotMatch(phase1, /renew-cert|test-renewal/);
  assert.match(crontab(cfg), /17 3 \* \* \* .*renew-cert\n47 3 1 \* \* .*test-renewal/);
});

test('the recommended certificate holds the name alone: no address in its names or its limits', { skip }, () => {
  const tls = join(scratch(), 'tls');
  const r = run('make', NAME, 'dir', tls);
  assert.equal(r.status, 0, r.out);
  const leaf = new X509Certificate(readFileSync(installedPaths(tls).cert));
  assert.equal(leaf.subjectAltName, `DNS:${NAME}`);
  const caText = openssl('x509', '-in', join(tls, 'ca.crt'), '-noout', '-ext', 'nameConstraints');
  assert.match(caText, /Name Constraints: critical\s+Permitted:\s+DNS:shelfready\.example\.com\s*$/);
  assert.doesNotMatch(caText, /IP:/);
});

test('a make that stops between installing the pair and writing ca.crt is found by status and fixed by the next make', { skip }, async () => {
  const tls = join(scratch(), 'tls');
  assert.equal(run('make', NAME, 'dir', tls).status, 0);
  const oldCa = readFileSync(join(tls, 'ca.crt'));
  const lines: string[] = [];
  await assert.rejects(
    make(tls, { names: [NAME], ips: [] }, MAX_DAYS, true, { afterInstall: () => { throw new Error('power cut'); }, log: (l) => lines.push(l) }),
    /power cut/,
  );
  // The new pair is live, but ca.crt is still the old store CA, and the new one was left aside.
  assert.deepEqual(readFileSync(join(tls, 'ca.crt')), oldCa);
  assert.equal(readdirSync(tls).filter((n) => /^ca\.crt\.new-/.test(n)).length, 1);
  const st = run('status', 'dir', tls);
  assert.equal(st.status, 1);
  assert.match(st.out, /FAIL the installed certificate was not signed by this store CA, so phones cannot be given the right one\. Run: node scripts\/net\/private-cert\.ts make shelfready\.example\.com replace/);
  const fixed = run('make', NAME, 'dir', tls, 'replace');
  assert.equal(fixed.status, 0, fixed.out);
  assert.equal(readdirSync(tls).filter((n) => /^ca\.crt\.new-/.test(n)).length, 0, 'the leftover is removed');
  assert.match(run('status', 'dir', tls).out, /OK {3}the installed certificate was signed by this store CA/);
});

test('work folders left by a run that could not clean up are removed: only ours, only stale, never through a link', { skip }, () => {
  const tag = randomBytes(2).toString('hex').slice(0, 3);
  const stale = join(RAM, `shelfready-ca-st${tag}1`);
  const fresh = join(RAM, `shelfready-ca-fr${tag}1`);
  const link = join(RAM, `shelfready-ca-ln${tag}1`);
  const target = privateDir(join(scratch(), 'elsewhere'));
  writeFileSync(join(target, 'keep.txt'), 'not ours to remove');
  try {
    mkdirSync(stale, { mode: 0o700 });
    writeFileSync(join(stale, 'ca.key'), 'stand-in for a key');
    const old = (Date.now() - 20 * 60_000) / 1000;
    utimesSync(stale, old, old);
    mkdirSync(fresh, { mode: 0o700 });
    symlinkSync(target, link);
    assert.equal(removeStaleRamFolders(), 1);
    assert.equal(statSync(stale, { throwIfNoEntry: false }), undefined, 'the stale folder is gone');
    assert.ok(statSync(fresh).isDirectory(), 'a folder a run may still be using stays');
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'not ours to remove', 'a link is never followed');
  } finally {
    for (const p of [stale, fresh, link]) rmSync(p, { recursive: true, force: true });
  }
});

test('Ctrl-C while the store CA key exists wipes it and installs nothing', { skip }, async () => {
  const tls = join(scratch(), 'tls');
  const env: NodeJS.ProcessEnv = { ...process.env, SHELFREADY_TEST_PAUSE_MS: '5000' };
  delete env.NODE_OPTIONS;
  // The pause holds the run while the CA key exists, so the interrupt always lands there.
  const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'net', 'private-cert.ts'), 'make', NAME, 'dir', tls], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const closed = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
  const keyFile = (): string | undefined => ramLeftovers().map((n) => join(RAM, n, 'ca.key')).find((p) => existsSync(p));
  for (let i = 0; i < 400 && !keyFile(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(keyFile(), 'the CA key exists in this test\'s own RAM folder');
  child.kill('SIGINT');
  assert.equal(await closed, 130);
  assert.match(out, /Stopped \(SIGINT\)\. The store CA key was wiped and nothing was installed\./);
  assert.deepEqual(ramLeftovers(), [], 'the work folder and the key are gone');
  assert.equal(statSync(join(tls, 'current'), { throwIfNoEntry: false }), undefined);
});

test('the settings page warns 30 days before the private certificate ends, and when it has ended', { skip }, () => {
  const tls = join(scratch(), 'tls');
  assert.equal(run('make', NAME, 'dir', tls).status, 0);
  const paths = installedPaths(tls);
  const net: NetworkView = { tls: true, port: 8443, host: '127.0.0.1', allowedHosts: [NAME], listenAddresses: ['10.0.0.5'], listening: ['10.0.0.5'], inUse: [], hstsMaxAgeSeconds: 300 };
  const leaf = new X509Certificate(readFileSync(paths.cert));
  const start = leaf.validFromDate.getTime();
  const end = leaf.validToDate.getTime();
  const at = (now: number): string => certificateSection(readCertStatus(paths.cert, paths.status, now), net).value;
  // A day after it starts: no warning at all.
  const early = at(start + DAY);
  assert.match(early, /This is the private store certificate/);
  assert.doesNotMatch(early, /role="alert"/);
  // Ten days before the end: the reminder, with the date.
  const late = at(end - 10 * DAY);
  assert.match(late, new RegExp(`The private store certificate ends on ${new Date(end).toISOString().slice(0, 10)}\\. Before then, make a new one and install its store CA on both phones`));
  assert.match(late, /\(9 days left\)|\(10 days left\)/);
  // A day after the end.
  const over = at(end + DAY);
  assert.match(over, /The private store certificate has run out\. Phones will refuse ShelfReady/);
  assert.match(over, /\(ended\)/);
  for (const html of [early, late, over]) assert.doesNotMatch(html, /renewal|Let&#39;s Encrypt/i);
});
