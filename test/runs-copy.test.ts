// Card copy in invoice runs: the stage with a fake copy client, the blockers, the card routes
// (roles, CSRF, ids from another run), a restart during writing, nothing arrived, and copy over
// the cost cap approved by an admin. Invented data only; no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { ModelCallError } from '../src/invoice/extract.ts';
import { createCardCopyStage } from '../src/runs/card-copy.ts';
import type { CopyModelClient } from '../src/copy/client.ts';
import { insertImportedCard } from '../src/copy/store.ts';
import { answer, fakeCopyClient, modelCard, reply, retryReply, type FakeCopyClient } from './copy-fixtures.ts';
import { decide, failingWriter, fakeCatalogSource, makeAppWith, makeRunApp, modelFor, runState, seedCards, signIn, testInvoice, uploadPhoto, SCALES, type RunApp } from './runs-fixtures.ts';
import { ageReauth, ORIGIN, START, tempDir, type TestApp } from './server-helpers.ts';
import { runSpend, spendSince } from '../src/runs/spend.ts';

type Session = { cookie: string; csrf: string };

const CRACKER = modelCard({
  category: 'CRACKERS',
  n1: 'Sea Salt ',
  n2: 'Crackers',
  producer: 'Bluecrest Bakery · Testville',
  spec1: { label: 'STYLE', value: 'Thin' },
  spec2: { label: 'SALT', value: 'Sea Salt' },
  spec3: { label: 'PAIR', value: 'Soft Cheese' },
  paragraph1: 'Thin crackers baked with flour, oil and flakes of sea salt.',
  paragraph2: 'Crisp and plain. Good with a soft cheese or a slice of ham.',
  unit: '4.4 OZ',
});

function stage(client: CopyModelClient) {
  return createCardCopyStage({ client: () => client });
}

async function copyApp(fake: FakeCopyClient, opts: { except?: string[]; inv?: ReturnType<typeof testInvoice> } = {}): Promise<RunApp> {
  return makeRunApp({ inv: opts.inv, cardsExcept: opts.except ?? ['V_CRACKER'], deps: { cardCopy: stage(fake) } });
}

async function settle(s: TestApp, mgr: Session, id = 1): Promise<void> {
  await decide(s, mgr, `/runs/${id}/supplier`, { create: '1' });
  await decide(s, mgr, `/runs/${id}/lines/1/pick`, { variationId: 'V_GOUDA' });
  await decide(s, mgr, `/runs/${id}/lines/3/pick`, { variationId: 'V_SALMON' });
}

const page = async (s: TestApp, who: Session, url = '/runs/1') => (await s.app.inject({ method: 'GET', url, headers: { cookie: who.cookie } })).body;
const generated = (s: TestApp) => s.app.shelf.db.prepare("SELECT id, version, checked_version, source, blocked, content FROM cards WHERE first_source = 'generated' ORDER BY id").all() as Array<{ id: number; version: number; checked_version: number; source: string; blocked: string; content: string }>;
const copyRow = (s: TestApp, v: string, run = 1) => s.app.shelf.db.prepare('SELECT * FROM run_copy WHERE run_id = ? AND variation_id = ?').get(run, v) as Record<string, any> | undefined;
const spend = (s: TestApp, kind: 'read' | 'copy', run = 1) => Math.round(runSpend(s.app.shelf.db, run, kind) * 1e6) / 1e6;
const blockers = (s: TestApp, run = 1) => (JSON.parse((s.app.shelf.db.prepare('SELECT evaluation FROM runs WHERE id = ?').get(run) as { evaluation: string }).evaluation).blockers as Array<{ message: string }>).map((b) => b.message);

function editFields(c: { variationId: string; cardId: number; version: number }, fields: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    variationId: c.variationId,
    cardId: String(c.cardId),
    version: String(c.version),
    eyebrow: 'CRACKERS',
    origin: 'PRODUCT OF TESTLAND',
    n1: 'Sea Salt',
    n2: 'Crackers',
    producer: 'Bluecrest Bakery · Testville',
    spec1Label: 'STYLE',
    spec1Value: 'Thin',
    spec2Label: 'SALT',
    spec2Value: 'Sea Salt',
    spec3Label: 'PAIR',
    spec3Value: 'Soft Cheese',
    p1: 'Thin crackers baked with flour, oil and flakes of sea salt.',
    p2: 'Crisp and plain. Good with a soft cheese.',
    unit: '4.4 OZ',
    ...fields,
  } as Record<string, string>;
}

