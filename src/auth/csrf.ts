// CSRF defence in three layers: SameSite=Strict cookies, an Origin or Referer check on
// every state-changing request, and a per-session token in every form.

import { timingSafeEqual } from 'node:crypto';

/** True if the request's Origin, or failing that its Referer, is one of the allowed origins. */
export function originAllowed(headers: Record<string, string | string[] | undefined>, allowed: readonly string[]): boolean {
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    return allowed.includes(origin);
  }
  const referer = headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try {
      return allowed.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  // A browser always sends one of the two on a form post. Neither means it is not our form.
  return false;
}

export function tokensEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length === 0 || b.length === 0) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
