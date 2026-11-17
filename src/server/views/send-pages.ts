// The send page: Send to Square and the scales, the scale preview with every warning and drift to
// accept, the result per scale, and resend for a pending scale. A minimal page built only from the
// view model in src/runs/send-view.ts; the frontend engineer restyles it. Every value is escaped by
// the html template. No inline script or style. Each form carries the session's CSRF token, and
// each form field appears once (the server refuses a field sent twice), so drift tokens are
// numbered fields.

import type { SessionUser } from '../../auth/sessions.ts';
import type { PreviewView, ScaleRow, SendView } from '../../runs/send-view.ts';
import type { SquareReportItem } from '../../runs/square-send.ts';
import { money } from '../../runs/review.ts';
import { html, type SafeHtml } from './html.ts';
import { csrfField, layout, messages } from './pages.ts';

const PART: Record<string, string> = { done: 'done', failed: 'refused by Square', unknown: 'no answer yet', not_sent: 'not sent' };

function form(user: SessionUser, action: string, body: SafeHtml, button: string, kind = 'button'): SafeHtml {
  return html`<form method="post" action="${action}" class="stack">${csrfField(user)}${body}<button type="submit" class="${kind}">${button}</button></form>`;
}

function itemLines(i: SquareReportItem): SafeHtml {
  const parts: string[] = [];
  if (i.rename) parts.push(`Name to "${i.rename.to}": ${PART[i.rename.state]}`);
  if (i.price) parts.push(`Price ${money(i.price.toCents)}${i.price.perPound ? ' per pound' : ''}: ${PART[i.price.state]}`);
  if (i.switchToWeight) parts.push(`Sold by weight: ${PART[i.switchToWeight.state]}`);
  if (i.tracking) parts.push(`Stock tracking on: ${PART[i.tracking.state]}`);
  if (i.stock) parts.push(`Stock set to ${i.stock.to}${i.stock.unit === 'lb' ? ' lb' : ''}: ${PART[i.stock.state]}${i.stock.squareNow !== null ? ` (Square shows ${i.stock.squareNow})` : ''}`);
  const rb = i.readBack;
  return html`<li><strong>${i.label}</strong>
  <ul>${parts.map((p) => html`<li>${p}</li>`)}</ul>
  ${rb ? html`<p class="hint">Read back: ${rb.name}, ${rb.priceCents === null ? 'no fixed price' : money(rb.priceCents)}${rb.perPound ? ' per pound' : ''}, ${rb.pricingType === 'FIXED_PRICING' ? 'fixed price' : 'price at the register'}, tracking ${rb.tracked ? 'on' : 'off'}.</p>` : html`<p class="hint">Not read back.</p>`}
  ${i.problems.map((p) => html`<p class="error">${p}</p>`)}</li>`;
}

function squareBlock(v: SendView): SafeHtml {
  const r = v.square;
  if (!r) return html``;
  return html`<section class="stack" aria-labelledby="sq"><h2 id="sq">Square</h2>
  <p>${r.ok ? 'Square is done and read back.' : `Square did not finish. ${r.stopped}`}</p>
  ${r.warnings.map((w) => html`<p class="hint">${w}</p>`)}
  <ul class="stack">${r.items.map(itemLines)}</ul>
  ${r.corrections.length ? html`<h3>Corrections</h3><ul>${r.corrections.map((c) => html`<li>Line ${String(c.line)}: take back ${c.takeBack || 'nothing'}: ${PART[c.state]}</li>`)}</ul>` : ''}
  <details><summary>Square writes (${String(r.writes.length)})</summary><ul>${r.writes.map((w) => html`<li>${w.step}: ${String(w.objects)} ${w.objects === 1 ? 'object' : 'objects'}, ${w.state}${w.attempts > 1 ? `, ${w.attempts} tries` : ''}${w.error ? `: ${w.error}` : ''}</li>`)}</ul></details>
</section>`;
}

