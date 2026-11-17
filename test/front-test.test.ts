// The step 10 FRONT test script (scripts/runs/front-test.ts).
//
// Without the harness: arguments, the acknowledgement match, the checks on ScaleConnect's list,
// the token, where the token may go (refused before anything is sent), the restore cost, the
// stock weight, the escaping of printed data, and clean with nothing to reach.
//
// Against the dev harness (ScaleConnect's real MCP server and three fake scales on
// 127.0.0.1:18765), with the fake Square from send-fixtures.ts. Needs the harness:
// scripts/dev-scaleconnect/dev-sc.sh start. Skipped when it is not running.
// 1. The whole sequence: partial with FRONT verified, six reads and two writes of FRONT, nothing
//    read or written on KITCHEN or COUNTER, every preview and apply for FRONT alone, and the price
//    and stock back where they were.
// 2. A lost apply reply: not known, never sent again, found by status.
// 3. FRONT gives no reply to the preview: a stop at once.
// 4. Non-zero exits: FRONT not verified, a preview that is not the planned price, a sandbox that
//    does not match.
// 5. Stopped after the yes and before the apply: status looks it up, records it never applied
//    once its preview has ended, and clean then works.
// Each test uses its own dev harness code, apart from send-dev.test.ts and send-local.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withHarnessLock } from './harness-lock.ts';
import { ackProblem, checkScaleList, costForPrice, data, frontTest, keyPathFor, listenerProblem, liveToken, liveUrlProblem, parseArgs, plainText, poundsFromStock, Stop, word, type FrontTestHooks, type SquareSide } from '../scripts/runs/front-test.ts';
import { DEFAULT_FORMULA } from '../src/settings/schema.ts';
import { connectScaleConnect, type ScaleApi } from '../src/scaleconnect/connection.ts';
import { DEV_MCP_URL, readDevConnection } from '../src/scaleconnect/dev-connection.ts';
import { trailingScaleCode } from '../src/lib/scale-code.ts';
import type { CatalogSource } from '../src/square/catalog-source.ts';
import { CAT_CHEESE, item, LOCATION, POUND } from './matching-fixtures.ts';
import { fakeSquare, sendObjects, type FakeSquare } from './send-fixtures.ts';

const DEV_SC = fileURLToPath(new URL('../scripts/dev-scaleconnect/dev-sc.sh', import.meta.url));
const runFile = promisify(execFile);
const LOCAL = ['127.0.0.1', '10.0.0.20'];

// ---- Without the harness

test('arguments: name=value and --name value, flags, and unknown words refused (url is gone)', () => {
  const a = parseArgs(['plan', 'plu=7015', '--cost', '5.75']);
  assert.equal(a.command, 'plan');
  assert.equal(a.values.get('plu'), '7015');
  assert.equal(a.values.get('cost'), '5.75');
  assert.ok(parseArgs(['preview', 'tick-big', '--again']).flags.has('again'));
  assert.throws(() => parseArgs(['plan', 'url=http://10.0.0.20:8765/mcp']), /SCALECONNECT_URL/);
  assert.throws(() => parseArgs(['send', 'acknowledge=all']), Stop);
  assert.throws(() => parseArgs(['send', 'ack=']), Stop);
  assert.throws(() => parseArgs(['send', 'dev=1']), Stop);
});

const preview = (codes: string[], tokens: string[] = []) => ({
  summary: '',
  expiresAt: '2099-01-01T00:00:00Z',
  scales: ['FRONT'],
  mustAcknowledge: codes.length > 0,
  warnings: codes.map((code) => ({ code, message: 'm', requiresAck: true, mayBeFrozen: false })),
  driftTokens: tokens,
  drift: [],
  driftCannotAck: [],
  leftOut: [],
  mayBeFrozen: [],
  differences: [],
  blockedWhy: '',
  digest: 'x',
});

test('the warnings and drift typed on send must be exactly the ones the preview showed', () => {
  const p = preview(['scale_not_targeted', 'price_change_large']);
  assert.equal(ackProblem(p, 'price_change_large,scale_not_targeted', ''), null);
  assert.match(ackProblem(p, 'scale_not_targeted', '') ?? '', /not exactly/);
  assert.match(ackProblem(p, 'scale_not_targeted,price_change_large,plu_change', '') ?? '', /not exactly/);
  assert.match(ackProblem(p, 'none', '') ?? '', /not exactly/);
  assert.equal(ackProblem(preview([]), 'none', ''), null);
  assert.match(ackProblem(preview([]), 'scale_not_targeted', '') ?? '', /not exactly/);
  const d = preview(['scale_not_targeted'], ['FRONT:10:abc']);
  assert.match(ackProblem(d, 'scale_not_targeted', '') ?? '', /drift/);
  assert.equal(ackProblem(d, 'scale_not_targeted', 'FRONT:10:abc'), null);
  assert.match(ackProblem(d, 'scale_not_targeted', 'FRONT:10:abc,FRONT:11:def') ?? '', /drift/);
});

const scales = [{ name: 'FRONT', write_enabled: true }, { name: 'KITCHEN', write_enabled: true }, { name: 'COUNTER', write_enabled: true }];
const clear = { scales, config_changed: false, scales_in_use: false, unfinished: [], scales_may_be_frozen: [], interrupted_change_ids: [] };

