// Reads development secrets from ~/.config/shelfready/dev.env by key name.
// Refuses the file unless only its owner can read it. Errors name the key,
// never a value. Callers check each value's shape before using it.
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEV_ENV = join(homedir(), '.config/shelfready/dev.env');

/** Checks and reads the file through one descriptor, so it cannot be swapped in between. */
function readDevEnvText(): string {
  const fd = openSync(DEV_ENV, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error('~/.config/shelfready/dev.env is not a regular file.');
    if (st.mode & 0o077) throw new Error('~/.config/shelfready/dev.env must be mode 600. Run: chmod 600 ~/.config/shelfready/dev.env');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error('~/.config/shelfready/dev.env must be owned by you.');
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** The value for `key`, with only file formatting removed (CR, edge spaces, surrounding quotes). */
export function devEnvValue(key: string): string {
  for (const line of readDevEnvText().split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === key) {
      const v = line.slice(i + 1).replace(/\r$/, '').replace(/^[ \t]+|[ \t]+$/g, '').replace(/^["']|["']$/g, '');
      if (v) return v;
    }
  }
  throw new Error(`${key} is not set in ~/.config/shelfready/dev.env`);
}

/** Like devEnvValue, but an empty string when the key is missing. */
export function devEnvValueOrEmpty(key: string): string {
  try {
    return devEnvValue(key);
  } catch (e) {
    if (e instanceof Error && e.message.endsWith('is not set in ~/.config/shelfready/dev.env')) return '';
    throw e;
  }
}