function previewBody(p: PreviewView): SafeHtml {
  return html`${p.expiresAt ? html`<p class="hint">ScaleConnect keeps this preview until ${p.expiresAt}.${p.expired ? ' It has expired.' : ''}</p>` : ''}
  ${p.differences.length ? html`<h3>Changes</h3><ul>${p.differences.map((d) => html`<li>Code ${d.plu}: ${d.fields}</li>`)}</ul>` : ''}
  ${p.leftOut.length ? html`<p class="error">Left out: ${p.leftOut.join(', ')}. ${p.leftOut.length === 1 ? 'It' : 'They'} gave no reply earlier. Nothing is read or sent there.</p>` : ''}
  ${p.warnings.length ? html`<h3>Warnings</h3><ul>${p.warnings.map((w) => html`<li><strong>${w.code}</strong>: ${w.message}</li>`)}</ul>` : html`<p>No warnings.</p>`}
  ${p.drift.length || p.driftTokens.length ? html`<h3>Differences found on the scales</h3><ul>${(p.drift.length ? p.drift : p.driftTokens.map((t) => ({ token: t, scale: '', plu: '', text: '' }))).map((d) => html`<li>${d.scale} ${d.plu ? `code ${d.plu}` : ''} ${d.text} <code>${d.token}</code></li>`)}</ul>` : ''}
  ${p.driftCannotAck.map((d) => html`<p class="error">${d}</p>`)}
  ${p.blockedWhy ? html`<p class="error" role="alert">${p.blockedWhy}</p>` : ''}
  <details><summary>ScaleConnect's summary</summary><pre>${p.summary}</pre></details>`;
}

function scalePreviewBlock(user: SessionUser, v: SendView): SafeHtml {
  const p = v.scalePreview;
  if (!p) return v.canNewPreview ? html`<section class="stack"><h2>Scales</h2>${form(user, `/runs/${v.runId}/send/scale-preview`, html``, 'Prepare the scale change (reads the scales)')}</section>` : html``;
  const canAccept = !p.blockedWhy && !p.expired && p.previewId !== '' && !v.working;
  const ack = canAccept
    ? form(
        user,
        `/runs/${v.runId}/send/scales`,
        html`<input type="hidden" name="stepId" value="${String(p.stepId)}">
${p.mustAcknowledge ? html`<label class="check"><input type="checkbox" name="ack" value="${p.digest}"> I have read every warning above and accept ${p.warnings.length === 1 ? 'it' : 'them all'}.</label>` : ''}
${p.driftTokens.map((t, i) => html`<label class="check"><input type="checkbox" name="drift_${String(i)}" value="${t}"> Accept the difference <code>${t}</code>.</label>`)}`,
        'Send to the scales',
        'button button-accent',
      )
    : html``;
  return html`<section class="stack" aria-labelledby="sp"><h2 id="sp">Scale change</h2>
  ${previewBody(p)}
  ${ack}
  ${v.canNewPreview ? form(user, `/runs/${v.runId}/send/scale-preview`, html``, 'Make a new preview (reads the scales)', 'button button-outline') : ''}
</section>`;
}

function scaleRow(user: SessionUser, v: SendView, s: ScaleRow): SafeHtml {
  const r = s.resend;
  return html`<li class="stack"><strong>${s.name}</strong>: ${s.statusLabel}${s.targeted ? '' : ' (left out of this test run)'}${s.mayBeFrozen ? html` <span class="error">May be frozen. Someone should look at it.</span>` : ''}
  ${s.missing.length ? html`<ul>${s.missing.map((m) => html`<li>Code ${m.code}, ${m.itemName}: ${m.price}. ${s.name} ${m.why}.</li>`)}</ul>` : ''}
  ${r ? html`<p>Resend: ${r.label}. ${r.message} <span class="hint">Looked at by ${r.lookedByName}, ${r.lookedAt}.</span></p>` : ''}
  ${r && r.settles.length ? html`${r.settles.map(previewBody)}${s.canAcceptSettle ? form(user, `/runs/${v.runId}/send/resend/accept`, html`<input type="hidden" name="scale" value="${s.name}"><label class="check"><input type="checkbox" name="digest" value="${r.digest}"> Yes: send the catalog's record to ${s.name} for each item above. I have read every warning shown.</label>${r.settles.flatMap((x) => x.driftTokens).map((t, i) => html`<label class="check"><input type="checkbox" name="drift_${String(i)}" value="${t}"> Accept the difference <code>${t}</code>.</label>`)}`, `Send the settle to ${s.name}`, 'button button-accent') : ''}` : ''}
  ${s.canLook ? form(user, `/runs/${v.runId}/send/resend/look`, html`<input type="hidden" name="scale" value="${s.name}"><label class="check"><input type="checkbox" name="looked" value="1"> Someone has looked at ${s.name}, and rebooted it if it needed that.</label>`, `Resend to ${s.name}`) : ''}
</li>`;
}