test('ScaleConnect\'s list: anything that would make the test unsafe is a refusal, a frozen scale a stop', () => {
  assert.deepEqual(checkScaleList(clear, { plu: '7015', beforeChange: true }), { frozen: [], problems: [], names: ['FRONT', 'KITCHEN', 'COUNTER'] });
  assert.match(checkScaleList({ ...clear, config_changed: true }, { plu: '7015', beforeChange: true }).problems.join(), /config_changed/);
  assert.match(checkScaleList({ ...clear, scales_in_use: true }, { plu: '7015', beforeChange: true }).problems.join(), /scales_in_use/);
  assert.match(checkScaleList({ ...clear, interrupted_change_ids: ['c1'] }, { plu: '7015', beforeChange: true }).problems.join(), /stopped without finishing/);
  assert.match(checkScaleList({ ...clear, unfinished: [{ scale: 'FRONT', plu: '7100', kind: 'missed_change' }] }, { plu: '7015', beforeChange: false }).problems.join(), /FRONT has 1 unfinished/);
  assert.match(checkScaleList({ ...clear, unfinished: [{ scale: 'KITCHEN', plu: '', kind: 'list_failed' }] }, { plu: '7015', beforeChange: false }).problems.join(), /list_failed/);
  // KITCHEN missing this code is expected after the change, but not before it.
  const kitchen = { ...clear, unfinished: [{ scale: 'KITCHEN', plu: '7015', kind: 'missed_change' }] };
  assert.deepEqual(checkScaleList(kitchen, { plu: '7015', beforeChange: false }).problems, []);
  assert.match(checkScaleList(kitchen, { plu: '7015', beforeChange: true }).problems.join(), /Code 7015 has unfinished changes on KITCHEN/);
  assert.match(checkScaleList({ ...clear, scales: [{ name: 'FRONT', write_enabled: false }] }, { plu: '7015', beforeChange: true }).problems.join(), /writes off/);
  assert.match(checkScaleList(clear, { plu: '7015', beforeChange: true, scaleNames: ['FRONT', 'KITCHEN'] }).problems.join(), /now lists the scales/);
  assert.deepEqual(checkScaleList({ ...clear, scales_may_be_frozen: ['KITCHEN'] }, { plu: '7015', beforeChange: true }).frozen, ['KITCHEN']);
  assert.deepEqual(checkScaleList({ ...clear, unfinished: [{ scale: 'COUNTER', plu: '7015', kind: 'missed_change', may_be_frozen: true }] }, { plu: '7015', beforeChange: false }).frozen, ['COUNTER']);
});

test('the live token: a plain message when SCALECONNECT_TOKEN is missing, and never its value', () => {
  assert.throws(() => liveToken(() => ''), /SCALECONNECT_TOKEN is not in ~\/\.config\/shelfready\/dev\.env yet/);
  const short = 'abc';
  assert.throws(() => liveToken(() => short), (e: Error) => /does not look like/.test(e.message) && !e.message.includes(short));
  const spaced = 'a'.repeat(20) + ' b';
  assert.throws(() => liveToken(() => spaced), (e: Error) => !e.message.includes(spaced));
  const good = 'T'.repeat(43);
  assert.equal(liveToken(() => good), good);
  assert.throws(() => liveToken(() => { throw new Error('~/.config/shelfready/dev.env must be mode 600.'); }), /mode 600/);
});

