// Connection details for the dev harness in scripts/dev-scaleconnect/. Development only.
// The file holds the dev token and is mode 600 in data/dev-scaleconnect/, which git ignores.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ScaleConnectClientOptions } from './client.ts';

export const DEV_CONNECTION_FILE = fileURLToPath(
  new URL('../../data/dev-scaleconnect/connection.json', import.meta.url),
);

/** The only address the dev harness uses. Anything else could be the live ScaleConnect server. */
export const DEV_MCP_URL = 'http://127.0.0.1:18765/mcp';

/** A catalog item only the dev harness seeds. Check it before any preview. */
export const DEV_SENTINEL = { plu: '8999', description: 'SHELFREADY DEV HARNESS ONLY' } as const;

export interface DevConnection extends ScaleConnectClientOptions {
  scales: Record<string, { port: number; serial: string }>;
}

/**
 * The dev harness's URL and token, or undefined when the harness is not running.
 * Throws if the file names any address but the dev one. Error messages never quote the file,
 * because it holds the token.
 */
export async function readDevConnection(file = DEV_CONNECTION_FILE): Promise<DevConnection | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let raw: { url?: unknown; token?: unknown; scales?: unknown };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new Error(`The dev connection file at ${file} is not valid JSON. Restart the dev harness.`);
  }
  if (typeof raw.url !== 'string' || typeof raw.token !== 'string' || raw.token.length < 20) {
    throw new Error(`The dev connection file at ${file} has no usable url or token. Restart the dev harness.`);
  }
  if (raw.url !== DEV_MCP_URL) {
    throw new Error(`The dev connection file names an address other than ${DEV_MCP_URL}. Refusing to use it.`);
  }
  return { url: raw.url, token: raw.token, scales: (raw.scales ?? {}) as DevConnection['scales'] };
}
