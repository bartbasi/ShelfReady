// Unit tests for the ScaleConnect client that need no harness and no network beyond a local test server.
// The result shapes copy what ScaleConnect's MCP server returned on November 4, 2026.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { inspect } from 'node:util';
import {
  ScaleConnectClient,
  classifyApply,
  classifyLoggedChange,
  targetedScaleStatuses,
  type ChangeResult,
} from '../src/scaleconnect/client.ts';

const ALL_VERIFIED = { FRONT: 'verified', KITCHEN: 'verified', COUNTER: 'verified' };

function change(fields: Partial<ChangeResult>): ChangeResult {
  return { summary: 'test', ...fields };
}

test('apply: full success only when success, outcome and every status agree', () => {
  assert.equal(classifyApply(change({ success: true, outcome: 'success', scale_statuses: ALL_VERIFIED })), 'success');
  const oneNotVerified = { ...ALL_VERIFIED, KITCHEN: 'accepted_not_verified' };
  assert.equal(classifyApply(change({ success: true, outcome: 'success', scale_statuses: oneNotVerified })), 'unknown');
  assert.equal(classifyApply(change({ success: true, outcome: 'success', scale_statuses: {} })), 'unknown');
});

test('apply: partial, failed, in_progress and other outcomes', () => {
  const partial = { FRONT: 'verified', KITCHEN: 'not_available', COUNTER: 'verified' };
  assert.equal(classifyApply(change({ success: false, outcome: 'partial', scale_statuses: partial })), 'partial');
  assert.equal(classifyApply(change({ success: false, outcome: 'failed', scale_statuses: { FRONT: 'rejected' } })), 'failed');
  for (const outcome of ['in_progress', 'unknown', 'catalog_out_of_sync', 'interrupted', undefined]) {
    assert.equal(classifyApply(change({ success: false, outcome, running: true })), 'unknown', String(outcome));
  }
});

test('apply: a refusal with nothing sent is refused, RESULT UNKNOWN is unknown', () => {
  const refusal = { ok: false, nothing_sent: true, error: { code: 'acknowledgement_required', message: 'x' } };
  assert.equal(classifyApply(change(refusal)), 'refused');
  const unexpected = { ok: false, nothing_sent: false, error: { code: 'unexpected', message: 'KeyError' } };
  assert.equal(classifyApply(change(unexpected)), 'unknown');
  assert.equal(classifyApply(change({ ok: false })), 'unknown');
});

test('getChange: a failed lookup is unknown, never refused', () => {
  // scale_get_change does not write, so its error replies say nothing_sent true about the lookup.
  const lookupError = { ok: false, nothing_sent: true, error: { code: 'unexpected', message: 'OperationalError' } };
  assert.equal(classifyLoggedChange(change(lookupError)), 'unknown');
  const notFound = { ok: false, nothing_sent: true, error: { code: 'change_not_found', message: 'x' } };
  assert.equal(classifyLoggedChange(change(notFound)), 'unknown');
});

test('getChange: applied false is not_applied, distinct from unknown', () => {
  const never = { applied: false, preview_id: 'f'.repeat(32), success: false };
  assert.equal(classifyLoggedChange(change(never)), 'not_applied');
});

test('getChange: logged outcomes', () => {
  assert.equal(
    classifyLoggedChange(change({ applied: true, success: true, outcome: 'success', scale_statuses: ALL_VERIFIED })),
    'success',
  );
  assert.equal(classifyLoggedChange(change({ applied: true, success: false, outcome: 'in_progress', running: true })), 'unknown');
  assert.equal(classifyLoggedChange(change({ applied: true, success: false, outcome: 'partial' })), 'partial');
});

test('a settle that verified on its one scale is partial, and its targeted scale is verified', () => {
  const settle = change({ success: false, outcome: 'partial', scale_statuses: { KITCHEN: 'verified' }, not_touched: [] });
  assert.equal(classifyApply(settle), 'partial');
  assert.deepEqual(targetedScaleStatuses(settle), { statuses: { KITCHEN: 'verified' }, allVerified: true });
});

test('targetedScaleStatuses leaves out scales not touched', () => {
  const subset = change({
    success: false,
    outcome: 'partial',
    scale_statuses: { FRONT: 'verified', KITCHEN: 'skipped_not_write_enabled' },
    not_touched: ['KITCHEN', 'COUNTER'],
  });
  assert.deepEqual(targetedScaleStatuses(subset), { statuses: { FRONT: 'verified' }, allVerified: true });
  const missed = change({ outcome: 'partial', scale_statuses: { FRONT: 'verified', KITCHEN: 'not_available' } });
  assert.equal(targetedScaleStatuses(missed).allVerified, false);
  assert.equal(targetedScaleStatuses(change({})).allVerified, false);
});