test('the token goes only to plain http, an IPv4 address of this PC, path /mcp', () => {
  assert.equal(liveUrlProblem('http://10.0.0.20:8765/mcp', LOCAL), null);
  assert.match(liveUrlProblem('http://10.0.0.21:8765/mcp', LOCAL) ?? '', /not an address of this PC/);
  assert.match(liveUrlProblem('http://8.8.8.8:8765/mcp', LOCAL) ?? '', /not an address of this PC/);
  assert.match(liveUrlProblem('https://10.0.0.20:8765/mcp', LOCAL) ?? '', /http:\/\//);
  assert.match(liveUrlProblem('http://scales.example.com:8765/mcp', LOCAL) ?? '', /not a name/);
  assert.match(liveUrlProblem('http://localhost:8765/mcp', LOCAL) ?? '', /not a name/);
  assert.match(liveUrlProblem('http://[::1]:8765/mcp', LOCAL) ?? '', /not a name/);
  assert.match(liveUrlProblem('http://10.0.0.20:8765/', LOCAL) ?? '', /\/mcp/);
  assert.match(liveUrlProblem('http://10.0.0.20:8765/mcp?x=1', LOCAL) ?? '', /\/mcp/);
  assert.match(liveUrlProblem('http://u:p@10.0.0.20:8765/mcp', LOCAL) ?? '', /\/mcp/);
  assert.match(liveUrlProblem(DEV_MCP_URL, LOCAL) ?? '', /dev harness/);
  assert.match(liveUrlProblem('10.0.0.20', LOCAL) ?? '', /full address/);
});

/** /proc/net/tcp text with these rows: [address:port in its hex, state, uid]. */
function procTable(rows: Array<[string, string, number]>): string {
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  return [head, ...rows.map(([a, st, uid], i) => `   ${i}: ${a} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${1000 + i} 1 0000000000000000 100 0 0 10 0`)].join('\n') + '\n';
}

test('the token goes only to a listener this user owns, on that address and port', () => {
  const host = '10.0.0.20';
  const at = '1400000A:223D'; // 10.0.0.20:8765
  const v6 = (addr: string) => procTable([[addr, '0A', 1001]]);
  assert.equal(listenerProblem({ tcp: procTable([[at, '0A', 1000]]), tcp6: '' }, host, 8765, 1000), null, 'ours');
  assert.match(listenerProblem({ tcp: procTable([[at, '0A', 1001]]), tcp6: '' }, host, 8765, 1000) ?? '', /another user/);
  assert.match(listenerProblem({ tcp: '', tcp6: '' }, host, 8765, 1000) ?? '', /Nothing is listening on 10\.0\.0\.20:8765/);
  assert.match(listenerProblem({ tcp: procTable([[at, '01', 1000]]), tcp6: '' }, host, 8765, 1000) ?? '', /Nothing is listening/, 'a connection, not a listener');
  assert.match(listenerProblem({ tcp: procTable([['1400000A:223E', '0A', 1000]]), tcp6: '' }, host, 8765, 1000) ?? '', /Nothing is listening/, 'another port');
  assert.equal(listenerProblem({ tcp: procTable([['00000000:223D', '0A', 1000]]), tcp6: '' }, host, 8765, 1000), null, 'a wildcard of ours');
  assert.match(listenerProblem({ tcp: procTable([['00000000:223D', '0A', 1001]]), tcp6: '' }, host, 8765, 1000) ?? '', /another user/, 'a wildcard of another user');
  assert.match(listenerProblem({ tcp: procTable([[at, '0A', 1000], ['00000000:223D', '0A', 1001]]), tcp6: '' }, host, 8765, 1000) ?? '', /another user/);
  assert.match(listenerProblem({ tcp: '', tcp6: v6('00000000000000000000000000000000:223D') }, host, 8765, 1000) ?? '', /another user/, 'tcp6 wildcard');
  assert.match(listenerProblem({ tcp: '', tcp6: v6('0000000000000000FFFF00001400000A:223D') }, host, 8765, 1000) ?? '', /another user/, 'tcp6 mapped address');
  assert.equal(listenerProblem({ tcp: procTable([['0100007F:4965', '0A', 1000]]), tcp6: '' }, '127.0.0.1', 18789, 1000), null, '127.0.0.1:18789');
});

test('a bad address is refused before any request carries the token', async (t) => {
  const seen: Array<{ url: string; auth: boolean }> = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', auth: typeof req.headers.authorization === 'string' });
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const token = 'L'.repeat(43);
  const stateDir = mkdtempSync(join(tmpdir(), 'shelfready-front-test-url-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const noSquare = (): SquareSide => {
    throw new Error('Square must not be reached');
  };
  const run = async (address: string, argv = ['plan', 'plu=7015', 'cost=5.75']) => {
    const lines: string[] = [];
    const code = await frontTest(argv, { stateDir, square: noSquare, localAddresses: () => ['127.0.0.1'], readEnv: (k) => (k === 'SCALECONNECT_TOKEN' ? token : k === 'SCALECONNECT_URL' ? address : ''), out: (l) => lines.push(l) });
    const text = lines.join('\n');
    assert.ok(!text.includes(token));
    return { code, text };
  };
  for (const bad of [`http://127.0.0.1:${port}/other`, `https://127.0.0.1:${port}/mcp`, `http://192.0.2.10:${port}/mcp`, `http://localhost:${port}/mcp`, `http://127.0.0.1:${port}/mcp?next=x`]) {
    const r = await run(bad);
    assert.equal(r.code, 2, `${bad}: ${r.text}`);
    assert.match(r.text, /Nothing was sent/);
    const s = await run(bad, ['status', 'preview=abc']);
    assert.equal(s.code, 2, `${bad}: ${s.text}`);
  }
  assert.equal(seen.length, 0, 'no request reached any address');
  // The right address, but the listener belongs to another user: refused.
  const foreign = await frontTest(['status', 'preview=abc'], { stateDir, uid: (process.getuid?.() ?? 0) + 1, localAddresses: () => ['127.0.0.1'], readEnv: (k) => (k === 'SCALECONNECT_TOKEN' ? token : k === 'SCALECONNECT_URL' ? `http://127.0.0.1:${port}/mcp` : ''), out: () => undefined });
  assert.equal(foreign, 2);
  // The right address, but nothing is listening there.
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const nobody = await run(`http://127.0.0.1:${closedPort}/mcp`, ['status', 'preview=abc']);
  assert.equal(nobody.code, 2);
  assert.match(nobody.text, /Nothing is listening on 127\.0\.0\.1:\d+/);
  assert.equal(seen.length, 0, 'still no request reached any address');
  // No address in dev.env: the server config's liveScaleConnectUrl is used. With neither, it stops.
  const fromConfig = async (configured: string) => {
    const lines: string[] = [];
    const code = await frontTest(['status', 'preview=abc'], { stateDir, square: noSquare, localAddresses: () => ['127.0.0.1'], readEnv: (k) => (k === 'SCALECONNECT_TOKEN' ? token : ''), configLiveUrl: () => configured, out: (l) => lines.push(l) });
    return { code, text: lines.join('\n') };
  };
  const neither = await fromConfig('');
  assert.notEqual(neither.code, 0);
  assert.match(neither.text, /No ScaleConnect address: set SCALECONNECT_URL in ~\/\.config\/shelfready\/dev\.env, or liveScaleConnectUrl in config\/local\/server\.json\. Nothing was contacted\./);
  const configured = await fromConfig(`http://127.0.0.1:${closedPort}/mcp`);
  assert.equal(configured.code, 2);
  assert.match(configured.text, /Nothing is listening on 127\.0\.0\.1:\d+/);
  assert.ok(!configured.text.includes(token));
  assert.equal(seen.length, 0, 'still no request reached any address');
  // The checks are not what stopped them: a good address with our listener is reached, with the token.
  const ok = await run(`http://127.0.0.1:${port}/mcp`, ['status', 'preview=abc']);
  assert.notEqual(ok.code, 0);
  assert.ok(seen.length > 0 && seen.every((x) => x.url === '/mcp' && x.auth));
});

test('the restore cost gives back exactly the original price, or none when the formula cannot', () => {
  for (const cents of [1299, 1899, 2399, 499, 999]) {
    const c = costForPrice(DEFAULT_FORMULA, cents);
    assert.ok(c, `a cost for ${cents}`);
    assert.match(c!, /^\d+\.\d{2}$/);
  }
  assert.equal(costForPrice(DEFAULT_FORMULA, 1849), null);
  assert.equal(costForPrice(DEFAULT_FORMULA, 1899), '8.50');
});

test('the invoice weight is the stock count, when it can be one', () => {
  assert.equal(poundsFromStock('3.75000'), '3.75');
  assert.equal(poundsFromStock('12'), '12');
  assert.equal(poundsFromStock('0.125'), '0.125');
  for (const bad of [null, '0', '0.000', '-2', '1.2345', '250', 'x', '1e3']) assert.equal(poundsFromStock(bad), null, String(bad));
});

test('printed data is quoted and escaped; ScaleConnect words are filtered', () => {
  assert.equal(data('A‮B⁦C\u007fD\u0085E\u0007'), '"A\\u202eB\\u2066C\\u007fD\\u0085E\\u0007"');
  assert.equal(data('x'.repeat(50), 10), `"${'x'.repeat(10)}"`);
  assert.equal(word('scale_not_targeted'), 'scale_not_targeted');
  assert.equal(word('FRONT:10:abc'), 'FRONT:10:abc');
  assert.equal(word('FRONT‮'), '"FRONT\\u202e"');
  assert.equal(word('SUCCESS all verified'), '"SUCCESS all verified"');
  assert.equal(plainText('a\nb⁧c'), 'a\\u000ab\\u2067c');
});

test('clean needs nothing reachable when no apply can be in flight', async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), 'shelfready-front-test-clean-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ version: 1, mode: 'live', url: 'http://10.0.0.20:8765/mcp', plu: '7015', scaleNames: [], item: {}, original: {}, runs: [], frozenStop: null }));
  const lines: string[] = [];
  const code = await frontTest(['clean', 'yes'], { stateDir, readEnv: () => '', localAddresses: () => [], out: (l) => lines.push(l) });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(!existsSync(stateDir));
});

