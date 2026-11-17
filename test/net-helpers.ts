// Test certificates made with openssl in a temp folder. Nothing here is ever committed: a private
// key in the repo is refused by the pre-commit hook, so every test makes its own.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export function opensslMissing(): string | false {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return false;
  } catch {
    return 'openssl is not installed';
  }
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'ignore' });
}

/** A private folder (mode 700) for certificates. */
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

/** A self-signed certificate for the names, as fullchain.pem and key.pem (both mode 600) in dir. */
export function selfSigned(dir: string, names: string[], days = 90): { cert: string; key: string } {
  privateDir(dir);
  openssl(
    ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'key.pem', '-out', 'fullchain.pem', '-days', String(days), '-subj', `/CN=${names[0]}`, '-addext', `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}`],
    dir,
  );
  chmodSync(join(dir, 'key.pem'), 0o600);
  chmodSync(join(dir, 'fullchain.pem'), 0o600);
  return { cert: join(dir, 'fullchain.pem'), key: join(dir, 'key.pem') };
}

/**
 * A two-certificate chain like Let's Encrypt's: a leaf for the names, issued by a test issuer.
 * With staging, the issuer's names say (STAGING) as Let's Encrypt's staging ones do.
 */
export function issuedChain(dir: string, names: string[], o: { staging: boolean; days?: number }): { fullchain: Buffer; key: Buffer } {
  privateDir(dir);
  const org = o.staging ? "(STAGING) Let's Encrypt" : "Let's Encrypt";
  const cn = o.staging ? '(STAGING) Test Issuer E9' : 'Test Issuer E9';
  openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '3650', '-subj', `/C=US/O=${org}/CN=${cn}`], dir);
  openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', `/CN=${names[0]}`], dir);
  writeFileSync(join(dir, 'ext.cnf'), `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}\n`);
  openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', String(o.days ?? 90), '-out', 'leaf.pem', '-extfile', 'ext.cnf'], dir);
  const fullchain = Buffer.concat([readFileSync(join(dir, 'leaf.pem')), readFileSync(join(dir, 'ca.pem'))]);
  return { fullchain, key: readFileSync(join(dir, 'leaf.key')) };
}

/** A TCP port free right now on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}
