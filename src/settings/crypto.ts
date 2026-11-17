// The master key and AES-256-GCM encryption for settings.
//
// The key file is JSON: { "version": 1, "current": "<key id>", "keys": { "<key id>": "<base64 key>" } }.
// It sits outside the repo and outside the data folder, mode 600, so a copy of the database or a
// backup of data/ does not hold what is needed to read the secrets. More than one key can be listed,
// so a later step can rotate keys: new values use "current", old ones still decrypt by their id.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface MasterKeys {
  currentId: string;
  keys: Map<string, Buffer>;
}

export interface Sealed {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

const NONCE_LEN = 12;
const KEY_LEN = 32;

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The real path of p, following symlinks in every folder that exists. The last parts may not exist yet. */
function realish(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

const uid = (): number | undefined => (typeof process.getuid === 'function' ? process.getuid() : undefined);

export interface MasterKeyOptions {
  /**
   * Whether a missing key file may be created. Pass false when the database already holds
   * encrypted settings: a new key could never read them, so stopping is the only safe answer.
   */
  allowCreate: boolean;
}

/**
 * Reads the master key file, or creates it (mode 600, folder mode 700) if it does not exist.
 * Refuses: a path inside any of forbiddenDirs (compared after resolving symlinks), a symlink,
 * anything but a regular file, a file or folder owned by another user, a file group or others
 * can read, a folder group or others can write. Checks are made on the open file descriptor and
 * the file is read from it, so the file cannot be swapped between check and read.
 * Never overwrites an existing file: doing so would lose every stored secret.
 */
export function loadOrCreateMasterKey(path: string, forbiddenDirs: readonly string[], opts: MasterKeyOptions = { allowCreate: true }): MasterKeys {
  // Resolve symlinks in the folders only. The file itself must not be a symlink: O_NOFOLLOW refuses it.
  const real = join(realish(dirname(path)), basename(path));
  for (const dir of forbiddenDirs) {
    if (isInside(real, realish(dir))) {
      throw new Error(`The master key path must be outside ${dir}. Set masterKeyPath to a folder like ~/.config/shelfready.`);
    }
  }
  const dir = dirname(real);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ds = statSync(dir);
  if (!ds.isDirectory()) throw new Error(`The folder for the master key, ${dir}, is not a folder.`);
  if (uid() !== undefined && ds.uid !== uid()) throw new Error(`The folder ${dir} belongs to another user. The master key must be in a folder you own.`);
  if ((ds.mode & 0o022) !== 0) throw new Error(`Other users can write to the folder ${dir}. Run: chmod 700 ${dir}`);

  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new Error(`The master key file at ${real} is a symbolic link. Use the real file.`);
    if (code !== 'ENOENT') throw new Error(`Cannot read the master key file at ${real}.`);
    if (!opts.allowCreate) {
      throw new Error(
        `There is no master key file at ${real}, but the database holds encrypted settings. ` +
          'Restore the key file from backup. A new key could not read those settings, so ShelfReady stopped.',
      );
    }
    const id = `k${randomBytes(6).toString('hex')}`;
    const body = JSON.stringify({ version: 1, current: id, keys: { [id]: randomBytes(KEY_LEN).toString('base64') } }) + '\n';
    // O_EXCL: fail rather than overwrite if another process created it first. It also refuses a symlink.
    const wfd = openSync(real, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(wfd, body);
      fsyncSync(wfd);
    } finally {
      closeSync(wfd);
    }
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`The master key at ${real} is not a regular file.`);
    if (uid() !== undefined && st.uid !== uid()) throw new Error(`The master key file at ${real} belongs to another user.`);
    if ((st.mode & 0o077) !== 0) throw new Error(`The master key file at ${real} can be read by other users. Run: chmod 600 ${real}`);
    text = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  path = real;
  let parsed: { version?: unknown; current?: unknown; keys?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new Error(`The master key file at ${path} is damaged. Restore it from backup. Do not delete it.`);
  }
  if (parsed.version !== 1 || typeof parsed.current !== 'string' || typeof parsed.keys !== 'object' || parsed.keys === null) {
    throw new Error(`The master key file at ${path} is damaged. Restore it from backup. Do not delete it.`);
  }
  const keys = new Map<string, Buffer>();
  for (const [id, v] of Object.entries(parsed.keys as Record<string, unknown>)) {
    const buf = typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.alloc(0);
    if (buf.length !== KEY_LEN) throw new Error(`The master key file at ${path} has a key of the wrong length.`);
    keys.set(id, buf);
  }
  if (!keys.has(parsed.current)) throw new Error(`The master key file at ${path} does not hold its current key.`);
  return { currentId: parsed.current, keys };
}

/**
 * A 32-byte key for one purpose, derived from the current master key with HKDF-SHA256.
 * Each purpose gets its own key, so none of them can decrypt settings.
 */
export function deriveKey(mk: MasterKeys, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', mk.keys.get(mk.currentId)!, Buffer.alloc(0), `shelfready ${purpose}`, 32));
}

/** Encrypts with a fresh random nonce. aad binds the value to its setting name. */
export function seal(mk: MasterKeys, plaintext: string, aad: string): Sealed {
  const key = mk.keys.get(mk.currentId)!;
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { keyId: mk.currentId, nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Decrypts and checks the tag. Throws if the value, nonce, tag, key id or name were changed. */
export function open(mk: MasterKeys, s: Sealed, aad: string): string {
  const key = mk.keys.get(s.keyId);
  if (!key) throw new Error('A setting was encrypted with a key that is not in the master key file.');
  if (s.nonce.length !== NONCE_LEN || s.tag.length !== 16) throw new Error('A stored setting is damaged.');
  const decipher = createDecipheriv('aes-256-gcm', key, s.nonce, { authTagLength: 16 });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(s.tag);
  try {
    return Buffer.concat([decipher.update(s.ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('A stored setting failed its integrity check. It may have been tampered with.');
  }
}
