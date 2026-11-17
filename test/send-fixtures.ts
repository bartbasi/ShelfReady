// Helpers for the send tests: a fake Square write API that behaves like the real one where it
// matters (whole objects replaced, versions checked, idempotency keys honoured, failures on
// demand), a fake ScaleConnect with fake scales that can be unplugged, and an approved run.
// Invented values only, never store data.

import { classifyApply, classifyLoggedChange, type ChangeResult, type ScaleChange } from '../src/scaleconnect/client.ts';
import type { ScaleApi } from '../src/scaleconnect/connection.ts';
import { SquareError, type InventoryCount } from '../src/square/client.ts';
import type { CatalogSource } from '../src/square/catalog-source.ts';
import { checkInventoryBody, checkUpsertBody, SquareNotSent, SquareWriteUnknown, type InventoryBody, type Json, type SquareWriteApi, type UpsertBody } from '../src/square/writer.ts';
import type { ModelInvoice } from '../src/invoice/types.ts';
import { LOCATION, testObjects } from './matching-fixtures.ts';
import { decide, makeRunApp, signIn, testInvoice, uploadPhoto, type RunApp } from './runs-fixtures.ts';
import type { ConfigInput } from '../src/server/config.ts';
import type { AppDeps } from '../src/server/app.ts';

const clone = <T>(v: T): T => structuredClone(v);

/** The invented catalog, with the salmon taking its price at the register at the store (a location override). */
export function sendObjects(extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const objs = testObjects().map((o) => clone(o));
  const salmon = objs.find((o) => o.id === 'I_SALMON') as { item_data: { variations: Array<{ item_variation_data: Json }> } };
  salmon.item_data.variations[0]!.item_variation_data.location_overrides = [{ location_id: LOCATION, pricing_type: 'VARIABLE_PRICING', track_inventory: false }];
  return [...objs, ...extra];
}

export function sendCatalogSource(objects: Record<string, unknown>[], counts: Record<string, string> = { V_CRACKER: '3' }): CatalogSource {
  return {
    kind: 'square_sandbox',
    label: 'Test catalog',
    async load() {
      return { source: 'square_sandbox', locationId: LOCATION, takenAt: '2026-11-06T17:00:00.000Z', objects: clone(objects) };
    },
    async counts(ids) {
      return new Map(Object.entries(counts).filter(([k]) => ids.includes(k)));
    },
  };
}

type On = 'retrieve' | 'upsert' | 'inventory' | 'counts';
export interface Failure {
  on: On;
  /** refuse: Square says no, nothing lands. lost-before: no answer, nothing landed. lost-after: no answer, but it landed. */
  mode: 'refuse' | 'lost-before' | 'lost-after' | 'not-sent';
  codes?: string[];
  /** The HTTP status of a refusal. Default 400. */
  status?: number;
  /** Which call of this kind fails, counting from 1. Default: the next one. */
  nth?: number;
}

export interface FakeSquare extends SquareWriteApi {
  calls: Array<{ on: On; body?: unknown; ids?: readonly string[] }>;
  items: Map<string, Json>;
  counts: Map<string, number>;
  /** Writes that changed something (a replay with the same key does not count). */
  applied: Array<{ on: On; key: string }>;
  fail(f: Failure): void;
  /** Someone else edits an item in Square: its version moves. */
  touch(itemId: string): void;
}

