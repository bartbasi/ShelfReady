// Helpers for the invoice run tests: a fake catalog source built from the invented matching
// catalog, a fake model client that reads an invented invoice, a Square writer that fails on any
// call, and a multipart body builder. Invented values only, never store data.

import type { FastifyInstance } from 'fastify';
import type { CatalogSource } from '../src/square/catalog-source.ts';
import type { SquareWriter } from '../src/square/client.ts';
import type { ModelInvoice } from '../src/invoice/types.ts';
import { fakeClient, image, invoice, line, testImage } from './invoice-fixtures.ts';
import { LOCATION, testObjects, UPC_CRACKER } from './matching-fixtures.ts';
import { addUser, ADMIN_PW, csrfFrom, get, login, MANAGER_PW, ORIGIN, tempDir, type TestApp } from './server-helpers.ts';
import type { AppDeps } from '../src/server/app.ts';
import type { ConfigInput } from '../src/server/config.ts';
import type { SettingValues } from '../src/settings/schema.ts';
import { buildApp } from '../src/server/app.ts';
import { makeConfig } from '../src/server/config.ts';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { START, TEST_SCRYPT } from './server-helpers.ts';
import { buildCatalogIndex, itemOf } from '../src/matching/catalog.ts';
import { insertImportedCard, linkCard } from '../src/copy/store.ts';
import type { Db } from '../src/db/db.ts';

export const SCALES = ['FRONT', 'KITCHEN', 'COUNTER'];

/** A catalog source that never touches the network. */
export function fakeCatalogSource(extra: Record<string, unknown>[] = [], counts: Record<string, string> = { V_CRACKER: '3' }): CatalogSource & { loads: number } {
  const src = {
    kind: 'square_sandbox' as const,
    label: 'Test catalog',
    loads: 0,
    async load() {
      src.loads++;
      return { source: 'square_sandbox' as const, locationId: LOCATION, takenAt: '2026-11-06T17:00:00.000Z', objects: [...testObjects(), ...extra] };
    },
    async counts(ids: readonly string[]) {
      return new Map(Object.entries(counts).filter(([k]) => ids.includes(k)));
    },
  };
  return src;
}

/** Fails the test if anything tries to write to Square. */
export function failingWriter(): SquareWriter & { calls: number } {
  const w = {
    calls: 0,
    async batchUpsertCatalog(): Promise<unknown> {
      w.calls++;
      throw new Error('dry run tried to write the catalog');
    },
    async batchChangeInventory(): Promise<unknown> {
      w.calls++;
      throw new Error('dry run tried to write inventory');
    },
  };
  return w;
}

/** A fetch that fails the test on any call. */
export function failingFetch(): typeof fetch & { calls: number } {
  const f = (async () => {
    f.calls++;
    throw new Error('no network in tests');
  }) as unknown as typeof fetch & { calls: number };
  f.calls = 0;
  return f;
}

/**
 * The invented invoice: a by-weight cheese (picked in review), a packaged cracker (matched by its
 * UPC) and a fish priced at the register today (picked, then switched to sold by weight).
 */
export function testInvoice(fields: Partial<ModelInvoice> = {}): ModelInvoice {
  return invoice({
    supplier_name: 'Hilltop Provisions',
    images: [image()],
    lines: [
      line({ item_number: 'G100', description: 'GOUDA SMOKED WHEEL', unit: 'LB', qty_shipped: '1', weight: '10.5', unit_price: '6.00', extension: '63.00' }),
      line({ item_number: 'C200', upc: UPC_CRACKER, description: 'BLUECREST SEA SALT CRACKERS', pack_size: '12/4.4Z', unit: 'CS', qty_shipped: '2', unit_price: '30.00', extension: '60.00' }),
      line({ item_number: 'S300', description: 'COHO SALMON FILLET', unit: 'LB', qty_shipped: '1', weight: '8', unit_price: '9.00', extension: '72.00' }),
    ],
    total: '195.00',
    ...fields,
  });
}

/** A model client that answers every first-pass call with this invoice. */
export function modelFor(inv: ModelInvoice, times = 5): ReturnType<typeof fakeClient> {
  return fakeClient({ 'claude-sonnet-5-5': Array.from({ length: times }, () => ({ json: inv })), 'claude-opus-5-5': Array.from({ length: times }, () => ({ json: inv })) });
}

export interface RunApp extends TestApp {
  model: ReturnType<typeof fakeClient>;
  writer: ReturnType<typeof failingWriter>;
  fetch: ReturnType<typeof failingFetch>;
  source: ReturnType<typeof fakeCatalogSource>;
}

/**
 * An imported card for every live variation in the catalog, linked to it, as if the store's
 * existing cards were imported: invented text, PER POUND for goods sold by weight. So the run
 * tests that are not about card copy find a card that prints for every item.
 */
