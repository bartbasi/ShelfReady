// Password hashing with scrypt from node:crypto.
// Stored form: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>. The parameters travel with
// the hash, so they can be raised later and old hashes still verify.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptParams } from '../server/config.ts';

const KEY_LEN = 64;
const SALT_LEN = 16;
/** Longest password accepted. Stops a huge input from tying up the CPU. */
export const MAX_PASSWORD_LENGTH = 256;

function scryptAsync(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const maxmem = 128 * params.N * params.r * 2 + 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N: params.N, r: params.r, p: params.p, maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string, params: ScryptParams): Promise<string> {
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('Password is too long.');
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time check. A malformed stored hash returns false, never throws. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Refuse absurd parameters from a tampered row rather than burn memory on them.
  if (!Number.isInteger(N) || N < 2 || N > 2 ** 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    return false;
  }
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length !== KEY_LEN || salt.length < SALT_LEN) return false;
  const actual = await scryptAsync(password, salt, { N, r, p });
  return timingSafeEqual(actual, expected);
}

/** Plain-language problem with a new password, or undefined if it is acceptable. */
export function passwordProblem(password: string, minLength: number, username?: string): string | undefined {
  if (password.length < minLength) return `Use at least ${minLength} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Do not put the username in the password.';
  if (/^(.)\1*$/.test(password)) return 'Do not repeat one character.';
  return undefined;
}
