// Integration test against ScaleConnect's real MCP server and three fake scales.
// Needs the dev harness: scripts/dev-scaleconnect/dev-sc.sh start. Skipped when it is not running.
//
// What it checks:
// 1. A price edit on every scale: SUCCESS, every scale verified, catalog has the new price.
// 2. KITCHEN unplugged. The first preview cannot read it and flags it as may be frozen, and says
//    not to apply. A new preview leaves it out with a scale_left_out warning that needs a person's
//    acknowledgement. Applied with that acknowledgement, the result is partial: FRONT and COUNTER
//    verified, KITCHEN not_available.
// 3. KITCHEN plugged back in and compared alone, which is the only read that clears the flag.
//    KITCHEN then stays on the unfinished list for the missed edit.
// 4. The resend: a settle of KITCHEN to the catalog's record, which ends the missed edit there.
// Before anything reads or writes a scale, it checks the URL is the dev one and the catalog holds
// the dev sentinel item.

import { test } from 'node:test';
import { withHarnessLock } from './harness-lock.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ScaleConnectClient,
  targetedScaleStatuses,
  type ChangeResult,
  type ScaleConnectResult,
  type WriteResult,
} from '../src/scaleconnect/client.ts';
import { DEV_MCP_URL, DEV_SENTINEL, readDevConnection } from '../src/scaleconnect/dev-connection.ts';

const DEV_SC = fileURLToPath(new URL('../scripts/dev-scaleconnect/dev-sc.sh', import.meta.url));
const SCALES = ['FRONT', 'KITCHEN', 'COUNTER'];
const UNPLUGGED = 'KITCHEN';
const runFile = promisify(execFile);

function reachable(url: string): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const socket = connect({ host: u.hostname, port: Number(u.port) });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const conn = await readDevConnection();
let skip: string | false = false;
if (!conn) {
  skip = 'dev ScaleConnect harness is not running. Start it with: scripts/dev-scaleconnect/dev-sc.sh start';
} else if (!(await reachable(conn.url))) {
  skip = 'dev ScaleConnect harness left its connection file but its MCP server does not answer. Restart it.';
}

async function harness(...args: string[]): Promise<void> {
  await runFile(DEV_SC, args, { timeout: 60_000 });
}

/** Text price plus cents, as text with two decimals. Small steps stay under the 50 percent warning. */
function bump(price: string, cents: number): string {
  const [whole, frac = '00'] = price.split('.');
  let total = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2)) + cents;
  if (total > 99_999) total -= 2 * cents;
  return `${Math.floor(total / 100)}.${String(total % 100).padStart(2, '0')}`;
}

async function catalogPrice(client: ScaleConnectClient, plu: string): Promise<string> {
  const { data } = await client.getItem({ plu });
  const item = data.item as { price?: unknown } | undefined;
  assert.equal(typeof item?.price, 'string', `catalog item ${plu} has a text price`);
  return item!.price as string;
}

function statuses(result: ChangeResult): Record<string, string> {
  return { ...(result.scale_statuses ?? {}) };
}

/** The change data of a write that ran, or a failed assertion naming what came back instead. */
function ran(result: WriteResult, kind: 'success' | 'partial'): ChangeResult {
  assert.equal(result.kind, kind, 'message' in result ? result.message : result.data.summary);
  assert.ok(result.kind === 'success' || result.kind === 'partial');
  return result.data;
}

function frozenList(data: ScaleConnectResult): string[] {
  return (data.scales_may_be_frozen as string[] | undefined) ?? [];
}

