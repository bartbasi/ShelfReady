// Creates a user from the command line. Use it once to make the first admin.
//
//   node scripts/admin/create-user.ts --username bart [--role admin|manager] [--name "Bart Basi"]
//
// The password is typed at the terminal and never shown. It is never read from arguments
// or the environment. Uses the same config as the server (SHELFREADY_CONFIG or config/local/server.json).

import { createUser, isRole, UserError } from '../../src/auth/users.ts';
import { SYSTEM_ACTOR } from '../../src/db/audit.ts';
import { openDatabase } from '../../src/db/db.ts';
import { loadConfig } from '../../src/server/config.ts';
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
  const role = argValue(args, '--role') ?? 'admin';
  if (!isRole(role)) throw new Error('--role must be admin or manager.');
  const displayName = argValue(args, '--name') ?? '';
  const password = await askNewPassword();
  const db = openDatabase(config.dbPath);
  try {
    const u = await createUser(
      db,
      { username, displayName, role, password },
      { scrypt: config.scrypt, minLength: config.passwordMinLength, actor: { ...SYSTEM_ACTOR, username: 'cli' } },
    );
    console.log(`Created ${u.role} ${u.username}.`);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof UserError || err instanceof Error ? err.message : 'Failed.');
  process.exit(1);
});
