// Sets a new password for a user from the command line, for when the only admin is locked out.
//
//   node scripts/admin/reset-password.ts --username bart
//
// Also re-enables the account, ends all its sessions and lifts any sign-in lockout.
// The password is typed at the terminal.

import { dirname } from 'node:path';
import { clearUserLock, userKeyerFor } from '../../src/auth/throttle.ts';
import { findUserByUsername, setDisabled, setPassword } from '../../src/auth/users.ts';
import { SYSTEM_ACTOR } from '../../src/db/audit.ts';
import { openDatabase } from '../../src/db/db.ts';
import { loadOrCreateMasterKey } from '../../src/settings/crypto.ts';
import { loadConfig, REPO_ROOT } from '../../src/server/config.ts';
import { argValue, ask, askNewPassword, requireTerminal } from './prompt.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--password') || args.some((a) => a.startsWith('--password='))) {
    throw new Error('Passwords are never passed as arguments. Leave it out and type it when asked.');
  }
  requireTerminal();
  process.umask(0o077);
  const config = loadConfig();
  const username = argValue(args, '--username') ?? (await ask('Username: ', false));
  const db = openDatabase(config.dbPath);
  try {
    const u = findUserByUsername(db, username);
    if (!u) throw new Error('No such user.');
    // The lockout is keyed by an HMAC from the master key, so load it the way the server does.
    // A new key may be made only while no encrypted settings exist.
    const rows = (db.prepare('SELECT count(*) AS n FROM settings').get() as { n: number }).n;
    const keyer = userKeyerFor(loadOrCreateMasterKey(config.masterKeyPath, [REPO_ROOT, dirname(config.dbPath)], { allowCreate: rows === 0 }));
    const password = await askNewPassword();
    const actor = { ...SYSTEM_ACTOR, username: 'cli' };
    await setPassword(db, u.id, password, { scrypt: config.scrypt, minLength: config.passwordMinLength, actor, byAdmin: false });
    if (u.disabled) setDisabled(db, u.id, false, actor);
    // Lift any sign-in lockout on this username, so the new password works at once.
    clearUserLock(db, u.username, keyer);
    console.log(`New password set for ${u.username}. All their sessions ended and any sign-in lockout is lifted.`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'Failed.');
  process.exit(1);
});