export function fakeSquare(objects: Record<string, unknown>[], now: () => number, initialCounts: Record<string, number> = { V_CRACKER: 3 }): FakeSquare {
  const items = new Map<string, Json>();
  for (const o of objects) if (o.type === 'ITEM') items.set(o.id as string, clone(o) as Json);
  const counts = new Map(Object.entries(initialCounts));
  const keys = new Map<string, { body: string; result: unknown }>();
  const pending: Failure[] = [];
  const seen: Record<On, number> = { retrieve: 0, upsert: 0, inventory: 0, counts: 0 };
  let version = 1000;
  const take = (on: On): Failure | undefined => {
    seen[on]++;
    const i = pending.findIndex((f) => f.on === on && (f.nth === undefined || f.nth === seen[on]));
    return i >= 0 ? pending.splice(i, 1)[0] : undefined;
  };
  const vars = (it: Json): Json[] => ((it.item_data as Json).variations as Json[]) ?? [];
  const parentOf = (variationId: string): Json | undefined => [...items.values()].find((it) => vars(it).some((v) => v.id === variationId));
  const sq: FakeSquare = {
    environment: 'sandbox',
    calls: [],
    items,
    counts,
    applied: [],
    fail(f) {
      pending.push(f);
    },
    touch(itemId) {
      const it = items.get(itemId)!;
      it.version = ++version;
    },
    async retrieveObjects(ids) {
      sq.calls.push({ on: 'retrieve', ids });
      const f = take('retrieve');
      if (f) throw new SquareError('Could not reach Square for POST /v2/catalog/batch-retrieve.');
      return ids.map((id) => items.get(id)).filter((x): x is Json => x !== undefined).map((x) => clone(x));
    },
    async batchUpsert(body: UpsertBody) {
      checkUpsertBody(body);
      sq.calls.push({ on: 'upsert', body: clone(body) });
      const f = take('upsert');
      if (f?.mode === 'not-sent') throw new SquareNotSent('Refused before sending: no Square access token is set.');
      if (f?.mode === 'refuse') throw new SquareError(`Square POST /v2/catalog/batch-upsert did not work (HTTP ${f.status ?? 400}): ${(f.codes ?? ['BAD_REQUEST']).join(', ')}.`, f.codes ?? ['BAD_REQUEST'], f.status ?? 400);
      if (f?.mode === 'lost-before') throw new SquareWriteUnknown('Square did not answer.');
      const text = JSON.stringify(body);
      const prior = keys.get(body.idempotency_key);
      if (prior) {
        if (prior.body !== text) throw new SquareError('Square POST /v2/catalog/batch-upsert did not work (HTTP 400): IDEMPOTENCY_KEY_REUSED.', ['IDEMPOTENCY_KEY_REUSED'], 400);
        return clone(prior.result) as { objects: Json[] };
      }
      const objs = body.batches[0].objects;
      for (const o of objs) {
        const current = o.type === 'ITEM' ? items.get(o.id as string) : vars(parentOf(o.id as string) ?? { item_data: {} }).find((v) => v.id === o.id);
        if (!current || current.version !== o.version) throw new SquareError('Square POST /v2/catalog/batch-upsert did not work (HTTP 400): VERSION_MISMATCH.', ['VERSION_MISMATCH'], 400);
      }
      const out: Json[] = [];
      for (const o of objs) {
        const next = clone(o);
        next.version = ++version;
        if (o.type === 'ITEM') {
          for (const v of vars(next)) v.version = version;
          items.set(o.id as string, next);
        } else {
          // Square replaces the whole variation, as the sandbox showed.
          const parent = parentOf(o.id as string)!;
          const list = vars(parent);
          list[list.findIndex((v) => v.id === o.id)] = next;
          parent.version = ++version;
        }
        out.push(clone(next));
      }
      const result = { objects: out };
      keys.set(body.idempotency_key, { body: text, result });
      sq.applied.push({ on: 'upsert', key: body.idempotency_key });
      if (f?.mode === 'lost-after') throw new SquareWriteUnknown('Square did not answer.');
      return clone(result);
    },
    async changeInventory(body: InventoryBody) {
      checkInventoryBody(body, LOCATION, now());
      sq.calls.push({ on: 'inventory', body: clone(body) });
      const f = take('inventory');
      if (f?.mode === 'not-sent') throw new SquareNotSent('Refused before sending: no Square access token is set.');
      if (f?.mode === 'refuse') throw new SquareError(`Square POST /v2/inventory/changes/batch-create did not work (HTTP ${f.status ?? 400}).`, f.codes ?? ['BAD_REQUEST'], f.status ?? 400);
      if (f?.mode === 'lost-before') throw new SquareWriteUnknown('Square did not answer.');
      const text = JSON.stringify(body);
      const prior = keys.get(body.idempotency_key);
      if (prior) {
        if (prior.body !== text) throw new SquareError('IDEMPOTENCY_KEY_REUSED', ['IDEMPOTENCY_KEY_REUSED'], 400);
        return clone(prior.result) as { counts: InventoryCount[] };
      }
      for (const c of body.changes) {
        if (c.type === 'PHYSICAL_COUNT') {
          const d = c.physical_count as Json;
          counts.set(d.catalog_object_id as string, Number(d.quantity));
        } else {
          const d = c.adjustment as Json;
          counts.set(d.catalog_object_id as string, (counts.get(d.catalog_object_id as string) ?? 0) - Number(d.quantity));
        }
      }
      const result = { counts: [...counts].map(([variationId, q]) => ({ variationId, locationId: LOCATION, state: 'IN_STOCK', quantity: String(q) })) };
      keys.set(body.idempotency_key, { body: text, result });
      sq.applied.push({ on: 'inventory', key: body.idempotency_key });
      if (f?.mode === 'lost-after') throw new SquareWriteUnknown('Square did not answer.');
      return clone(result);
    },
    async inventoryCounts(ids) {
      sq.calls.push({ on: 'counts', ids });
      if (take('counts')) throw new SquareError('Could not reach Square.');
      return ids.filter((id) => counts.has(id)).map((id) => ({ variationId: id, locationId: LOCATION, state: 'IN_STOCK', quantity: String(counts.get(id)) }));
    },
  };
  return sq;
}

