// Pages for invoice runs: upload, the list, a run's progress and review, the line search, the
// dry run and the cards. Mobile first: one column, large tap targets, the main action in the
// sticky bar at the bottom. Built only from the view models in src/runs/review.ts.
// Every value is escaped by the html template. No inline script or style. The one script, on the
// upload page, is a static file and only adds to a form that works without it.
//
// The upload form puts the CSRF token first, so the server checks it before reading any file.
// Dry run pages use layout mode 'dry-run', which adds the shared DRY RUN banner and frame.

import type { SessionUser } from '../../auth/sessions.ts';
import type { RunListItem } from '../../runs/store.ts';
import { STATE_LABELS, type RunState } from '../../runs/states.ts';
import type { CandidateView, CardView, DryRunView, LineView, PrintedCardView, ReviewView } from '../../runs/review.ts';
import type { SheetRowView, SheetSectionView } from '../../runs/card-sheets.ts';
import { html, type SafeHtml } from './html.ts';
import { csrfField, eyebrow, layout, messages } from './pages.ts';
import { SQUARE_LIVE_LABEL } from '../../square/origins.ts';

/** A Square catalog label, with a red LIVE tag when it is live Square, so it is never taken for the sandbox. */
export function squareLabel(label: string): SafeHtml {
  return label === SQUARE_LIVE_LABEL ? html`<strong>${label}</strong> <span class="tag tag-live">LIVE</span>` : html`${label}`;
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

type Kind = 'ok' | 'wait' | 'stop' | 'mute';

function tag(text: string, kind: Kind | '' = ''): SafeHtml {
  return html`<span class="tag${kind ? ` tag-${kind}` : ''}">${text}</span>`;
}

/** What each state looks like in a list: a tag colour. Yellow means a person is wanted. */
const STATE_KIND: Record<RunState, Kind> = {
  uploaded: 'wait',
  reading: 'wait',
  needs_approval: 'stop',
  retry: 'stop',
  review: 'wait',
  ready: 'ok',
  dry_run_done: 'ok',
  approved: 'ok',
  sending: 'wait',
  done: 'ok',
  partial: 'stop',
  failed: 'mute',
};

// ---- Upload ----

export function uploadPage(o: { user: SessionUser; maxFiles: number; maxFileMb: number; maxPdfPages: number; catalogLabel: string; error?: string }): string {
  return layout({
    title: 'Upload an invoice',
    user: o.user,
    nav: 'runs',
    eyebrow: 'New invoice',
    scripts: ['upload'],
    body: html`${messages(o.error)}
<form method="post" action="/runs" enctype="multipart/form-data" class="stack" data-upload data-max-files="${String(o.maxFiles)}" data-max-file-mb="${String(o.maxFileMb)}">
  ${csrfField(o.user)}
  <label class="button button-accent button-xl pick" for="photos">Take photos of the invoice
    <input id="photos" class="sr-only" name="files" type="file" accept="image/*,application/pdf" capture="environment" multiple data-take>
  </label>
  <p class="hint">One photo per page. After each one, take the next. The photos stay in the list below.</p>
  <p class="upload-or"><label class="button button-outline pick" for="files">Or choose a PDF or saved photos
    <input id="files" class="sr-only" name="files" type="file" accept="image/*,application/pdf" multiple data-take>
  </label></p>
  <div data-holder></div>
  <section aria-labelledby="chosen-h">
    <h2 id="chosen-h">Ready to upload</h2>
    <ul class="file-list" data-list aria-live="polite"></ul>
    <p class="hint" data-status>Choose the photos or the PDF above. Nothing is sent until you press the button below.</p>
  </section>
  <ul class="limits">
    <li>Up to ${o.maxFiles} photos, or one PDF of up to ${o.maxPdfPages} pages.</li>
    <li>Each file up to ${o.maxFileMb} MB.</li>
    <li>Photos: JPEG, PNG, WebP or HEIF.</li>
  </ul>
  <div class="action-bar"><button type="submit" data-submit>Upload and read</button></div>
</form>
<p class="hint">Square catalog: ${squareLabel(o.catalogLabel)}. Nothing is sent to Square or the scales until a person approves a dry run.</p>`,
  });
}

// ---- The list ----

export function runListPage(o: { user: SessionUser; runs: RunListItem[]; catalogLabel: string }): string {
  const rows = o.runs.map(
    (r) => html`<li><a class="run-link" href="/runs/${r.id}">
  <span class="run-title">Invoice ${r.id}${r.supplier ? html`: ${r.supplier}` : ''}${r.invoiceNumber ? html` #${r.invoiceNumber}` : ''}</span>
  <span class="run-meta">${tag(STATE_LABELS[r.state], STATE_KIND[r.state])}${r.blockers ? tag(`${r.blockers} to settle`, 'wait') : ''}<span class="hint">Uploaded by ${r.createdByName}, ${when(r.createdAt)}</span></span>
</a></li>`,
  );
  return layout({
    title: 'Invoices',
    user: o.user,
    nav: 'runs',
    eyebrow: 'All invoices',
    body: html`<p><a class="button button-accent" href="/runs/new">Upload an invoice</a></p>
<p class="hint">Square catalog: ${squareLabel(o.catalogLabel)}.</p>
${o.runs.length ? html`<ul class="run-list">${rows}</ul>` : html`<p class="lead">No invoices yet. Upload the first one to begin.</p>`}`,
  });
}

// ---- Forms ----

function form(user: SessionUser, action: string, fields: Record<string, string>, label: string, extra: SafeHtml | string = '', cls = ''): SafeHtml {
  return html`<form method="post" action="${action}" class="inline">${csrfField(user)}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}${extra}<button type="submit"${cls ? html` class="${cls}"` : ''}>${label}</button></form>`;
}

function undoForm(user: SessionUser, runId: number, kind: string, target: string): SafeHtml {
  return form(user, `/runs/${runId}/undo`, { kind, target }, 'Undo', '', 'button-outline button-small');
}

// ---- Where the invoice stands ----

const STEPS = ['Uploaded', 'Read', 'Review', 'Dry run', 'Approved'] as const;
const STEP_OF: Record<RunState, number> = { uploaded: 0, reading: 1, needs_approval: 1, retry: 1, review: 2, ready: 2, dry_run_done: 3, approved: 4, sending: 4, done: 4, partial: 4, failed: -1 };

/** States whose run has a send page (src/server/send-routes.ts). */
const SENDABLE: ReadonlySet<RunState> = new Set(['approved', 'sending', 'partial', 'done']);

/** Plain words for each state. Nothing here is from the invoice or a model. */
function guide(v: ReviewView): { head: string; detail: string } {
  const h = v.header;
  if (h.working && h.state !== 'reading' && h.state !== 'uploaded') return { head: 'Working', detail: 'ShelfReady is working on this invoice. This page updates by itself. You can leave and come back.' };
  switch (h.state) {
    case 'uploaded':
      return { head: 'Waiting its turn', detail: 'The photos are saved. ShelfReady reads them next. This page updates by itself. You can leave and come back.' };
    case 'reading':
      return { head: 'Reading the invoice', detail: 'This usually takes a minute or two. This page updates by itself. You can leave and come back.' };
    case 'needs_approval':
      return { head: 'Waiting for an admin', detail: 'Reading this invoice would cost more than the limit. An admin must approve the cost first. Nothing is lost while it waits.' };
    case 'retry':
      return { head: 'Could not read it yet', detail: 'Nothing is lost. Try reading it again.' };
    case 'review':
      return { head: 'Needs you', detail: v.blockers.length ? `${v.blockers.length} ${v.blockers.length === 1 ? 'thing needs' : 'things need'} a decision before a dry run. They are listed below.` : 'Look over the lines below, then make a dry run.' };
    case 'ready':
      return { head: 'Ready for a dry run', detail: 'Nothing blocks. A dry run shows what would change. It sends nothing.' };
    case 'dry_run_done':
      return { head: 'Dry run done', detail: 'Look at the dry run. If it is right, approve it there. Nothing has been sent.' };
    case 'approved':
      return { head: 'Approved', detail: 'A person approved the dry run. Send it to Square and the scales from the send page.' };
    case 'sending':
      return { head: 'Sending', detail: 'The changes are going to Square and the scales. The send page shows each step.' };
    case 'done':
      return { head: 'Done', detail: 'Square and the scales are up to date.' };
    case 'partial':
      return { head: 'Partly sent', detail: 'Square is done and some scales still need the prices. The send page shows which, with a way to resend.' };
    default:
      return { head: 'Stopped', detail: 'This invoice was stopped. The record is kept.' };
  }
}

function steps(state: RunState): SafeHtml {
  const at = STEP_OF[state];
  return html`<ol class="steps" aria-label="Where this invoice is">${STEPS.map(
    (name, i) => html`<li${i === at ? html` class="is-now" aria-current="step"` : i < at ? html` class="is-done"` : ''}>${name}</li>`,
  )}</ol>`;
}

function statusPanel(user: SessionUser, v: ReviewView): SafeHtml {
  const h = v.header;
  const g = guide(v);
  return html`<section class="status-panel" aria-labelledby="progress-h">
<div class="status-head"><h2 id="progress-h">${g.head}</h2>${tag(h.stateLabel, STATE_KIND[h.state])}</div>
<div class="status-body">
<p>${g.detail}</p>
${h.message ? html`<p><strong>${h.message}</strong></p>` : ''}
${v.pendingCost
  ? html`<div class="callout callout-warn">
  <p>${v.pendingCost.message}</p>
  ${user.role === 'admin'
    ? form(user, `/runs/${h.id}/approve-cost`, { model: v.pendingCost.model, estimateUsd: v.pendingCost.estimateUsd }, `Approve up to $${v.pendingCost.estimateUsd} with ${v.pendingCost.model}`, '', 'button-red')
    : html`<p class="hint">Ask an admin to approve it.</p>`}
</div>`
  : ''}
${h.canReadAgain ? form(user, `/runs/${h.id}/read-again`, {}, 'Read again', '', h.state === 'retry' ? 'button-accent' : 'button-outline') : ''}
${SENDABLE.has(h.state) ? html`<p><a class="button${h.state === 'done' ? ' button-outline' : ' button-accent'}" href="/runs/${h.id}/send">${h.state === 'approved' ? 'Go to sending' : 'See the send'}</a></p>` : ''}
</div>
${steps(h.state)}
</section>`;
}

/** The history, the files and the way to stop. Below the things to settle, so those come first. */
function historyBox(user: SessionUser, v: ReviewView): SafeHtml {
  const h = v.header;
  return html`<details>
<summary>What happened, and the files</summary>
<ol>${v.events.map((e) => html`<li><span class="hint">${e.at}</span> ${e.message}</li>`)}</ol>
<h3>Files</h3>
<ul>${v.files.map((f) => html`<li><a href="/runs/${h.id}/files/${f.id}">${f.position}. ${f.name}</a> <span class="hint">(${f.kind}, ${Math.ceil(f.bytes / 1024)} KB)</span></li>`)}</ul>
</details>
${h.canStop ? html`<details><summary>Stop this invoice</summary><p>Nothing has been sent. Stopping keeps the record but ends the run.</p>${form(user, `/runs/${h.id}/stop`, {}, 'Stop this invoice', '', 'button-red')}</details>` : ''}`;
}

// ---- Lines ----

const MONEY = /^\$(\d+)\.(\d{2})$/;
function centsOf(text: string): number | null {
  const m = MONEY.exec(text);
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

/**
 * The change from the old price to the new, as text like "+17%". Empty when either price is
 * missing or the old one is zero. It is cut toward zero, never rounded up, so a line that is not
 * flagged cannot read as the limit or above (29.6 shows as 29%). A flagged line shows the
 * rounded-up figure from the review instead.
 */
function percentText(oldText: string, nextText: string): string {
  const a = centsOf(oldText);
  const b = centsOf(nextText);
  if (a === null || b === null || a === 0 || a === b) return '';
  const pct = Math.trunc(((b - a) / a) * 100);
  if (pct === 0) return '';
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

const ARRIVED: Record<string, string> = { all: 'All of it', none: 'None of it', some: 'Some', unclear: 'Not clear' };
const ARRIVED_SOURCE: Record<string, string> = { default: '', invoice: ' (from the invoice)', note: ' (from a note on the line, please confirm)', person: ' (decided in review)' };

function candidateItem(user: SessionUser, runId: number, n: number, c: CandidateView): SafeHtml {
  return html`<li><p><strong>${c.label}</strong> ${tag(`${c.scorePercent}% by ${c.method}`, 'mute')}</p>${c.reasons.length ? html`<p class="hint">${c.reasons.join(' ')}</p>` : ''}
  ${form(user, `/runs/${runId}/lines/${n}/pick`, { variationId: c.variationId }, 'This one', '', 'button-accent')}</li>`;
}

function lineCard(user: SessionUser, v: ReviewView, l: LineView): SafeHtml {
  const id = v.header.id;
  const can = v.header.canDecide;
  const p = l.printed;
  const price = l.price;
  const big = l.bigChange;
  const outcomeKind: Kind = l.outcome === 'send' ? 'ok' : l.outcome === 'needs_match' || l.outcome === 'new_item' ? 'wait' : 'mute';
  const mine = v.decisions.filter((d) => d.target === String(l.n));
  // A percent only where pricing really compared the two prices: not for a switch to by weight
  // (the old price is per unit, the new per pound), not for a line pricing did not settle, and
  // not while a vendor clash means the formula is not trusted.
  const checked = price !== null && price.status === 'priced' && !price.switchToWeight && !v.vendorClash;
  const pct = price ? (big ? `${big.up ? '+' : '-'}${big.percent}%` : checked ? percentText(price.old, price.next) : '') : '';
  const quiet = l.outcome === 'skipped' || l.outcome === 'not_for_resale' || l.outcome === 'nothing_arrived';
  return html`<li class="line${big ? (big.overHalf ? ' big-change over-half' : ' big-change') : ''}${quiet ? ' is-done-line' : ''}" id="${l.anchor}">
<div class="line-head"><h3><span class="line-no">${l.n}</span>${p.description}</h3>${tag(l.outcomeLabel, outcomeKind)}${big ? tag(`${big.accepted ? 'Confirmed' : 'Big change'} ${big.up ? '+' : '-'}${big.percent}%`, big.accepted ? 'ok' : 'stop') : ''}</div>

<div class="line-block">
<p class="block-label">On the invoice</p>
<div class="on-invoice">
<p><strong>${p.description}</strong></p>
<p>${p.itemNumber ? html`Item ${p.itemNumber}. ` : ''}${p.upc ? html`UPC ${p.upc}. ` : ''}${p.brand ? html`${p.brand}. ` : ''}${p.pack ? html`Pack ${p.pack}. ` : ''}Shipped ${p.qtyShipped} ${p.unit}${p.weight ? html`, ${p.weight} lb` : ''}. Price ${p.unitPrice}${p.allowance ? html` less ${p.allowance}` : ''}. Amount ${p.extension}.</p>
</div>
${l.flags.length ? html`<ul>${l.flags.map((f) => html`<li>${f}</li>`)}</ul>` : ''}
</div>

<div class="line-block">
<p class="block-label">Square match</p>
${l.match
  ? html`<p class="match-name">${l.match.label}</p>${l.match.how ? html`<p class="hint">Matched by ${l.match.how}.</p>` : ''}`
  : l.outcome === 'needs_match' || l.outcome === 'new_item'
    ? html`<p>No Square item chosen yet.</p>`
    : html`<p><strong>${l.outcomeLabel}</strong></p>`}
${l.possibleMisread ? html`<p class="callout callout-warn">The code on this line may be misread. Check it against the paper invoice.</p>` : ''}
${l.warnings.length ? html`<ul>${l.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
${l.byWeightProblems.length ? html`<p class="callout callout-weight">Sold by weight problems in Square, fixed in the same run: ${l.byWeightProblems.join(' ')}</p>` : ''}
${can && (l.outcome === 'needs_match' || l.outcome === 'new_item' || l.outcome === 'send' || l.outcome === 'not_for_resale' || l.outcome === 'nothing_arrived')
  ? html`<details${l.outcome === 'send' ? '' : html` open`}><summary>${l.outcome === 'send' ? 'Wrong item? Pick another' : 'Pick the Square item'}</summary>
${l.candidates.length ? html`<ul class="candidates">${l.candidates.map((c) => candidateItem(user, id, l.n, c))}</ul>` : html`<p>No likely Square items.</p>`}
<form method="get" action="/runs/${id}/lines/${l.n}/search" class="inline"><label for="q-${l.n}">Search Square</label><input id="q-${l.n}" name="q" maxlength="100"><button type="submit">Search</button></form>
</details>`
  : ''}
</div>

<div class="line-block">
<p class="block-label">What arrived</p>
<p class="arrival${l.arrival.toConfirm ? ' to-confirm' : ''}">What arrived: ${ARRIVED[l.arrival.arrived] ?? l.arrival.arrived}${l.arrival.pieces ? html`, ${l.arrival.pieces} pieces` : ''}${l.arrival.pounds ? html`, ${l.arrival.pounds} lb` : ''}${ARRIVED_SOURCE[l.arrival.source] ?? ''}</p>
${can
  ? html`<details${l.arrival.toConfirm || l.arrival.arrived === 'unclear' ? html` open` : ''}><summary>Change what arrived</summary>
<form method="post" action="/runs/${id}/lines/${l.n}/arrived" class="stack">${csrfField(user)}
  <fieldset><legend>What arrived?</legend>
  <label class="check"><input type="radio" name="arrived" value="all"${l.arrival.arrived === 'all' ? html` checked` : ''}> All of it</label>
  <label class="check"><input type="radio" name="arrived" value="none"${l.arrival.arrived === 'none' ? html` checked` : ''}> None of it. Today's price stays and it becomes a credit to claim.</label>
  <label class="check"><input type="radio" name="arrived" value="some"${l.arrival.arrived === 'some' ? html` checked` : ''}> Some</label>
  ${l.arrival.askPounds
    ? html`<label for="lb-${l.n}">Pounds that arrived</label><input id="lb-${l.n}" name="pounds" inputmode="decimal" maxlength="12" value="${l.arrival.pounds ?? ''}">`
    : html`<label for="pc-${l.n}">Pieces that arrived</label><input id="pc-${l.n}" name="pieces" inputmode="numeric" maxlength="7" value="${l.arrival.pieces ?? ''}">`}
  </fieldset><button type="submit">Save</button></form></details>`
  : ''}
${l.pack
  ? html`${l.pack.saved ? html`<p class="hint">${l.pack.saved}</p>` : ''}
${can
  ? html`<form method="post" action="/runs/${id}/lines/${l.n}/pack" class="stack">${csrfField(user)}
${l.pack.need === 'units_per_case'
  ? html`<label for="upc-${l.n}">Units in one case (saved for next time)</label><input id="upc-${l.n}" name="unitsPerCase" inputmode="numeric" maxlength="5" required>`
  : html`<label for="ppu-${l.n}">Pounds in one unit (saved for next time)</label><input id="ppu-${l.n}" name="poundsPerUnit" inputmode="decimal" maxlength="9" required>`}
<button type="submit">Save</button></form>`
  : ''}`
  : ''}
${l.stock ? ('problem' in l.stock ? html`<p class="callout callout-stop">Stock: ${l.stock.problem}</p>` : html`<p>Stock to set: ${l.stock.text} ${l.stock.unit}. <span class="hint">${l.stock.how}</span></p>`) : ''}
</div>

${price
  ? html`<div class="line-block">
<p class="block-label">Price</p>
<p class="price-move"><span class="sr-only">Price: ${price.old} now, ${price.next}.</span><span class="price-old" aria-hidden="true">${price.old}</span><span class="price-arrow" aria-hidden="true">now</span><span class="price-new${price.old === price.next ? ' same' : ''}" aria-hidden="true">${price.next}</span>${pct ? html`<span class="price-pct">${tag(pct, big ? (big.accepted ? 'ok' : 'stop') : 'mute')}</span>` : ''}</p>
${price.change ? html`<p class="hint">Change ${price.change}.</p>` : ''}
${price.switchToWeight ? html`<p class="callout callout-weight"><strong>Switch to sold by weight</strong> at ${price.next} per pound. Square will sell it by the pound, at the same price as the scales.</p>` : ''}
<p class="hint">Formula ${price.formula}: ${price.formulaPrice}. ${price.costHow}</p>
${price.override ? html`<p>${price.override}</p>` : ''}
${price.flags.length ? html`<ul>${price.flags.map((f) => html`<li>${f}</li>`)}</ul>` : ''}
${big
  ? html`<div class="callout ${big.accepted ? '' : 'callout-warn'}"><p><strong>${big.text}</strong>${big.accepted ? ' Confirmed.' : ''}</p>
${can && !big.accepted ? form(user, `/runs/${id}/big-change`, { variationId: big.variationId, fromCents: String(big.fromCents), toCents: String(big.toCents) }, `Yes, this ${big.percent}% change is right`, '', 'button-red') : ''}</div>`
  : ''}
${can && l.overrideQuestion
  ? html`<form method="post" action="/runs/${id}/override" class="stack">${csrfField(user)}
<input type="hidden" name="variationId" value="${l.overrideQuestion.variationId}">
<input type="hidden" name="formulaCents" value="${String(l.overrideQuestion.formulaCents)}">
<input type="hidden" name="overrideCents" value="${String(l.overrideQuestion.overrideCents)}">
<fieldset><legend>Formula ${l.overrideQuestion.formula} is above the override ${l.overrideQuestion.override}</legend>
<label class="check"><input type="radio" name="choice" value="keep_override"${l.overrideQuestion.choice === 'keep_override' ? html` checked` : ''}> Keep the override</label>
<label class="check"><input type="radio" name="choice" value="use_formula"${l.overrideQuestion.choice === 'use_formula' ? html` checked` : ''}> Use the formula price</label>
<label class="check"><input type="radio" name="choice" value="enter_price"${l.overrideQuestion.choice === 'enter_price' ? html` checked` : ''}> Enter a price</label>
<label for="price-${l.n}">Price</label><input id="price-${l.n}" name="price" inputmode="decimal" maxlength="10">
</fieldset><button type="submit">Save</button></form>`
  : ''}
${can && l.conflict
  ? html`<form method="post" action="/runs/${id}/conflict" class="stack">${csrfField(user)}
<input type="hidden" name="variationId" value="${l.conflict.variationId}">
<fieldset><legend>Pick one price for this item</legend>
${l.conflict.prices.map((c) => html`<label class="check"><input type="radio" name="priceCents" value="${String(c.cents)}"${l.conflict!.picked === c.cents ? html` checked` : ''}> ${c.text}</label>`)}
</fieldset><button type="submit">Save</button></form>`
  : ''}
${can && l.rename
  ? html`<details><summary>Store name${l.rename.next ? html`: ${l.rename.current} becomes ${l.rename.next}` : ''}</summary>
<form method="post" action="/runs/${id}/rename" class="stack">${csrfField(user)}
<input type="hidden" name="itemId" value="${l.rename.itemId}">
<label for="name-${l.n}">Name in Square${l.rename.scaleCode ? html` (scale code ${l.rename.scaleCode} stays at the end)` : ''}. The card's own name is edited with the card.</label>
<input id="name-${l.n}" name="name" maxlength="200" value="${l.rename.edited ?? ''}">
<button type="submit">Save name</button></form></details>`
  : ''}
</div>`
  : ''}

<div class="line-block">
<p class="block-label">Card</p>
${l.card ? html`<p>Card: <a href="#${l.card.anchor}">${l.card.status}</a></p>` : l.outcome === 'nothing_arrived' ? html`<p class="hint">No card: nothing arrived.</p>` : html`<p class="hint">No card for this line.</p>`}
</div>

${can || mine.length
  ? html`<div class="line-block">
${mine.map((d) => html`<div class="undo-row"><span>${d.label} <span class="hint">(${d.by})</span></span>${can ? undoForm(user, id, d.kind, d.target) : ''}</div>${d.undoNote && can ? html`<p class="hint">${d.undoNote}</p>` : ''}`)}
${can && l.outcome !== 'not_for_resale'
  ? html`<details><summary>Not for resale?</summary>
<form method="post" action="/runs/${id}/lines/${l.n}/not-for-resale" class="stack">${csrfField(user)}
<label class="check"><input type="checkbox" name="confirm" value="1" required> The store never sells this (kitchen supplies). It is skipped on every invoice from this supplier from now on.</label>
<button type="submit">Mark not for resale</button></form></details>`
  : ''}
${can ? form(user, `/runs/${id}/lines/${l.n}/skip`, { skip: l.skipped ? '0' : '1' }, l.skipped ? 'Put back in this run' : 'Leave out of this run', '', 'button-outline button-small') : ''}
</div>`
  : ''}
</li>`;
}

// ---- The run page ----

const READING_RESULT: Record<string, { text: string; kind: Kind }> = {
  ok: { text: 'Read cleanly', kind: 'ok' },
  review: { text: 'Read, but a person must look', kind: 'wait' },
  needs_approval: { text: 'Waiting for an admin to approve the cost', kind: 'stop' },
  retry: { text: 'Could not be read', kind: 'stop' },
};

function blockersBox(v: ReviewView): SafeHtml {
  const h = v.header;
  if (v.blockers.length) {
    return html`<section class="todo" id="todo" aria-labelledby="block-h"><h2 id="block-h">To settle before a dry run (${v.blockers.length})</h2>
<ol>${v.blockers.map((b) => html`<li>${b.anchor ? html`<a href="#${b.anchor}">${b.message}</a>` : html`<span class="todo-text">${b.message}</span>`}</li>`)}</ol></section>`;
  }
  if (h.state === 'ready' || h.state === 'dry_run_done') {
    return html`<section class="todo todo-clear" aria-labelledby="block-h"><h2 id="block-h">Nothing blocks</h2>
<div class="todo-body"><p>${h.state === 'ready' ? 'Every line is settled. Make a dry run to see what would change.' : 'Every line is settled and the dry run matches your decisions.'}</p></div></section>`;
  }
  return html``;
}

function actionBar(user: SessionUser, v: ReviewView): SafeHtml {
  const h = v.header;
  if (h.working) return html``;
  if (v.blockers.length && h.canDecide) {
    const first = v.blockers.find((b) => b.anchor)?.anchor;
    return html`<div class="action-bar"><a class="button" href="#${first ?? 'todo'}">Next: ${v.blockers.length} to settle</a></div>`;
  }
  if (h.state === 'ready' && h.canDecide) {
    return html`<form method="post" action="/runs/${h.id}/dry-run" class="action-bar">${csrfField(user)}<button type="submit" class="button-accent">Make a dry run</button></form>`;
  }
  if (h.state === 'dry_run_done' || h.state === 'approved') {
    return html`<div class="action-bar"><a class="button button-accent" href="/runs/${h.id}/dry-run">See the dry run</a></div>`;
  }
  return html``;
}

export function runPage(o: { user: SessionUser; view: ReviewView; error?: string; notice?: string; sheets?: SheetSectionView }): string {
  const v = o.view;
  const h = v.header;
  const r = v.reading;
  const can = h.canDecide;
  const supplier = v.supplier;
  const result = r ? (READING_RESULT[r.status] ?? { text: r.status, kind: 'mute' as Kind }) : null;
  return layout({
    title: `Invoice ${h.id}`,
    user: o.user,
    nav: 'runs',
    eyebrow: r?.supplierPrinted ? r.supplierPrinted : 'Invoice',
    refreshSeconds: h.working || sheetsChecking(o.sheets) ? 5 : undefined,
    body: html`${messages(o.error, o.notice)}
${statusPanel(o.user, v)}
${blockersBox(v)}
${historyBox(o.user, v)}
${v.bigChanges.total ? html`<p class="${v.bigChanges.toTick ? 'error' : 'notice'}"><strong>${v.bigChanges.total} ${v.bigChanges.total === 1 ? 'price moves' : 'prices move'} more than ${v.bigChanges.percent}%.</strong> ${v.bigChanges.toTick ? html`${v.bigChanges.toTick} still ${v.bigChanges.toTick === 1 ? 'needs its' : 'need their'} own tick.` : 'All confirmed.'}</p>` : ''}
${v.sameFiles.length ? html`<p class="error">The same files were uploaded in ${v.sameFiles.map((n, i) => html`${i ? ', ' : ''}<a href="/runs/${n}">invoice ${n}</a>`)}. Check this is not the same delivery twice.</p>` : ''}
${v.dryRun ? html`<p><a class="button button-outline" href="/runs/${h.id}/dry-run">See the dry run</a> <span class="hint">made ${v.dryRun.at}</span></p>` : ''}
${r
  ? html`<section aria-labelledby="reading-h">${eyebrow('The reading')}<h2 id="reading-h">Reading</h2>
<p>${result ? tag(result.text, result.kind) : ''}</p>
<p>${r.supplierPrinted}${r.invoiceNumber ? html`, invoice ${r.invoiceNumber}` : ''}${r.invoiceDate ? html`, dated ${r.invoiceDate}` : ''}${r.total ? html`, total ${r.total}` : ''}.</p>
<p class="hint">Read by ${r.model || 'no model'}: ${r.status}. Cost ${r.cost}. Square catalog: ${squareLabel(v.catalog.label)}, taken ${v.catalog.takenAt}.</p>
${r.reasons.length ? html`<details${r.status === 'ok' ? '' : html` open`}><summary>Why a person must look</summary><ul>${r.reasons.map((x) => html`<li>${x}</li>`)}</ul></details>` : ''}
${r.failedChecks.length
  ? html`<h3>Failed checks</h3><ul>${r.failedChecks.map(
      (c) => html`<li>${c.message}${c.details.length ? html`<ul>${c.details.map((d) => html`<li>${d}</li>`)}</ul>` : ''}
${c.accepted ? html` ${tag('Accepted after checking the paper', 'ok')}` : c.acceptable && can ? form(o.user, `/runs/${h.id}/checks/accept`, { checkId: c.id }, 'I checked it against the paper invoice') : !c.acceptable ? html` <span class="hint">Upload again to fix this.</span>` : ''}</li>`,
    )}</ul>`
  : ''}
${r.notices.length ? html`<details><summary>Notes (${r.notices.length})</summary><ul>${r.notices.map((x) => html`<li>${x}</li>`)}</ul></details>` : ''}
<details><summary>Checks</summary><ul>${r.checks.map((c) => html`<li>${c.passed ? 'Passed' : c.blocking ? 'Failed' : 'Note'}: ${c.message}</li>`)}</ul>
<p class="hint">${r.attempts.map((a) => `${a.role}: ${a.model}, ${a.outcome}, ${a.cost}.`).join(' ')}</p></details>
</section>`
  : ''}
${supplier
  ? html`<section aria-labelledby="supplier-h">${eyebrow('The supplier')}<h2 id="supplier-h">Supplier</h2>
${supplier.status === 'known'
  ? html`<p>${supplier.name}. <span class="hint">${supplier.vendor}</span></p>`
  : html`<p class="callout callout-warn">"${supplier.printed}" is new to ShelfReady.</p>
${can
  ? html`${supplier.suggestions.length ? html`<p>Is it one of these?</p><ul>${supplier.suggestions.map((s) => html`<li>${s.name} ${form(o.user, `/runs/${h.id}/supplier`, { supplierId: String(s.id) }, 'Same supplier')}</li>`)}</ul>` : ''}
${form(o.user, `/runs/${h.id}/supplier`, { create: '1' }, 'Add as a new supplier', '', 'button-accent')}`
  : ''}`}
${v.vendorClash ? html`<p class="error">${v.vendorClash}</p>` : ''}
</section>`
  : ''}
${v.lines.length ? html`<section aria-labelledby="lines-h">${eyebrow('The lines')}<h2 id="lines-h">Lines (${v.lines.length})</h2><ul class="cards-plain">${v.lines.map((l) => lineCard(o.user, v, l))}</ul></section>` : ''}
${v.credits.length || v.claim
  ? html`<section aria-labelledby="credit-h">${eyebrow('Short deliveries')}<h2 id="credit-h">Credits to claim</h2>
${v.credits.length ? html`<ul>${v.credits.map((c) => html`<li>Line ${c.n}: ${c.amount}. ${c.reason}</li>`)}</ul><p><strong>Total known: ${v.creditTotal}.</strong></p>` : html`<p>None.</p>`}
${v.claim ? html`<p>Claim terms printed on the invoice: "${v.claim.text}"${v.claim.deadline ? html`. Claim by ${v.claim.deadline}.` : ''}</p>` : html`<p class="hint">The invoice prints no claim deadline.</p>`}
</section>`
  : ''}
${cardsSection(o.user, v)}
${o.sheets ? sheetBox(o.user, o.sheets, 'run') : ''}
${v.decisions.length
  ? html`<section aria-labelledby="dec-h">${eyebrow('Your decisions')}<h2 id="dec-h">Decisions on this invoice (${v.decisions.length})</h2>
<ul class="decisions">${v.decisions.map((d) => html`<li><div class="undo-row"><span>${d.label} <span class="hint">(${d.by})</span></span>${can ? undoForm(o.user, h.id, d.kind, d.target) : ''}</div>${d.undoNote && can ? html`<p class="hint">${d.undoNote}</p>` : ''}</li>`)}</ul></section>`
  : ''}
${v.catalogNotes.length || v.stale.length
  ? html`<section aria-labelledby="notes-h"><h2 id="notes-h">Square catalog notes</h2>
<ul>${v.catalogNotes.map((n) => html`<li>${n}</li>`)}${v.stale.map((n) => html`<li>Saved match to pick again: ${n}</li>`)}</ul></section>`
  : ''}
${actionBar(o.user, v)}`,
  });
}

// ---- Search ----

export function searchPage(o: { user: SessionUser; runId: number; n: number; description: string; q: string; results: CandidateView[]; canDecide: boolean }): string {
  return layout({
    title: `Search Square for line ${o.n}`,
    user: o.user,
    nav: 'runs',
    eyebrow: `Invoice ${o.runId}`,
    body: html`<p class="lead">Line ${o.n}: ${o.description}</p>
<form method="get" action="/runs/${o.runId}/lines/${o.n}/search" class="inline"><label for="q">Search Square</label><input id="q" name="q" maxlength="100" value="${o.q}"><button type="submit">Search</button></form>
${o.q
  ? o.results.length
    ? html`<ul class="candidates">${o.results.map((c) => html`<li><p><strong>${c.label}</strong> ${tag(`${c.scorePercent}%`, 'mute')}</p>${o.canDecide ? form(o.user, `/runs/${o.runId}/lines/${o.n}/pick`, { variationId: c.variationId }, 'This one', '', 'button-accent') : ''}</li>`)}</ul>`
    : html`<p>Nothing found. Try the first words of the Square name.</p>`
  : ''}
<p><a class="button button-outline" href="/runs/${o.runId}#line-${o.n}">Back to the invoice</a></p>`,
  });
}

// ---- The dry run ----

function stat(n: number, label: string): SafeHtml {
  return html`<div><span class="stat-n">${String(n)}</span><span class="stat-l">${label}</span></div>`;
}

export function dryRunPage(o: { user: SessionUser; view: DryRunView; error?: string; sheets?: SheetSectionView; mailchimp?: SafeHtml }): string {
  const v = o.view;
  const h = v.header;
  const approved = h.state === 'approved';
  // Approved and past it: the send page carries on from here.
  const sent = SENDABLE.has(h.state);
  return layout({
    title: `Invoice ${h.id}: what would change`,
    user: o.user,
    nav: 'runs',
    mode: 'dry-run',
    eyebrow: 'Dry run',
    refreshSeconds: sheetsChecking(o.sheets) ? 5 : undefined,
    body: html`${messages(o.error)}
<p class="lead">This shows what approving would change. Nothing was sent to Square or the scales.</p>
<p class="hint">Made ${v.preview.computedAt.replace('T', ' ').slice(0, 16)} UTC from ${squareLabel(v.preview.catalog.label)}, taken ${v.preview.catalog.takenAt}.</p>
<div class="stat-grid">${stat(v.square.length, 'Square items')}${stat(v.scales.rows.length, 'Scale prices')}${stat(v.cards.length, 'Cards')}${stat(v.bigChanges, 'Big changes')}</div>
${v.bigChanges ? html`<p class="notice"><strong>${v.bigChanges} ${v.bigChanges === 1 ? 'price moves' : 'prices move'} more than ${v.bigChangePercent}%</strong>, each confirmed in review. They are marked below.</p>` : ''}
<section aria-labelledby="sq-h">${eyebrow('01')}<h2 id="sq-h">Square (${v.square.length})</h2>
${v.square.length
  ? html`<ul class="cards">${v.square.map(
      (s) => html`<li class="card${s.bigChange ? ' big-change' : ''}"><h3>${s.label}</h3><p class="hint">Lines ${s.lines}</p>${s.bigChange ? html`<p class="callout callout-warn"><strong>${s.bigChange}</strong></p>` : ''}<ul>${s.changes.map((c) => html`<li>${c}</li>`)}</ul>
${approved
  ? html`${s.lineStock.filter((x) => !v.corrections.some((c) => c.line === x.n)).map(
      (x) => html`<details><summary>Line ${x.n} did not arrive?</summary><form method="post" action="/runs/${h.id}/lines/${x.n}/not-arrived" class="stack">${csrfField(o.user)}
<label class="check"><input type="checkbox" name="confirm" value="1" required> Line ${x.n} did not arrive. Take its ${x.stock} back out of stock and claim the credit.</label><button type="submit">Record it</button></form></details>`,
    )}`
  : ''}</li>`,
    )}</ul>`
  : html`<p>No Square changes.</p>`}
${v.corrections.length
  ? html`<h3>Corrections after approval</h3><ul>${v.corrections.map((c) => html`<li>Line ${c.line} did not arrive: ${c.stockTakeBack ? html`take ${c.stockTakeBack} ${c.stockUnit === 'lb' ? 'lb' : 'units'} back out of stock, ` : ''}credit ${c.credit}. Recorded by ${c.recordedByName}. ${c.state === 'pending' ? html`Waiting to be sent to Square from the <a href="/runs/${h.id}/send">send page</a>.` : 'Sent.'}</li>`)}</ul>`
  : ''}
</section>
<section aria-labelledby="sc-h">${eyebrow('02')}<h2 id="sc-h">Scales (preview only, not contacted)</h2>
${v.scales.rows.length ? html`<ul>${v.scales.rows.map((r) => html`<li>Code ${r.code}, ${r.item}: ${r.price} on ${r.scales}</li>`)}</ul>` : html`<p>No scale prices change.</p>`}
</section>
<section aria-labelledby="cd-h">${eyebrow('03')}<h2 id="cd-h">Cards that would print (${v.cards.length})</h2>
${v.cards.length ? html`<ul class="cards">${v.cards.map((c) => html`<li class="card card-item"><div class="card-head"><h3>${c.title}</h3>${tag(c.source, 'mute')}</div><p class="hint">Version ${String(c.version)}.</p>${printedCard(c.printed)}</li>`)}</ul>` : html`<p>No cards.</p>`}
${v.cardsLeftOut.length ? html`<h3>No card</h3><ul>${v.cardsLeftOut.map((c) => html`<li>${c.title}: ${c.why}</li>`)}</ul>` : ''}
</section>
${o.mailchimp ?? ''}
${v.credits.length ? html`<section aria-labelledby="cr-h">${eyebrow('04')}<h2 id="cr-h">Credits to claim</h2><ul>${v.credits.map((c) => html`<li>Line ${c.n}: ${c.amount}. ${c.reason}</li>`)}</ul>${v.claim ? html`<p>"${v.claim.text}"${v.claim.deadline ? html`. Claim by ${v.claim.deadline}.` : ''}</p>` : ''}</section>` : ''}
${v.leftOut.length ? html`<section aria-labelledby="lo-h"><h2 id="lo-h">Not changed</h2><ul>${v.leftOut.map((l) => html`<li>Line ${l.n}: ${l.why}</li>`)}</ul></section>` : ''}
<section aria-labelledby="ap-h">${eyebrow('Last step')}<h2 id="ap-h">Approval</h2>
${sent
  ? html`<p class="notice">Approved by ${v.approval.approvedBy}, ${v.approval.approvedAt}.</p><p><a class="button button-accent" href="/runs/${h.id}/send">${h.state === 'approved' ? 'Go to sending' : 'See the send'}</a></p>`
  : v.approval.allowed
    ? html`<p>If this is right, approve it. Approving sends nothing yet.</p>`
    : html`<p class="callout callout-warn">Approval is not possible yet:</p><ul>${v.approval.problems.map((p) => html`<li>${p}</li>`)}</ul>`}
</section>
${o.sheets ? sheetBox(o.user, o.sheets, 'dry-run') : ''}
<p><a class="button button-outline" href="/runs/${h.id}">Back to the invoice</a></p>
${!sent && v.approval.allowed
  ? html`<form method="post" action="/runs/${h.id}/approve" class="action-bar">${csrfField(o.user)}<input type="hidden" name="hash" value="${v.preview.hash}"><button type="submit" class="button-red">Approve these changes</button></form>`
  : ''}`,
  });
}

// ---- Cards ----

/** A card as it will print: plain text in reading order. Never a link: every value is escaped. */
function printedCard(p: PrintedCardView): SafeHtml {
  return html`<div class="printed-card">
<p class="pc-eyebrow">${p.eyebrow}${p.origin ? html` · ${p.origin}` : ''}</p>
<p class="pc-name">${p.n1}${p.n2 ? html`<em>${p.n2}</em>` : ''}</p>
<p class="pc-producer">${p.producer}</p>
${p.specs.length ? html`<dl class="pc-specs">${p.specs.map((s) => html`<dt>${s.label}</dt><dd>${s.value}</dd>`)}</dl>` : ''}
<div class="pc-copy">${p.copy.map((para) => html`<p>${para}</p>`)}</div>
<p class="pc-foot"><span class="pc-price">${p.price}</span> <span class="pc-unit">${p.unit}</span>${p.code ? html` <span class="pc-code">code ${p.code}</span>` : ''}</p>
</div>`;
}

function cardEditForm(user: SessionUser, runId: number, c: CardView): SafeHtml {
  const e = c.edit!;
  const id = (name: string) => `${c.anchor}-${name}`;
  const known = e.categories.includes(e.eyebrow.toUpperCase());
  return html`<details><summary>Edit the card text</summary>
<form method="post" action="/runs/${runId}/cards/edit" class="stack">${csrfField(user)}
<input type="hidden" name="variationId" value="${c.variationId}">
<input type="hidden" name="cardId" value="${String(c.cardId)}">
<input type="hidden" name="version" value="${String(c.version)}">
<p class="hint">Price and scale code come from pricing and Square, never from the card text. A price, phone number or web address is refused.${c.source === 'generated' || c.needsCheck ? ' An edit of a card the model wrote needs a new check.' : ''}</p>
<label for="${id('eyebrow')}">Category</label>
<select id="${id('eyebrow')}" name="eyebrow">${known ? '' : html`<option value="${e.eyebrow}" selected>${e.eyebrow} (as printed)</option>`}${e.categories.map((w) => html`<option value="${w}"${known && w === e.eyebrow.toUpperCase() ? html` selected` : ''}>${w}</option>`)}</select>
<label for="${id('origin')}">Origin line</label><input id="${id('origin')}" name="origin" maxlength="80" value="${e.origin}">
<label for="${id('n1')}">Name, first part (black)</label><input id="${id('n1')}" name="n1" maxlength="80" value="${e.n1}">
<label for="${id('n2')}">Name, second part (red italic)</label><input id="${id('n2')}" name="n2" maxlength="80" value="${e.n2}">
<label for="${id('producer')}">Producer (Maker · Place)</label><input id="${id('producer')}" name="producer" maxlength="160" value="${e.producer}">
${e.specs.map(
  (sp, i) => html`<label for="${id(`s${i + 1}l`)}">Spec ${i + 1} label</label><input id="${id(`s${i + 1}l`)}" name="spec${i + 1}Label" maxlength="40" value="${sp.label}">
<label for="${id(`s${i + 1}v`)}">Spec ${i + 1} value</label><input id="${id(`s${i + 1}v`)}" name="spec${i + 1}Value" maxlength="80" value="${sp.value}">`,
)}
${e.paragraphs.slice(0, 4).map((para, i) => html`<label for="${id(`p${i + 1}`)}">Paragraph ${i + 1}</label><textarea id="${id(`p${i + 1}`)}" name="p${i + 1}" rows="4" maxlength="1500">${para}</textarea>`)}
<label for="${id('unit')}">Unit (PER POUND for goods sold by weight, else the pack size)</label><input id="${id('unit')}" name="unit" maxlength="40" value="${e.unit}">
<button type="submit">Save the card</button></form></details>`;
}

function cardItem(user: SessionUser, v: ReviewView, c: CardView): SafeHtml {
  const id = v.header.id;
  const can = v.header.canDecide;
  const kind: Kind = c.leftOut ? 'mute' : c.waitingFor.length === 0 ? 'ok' : 'wait';
  return html`<li class="card card-item" id="${c.anchor}">
<div class="card-head"><h3>Card: ${c.label}</h3>${tag(c.status, kind)}</div>
<p>Source: ${tag(c.sourceLabel, 'mute')} Lines ${c.lines.join(', ')}.${c.pendingLink ? ' Matched to a stored card for sure; the link is saved when the invoice is sent.' : ''}</p>
${!c.leftOut && c.waitingFor.length ? html`<ul class="callout callout-warn">${c.waitingFor.map((w) => html`<li>${w}</li>`)}</ul>` : ''}
${c.printed ? html`<h4 class="block-label">As it will print</h4>${printedCard(c.printed)}` : ''}
${c.suggestions.length
  ? html`<h4 class="block-label">A stored card may be this product</h4><ul class="candidates">${c.suggestions.map(
      (sg) => html`<li><p><strong>${sg.name}</strong>, ${sg.producer}, ${sg.unit}. <span class="hint">${sg.source === 'edited' ? 'Edited in the app' : sg.source === 'imported' ? 'Imported' : 'Written by the model'}. ${sg.reasons.join(' ')}</span></p><p class="hint">${sg.firstParagraph}</p>
${can ? html`${form(user, `/runs/${id}/cards/confirm`, { variationId: c.variationId, cardId: String(sg.cardId) }, 'Yes, this is the product', '', 'button-accent')} ${form(user, `/runs/${id}/cards/reject`, { variationId: c.variationId, cardId: String(sg.cardId) }, 'No, another product', '', 'button-outline')}` : ''}</li>`,
    )}</ul>`
  : ''}
${c.blocked.length ? html`<p class="callout callout-stop">Blocked until edited: ${c.blocked.join(' ')}</p>` : ''}
${c.problems.length ? html`<h4 class="block-label">Out of limits</h4><ul>${c.problems.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
${c.styleNotes.length ? html`<h4 class="block-label">Style notes</h4><ul>${c.styleNotes.map((p) => html`<li>${p}</li>`)}</ul>` : ''}
${c.written
  ? html`<h4 class="block-label">Check before printing</h4>
${c.checkList.length ? html`<ul class="checklist-check">${c.checkList.map((x) => html`<li>${x.text} <span class="hint">(${x.kind}, ${x.from})</span></li>`)}</ul>` : html`<p>The list is empty. That proves nothing: check the card against its sources and the package anyway.</p>`}
${c.written.productIdentified ? '' : html`<p class="callout callout-stop">The model could not find this exact product on the web.</p>`}
${c.written.sellingPoint ? html`<p class="hint">Selling point: ${c.written.sellingPoint}</p>` : ''}
<h4 class="block-label">Sources</h4>
${c.sources.length ? html`<ul>${c.sources.map((x) => html`<li>${x.title || 'Untitled page'}, on <strong>${x.host || 'an unknown site'}</strong>: <span class="hint">${x.url}</span>${x.usedFor ? html`. Used for ${x.usedFor}.` : ''}</li>`)}</ul>` : html`<p>No sources.</p>`}
<p class="hint">Addresses are shown as text, not links. Copy one into the browser to open it.</p>
${c.searches.length ? html`<details><summary>Searches (${c.searches.length})</summary><ul>${c.searches.map((x) => html`<li>${x.query}: ${x.error ? html`failed (${x.error})` : html`${String(x.results)} results`}</li>`)}</ul></details>` : ''}
<p class="hint">Written by ${c.written.model}, ${c.written.at}, for ${c.written.cost}.</p>`
  : ''}
${c.copyState ? html`<p class="hint">Card copy spent in this invoice for this card: ${c.runCost}.</p>` : ''}
${c.pendingApproval && !c.leftOut ? html`<p>Writing this card could cost up to $${c.pendingApproval.usd} with ${c.pendingApproval.model}. It waits for the <a href="#copy-approval">approval of all waiting cards</a>, or leave it out of this run.</p>` : ''}
${can && c.canWrite ? form(user, `/runs/${id}/cards/write`, { variationId: c.variationId }, 'Write copy now', '', 'button-accent') : ''}
${can && c.needsCheck && c.cardId !== null && !c.leftOut
  ? html`<form method="post" action="/runs/${id}/cards/check" class="stack">${csrfField(user)}
<input type="hidden" name="variationId" value="${c.variationId}"><input type="hidden" name="cardId" value="${String(c.cardId)}"><input type="hidden" name="version" value="${String(c.version)}">
<label class="check"><input type="checkbox" name="confirm" value="1" required> I checked every item on the list, and the card, against the sources and the package.</label>
<button type="submit" class="button-accent">Mark this version checked</button></form>`
  : ''}
${can && c.edit ? cardEditForm(user, id, c) : ''}
${can ? form(user, `/runs/${id}/cards/leave-out`, { variationId: c.variationId, leaveOut: c.leftOut ? '0' : '1' }, c.leftOut ? 'Make a card in this run after all' : 'Leave the card out of this run', '', 'button-outline button-small') : ''}
</li>`;
}

function cardsSection(user: SessionUser, v: ReviewView): SafeHtml {
  const s = v.cardsSummary;
  return html`<section aria-labelledby="cards-h">${eyebrow('The shelf cards')}<h2 id="cards-h">Cards (${s.total})</h2>
${s.total
  ? html`<p>${String(s.prints)} ${s.prints === 1 ? 'prints' : 'print'} as shown, ${String(s.waiting)} ${s.waiting === 1 ? 'needs' : 'need'} a person${s.leftOut ? html`, ${String(s.leftOut)} left out` : ''}. Card copy in this invoice has cost ${s.spent}.</p>
${s.budget ? html`<p class="hint">${s.budget}</p>` : ''}
${v.copyApproval
  ? html`<div class="callout callout-warn" id="copy-approval"><p><strong>${String(v.copyApproval.count)} ${v.copyApproval.count === 1 ? 'card waits' : 'cards wait'} for a cost approval: up to $${v.copyApproval.totalUsd} in all with ${v.copyApproval.model}.</strong> ${v.copyApproval.why}</p>
${user.role === 'admin' && v.header.canDecide
  ? form(user, `/runs/${v.header.id}/cards/approve-cost`, { model: v.copyApproval.model, totalUsd: v.copyApproval.totalUsd, fingerprint: v.copyApproval.fingerprint }, `Approve up to $${v.copyApproval.totalUsd} for all ${v.copyApproval.count} with ${v.copyApproval.model}`, '', 'button-red')
  : html`<p class="hint">Ask an admin to approve them, or leave cards out of this run.</p>`}</div>`
  : ''}
${v.header.canDecide && s.canWrite > 1 ? form(user, `/runs/${v.header.id}/cards/write`, { all: '1' }, `Write copy for all ${s.canWrite} cards with none`, '', 'button-accent') : ''}
<ul class="cards-plain">${v.cards.map((c) => cardItem(user, v, c))}</ul>`
  : html`<p>No cards yet. Lines where nothing arrived make no card.</p>`}
</section>`;
}

// ---- The card sheet ----

/** A sheet check is waiting or running, so the page refreshes itself. */
function sheetsChecking(s: SheetSectionView | undefined): boolean {
  return !!s && s.sheets.some((r) => r.checkState === 'queued' || r.checkState === 'checking');
}

const CHECK_KIND: Record<SheetRowView['checkState'], Kind> = { queued: 'wait', checking: 'wait', passed: 'ok', failed: 'stop', unchecked: 'wait' };

function sheetRow(user: SessionUser, runId: number, r: SheetRowView, from: Record<string, string>): SafeHtml {
  return html`<li class="card"><div class="card-head"><h3>${r.label}</h3>${tag(r.checkLabel, CHECK_KIND[r.checkState])}</div>
<p>${String(r.cards)} ${r.cards === 1 ? 'card' : 'cards'} on ${String(r.pages)} ${r.pages === 1 ? 'page' : 'pages'}. Made by ${r.madeBy}, ${r.madeAt}. <span class="hint">sha256 ${r.hash}</span></p>
${r.checkMessage ? html`<p class="${r.checkState === 'failed' ? 'callout callout-stop' : r.checkState === 'unchecked' ? 'callout callout-warn' : 'hint'}">${r.checkMessage}</p>` : ''}
${r.failures.length ? html`<ul>${r.failures.map((f) => html`<li><strong>${f.name || 'A card'}</strong> (${f.where}): ${f.problems.join(' ')}</li>`)}</ul>` : ''}
${r.download
  ? html`<p><a class="button${r.checkState === 'unchecked' ? ' button-outline' : ' button-accent'}" href="${r.download}">${r.checkState === 'unchecked' ? 'Download anyway' : 'Download'}</a> <span class="hint">${r.fileName}</span></p>`
  : html`<p class="hint">${r.refusal}</p>`}
${r.canRecheck ? form(user, `/runs/${runId}/card-sheets/${r.id}/check`, from, 'Check again', '', 'button-outline button-small') : ''}
<details><summary>Cards on it (${String(r.cards)})</summary><ol>${r.names.map((n) => html`<li>${n}</li>`)}</ol></details>
</li>`;
}

/** The card sheet: made after approval, downloaded once Square has the prices. */
function sheetBox(user: SessionUser, s: SheetSectionView, page: 'run' | 'dry-run'): SafeHtml {
  const from: Record<string, string> = page === 'dry-run' ? { from: 'dry-run' } : {};
  const head = html`${eyebrow('Shelf cards')}<h2 id="sheet-h">Card sheet</h2>`;
  if (!s.canMake) {
    return html`<section aria-labelledby="sheet-h">${head}<p>The card sheet is made once this invoice is approved. It holds exactly the cards the dry run lists.</p></section>`;
  }
  return html`<section aria-labelledby="sheet-h">${head}
<p>The sheet holds the ${String(s.approvedCards)} ${s.approvedCards === 1 ? 'card' : 'cards'} the approved dry run lists, at the prices sent to Square, four to a page.${s.squareDone ? '' : ' It can be made and checked now. The download opens once Square has this invoice\'s prices.'}</p>
<p class="hint">Open the .docx in Google Drive as it is. Do not convert it to a Google Doc: that pushes the bottom cards onto a second page.</p>
${s.notArrived.length ? html`<p class="callout callout-warn">No card for ${s.notArrived.map((c, i) => html`${i ? ', ' : ''}${c.title} (line ${c.lines.join(', ')})`)}: marked as not arrived after approval, so ${s.notArrived.length === 1 ? 'it is' : 'they are'} left off the sheet.</p>` : ''}
${s.canMakeRunSheet ? form(user, `/runs/${s.runId}/card-sheet`, from, `Make the card sheet (${s.approvedCards} ${s.approvedCards === 1 ? 'card' : 'cards'})`, '', 'button-accent') : ''}
${s.sheets.length ? html`<ul class="cards">${s.sheets.map((r) => sheetRow(user, s.runId, r, from))}</ul>` : ''}
${s.reprintChoices.length
  ? html`<details><summary>Reprint some cards</summary>
<form method="post" action="/runs/${s.runId}/card-sheet/reprint" class="stack">${csrfField(user)}${page === 'dry-run' ? html`<input type="hidden" name="from" value="dry-run">` : ''}
<p class="hint">A reprint uses each card's text as it is now, with the price this invoice sent to Square.</p>
${s.reprintChoices.map((c) => html`<label class="check"><input type="checkbox" name="card_${String(c.index)}" value="1"> ${c.title} <span class="hint">${c.price} ${c.unit}</span></label>`)}
<button type="submit">Make a reprint</button></form></details>`
  : ''}
</section>`;
}
