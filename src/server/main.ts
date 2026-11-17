// Starts the ShelfReady server. Run: node src/server/main.ts
// Reads config/local/server.json, or the file named by SHELFREADY_CONFIG.
// On the store PC the service script starts it (scripts/net/service.sh, docs/INSTALL.md).

import { setPriority } from 'node:os';
import sharp from 'sharp';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { listenAll } from './listen.ts';

// Root would own every file it writes and could bind any port. ShelfReady runs as Bart.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('Do not run ShelfReady as root. Run it as the user who owns the ShelfReady folder.');
  process.exit(1);
}

// New files (database, WAL, master key, uploads) are private to this user.
process.umask(0o077);

const config = loadConfig();
// The store PC is shared with staff. Invoice work (photos, model calls) runs in this process, one
// job at a time, and photo resizing uses one thread. setPriority lowers only the main thread on
// Linux, so it is a fallback: the service script starts the whole process under nice and ionice.
try {
  setPriority(config.nice);
} catch {
  // Lowering priority can only fail on an unusual system, or when already lower. Carry on.
}
sharp.concurrency(1);
const app = await buildApp(config);

const stop = async (): Promise<void> => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
// SIGHUP: look for a renewed certificate now rather than at the next check. Only when not run
// from a terminal: there, SIGHUP means the terminal closed, and the server should stop as before.
if (!process.stdin.isTTY) {
  process.on('SIGHUP', () => {
    app.shelf.tlsReload();
  });
}

// This PC first (a failure here stops the start), then the store network and tailnet addresses,
// each tried again until it is up.
await listenAll(app);
// Background work that changes things outside this PC starts only once the server is up, so a
// start that fails never leaves a fish email half changed.
app.shelf.mailchimp.start();
