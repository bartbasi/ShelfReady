// Card copy for one run: each product looked up once, stored copy used, a possible match left
// for a person, new copy only where there is none and something arrived, and the run's copy done
// only when no card waits for a person. Fake model client, invented data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importCards } from '../src/copy/import.ts';
import { copyForRun, invoiceFactsFromLine } from '../src/copy/run.ts';
import { buildCopySettings } from '../src/copy/settings.ts';
import { markCardChecked } from '../src/copy/store.ts';
import { line } from './invoice-fixtures.ts';
import { ACTOR, answer, CATALOG, CONFIG, db, fakeCopyClient, imported, NOW, PERSON, reply } from './copy-fixtures.ts';

function setup(responses = [reply(answer())]) {
  const d = db();
  importCards(d, ACTOR, CATALOG, { cards: [imported({ code: '7101', n1: 'Smoked ', n2: 'Gouda' }), imported({ n1: 'Fennel Salami ', n2: 'Picante', eyebrow: '02 / CURED MEAT' })] }, NOW);
  const client = fakeCopyClient(responses);
  return { d, client, deps: { db: d, client, settings: buildCopySettings(), config: CONFIG, actor: ACTOR, now: () => NOW } };
}

test('a run uses stored copy, asks about a possible match, writes only what is missing, and skips what did not arrive', async () => {
  const { client, deps } = setup();
  const facts = invoiceFactsFromLine(line({ description: 'CHEDDAR AGED 12MO', brand: 'HILLTOP' }), 'Test Foods');
  assert.equal(facts.description, 'CHEDDAR AGED 12MO');
  const out = await copyForRun(
    deps,
    CATALOG,
    [
      { variationId: 'V_GOUDA', invoice: null, arrived: 'all' },
      { variationId: 'V_GOUDA', invoice: null, arrived: 'all' },
      { variationId: 'V_SALAMI', invoice: null, arrived: 'all' },
      { variationId: 'V_CHEDDAR', invoice: facts, arrived: 'some' },
      { variationId: 'V_TURKEY', invoice: null, arrived: 'none' },
      { variationId: 'V_GONE', invoice: null, arrived: 'all' },
    ],
    { totalCapUsd: 1, generate: true },
  );
  assert.deepEqual(out.lines.map((l) => [l.variationId, l.state]), [
    ['V_GOUDA', 'stored'],
    ['V_SALAMI', 'confirm'],
    ['V_CHEDDAR', 'generated'],
    ['V_TURKEY', 'not_arrived'],
    ['V_GONE', 'not_in_catalog'],
  ]);
  assert.equal(client.calls.length, 1, 'only the product with nothing stored is written');
  assert.equal(out.lines[3]!.lookup, null, 'nothing is even looked up for a line where nothing arrived');
  assert.equal(out.status, 'needs_review');
  assert.match(out.lines[2]!.waitingFor.join(' '), /A person must check this version/);
  assert.match(out.message, /^Card copy: 1 stored, 1 written new, 1 with a stored card to confirm, 1 not in the catalog, 1 that did not arrive, so no card; 3 waiting for a person, \$0\.\d\d spent\.$/);
});

test('a freshly written card never makes the run done, even with an empty verify list', async () => {
  const { deps } = setup([reply(answer({ verify: [] }))]);
  const out = await copyForRun(deps, CATALOG, [{ variationId: 'V_CHEDDAR', invoice: null, arrived: 'all' }], { totalCapUsd: 1, generate: true });
  assert.equal(out.lines[0]!.state, 'generated');
  assert.equal(out.lines[0]!.generated!.card!.review!.verify.length, 0);
  assert.equal(out.status, 'needs_review');
  // Once a person checks it, the next run counts it as done.
  markCardChecked(deps.db, PERSON, out.lines[0]!.generated!.card!.id, 1, NOW);
  const next = await copyForRun(deps, CATALOG, [{ variationId: 'V_CHEDDAR', invoice: null, arrived: 'all' }], { totalCapUsd: 1, generate: true });
  assert.equal(next.lines[0]!.state, 'stored');
  assert.equal(next.status, 'done');
});

test('no copy is written while arrival is unsettled, or when writing is off', async () => {
  const { client, deps } = setup();
  const unsettled = await copyForRun(deps, CATALOG, [{ variationId: 'V_CHEDDAR', invoice: null, arrived: 'unclear' }], { totalCapUsd: 1, generate: true });
  assert.equal(unsettled.lines[0]!.state, 'not_generated');
  assert.match(unsettled.lines[0]!.waitingFor.join(' '), /What arrived is not settled/);
  const off = await copyForRun(deps, CATALOG, [{ variationId: 'V_TURKEY', invoice: null, arrived: 'all' }], { totalCapUsd: 1, generate: false });
  assert.equal(off.lines[0]!.state, 'not_generated');
  assert.equal(client.calls.length, 0);
  // Two lines of one product: arrived when either did.
  const both = await copyForRun(deps, CATALOG, [
    { variationId: 'V_GOUDA', invoice: null, arrived: 'none' },
    { variationId: 'V_GOUDA', invoice: null, arrived: 'all' },
  ], { totalCapUsd: 1, generate: false });
  assert.deepEqual(both.lines.map((l) => l.state), ['stored']);
  assert.equal(both.status, 'done', 'an imported card linked surely needs nothing from a person');
});
