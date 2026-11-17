// Uploaded invoice files on disk. Each file gets a random 32-character name in the upload folder,
// written mode 600 in a mode 700 folder. The name a phone gave the file is kept only for display,
// cleaned and cut, and is never part of a path. Files are read back only by a stored name that
// matches the random-name pattern, so no path from a browser ever reaches the disk.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../invoice/redact.ts';

const NAME = /^[0-9a-f]{32}$/;

export function newStoredName(): string {
  return randomBytes(16).toString('hex');
}

export function storedPath(dir: string, storedName: string): string {
  if (!NAME.test(storedName)) throw new Error('bad stored file name');
  return join(dir, storedName);
}

/**
 * Makes the upload folder if needed, then checks it: a real folder, not a symlink, owned by this
 * user, with no access for group or others. Anything else is refused rather than used.
 */
export function ensureUploadDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new UploadDirError('The upload folder is not a plain folder. Check uploads.dir in the server config.');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new UploadDirError('The upload folder belongs to another user. Check uploads.dir in the server config.');
  if (st.mode & 0o077) throw new UploadDirError('Others can read the upload folder. Run: chmod 700 on it.');
}

/** The upload folder cannot be used safely. Safe to show. */
export class UploadDirError extends Error {}

/** Free bytes on the upload folder's disk. */
export function freeBytes(dir: string): number {
  const st = statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

/** Opens a new file for writing: it must not exist yet, and only this user can read it. */
export function openNewFile(dir: string, storedName: string): number {
  return openSync(storedPath(dir, storedName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}

export function removeStoredFile(dir: string, storedName: string): void {
  try {
    rmSync(storedPath(dir, storedName), { force: true });
  } catch {
    // Already gone.
  }
}

/** Reads a stored file through one descriptor, refusing anything but a plain file. */
export function readStoredFile(dir: string, storedName: string): Buffer {
  const fd = openSync(storedPath(dir, storedName), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a file');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A file name safe to show: one line of plain characters, at most 80 long. */
export function displayName(name: string, fallback: string): string {
  const clean = redactSecrets(String(name).slice(0, 400), 400)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return clean || fallback;
}
