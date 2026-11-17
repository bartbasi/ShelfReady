// Offline checks of scripts/square/live-readonly.ts: fetch is stubbed and a fake
// token is used, so nothing reaches Square.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FAKE = 'EAAA' + 'f'.repeat(40);
const home = mkdtempSync(join(tmpdir(), 'sr-live-'));
mkdirSync(join(home, '.config/shelfready'), { recursive: true });
const envFile = join(home, '.config/shelfready/dev.env');
writeFileSync(envFile, `SQUARE_LIVE_READONLY_TOKEN=${FAKE}\n`, { mode: 0o600 });
process.env.HOME = home;

const calls: Array<{ method: string; url: string; body?: string }> = [];
globalThis.fetch = (async (input: any, init: any) => {
  calls.push({ method: init?.method, url: String(input), body: init?.body });
  return new Response(JSON.stringify({ locations: [], objects: [], counts: [] }), { status: 200 });
}) as typeof fetch;

const mod = await import('../scripts/square/live-readonly.ts');

test('the module exports only fixed read functions, no general sender', () => {
  assert.deepEqual(Object.keys(mod).sort(), ['catalogPage', 'checkLiveToken', 'countsPage', 'listLocations']);
});

test('the source names no write endpoint and no write method', () => {
  const src = readFileSync(new URL('../scripts/square/live-readonly.ts', import.meta.url), 'utf8');
  for (const bad of ['upsert', 'batch-change', 'changes/batch-create', 'delete', "'PUT'", "'DELETE'", "'PATCH'", 'update']) {
    assert.ok(!src.toLowerCase().includes(bad.toLowerCase()), `found ${bad}`);
  }
});

test('each function sends exactly one read call to live Square', async () => {
  calls.length = 0;
  await mod.listLocations();
  await mod.catalogPage('ITEM,CATEGORY', 'abc');
  await mod.countsPage(['V1'], 'L1', '');
  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).origin}${new URL(c.url).pathname}`),
    [
      'GET https://connect.squareup.com/v2/locations',
      'GET https://connect.squareup.com/v2/catalog/list',
      'POST https://connect.squareup.com/v2/inventory/counts/batch-retrieve',
    ],
  );
});

test('odd catalog types and id counts are refused before sending', async () => {
  calls.length = 0;
  await assert.rejects(mod.catalogPage('ITEM&x=1', ''));
  await assert.rejects(mod.catalogPage('../batch-upsert', ''));
  await assert.rejects(mod.countsPage([], 'L1', ''));
  await assert.rejects(mod.countsPage(Array(501).fill('V'), 'L1', ''));
  assert.equal(calls.length, 0);
});

test('a dev.env others can read is refused, and the error holds no token', () => {
  chmodSync(envFile, 0o644);
  try {
    assert.throws(() => mod.checkLiveToken(), (e: Error) => /mode 600/.test(e.message) && !e.message.includes(FAKE));
  } finally {
    chmodSync(envFile, 0o600);
  }
});

test('a malformed token is refused without echoing it', () => {
  const bad = 'EAAA' + 'x'.repeat(20) + '\r' + 'y';
  writeFileSync(envFile, `SQUARE_LIVE_READONLY_TOKEN=${bad}\n`, { mode: 0o600 });
  try {
    assert.throws(() => mod.checkLiveToken(), (e: Error) => !e.message.includes('xxxx'));
  } finally {
    writeFileSync(envFile, `SQUARE_LIVE_READONLY_TOKEN=${FAKE}\n`, { mode: 0o600 });
  }
});

test('a proxy or TLS override in the environment is refused', () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
  try {
    assert.throws(() => mod.checkLiveToken(), /HTTPS_PROXY/);
  } finally {
    delete process.env.HTTPS_PROXY;
  }
});