// ---- A fake ScaleConnect with fake scales

export interface FakeScales extends ScaleApi {
  calls: Array<{ tool: string; args: unknown }>;
  catalog: Map<string, string>;
  held: Map<string, Map<string, string>>;
  unplugged: Set<string>;
  frozen: Set<string>;
  /** The next apply runs, but its reply is lost. */
  loseNextApply: boolean;
  /** The next apply never reaches ScaleConnect, and the client hears nothing back. */
  dropNextApply: boolean;
  /** When new previews expire. */
  expiresAt: string;
  applies(): Array<{ previewId: string; acknowledgeWarnings: boolean; acknowledgeDrift: string[] }>;
}

interface FakePreview {
  kind: 'push' | 'settle';
  changes: ScaleChange[];
  scales: string[];
  mustAck: boolean;
  tokens: string[];
  used: boolean;
}

export function fakeScales(catalog: Record<string, string> = { '7101': '18.99', '4101': '0.00', '9999': '1.00' }, names = ['FRONT', 'KITCHEN', 'COUNTER']): FakeScales {
  const cat = new Map(Object.entries(catalog));
  const held = new Map(names.map((n) => [n, new Map(cat)]));
  const previews = new Map<string, FakePreview>();
  const log = new Map<string, ChangeResult>();
  let n = 0;
  const f: FakeScales = {
    calls: [],
    catalog: cat,
    held,
    unplugged: new Set(),
    frozen: new Set(),
    loseNextApply: false,
    dropNextApply: false,
    expiresAt: '2099-01-01T00:00:00-06:00',
    applies() {
      return f.calls.filter((c) => c.tool === 'apply').map((c) => c.args as { previewId: string; acknowledgeWarnings: boolean; acknowledgeDrift: string[] });
    },
    async close() {},
    async listScales() {
      f.calls.push({ tool: 'list', args: {} });
      return { isError: false, data: { summary: 'Scales.', scales: names.map((name) => ({ name, write_enabled: true, read_enabled: true })), scales_may_be_frozen: [...f.frozen], unfinished: [] } };
    },
    async getItem(target) {
      f.calls.push({ tool: 'get_item', args: target });
      const plu = 'plu' in target ? target.plu : '';
      return cat.has(plu)
        ? { isError: false, data: { summary: 'Item.', ok: true, item: { plu, price: cat.get(plu) } } }
        : { isError: true, data: { summary: 'REFUSED.', ok: false, error: { code: 'item_not_found', message: 'none' } } };
    },
    async previewChanges(changes, options = {}) {
      f.calls.push({ tool: 'preview', args: { changes, scales: options.scales } });
      const target = options.scales ?? names;
      const leftOut = target.filter((s) => f.frozen.has(s));
      const readNow = target.filter((s) => !f.frozen.has(s));
      const noReply = readNow.filter((s) => f.unplugged.has(s));
      for (const s of noReply) f.frozen.add(s);
      const warnings: Array<{ code: string; message: string; requires_ack: boolean; may_be_frozen: boolean }> = [];
      if (options.scales && options.scales.length < names.length) warnings.push({ code: 'scale_not_targeted', message: 'This change will not touch the other scales.', requires_ack: true, may_be_frozen: false });
      if (leftOut.length) warnings.push({ code: 'scale_left_out', message: `${leftOut.join(', ')} is left out.`, requires_ack: true, may_be_frozen: true });
      for (const c of changes) {
        const old = Number(cat.get(c.target_plu!) ?? '0');
        if (old > 0 && Math.abs(Number(c.price) - old) / old > 0.5) warnings.push({ code: 'price_change_large', message: 'A price is more than 50 percent away.', requires_ack: true, may_be_frozen: false });
      }
      if (noReply.length) warnings.push({ code: 'scale_read_failed', message: 'No reply.', requires_ack: false, may_be_frozen: true });
      const tokens: string[] = [];
      for (const s of readNow.filter((x) => !noReply.includes(x))) for (const c of changes) if (held.get(s)!.get(c.target_plu!) !== cat.get(c.target_plu!)) tokens.push(`${s}:${c.target_plu}:drift`);
      const id = `p${++n}`;
      const mustAck = warnings.some((w) => w.requires_ack === true);
      previews.set(id, { kind: 'push', changes, scales: target, mustAck, tokens, used: false });
      return {
        isError: false,
        data: {
          summary: `Preview only. ${changes.length} change(s).`,
          ok: true,
          preview_id: id,
          expires_at: f.expiresAt,
          scales: target,
          warnings,
          warnings_requiring_ack: warnings.filter((w) => w.requires_ack),
          must_acknowledge_warnings: mustAck,
          drift_tokens_to_acknowledge: tokens,
          drift: tokens.map((t) => ({ ack_token: t, scale: t.split(':')[0], plu: t.split(':')[1], message: 'differs in price' })),
          left_out: leftOut,
          scales_may_be_frozen: noReply,
          differences: changes.map((c) => ({ plu: c.target_plu, fields: { price: { before: cat.get(c.target_plu!), after: c.price } } })),
        },
      };
    },
    async previewSettleDrift(scale, _take, target) {
      f.calls.push({ tool: 'settle_preview', args: { scale, target } });
      const plu = 'plu' in target ? target.plu : '';
      if (f.frozen.has(scale)) return { isError: true, data: { summary: 'REFUSED.', ok: false, nothing_sent: true, errors: [{ code: 'scale_may_be_frozen' }] } };
      if (held.get(scale)!.get(plu) === cat.get(plu)) return { isError: true, data: { summary: 'REFUSED. Change 0: no_drift.', ok: false, nothing_sent: true, errors: [{ code: 'no_drift' }] } };
      const id = `p${++n}`;
      const token = `${scale}:${plu}:settle`;
      previews.set(id, { kind: 'settle', changes: [{ action: 'edit', target_plu: plu, price: cat.get(plu) }], scales: [scale], mustAck: true, tokens: [token], used: false });
      return {
        isError: false,
        data: {
          summary: `Preview only. Settle PLU ${plu} on ${scale}.`,
          ok: true,
          preview_id: id,
          expires_at: f.expiresAt,
          scales: [scale],
          warnings: [{ code: 'scale_not_targeted', message: 'This change will not touch the other scales.', requires_ack: true, may_be_frozen: false }],
          must_acknowledge_warnings: true,
          drift_tokens_to_acknowledge: [token],
          drift: [{ ack_token: token, scale, plu, message: 'differs in price' }],
          left_out: [],
          scales_may_be_frozen: [],
          differences: [{ plu, fields: { price: { before: held.get(scale)!.get(plu), after: cat.get(plu) } } }],
        },
      };
    },
    async compareScale(scale) {
      f.calls.push({ tool: 'compare', args: { scale } });
      if (f.unplugged.has(scale)) {
        f.frozen.add(scale);
        return { isError: true, data: { summary: 'Did not answer.', scales: [{ scale, status: 'unreachable', may_be_frozen: true }], scales_may_be_frozen: [scale] } };
      }
      f.frozen.delete(scale);
      return { isError: false, data: { summary: 'Compared.', scales: [{ scale, status: 'compared' }], scales_may_be_frozen: [] } };
    },
    async applyChanges(previewId, acks) {
      if (f.dropNextApply) {
        f.dropNextApply = false;
        return { kind: 'unknown', previewId, isError: true, message: 'The apply did not return (client timeout).' };
      }
      f.calls.push({ tool: 'apply', args: { previewId, ...acks } });
      const p = previews.get(previewId);
      if (!p || p.used) return { kind: 'refused', previewId, isError: true, data: { summary: 'REFUSED.', ok: false, nothing_sent: true, error: { code: 'preview_not_found', message: '' } }, message: 'REFUSED.' };
      if (p.mustAck && acks.acknowledgeWarnings !== true) return { kind: 'refused', previewId, isError: true, data: { summary: 'REFUSED.', ok: false, nothing_sent: true, error: { code: 'acknowledgement_required', message: '' } }, message: 'REFUSED.' };
      p.used = true;
      const statuses: Record<string, string> = {};
      for (const s of p.scales) {
        if (f.frozen.has(s)) statuses[s] = 'not_available';
        else if (f.unplugged.has(s)) {
          f.frozen.add(s);
          statuses[s] = 'unreachable';
        } else if (p.tokens.some((t) => t.startsWith(`${s}:`)) && !p.tokens.filter((t) => t.startsWith(`${s}:`)).every((t) => acks.acknowledgeDrift.includes(t))) statuses[s] = 'drift_refused';
        else statuses[s] = 'verified';
      }
      const landed = Object.values(statuses).includes('verified');
      if (landed && p.kind === 'push') for (const c of p.changes) cat.set(c.target_plu!, c.price!);
      for (const [s, st] of Object.entries(statuses)) if (st === 'verified') for (const c of p.changes) held.get(s)!.set(c.target_plu!, cat.get(c.target_plu!)!);
      const verifiedOn = Object.entries(statuses).filter(([, st]) => st === 'verified').map(([s]) => s);
      const items = p.changes.map((c) => ({
        plu: c.target_plu,
        scales: Object.fromEntries(Object.entries(statuses).map(([s, st]) => [s, { status: st === 'verified' ? 'verified' : 'not_sent' }])),
        confirmed_on: verifiedOn,
        known_not_on: Object.keys(statuses).filter((s) => !verifiedOn.includes(s)),
        not_known: [],
      }));
      const success = names.every((s) => statuses[s] === 'verified');
      const data: ChangeResult = {
        summary: success ? 'SUCCESS.' : landed ? 'PARTIAL, NOT COMPLETE.' : 'FAILED.',
        success,
        outcome: success ? 'success' : landed ? 'partial' : 'failed',
        change_id: `c${previewId}`,
        scale_statuses: statuses,
        items,
        not_touched: names.filter((s) => !p.scales.includes(s)),
        scales_may_be_frozen: [...f.frozen],
        still_to_do: success ? ['square', 'labels'] : [],
      };
      log.set(previewId, data);
      if (f.loseNextApply) {
        f.loseNextApply = false;
        return { kind: 'unknown', previewId, isError: true, message: 'The apply did not return (client timeout).' };
      }
      const kind = classifyApply(data);
      return kind === 'success' || kind === 'partial' || kind === 'failed' ? { kind, previewId, isError: kind !== 'success', data } : { kind: 'unknown', previewId, isError: true, message: data.summary };
    },
    async getChange(target) {
      f.calls.push({ tool: 'get_change', args: target });
      const id = 'previewId' in target ? target.previewId : '';
      const r = log.get(id);
      const data = r ? { ...r, applied: true } : { summary: 'Not applied.', ok: true, applied: false };
      return { isError: false, data, kind: classifyLoggedChange(data) };
    },
  };
  return f;
}

