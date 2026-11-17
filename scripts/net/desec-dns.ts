// The deSEC side of the DNS-01 challenge. acme.sh calls this through ShelfReady's own hook
// (dns_shelfready, written by scripts/net/cert.ts) to add and remove the TXT record.
//
//   node scripts/net/desec-dns.ts add|rm <name> <value> <cert config file>
//
// The token is read here, from the token file, and sent only in the Authorization header from
// this process. So it is never on a command line, where other users on this PC could see it while
// it runs, and never in acme.sh's environment or settings. Only one name can be written: the
// _acme-challenge record of the challenge alias (or of the domain, without an alias).

import { CertError, loadCertConfig, readTokens, scriptEnvironmentProblem, testDesecApi } from './cert-lib.ts';
import { REPO_ROOT } from '../../src/server/config.ts';
import { riskyEnvironment } from '../../src/lib/risky-env.ts';

export const DESEC_API = 'https://desec.io/api/v1';

/**
 * The API base: deSEC itself. A test may point it at a fake deSEC on this PC, but only together
 * with the tests' fake token, so a real token always goes to deSEC.
 */
export function desecApi(env: NodeJS.ProcessEnv, token: string): string {
  return testDesecApi(env, token) ?? DESEC_API;
}

export interface DesecDeps {
  token: string;
  api: string;
  fetch: typeof fetch;
}

/** A deSEC answer worth stopping for, with words safe to print. */
function failed(what: string, status: number): CertError {
  if (status === 401 || status === 403) return new CertError(`deSEC refused the token while trying to ${what}. Check DESEC_TOKEN in the token file.`);
  if (status === 404) return new CertError(`deSEC has no such domain in this account while trying to ${what}.`);
  if (status === 429) return new CertError(`deSEC asked us to slow down while trying to ${what}. Try again in a few minutes.`);
  return new CertError(`deSEC answered with status ${status} while trying to ${what}.`);
}

async function call(d: DesecDeps, method: 'GET' | 'PUT', path: string, body?: unknown): Promise<Response> {
  // main() already refused any Node flag or preload. This holds for every caller.
  const risky = riskyEnvironment();
  if (risky) throw new CertError(`Not calling deSEC while ${risky === 'flag' ? 'a Node proxy or certificate flag' : risky} is set: the token must go straight to deSEC.`);
  try {
    return await d.fetch(`${d.api}${path}`, {
      method,
      headers: { Authorization: `Token ${d.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // A thrown fetch error could quote the request, so only fixed words leave here.
    throw new CertError('deSEC could not be reached.');
  }
}

/** The zone and the record name inside it. Refuses every name but the one this install may write. */
export function challengeTarget(fqdn: string, c: { domain: string; challengeAlias: string }): { zone: string; subname: string } {
  const name = fqdn.toLowerCase().replace(/\.$/, '');
  const base = c.challengeAlias || c.domain;
  if (name !== `_acme-challenge.${base}`) throw new CertError(`Refusing to write a DNS record for ${name.slice(0, 120)}: only _acme-challenge.${base} is allowed.`);
  return { zone: base, subname: '_acme-challenge' };
}

/** Without an alias the zone is the longest deSEC domain the name ends with. */
async function zoneFor(d: DesecDeps, target: { zone: string; subname: string }, aliased: boolean): Promise<{ zone: string; subname: string }> {
  if (aliased) return target;
  const res = await call(d, 'GET', '/domains/');
  if (!res.ok) throw failed('list the domains', res.status);
  const names = ((await res.json()) as { name?: unknown }[]).map((x) => String(x.name ?? '').toLowerCase());
  const zone = names.filter((n) => target.zone === n || target.zone.endsWith(`.${n}`)).sort((a, b) => b.length - a.length)[0];
  if (!zone) throw new CertError(`deSEC holds no domain for ${target.zone} in this account.`);
  const rest = target.zone === zone ? '' : target.zone.slice(0, -zone.length - 1);
  return { zone, subname: rest ? `${target.subname}.${rest}` : target.subname };
}

async function currentValues(d: DesecDeps, zone: string, subname: string): Promise<string[]> {
  const res = await call(d, 'GET', `/domains/${encodeURIComponent(zone)}/rrsets/${encodeURIComponent(subname)}/TXT/`);
  if (res.status === 404) return [];
  if (!res.ok) throw failed('read the TXT record', res.status);
  const records = ((await res.json()) as { records?: unknown }).records;
  return Array.isArray(records) ? records.filter((r): r is string => typeof r === 'string') : [];
}

async function putValues(d: DesecDeps, zone: string, subname: string, records: string[], what: string): Promise<void> {
  // deSEC's bulk PUT creates, replaces or (with no records) deletes the set. 3600 is deSEC's lowest TTL.
  const res = await call(d, 'PUT', `/domains/${encodeURIComponent(zone)}/rrsets/`, [{ subname, type: 'TXT', ttl: 3600, records }]);
  if (!res.ok) throw failed(what, res.status);
}

/** Adds one challenge value, keeping any already there (two can be wanted at once). */
export async function addTxt(d: DesecDeps, fqdn: string, value: string, c: { domain: string; challengeAlias: string }): Promise<string> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(value)) throw new CertError('The challenge value does not look like one from Let\'s Encrypt.');
  const t = await zoneFor(d, challengeTarget(fqdn, c), c.challengeAlias !== '');
  const quoted = `"${value}"`;
  const have = await currentValues(d, t.zone, t.subname);
  if (!have.includes(quoted)) await putValues(d, t.zone, t.subname, [...have, quoted], 'add the TXT record');
  return `Added the TXT record ${t.subname}.${t.zone} at deSEC.`;
}

/** Removes one challenge value. The record goes when no value is left. */
export async function removeTxt(d: DesecDeps, fqdn: string, value: string, c: { domain: string; challengeAlias: string }): Promise<string> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(value)) throw new CertError('The challenge value does not look like one from Let\'s Encrypt.');
  const t = await zoneFor(d, challengeTarget(fqdn, c), c.challengeAlias !== '');
  const quoted = `"${value}"`;
  const have = await currentValues(d, t.zone, t.subname);
  if (have.includes(quoted)) await putValues(d, t.zone, t.subname, have.filter((v) => v !== quoted), 'remove the TXT record');
  return `Removed the TXT record ${t.subname}.${t.zone} at deSEC.`;
}

async function main(argv: string[]): Promise<number> {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    console.log('Do not run this as root.');
    return 2;
  }
  const problem = scriptEnvironmentProblem();
  if (problem) {
    console.log(`deSEC: not running while ${problem} is set. The token must stay in this process.`);
    return 2;
  }
  const [action, fqdn, value, configPath] = argv;
  if (!['add', 'rm'].includes(action) || !fqdn || !value || !configPath || argv.length !== 4) {
    console.log('Usage: node scripts/net/desec-dns.ts add|rm <name> <value> <cert config file>');
    return 2;
  }
  try {
    const c = loadCertConfig(configPath, REPO_ROOT);
    if (c.dnsProvider !== 'desec') throw new CertError('The certificate config does not use deSEC.');
    const token = readTokens(c).DEDYN_TOKEN;
    const d: DesecDeps = { token, api: desecApi(process.env, token), fetch };
    console.log(action === 'add' ? await addTxt(d, fqdn, value, c) : await removeTxt(d, fqdn, value, c));
    return 0;
  } catch (err) {
    console.log(`deSEC: ${err instanceof CertError ? err.message : `an unexpected error (${err instanceof Error ? err.name : 'unknown'}).`}`);
    return 1;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