// ---- Against the dev harness

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
if (!conn) skip = 'dev ScaleConnect harness is not running. Start it with: scripts/dev-scaleconnect/dev-sc.sh start';
else if (!(await reachable(conn.url))) skip = 'dev ScaleConnect harness left its connection file but its MCP server does not answer. Restart it.';

async function harness(...args: string[]): Promise<string> {
  return (await runFile(DEV_SC, args, { timeout: 60_000 })).stdout;
}

/** Reads (LP) and writes (GP) each fake scale has received so far. */
async function counters(): Promise<Record<string, { reads: number; writes: number }>> {
  const st = JSON.parse(await harness('status')) as { scales: Record<string, { lp_messages: number; gp_messages: number }> };
  return Object.fromEntries(Object.entries(st.scales).map(([k, v]) => [k, { reads: v.lp_messages, writes: v.gp_messages }]));
}

const devApi = (): Promise<ScaleApi> => connectScaleConnect({ url: conn!.url, token: conn!.token, allowLive: false, clientName: 'shelfready-front-test-test' });

async function withDev<T>(fn: (api: ScaleApi) => Promise<T>): Promise<T> {
  const api = await devApi();
  try {
    return await fn(api);
  } finally {
    await api.close();
  }
}

const catalogPrice = (plu: string) => withDev(async (api) => String(((await api.getItem({ plu })).data.item as { price: string }).price));
const cents = (p: string) => Math.round(Number(p) * 100);

/** The Square side for the script, over the fake Square's live items. */
function fakeSide(sq: FakeSquare, tamper?: () => boolean): SquareSide {
  return {
    locationId: LOCATION,
    settings: { values: { squareEnvironment: 'sandbox' }, secrets: {} },
    async findItem(plu) {
      const hits = [...sq.items.values()].filter((o) => trailingScaleCode(String((o.item_data as { name: string }).name)) === plu);
      if (hits.length !== 1) throw new Stop(`no single item for ${plu}`);
      return { itemId: hits[0]!.id as string, variationId: ((hits[0]!.item_data as { variations: Array<{ id: string }> }).variations[0]!).id };
    },
    async readItem(id) {
      const it = sq.items.get(id);
      if (!it) return null;
      const copy = structuredClone(it);
      // Someone changed the sandbox item right after the app wrote it.
      if (tamper?.()) ((copy.item_data as { variations: Array<{ item_variation_data: { price_money: { amount: number } } }> }).variations[0]!.item_variation_data.price_money.amount += 100);
      return copy;
    },
    async poundUnitId() {
      return POUND;
    },
    async stockCount(v) {
      return sq.counts.has(v) ? `${sq.counts.get(v)!.toFixed(5)}` : null;
    },
  };
}

