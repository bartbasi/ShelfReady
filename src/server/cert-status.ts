// What the admin settings page shows about the certificate: its names, who issued it, when it
// ends, when the daily check will renew it, and how the last renewal and renewal test went.
// Reads the installed certificate and the small status file that scripts/net/cert.ts writes in
// the certificate folder. Neither holds a secret. The private key is never read here.

import type { X509Certificate } from 'node:crypto';
import { parseChain, readSmallFile, TlsFileError } from './tls.ts';

export const STATUS_FILE = 'status.json';
/** The organization name scripts/net/private-cert.ts gives its store CA. Marks the private store certificate. */
export const PRIVATE_CA_ORG = 'ShelfReady private store CA';
const DAY_MS = 24 * 3600_000;

/** One line of the renewal record. message is fixed words from cert.ts, never a tool's output. */
export interface RenewalEntry {
  at: number;
  ok: boolean;
  /** What ran: issue, renew (a real renewal), check (the daily run found nothing due) or dry-run. */
  kind: 'issue' | 'renew' | 'check' | 'dry-run';
  ca: 'staging' | 'production' | '';
  message: string;
}

export interface RenewalRecord {
  /** The last daily run, whatever it did. */
  lastCheck?: RenewalEntry;
  /** The last time a certificate was asked for (issue or renewal), and how it went. */
  lastRenewal?: RenewalEntry;
  /** The last renewal test against the Let's Encrypt staging service. Nothing is installed. */
  lastDryRun?: RenewalEntry;
}

export interface CertStatus {
  /** Why there is nothing to show, in plain words. */
  problem?: string;
  names: string[];
  issuer: string;
  /** Issued by the Let's Encrypt staging (test) service. Browsers do not trust it. */
  staging: boolean;
  /**
   * The private store certificate (Phase 1), made by scripts/net/private-cert.ts. Phones trust it
   * once they have the store CA. It is not renewed: a new one is made by hand before it ends.
   */
  privateStore: boolean;
  validFrom?: number;
  validTo?: number;
  daysLeft?: number;
  /** When the daily check will renew it. */
  renewAt?: number;
  due: boolean;
  expired: boolean;
  record: RenewalRecord;
  recordProblem?: string;
  /** A certificate is installed but the daily check has not run for two days. */
  checkStale: boolean;
}

/** Renewal starts when a third of the certificate's life is left: day 60 of 90. */
export function renewAt(validFrom: number, validTo: number): number {
  return validTo - Math.floor((validTo - validFrom) / 3);
}

/** True for certificates from the Let's Encrypt staging service, whose names say (STAGING). */
export function isStagingIssuer(issuer: string): boolean {
  return /\(STAGING\)/i.test(issuer);
}

function clean(s: string, max: number): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, max);
}

/** The issuer's organization and name, like "Let's Encrypt (E7)". */
export function issuerLabel(x: X509Certificate): string {
  const parts = new Map<string, string>();
  for (const line of x.issuer.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) parts.set(line.slice(0, i), line.slice(i + 1));
  }
  const o = parts.get('O');
  const cn = parts.get('CN');
  return clean(o && cn ? `${o} (${cn})` : (o ?? cn ?? x.issuer), 120);
}

/** The DNS names a certificate covers. */
export function dnsNames(x: X509Certificate): string[] {
  return (x.subjectAltName ?? '')
    .split(', ')
    .filter((s) => /^DNS:[A-Za-z0-9.*-]+$/.test(s))
    .map((s) => s.slice(4).toLowerCase());
}

/** The DNS names, then the IPv4 addresses, a certificate covers. */
export function certNames(x: X509Certificate): string[] {
  const ips = (x.subjectAltName ?? '')
    .split(', ')
    .filter((s) => /^IP Address:[0-9.]+$/.test(s))
    .map((s) => s.slice('IP Address:'.length));
  return [...dnsNames(x), ...ips];
}

/** The issuer's organization name, or ''. */
function issuerOrg(x: X509Certificate): string {
  for (const line of x.issuer.split('\n')) if (line.startsWith('O=')) return line.slice(2);
  return '';
}

function entry(v: unknown): RenewalEntry | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const e = v as Record<string, unknown>;
  const at = typeof e.at === 'string' ? Date.parse(e.at) : NaN;
  if (!Number.isFinite(at) || typeof e.ok !== 'boolean' || typeof e.message !== 'string') return undefined;
  const kind = ['issue', 'renew', 'check', 'dry-run'].includes(e.kind as string) ? (e.kind as RenewalEntry['kind']) : undefined;
  if (!kind) return undefined;
  const ca = e.ca === 'staging' || e.ca === 'production' ? e.ca : '';
  return { at, ok: e.ok, kind, ca, message: clean(e.message, 200) };
}

/** Reads status.json. Throws on anything that is not the expected shape. Unknown fields are ignored. */
export function parseRenewalRecord(text: string): RenewalRecord {
  const v = JSON.parse(text) as Record<string, unknown>;
  if (typeof v !== 'object' || v === null || v.version !== 1) throw new Error('not a renewal record');
  const out: RenewalRecord = {};
  const lastCheck = entry(v.lastCheck);
  const lastRenewal = entry(v.lastRenewal);
  const lastDryRun = entry(v.lastDryRun);
  if (lastCheck) out.lastCheck = lastCheck;
  if (lastRenewal) out.lastRenewal = lastRenewal;
  if (lastDryRun) out.lastDryRun = lastDryRun;
  return out;
}

/** Everything the settings page shows, read fresh. statusPath: the renewal record. Never throws. */
export function readCertStatus(certPath: string, statusPath: string, now: number): CertStatus {
  const out: CertStatus = { names: [], issuer: '', staging: false, privateStore: false, due: false, expired: false, record: {}, checkStale: false };
  try {
    out.record = parseRenewalRecord(readSmallFile(statusPath, 16 * 1024).bytes.toString('utf8'));
  } catch (err) {
    // No record yet is normal before the first renewal run. A damaged one is worth saying.
    if (!(err instanceof TlsFileError && /^There is no file/.test(err.message))) out.recordProblem = 'The renewal record could not be read.';
  }
  let leaf: X509Certificate;
  try {
    leaf = parseChain(readSmallFile(certPath, 64 * 1024).bytes.toString('latin1'), certPath)[0];
  } catch (err) {
    out.problem = err instanceof TlsFileError && /^There is no file/.test(err.message) ? 'No certificate is installed yet.' : 'The certificate file could not be read.';
    return out;
  }
  out.names = certNames(leaf);
  out.issuer = issuerLabel(leaf);
  out.staging = isStagingIssuer(leaf.issuer);
  out.privateStore = issuerOrg(leaf) === PRIVATE_CA_ORG;
  out.validFrom = leaf.validFromDate.getTime();
  out.validTo = leaf.validToDate.getTime();
  out.daysLeft = Math.floor((out.validTo - now) / DAY_MS);
  out.expired = now >= out.validTo;
  // The private store certificate is never renewed by a job, so no renewal date and no daily check.
  if (out.privateStore) return out;
  out.renewAt = renewAt(out.validFrom, out.validTo);
  out.due = now >= out.renewAt;
  out.checkStale = !out.record.lastCheck || now - out.record.lastCheck.at > 2 * DAY_MS;
  return out;
}