test('the stage writes copy for a product with none, a person checks it, and the dry run lists the card as it will print', async (t) => {
  const fake = fakeCopyClient([reply(answer({ card: CRACKER }))]);
  const s = await copyApp(fake);
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 1, 'one call for the one product with no card');
  assert.equal(fake.calls[0]!.webSearch?.type, 'web_search_20250305');
  assert.equal(copyRow(s, 'V_CRACKER')!.state, 'written');
  const [card] = generated(s);
  assert.ok(card);
  const run = s.app.shelf.db.prepare("SELECT details FROM audit_log WHERE action = 'run.copy' AND run_id = 1").get() as { details: string };
  assert.ok(JSON.parse(run.details).totalCostUsd > 0, 'the cost is in the run log');

  await settle(s, mgr);
  assert.equal(runState(s), 'review');
  assert.ok(blockers(s).some((b) => /Card for Bluecrest - Crackers, Sea Salt: The model wrote this card\. A person must check this version/.test(b)));
  let body = await page(s, mgr);
  assert.match(body, /Written by the model/);
  assert.match(body, /Thin crackers baked with flour/);
  assert.match(body, /\$6\.99<\/span> <span class="pc-unit">4\.4 OZ/, 'price from pricing, unit from the card');
  // Sources are plain text with the host shown, never a live link.
  assert.match(body, /on <strong>hilltop\.example<\/strong>: <span class="hint">https:\/\/hilltop\.example\/cheddar<\/span>/);
  assert.doesNotMatch(body, /href="https:\/\/hilltop/);

  assert.equal((await decide(s, mgr, '/runs/1/cards/check', { variationId: 'V_CRACKER', cardId: String(card.id), version: String(card.version) })).statusCode, 400, 'the box must be ticked');
  assert.equal((await decide(s, mgr, '/runs/1/cards/check', { variationId: 'V_CRACKER', cardId: String(card.id), version: String(card.version), confirm: '1' })).statusCode, 303);
  assert.equal(generated(s)[0]!.checked_version, card.version);
  assert.equal(runState(s), 'ready');

  await decide(s, mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  assert.equal(runState(s), 'dry_run_done');
  const p = JSON.parse((s.app.shelf.db.prepare('SELECT dry_run FROM runs WHERE id = 1').get() as { dry_run: string }).dry_run);
  assert.equal(p.cards.cards.length, 3);
  const cracker = p.cards.cards.find((c: any) => c.variationId === 'V_CRACKER');
  assert.deepEqual(cracker.record.copy, [CRACKER.paragraph1, CRACKER.paragraph2]);
  assert.equal(cracker.record.price, '$6.99');
  assert.equal(cracker.record.eyebrow, '03 / CRACKERS');
  assert.equal(cracker.record.code, '');
  const gouda = p.cards.cards.find((c: any) => c.variationId === 'V_GOUDA');
  assert.equal(gouda.record.code, '7101');
  assert.equal(gouda.record.unit, 'PER POUND');
  assert.equal(gouda.record.price, '$13.99');
  body = await page(s, mgr, '/runs/1/dry-run');
  assert.match(body, /Cards that would print \(3\)/);
  assert.match(body, /Crisp and plain\. Good with a soft cheese or a slice of ham\./);

  // An edit after the dry run needs a new check, and the dry run is gone.
  const c2 = generated(s)[0]!;
  assert.equal((await decide(s, mgr, '/runs/1/cards/edit', editFields({ variationId: 'V_CRACKER', cardId: c2.id, version: c2.version }))).statusCode, 303);
  assert.equal(runState(s), 'review');
  assert.equal(generated(s)[0]!.source, 'edited');
  assert.ok(blockers(s).some((b) => /must check this version/.test(b)));
  assert.equal(fake.calls.length, 1, 'nothing more was paid for');
});

test('a guard-blocked card cannot print until edited, and an edit may not add a price or break a limit', async (t) => {
  const priced = modelCard({ ...CRACKER, paragraph2: 'Sold here for $4.99 a box.' });
  const fake = fakeCopyClient([reply(answer({ card: priced })), retryReply(priced)]);
  const s = await copyApp(fake);
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  await settle(s, mgr);
  const card = generated(s)[0]!;
  assert.notEqual(card.blocked, '[]');
  assert.ok(blockers(s).some((b) => /Blocked until edited: The card has a money amount/.test(b)));
  const ids = { variationId: 'V_CRACKER', cardId: card.id, version: card.version };
  let res = await decide(s, mgr, '/runs/1/cards/edit', editFields(ids, { p2: 'Now 3.50 USD a box.' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Not saved\. The card has a money amount/);
  res = await decide(s, mgr, '/runs/1/cards/edit', editFields(ids, { producer: 'Bluecrest Bakery and Biscuit Company of the Northern Hills · Testville' }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /Not saved\. The producer line is \d+ characters/);
  res = await decide(s, mgr, '/runs/1/cards/edit', editFields(ids, { p2: 'Crisp and plain.​ Good with ham.', eyebrow: 'NOT A CATEGORY' }));
  assert.equal(res.statusCode, 400, 'the category comes from the config');
  res = await decide(s, mgr, '/runs/1/cards/edit', editFields(ids, { p2: 'Crisp and plain.​ Good with ham.' }));
  assert.equal(res.statusCode, 303);
  const after = generated(s)[0]!;
  assert.equal(after.blocked, '[]');
  assert.equal(JSON.parse(after.content).copy[1], 'Crisp and plain. Good with ham.', 'edits go through cleanText');
  assert.equal(JSON.parse(after.content).n1, 'Sea Salt ');
  assert.ok(blockers(s).some((b) => /must check this version/.test(b)), 'still needs a check');
  assert.ok(!blockers(s).some((b) => /Blocked until edited/.test(b)));
  // Someone else's newer edit is not overwritten.
  res = await decide(s, mgr, '/runs/1/cards/edit', editFields(ids));
  assert.equal(res.statusCode, 409);
});

test('a written card out of limits blocks until a person brings it within them', async (t) => {
  const long = modelCard({ ...CRACKER, paragraph1: 'Thin crackers baked with flour and oil. '.repeat(10).trim() });
  const fake = fakeCopyClient([reply(answer({ card: long })), retryReply(long)]);
  const s = await copyApp(fake);
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  await settle(s, mgr);
  assert.equal(copyRow(s, 'V_CRACKER')!.state, 'review');
  assert.ok(blockers(s).some((b) => /Out of limits: The paragraphs run to \d+ characters/.test(b)));
  const card = generated(s)[0]!;
  const ids = { variationId: 'V_CRACKER', cardId: card.id, version: card.version };
  // Still too long, but shorter: saved on the way, still blocked.
  assert.equal((await decide(s, mgr, '/runs/1/cards/edit', editFields(ids, { p1: 'Thin crackers baked with flour and oil. '.repeat(9).trim() }))).statusCode, 303);
  assert.ok(blockers(s).some((b) => /Out of limits/.test(b)));
  const c2 = generated(s)[0]!;
  assert.equal((await decide(s, mgr, '/runs/1/cards/edit', editFields({ ...ids, version: c2.version }))).statusCode, 303);
  assert.ok(!blockers(s).some((b) => /Out of limits/.test(b)));
});

test('lines where nothing arrived make no card and pay for no copy', async (t) => {
  const inv = testInvoice();
  inv.lines[1] = { ...inv.lines[1]!, printed_status: 'out_of_stock', qty_shipped: '0', extension: '0.00' };
  inv.total = '135.00';
  const fake = fakeCopyClient([]);
  const s = await copyApp(fake, { inv });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  assert.equal(fake.counts.length + fake.calls.length, 0);
  await settle(s, mgr);
  assert.equal(runState(s), 'ready');
  const body = await page(s, mgr);
  assert.match(body, /No card: nothing arrived\./);
  assert.match(body, /Cards \(2\)/);
  await decide(s, mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  const p = JSON.parse((s.app.shelf.db.prepare('SELECT dry_run FROM runs WHERE id = 1').get() as { dry_run: string }).dry_run);
  assert.deepEqual(p.cards.cards.map((c: any) => c.variationId).sort(), ['V_GOUDA', 'V_SALMON']);
  assert.equal(copyRow(s, 'V_CRACKER'), undefined);
});

test('a stored card that may match is confirmed or rejected by a person, and a card can be left out', async (t) => {
  const fake = fakeCopyClient([]);
  const s = await copyApp(fake, { except: ['V_GOUDA'] });
  t.after(() => s.close());
  const actor = { userId: null, username: 'test' };
  const maybe = (n2: string, slot: number) =>
    insertImportedCard(s.app.shelf.db, actor, {
      code: '',
      price: '$9.99',
      unit: 'PER POUND',
      origin: 'PRODUCT OF TESTLAND',
      eyebrow: '01 / CHEESE',
      n1: 'Smoked ',
      n2,
      producer: 'Test Dairy · Testville',
      specs: [['MILK', 'Cow'], ['AGE', 'Young'], ['CUT', 'Whole']],
      copy: ['An invented first paragraph.', 'An invented second paragraph.'],
      source: { file: 'old.docx', created: '2026-01-01T00:00:00.000Z', sheet: 9, slot, mark: 'C&C', tagline: 'Test tagline.' },
    }).id;
  const first = maybe('Gouda Wheel', 1);
  const second = maybe('Gouda Round', 2);
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  await settle(s, mgr);
  assert.equal(fake.counts.length, 0, 'no copy is written while a stored card may match');
  assert.ok(blockers(s).some((b) => /Card for Gouda Smoked 7101: A stored card may be this product/.test(b)));
  assert.match(await page(s, mgr), /Yes, this is the product/);
  assert.equal((await decide(s, mgr, '/runs/1/cards/confirm', { variationId: 'V_GOUDA', cardId: '999' })).statusCode, 400);
  assert.equal((await decide(s, mgr, '/runs/1/cards/reject', { variationId: 'V_GOUDA', cardId: String(second) })).statusCode, 303);
  assert.ok(s.app.shelf.db.prepare("SELECT 1 FROM card_link_rejections WHERE card_id = ? AND variation_id = 'V_GOUDA'").get(second), 'remembered, so it is not asked again');
  assert.equal((await decide(s, mgr, '/runs/1/cards/confirm', { variationId: 'V_GOUDA', cardId: String(first) })).statusCode, 303);
  assert.equal((s.app.shelf.db.prepare("SELECT card_id FROM card_links WHERE variation_id = 'V_GOUDA'").get() as { card_id: number }).card_id, first);
  assert.equal(runState(s), 'ready');
  // A card left out does not print and blocks nothing.
  assert.equal((await decide(s, mgr, '/runs/1/cards/leave-out', { variationId: 'V_GOUDA' })).statusCode, 303);
  assert.equal(runState(s), 'ready');
  assert.match(await page(s, mgr), /Left out of this run/);
  await decide(s, mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  const p = JSON.parse((s.app.shelf.db.prepare('SELECT dry_run FROM runs WHERE id = 1').get() as { dry_run: string }).dry_run);
  assert.equal(p.cards.cards.some((c: any) => c.variationId === 'V_GOUDA'), false);
  assert.equal(p.cards.leftOut[0].variationId, 'V_GOUDA');
  assert.equal((await decide(s, mgr, '/runs/1/cards/leave-out', { variationId: 'V_GOUDA', leaveOut: '0' })).statusCode, 303);
  assert.equal(runState(s), 'ready', 'back in, and it prints');
  assert.equal(fake.calls.length, 0);
});

test('card routes: roles, CSRF and ids from another run', async (t) => {
  const fake = fakeCopyClient([reply(answer({ card: CRACKER }))]);
  const s = await copyApp(fake);
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr, 1);
  await s.app.shelf.runner.drain();
  await uploadPhoto(s, mgr, 2);
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 1, 'the second run uses the card the first one wrote');
  await settle(s, mgr, 1);
  await settle(s, mgr, 2);
  // Run 1 leaves the crackers out, so their card is not part of run 1.
  await decide(s, mgr, '/runs/1/lines/2/skip', { skip: '1' });
  const card = generated(s)[0]!;
  const good = { variationId: 'V_CRACKER', cardId: String(card.id), version: String(card.version), confirm: '1' };
  let res = await decide(s, mgr, '/runs/1/cards/check', good);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /That item has no card on this invoice/);
  assert.equal((await decide(s, mgr, '/runs/1/cards/edit', editFields({ variationId: 'V_CRACKER', cardId: card.id, version: card.version }))).statusCode, 400);
  // Another card's id with this run's item.
  const other = (s.app.shelf.db.prepare("SELECT card_id FROM card_links WHERE variation_id = 'V_GOUDA'").get() as { card_id: number }).card_id;
  res = await decide(s, mgr, '/runs/2/cards/check', { ...good, cardId: String(other) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /not the one this invoice shows/);
  // No CSRF token, or no session: nothing changes.
  res = await s.app.inject({ method: 'POST', url: '/runs/2/cards/check', headers: { cookie: mgr.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(good).toString() });
  assert.equal(res.statusCode, 403);
  res = await s.app.inject({ method: 'POST', url: '/runs/2/cards/check', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ ...good, _csrf: mgr.csrf }).toString() });
  assert.notEqual(res.statusCode, 303);
  assert.equal(generated(s)[0]!.checked_version, 0);
  // A manager cannot approve copy cost.
  assert.equal((await decide(s, mgr, '/runs/2/cards/approve-cost', { variationId: 'V_CRACKER', model: 'claude-sonnet-5-5', usd: '9.99' })).statusCode, 403);
  // The real check, audited with the run and the person.
  assert.equal((await decide(s, mgr, '/runs/2/cards/check', good)).statusCode, 303);
  const a = s.app.shelf.db.prepare("SELECT username, run_id FROM audit_log WHERE action = 'run.card.check'").get() as { username: string; run_id: number };
  assert.deepEqual({ ...a }, { username: 'mgr', run_id: 2 });
});

test('a restart while copy or a reading is under way does not pay again, and keeps the worst case counted', async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const deps = (client: CopyModelClient) => ({ modelClient: modelFor(testInvoice()), catalogSource: fakeCatalogSource(), squareWriter: failingWriter(), startRunner: false, cardCopy: stage(client) });
  const noKey: CopyModelClient = {
    countTokens: async () => {
      throw new ModelCallError('authentication', 'No Claude API key is set.', null, null);
    },
    call: async () => {
      throw new Error('not called');
    },
  };
  const a = await makeAppWith({ scaleNames: SCALES }, deps(noKey), dir);
  await seedCards(a.app.shelf.db, fakeCatalogSource(), ['V_CRACKER']);
  const mgr = await signIn(a);
  await uploadPhoto(a, mgr);
  await a.app.shelf.runner.drain();
  assert.equal(copyRow(a, 'V_CRACKER')!.state, 'failed');
  assert.match(await page(a, mgr), /No Claude API key is set\./);
  const readBooked = spend(a, 'read');
  assert.ok(readBooked > 0 && readBooked < 1, 'the reading is booked at its real cost, not its worst case');
  // As if the server died during a paid copy call and another run's reading: both marked under
  // way at their worst case, the job running.
  a.app.shelf.db.exec("UPDATE run_copy SET state = 'calling'");
  a.app.shelf.db.prepare("INSERT INTO model_spend (run_id, kind, variation_id, state, usd, estimate, at, updated_at) VALUES (1, 'copy', 'V_CRACKER', 'reserved', 0.9, 1, ?, ?)").run(START, START);
  a.app.shelf.db.prepare("INSERT INTO model_spend (run_id, kind, state, usd, estimate, at, updated_at) VALUES (1, 'read', 'reserved', 1, 1, ?, ?)").run(START, START);
  a.app.shelf.db.prepare("INSERT INTO run_jobs (run_id, kind, state, resume_approved, created_at, started_at) VALUES (1, 'process', 'running', 0, ?, ?)").run(START, START);
  await a.app.close();

  const fake = fakeCopyClient([reply(answer({ card: CRACKER }))]);
  const b = await makeAppWith({ scaleNames: SCALES }, deps(fake), dir);
  t.after(() => b.app.close());
  await b.app.shelf.runner.drain();
  assert.equal(fake.calls.length + fake.counts.length, 0, 'not sent again on its own');
  assert.equal(copyRow(b, 'V_CRACKER')!.state, 'interrupted');
  // Nothing is left reserved, and the worst cases stay counted in both budgets.
  assert.equal((b.app.shelf.db.prepare("SELECT count(*) AS n FROM model_spend WHERE state = 'reserved'").get() as { n: number }).n, 0);
  assert.equal(spend(b, 'copy'), 0.9);
  assert.equal(Math.round((spend(b, 'read') - readBooked) * 100), 100);
  assert.equal(Math.round(spendSince(b.app.shelf.db, 0) * 1e6), Math.round((spend(b, 'copy') + spend(b, 'read')) * 1e6));
  const m2 = await signIn(b);
  assert.match(await page(b, m2), /restarted while writing this card/);
  assert.equal((await decide(b, m2, '/runs/1/cards/write', { variationId: 'V_CRACKER' })).statusCode, 303);
  assert.equal((await decide(b, m2, '/runs/1/cards/write', { variationId: 'V_CRACKER' })).statusCode, 409, 'queued once');
  await b.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 1);
  assert.equal(copyRow(b, 'V_CRACKER')!.state, 'written');
  assert.ok(spend(b, 'copy') > 0.9, 'every copy call of the run counts, the cut-short one too');
});

test('Write copy now writes only that card, and the run budget adds up every copy call', async (t) => {
  const fake = fakeCopyClient([reply(answer()), reply(answer())]);
  const s = await copyApp(fake, { except: ['V_GOUDA', 'V_SALMON'] });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  await settle(s, mgr);
  assert.equal(fake.calls.length, 0, 'the first pass ran before the picks');
  assert.equal((await decide(s, mgr, '/runs/1/cards/write', { variationId: 'V_GOUDA' })).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 1);
  assert.equal(copyRow(s, 'V_GOUDA')!.state, 'written');
  assert.equal(copyRow(s, 'V_SALMON'), undefined, 'the other card was not written');
  const first = spend(s, 'copy');
  assert.equal((await decide(s, mgr, '/runs/1/cards/write', { variationId: 'V_SALMON' })).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 2);
  const both = spend(s, 'copy');
  assert.ok(both > first * 1.9, 'both calls count');
  const row = s.app.shelf.db.prepare("SELECT coalesce(sum(json_extract(details, '$.totalCostUsd')), 0) AS usd FROM audit_log WHERE action = 'run.copy' AND run_id = 1").get() as { usd: number };
  assert.equal(Math.round(both * 1e6), Math.round(row.usd * 1e6));
  assert.match(await page(s, mgr), new RegExp(`card copy budget of \\$5\\.00 has \\$${(5 - both).toFixed(2).replace('.', '\\.')} left`));
});

test('cards past the copy budget wait for one admin approval of all of them, with a recent password, used once', async (t) => {
  const fake = fakeCopyClient([reply(answer()), reply(answer())]);
  const s = await copyApp(fake, { except: ['V_GOUDA', 'V_SALMON'] });
  t.after(() => s.close());
  // The copy budget is its own setting, apart from the reading's cap.
  s.app.shelf.settings.update({ values: { cardCopyCapUsd: '0.10' } }, { userId: null, username: 'test' });
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  await settle(s, mgr);
  assert.equal((await decide(s, mgr, '/runs/1/cards/write', { all: '1' })).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 0, 'nothing is sent past the budget');
  const g = copyRow(s, 'V_GOUDA')!;
  const m = copyRow(s, 'V_SALMON')!;
  assert.equal(g.state, 'needs_approval');
  assert.equal(m.state, 'needs_approval');
  const total = ((Math.round(Number(g.approval_usd) * 100) + Math.round(Number(m.approval_usd) * 100)) / 100).toFixed(2);
  let body = await page(s, mgr);
  assert.match(body, new RegExp(`2 cards wait for a cost approval: up to \\$${total.replace('.', '\\.')} in all`));
  assert.match(body, /This invoice&#39;s card copy budget is what ran out\./);
  assert.match(body, /Ask an admin to approve them/);
  assert.doesNotMatch(body, /cards\/approve-cost/);
  const admin = await signIn(s, 'admin');
  body = await page(s, admin);
  const fp = /name="fingerprint" value="([0-9a-f]+)"/.exec(body)![1]!;
  const shown = { model: 'claude-sonnet-5-5', totalUsd: total, fingerprint: fp };
  assert.equal((await decide(s, mgr, '/runs/1/cards/approve-cost', shown)).statusCode, 403);
  // An old password: nothing changes until the admin types it again.
  ageReauth(s, 16 * 60_000);
  let res = await decide(s, admin, '/runs/1/cards/approve-cost', shown);
  assert.equal(res.statusCode, 403);
  assert.match(res.body, /Confirm your password/);
  assert.equal(copyRow(s, 'V_GOUDA')!.state, 'needs_approval');
  const fresh = await signIn(s, 'admin');
  assert.equal((await decide(s, fresh, '/runs/1/cards/approve-cost', { ...shown, totalUsd: '99.00' })).statusCode, 409, 'the browser cannot pick the total');
  assert.equal((await decide(s, fresh, '/runs/1/cards/approve-cost', { ...shown, fingerprint: 'f'.repeat(32) })).statusCode, 409);
  res = await decide(s, fresh, '/runs/1/cards/approve-cost', shown);
  assert.equal(res.statusCode, 303);
  assert.equal(copyRow(s, 'V_GOUDA')!.state, 'approved');
  assert.equal(copyRow(s, 'V_SALMON')!.state, 'approved');
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 2);
  assert.equal(copyRow(s, 'V_GOUDA')!.state, 'written');
  assert.equal(copyRow(s, 'V_SALMON')!.state, 'written');
  // Used once: the same approval again finds nothing waiting.
  assert.equal((await decide(s, fresh, '/runs/1/cards/approve-cost', shown)).statusCode, 409);
  const audits = s.app.shelf.db.prepare("SELECT username, details FROM audit_log WHERE action = 'run.copy_cost_approved'").all() as Array<{ username: string; details: string }>;
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.username, 'bart');
  assert.equal(JSON.parse(audits[0]!.details).totalUsd, total);
  assert.equal(JSON.parse(audits[0]!.details).cards.length, 2);
  const gen = s.app.shelf.db.prepare("SELECT details FROM audit_log WHERE action = 'card_generate'").get() as { details: string };
  assert.equal(JSON.parse(gen.details).approvedBy, 'bart');
});

