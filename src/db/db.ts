// Opens the SQLite database with node:sqlite and brings the schema up to date.

import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS, type Migration } from './migrations.ts';

export type Db = DatabaseSync;

/** Opens (or creates) the database file, sets WAL mode and runs pending migrations. */
export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const isNew = path !== ':memory:' && !existsSync(path);
  const db = new DatabaseSync(path);
  if (isNew) chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Deleted rows are overwritten with zeros, so pruned sign-in data does not linger on disk.
  db.exec('PRAGMA secure_delete = ON');
  migrate(db, migrations);
  return db;
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('SELECT max(version) AS v FROM schema_migrations').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * Runs pending migrations, each in its own transaction. Foreign keys are off while they run
 * (SQLite ignores that pragma inside a transaction, so it is set before BEGIN), every reference
 * is checked before COMMIT, and the previous setting is restored afterwards.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  if (db.isTransaction) throw new Error('migrate() must not run inside a transaction.');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  for (let i = 0; i < migrations.length; i++) {
    if (migrations[i].version !== i + 1) throw new Error('Migrations must be numbered 1, 2, 3 and so on with no gaps.');
  }
  const current = schemaVersion(db);
  const latest = migrations.length;
  if (current > latest) {
    throw new Error(`The database is at schema version ${current}, newer than this code knows (${latest}). Use a newer ShelfReady.`);
  }
  const pending = migrations.slice(current);
  if (pending.length === 0) return;
  const fkWasOn = (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
  let vacuum = false;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const m of pending) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(m.sql);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length > 0) {
          throw new Error(`Migration ${m.version} (${m.name}) would leave ${broken.length} broken references. Nothing was changed.`);
        }
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
        db.exec('COMMIT');
        if (m.vacuumAfter) vacuum = true;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys = ON');
  }
  if (vacuum) {
    // Outside any transaction. Then fold the WAL back in, so old page copies there go too.
    db.exec('VACUUM');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
}

let savepointSeq = 0;

/**
 * Runs fn inside a transaction, so checks and writes cannot interleave with another writer.
 * At the top level it uses BEGIN IMMEDIATE. Called inside another transaction it uses a
 * SAVEPOINT, so a failure rolls back only the inner part and the outer one can carry on.
 * fn must not await: node:sqlite is synchronous, and an await would let other work run mid-transaction.
 */
export function inTransaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const name = `sp_${++savepointSeq}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