// ---- An approved run

export interface SendApp extends RunApp {
  sq: FakeSquare;
  sc: FakeScales;
  mgr: { cookie: string; csrf: string };
  clock: { now: number };
}

/**
 * The invented invoice taken to approval: the gouda (by weight, code 7101) drops in price, the
 * crackers rise and get stock, the salmon (code 4101, price at the register with a store override)
 * switches to sold by weight. before() runs extra decisions before the dry run.
 */
export async function approvedRun(opts: { inv?: ModelInvoice; extra?: Record<string, unknown>[]; config?: ConfigInput; deps?: AppDeps; before?: (s: RunApp, mgr: { cookie: string; csrf: string }) => Promise<void>; scaleCatalog?: Record<string, string>; approve?: boolean; picks?: Array<[number, string]> } = {}): Promise<SendApp> {
  const objects = sendObjects(opts.extra);
  const clock = { now: Date.parse('2026-11-06T18:00:00Z') };
  const sq = fakeSquare(objects, () => clock.now);
  const sc = fakeScales(opts.scaleCatalog);
  const s = await makeRunApp({
    inv: opts.inv ?? testInvoice(),
    // The fake scales may all get writes here. The default config allows FRONT only.
    config: { writeScales: ['FRONT', 'KITCHEN', 'COUNTER'], ...opts.config },
    deps: { catalogSource: sendCatalogSource(objects), squareWriteApi: sq, scaleApi: async () => sc, squareLocationId: () => LOCATION, ...opts.deps },
  });
  // The app's clock moves with advance(); the fake Square checks occurred_at against the same time.
  const advance = s.advance.bind(s);
  s.advance = (ms: number) => {
    clock.now += ms;
    advance(ms);
  };
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  await decide(s, mgr, '/runs/1/supplier', { create: '1' });
  for (const [n, variationId] of opts.picks ?? [[1, 'V_GOUDA'], [3, 'V_SALMON']]) await decide(s, mgr, `/runs/1/lines/${n}/pick`, { variationId });
  if (opts.before) await opts.before(s, mgr);
  await decide(s, mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  if (opts.approve !== false) {
    const hash = (s.app.shelf.db.prepare('SELECT dry_run_hash FROM runs WHERE id = 1').get() as { dry_run_hash: string }).dry_run_hash;
    const ok = await decide(s, mgr, '/runs/1/approve', { hash });
    if (ok.statusCode !== 303) throw new Error(`approval refused: ${ok.body.match(/<p class="error"[^>]*>([^<]*)/)?.[1] ?? ok.statusCode}`);
  }
  return Object.assign(s, { sq, sc, mgr, clock });
}

export function dryRunHash(s: RunApp, id = 1): string {
  return (s.app.shelf.db.prepare('SELECT dry_run_hash FROM runs WHERE id = ?').get(id) as { dry_run_hash: string }).dry_run_hash;
}

export function sendPhase(s: RunApp, id = 1): string {
  return (s.app.shelf.db.prepare('SELECT phase FROM run_sends WHERE run_id = ?').get(id) as { phase: string } | undefined)?.phase ?? '';
}

/** Presses Send on the page, with the scales given (default all three), and runs the jobs. */
export async function pressSend(s: SendApp, scales = ['FRONT', 'KITCHEN', 'COUNTER']) {
  const fields: Record<string, string> = { hash: dryRunHash(s) };
  for (const x of scales) fields[`scale_${x}`] = '1';
  const res = await decide(s, s.mgr, '/runs/1/send/start', fields);
  await s.app.shelf.runner.drain();
  return res;
}

/** The current scale preview step, as stored. */
export function pushStep(s: RunApp, id = 1): { id: number; previewId: string; state: string; preview: { digest: string; driftTokens: string[]; mustAcknowledge: boolean; blockedWhy: string; warnings: Array<{ code: string }>; leftOut: string[]; mayBeFrozen: string[] } } {
  const r = s.app.shelf.db.prepare("SELECT id, preview_id, state, preview FROM scale_steps WHERE run_id = ? AND kind = 'push' ORDER BY id DESC LIMIT 1").get(id) as { id: number; preview_id: string; state: string; preview: string };
  return { id: r.id, previewId: r.preview_id, state: r.state, preview: JSON.parse(r.preview) };
}

/** A person ticks every box on the scale preview and presses Send to the scales. */
export async function acceptPreview(s: SendApp, opts: { warnings?: boolean; drift?: boolean } = {}) {
  const st = pushStep(s);
  const fields: Record<string, string> = { stepId: String(st.id) };
  if (opts.warnings !== false && st.preview.mustAcknowledge) fields.ack = st.preview.digest;
  if (opts.drift !== false) st.preview.driftTokens.forEach((t, i) => (fields[`drift_${i}`] = t));
  const res = await decide(s, s.mgr, '/runs/1/send/scales', fields);
  await s.app.shelf.runner.drain();
  return res;
}

export function pending(s: RunApp, id = 1): Array<{ scale: string; code: string; reason: string; state: string; price_cents: number }> {
  return s.app.shelf.db.prepare('SELECT scale, code, reason, state, price_cents FROM scale_pending WHERE run_id = ? ORDER BY scale, code').all(id) as Array<{ scale: string; code: string; reason: string; state: string; price_cents: number }>;
}

export function variation(sq: FakeSquare, itemId: string, variationId: string): Json {
  return ((sq.items.get(itemId)!.item_data as Json).variations as Json[]).find((v) => v.id === variationId)!;
}

/** The settle form for one scale, as the page shows it: the yes box and each drift box. */
export async function settleFields(s: SendApp, scale: string): Promise<Record<string, string>> {
  const { get } = await import('./server-helpers.ts');
  const html = (await get(s, '/runs/1/send', s.mgr.cookie)).body;
  const form = html.split('action="/runs/1/send/resend/accept"').slice(1).find((f) => f.includes(`name="scale" value="${scale}"`)) ?? '';
  const body = form.split('</form>')[0] ?? '';
  const fields: Record<string, string> = { scale };
  const digest = /name="digest" value="([0-9a-f]{32})"/.exec(body)?.[1];
  if (digest) fields.digest = digest;
  for (const m of body.matchAll(/name="(drift_[0-9]+)" value="([^"]+)"/g)) fields[m[1]!] = m[2]!;
  return fields;
}
