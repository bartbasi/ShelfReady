// Network rules that need no sockets: which addresses the server may listen on, which Host names it
// answers to, and how the sign-in throttle groups IPv6 addresses. Pure functions, so tests cover
// every case without opening a port.

import { isIPv4, isIPv6 } from 'node:net';

export type AddressKind = 'unspecified' | 'loopback' | 'private' | 'tailnet' | 'link-local' | 'multicast' | 'reserved' | 'public' | 'invalid';

/** The four parts of a dotted IPv4 address, or null. */
export function ipv4Parts(ip: string): number[] | null {
  if (!isIPv4(ip)) return null;
  return ip.split('.').map(Number);
}

/**
 * The eight 16-bit groups of an IPv6 address, or null. A zone (fe80::1%wlan0) must be removed
 * first. An IPv4 tail (::ffff:192.0.2.1) becomes the last two groups.
 */
export function ipv6Groups(ip: string): number[] | null {
  if (!isIPv6(ip) || ip.includes('%')) return null;
  let s = ip.toLowerCase();
  const tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (tail) {
    const o = ipv4Parts(tail[2]);
    if (!o) return null;
    s = `${tail[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  if (groups.length !== 8 || groups.some((n) => Number.isNaN(n))) return null;
  return groups;
}

/** The IPv4 address inside an IPv4-mapped IPv6 address (::ffff:a.b.c.d), or null. */
function mappedIpv4(g: number[]): string | null {
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return null;
}

function ipv4Kind(o: number[]): AddressKind {
  const [a, b] = o;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  // 100.64.0.0/10: carrier-grade NAT space, which Tailscale uses for tailnet addresses.
  if (a === 100 && b >= 64 && b <= 127) return 'tailnet';
  if (a === 169 && b === 254) return 'link-local';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

/** What kind of address this is. Host names are 'invalid': only literal addresses count. */
export function addressKind(ip: string): AddressKind {
  const v4 = ipv4Parts(ip);
  if (v4) return ipv4Kind(v4);
  const g = ipv6Groups(ip);
  if (!g) return 'invalid';
  const mapped = mappedIpv4(g);
  if (mapped) return ipv4Kind(ipv4Parts(mapped)!);
  if (g.every((n) => n === 0)) return 'unspecified';
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return 'loopback';
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';
  // fd7a:115c:a1e0::/48 is Tailscale's IPv6 range, inside the unique local range fc00::/7.
  if (g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0) return 'tailnet';
  if ((g[0] & 0xfe00) === 0xfc00) return 'private';
  return 'public';
}

/** Why an address may not be in listenAddresses, or null when it may. */
export function listenAddressProblem(ip: unknown): string | null {
  if (typeof ip !== 'string' || ip === '') return 'listenAddresses entries must be addresses written out, like 10.0.0.20.';
  const kind = addressKind(ip);
  switch (kind) {
    case 'private':
    case 'tailnet':
      return null;
    case 'unspecified':
      return `listenAddresses may not hold ${ip}: that listens on every network, the internet included. Name each address.`;
    case 'loopback':
      return `listenAddresses may not hold ${ip}: this PC is already covered by host.`;
    case 'invalid':
      return `listenAddresses entries must be addresses written out, not names or ranges: ${ip}`;
    case 'public':
      return `listenAddresses may hold only store network and tailnet addresses (10.x, 172.16 to 172.31, 192.168/16, Tailscale 100.64 to 100.127, or IPv6 fc00::/7), not ${ip}.`;
    default:
      return `listenAddresses may not hold the ${kind} address ${ip}.`;
  }
}

/** True for a host name made of letters, digits and hyphens, with at least one dot. Not an address. */
export function isDnsName(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 3 || s.length > 253) return false;
  const labels = s.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false;
  // A last label of only digits would make it look like an IPv4 address.
  return !/^[0-9]+$/.test(labels[labels.length - 1]);
}

/**
 * The name in a Host header, lowercased, without the port or a trailing dot. IPv6 literals keep
 * their brackets. Null for anything malformed, which is then refused.
 */
export function hostName(header: unknown): string | null {
  if (typeof header !== 'string' || header.length === 0 || header.length > 270) return null;
  const h = header.toLowerCase();
  let name: string;
  let rest: string;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    name = h.slice(0, end + 1);
    rest = h.slice(end + 1);
    if (!/^\[[0-9a-f:.]+\]$/.test(name)) return null;
  } else {
    const i = h.indexOf(':');
    name = i < 0 ? h : h.slice(0, i);
    rest = i < 0 ? '' : h.slice(i);
    if (!/^[a-z0-9.-]+$/.test(name)) return null;
  }
  if (rest !== '' && !/^:[0-9]{1,5}$/.test(rest)) return null;
  if (name.endsWith('.')) name = name.slice(0, -1);
  return name === '' ? null : name;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * True when the server should answer a request with this Host header. The configured names are
 * answered everywhere. The loopback names (localhost, 127.0.0.1, [::1]) are answered only on a
 * connection that arrived on a loopback address, so they serve this PC alone. Anything else is
 * refused, which stops DNS rebinding: a page on another name that points at this PC gets nothing.
 * The port is not compared. A connection that reached us already used our port; the name is what
 * rebinding changes. localAddress is undefined only for requests made in tests with inject.
 */
export function hostAllowed(header: unknown, localAddress: string | undefined, allowedHosts: readonly string[]): boolean {
  const name = hostName(header);
  if (name === null) return false;
  if (allowedHosts.includes(name)) return true;
  return LOOPBACK_NAMES.has(name) && (localAddress === undefined || addressKind(localAddress) === 'loopback');
}

/**
 * The address the sign-in throttle and the per-device connection cap count by. IPv4 as is. IPv6
 * by its /64, because one device can use many addresses in its /64. Tailscale's IPv6 addresses
 * (fd7a:115c:a1e0::/48) count one by one: Tailscale gives each device a single address, and
 * devices on a tailnet share a /64, so grouping them would let one device lock out the others.
 * An IPv4-mapped IPv6 address counts as its IPv4 address. A zone is dropped. Anything that is not
 * an address is kept as it was (cut to 64 characters).
 */
export function throttleAddress(ip: string): string {
  const bare = ip.replace(/%.*$/, '');
  if (isIPv4(bare)) return bare;
  const g = ipv6Groups(bare);
  if (!g) return ip.slice(0, 64);
  const mapped = mappedIpv4(g);
  if (mapped) return mapped;
  if (g[0] === 0xfd7a && g[1] === 0x115c && g[2] === 0xa1e0) return g.map((n) => n.toString(16)).join(':');
  return `${g
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(':')}::/64`;
}

/** An https origin for a host name and port, as a browser writes it in the Origin header. */
export function httpsOrigin(name: string, port: number): string {
  return port === 443 ? `https://${name}` : `https://${name}:${port}`;
}
