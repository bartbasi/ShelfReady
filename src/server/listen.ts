// Listening. Fastify listens on this PC (config.host). Each store network and tailnet address in
// config.listenAddresses gets a plain TCP listener that hands every connection to Fastify's own
// server, so one set of TLS settings, timeouts and connection tracking covers every address.
// An address that is not up yet (Wi-Fi or Tailscale still starting at boot) is tried again until
// it is, while the others serve. Never a wildcard: the config refuses 0.0.0.0 and ::.
//
// Node's server does not count connections handed to it this way, so this file keeps them: each
// device may hold only so many at once, and closing the app closes the ones left over. (The app
// itself counts requests in progress and waits for them before closing the database.)

import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { throttleAddress } from './network.ts';

interface ListenLog {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
}

/** Why an address is not listening: not up yet, or taken by another program (an alarm). */
export type ListenProblem = 'not-up' | 'in-use';

/** The extra listeners of one app. buildApp makes it, and drains it when the app closes. */
export class ExtraListeners {
  private servers = new Map<string, Server>();
  private timers = new Set<NodeJS.Timeout>();
  private problemsBy = new Map<string, ListenProblem>();
  private sockets = new Set<Socket>();
  private perDevice = new Map<string, number>();
  private warnedDevice = new Map<string, number>();
  private closed = false;

  /** The extra addresses listening now. */
  listening(): string[] {
    return [...this.servers.keys()];
  }

  /** The extra addresses that are not listening, and why. */
  problems(): Map<string, ListenProblem> {
    return new Map(this.problemsBy);
  }

  /** Connections handed in and not yet closed. */
  open(): number {
    return this.sockets.size;
  }

  /**
   * Listens on address and port, handing each connection to target (the app's server). On
   * failure tries again after each delay in turn, the last one repeating.
   */
  start(o: { address: string; port: number; target: Server; maxConnections: number; maxPerDevice: number; log: ListenLog; retryDelaysMs: readonly number[] }): void {
    const take = (socket: Socket): void => {
      // One phone, or one address in an IPv6 /64, may hold only maxPerDevice connections at once.
      const device = throttleAddress(socket.remoteAddress ?? '');
      const n = this.perDevice.get(device) ?? 0;
      if (n >= o.maxPerDevice) {
        socket.destroy();
        const last = this.warnedDevice.get(device) ?? 0;
        if (Date.now() - last > 60_000) {
          this.warnedDevice.set(device, Date.now());
          o.log.warn({ address: o.address, remoteAddress: device, limit: o.maxPerDevice }, 'refused a connection: that device already has the most allowed');
        }
        return;
      }
      this.perDevice.set(device, n + 1);
      this.sockets.add(socket);
      socket.once('close', () => {
        this.sockets.delete(socket);
        const left = (this.perDevice.get(device) ?? 1) - 1;
        if (left <= 0) this.perDevice.delete(device);
        else this.perDevice.set(device, left);
      });
      o.target.emit('connection', socket);
    };
    const attempt = (n: number): void => {
      if (this.closed) return;
      const srv = createServer({ noDelay: true }, take);
      srv.maxConnections = o.maxConnections;
      const onError = (err: NodeJS.ErrnoException): void => {
        if (this.closed) return;
        const delay = o.retryDelaysMs[Math.min(n, o.retryDelaysMs.length - 1)];
        const inUse = err.code === 'EADDRINUSE';
        this.problemsBy.set(o.address, inUse ? 'in-use' : 'not-up');
        if (n === 0 || n % 10 === 0) {
          const fields = { address: o.address, port: o.port, code: err.code ?? 'unknown', retrySeconds: delay / 1000 };
          // Another program on our address and port could be pretending to be ShelfReady.
          if (inUse) o.log.error(fields, 'another program is listening on this address and port; ShelfReady cannot use it until it stops');
          else o.log.warn(fields, 'cannot listen on this address yet; trying again');
        }
        const t = setTimeout(() => {
          this.timers.delete(t);
          attempt(n + 1);
        }, delay);
        t.unref();
        this.timers.add(t);
      };
      srv.once('error', onError);
      srv.listen({ host: o.address, port: o.port, exclusive: true }, () => {
        srv.off('error', onError);
        srv.on('error', (err: NodeJS.ErrnoException) => o.log.error({ address: o.address, code: err.code ?? 'unknown' }, 'listener error'));
        if (this.closed) {
          srv.close();
          return;
        }
        this.servers.set(o.address, srv);
        this.problemsBy.delete(o.address);
        o.log.info({ address: o.address, port: o.port }, 'listening');
      });
    };
    attempt(0);
  }

  /** Stops accepting on every extra address and stops retrying. */
  stopAccepting(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const srv of this.servers.values()) srv.close();
    this.servers.clear();
  }

  /** Closes every handed-in connection still open. The app calls it on close, once requests are done or the grace period is over. */
  closeAll(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }
}

/** Listens on this PC, then on every address in listenAddresses. Fails only if this PC's address fails. */
export async function listenAll(app: FastifyInstance, opts: { retryDelaysMs?: readonly number[] } = {}): Promise<void> {
  const { config, listeners } = app.shelf;
  await app.listen({ host: config.host, port: config.port });
  const port = (app.server.address() as AddressInfo).port;
  for (const address of config.listenAddresses) {
    listeners.start({
      address,
      port,
      target: app.server as unknown as Server,
      maxConnections: config.maxConnections,
      maxPerDevice: config.maxConnectionsPerDevice,
      log: app.log,
      retryDelaysMs: opts.retryDelaysMs ?? [5000, 15000, 30000, 60000],
    });
  }
}