/** The catalog the app reads: the fake Square as it is now, so the restore sees the new price. */
function liveCatalog(sq: FakeSquare, base: Record<string, unknown>[]): CatalogSource {
  return {
    kind: 'square_sandbox',
    label: 'Test catalog',
    async load() {
      return { source: 'square_sandbox', locationId: LOCATION, takenAt: new Date().toISOString(), objects: [...base.filter((o) => o.type !== 'ITEM'), ...[...sq.items.values()].map((o) => structuredClone(o))] };
    },
    async counts(ids) {
      return new Map([...sq.counts].filter(([k]) => ids.includes(k)).map(([k, v]) => [k, String(v)]));
    },
  };
}

interface Env {
  sq: FakeSquare;
  variation: string;
  startCents: number;
  stateDir: string;
  run(argv: string[], extra?: Partial<FrontTestHooks>): Promise<{ code: number; text: string }>;
}

async function setup(t: { after(fn: () => unknown): void; diagnostic(m: string): void }, plu: string, name: string, opts: { stock?: number; tamper?: () => boolean } = {}): Promise<Env> {
  const startCents = cents(await catalogPrice(plu));
  const variation = `V_FT${plu}`;
  const objects = sendObjects([item({ id: `I_FT${plu}`, name: `${name} ${plu}`, category: CAT_CHEESE, variations: [{ id: variation, cents: startCents, unit: POUND }] })]);
  const sq = fakeSquare(objects, Date.now, opts.stock === undefined ? {} : { [variation]: opts.stock });
  const stateDir = mkdtempSync(join(tmpdir(), 'shelfready-front-test-'));
  t.after(() => {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(keyPathFor(stateDir), { force: true });
  });
  const base: FrontTestHooks = { stateDir, square: () => fakeSide(sq, opts.tamper), appDeps: { catalogSource: liveCatalog(sq, objects), squareWriteApi: sq, squareLocationId: () => LOCATION } };
  return {
    sq,
    variation,
    startCents,
    stateDir,
    async run(argv, extra = {}) {
      const lines: string[] = [];
      const code = await frontTest(argv, { ...base, ...extra, appDeps: { ...base.appDeps, ...extra.appDeps }, out: (l) => lines.push(l) });
      const text = lines.join('\n');
      t.diagnostic(`front-test ${argv.join(' ')} -> ${code}\n${text}`);
      // Bart reads this output: no em dashes, no double hyphens, and never the token.
      assert.ok(!/—|--/.test(text), `plain punctuation in: ${text}`);
      assert.ok(!text.includes(conn!.token), 'the token is never printed');
      return { code, text };
    },
  };
}

const squareCents = (env: Env) => {
  const it = env.sq.items.get(`I_FT${env.variation.slice(4)}`)!;
  const v = (it.item_data as { variations: Array<{ item_variation_data: { price_money?: { amount: number }; measurement_unit_id?: string; pricing_type: string } }> }).variations[0]!.item_variation_data;
  assert.equal(v.measurement_unit_id, POUND, 'sold by weight (rule 12)');
  assert.equal(v.pricing_type, 'FIXED_PRICING');
  return v.price_money?.amount;
};

/** KITCHEN and COUNTER never got the test's changes. A compare of each alone ends their rows (fake scales only). */
async function settleOthers(plu: string): Promise<void> {
  await withDev(async (api) => {
    for (const s of ['KITCHEN', 'COUNTER']) await api.compareScale(s);
    const left = (((await api.listScales()).data.unfinished as Array<{ plu: string; scale: string }>) ?? []).filter((u) => u.plu === plu);
    assert.deepEqual(left, [], 'the dev harness is left clean for the other tests');
  });
}

/** The new whole-dollar price a dollar up, and the cost that gives it (2 x cost + 1, up to .99). */
function nextPrice(startCents: number): { cost: string; cents: number } {
  const whole = Math.floor(startCents / 100) + 1;
  return { cost: ((whole - 1) / 2 + 0.25).toFixed(2), cents: whole * 100 + 99 };
}

/** Records what the app asks ScaleConnect, and lets a test change it. */
function spy(calls: Array<{ tool: string; scales?: string[]; previewId?: string }>, change: Partial<ScaleApi> = {}) {
  return (api: ScaleApi): ScaleApi => ({
    close: () => api.close(),
    listScales: () => api.listScales(),
    getItem: (x) => api.getItem(x),
    getChange: (x) => api.getChange(x),
    previewSettleDrift: (sc, take, x) => (calls.push({ tool: 'settle', scales: [sc] }), api.previewSettleDrift(sc, take, x)),
    compareScale: (sc, m) => (calls.push({ tool: 'compare', scales: [sc] }), api.compareScale(sc, m)),
    previewChanges: (c, o) => (calls.push({ tool: 'preview', scales: o?.scales }), (change.previewChanges ?? api.previewChanges.bind(api))(c, o)),
    applyChanges: (id, a) => (calls.push({ tool: 'apply', previewId: id }), (change.applyChanges ?? api.applyChanges.bind(api))(id, a)),
  });
}

const ackOf = (text: string) => /send ack=([a-z_,]+)/.exec(text)![1]!;
const plugAll = async () => {
  for (const s of ['FRONT', 'KITCHEN', 'COUNTER']) await harness('plug', s);
};

