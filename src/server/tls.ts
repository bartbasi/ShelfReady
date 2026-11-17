// TLS for the server: reading the certificate and key safely, the protocol and cipher settings,
// and picking up a renewed certificate without a restart.
//
// The key must be a regular file owned by this user that no one else can read, in a folder only
// this user can open, outside the repo and the data folder. Its bytes are never logged or shown.

import { createPrivateKey, X509Certificate } from 'node:crypto';
import { closeSync, constants as fsc, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { SecureContextOptions, TlsOptions } from 'node:tls';

/**
 * TLS 1.3, and for TLS 1.2 only forward-secret AEAD suites (ECDHE with AES-GCM or ChaCha20).
 * Names starting TLS_ are the TLS 1.3 suites; Node sets those apart from the rest.
 */
export const TLS_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');

export class TlsFileError extends Error {}

export interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  /** The server's own certificate, then the ones that issued it. */
  chain: X509Certificate[];
  /** Changes whenever either file changes. */
  signature: string;
}

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A short fingerprint of a file's identity and age, the same from stat and fstat. */
export function statSignature(st: Stats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
}

/**
 * Reads a small file through one descriptor, opened without following a link and without
 * blocking. It must be a regular file no larger than max. Returns the bytes and the fstat.
 */
export function readSmallFile(path: string, max: number): { bytes: Buffer; st: Stats } {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new TlsFileError(`There is no file at ${path}.`);
    if (code === 'ELOOP') throw new TlsFileError(`The file at ${path} is a symbolic link. Use the real file.`);
    throw new TlsFileError(`Cannot read the file at ${path}.`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new TlsFileError(`${path} is not a regular file.`);
    if (st.size < 1 || st.size > max) throw new TlsFileError(`The file at ${path} is empty or too large.`);
    const bytes = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, bytes, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    if (got !== st.size) throw new TlsFileError(`The file at ${path} changed while it was read.`);
    return { bytes, st };
  } finally {
    closeSync(fd);
  }
}

/** The PEM certificate blocks in a file, in order. */
export function pemCertificates(text: string): string[] {
  return text.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g) ?? [];
}

/** Parses a full chain file. Throws TlsFileError with plain words. */
export function parseChain(text: string, where: string): X509Certificate[] {
  const blocks = pemCertificates(text);
  if (blocks.length === 0 || blocks.length > 8) throw new TlsFileError(`The certificate file at ${where} holds no certificate in PEM form.`);
  try {
    return blocks.map((b) => new X509Certificate(b));
  } catch {
    throw new TlsFileError(`The certificate file at ${where} holds a damaged certificate.`);
  }
}

/** The signature of the two files now, or '' if either cannot be seen. Never follows a link. */
export function filesSignature(certPath: string, keyPath: string): string {
  try {
    return `${statSignature(lstatSync(certPath))}|${statSignature(lstatSync(keyPath))}`;
  } catch {
    return '';
  }
}

/**
 * Reads and checks the certificate and key. Every name in allowedHosts must be covered by the
 * certificate's subject alternative names. forbiddenDirs: the repo and the data folder.
 * Throws TlsFileError with plain words that never quote the key.
 */
export function loadTlsMaterial(paths: { certPath: string; keyPath: string }, allowedHosts: readonly string[], forbiddenDirs: readonly string[]): TlsMaterial {
  const keyDir = realOr(dirname(paths.keyPath));
  const keyReal = join(keyDir, basename(paths.keyPath));
  for (const dir of forbiddenDirs) {
    if (isInside(keyReal, realOr(dir))) throw new TlsFileError(`The TLS key must be outside ${dir}. Keep it in ~/.config/shelfready/tls.`);
  }
  let ds: Stats;
  try {
    ds = statSync(keyDir);
  } catch {
    throw new TlsFileError(`There is no folder ${keyDir} for the TLS key. Run the certificate setup in docs/INSTALL.md first.`);
  }
  if (!ds.isDirectory()) throw new TlsFileError(`${keyDir} is not a folder.`);
  if (uid() !== undefined && ds.uid !== uid()) throw new TlsFileError(`The folder ${keyDir} belongs to another user. The TLS key must be in a folder you own.`);
  if ((ds.mode & 0o077) !== 0) throw new TlsFileError(`Other users can open the folder ${keyDir}. Run: chmod 700 ${keyDir}`);

  const key = readSmallFile(keyReal, 16 * 1024);
  if (uid() !== undefined && key.st.uid !== uid()) throw new TlsFileError(`The TLS key at ${keyReal} belongs to another user.`);
  if ((key.st.mode & 0o077) !== 0) throw new TlsFileError(`The TLS key at ${keyReal} can be read by other users. Run: chmod 600 ${keyReal}`);

  const certReal = join(realOr(dirname(paths.certPath)), basename(paths.certPath));
  const cert = readSmallFile(certReal, 64 * 1024);
  if (uid() !== undefined && cert.st.uid !== uid()) throw new TlsFileError(`The certificate at ${certReal} belongs to another user.`);
  if ((cert.st.mode & 0o022) !== 0) throw new TlsFileError(`Other users can change the certificate at ${certReal}. Run: chmod 600 ${certReal}`);

  const chain = parseChain(cert.bytes.toString('latin1'), certReal);
  let privateKey;
  try {
    privateKey = createPrivateKey(key.bytes);
  } catch {
    throw new TlsFileError(`The file at ${keyReal} is not a private key in PEM form.`);
  }
  if (!chain[0].checkPrivateKey(privateKey)) throw new TlsFileError('The certificate and the key do not belong together.');
  for (let i = 0; i + 1 < chain.length; i++) {
    if (!chain[i].checkIssued(chain[i + 1]) || !chain[i].verify(chain[i + 1].publicKey)) {
      throw new TlsFileError(`The certificates in ${certReal} are not a chain in order: each must be issued by the next.`);
    }
  }
  for (const name of allowedHosts) {
    // An address must be among the certificate's IP names, a host name among its DNS names.
    const covered = isIP(name) ? chain[0].checkIP(name) : chain[0].checkHost(name, { subject: 'never' });
    if (!covered) throw new TlsFileError(`The certificate at ${certReal} does not cover ${name}.`);
  }
  return { cert: cert.bytes, key: key.bytes, chain, signature: `${statSignature(cert.st)}|${statSignature(key.st)}` };
}

