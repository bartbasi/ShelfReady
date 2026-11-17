import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inTransaction, migrate, openDatabase, schemaVersion } from '../src/db/db.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { appendAudit, listAudit, SYSTEM_ACTOR } from '../src/db/audit.ts';
import { tempDir } from './server-helpers.ts';

test('migrations build a fresh database in WAL mode with private file permissions', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'fresh.sqlite3');
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const name of ['users', 'sessions', 'settings', 'audit_log', 'login_throttle', 'schema_migrations']) assert.ok(tables.includes(name), name);
  assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
  assert.equal(statSync(path).mode & 0o077, 0, 'the database file is not readable by others');
});

test('running migrations again does nothing', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'again.sqlite3');
  openDatabase(path).close();
  const db = openDatabase(path);
  t.after(() => db.close());
  migrate(db);
  const n = (db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n;
  assert.equal(n, MIGRATIONS.length);
});

test('a database newer than the code is refused', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'newer.sqlite3');
  openDatabase(path).close();
  const raw = new DatabaseSync(path);
  raw.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(MIGRATIONS.length + 1, 'future', 'x');
  raw.close();
  assert.throws(() => openDatabase(path), /newer than this code knows/);
});

test('a failed migration rolls back completely', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const bad = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'broken', sql: 'CREATE TABLE half (x INTEGER); THIS IS NOT SQL;' }];
  assert.throws(() => migrate(db, bad));
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
});

test('the audit log takes entries from later steps and refuses edits and deletes', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const id = appendAudit(db, { userId: null, username: 'manager1', ip: '10.0.0.5' }, {
    action: 'square.update_price',
    entityType: 'square_item',
    entityId: 'ITEM123',
    runId: 7,
    details: { from: '10.99', to: '11.99' },
  });
  appendAudit(db, SYSTEM_ACTOR, { action: 'scale.push', entityType: 'scale', entityId: 'FRONT' });
  const rows = listAudit(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].id, id);
  assert.equal(rows[1].run_id, 7);
  assert.match(rows[1].at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(JSON.parse(rows[1].details), { from: '10.99', to: '11.99' });
  assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x' WHERE id = ?").run(id), /append only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = ?').run(id), /append only/);
  assert.equal(listAudit(db, { action: 'scale.push' }).length, 1);
});

// A v2 that rebuilds users the way SQLite recommends: new table, copy, drop, rename.
// With foreign keys on, dropping users would cascade-delete sessions and try to null the
// audit log's user ids, which its triggers refuse.
const REBUILD_USERS = {
  version: MIGRATIONS.length + 1,
  name: 'test: rebuild users with a new column',
  sql: `
CREATE TABLE users_new (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('manager', 'admin')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT ''
) STRICT;
INSERT INTO users_new (id, username, display_name, role, password_hash, must_change_password, disabled, created_at, updated_at)
  SELECT id, username, display_name, role, password_hash, must_change_password, disabled, created_at, updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
`,
};

function seedV1(path: string): void {
  const db = openDatabase(path);
  db.prepare("INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES (1, 'bart', 'admin', 'x', 't', 't')").run();
  db.prepare("INSERT INTO sessions (id_hash, user_id, csrf_token, remember, auth_at, created_at, last_seen_at, expires_at) VALUES ('h', 1, 'c', 0, 1, 1, 1, 9)").run();
  appendAudit(db, { userId: 1, username: 'bart' }, { action: 'user.create' });
  db.close();
}

test('a v1 database holding data upgrades to v2 through a users rebuild, keeping every row', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'up.sqlite3');
  seedV1(path);
  const db = openDatabase(path, [...MIGRATIONS, REBUILD_USERS]);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), MIGRATIONS.length + 1);
  assert.equal((db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n, 1, 'sessions survived');
  assert.equal((db.prepare('SELECT user_id FROM audit_log').get() as { user_id: number }).user_id, 1, 'audit user ids survived');
  assert.equal((db.prepare("SELECT phone FROM users WHERE id = 1").get() as { phone: string }).phone, '');
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1, 'foreign keys are back on');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a migration that would break references is rolled back', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bad.sqlite3');
  seedV1(path);
  const breaks = { version: MIGRATIONS.length + 1, name: 'test: orphan sessions', sql: 'DELETE FROM users;' };
  assert.throws(() => openDatabase(path, [...MIGRATIONS, breaks]), /broken references/);
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n, 1, 'the user is still there');
});

test('transactions nest with savepoints', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const count = () => (db.prepare('SELECT count(*) AS n FROM login_throttle').get() as { n: number }).n;
  const add = (k: string) => db.prepare('INSERT INTO login_throttle (key, failures, last_failure_at, locked_until) VALUES (?, 1, 1, 0)').run(k);
  inTransaction(db, () => {
    add('outer');
    assert.throws(() =>
      inTransaction(db, () => {
        add('inner');
        throw new Error('inner fails');
      }),
    );
    inTransaction(db, () => add('inner2'));
  });
  assert.equal(count(), 2, 'the failed inner part rolled back alone');
  assert.throws(() =>
    inTransaction(db, () => {
      add('outer2');
      inTransaction(db, () => add('inner3'));
      throw new Error('outer fails');
    }),
  );
  assert.equal(count(), 2, 'an outer failure rolls back the inner part too');
  assert.equal(db.isTransaction, false);
});

test('v3 drops throttle rows keyed by typed names and wipes them from the file', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'v2.sqlite3');
  const v2 = new DatabaseSync(path);
  v2.exec('PRAGMA journal_mode = WAL');
  migrate(v2, MIGRATIONS.slice(0, 2));
  v2.prepare("INSERT INTO login_throttle (key, failures, last_failure_at, locked_until) VALUES ('user:typedsecretname', 3, 1, 0)").run();
  v2.close();
  const db = openDatabase(path);
  t.after(() => db.close());
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal((db.prepare('SELECT count(*) AS n FROM login_throttle').get() as { n: number }).n, 0);
  for (const f of [path, `${path}-wal`]) {
    if (existsSync(f)) assert.ok(!readFileSync(f).toString('latin1').includes('typedsecretname'), `${f} still holds the name`);
  }
});