test('when the daily limit is the lower one, cards wait the same way and the page says so', async (t) => {
  const fake = fakeCopyClient([]);
  // The reading's own cap must fit under the daily limit, or the reading itself waits (runner.ts).
  const s = await makeRunApp({ cardsExcept: ['V_GOUDA'], settings: { dailyLimitUsd: '0.20', invoiceCostCapUsd: '0.10' }, deps: { cardCopy: stage(fake) } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  await settle(s, mgr);
  await decide(s, mgr, '/runs/1/cards/write', { variationId: 'V_GOUDA' });
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 0);
  assert.equal(copyRow(s, 'V_GOUDA')!.state, 'needs_approval');
  const body = await page(s, mgr);
  assert.match(body, /The daily limit for readings and card copy is what ran out\./);
  assert.match(body, /The daily limit of \$0\.20 for readings and card copy together has \$0\.\d\d left/);
});

test('with no cards stored yet, copy is written only when a person asks', async (t) => {
  const fake = fakeCopyClient([reply(answer({ card: CRACKER }))]);
  const s = await makeRunApp({ cards: false, deps: { cardCopy: stage(fake) } });
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  assert.equal(fake.counts.length + fake.calls.length, 0);
  assert.match(await page(s, mgr), /No cards are stored yet, so no copy is written on its own/);
  assert.equal((await decide(s, mgr, '/runs/1/cards/write', { variationId: 'V_CRACKER' })).statusCode, 303);
  await s.app.shelf.runner.drain();
  assert.equal(fake.calls.length, 1);
});