test('dev harness: the whole sequence on FRONT alone, six reads and two writes, then everything back', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8722';
  const env = await setup(t, plu, 'Aged Gouda', { stock: 3.75 });
  const next = nextPrice(env.startCents);
  const calls: Array<{ tool: string; scales?: string[]; previewId?: string }> = [];
  const hooks = { wrapScaleApi: spy(calls) };
  const before = await counters();

  let r = await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'], hooks);
  assert.equal(r.code, 0);
  assert.match(r.text, /Only FRONT will be written/);
  assert.match(r.text, /No card sheet/);
  assert.match(r.text, /Invoice cost: \$[\d.]+ per lb, 3\.75 lb/);
  assert.match(r.text, /so the stock does not change/);
  assert.equal(await catalogPrice(plu), (env.startCents / 100).toFixed(2), 'plan changes nothing');

  assert.equal((await env.run(['send', 'ack=scale_not_targeted'], hooks)).code, 1, 'no send before a preview');

  r = await env.run(['preview'], hooks);
  assert.equal(r.code, 0);
  assert.match(r.text, /Scales it would write: FRONT\./);
  assert.match(r.text, /FRONT was read once for this preview/);
  assert.match(r.text, /send ack=scale_not_targeted\nAsk Bart before running this\./);
  assert.equal(squareCents(env), next.cents, 'the sandbox is written before the scales (decision 1)');
  assert.equal(env.sq.counts.get(env.variation), 3.75, 'the stock count stays as it was');
  assert.equal(await catalogPrice(plu), (env.startCents / 100).toFixed(2), 'a preview writes no scale');

  r = await env.run(['preview'], hooks);
  assert.equal(r.code, 1, 'a second preview reads FRONT again, so it needs again');
  assert.equal((await env.run(['send', 'ack=scale_not_targeted,price_change_large'], hooks)).code, 1);
  assert.equal((await env.run(['send', 'ack=none'], hooks)).code, 1);

  r = await env.run(['send', 'ack=scale_not_targeted'], hooks);
  assert.equal(r.code, 0);
  assert.match(r.text, /Scales: PARTIAL\. FRONT confirmed it/);
  assert.match(r.text, /FRONT: verified\. Confirmed by reading it back\./);
  assert.match(r.text, /KITCHEN: left out of this test, nothing sent\..*not_targeted/);
  assert.match(r.text, /Labels: none/);
  assert.match(r.text, /Next: restore/);
  assert.equal(cents(await catalogPrice(plu)), next.cents);
  assert.equal((await env.run(['send', 'ack=scale_not_targeted'], hooks)).code, 1, 'never sent twice');

  r = await env.run(['restore'], hooks);
  assert.equal(r.code, 0);
  r = await env.run(['preview'], hooks);
  assert.equal(r.code, 0);
  assert.equal(squareCents(env), env.startCents);
  r = await env.run(['send', `ack=${ackOf(r.text)}`], hooks);
  assert.equal(r.code, 0);
  assert.match(r.text, /The restore is done on FRONT/);
  assert.match(r.text, /Nothing is left on KITCHEN or COUNTER/);
  assert.match(r.text, new RegExp(`next time code ${plu} is changed with a read, they may show drift in the time alone`));
  assert.match(r.text, /stock: "3\.75000" lb before the test, "3\.75000" lb now/);
  assert.equal(cents(await catalogPrice(plu)), env.startCents, 'the scale catalog has the original price again');
  assert.equal(squareCents(env), env.startCents, 'and the sandbox');

  // Measured on the fake scales: FRONT read three times per run and written once; the others untouched.
  const after = await counters();
  const delta = (s: string) => ({ reads: after[s]!.reads - before[s]!.reads, writes: after[s]!.writes - before[s]!.writes });
  t.diagnostic(`fake scale messages: ${JSON.stringify({ FRONT: delta('FRONT'), KITCHEN: delta('KITCHEN'), COUNTER: delta('COUNTER') })}`);
  assert.deepEqual(delta('FRONT'), { reads: 6, writes: 2 });
  assert.deepEqual(delta('KITCHEN'), { reads: 0, writes: 0 });
  assert.deepEqual(delta('COUNTER'), { reads: 0, writes: 0 });
  // Every preview the app asked for named FRONT alone, and each apply was one of those previews.
  const previews = calls.filter((c) => c.tool === 'preview');
  assert.equal(previews.length, 2);
  for (const p of previews) assert.deepEqual(p.scales, ['FRONT']);
  assert.deepEqual(calls.filter((c) => !['preview', 'apply'].includes(c.tool)), [], 'no compare or settle');
  const applies = calls.filter((c) => c.tool === 'apply');
  assert.equal(applies.length, 2);
  await withDev(async (api) => {
    for (const a of applies) assert.deepEqual(Object.keys((await api.getChange({ previewId: a.previewId! })).data.scale_statuses ?? {}), ['FRONT']);
  });

  r = await env.run(['status'], hooks);
  assert.equal(r.code, 0);
  assert.match(r.text, /ScaleConnect's log for preview .*: partial/);
  await settleOthers(plu);
}));

