// Migration 12 on a database already at version 11: every row in model_spend, upload_attempts
// and runs is kept, and the new columns take their defaults. Invented rows only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase, schemaVersion } from '../src/db/db.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';

test('a version 11 database upgrades to 12 and keeps every row, with the right defaults', () => {
  const db = openDatabase(':memory:', MIGRATIONS.slice(0, 11));
  assert.equal(schemaVersion(db), 11);
  db.prepare("INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES (1, 'mgr', 'manager', 'x', 't', 't')").run();
  db.prepare("INSERT INTO runs (id, state, created_by, created_by_name, created_at, updated_at, read_status) VALUES (1, 'review', 1, 'mgr', 100, 100, 'ok')").run();
  db.prepare("INSERT INTO runs (id, state, created_by, created_by_name, created_at, updated_at) VALUES (2, 'failed', 1, 'mgr', 200, 200)").run();
  db.prepare("INSERT INTO model_spend (id, run_id, kind, state, usd, estimate, at, updated_at) VALUES (1, 1, 'read', 'booked', 0.05, 0, 100, 100)").run();
  db.prepare("INSERT INTO model_spend (id, run_id, kind, variation_id, state, usd, estimate, at, updated_at) VALUES (2, 1, 'copy', 'V1', 'reserved', 0.2, 1, 150, 150)").run();
  db.prepare("INSERT INTO model_spend (id, run_id, kind, state, usd, estimate, at, updated_at) VALUES (3, NULL, 'read', 'booked', 0.07, 0, 160, 160)").run();
  db.prepare('INSERT INTO upload_attempts (id, user_id, at) VALUES (1, 1, 100), (2, 1, 200)').run();
  const before = {
    runs: db.prepare('SELECT * FROM runs ORDER BY id').all(),
    spend: db.prepare('SELECT * FROM model_spend ORDER BY id').all(),
    attempts: db.prepare('SELECT * FROM upload_attempts ORDER BY id').all(),
  };

  migrate(db);
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.equal(MIGRATIONS.length, 13);

  // Runs: untouched.
  assert.deepEqual(db.prepare('SELECT * FROM runs ORDER BY id').all(), before.runs);
  // Spend: every row and value kept; the new columns say "a run's call" and "no old invoice".
  const spend = db.prepare('SELECT * FROM model_spend ORDER BY id').all() as Array<Record<string, unknown>>;
  assert.equal(spend.length, 3);
  for (const [i, row] of spend.entries()) {
    const { source, purchase_invoice_id, ...rest } = row;
    assert.deepEqual(rest, { ...(before.spend[i] as object) });
    assert.equal(source, 'run');
    assert.equal(purchase_invoice_id, null);
  }
  // Upload attempts: kept, all counted as invoice run attempts.
  const attempts = db.prepare('SELECT * FROM upload_attempts ORDER BY id').all() as Array<Record<string, unknown>>;
  assert.deepEqual(attempts.map(({ kind, ...rest }) => rest), before.attempts.map((a) => ({ ...(a as object) })));
  assert.deepEqual(attempts.map((a) => a.kind), ['run', 'run']);
  // The new tables exist and are empty; no run was recorded by the migration itself.
  for (const t of ['purchase_invoices', 'purchase_files', 'purchase_lines']) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, 0, t);
  // The new checks hold: a bad source or kind is refused.
  assert.throws(() => db.prepare("INSERT INTO model_spend (run_id, source, kind, state, usd, at, updated_at) VALUES (NULL, 'other', 'read', 'booked', 0, 1, 1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO upload_attempts (user_id, kind, at) VALUES (1, 'other', 1)").run(), /CHECK/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});