test('ScaleConnect dev harness: full success, then a partial result with one scale unplugged', { skip }, async (t) => withHarnessLock(async () => {
  // Only ever the dev server. readDevConnection refuses any other address too.
  assert.equal(conn!.url, DEV_MCP_URL);
  const client = new ScaleConnectClient({ url: conn!.url, token: conn!.token, clientName: 'shelfready-test' });
  await client.connect();
  t.after(() => client.close());
  await harness('plug', UNPLUGGED);

  // ---- the scales
  const list = await client.listScales();
  const scales = list.data.scales as Array<{ name: string; write_enabled: boolean; read_enabled: boolean }>;
  assert.deepEqual(scales.map((s) => s.name), SCALES);
  assert.ok(scales.every((s) => s.write_enabled && s.read_enabled), 'every fake scale has writes and reads on');
  assert.deepEqual(frozenList(list.data), [], 'no scale is flagged as may be frozen. Restart the harness if one is.');

  // The dev sentinel item must be in the catalog before anything reads or writes a scale. MCP does not
  // report scale serials, so this is the server side proof that this is the dev catalog.
  const sentinel = await client.getItem({ plu: DEV_SENTINEL.plu });
  const sentinelItem = sentinel.data.item as { description?: string } | undefined;
  assert.equal(sentinelItem?.description, DEV_SENTINEL.description, 'not the dev harness catalog. Stopping before any preview.');

  // ---- 1. full success
  const plu1 = '8704';
  const found = await client.searchItems(plu1);
  assert.ok(Array.isArray(found.data.items) && found.data.items.length > 0, `seeded item ${plu1} is in the catalog`);
  const new1 = bump(await catalogPrice(client, plu1), 50);

  const p1 = await client.previewChanges([{ action: 'edit', target_plu: plu1, price: new1 }]);
  assert.equal(p1.data.ok, true, p1.data.summary);
  assert.equal(p1.data.must_acknowledge_warnings, false, 'a small price edit needs no acknowledgement');
  assert.deepEqual(p1.data.drift_tokens_to_acknowledge, [], 'no drift at start');
  assert.deepEqual(frozenList(p1.data), []);

  const before = await client.getChange({ previewId: p1.data.preview_id! });
  t.diagnostic(`getChange before apply: kind=${before.kind}`);
  assert.equal(before.kind, 'not_applied');

  const w1 = await client.applyChanges(p1.data.preview_id!, { acknowledgeWarnings: false, acknowledgeDrift: [] });
  const a1 = ran(w1, 'success');
  t.diagnostic(`full success: kind=${w1.kind} isError=${w1.isError} outcome=${a1.outcome} success=${a1.success} statuses=${JSON.stringify(statuses(a1))}`);
  assert.equal(a1.success, true, a1.summary);
  assert.equal(a1.outcome, 'success');
  assert.equal(w1.isError, false);
  assert.ok(a1.summary.startsWith('SUCCESS.'), a1.summary);
  assert.deepEqual(statuses(a1), { FRONT: 'verified', KITCHEN: 'verified', COUNTER: 'verified' });
  assert.deepEqual(a1.still_to_do, ['square', 'labels']);
  assert.equal(await catalogPrice(client, plu1), new1);

  const logged = await client.getChange({ previewId: p1.data.preview_id! });
  assert.equal(logged.kind, 'success', 'the change log agrees');
  // A preview id ScaleConnect never issued: the lookup fails, which is unknown, never refused.
  const missing = await client.getChange({ previewId: 'f'.repeat(32) });
  t.diagnostic(`getChange of a preview id never issued: kind=${missing.kind} code=${missing.data.error?.code} nothing_sent=${missing.data.nothing_sent}`);
  assert.equal(missing.kind, 'unknown');

  // A preview id that does not exist is refused with nothing sent.
  const bogus = await client.applyChanges('0'.repeat(32), { acknowledgeWarnings: false, acknowledgeDrift: [] });
  t.diagnostic(`unknown preview id: kind=${bogus.kind} isError=${bogus.isError} code=${bogus.data?.error?.code}`);
  assert.equal(bogus.kind, 'refused');

  // ---- 2. one scale unplugged
  const plu2 = '8203';
  const old2 = await catalogPrice(client, plu2);
  const new2 = bump(old2, 50);
  await harness('unplug', UNPLUGGED);
  try {
    // The preview reads every scale. KITCHEN refuses the connection, so it is flagged as may be frozen.
    const p2 = await client.previewChanges([{ action: 'edit', target_plu: plu2, price: new2 }]);
    const warnCodes2 = (p2.data.warnings ?? []).map((w) => w.code);
    t.diagnostic(`preview with ${UNPLUGGED} unplugged: warnings=${JSON.stringify(warnCodes2)} may_be_frozen=${JSON.stringify(frozenList(p2.data))} must_ack=${p2.data.must_acknowledge_warnings}`);
    assert.equal(p2.data.ok, true, p2.data.summary);
    assert.ok(warnCodes2.includes('scale_read_failed'), p2.data.summary);
    assert.deepEqual(frozenList(p2.data), [UNPLUGGED]);
    // ScaleConnect says not to apply this preview, even though it needs no acknowledgement. We do not.
    assert.match(p2.data.next_step ?? '', /Do not apply this preview/);

    // A new preview leaves KITCHEN out, with a warning a person must acknowledge.
    const p3 = await client.previewChanges([{ action: 'edit', target_plu: plu2, price: new2 }]);
    const needAck = (p3.data.warnings_requiring_ack as Array<{ code: string }> | undefined) ?? [];
    t.diagnostic(`second preview: left_out=${JSON.stringify(p3.data.left_out)} warnings_requiring_ack=${JSON.stringify(needAck.map((w) => w.code))}`);
    assert.equal(p3.data.ok, true, p3.data.summary);
    assert.deepEqual(p3.data.left_out, [UNPLUGGED]);
    assert.equal(p3.data.must_acknowledge_warnings, true);
    assert.deepEqual(needAck.map((w) => w.code), ['scale_left_out']);
    assert.deepEqual(p3.data.drift_tokens_to_acknowledge, []);

    // Without the acknowledgement it is refused, with nothing sent.
    const refused = await client.applyChanges(p3.data.preview_id!, { acknowledgeWarnings: false, acknowledgeDrift: [] });
    assert.equal(refused.kind, 'refused');
    assert.equal(refused.isError, true);
    assert.equal(refused.data?.error?.code, 'acknowledgement_required');
    assert.equal(await catalogPrice(client, plu2), old2, 'a refused apply changes nothing');

    // This test stands in for the person who has seen exactly that one warning and accepts it.
    const w3 = await client.applyChanges(p3.data.preview_id!, { acknowledgeWarnings: true, acknowledgeDrift: [] });
    const a3 = ran(w3, 'partial');
    const st = statuses(a3);
    t.diagnostic(`unplugged: kind=${w3.kind} outcome=${a3.outcome} success=${a3.success} isError=${w3.isError} statuses=${JSON.stringify(st)} may_be_frozen=${JSON.stringify(frozenList(a3))}`);
    assert.equal(a3.success, false);
    assert.equal(a3.outcome, 'partial');
    assert.ok(a3.summary.startsWith('PARTIAL, NOT COMPLETE.'), a3.summary);
    assert.equal(st.FRONT, 'verified');
    assert.equal(st.COUNTER, 'verified');
    assert.notEqual(st[UNPLUGGED], 'verified');
    assert.equal(st[UNPLUGGED], 'not_available');
    assert.deepEqual(a3.still_to_do, [], 'not a full success, so the person decides before Square');
    const row = (a3.items as Array<{ plu: string; confirmed_on: string[]; known_not_on: string[] }>)[0];
    assert.deepEqual(row.confirmed_on, ['FRONT', 'COUNTER']);
    assert.deepEqual(row.known_not_on, [UNPLUGGED]);
    assert.equal(await catalogPrice(client, plu2), new2, 'the catalog took the change because some scales did');
  } finally {
    await harness('plug', UNPLUGGED);
  }

  // ---- 3. back in: the flag stays until a compare names that scale alone
  const after = await client.listScales();
  assert.deepEqual(frozenList(after.data), [UNPLUGGED], 'still flagged after it answers again');
  const cmp = await client.compareScale(UNPLUGGED);
  t.diagnostic(`compare ${UNPLUGGED} alone: ${cmp.data.summary.split('\n').join(' | ')}`);
  assert.deepEqual(frozenList(cmp.data), []);
  const cleared = await client.listScales();
  assert.deepEqual(frozenList(cleared.data), [], 'the compare cleared the flag');
  const unfinished = (cleared.data.unfinished as Array<{ scale: string; plu: string; kind: string }>) ?? [];
  t.diagnostic(`unfinished after replug: ${JSON.stringify(unfinished.map((u) => `${u.scale} ${u.kind} ${u.plu}`))}`);
  assert.ok(unfinished.some((u) => u.scale === UNPLUGGED && u.plu === plu2 && u.kind === 'missed_change'));

  // ---- 4. the resend: settle KITCHEN to the catalog's record for the missed item
  const ps = await client.previewSettleDrift(UNPLUGGED, 'catalog', { plu: plu2 });
  const settleAck = ((ps.data.warnings_requiring_ack as Array<{ code: string }> | undefined) ?? []).map((w) => w.code);
  t.diagnostic(`settle preview: ok=${ps.data.ok} warnings_requiring_ack=${JSON.stringify(settleAck)} drift_tokens=${(ps.data.drift_tokens_to_acknowledge ?? []).length} | ${ps.data.summary.split('\n').join(' | ')}`);
  assert.equal(ps.data.ok, true, ps.data.summary);
  // A settle touches one scale, so it always carries scale_not_targeted, which needs acknowledging.
  assert.deepEqual(settleAck, ['scale_not_targeted']);
  const tokens = ps.data.drift_tokens_to_acknowledge ?? [];
  assert.equal(tokens.length, 1, 'one drift token: KITCHEN holds the old price');
  assert.ok(tokens[0].startsWith(`${UNPLUGGED}:`), 'the token names KITCHEN');
  // The test stands in for the person who has seen that warning and that KITCHEN holds the old price,
  // and wants the catalog's price there.
  const ws = await client.applyChanges(ps.data.preview_id!, { acknowledgeWarnings: true, acknowledgeDrift: tokens });
  const settleData = 'data' in ws ? ws.data : undefined;
  t.diagnostic(`settle apply: kind=${ws.kind} isError=${ws.isError} statuses=${JSON.stringify(settleData ? statuses(settleData as ChangeResult) : {})}`);
  const settled = ran(ws, 'partial');
  assert.deepEqual(targetedScaleStatuses(settled), { statuses: { [UNPLUGGED]: 'verified' }, allVerified: true });
  const done = await client.listScales();
  const left = ((done.data.unfinished as Array<{ scale: string; plu: string }>) ?? []).filter((u) => u.scale === UNPLUGGED && u.plu === plu2);
  assert.deepEqual(left, [], `${UNPLUGGED} is no longer missing ${plu2}`);
}));
