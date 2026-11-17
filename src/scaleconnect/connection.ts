// How the app reaches ScaleConnect when it sends a run. The address and token come from the admin
// settings; this module decides whether that address may be used at all.
//
// - allowLiveScaleConnect off (the default): the only address allowed is the dev harness on this
//   PC (DEV_MCP_URL), and before any call that reads or writes a scale the harness's sentinel item
//   must be in the catalog, which proves it is the dev catalog.
// - allowLiveScaleConnect on: the only address allowed is the server config's liveScaleConnectUrl,
//   and the address in settings must be exactly that. When it is an address of this PC, the
//   listener on it must belong to our own user (src/scaleconnect/live-address.ts), so the token
//   never goes to another program that took ScaleConnect's port.
//
// The token is never logged and never put in an error message.

import { riskyEnvironment } from '../lib/risky-env.ts';
import { ScaleConnectClient, ScaleConnectError } from './client.ts';
import { DEV_MCP_URL, DEV_SENTINEL } from './dev-connection.ts';
import { liveListenerProblem, type ListenerCheckHooks } from './live-address.ts';

/** What the send code uses of the client. Tests pass a fake with the same shape. */
export type ScaleApi = Pick<
  ScaleConnectClient,
  'close' | 'listScales' | 'getItem' | 'previewChanges' | 'previewSettleDrift' | 'compareScale' | 'applyChanges' | 'getChange'
>;

export interface ScaleConnectionOptions {
  url: string;
  token: string | undefined;
  /** From the server config. False: only the dev harness may be used. */
  allowLive: boolean;
  /** From the server config (liveScaleConnectUrl): the only address allowed when allowLive. */
  liveUrl?: string;
  clientName?: string;
  /** Tests: stand-ins for this PC's addresses and listeners. */
  listenerHooks?: ListenerCheckHooks;
}

/** Why this address may not be used, or null when it may. Words safe to show. */
export function scaleAddressProblem(url: string, allowLive: boolean, liveUrl = ''): string | null {
  if (!url) return 'No ScaleConnect address is set. An admin must set it in settings.';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'The ScaleConnect address in settings is not a web address.';
  }
  if (!allowLive) {
    if (u.href !== DEV_MCP_URL) return `ShelfReady sends only to the dev ScaleConnect on this PC (${DEV_MCP_URL}) until live scales are approved. The address in settings is refused.`;
    return null;
  }
  let live: URL;
  try {
    live = new URL(liveUrl);
  } catch {
    return 'Live scales are on, but the server config names no live ScaleConnect address (liveScaleConnectUrl). Nothing was sent.';
  }
  if (u.href !== live.href) return `The ScaleConnect address in settings is not the live address in the server config (${live.href}). It is refused. Set it to that address.`;
  return null;
}

/**
 * Why the scales cannot be reached at all, checked without contacting anything, or null. Run
 * before the first Square write, so a bad setting, a missing token, or ScaleConnect not listening
 * (for live, /proc/net only) cannot leave Square changed and the scales not.
 */
export function scalePreflightProblem(o: { url: () => string; token: () => string | undefined; allowLive: boolean; liveUrl: string; listenerHooks?: ListenerCheckHooks }): string | null {
  const url = o.url();
  const problem = scaleAddressProblem(url, o.allowLive, o.liveUrl);
  if (problem) return problem;
  if (o.allowLive) {
    const owner = liveListenerProblem(url, o.listenerHooks);
    if (owner) return owner;
  }
  let token: string | undefined;
  try {
    token = o.token();
  } catch {
    return 'The ScaleConnect token in settings is damaged. An admin must enter it again.';
  }
  return token && token.length >= 20 ? null : 'No usable ScaleConnect token is set. An admin must set it in settings.';
}

/**
 * A connected client, after the address and, for the dev harness, the sentinel check. The caller
 * closes it. Throws ScaleConnectError with words safe to show.
 */
export async function connectScaleConnect(o: ScaleConnectionOptions): Promise<ScaleApi> {
  const problem = scaleAddressProblem(o.url, o.allowLive, o.liveUrl);
  if (problem) throw new ScaleConnectError(problem);
  if (!o.token) throw new ScaleConnectError('No ScaleConnect token is set. An admin must set it in settings.');
  if (o.allowLive) {
    // Checked just before connecting, every time: ScaleConnect may have stopped since.
    const owner = liveListenerProblem(o.url, o.listenerHooks);
    if (owner) throw new ScaleConnectError(`${owner} Nothing was sent.`);
  }
  // No proxy, certificate or key log overrides: the token must go straight to ScaleConnect.
  const risky = riskyEnvironment();
  if (risky) {
    throw new ScaleConnectError(`ShelfReady will not call ScaleConnect while ${risky === 'flag' ? 'Node runs with a proxy or certificate flag' : `${risky} is set`}. The token must go straight to ScaleConnect.`);
  }
  const client = new ScaleConnectClient({ url: o.url, token: o.token, clientName: o.clientName ?? 'shelfready' });
  await client.connect();
  if (new URL(o.url).href === DEV_MCP_URL) {
    // The dev harness seeds a sentinel item no store catalog has. Without it, stop before anything
    // reads or writes a scale. getItem contacts no scale.
    let ok = false;
    try {
      const found = await client.getItem({ plu: DEV_SENTINEL.plu });
      ok = (found.data.item as { description?: unknown } | undefined)?.description === DEV_SENTINEL.description;
    } catch {
      ok = false;
    }
    if (!ok) {
      await client.close();
      throw new ScaleConnectError('The ScaleConnect on the dev address does not hold the dev harness catalog. Nothing was read or sent.');
    }
  }
  return client;
}