test('applyChanges refuses bad arguments before sending anything', async () => {
  // Port 9 on localhost: nothing is ever sent, because these fail before any request.
  const client = new ScaleConnectClient({ url: 'http://127.0.0.1:9/mcp', token: 't'.repeat(43) });
  const bad = await client.applyChanges('not a preview id!', { acknowledgeWarnings: false, acknowledgeDrift: [] });
  assert.equal(bad.kind, 'refused');
  const noAck = await client.applyChanges('a'.repeat(32), {
    acknowledgeWarnings: 'yes' as unknown as boolean,
    acknowledgeDrift: [],
  });
  assert.equal(noAck.kind, 'refused');
  const badToken = await client.applyChanges('a'.repeat(32), {
    acknowledgeWarnings: false,
    acknowledgeDrift: [42 as unknown as string],
  });
  assert.equal(badToken.kind, 'refused');
  const notConnected = await client.applyChanges('a'.repeat(32), { acknowledgeWarnings: false, acknowledgeDrift: [] });
  assert.equal(notConnected.kind, 'refused');
});

test('the client keeps its token out of inspect and JSON', () => {
  const token = 'secret-token-value-0123456789abcdef';
  const client = new ScaleConnectClient({ url: 'http://127.0.0.1:9/mcp', token });
  assert.ok(!inspect(client, { showHidden: true, depth: 5 }).includes(token));
  assert.ok(!JSON.stringify(client).includes(token));
});

test('the client never calls listTools', async () => {
  // Once listTools has run, the SDK checks tool output after a tool has run and raises errors with
  // the same codes as a refusal. applyChanges treats those as unknown anyway, but keep it simple.
  const source = await readFile(new URL('../src/scaleconnect/client.ts', import.meta.url), 'utf8');
  const code = source.replace(/\/\/.*$/gm, '');
  assert.ok(!/\.listTools\s*\(/.test(code), 'client.ts must not call listTools');
});

test('targetedScaleStatuses: a still_differ entry for a targeted scale means not done', () => {
  const differs = change({
    success: false,
    outcome: 'partial',
    scale_statuses: { KITCHEN: 'verified' },
    still_differ: [{ scale: 'KITCHEN', kind: 'differs', item_id: 4, plu: '8203' }],
  });
  assert.equal(targetedScaleStatuses(differs).allVerified, false);
  const elsewhere = change({
    outcome: 'partial',
    scale_statuses: { KITCHEN: 'verified' },
    still_differ: [{ scale: 'FRONT', kind: 'differs', item_id: 4 }],
  });
  assert.equal(targetedScaleStatuses(elsewhere).allVerified, true);
  const unnamed = change({ outcome: 'partial', scale_statuses: { KITCHEN: 'verified' }, still_differ: [{ kind: 'differs' }] });
  assert.equal(targetedScaleStatuses(unnamed).allVerified, false);
});

test('targetedScaleStatuses: an unverified item on a verified scale means not done', () => {
  const fromResults = change({
    outcome: 'partial',
    scale_statuses: { KITCHEN: 'verified' },
    scale_results: [{ scale: 'KITCHEN', status: 'verified', items: [{ status: 'verified' }, { status: 'not_sent' }] }],
  });
  assert.equal(targetedScaleStatuses(fromResults).allVerified, false);
  const fromRows = change({
    outcome: 'partial',
    scale_statuses: { KITCHEN: 'verified' },
    items: [{ plu: '8203', scales: { KITCHEN: { status: 'accepted_not_verified' } } }],
  });
  assert.equal(targetedScaleStatuses(fromRows).allVerified, false);
  const allGood = change({
    outcome: 'partial',
    scale_statuses: { KITCHEN: 'verified' },
    scale_results: [{ scale: 'KITCHEN', status: 'verified', items: [{ status: 'verified' }] }],
    items: [{ plu: '8203', scales: { KITCHEN: { status: 'verified' } } }],
  });
  assert.equal(targetedScaleStatuses(allGood).allVerified, true);
});

test('the client follows no redirect, even within the same origin, so the token goes to its URL only', async (t) => {
  const seen: Array<{ method: string; url: string; auth: boolean }> = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: typeof req.headers.authorization === 'string' });
    // 307 keeps the method and body, so a client that follows it would send the token on.
    res.statusCode = 307;
    res.setHeader('location', '/elsewhere');
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const token = 'R'.repeat(43);
  const client = new ScaleConnectClient({ url: `http://127.0.0.1:${port}/mcp`, token, shortCallTimeoutMs: 5000 });
  await assert.rejects(client.connect(), (e: Error) => /Could not connect/.test(e.message) && !e.message.includes(token));
  await client.close();
  assert.ok(seen.length > 0, 'the first request reached the server');
  assert.deepEqual(seen.filter((x) => x.url !== '/mcp'), [], 'nothing went to the redirect target');
});
