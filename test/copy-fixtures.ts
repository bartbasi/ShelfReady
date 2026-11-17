// Invented cards, answers, catalogs and a fake model client for the card copy tests. Invented
// names only, never store data: automated tests must not read data/ or test-invoices/. The copy
// rules are a fixed test config, not the store's config file, so a change to the store's config
// cannot change what these tests mean.

import type { ImportedCard } from '../src/cards/import.ts';
import type { CardConfig } from '../src/cards/types.ts';
import { openDatabase, type Db } from '../src/db/db.ts';
import type { AuditActor } from '../src/db/audit.ts';
import type { CopyModelClient, CopyRequest, CopyResponse } from '../src/copy/client.ts';
import { copyConfigFrom } from '../src/copy/config.ts';
import type { ModelAnswer, ModelCard } from '../src/copy/schema.ts';
import type { CardContent, CopyCatalog, SearchRecord } from '../src/copy/types.ts';
import { buildCatalogIndex } from '../src/matching/catalog.ts';
import { testObjects } from './matching-fixtures.ts';

export const ACTOR: AuditActor = { userId: null, username: 'tester' };
export const PERSON: AuditActor = { userId: 7, username: 'manager1' };
export const NOW = Date.UTC(2026, 10, 7, 15, 0, 0);

/** An in-memory database with the PERSON user in it, since the audit log refers to users. */
export function db(): Db {
  const d = openDatabase(':memory:');
  d.prepare("INSERT INTO users (id, username, role, password_hash, created_at, updated_at) VALUES (?, ?, 'manager', 'x', ?, ?)").run(PERSON.userId, PERSON.username, new Date(NOW).toISOString(), new Date(NOW).toISOString());
  return d;
}

/** Fixed copy rules for the tests: the same shape and limits as a store config, invented guide text. */
export const CONFIG = copyConfigFrom(
  {
    eyebrows: ['01 / CHEESE', '02 / CURED MEAT', '03 / CRACKERS', '04 / PASTA', '09 / PANTRY', '12 / SEAFOOD'],
    limits: {
      copy: { paragraphs: 2, maxLines: 10, targetChars: 340, maxChars: 360 },
      name: { oneLineChars: 24, maxLines: 2, maxChars: 45 },
      producer: { maxChars: 60 },
      specValue: { targetChars: 11, maxChars: 15 },
      specLabel: { maxChars: 12 },
    },
    copyWriting: {
      voice: ['A test voice: plain and specific.'],
      accuracy: ['Check the origin against a source.'],
      origin: ['PRODUCT OF and the country, in capitals.'],
      fields: ['producer: Maker · Place.'],
      flagPhrases: ['indulgent', 'decadent', 'gourmet', 'perfect for'],
      curlyApostrophes: true,
    },
  } as unknown as CardConfig,
  'test config',
);

/** The invented catalog of the matching tests, at location LOC_TEST. */
export const CATALOG: CopyCatalog = { index: buildCatalogIndex({ objects: testObjects(), locationId: 'LOC_TEST' }), source: 'test' };
export const KEY = 'LOC_TEST';

/** The same items under other ids at another location: a copy like the sandbox holds of live. */
export function otherCatalog(): CopyCatalog {
  const objects = JSON.parse(JSON.stringify(testObjects())) as Array<Record<string, any>>;
  for (const o of objects) {
    if (o.type !== 'ITEM') continue;
    o.id = `SBX_${o.id}`;
    for (const v of o.item_data.variations) {
      v.id = `SBX_${v.id}`;
      v.item_variation_data.item_id = o.id;
    }
  }
  return { index: buildCatalogIndex({ objects, locationId: 'LOC_OTHER' }), source: 'square_sandbox' };
}

let slot = 0;

/** An imported card as data/cards/imported.json holds it, with invented text. */
export function imported(fields: Partial<ImportedCard> & { n1: string; n2: string }): ImportedCard {
  slot++;
  return {
    code: '',
    price: '$9.99',
    unit: 'PER POUND',
    origin: 'PRODUCT OF TESTLAND',
    eyebrow: '01 / CHEESE',
    producer: 'Test Dairy · Testville',
    specs: [
      ['MILK', 'Cow’s'],
      ['AGE', '6 Months'],
      ['CUT', 'To Order'],
    ],
    copy: ['A first paragraph about an invented product.', 'A second paragraph about how it eats.'],
    source: { file: 'invented.docx', created: '2026-10-01T00:00:00.000Z', sheet: Math.ceil(slot / 4), slot: ((slot - 1) % 4) + 1, mark: 'C&C', tagline: 'Real food, really good.' },
    ...fields,
  };
}

