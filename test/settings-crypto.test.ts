import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadOrCreateMasterKey, open, seal } from '../src/settings/crypto.ts';
import { tempDir } from './server-helpers.ts';

test('the master key is created mode 600 in a mode 700 folder and reloads the same', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'conf', 'master.key');
  const a = loadOrCreateMasterKey(path, []);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'conf')).mode & 0o777, 0o700);
  const b = loadOrCreateMasterKey(path, []);
  assert.equal(a.currentId, b.currentId);
  assert.ok(a.keys.get(a.currentId)!.equals(b.keys.get(b.currentId)!));
  assert.equal(a.keys.get(a.currentId)!.length, 32);
});

test('a key file other users can read is refused', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'master.key');
  loadOrCreateMasterKey(path, []);
  chmodSync(path, 0o640);
  assert.throws(() => loadOrCreateMasterKey(path, []), /chmod 600/);
});

test('a key path inside the repo or the data folder is refused', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadOrCreateMasterKey(join(dir, 'data', 'master.key'), [join(dir, 'data')]), /must be outside/);
});

test('a damaged key file is never replaced', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'k'), { mode: 0o700 });
  const path = join(dir, 'k', 'master.key');
  writeFileSync(path, 'garbage', { mode: 0o600 });
  assert.throws(() => loadOrCreateMasterKey(path, []), /damaged/);
  assert.equal(readFileSync(path, 'utf8'), 'garbage');
});

test('seal and open round trip, with a fresh nonce each time', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mk = loadOrCreateMasterKey(join(dir, 'master.key'), []);
  const a = seal(mk, 'hello value', 'secret:x');
  const b = seal(mk, 'hello value', 'secret:x');
  assert.notDeepEqual(a.nonce, b.nonce);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.equal(a.keyId, mk.currentId);
  assert.equal(open(mk, a, 'secret:x'), 'hello value');
  assert.ok(!a.ciphertext.toString('utf8').includes('hello'));
});

test('any tampering is detected', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mk = loadOrCreateMasterKey(join(dir, 'master.key'), []);
  const s = seal(mk, 'the real value', 'secret:a');
  const flip = (b: Buffer, i = 0): Buffer => {
    const c = Buffer.from(b);
    c[i] ^= 1;
    return c;
  };
  assert.throws(() => open(mk, { ...s, ciphertext: flip(s.ciphertext) }, 'secret:a'), /integrity/);
  assert.throws(() => open(mk, { ...s, tag: flip(s.tag) }, 'secret:a'), /integrity/);
  assert.throws(() => open(mk, { ...s, nonce: flip(s.nonce) }, 'secret:a'), /integrity/);
  assert.throws(() => open(mk, s, 'secret:b'), /integrity/, 'a value moved to another name fails');
  assert.throws(() => open(mk, { ...s, keyId: 'kother' }, 'secret:a'), /not in the master key/);
  const other = loadOrCreateMasterKey(join(dir, 'other.key'), []);
  assert.throws(() => open({ currentId: mk.currentId, keys: new Map([[mk.currentId, other.keys.get(other.currentId)!]]) }, s, 'secret:a'), /integrity/);
});

test('a symlinked key file is refused, even when it points at a good key', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, 'real.key');
  loadOrCreateMasterKey(real, []);
  symlinkSync(real, join(dir, 'link.key'));
  assert.throws(() => loadOrCreateMasterKey(join(dir, 'link.key'), []), /symbolic link/);
});

test('a key folder other users can write to is refused', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'open'));
  chmodSync(join(dir, 'open'), 0o777);
  assert.throws(() => loadOrCreateMasterKey(join(dir, 'open', 'master.key'), []), /chmod 700/);
});

test('a forbidden folder reached through a symlink is still refused', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'data'), { mode: 0o700 });
  symlinkSync(join(dir, 'data'), join(dir, 'alias'));
  assert.throws(() => loadOrCreateMasterKey(join(dir, 'alias', 'master.key'), [join(dir, 'data')]), /must be outside/);
});

test('a missing key is not recreated when encrypted settings already exist', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'k', 'master.key');
  assert.throws(() => loadOrCreateMasterKey(path, [], { allowCreate: false }), /Restore the key file from backup/);
  assert.throws(() => statSync(path), /ENOENT/, 'nothing was created');
});