export async function seedCards(db: Db, source: CatalogSource, except: readonly string[] = []): Promise<void> {
  const data = await source.load();
  const index = buildCatalogIndex({ objects: data.objects, locationId: data.locationId });
  let slot = 0;
  for (const v of index.variationById.values()) {
    if (except.includes(v.id)) continue;
    const item = itemOf(index, v);
    const byWeight = item.scaleCode !== null || v.perPound;
    slot++;
    const card = insertImportedCard(db, { userId: null, username: 'test' }, {
      code: item.scaleCode ?? '',
      price: '$9.99',
      unit: byWeight ? 'PER POUND' : '4.4 OZ',
      origin: 'PRODUCT OF TESTLAND',
      eyebrow: byWeight ? '01 / CHEESE' : '09 / PANTRY',
      n1: 'Test ',
      n2: `Card ${slot}`,
      producer: 'Test Maker · Testville',
      specs: [
        ['MILK', 'Cow'],
        ['AGE', 'Young'],
        ['CUT', 'Whole'],
      ],
      copy: ['An invented first paragraph.', 'An invented second paragraph.'],
      source: { file: 'invented.docx', created: '2026-10-01T00:00:00.000Z', sheet: Math.ceil(slot / 4), slot: ((slot - 1) % 4) + 1, mark: 'C&C', tagline: 'Test tagline.' },
    }, START);
    linkCard(db, { userId: null, username: 'test' }, card.id, { catalog: data.locationId, catalogSource: data.source, variationId: v.id, itemId: item.id, label: v.label, scaleCode: item.scaleCode }, 'person', {}, START);
  }
}

export async function makeRunApp(opts: { config?: ConfigInput; /** Admin settings to save before the first request, like dailyLimitUsd or bigChangePercent. */ settings?: Partial<SettingValues>; deps?: AppDeps; inv?: ModelInvoice; model?: ReturnType<typeof fakeClient>; cards?: boolean; cardsExcept?: string[] } = {}): Promise<RunApp> {
  const model = opts.model ?? modelFor(opts.inv ?? testInvoice());
  const writer = failingWriter();
  const fetchFake = failingFetch();
  const source = fakeCatalogSource();
  const t = await makeAppWith({ scaleNames: SCALES, ...opts.config }, { modelClient: model, squareWriter: writer, squareFetch: fetchFake, catalogSource: source, startRunner: false, ...opts.deps });
  if (opts.settings) t.app.shelf.settings.update({ values: opts.settings }, { userId: null, username: 'test' });
  const used = (opts.deps?.catalogSource ?? source) as CatalogSource & { loads?: number };
  if (opts.cards !== false) {
    try {
      await seedCards(t.app.shelf.db, used, opts.cardsExcept);
    } catch {
      // A catalog source that fails on purpose: nothing to seed.
    }
  }
  if (typeof used.loads === 'number') used.loads = 0;
  return Object.assign(t, { model, writer, fetch: fetchFake, source });
}

/** Like makeApp, but with app deps. */
export async function makeAppWith(overrides: ConfigInput, deps: AppDeps, dir?: string): Promise<TestApp> {
  const d = dir ?? tempDir();
  let clock = START;
  const logs: string[] = [];
  const config = makeConfig(
    { dbPath: join(d, 'data', 'test.sqlite3'), masterKeyPath: join(d, 'keys', 'master.key'), scrypt: TEST_SCRYPT, logLevel: 'trace', ...overrides },
    { allowVerboseLogs: true },
  );
  const app: FastifyInstance = await buildApp(config, { now: () => clock, logStream: { write: (l: string) => void logs.push(l) }, ...deps });
  return {
    app,
    config,
    dir: d,
    logs,
    advance(ms: number) {
      clock += ms;
    },
    async close() {
      await app.close();
      rmSync(d, { recursive: true, force: true });
    },
  };
}

export type Part = { name: string; value: string } | { name: string; filename: string; type: string; data: Buffer };

/** A multipart/form-data body, parts in the order given. */
export function multipart(parts: Part[]): { payload: Buffer; contentType: string } {
  const boundary = '----shelfreadytest' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if ('value' in p) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    } else {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`));
      chunks.push(p.data);
      chunks.push(Buffer.from('\r\n'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function signIn(t: TestApp, role: 'manager' | 'admin' = 'manager'): Promise<{ cookie: string; csrf: string }> {
  const name = role === 'admin' ? 'bart' : 'mgr';
  const pw = role === 'admin' ? ADMIN_PW : MANAGER_PW;
  const exists = t.app.shelf.db.prepare('SELECT id FROM users WHERE username = ?').get(name);
  if (!exists) await addUser(t, name, role, pw);
  const r = await login(t, name, pw);
  const csrf = csrfFrom((await get(t, '/', r.cookie)).body);
  return { cookie: r.cookie, csrf };
}

export async function upload(t: TestApp, cookie: string, parts: Part[], headers: Record<string, string> = {}) {
  const { payload, contentType } = multipart(parts);
  return t.app.inject({ method: 'POST', url: '/runs', headers: { cookie, origin: ORIGIN, 'content-type': contentType, ...headers }, payload });
}

export async function uploadPhoto(t: TestApp, s: { cookie: string; csrf: string }, seed = 1) {
  return upload(t, s.cookie, [
    { name: '_csrf', value: s.csrf },
    { name: 'files', filename: `page${seed}.jpg`, type: 'image/jpeg', data: await testImage(seed) },
  ]);
}

/** Posts a decision form with the session's token. */
export async function decide(t: TestApp, s: { cookie: string; csrf: string }, url: string, fields: Record<string, string> = {}) {
  return t.app.inject({
    method: 'POST',
    url,
    headers: { cookie: s.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ _csrf: s.csrf, ...fields }).toString(),
  });
}

export function runState(t: TestApp, id = 1): string {
  return (t.app.shelf.db.prepare('SELECT state FROM runs WHERE id = ?').get(id) as { state: string }).state;
}