test('dev harness: a lost apply reply is looked up by preview id, never sent again', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8715';
  const env = await setup(t, plu, 'Gruyere Reserve');
  const next = nextPrice(env.startCents);
  let applies = 0;
  let lost = false;
  const lose = (api: ScaleApi): ScaleApi => ({
    close: () => api.close(),
    listScales: () => api.listScales(),
    getItem: (x) => api.getItem(x),
    previewChanges: (c, o) => api.previewChanges(c, o),
    previewSettleDrift: (sc, take, x) => api.previewSettleDrift(sc, take, x),
    compareScale: (sc, m) => api.compareScale(sc, m),
    getChange: async (x) => {
      // The connection is still gone when the app first asks for the result.
      if (lost) {
        lost = false;
        throw new Error('connection lost');
      }
      return api.getChange(x);
    },
    applyChanges: async (id, acks) => {
      applies++;
      await api.applyChanges(id, acks);
      lost = true;
      // The change ran, but its answer never reaches ShelfReady (a client timeout).
      return { kind: 'unknown', previewId: id, isError: true, message: 'The apply did not return (client timeout).' };
    },
  });
  assert.equal((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'])).code, 0);
  assert.match((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'])).text, /already planned/);
  assert.equal((await env.run(['preview'], { wrapScaleApi: lose })).code, 0);
  let r = await env.run(['send', 'ack=scale_not_targeted'], { wrapScaleApi: lose });
  assert.equal(r.code, 4);
  assert.match(r.text, /RESULT NOT KNOWN YET/);
  assert.equal(applies, 1);

  r = await env.run(['send', 'ack=scale_not_targeted'], { wrapScaleApi: lose });
  assert.equal(r.code, 1);
  assert.match(r.text, /never sent twice/);
  assert.equal((await env.run(['restore'], { wrapScaleApi: lose })).code, 1, 'no restore while the change has no known result');
  assert.equal(applies, 1);

  r = await env.run(['status'], { wrapScaleApi: lose });
  assert.equal(r.code, 0);
  assert.match(r.text, /Scales: PARTIAL\. FRONT confirmed it/);
  assert.equal(applies, 1, 'status only looked it up');
  assert.equal(cents(await catalogPrice(plu)), next.cents, 'the one apply landed');

  // Put it back, with replies that arrive.
  assert.equal((await env.run(['restore'])).code, 0);
  r = await env.run(['preview']);
  assert.equal(r.code, 0);
  assert.equal((await env.run(['send', `ack=${ackOf(r.text)}`])).code, 0);
  assert.equal(cents(await catalogPrice(plu)), env.startCents);
  assert.equal(applies, 1);
  await settleOthers(plu);
}));

test('dev harness: FRONT gives no reply to the preview, and the script stops at once', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8710';
  const env = await setup(t, plu, 'Manchego 6 Month');
  const next = nextPrice(env.startCents);
  assert.equal((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'])).code, 0);
  const calls: Array<{ tool: string }> = [];
  const count = spy(calls);
  await harness('unplug', 'FRONT');
  try {
    let r = await env.run(['preview'], { wrapScaleApi: count });
    assert.equal(r.code, 3);
    assert.match(r.text, /STOP\. FRONT MAY BE FROZEN/);
    assert.match(r.text, /do not retry/);
    assert.equal(calls.length, 1, 'the one preview read, and nothing after it');
    r = await env.run(['send', 'ack=scale_not_targeted'], { wrapScaleApi: count });
    assert.notEqual(r.code, 0);
    r = await env.run(['preview', 'again'], { wrapScaleApi: count });
    assert.notEqual(r.code, 0);
    assert.match(r.text, /may have been frozen/);
    r = await env.run(['preview', 'again', 'frozen-cleared'], { wrapScaleApi: count });
    assert.equal(r.code, 3, 'ScaleConnect still lists FRONT as may be frozen');
    r = await env.run(['status'], { wrapScaleApi: count });
    assert.equal(r.code, 3);
    assert.match(r.text, /MAY BE FROZEN/);
    assert.equal(calls.length, 1, 'nothing after the stop read or wrote a scale');
    assert.equal(await catalogPrice(plu), (env.startCents / 100).toFixed(2));
  } finally {
    await harness('plug', 'FRONT');
    // Someone looked at it: a compare of FRONT alone clears the flag (fake scales only).
    await withDev((api) => api.compareScale('FRONT'));
  }
}));

test('dev harness: FRONT not verified after the send exits non-zero, with no next step', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8731';
  const env = await setup(t, plu, 'Parmigiano Reggiano');
  const next = nextPrice(env.startCents);
  const notVerified = (api: ScaleApi): ScaleApi =>
    spy([], {
      applyChanges: async (id, acks) => {
        const w = await api.applyChanges(id, acks);
        if (w.kind !== 'partial') return w;
        // FRONT says Error: it did not take the change.
        return { ...w, data: { ...w.data, scale_statuses: { FRONT: 'rejected' }, items: [] } };
      },
    })(api);
  assert.equal((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'])).code, 0);
  assert.equal((await env.run(['preview'])).code, 0);
  const r = await env.run(['send', 'ack=scale_not_targeted'], { wrapScaleApi: notVerified });
  assert.equal(r.code, 1);
  assert.match(r.text, /FRONT did NOT confirm the new price/);
  assert.match(r.text, /FRONT: rejected\./);
  assert.ok(!/Next: restore|The restore is done|Confirmed by reading it back/.test(r.text));
  // The fake FRONT did take it in fact; put it back.
  assert.equal((await env.run(['restore'])).code, 0);
  const p = await env.run(['preview']);
  assert.equal((await env.run(['send', `ack=${ackOf(p.text)}`])).code, 0);
  assert.equal(cents(await catalogPrice(plu)), env.startCents);
  await settleOthers(plu);
}));

test('dev harness: a preview that is not the planned price exits non-zero, and send refuses it', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8121';
  const env = await setup(t, plu, 'Speck Alto Adige');
  const next = nextPrice(env.startCents);
  const calls: Array<{ tool: string }> = [];
  const shifted = (api: ScaleApi): ScaleApi =>
    spy(calls, { previewChanges: (c, o) => api.previewChanges(c.map((x) => ({ ...x, price: (Number(x.price) + 1).toFixed(2) })), o) })(api);
  assert.equal((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'])).code, 0);
  let r = await env.run(['preview'], { wrapScaleApi: shifted });
  assert.equal(r.code, 1);
  assert.match(r.text, /must not be sent: it does not put \$[\d.]+ on code 8121 alone/);
  assert.ok(!/send ack=/.test(r.text));
  r = await env.run(['send', 'ack=scale_not_targeted'], { wrapScaleApi: shifted });
  assert.equal(r.code, 1);
  assert.ok(!calls.some((c) => c.tool === 'apply'));
  assert.equal(await catalogPrice(plu), (env.startCents / 100).toFixed(2));
}));

test('dev harness: a sandbox that does not match after its write exits non-zero, and send refuses', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8115';
  let tamper = false;
  const env = await setup(t, plu, 'Jamon Serrano', { tamper: () => tamper });
  const next = nextPrice(env.startCents);
  const calls: Array<{ tool: string }> = [];
  assert.equal((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'])).code, 0);
  tamper = true;
  let r = await env.run(['preview'], { wrapScaleApi: spy(calls) });
  assert.equal(r.code, 1);
  assert.match(r.text, /It is not\. The scale must not get a price Square does not have/);
  assert.ok(!/send ack=/.test(r.text));
  r = await env.run(['send', 'ack=scale_not_targeted'], { wrapScaleApi: spy(calls) });
  assert.equal(r.code, 1);
  assert.match(r.text, /Refusing: the sandbox item/);
  assert.ok(!calls.some((c) => c.tool === 'apply'));
}));

test('dev harness: stopped after the yes, before the apply: status records it never applied, clean works', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8207';
  const env = await setup(t, plu, 'Finocchiona');
  const next = nextPrice(env.startCents);
  const calls: Array<{ tool: string }> = [];
  const hooks = { wrapScaleApi: spy(calls) };
  assert.equal((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'], hooks)).code, 0);
  assert.equal((await env.run(['preview'], hooks)).code, 0);
  let r = await env.run(['send', 'ack=scale_not_targeted'], { ...hooks, afterAck: () => { throw new Stop('Stopped (Ctrl-C).', 130); } });
  assert.equal(r.code, 130);
  // The yes is stored and the job queued; nothing went to ScaleConnect.
  for (const cmd of [['send', 'ack=scale_not_targeted'], ['preview', 'again'], ['restore']]) assert.equal((await env.run(cmd, hooks)).code, 1, cmd.join(' '));

  r = await env.run(['status'], hooks);
  assert.equal(r.code, 4);
  assert.match(r.text, /cut short\. It is only looked up from now on, never sent/);
  assert.match(r.text, /no result for it yet/);
  // Now the step is looked up only, and its preview has not ended: clean asks ScaleConnect and refuses.
  r = await env.run(['clean', 'yes'], hooks);
  assert.equal(r.code, 1);
  assert.match(r.text, /may still be running/);
  // Once the preview has ended and five more minutes have gone, it can never run.
  const later = Date.now() + 25 * 60_000;
  r = await env.run(['status'], { ...hooks, appDeps: { now: () => later } });
  assert.equal(r.code, 1);
  assert.match(r.text, /NEVER APPLIED/);
  assert.ok(!calls.some((c) => c.tool === 'apply'), 'never applied by anything');
  assert.equal(await catalogPrice(plu), (env.startCents / 100).toFixed(2));
  assert.equal((await env.run(['clean', 'yes'], hooks)).code, 0);
  assert.ok(!existsSync(env.stateDir));
}));

test('dev harness: plan says clean yes when it stops after making the test database', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  const plu = '8211';
  const env = await setup(t, plu, 'Soppressata Calabrese');
  // A cost that gives the price the scale has now: refused after the database exists.
  const same = ((Math.floor(env.startCents / 100) - 1) / 2 + 0.25).toFixed(2);
  let r = await env.run(['plan', `plu=${plu}`, `cost=${same}`, 'dev']);
  assert.equal(r.code, 1);
  assert.match(r.text, /the price the scale has now\. Pick a cost that changes it\. Run clean yes before planning again\./);
  r = await env.run(['plan', `plu=${plu}`, `cost=${nextPrice(env.startCents).cost}`, 'dev']);
  assert.match(r.text, /Run clean yes, then plan again/);
  assert.equal((await env.run(['clean', 'yes'])).code, 0);
}));

test('dev harness: a stock count that moved since plan stops the preview before Square is written', { skip, timeout: 600_000 }, async (t) => withHarnessLock(async () => {
  await plugAll();
  const plu = '8211';
  const env = await setup(t, plu, 'Soppressata Calabrese', { stock: 4 });
  const next = nextPrice(env.startCents);
  const calls: Array<{ tool: string }> = [];
  assert.equal((await env.run(['plan', `plu=${plu}`, `cost=${next.cost}`, 'dev'])).code, 0);
  env.sq.counts.set(env.variation, 2.5); // a sale since the plan
  const r = await env.run(['preview'], { wrapScaleApi: spy(calls) });
  assert.equal(r.code, 1);
  assert.match(r.text, /stock count moved since the plan \("4\.00000" lb then, "2\.50000" lb now\)/);
  assert.match(r.text, /Run clean yes, then plan again/);
  assert.equal(squareCents(env), env.startCents, 'Square not written');
  assert.equal(env.sq.counts.get(env.variation), 2.5);
  assert.equal(calls.length, 0, 'no scale preview');
}));
