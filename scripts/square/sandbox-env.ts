// Reads the Square sandbox settings from ~/.config/shelfready/dev.env by key
// name and checks their shape, so a malformed or swapped value is refused
// before it can reach a header, the screen or a file. Errors name the key only.
import { devEnvValue as readEnvKey } from '../lib/dev-env.ts';

export const SANDBOX = 'https://connect.squareupsandbox.com';
export const SQUARE_VERSION = '2025-10-16';

export function sandboxSettings(): { token: string; locationId: string } {
  const token = readEnvKey('SQUARE_SANDBOX_ACCESS_TOKEN');
  // Square access tokens start with EAAA. Anything else (an Anthropic key on the
  // wrong line, say) is refused before it can be sent to Square.
  if (!/^EAAA[A-Za-z0-9_-]{16,196}$/.test(token)) {
    throw new Error('SQUARE_SANDBOX_ACCESS_TOKEN in dev.env does not look like a Square access token. Check that line.');
  }
  const locationId = readEnvKey('SQUARE_SANDBOX_LOCATION_ID');
  if (!/^[A-Za-z0-9]{8,32}$/.test(locationId) || locationId.startsWith('EAAA')) {
    throw new Error('SQUARE_SANDBOX_LOCATION_ID in dev.env does not look like a location id. Check that line.');
  }
  return { token, locationId };
}

/** fetch to the sandbox only. Redirects are refused, so nothing is resent elsewhere. */
export async function sandboxFetch(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const url = new URL(path, SANDBOX);
  if (url.origin !== SANDBOX) throw new Error('Refusing to call anything but the Square sandbox');
  const res = await fetch(url, {
    method,
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || json.errors?.length) {
    const errs = (json.errors ?? []).map((e: any) => `${e.code}: ${e.detail ?? ''}`).join('; ');
    throw new Error(`Square ${method} ${url.pathname} failed (HTTP ${res.status}) ${errs}`);
  }
  return json;
}