export function sendPage(o: { user: SessionUser; view: SendView; where: string; error?: string; mailchimp?: SafeHtml; /** The run was read in live Square: the page carries the LIVE banner. */ live?: boolean }): string {
  const v = o.view;
  const st = v.start;
  const startForm = st
    ? html`<section class="stack" aria-labelledby="go"><h2 id="go">${st.retry ? 'Send the rest to Square' : 'Send'}</h2>
  <p>${String(st.squareItems)} Square ${st.squareItems === 1 ? 'item' : 'items'}, then ${String(st.scalePrices)} scale ${st.scalePrices === 1 ? 'price' : 'prices'}. Square goes first. The scales go only if Square fully succeeds.</p>
  ${st.expiresAt ? html`<p class="hint">The approval is good until ${st.expiresAt}.</p>` : ''}
  ${st.replayOnly ? html`<p>The approval has expired, and part of this invoice is already in Square. Send again only resends the writes whose answer was lost, with the same keys. Nothing new is written. The scales then get only the prices Square has.</p>` : ''}
  ${st.problems.map((p) => html`<p class="error">${p}</p>`)}
  ${st.canStart
    ? form(
        o.user,
        `/runs/${v.runId}/send/start`,
        html`<input type="hidden" name="hash" value="${st.hash}">
${st.retry ? '' : html`<fieldset><legend>Scales to send to</legend>${st.scales.map((s) => html`<label class="check"><input type="checkbox" name="scale_${s.name}" value="1"${s.checked ? html` checked` : ''}> ${s.name}</label>`)}${st.notAllowed.length ? html`<p class="hint">Not allowed to get writes (server config): ${st.notAllowed.join(', ')}. A send to fewer than all scales ends partly sent, with the others listed as missing the prices.</p>` : ''}</fieldset>`}`,
        st.retry ? 'Send the rest to Square' : 'Send to Square, then the scales',
        'button button-accent button-xl',
      )
    : ''}
  ${st.canStop ? form(o.user, `/runs/${v.runId}/send/stop`, html`<label class="check"><input type="checkbox" name="confirm" value="1"> Nothing reached Square. Stop this send, and upload the invoice again later.</label>`, 'Stop this send', 'button button-outline') : ''}
  ${st.canRedoDryRun ? form(o.user, `/runs/${v.runId}/send/redo-dry-run`, html``, 'Set the approval aside and make a new dry run', 'button button-outline') : ''}
</section>`
    : html``;
  return layout({
    title: `Send invoice ${v.runId}`,
    user: o.user,
    nav: 'runs',
    mode: o.live ? 'live' : undefined,
    eyebrow: `Invoice ${v.runId}`,
    refreshSeconds: v.working ? 5 : undefined,
    body: html`${messages(o.error)}
<p class="lead">${v.phaseLabel || v.stateLabel}</p>
<p class="hint">${o.where}</p>
${v.message ? html`<p>${v.message}</p>` : ''}
${v.working ? html`<p class="notice" role="status">Working. This page updates by itself. You can leave and come back.</p>` : ''}
${startForm}
${squareBlock(v)}
${scalePreviewBlock(o.user, v)}
${v.unknownWrites.length ? html`<section class="stack" aria-labelledby="uw"><h2 id="uw">Square writes with no answer</h2><p>Square did not answer these, and they could not be sent again with the same key. Each may or may not be in Square. Check Square, then say what you found. ShelfReady never sends them with a new key on its own.</p><ul class="stack">${v.unknownWrites.map((w) => html`<li>${w.step}: ${w.objects.join(', ')}. ${w.error}${v.canCheckWrites ? form(o.user, `/runs/${v.runId}/send/writes/check`, html`<input type="hidden" name="writeId" value="${String(w.id)}"><fieldset><legend>In Square?</legend><label class="check"><input type="radio" name="landed" value="yes"> It is in Square</label><label class="check"><input type="radio" name="landed" value="no"> It is not in Square</label></fieldset><label class="check"><input type="checkbox" name="confirm" value="1"> I checked Square myself.</label>`, 'Record what Square holds') : ''}</li>`)}</ul></section>` : ''}
${v.canLookup ? form(o.user, `/runs/${v.runId}/send/lookup`, html`<p>A scale answer did not come back. Looking it up asks ScaleConnect only. It never sends the change again.</p>`, 'Look up the result') : ''}
${v.scales.length ? html`<section class="stack" aria-labelledby="sc"><h2 id="sc">Each scale</h2><ul class="stack">${v.scales.map((s) => scaleRow(o.user, v, s))}</ul></section>` : ''}
${o.mailchimp ?? ''}
${v.corrections.list.length ? html`<section class="stack"><h2>Corrections after approval</h2><ul>${v.corrections.list.map((c) => html`<li>Line ${String(c.line)}: take back ${c.takeBack || 'nothing'}${c.unit === 'lb' ? ' lb' : ''}, credit ${c.credit}. ${c.state}. Recorded by ${c.recordedByName}.</li>`)}</ul>${v.corrections.canSend ? form(o.user, `/runs/${v.runId}/send/corrections`, html``, 'Send the corrections to Square') : ''}</section>` : ''}
<p><a href="/runs/${String(v.runId)}">Back to the invoice</a></p>`,
  });
}