/** Card text within every limit. */
export function content(fields: Partial<CardContent> = {}): CardContent {
  return {
    origin: 'PRODUCT OF TESTLAND',
    eyebrow: 'CHEESE',
    n1: 'Hilltop Aged ',
    n2: 'Cheddar',
    producer: 'Hilltop Dairy · Testville, North Region',
    specs: [
      ['MILK', 'Cow’s'],
      ['AGE', '12 Months'],
      ['CUT', 'To Order'],
    ],
    copy: ['A block cheddar aged a year in a cool cave, firm and a little crumbly.', 'Sharp and nutty. Good on a board with apples, or melted on toast.'],
    unit: 'PER POUND',
    ...fields,
  };
}

export const SRC_MAKER = 'https://hilltop.example/cheddar';
export const SRC_REGISTER = 'https://register.example/products/hilltop';

export function modelCard(fields: Partial<ModelCard> = {}): ModelCard {
  return {
    origin: 'PRODUCT OF TESTLAND',
    category: 'CHEESE',
    new_category: '',
    n1: 'Hilltop Aged ',
    n2: 'Cheddar',
    producer: 'Hilltop Dairy · Testville, North Region',
    spec1: { label: 'MILK', value: 'Cow’s' },
    spec2: { label: 'AGE', value: '12 Months' },
    spec3: { label: 'CUT', value: 'To Order' },
    paragraph1: 'A block cheddar aged a year in a cool cave, firm and a little crumbly.',
    paragraph2: 'Sharp and nutty. Good on a board with apples, or melted on toast.',
    unit: 'PER POUND',
    ...fields,
  };
}

/** An answer within every limit, citing pages that the default searches return. */
export function answer(fields: Partial<ModelAnswer> = {}): ModelAnswer {
  return {
    product_identified: true,
    card: modelCard(),
    unique_selling_point: 'Aged a year in a cave.',
    origin_check: { country: 'Testland', confirmed: true, source_urls: [SRC_MAKER], note: '' },
    designation_check: { designation: '', confirmed: false, source_urls: [], note: '' },
    claims: [{ claim: 'Aged a year in a cool cave.', confirmed: true, source_urls: [SRC_MAKER] }],
    verify: [],
    sources: [{ url: SRC_MAKER, title: 'Hilltop cheddar', used_for: 'origin and ageing' }],
    ...fields,
  };
}

export function searches(urls: string[] = [SRC_MAKER, SRC_REGISTER]): SearchRecord[] {
  return [{ query: 'hilltop aged cheddar', results: urls.map((url, i) => ({ url, title: `Page ${i + 1}`, pageAge: '' })), error: '' }];
}

/** A finished response carrying this answer. */
export function reply(body: unknown, fields: Partial<CopyResponse> = {}): CopyResponse {
  const found = fields.searches ?? searches();
  return {
    stop: 'end_turn',
    stopReason: 'end_turn',
    refusalCategory: null,
    text: typeof body === 'string' ? body : JSON.stringify(body),
    paused: null,
    searches: found,
    usage: { inputTokens: 20_000, outputTokens: 1500, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 500 },
    webSearchRequests: found.length,
    serverReadings: null,
    requestId: 'req_test',
    model: 'claude-sonnet-5-5',
    ...fields,
  };
}

/** A retry answer: the card with its own claims and verify list. */
export function retryReply(card: ModelCard, extra: Partial<{ claims: ModelAnswer['claims']; verify: ModelAnswer['verify'] }> = {}): CopyResponse {
  return reply({ card, claims: extra.claims ?? [{ claim: 'Aged a year in a cool cave.', confirmed: true, source_urls: [SRC_MAKER] }], verify: extra.verify ?? [] }, { searches: [] });
}

export interface FakeCopyClient extends CopyModelClient {
  calls: CopyRequest[];
  counts: CopyRequest[];
}

/** Answers calls in order from the list. An Error in the list is thrown instead. */
export function fakeCopyClient(responses: Array<CopyResponse | Error>, tokens = 4000): FakeCopyClient {
  const queue = [...responses];
  const calls: CopyRequest[] = [];
  const counts: CopyRequest[] = [];
  return {
    calls,
    counts,
    async countTokens(req) {
      counts.push(req);
      return tokens;
    },
    async call(req) {
      calls.push(JSON.parse(JSON.stringify(req)) as CopyRequest);
      const next = queue.shift();
      if (!next) throw new Error('the fake has no more responses');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}
