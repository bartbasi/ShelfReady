import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_PW, addUser, get, login } from './server-helpers.ts';
import { decide, makeRunApp, runState, signIn, uploadPhoto } from './runs-fixtures.ts';
import { dryRunPage, runListPage, runPage, searchPage, uploadPage } from '../src/server/views/run-pages.ts';
import type { SessionUser } from '../src/auth/sessions.ts';
import type { CardView, DryRunView, LineView, ReviewView } from '../src/runs/review.ts';
import type { RunState } from '../src/runs/states.ts';
import { STATE_LABELS } from '../src/runs/states.ts';

// Page tests for the run pages. Most build the view model by hand, so every state and every place
// model text can land is covered without a run. A few use the real app to check the wiring.

// Breaks out of a quoted attribute and a tag, if anything lets it.
const EVIL = `"'><img src=x onerror=alert(1)>`;

/** Nothing from the data became a tag, an attribute or a way out of one. */
function assertSafe(body: string, where: string): void {
  assert.doesNotMatch(body, /<img/i, where);
  assert.ok(!body.includes('"\'>'), `${where}: a quote and bracket from the data came through raw`);
  // Take the quoted attribute values out of each tag. What is left must hold no handler.
  for (const m of body.matchAll(/<[a-z][^>]*>/gi)) assert.doesNotMatch(m[0].replace(/="[^"]*"/g, '=""'), /\son[a-z]+\s*=|alert\(/i, `${where}: ${m[0]}`);
  assert.doesNotMatch(body, /<script(?![^>]*\ssrc="\/static\/js\/)/i, where);
  assert.doesNotMatch(body, /\sstyle=/i, where);
}
const user = (role: 'manager' | 'admin'): SessionUser => ({ userId: 1, username: 'u', displayName: '', role, csrfToken: 'tok', mustChangePassword: false }) as SessionUser;

function line(n: number, over: Partial<LineView> = {}): LineView {
  return {
    n,
    anchor: `line-${n}`,
    printed: { itemNumber: 'G100', upc: '012345678905', description: `Gouda ${n}`, brand: 'Hilltop', pack: '12/4 oz', qtyShipped: '2', unit: 'CS', weight: '', unitPrice: '$6.00', allowance: '', extension: '$12.00' },
    flags: [],
    outcome: 'send',
    outcomeLabel: 'Will update Square',
    match: { label: 'Gouda Smoked 7101', how: 'UPC', reasons: [], picked: false },
    candidates: [],
    possibleMisread: false,
    warnings: [],
    byWeightProblems: [],
    arrival: { arrived: 'all', source: 'default', toConfirm: false, pieces: null, pounds: null, askPounds: false },
    pack: null,
    bigChange: null,
    stock: { text: '24', unit: 'units', how: 'Two cases of 12.' },
    price: { status: 'priced', old: '$5.99', next: '$6.99', change: '+$1.00', formula: '(cost + 0.00) x 2 + 1.00', formulaPrice: '$6.99', costHow: 'Cost $3.00 per unit.', override: '', flags: [], switchToWeight: false, reason: null },
    overrideQuestion: null,
    conflict: null,
    rename: null,
    card: { anchor: 'card-1', status: 'Prints as shown' },
    skipped: false,
    notForResale: false,
    ...over,
  };
}

function card(over: Partial<CardView> = {}): CardView {
  return {
    anchor: 'card-1',
    variationId: 'V1',
    label: 'Gouda Smoked 7101',
    lines: [1],
    leftOut: false,
    source: 'generated',
    sourceLabel: 'Written by the model',
    status: 'Needs a person to check it',
    waitingFor: ['Check it'],
    printed: { eyebrow: 'CHEESE', origin: 'Product of Holland', n1: 'Smoked ', n2: 'Gouda', producer: 'Maker · Place', specs: [{ label: 'MILK', value: 'Cow' }], copy: ['A plain card.'], price: '$6.99', unit: 'PER POUND', code: '7101' },
    cardId: 4,
    version: 2,
    edit: { origin: 'Product of Holland', eyebrow: 'CHEESE', n1: 'Smoked', n2: 'Gouda', producer: 'Maker · Place', specs: [{ label: 'MILK', value: 'Cow' }], paragraphs: ['A plain card.', ''], unit: 'PER POUND', categories: ['CHEESE', 'CRACKERS'] },
    needsCheck: true,
    checkedVersion: 0,
    checkList: [{ kind: 'claim', text: 'Aged 12 months', from: 'raised by the model' }],
    sources: [{ title: 'Maker page', host: 'maker.example', url: 'https://maker.example/gouda', usedFor: 'origin' }],
    searches: [{ query: 'smoked gouda', results: 3, error: '' }],
    problems: [],
    styleNotes: [],
    blocked: [],
    written: { model: 'claude-test', cost: '$0.20', at: '2026-11-07 10:00 UTC', productIdentified: true, sellingPoint: 'Smoked over beech' },
    runCost: '$0.20',
    suggestions: [],
    pendingApproval: null,
    copyState: 'done',
    canWrite: false,
    pendingLink: false,
    ...over,
  };
}

function view(over: Partial<ReviewView> & { state?: RunState; working?: boolean } = {}): ReviewView {
  const state = over.state ?? 'review';
  const working = over.working ?? false;
  const v: ReviewView = {
    header: {
      id: 7,
      state,
      stateLabel: STATE_LABELS[state],
      createdByName: 'mgr',
      createdAt: '2026-11-07 10:00 UTC',
      message: '',
      working,
      canDecide: ['review', 'ready', 'dry_run_done'].includes(state) && !working,
      canReadAgain: state === 'retry',
      canStop: !['approved', 'done', 'failed'].includes(state),
    },
    files: [{ id: 1, position: 1, name: 'page1.jpg', kind: 'jpeg', bytes: 2048, inline: true }],
    events: [{ at: '2026-11-07 10:00 UTC', stage: 'upload', message: 'Uploaded.' }],
    pendingCost: null,
    catalog: { label: 'sandbox', takenAt: '2026-11-07T09:00:00Z' },
    reading: {
      status: 'ok',
      model: 'claude-test',
      cost: '$0.05',
      reasons: [],
      notices: [],
      checks: [{ id: 'sum', passed: true, blocking: true, message: 'Lines add up.', details: [] }],
      failedChecks: [],
      supplierPrinted: 'Hilltop Provisions',
      invoiceNumber: 'INV-1',
      invoiceDate: '11/05/26',
      total: '$12.00',
      attempts: [{ role: 'First reading', model: 'claude-test', outcome: 'ok', cost: '$0.05' }],
    },
    supplier: { status: 'known', name: 'Hilltop Provisions', vendor: 'Default formula' },
    lines: [line(1)],
    credits: [],
    creditTotal: '$0.00',
    claim: null,
    catalogNotes: [],
    stale: [],
    vendorClash: null,
    blockers: [],
    cards: [card()],
    cardsSummary: { total: 1, prints: 0, waiting: 1, leftOut: 0, canWrite: 0, spent: '$0.20', budget: '' },
    copyApproval: null,
    decisionsCount: 0,
    decisions: [],
    bigChanges: { total: 0, toTick: 0, percent: 30 },
    sameFiles: [],
    dryRun: null,
    ...over,
  } as ReviewView;
  return v;
}

const page = (v: ReviewView, role: 'manager' | 'admin' = 'manager', extra: { error?: string; notice?: string } = {}): string => runPage({ user: user(role), view: v, ...extra });

test('every state says in plain words where the invoice is, and which step it is on', () => {
  const cases: Array<[RunState, string, string]> = [
    ['uploaded', 'Waiting its turn', 'Upload'],
    ['reading', 'Reading the invoice', 'Read'],
    ['needs_approval', 'Waiting for an admin', 'Read'],
    ['retry', 'Could not read it yet', 'Read'],
    ['review', 'Needs you', 'Review'],
    ['ready', 'Ready for a dry run', 'Review'],
    ['dry_run_done', 'Dry run done', 'Dry run'],
    ['approved', 'Approved', 'Approved'],
    ['sending', 'Sending', 'Approved'],
    ['done', 'Done', 'Approved'],
    ['partial', 'Partly sent', 'Approved'],
    ['failed', 'Stopped', ''],
  ];
  for (const [state, head, step] of cases) {
    const body = page(view({ state }));
    assert.match(body, new RegExp(`<h2 id="progress-h">${head}</h2>`), state);
    assert.match(body, new RegExp(`<span class="tag tag-[a-z]+">${STATE_LABELS[state].replace(/\./g, '\\.')}</span>`), state);
    if (step) assert.match(body, new RegExp(`<li class="is-now" aria-current="step">${step}`), state);
    else assert.doesNotMatch(body, /is-now/, state);
  }
  // Safe to leave: the page says so while it works, and refreshes itself.
  for (const state of ['uploaded', 'reading'] as RunState[]) {
    const body = page(view({ state, working: true }));
    assert.match(body, /You can leave and come back/);
    assert.match(body, /<meta http-equiv="refresh" content="5">/);
  }
  assert.doesNotMatch(page(view({ state: 'review' })), /http-equiv="refresh"/);
  assert.match(page(view({ state: 'ready', working: true })), /<h2 id="progress-h">Working<\/h2>/);
});

test('all four reading results are shown for what they are', () => {
  const want: Record<string, RegExp> = {
    ok: /tag tag-ok">Read cleanly</,
    review: /tag tag-wait">Read, but a person must look</,
    needs_approval: /tag tag-stop">Waiting for an admin to approve the cost</,
    retry: /tag tag-stop">Could not be read</,
  };
  for (const [status, re] of Object.entries(want)) {
    const v = view();
    v.reading!.status = status;
    v.reading!.reasons = status === 'ok' ? [] : ['One line was hard to read.'];
    const body = page(v);
    assert.match(body, re, status);
    if (status !== 'ok') assert.match(body, /<details open><summary>Why a person must look<\/summary>.*One line was hard to read\./s, status);
  }
  // A state the page does not know is shown as it is, escaped, never trusted.
  const odd = view();
  odd.reading!.status = EVIL;
  assert.doesNotMatch(page(odd), /<img/);
});

test('the pending cost approval shows to an admin as a button and to a manager as a request', () => {
  const v = view({ state: 'needs_approval', pendingCost: { model: 'claude-opus-5-5', estimateUsd: '1.40', message: 'This reading could cost $1.40.' }, reading: null, lines: [], cards: [], supplier: null, cardsSummary: { total: 0, prints: 0, waiting: 0, leftOut: 0, canWrite: 0, spent: '$0.00', budget: '' } });
  const admin = page(v, 'admin');
  assert.match(admin, /action="\/runs\/7\/approve-cost"/);
  assert.match(admin, /Approve up to \$1\.40 with claude-opus-5-5/);
  const mgr = page(v, 'manager');
  assert.doesNotMatch(mgr, /approve-cost/);
  assert.match(mgr, /Ask an admin to approve it/);
  assert.match(mgr, /This reading could cost \$1\.40\./);
});

test('a retry offers Read again, and a clean read does not', () => {
  assert.match(page(view({ state: 'retry', reading: null, lines: [], cards: [], supplier: null })), /action="\/runs\/7\/read-again"/);
  assert.doesNotMatch(page(view({ state: 'ready' })), /read-again/);
});

test('blockers come first as a short checklist with jump links, and the sticky bar takes you to the first', () => {
  const v = view({
    lines: [line(1, { outcome: 'needs_match', outcomeLabel: 'Pick the Square item' }), line(2), line(3, { outcome: 'new_item', outcomeLabel: 'New item: not in Square' })],
    blockers: [
      { message: 'Line 1: pick the Square item.', anchor: 'line-1' },
      { message: 'Line 3: new item.', anchor: 'line-3' },
      { message: 'Choose the supplier.', anchor: null },
    ],
  });
  const body = page(v);
  assert.match(body, /<section class="todo" id="todo"[^>]*><h2 id="block-h">To settle before a dry run \(3\)<\/h2>/);
  assert.match(body, /<a href="#line-1">Line 1: pick the Square item\.<\/a>/);
  assert.match(body, /<a href="#line-3">Line 3: new item\.<\/a>/);
  assert.match(body, /<span class="todo-text">Choose the supplier\.<\/span>/);
  assert.ok(body.indexOf('block-h') < body.indexOf('id="lines-h"'), 'the checklist is above the lines');
  assert.match(body, /<div class="action-bar"><a class="button" href="#line-1">Next: 3 to settle<\/a><\/div>/);
  // Each target exists.
  for (const a of ['line-1', 'line-3']) assert.match(body, new RegExp(`<li class="line[^"]*" id="${a}">`));
});

test('ready: nothing blocks, and the dry run button is the sticky action', () => {
  const body = page(view({ state: 'ready' }));
  assert.match(body, /<h2 id="block-h">Nothing blocks<\/h2>/);
  assert.match(body, /<form method="post" action="\/runs\/7\/dry-run" class="action-bar">.*Make a dry run/s);
  // A person who cannot decide (work in progress) gets no button.
  assert.doesNotMatch(page(view({ state: 'ready', working: true })), /action="\/runs\/7\/dry-run"/);
  const done = page(view({ state: 'dry_run_done', dryRun: { at: '2026-11-07 11:00 UTC', hash: 'h' } }));
  assert.match(done, /<a class="button button-accent" href="\/runs\/7\/dry-run">See the dry run<\/a>/);
  assert.doesNotMatch(done, /<h2[^>]*>DRY RUN|banner-label/, 'the run page is not the dry run page');
});

test('a line is one card: invoice text, Square match, what arrived, price old to new with percent, the card', () => {
  const v = view({ lines: [line(1)] });
  const body = page(v);
  for (const label of ['On the invoice', 'Square match', 'What arrived', 'Price', 'Card']) assert.match(body, new RegExp(`<p class="block-label">${label}</p>`), label);
  assert.match(body, /Item G100\. UPC 012345678905\. Hilltop\. Pack 12\/4 oz\. Shipped 2 CS\. Price \$6\.00\. Amount \$12\.00\./);
  assert.match(body, /<p class="match-name">Gouda Smoked 7101<\/p><p class="hint">Matched by UPC\.<\/p>/);
  assert.match(body, /What arrived: All of it/);
  assert.match(body, /<span class="sr-only">Price: \$5\.99 now, \$6\.99\.<\/span>/);
  assert.match(body, /<span class="price-old" aria-hidden="true">\$5\.99<\/span>.*<span class="price-new" aria-hidden="true">\$6\.99<\/span>.*<span class="tag tag-mute">\+16%<\/span>/s);
  assert.match(body, /Card: <a href="#card-1">Prints as shown<\/a>/);
  assert.match(body, /Stock to set: 24 units/);
  // Not sold by weight: no callout.
  assert.doesNotMatch(body, /callout-weight/);
});

test('candidates show their score, method and reasons, and the possible misread is called out', () => {
  const v = view({
    lines: [
      line(1, {
        outcome: 'needs_match',
        outcomeLabel: 'Pick the Square item',
        match: null,
        price: null,
        stock: null,
        card: null,
        possibleMisread: true,
        candidates: [{ variationId: 'V_A', label: 'Gouda Smoked 7101', scorePercent: 94, method: 'name', reasons: ['Shares the words Gouda, Smoked.'] }],
      }),
    ],
    blockers: [{ message: 'Line 1: pick the Square item.', anchor: 'line-1' }],
  });
  const body = page(v);
  assert.match(body, /<ul class="candidates"><li><p><strong>Gouda Smoked 7101<\/strong> <span class="tag tag-mute">94% by name<\/span><\/p><p class="hint">Shares the words Gouda, Smoked\.<\/p>/);
  assert.match(body, /action="\/runs\/7\/lines\/1\/pick"/);
  assert.match(body, /The code on this line may be misread\. Check it against the paper invoice\./);
  assert.match(body, /No Square item chosen yet\./);
  assert.match(body, /<form method="get" action="\/runs\/7\/lines\/1\/search"/);
});

test('what arrived: all, none and some, in pieces or pounds, and a note to confirm stands out', () => {
  const some = page(view({ lines: [line(1, { arrival: { arrived: 'some', source: 'person', toConfirm: false, pieces: '18', pounds: null, askPounds: false } })] }));
  assert.match(some, /What arrived: Some, 18 pieces \(decided in review\)/);
  assert.match(some, /<label for="pc-1">Pieces that arrived<\/label>/);
  const lb = page(view({ lines: [line(1, { arrival: { arrived: 'some', source: 'person', toConfirm: false, pieces: null, pounds: '7.00', askPounds: true } })] }));
  assert.match(lb, /What arrived: Some, 7\.00 lb/);
  assert.match(lb, /<label for="lb-1">Pounds that arrived<\/label>/);
  const none = page(view({ lines: [line(1, { outcome: 'nothing_arrived', outcomeLabel: 'Nothing arrived: no change', price: null, stock: null, card: null, arrival: { arrived: 'none', source: 'invoice', toConfirm: false, pieces: null, pounds: null, askPounds: false } })], cards: [], cardsSummary: { total: 0, prints: 0, waiting: 0, leftOut: 0, canWrite: 0, spent: '$0.00', budget: '' } }));
  assert.match(none, /What arrived: None of it \(from the invoice\)/);
  assert.match(none, /No card: nothing arrived\./);
  const note = page(view({ lines: [line(1, { arrival: { arrived: 'none', source: 'note', toConfirm: true, pieces: null, pounds: null, askPounds: false } })] }));
  assert.match(note, /<p class="arrival to-confirm">What arrived: None of it \(from a note on the line, please confirm\)/);
  assert.match(note, /<details open><summary>Change what arrived/);
});

test('a big price change shows its percent and needs its own tick, and a confirmed one says so', () => {
  const big = (accepted: boolean) => ({ variationId: 'V1', percent: 67, up: true, overHalf: true, accepted, fromCents: 599, toCents: 999, text: 'Price goes up 67%, from $5.99 to $9.99. Over 50%: the scales will ask too.' });
  const open = page(view({ lines: [line(1, { bigChange: big(false), price: { ...line(1).price!, next: '$9.99' } })], bigChanges: { total: 1, toTick: 1, percent: 30 } }));
  assert.match(open, /<li class="line big-change over-half" id="line-1">/);
  assert.match(open, /tag tag-stop">Big change \+67%</);
  assert.match(open, /<span class="tag tag-stop">\+67%<\/span>/);
  assert.match(open, /action="\/runs\/7\/big-change"/);
  assert.match(open, /Yes, this 67% change is right/);
  assert.match(open, /1 price moves more than 30%\.<\/strong> 1 still needs its own tick/);
  const shut = page(view({ lines: [line(1, { bigChange: big(true), price: { ...line(1).price!, next: '$9.99' } })], bigChanges: { total: 1, toTick: 0, percent: 30 } }));
  assert.match(shut, /tag tag-ok">Confirmed \+67%</);
  assert.doesNotMatch(shut, /big-change"/);
  assert.match(shut, /Confirmed\./);
  assert.match(shut, /All confirmed\./);
  // The limit shown is the one in force, from the settings.
  assert.match(page(view({ bigChanges: { total: 2, toTick: 2, percent: 45 }, lines: [line(1)] })), /2 prices move more than 45%\./);
});

test('sold by weight is called out, with the switch', () => {
  const body = page(view({ lines: [line(1, { price: { ...line(1).price!, old: '$18.99', next: '$13.99', switchToWeight: true } })] }));
  assert.match(body, /<p class="callout callout-weight"><strong>Switch to sold by weight<\/strong> at \$13\.99 per pound\./);
  const prob = page(view({ lines: [line(1, { byWeightProblems: ['The per-pound unit is missing.'] })] }));
  assert.match(prob, /callout callout-weight">Sold by weight problems in Square, fixed in the same run: The per-pound unit is missing\./);
});

test('every decision has an Undo, on the line and in the list, for people who can decide only', () => {
  const decisions = [
    { kind: 'pick', target: '1', label: 'Picked: line 1: Gouda', by: 'mgr', undoNote: 'Undo also forgets the saved match for this supplier item.' },
    { kind: 'accept_big_change', target: 'V1', label: 'Big price change confirmed: 67% on V1', by: 'mgr', undoNote: '' },
  ];
  const body = page(view({ decisions, decisionsCount: 2 }));
  assert.match(body, /<h2 id="dec-h">Decisions on this invoice \(2\)<\/h2>/);
  assert.equal((body.match(/action="\/runs\/7\/undo"/g) ?? []).length, 3, 'two in the list, one on line 1');
  assert.match(body, /name="kind" value="accept_big_change"><input type="hidden" name="target" value="V1">/);
  assert.match(body, /Undo also forgets the saved match/);
  // Once the run is approved nobody can undo.
  const approved = page(view({ state: 'approved', decisions, decisionsCount: 2 }));
  assert.doesNotMatch(approved, /\/undo/);
});

test('not for resale needs its tick, and credits to claim are listed with the claim terms', () => {
  const body = page(view({ credits: [{ n: 2, amount: '$15.00', reason: 'Charged for 24.00 pieces, 18.00 arrived.' }], creditTotal: '$15.00', claim: { text: 'Claim within 3 days', deadline: '11/10/26' } }));
  assert.match(body, /<summary>Not for resale\?<\/summary>/);
  assert.match(body, /name="confirm" value="1" required> The store never sells this/);
  assert.match(body, /<h2 id="credit-h">Credits to claim<\/h2>/);
  assert.match(body, /Line 2: \$15\.00\. Charged for 24\.00 pieces, 18\.00 arrived\./);
  assert.match(body, /Total known: \$15\.00\./);
  assert.match(body, /"Claim within 3 days"\. Claim by 11\/10\/26\./);
  assert.match(page(view({ lines: [line(1, { outcome: 'not_for_resale', outcomeLabel: 'Not for resale', price: null, stock: null, card: null })] })), /tag tag-mute">Not for resale</);
  // Not shown when the line already is not for resale, nor to someone who cannot decide.
  assert.doesNotMatch(page(view({ lines: [line(1, { outcome: 'not_for_resale', outcomeLabel: 'Not for resale', price: null, stock: null, card: null })] })), /Not for resale\?<\/summary>/);
  assert.doesNotMatch(page(view({ state: 'approved' })), /not-for-resale/);
});

test('cards: as they will print, with the source, the check list and Mark checked; admin controls for admins only', () => {
  const copyApproval = { model: 'claude-opus-5-5', totalUsd: '2.40', fingerprint: 'fp', count: 2, why: 'This invoice\'s card copy budget is what ran out.' };
  const v = view({ copyApproval, cardsSummary: { total: 1, prints: 0, waiting: 1, leftOut: 0, canWrite: 2, spent: '$0.20', budget: 'The card copy budget of $5.00 has $4.80 left.' } });
  const mgr = page(v, 'manager');
  assert.match(mgr, /<h2 id="cards-h">Cards \(1\)<\/h2>/);
  assert.match(mgr, /<p class="pc-eyebrow">CHEESE · Product of Holland<\/p>/);
  assert.match(mgr, /<p class="pc-name">Smoked <em>Gouda<\/em><\/p>/);
  assert.match(mgr, /<span class="pc-price">\$6\.99<\/span> <span class="pc-unit">PER POUND<\/span> <span class="pc-code">code 7101<\/span>/);
  assert.match(mgr, /Source: <span class="tag tag-mute">Written by the model<\/span>/);
  assert.match(mgr, /<li>Aged 12 months <span class="hint">\(claim, raised by the model\)<\/span><\/li>/);
  assert.match(mgr, /on <strong>maker\.example<\/strong>: <span class="hint">https:\/\/maker\.example\/gouda<\/span>/);
  assert.doesNotMatch(mgr, /href="https?:\/\/maker/, 'a web address from a model is text, never a link');
  assert.match(mgr, /action="\/runs\/7\/cards\/check"/);
  assert.match(mgr, />Mark this version checked<\/button>/);
  assert.match(mgr, /action="\/runs\/7\/cards\/write"/, 'a manager may write copy for all cards');
  assert.match(mgr, /2 cards wait for a cost approval: up to \$2\.40 in all with claude-opus-5-5\./);
  assert.match(mgr, /Ask an admin to approve them/);
  assert.doesNotMatch(mgr, /cards\/approve-cost/);
  const admin = page(v, 'admin');
  assert.match(admin, /action="\/runs\/7\/cards\/approve-cost"/);
  assert.match(admin, /Approve up to \$2\.40 for all 2 with claude-opus-5-5/);
  // Nobody can change a card once the run is approved.
  const done = page(view({ state: 'approved', copyApproval }), 'admin');
  assert.doesNotMatch(done, /cards\/approve-cost|cards\/check|cards\/edit/);
});

test('a card left out, one with a stored suggestion and one blocked each say so', () => {
  const left = page(view({ cards: [card({ leftOut: true, status: 'Left out of this run', waitingFor: [] })], cardsSummary: { total: 1, prints: 0, waiting: 0, leftOut: 1, canWrite: 0, spent: '$0.00', budget: '' } }));
  assert.match(left, /tag tag-mute">Left out of this run</);
  assert.match(left, /Make a card in this run after all/);
  const sugg = page(view({ cards: [card({ written: null, needsCheck: false, suggestions: [{ cardId: 9, name: 'Smoked Gouda', producer: 'Maker', unit: 'PER POUND', source: 'imported', firstParagraph: 'A stored card.', reasons: ['Same code.'] }] })] }));
  assert.match(sugg, /A stored card may be this product/);
  assert.match(sugg, /Yes, this is the product/);
  assert.match(sugg, /No, another product/);
  const blocked = page(view({ cards: [card({ blocked: ['The card has a money amount.'] })] }));
  assert.match(blocked, /callout callout-stop">Blocked until edited: The card has a money amount\./);
});

test('the supplier: known, or new with suggestions and a way to add it', () => {
  const unknown = view({ supplier: { status: 'unknown', printed: 'Hilltop Provisions', suggestions: [{ id: 3, name: 'Hilltop Foods' }] }, blockers: [{ message: 'Choose the supplier.', anchor: null }] });
  const body = page(unknown);
  assert.match(body, /"Hilltop Provisions" is new to ShelfReady\./);
  assert.match(body, /Hilltop Foods.*Same supplier/s);
  assert.match(body, /Add as a new supplier/);
  assert.match(page(unknown, 'manager').replace(/\s+/g, ' '), /name="supplierId" value="3"/);
});

test('model, invoice and file text is escaped in every place the run pages show it', () => {
  const e = EVIL;
  const evilLine = line(1, {
    printed: { itemNumber: e, upc: e, description: e, brand: e, pack: e, qtyShipped: e, unit: e, weight: e, unitPrice: e, allowance: e, extension: e },
    flags: [e],
    outcome: 'needs_match',
    outcomeLabel: 'Pick the Square item',
    match: { label: e, how: e, reasons: [e], picked: false },
    candidates: [{ variationId: e, label: e, scorePercent: 90, method: e, reasons: [e] }],
    warnings: [e],
    byWeightProblems: [e],
    arrival: { arrived: 'some', source: 'person', toConfirm: false, pieces: e, pounds: e, askPounds: false },
    pack: { need: 'units_per_case', saved: e },
    bigChange: { variationId: e, percent: 67, up: true, overHalf: false, accepted: false, fromCents: 1, toCents: 2, text: e },
    stock: { text: e, unit: e, how: e },
    price: { status: 'priced', old: e, next: e, change: e, formula: e, formulaPrice: e, costHow: e, override: e, flags: [e], switchToWeight: true, reason: e },
    overrideQuestion: { variationId: e, formula: e, override: e, formulaCents: 1, overrideCents: 2, choice: null },
    conflict: { variationId: e, prices: [{ cents: 1, text: e }], picked: null },
    rename: { itemId: e, current: e, edited: e, next: e, scaleCode: e },
    card: { anchor: 'card-1', status: e },
  });
  const evilCard = card({
    variationId: e,
    anchor: 'card-1',
    label: e,
    sourceLabel: e,
    status: e,
    waitingFor: [e],
    printed: { eyebrow: e, origin: e, n1: e, n2: e, producer: e, specs: [{ label: e, value: e }], copy: [e], price: e, unit: e, code: e },
    edit: { origin: e, eyebrow: e, n1: e, n2: e, producer: e, specs: [{ label: e, value: e }], paragraphs: [e, e], unit: e, categories: [e] },
    checkList: [{ kind: e, text: e, from: e }],
    sources: [{ title: e, host: e, url: e, usedFor: e }],
    searches: [{ query: e, results: 1, error: e }],
    problems: [e],
    styleNotes: [e],
    blocked: [e],
    written: { model: e, cost: e, at: e, productIdentified: false, sellingPoint: e },
    runCost: e,
    suggestions: [{ cardId: 1, name: e, producer: e, unit: e, source: 'imported', firstParagraph: e, reasons: [e] }],
    pendingApproval: { model: e, usd: e },
  });
  const v = view({
    header: { ...view().header, message: e },
    files: [{ id: 1, position: 1, name: e, kind: e, bytes: 1, inline: false }],
    events: [{ at: e, stage: e, message: e }],
    pendingCost: { model: e, estimateUsd: e, message: e },
    reading: {
      status: e,
      model: e,
      cost: e,
      reasons: [e],
      notices: [e],
      checks: [{ id: e, passed: false, blocking: true, message: e, details: [e] }],
      failedChecks: [{ id: e as never, message: e, details: [e], acceptable: true, accepted: false }],
      supplierPrinted: e,
      invoiceNumber: e,
      invoiceDate: e,
      total: e,
      attempts: [{ role: e, model: e, outcome: e, cost: e }],
    },
    supplier: { status: 'unknown', printed: e, suggestions: [{ id: 1, name: e }] },
    lines: [evilLine, line(2, { printed: { ...line(2).printed, description: e }, price: { ...line(2).price!, status: 'priced' } })],
    credits: [{ n: 1, amount: e, reason: e }],
    creditTotal: e,
    claim: { text: e, deadline: e },
    catalogNotes: [e],
    stale: [e],
    vendorClash: e,
    blockers: [{ message: e, anchor: 'line-1' }, { message: e, anchor: null }],
    cards: [evilCard],
    cardsSummary: { total: 1, prints: 0, waiting: 1, leftOut: 0, canWrite: 2, spent: e, budget: e },
    copyApproval: { model: e, totalUsd: e, fingerprint: e, count: 2, why: e },
    decisions: [{ kind: e, target: '1', label: e, by: e, undoNote: e }, { kind: 'pick', target: e, label: e, by: e, undoNote: e }],
    decisionsCount: 2,
    catalog: { label: e, takenAt: e },
    dryRun: { at: e, hash: e },
  });
  v.header.canDecide = true;
  for (const role of ['manager', 'admin'] as const) {
    const body = page(v, role, { error: e, notice: e });
    assertSafe(body, role);
    assert.match(body, /&quot;&#39;&gt;&lt;img src=x onerror=alert\(1\)&gt;/, role);
    // Every hidden field the data fills is a safe attribute value.
    for (const m of body.matchAll(/<input type="hidden" name="[a-zA-Z]+" value="([^"]*)">/g)) assert.doesNotMatch(m[1]!, /[<>"']/, role);
  }
  // The search page, the list and the dry run too.
  const search = searchPage({ user: user('manager'), runId: 7, n: 1, description: e, q: e, results: [{ variationId: 'V', label: e, scorePercent: 1, method: e, reasons: [e] }], canDecide: true });
  assertSafe(search, 'search');
  assert.match(search, /&lt;img src=x/);
  const list = runListPage({ user: user('manager'), runs: [{ id: 1, state: 'review', createdByName: e, createdAt: 0, updatedAt: 0, blockers: 2, supplier: e, invoiceNumber: e }], catalogLabel: e });
  assertSafe(list, 'list');
  assert.match(list, /&lt;img src=x/);
  const upload = uploadPage({ user: user('manager'), maxFiles: 10, maxFileMb: 20, maxPdfPages: 20, catalogLabel: e, error: e });
  assertSafe(upload, 'upload');
  // And the dry run view: every string in it.
  const dry = dryView({
    header: { ...view({ state: 'approved' }).header, message: e },
    preview: { dryRun: true, runId: 7, computedAt: e, catalog: { source: e, label: e, takenAt: e }, square: [], scales: { contacted: false, names: [e], changes: [] }, cards: { cards: [], leftOut: [] }, credits: [], claim: null, leftOut: [], bigChangePercent: 30, hash: e },
    square: [{ label: e, lines: e, changes: [e], bigChange: e, lineStock: [{ n: 1, stock: e }] }],
    bigChanges: 1,
    corrections: [{ line: 1, variationId: e, stockTakeBack: e, stockUnit: 'lb', creditCents: 100, state: 'pending', recordedByName: e, recordedAt: 0, credit: e }],
    scales: { names: [e], rows: [{ code: e, item: e, price: e, scales: e }] },
    cards: [{ title: e, source: e, version: 1, printed: { eyebrow: e, origin: e, n1: e, n2: e, producer: e, specs: [{ label: e, value: e }], copy: [e], price: e, unit: e, code: e } }],
    cardsLeftOut: [{ title: e, why: e }],
    credits: [{ n: 1, amount: e, reason: e }],
    claim: { text: e, deadline: e },
    leftOut: [{ n: 1, why: e }],
    approval: { allowed: false, problems: [e], approvedBy: e, approvedAt: e },
  });
  const approvedDry = dryRunPage({ user: user('manager'), view: dry, error: e });
  assertSafe(approvedDry, 'dry run, approved');
  assert.match(approvedDry, /&quot;&#39;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  // Not yet approved: the approval problems and the approve form carry the data.
  const openDry = dryRunPage({ user: user('manager'), view: { ...dry, header: view({ state: 'dry_run_done' }).header, approval: { allowed: true, problems: [], approvedBy: '', approvedAt: '' } } });
  assertSafe(openDry, 'dry run, open');
  const blockedDry = dryRunPage({ user: user('manager'), view: { ...dry, header: view({ state: 'dry_run_done' }).header } });
  assertSafe(blockedDry, 'dry run, blocked');
  assert.match(blockedDry, /Approval is not possible yet/);
});

function dryView(over: Partial<DryRunView> = {}, state: RunState = 'dry_run_done'): DryRunView {
  return {
    header: { ...view({ state }).header },
    preview: { dryRun: true, runId: 7, computedAt: '2026-11-07T11:00:00Z', catalog: { source: 'file', label: 'dev catalog', takenAt: '2026-11-07T09:00:00Z' }, square: [], scales: { contacted: false, names: ['FRONT'], changes: [] }, cards: { cards: [], leftOut: [] }, credits: [], claim: null, leftOut: [], bigChangePercent: 30, hash: 'abc123' },
    square: [{ label: 'Gouda Smoked 7101', lines: '1', changes: ['Price: $18.99 becomes $13.99 per pound'], bigChange: null, lineStock: [{ n: 1, stock: '10.50 lb' }] }],
    bigChanges: 0,
    bigChangePercent: 30,
    corrections: [],
    scales: { names: ['FRONT'], rows: [{ code: '7101', item: 'Gouda Smoked 7101', price: '$13.99 per pound', scales: 'FRONT' }] },
    cards: [{ title: 'Gouda Smoked 7101', source: 'Written by the model', version: 2, printed: card().printed! }],
    cardsLeftOut: [],
    credits: [],
    claim: null,
    leftOut: [],
    approval: { allowed: true, problems: [], approvedBy: '', approvedAt: '' },
    ...over,
  };
}

test('the dry run page is loud, shared, and makes approval the one sticky action', () => {
  const body = dryRunPage({ user: user('manager'), view: dryView() });
  assert.match(body, /<body class="mode-dry-run">/);
  assert.match(body, /<title>DRY RUN: Invoice 7: what would change \| ShelfReady<\/title>/);
  assert.equal(body.match(/class="banner-label">DRY RUN<\/p>/g)?.length, 1, 'one banner, the shared one');
  assert.doesNotMatch(body, /<p class="error" role="status"><strong>DRY RUN/, 'no second hand-made notice');
  assert.match(body, /Nothing was sent to Square or the scales\./);
  assert.match(body, /<div class="stat-grid">.*<span class="stat-n">1<\/span><span class="stat-l">Square items<\/span>/s);
  assert.match(body, /<form method="post" action="\/runs\/7\/approve" class="action-bar">.*name="hash" value="abc123".*Approve these changes/s);
  assert.match(body, /<li>Price: \$18\.99 becomes \$13\.99 per pound<\/li>/);
  assert.match(body, /Code 7101, Gouda Smoked 7101: \$13\.99 per pound on FRONT/);
  assert.match(body, /<p class="pc-name">Smoked <em>Gouda<\/em><\/p>/);
  // Approval blocked: the reasons, and no button.
  const blocked = dryRunPage({ user: user('manager'), view: dryView({ approval: { allowed: false, problems: ['A line needs a decision.'], approvedBy: '', approvedAt: '' } }) });
  assert.match(blocked, /Approval is not possible yet:<\/p><ul><li>A line needs a decision\.<\/li>/);
  assert.doesNotMatch(blocked, /action="\/runs\/7\/approve"/);
  // Approved: still a dry run preview, no approve button, the correction form shows.
  const approved = dryRunPage({ user: user('manager'), view: dryView({ approval: { allowed: true, problems: [], approvedBy: 'mgr', approvedAt: '2026-11-07 12:00 UTC' } }, 'approved') });
  assert.match(approved, /Approved by mgr, 2026-11-07 12:00 UTC\./);
  assert.doesNotMatch(approved, /action="\/runs\/7\/approve"/);
  assert.match(approved, /Line 1 did not arrive\?/);
  // Big changes are counted.
  assert.match(dryRunPage({ user: user('manager'), view: dryView({ bigChanges: 2, square: [{ label: 'X', lines: '1', changes: ['No change'], bigChange: 'Price goes up 67%. Confirmed in review.', lineStock: [] }] }) }), /2 prices move more than 30%<\/strong>, each confirmed in review/);
});

test('the upload page: one big camera button, a PDF chooser, clear limits, the token first, one static script', () => {
  const body = uploadPage({ user: user('manager'), maxFiles: 10, maxFileMb: 20, maxPdfPages: 20, catalogLabel: 'sandbox' });
  assert.match(body, /<form method="post" action="\/runs" enctype="multipart\/form-data" class="stack" data-upload data-max-files="10" data-max-file-mb="20">\s*<input type="hidden" name="_csrf" value="tok">/);
  assert.match(body, /<label class="button button-accent button-xl pick" for="photos">Take photos of the invoice\s*<input id="photos"[^>]*accept="image\/\*,application\/pdf" capture="environment" multiple data-take>/);
  assert.match(body, /Or choose a PDF or saved photos/);
  assert.match(body, /Up to 10 photos, or one PDF of up to 20 pages\./);
  assert.match(body, /Each file up to 20 MB\./);
  assert.match(body, /<div class="action-bar"><button type="submit" data-submit>Upload and read<\/button><\/div>/);
  assert.match(body, /<script src="\/static\/js\/upload\.js" defer><\/script>/);
  assert.equal((body.match(/<script/g) ?? []).length, 1);
  // The page works without the script: both file boxes post as `files`.
  assert.equal((body.match(/name="files"/g) ?? []).length, 2);
});

test('the invoice list shows where each invoice stands, in tags a person can read at a glance', () => {
  const body = runListPage({
    user: user('manager'),
    catalogLabel: 'sandbox',
    runs: [
      { id: 3, state: 'review', createdByName: 'mgr', createdAt: 0, updatedAt: 0, blockers: 2, supplier: 'Hilltop', invoiceNumber: 'A1' },
      { id: 2, state: 'dry_run_done', createdByName: 'mgr', createdAt: 0, updatedAt: 0, blockers: 0, supplier: '', invoiceNumber: '' },
      { id: 1, state: 'retry', createdByName: 'mgr', createdAt: 0, updatedAt: 0, blockers: 0, supplier: '', invoiceNumber: '' },
    ],
  });
  assert.match(body, /<a class="run-link" href="\/runs\/3">\s*<span class="run-title">Invoice 3: Hilltop #A1<\/span>/);
  assert.match(body, /tag tag-wait">Needs review<\/span><span class="tag tag-wait">2 to settle<\/span>/);
  assert.match(body, /tag tag-ok">Dry run done\. Ready to approve</);
  assert.match(body, /tag tag-stop">Could not be read\. Try again</);
  assert.match(runListPage({ user: user('manager'), runs: [], catalogLabel: 'x' }), /No invoices yet\./);
});

test('no run page uses an em dash or a double hyphen in its words', () => {
  const pages = [
    page(view({ state: 'review', blockers: [{ message: 'Line 1: pick.', anchor: 'line-1' }] })),
    page(view({ state: 'ready' }), 'admin'),
    page(view({ state: 'needs_approval', pendingCost: { model: 'm', estimateUsd: '1.00', message: 'Cost.' } }), 'admin'),
    page(view({ state: 'retry' })),
    dryRunPage({ user: user('manager'), view: dryView() }),
    uploadPage({ user: user('manager'), maxFiles: 10, maxFileMb: 20, maxPdfPages: 20, catalogLabel: 'sandbox' }),
    runListPage({ user: user('manager'), runs: [], catalogLabel: 'x' }),
    searchPage({ user: user('manager'), runId: 1, n: 1, description: 'd', q: 'q', results: [], canDecide: true }),
  ];
  for (const body of pages) assert.doesNotMatch(body, /\u2014|\u2013|--/);
});

test('real app: the list, the review, the ready bar and the dry run page fit together', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  const list = await get(s, '/runs', mgr.cookie);
  assert.match(list.body, /<a class="run-link" href="\/runs\/1">/);
  assert.match(list.body, /tag tag-wait">Needs review/);
  let body = (await get(s, '/runs/1', mgr.cookie)).body;
  assert.match(body, /<h2 id="progress-h">Needs you<\/h2>/);
  assert.match(body, /tag tag-ok">Read cleanly</);
  assert.match(body, /<section class="todo" id="todo"/);
  assert.match(body, /<div class="action-bar"><a class="button" href="#[a-z0-9-]+">Next: \d+ to settle<\/a><\/div>/);
  assert.match(body, /<li class="is-now" aria-current="step">Review/);
  await decide(s, mgr, '/runs/1/supplier', { create: '1' });
  await decide(s, mgr, '/runs/1/lines/1/pick', { variationId: 'V_GOUDA' });
  await decide(s, mgr, '/runs/1/lines/3/pick', { variationId: 'V_SALMON' });
  assert.equal(runState(s), 'ready');
  body = (await get(s, '/runs/1', mgr.cookie)).body;
  assert.match(body, /<h2 id="block-h">Nothing blocks<\/h2>/);
  assert.match(body, /class="action-bar">.*Make a dry run/s);
  assert.match(body, /Switch to sold by weight<\/strong> at \$/);
  assert.match(body, /Undo/);
  await decide(s, mgr, '/runs/1/dry-run');
  await s.app.shelf.runner.drain();
  assert.equal(runState(s), 'dry_run_done');
  body = (await get(s, '/runs/1', mgr.cookie)).body;
  assert.match(body, /href="\/runs\/1\/dry-run">See the dry run</);
  assert.doesNotMatch(body, /banner-label/);
  const dry = (await get(s, '/runs/1/dry-run', mgr.cookie)).body;
  assert.match(dry, /<body class="mode-dry-run">/);
  assert.match(dry, /class="banner-label">DRY RUN</);
  assert.match(dry, /action="\/runs\/1\/approve" class="action-bar"/);
  // The form token is random and can hold "--", so its value is taken out before the check.
  const noToken = (b: string): string => b.replace(/(name="_csrf" value=")[^"]*"/g, '$1"');
  for (const b of [list.body, body, dry]) {
    assert.match(b, /name="_csrf" value="[^"]+"/, 'the page has a form token');
    assert.doesNotMatch(noToken(b), /\u2014|\u2013|--|\sstyle=|<script>/);
  }
});

test('real app: a manager never sees admin links or admin controls on the run pages', async (t) => {
  const s = await makeRunApp();
  t.after(() => s.close());
  await addUser(s, 'bart', 'admin', ADMIN_PW);
  const mgr = await signIn(s);
  await uploadPhoto(s, mgr);
  await s.app.shelf.runner.drain();
  const admin = (await login(s, 'bart', ADMIN_PW)).cookie;
  for (const url of ['/runs', '/runs/new', '/runs/1']) {
    const m = (await get(s, url, mgr.cookie)).body;
    assert.doesNotMatch(m, /href="\/settings"|href="\/users"|approve-cost/, `manager on ${url}`);
    assert.match(m, /role role-manager">Manager</, url);
    assert.match((await get(s, url, admin)).body, /href="\/settings"/, `admin on ${url}`);
  }
});

test('the per-line percent shows only where pricing compared the two prices', () => {
  const pct = (l: LineView, extra: Partial<ReviewView> = {}) => /class="price-pct"/.test(page(view({ lines: [l], ...extra })));
  assert.equal(pct(line(1)), true, 'a priced line shows its percent');
  // A switch to sold by weight: the old price is per unit and the new per pound.
  assert.equal(pct(line(1, { price: { ...line(1).price!, old: '$18.99', next: '$13.99', switchToWeight: true } })), false);
  // Pricing did not settle the line.
  for (const status of ['needs_decision', 'no_price', 'conflict'] as const) assert.equal(pct(line(1, { price: { ...line(1).price!, status } })), false, status);
  // A vendor clash means the formula is not trusted yet.
  assert.equal(pct(line(1), { vendorClash: 'Two vendor formulas fit this supplier.' }), false);
  // No change shows nothing, and the figure is cut toward zero: 29.6 percent reads 29%, never 30%.
  assert.equal(pct(line(1, { price: { ...line(1).price!, old: '$5.00', next: '$5.00' } })), false);
  assert.match(page(view({ lines: [line(1, { price: { ...line(1).price!, old: '$10.00', next: '$12.96' } })] })), /tag-mute">\+29%</);
  assert.match(page(view({ lines: [line(1, { price: { ...line(1).price!, old: '$10.00', next: '$7.04' } })] })), /tag-mute">-29%</);
  // A flagged line shows the rounded-up figure the review worked out.
  const big = { variationId: 'V1', percent: 31, up: true, overHalf: false, accepted: false, fromCents: 1000, toCents: 1304, text: 'Price goes up 31%, from $10.00 to $13.04.' };
  const body = page(view({ lines: [line(1, { bigChange: big, price: { ...line(1).price!, old: '$10.00', next: '$13.04' } })], bigChanges: { total: 1, toTick: 1, percent: 30 } }));
  assert.match(body, /tag-stop">\+31%</);
  assert.doesNotMatch(body, /\+30%/);
});

test('the dry run page shows its confirmed big changes as a notice, not an error', () => {
  const body = dryRunPage({ user: user('manager'), view: dryView({ bigChanges: 1, square: [{ label: 'X', lines: '1', changes: ['No change'], bigChange: 'Price goes up 34%. Confirmed in review.', lineStock: [] }] }) });
  assert.match(body, /<p class="notice"><strong>1 price moves more than 30%<\/strong>, each confirmed in review\./);
  assert.doesNotMatch(body, /<p class="error"/);
});

test('the upload script moves files all or nothing, never calls out, and sets the button right on Back', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server/static/js/upload.js', import.meta.url), 'utf8');
  // The visible box is emptied and checked before the hidden boxes join the form.
  const empty = src.indexOf("input.value = '';");
  const check = src.indexOf('could not empty the box');
  const attach = src.indexOf('holder.appendChild');
  assert.ok(empty > 0 && check > empty && attach > check, 'empty, check, then attach');
  assert.equal((src.match(/holder\.appendChild/g) ?? []).length, 1, 'hidden boxes are attached in one place only');
  assert.match(src, /catch \(err\) \{[^}]*return;/, 'on failure nothing is attached');
  assert.match(src, /addEventListener\('pageshow'/);
  assert.match(src, /submit\.textContent = label;\s*render\(\);/);
  // Nothing leaves the page but the form.
  assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|localStorage|sessionStorage|document\.cookie|eval\(|innerHTML|import\(/);
});
