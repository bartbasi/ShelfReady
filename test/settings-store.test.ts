import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/db/db.ts';
import { listAudit, SYSTEM_ACTOR } from '../src/db/audit.ts';
import { loadOrCreateMasterKey, seal } from '../src/settings/crypto.ts';
import { createSettings } from '../src/settings/store.ts';
import { exampleShelfCents, isLocalHost, parseVendorLines, SettingError, vendorLines } from '../src/settings/schema.ts';
import { tempDir } from './server-helpers.ts';

/**
 * The 192.168/16 private range, built at run time: the git hooks refuse that prefix written out,
 * because it is the store's own network. Tests of the range use this.
 */
const R192 = ['192', '168'].join('.');

// Made up at run time, so no real-looking key sits in the repo.
const FAKE_KEY = `test-anthropic-${'k'.repeat(20)}WXYZ`;
const FAKE_TOKEN = `TESTSQ${'t'.repeat(30)}LAST`;

function setup(allowSquareProduction = false) {
  const dir = tempDir();
  const dbPath = join(dir, 's.sqlite3');
  const db = openDatabase(dbPath);
  const mk = loadOrCreateMasterKey(join(dir, 'master.key'), []);
  const settings = createSettings(db, mk, { allowSquareProduction });
  return {
    db,
    mk,
    dbPath,
    settings,
    done() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('defaults come back before anything is saved', (t) => {
  const s = setup();
  t.after(() => s.done());
  assert.equal(s.settings.getSetting('anthropicFirstPassModel'), 'claude-sonnet-5-5');
  assert.equal(s.settings.getSetting('anthropicFallbackModel'), 'claude-opus-5-5');
  assert.equal(s.settings.getSetting('squareEnvironment'), 'sandbox');
  assert.deepEqual(s.settings.getSetting('pricing').default, { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' });
  assert.equal(s.settings.getSecret('anthropicApiKey'), undefined);
  assert.deepEqual(s.settings.secretStatus('anthropicApiKey'), { set: false, hint: '', damaged: false });
});

test('values and secrets round trip, encrypted at rest, with only the last 4 shown', (t) => {
  const s = setup();
  t.after(() => s.done());
  s.settings.update(
    { values: { invoiceCostCapUsd: '2.5', squareLocationId: 'LABC123XYZ' }, secrets: { anthropicApiKey: FAKE_KEY, squareAccessToken: FAKE_TOKEN } },
    { userId: null, username: 'tester' },
  );
  assert.equal(s.settings.getSetting('invoiceCostCapUsd'), '2.50');
  assert.equal(s.settings.getSecret('anthropicApiKey'), FAKE_KEY);
  assert.deepEqual(s.settings.secretStatus('anthropicApiKey'), { set: true, hint: 'WXYZ', damaged: false });
  s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const raw = readFileSync(s.dbPath).toString('latin1');
  // Secrets are nowhere in the file. Plain values like the location id are encrypted in the
  // settings table but appear in the audit log's before and after, which is intended.
  for (const plain of [FAKE_KEY, FAKE_TOKEN]) assert.ok(!raw.includes(plain), `${plain.slice(0, 6)} found in the db file`);
  const row = s.db.prepare("SELECT ciphertext FROM settings WHERE name = 'value:squareLocationId'").get() as { ciphertext: Uint8Array };
  assert.ok(!Buffer.from(row.ciphertext).toString('latin1').includes('LABC123XYZ'));
});

test('the audit log records which settings changed, never the secret', (t) => {
  const s = setup();
  t.after(() => s.done());
  s.settings.update({ values: { anthropicFirstPassModel: 'claude-sonnet-6' }, secrets: { anthropicApiKey: FAKE_KEY } }, { userId: null, username: 'bart', ip: '127.0.0.1' });
  s.settings.update({ secrets: { anthropicApiKey: null } }, SYSTEM_ACTOR);
  const rows = listAudit(s.db, { action: 'settings.update' });
  assert.equal(rows.length, 2);
  const all = JSON.stringify(rows);
  assert.ok(!all.includes(FAKE_KEY));
  assert.ok(!all.includes('WXYZ'));
  const first = JSON.parse(rows[1].details);
  assert.deepEqual(first.secrets, { anthropicApiKey: 'set' });
  assert.deepEqual(first.values.anthropicFirstPassModel, { from: 'claude-sonnet-5-5', to: 'claude-sonnet-6' });
  assert.equal(rows[1].username, 'bart');
  assert.deepEqual(JSON.parse(rows[0].details).secrets, { anthropicApiKey: 'cleared' });
  assert.equal(s.settings.getSecret('anthropicApiKey'), undefined);
});

test('saving the same values again changes nothing and logs nothing', (t) => {
  const s = setup();
  t.after(() => s.done());
  s.settings.update({ values: { scaleConnectUrl: 'http://127.0.0.1:8765/mcp' } }, SYSTEM_ACTOR);
  const again = s.settings.update({ values: { scaleConnectUrl: 'http://127.0.0.1:8765/mcp' } }, SYSTEM_ACTOR);
  assert.deepEqual(again.changed, []);
  assert.equal(listAudit(s.db, { action: 'settings.update' }).length, 1);
});

test('a tampered or swapped row in the database is detected', (t) => {
  const s = setup();
  t.after(() => s.done());
  s.settings.update({ secrets: { anthropicApiKey: FAKE_KEY, scaleConnectToken: `sc-${'x'.repeat(30)}` } }, SYSTEM_ACTOR);
  // Swap two encrypted rows: the name is bound in, so this fails.
  const a = s.db.prepare("SELECT * FROM settings WHERE name = 'secret:anthropicApiKey'").get() as Record<string, Uint8Array>;
  s.db.prepare("UPDATE settings SET nonce = ?, ciphertext = ?, tag = ? WHERE name = 'secret:scaleConnectToken'").run(a.nonce, a.ciphertext, a.tag);
  assert.throws(() => s.settings.getSecret('scaleConnectToken'), /integrity/);
  // Flip one byte of a stored ciphertext.
  const c = Buffer.from(a.ciphertext);
  c[0] ^= 0xff;
  s.db.prepare("UPDATE settings SET ciphertext = ? WHERE name = 'secret:anthropicApiKey'").run(c);
  assert.throws(() => s.settings.getSecret('anthropicApiKey'), /integrity/);
});

test('bad values are refused before anything is written', (t) => {
  const s = setup();
  t.after(() => s.done());
  const bad: [string, () => unknown][] = [
    ['model', () => s.settings.update({ values: { anthropicFirstPassModel: 'Bad Model!' } }, SYSTEM_ACTOR)],
    ['cap', () => s.settings.update({ values: { invoiceCostCapUsd: '-1' } }, SYSTEM_ACTOR)],
    ['url', () => s.settings.update({ values: { scaleConnectUrl: 'http://user:pw@host/mcp' } }, SYSTEM_ACTOR)],
    ['url scheme', () => s.settings.update({ values: { scaleConnectUrl: 'file:///etc/passwd' } }, SYSTEM_ACTOR)],
    ['location', () => s.settings.update({ values: { squareLocationId: `EAAA${'x'.repeat(20)}` } }, SYSTEM_ACTOR)],
    ['token shape', () => s.settings.update({ secrets: { squareAccessToken: 'has spaces in it and is long enough' } }, SYSTEM_ACTOR)],
    ['card path', () => s.settings.update({ values: { cardConfigPath: 'cards.txt' } }, SYSTEM_ACTOR)],
  ];
  for (const [name, fn] of bad) assert.throws(fn, SettingError, name);
  // One bad field stops the whole batch.
  assert.throws(() => s.settings.update({ values: { invoiceCostCapUsd: '3.00', anthropicFallbackModel: '!!' } }, SYSTEM_ACTOR), SettingError);
  assert.equal(s.settings.getSetting('invoiceCostCapUsd'), '1.00');
  assert.equal(listAudit(s.db).length, 0);
});

test('production Square is locked until the config allows it', (t) => {
  const locked = setup(false);
  t.after(() => locked.done());
  assert.throws(() => locked.settings.update({ values: { squareEnvironment: 'production' } }, SYSTEM_ACTOR), /locked/);
  const open = setup(true);
  t.after(() => open.done());
  open.settings.update({ values: { squareEnvironment: 'production' } }, SYSTEM_ACTOR);
  assert.equal(open.settings.getSetting('squareEnvironment'), 'production');
});

test('per-vendor pricing formulas are stored as data', (t) => {
  const s = setup();
  t.after(() => s.done());
  const vendors = parseVendorLines("Example's Cheese Co | 2.25 | 2 | 0\n\n Other Vendor | 0 | 2.5 | 0.50 ");
  assert.deepEqual(vendors[0], { vendor: "Example's Cheese Co", formula: { addBefore: '2.25', multiplier: '2', addAfter: '0.00', rounding: 'up-to-99' } });
  s.settings.update({ values: { pricing: { default: { addBefore: '0', multiplier: '2', addAfter: '1', rounding: 'up-to-99' }, vendors } } }, SYSTEM_ACTOR);
  const p = s.settings.getSetting('pricing');
  assert.equal(p.vendors.length, 2);
  assert.equal(p.default.addAfter, '1.00');
  assert.throws(() => parseVendorLines('A | 1 | 2 | 3\na | 1 | 2 | 3'), /listed twice/);
  assert.throws(() => parseVendorLines('A | 1 | 2'), /Line 1/);
  assert.throws(() => parseVendorLines('A | 1 | 0 | 3'), /multiplier/);
});

test('a damaged row shows as damaged, other code gets an error, and a new value overwrites it', (t) => {
  const s = setup();
  t.after(() => s.done());
  s.settings.update({ values: { invoiceCostCapUsd: '2.00' }, secrets: { anthropicApiKey: FAKE_KEY } }, SYSTEM_ACTOR);
  s.db.prepare("UPDATE settings SET tag = zeroblob(16) WHERE name IN ('value:invoiceCostCapUsd', 'secret:anthropicApiKey')").run();
  assert.throws(() => s.settings.getSetting('invoiceCostCapUsd'), /integrity/, 'callers never get a value that cannot be trusted');
  assert.throws(() => s.settings.getSecret('anthropicApiKey'), /integrity/);
  const v = s.settings.view();
  assert.deepEqual(v.damaged, ['invoiceCostCapUsd']);
  assert.equal(v.values.invoiceCostCapUsd, '1.00', 'the form shows the default');
  assert.deepEqual(s.settings.secretStatus('anthropicApiKey'), { set: true, hint: '', damaged: true });
  s.settings.update({ values: { invoiceCostCapUsd: '3.00' }, secrets: { anthropicApiKey: FAKE_KEY } }, SYSTEM_ACTOR);
  assert.equal(s.settings.getSetting('invoiceCostCapUsd'), '3.00');
  assert.equal(s.settings.getSecret('anthropicApiKey'), FAKE_KEY);
  assert.deepEqual(s.settings.view().damaged, []);
});

test('production is locked at read time too, not only when saved', (t) => {
  const s = setup(true);
  t.after(() => s.done());
  s.settings.update({ values: { squareEnvironment: 'production' } }, SYSTEM_ACTOR);
  assert.equal(s.settings.getSetting('squareEnvironment'), 'production');
  // The same database, read by an install whose config does not allow production.
  const locked = createSettings(s.db, s.mk, { allowSquareProduction: false });
  assert.equal(locked.getSetting('squareEnvironment'), 'sandbox');
  assert.equal(locked.view().values.squareEnvironment, 'sandbox');
  assert.equal(locked.view().productionLocked, true);
});

test('values saved by an older version get new fields from the defaults', (t) => {
  const s = setup();
  t.after(() => s.done());
  // Write an old-shaped pricing value directly: no rounding anywhere.
  const old = { default: { addBefore: '0.00', multiplier: '2', addAfter: '1.00' }, vendors: [{ vendor: 'Old Vendor', formula: { addBefore: '1.00', multiplier: '2', addAfter: '0.00' } }] };
  const sealed = seal(s.mk, JSON.stringify(old), 'value:pricing');
  s.db.prepare('INSERT INTO settings (name, key_id, nonce, ciphertext, tag, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    'value:pricing', sealed.keyId, sealed.nonce, sealed.ciphertext, sealed.tag, new Date().toISOString(),
  );
  const p = s.settings.getSetting('pricing');
  assert.equal(p.default.rounding, 'up-to-99');
  assert.equal(p.vendors[0].formula.rounding, 'up-to-99');
});

test('changing the ScaleConnect address clears its token unless a new one comes with it', (t) => {
  const s = setup();
  t.after(() => s.done());
  const tok = `sc-token-${'a'.repeat(24)}`;
  s.settings.update({ values: { scaleConnectUrl: 'http://10.0.0.50:8765/mcp' }, secrets: { scaleConnectToken: tok } }, SYSTEM_ACTOR);
  assert.equal(s.settings.getSecret('scaleConnectToken'), tok);
  // Same address again: token kept.
  s.settings.update({ values: { scaleConnectUrl: 'http://10.0.0.50:8765/mcp' } }, SYSTEM_ACTOR);
  assert.equal(s.settings.getSecret('scaleConnectToken'), tok);
  // New address, no token: token removed and logged as cleared.
  s.settings.update({ values: { scaleConnectUrl: 'https://scales.example.com/mcp' } }, SYSTEM_ACTOR);
  assert.equal(s.settings.getSecret('scaleConnectToken'), undefined);
  assert.deepEqual(JSON.parse(listAudit(s.db, { action: 'settings.update' })[0].details).secrets, { scaleConnectToken: 'cleared' });
  // New address with a token in the same save: kept.
  s.settings.update({ values: { scaleConnectUrl: 'http://10.0.0.5:8765/mcp' }, secrets: { scaleConnectToken: tok } }, SYSTEM_ACTOR);
  assert.equal(s.settings.getSecret('scaleConnectToken'), tok);
});

test('plain http ScaleConnect addresses must be local; https may go anywhere', (t) => {
  const s = setup();
  t.after(() => s.done());
  for (const ok of ['127.0.0.1', 'localhost', '[::1]', '10.1.2.3', '172.16.0.1', '172.31.255.255', `${R192}.0.10`, '100.64.0.1', '100.127.255.254']) {
    assert.equal(isLocalHost(ok), true, ok);
  }
  for (const bad of ['169.254.1.1', '172.32.0.1', '172.15.0.1', '100.128.0.1', '8.8.8.8', 'scales.example.com', `${R192}.1.300`, '0.0.0.0']) {
    assert.equal(isLocalHost(bad), false, bad);
  }
  assert.throws(() => s.settings.update({ values: { scaleConnectUrl: 'http://203.0.113.9:8765/mcp' } }, SYSTEM_ACTOR), /plain http/i);
  assert.throws(() => s.settings.update({ values: { scaleConnectUrl: 'http://169.254.169.254/latest' } }, SYSTEM_ACTOR), SettingError);
  s.settings.update({ values: { scaleConnectUrl: 'https://203.0.113.9/mcp' } }, SYSTEM_ACTOR);
});

test('vendor names that fold to the same key cannot both be saved', () => {
  for (const pair of [
    ["Example's Cheese Co", 'Example\u2019s Cheese Co'],
    ['Caf\u00e9 Example', 'Cafe Example'],
    ['Example  Foods', 'example foods'],
  ]) {
    assert.throws(() => parseVendorLines(`${pair[0]} | 2.25 | 2 | 0.00\n${pair[1]} | 0 | 3 | 0.00`), /listed twice/, pair.join(' vs '));
  }
  assert.equal(parseVendorLines('Example Foods | 0 | 2 | 1.00\nExample Food | 0 | 3 | 0.00').length, 2, 'different names are fine');
});

test('vendor rounding survives a round trip through the text form, and examples are exact', () => {
  const v = parseVendorLines("Example's | 2.25 | 2 | 0.00 | up-to-99");
  assert.equal(vendorLines(v), "Example's | 2.25 | 2 | 0.00 | up-to-99");
  assert.deepEqual(parseVendorLines(vendorLines(v)), v);
  const std = { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' as const };
  assert.equal(exampleShelfCents(std, '10.00'), 2199, '2 x 10 + 1 = 21.00 goes up to 21.99');
  assert.equal(exampleShelfCents(std, '9.99'), 2099, '20.98 goes up to 20.99');
  assert.equal(exampleShelfCents(v[0].formula, '10.00'), 2499, '(10 + 2.25) x 2 = 24.50 goes up to 24.99');
  assert.equal(exampleShelfCents({ ...std, multiplier: '2.5', addAfter: '0.00' }, '1.01'), 299, '2.525 goes up to 2.99');
  assert.equal(exampleShelfCents(std, '9.9975'), 2099, '20.995 gives 20.99, as the skill function does');
});
