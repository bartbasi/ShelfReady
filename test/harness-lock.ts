// One test at a time on the dev ScaleConnect harness. The test runner runs files in parallel, and
// the harness's fake scales are shared: one test unplugging KITCHEN must not meet another test
// plugging it back. A directory made with mkdir is the lock (mkdir is atomic); it holds the
// owner's pid, so a lock left by a test process that died is taken over.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK = join(tmpdir(), `shelfready-dev-harness-${process.getuid?.() ?? 'user'}.lock`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function withHarnessLock<T>(fn: () => Promise<T>, waitMs = 10 * 60_000): Promise<T> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(LOCK, { mode: 0o700 });
      writeFileSync(join(LOCK, 'pid'), String(process.pid));
      break;
    } catch {
      let owner = 0;
      try {
        owner = Number(readFileSync(join(LOCK, 'pid'), 'utf8'));
      } catch {
        owner = 0;
      }
      if (owner > 0 && owner !== process.pid && !alive(owner)) rmSync(LOCK, { recursive: true, force: true });
      if (Date.now() > until) throw new Error('Another test held the dev harness for too long.');
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
