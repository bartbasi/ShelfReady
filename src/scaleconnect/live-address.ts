// Checks before the ScaleConnect token goes to a live address on this PC. Moved here from
// scripts/runs/front-test.ts (step 10), where they were proven, so the app's own live connection
// (src/scaleconnect/connection.ts) uses the same ones.
//
// The address names this PC, but not the program on it. While ScaleConnect is stopped or
// restarting, another user on this PC could listen on its port and get the token. So the live
// address must be one of this PC's, and before the token goes there, /proc/net/tcp must show a
// listener on it owned by our own user. Linux only; any user may read those files.

import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

/** This PC's own IPv4 addresses, from its network interfaces. */
export function localIPv4(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => a !== undefined && (a.family === 'IPv4' || (a.family as unknown) === 4))
    .map((a) => a.address);
}

/** /proc/net/tcp and tcp6, which any user may read. A missing file reads as empty. */
export function readProcNet(): { tcp: string; tcp6: string } {
  const read = (p: string): string => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  return { tcp: read('/proc/net/tcp'), tcp6: read('/proc/net/tcp6') };
}

/** The address as /proc/net/tcp writes it: the four bytes in host order (little endian here), in hex. */
function procHex(ipv4: string): string {
  return ipv4
    .split('.')
    .map((b) => Number(b).toString(16).toUpperCase().padStart(2, '0'))
    .reverse()
    .join('');
}

/**
 * Why the listener on host:port may not get the token, or null. Reads LISTEN sockets (state 0A).
 * A listener on exactly that address, or a wildcard one on that port (0.0.0.0, or :: and its IPv4
 * mapped form in tcp6), must be owned by uid. Any such listener owned by another uid is a refusal,
 * and so is no listener at all.
 */
export function listenerProblem(tables: { tcp: string; tcp6: string }, host: string, port: number, uid: number): string | null {
  const portHex = port.toString(16).toUpperCase().padStart(4, '0');
  const exact4 = procHex(host);
  const mapped6 = `0000000000000000FFFF0000${exact4}`;
  const found: Array<{ uid: number; exact: boolean }> = [];
  for (const [text, v6] of [[tables.tcp, false], [tables.tcp6, true]] as const) {
    for (const row of text.split('\n').slice(1)) {
      const f = row.trim().split(/\s+/);
      if (f.length < 8 || f[3] !== '0A') continue;
      const [addr = '', p = ''] = (f[1] ?? '').toUpperCase().split(':');
      if (p !== portHex) continue;
      const exact = v6 ? addr === mapped6 : addr === exact4;
      const wild = v6 ? /^0{32}$/.test(addr) : addr === '00000000';
      if (exact || wild) found.push({ uid: Number(f[7]), exact });
    }
  }
  const where = `${host}:${port}`;
  if (!found.length) return `Nothing is listening on ${where}. ScaleConnect may be stopped or restarting, or the port is wrong.`;
  if (found.some((x) => x.uid !== uid)) return `The program listening on ${where} belongs to another user, not to you, so it may not be ScaleConnect. The token is not sent there.`;
  return null;
}

export interface ListenerCheckHooks {
  /** This PC's IPv4 addresses. Default: os.networkInterfaces(). */
  localAddresses?: () => string[];
  /** The /proc/net tables. Default: read them. */
  procNet?: () => { tcp: string; tcp6: string };
  /** Our own user id. Default: process.getuid(). */
  uid?: number;
}

/**
 * Why the token may not go to this live address now, or null. The address must be one of this
 * PC's own (or loopback), so the listener on it can be checked: an address on another machine is
 * refused, because nobody could say who is listening there. Then the listener must be ours.
 */
export function liveListenerProblem(url: string, hooks: ListenerCheckHooks = {}): string | null {
  const u = new URL(url);
  const host = u.hostname;
  const onThisPc = host.startsWith('127.') || (hooks.localAddresses ?? localIPv4)().includes(host);
  if (!onThisPc) return `The live ScaleConnect address ${host} is not an address of this PC, so ShelfReady cannot check who is listening there. The token is not sent.`;
  const uid = hooks.uid ?? process.getuid?.() ?? -1;
  return listenerProblem((hooks.procNet ?? readProcNet)(), host, Number(u.port || 80), uid);
}