/** Options for the TLS context: used when the server starts and again on each reload. */
export function secureContextOptions(m: TlsMaterial): SecureContextOptions {
  return { cert: m.cert, key: m.key, minVersion: 'TLSv1.2', ciphers: TLS_CIPHERS, honorCipherOrder: false };
}

/** Options for the TLS server itself. A handshake that takes too long is dropped. */
export function tlsServerOptions(m: TlsMaterial, handshakeTimeoutMs: number): TlsOptions {
  return { ...secureContextOptions(m), ALPNProtocols: ['http/1.1'], handshakeTimeout: handshakeTimeoutMs };
}

export type ReloadResult = 'unchanged' | 'reloaded' | 'failed';

export interface CertReloader {
  /** Looks at the files now and reloads them if they changed. */
  check(): ReloadResult;
  stop(): void;
  current(): TlsMaterial;
}

interface ReloadLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

const DAY_MS = 24 * 3600_000;

/**
 * Checks the certificate files every intervalMs, and when they change, loads and checks them and
 * hands them to apply (the server's setSecureContext). A pair that fails its checks, for example a
 * certificate and key caught halfway through being replaced, is not used: the old one stays, and
 * the next change is tried again. Also warns once a day when the certificate ends within 14 days.
 */
export function createCertReloader(o: {
  initial: TlsMaterial;
  load: () => TlsMaterial;
  apply: (m: TlsMaterial) => void;
  signature: () => string;
  log: ReloadLog;
  intervalMs: number;
  now: () => number;
}): CertReloader {
  let loaded = o.initial;
  let failedSignature = '';
  let lastExpiryWarning = 0;
  const describe = (m: TlsMaterial): object => ({ names: m.chain[0].subjectAltName ?? '', validTo: m.chain[0].validToDate.toISOString() });

  const warnIfEnding = (): void => {
    const left = loaded.chain[0].validToDate.getTime() - o.now();
    if (left < 14 * DAY_MS && o.now() - lastExpiryWarning > DAY_MS) {
      lastExpiryWarning = o.now();
      o.log.warn({ ...describe(loaded), daysLeft: Math.floor(left / DAY_MS) }, 'the certificate ends soon and has not been renewed');
    }
  };

  const check = (): ReloadResult => {
    const sig = o.signature();
    if (sig === '' || sig === loaded.signature || sig === failedSignature) {
      warnIfEnding();
      return 'unchanged';
    }
    try {
      const m = o.load();
      o.apply(m);
      loaded = m;
      failedSignature = '';
      o.log.info(describe(m), 'certificate reloaded');
      return 'reloaded';
    } catch (err) {
      // Files that changed while being read are tried again at the next check. Only a pair that
      // stayed the same and still failed is set aside until the files change again.
      if (o.signature() === sig) failedSignature = sig;
      o.log.error({ problem: err instanceof TlsFileError ? err.message : 'unexpected error' }, 'the new certificate was not used; the old one stays');
      return 'failed';
    } finally {
      warnIfEnding();
    }
  };

  const timer = setInterval(check, o.intervalMs);
  timer.unref();
  return { check, stop: () => clearInterval(timer), current: () => loaded };
}
