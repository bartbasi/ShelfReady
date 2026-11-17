// The fish email on pages: what a dry run would change, what a send did, and the alerts and notes
// on the home page. Campaign titles, row names and HTML snippets come from Mailchimp: data, escaped
// by the html template like every other value. Snippets are shown as code, never as markup.

import type { SessionUser } from '../../auth/sessions.ts';
import type { MailchimpPreview } from '../../mailchimp/plan.ts';
import { centsText } from '../../mailchimp/html.ts';
import type { HeldRow, MailchimpTask } from '../../mailchimp/store.ts';
import { html, type SafeHtml } from './html.ts';
import { csrfField, eyebrow } from './pages.ts';

const STATE: Record<MailchimpTask['state'], string> = {
  queued: 'Waiting its turn',
  running: 'Working on it now',
  done: 'Done',
  stopped: 'Stopped',
  needs_person: 'Needs a person',
};

function rowList(title: string, items: Array<{ key: string; why: string }>): SafeHtml {
  if (!items.length) return html``;
  return html`<h3>${title}</h3><ul>${items.map((n) => html`<li><strong>${n.key}</strong>: ${n.why}</li>`)}</ul>`;
}

function snippets(before: string, after: string): SafeHtml {
  return html`<details><summary>Before and after in the email's code</summary><p class="hint">Before</p><pre><code>${before}</code></pre><p class="hint">After</p><pre><code>${after}</code></pre></details>`;
}

/** The fish email part of the dry run. Null preview: no fish price changes in this run. */
export function mailchimpDryRunSection(p: MailchimpPreview | null, index = '05'): SafeHtml {
  if (!p) return html``;
  const t = p.target;
  return html`<section aria-labelledby="mc-h">${eyebrow(index)}<h2 id="mc-h">Fish email in Mailchimp (preview only, nothing changed)</h2>
${p.warning ? html`<p class="callout callout-stop">${p.warning}</p>` : ''}
${p.problem ? html`<p class="callout callout-warn">${p.problem}</p>` : ''}
${t
  ? t.kind === 'stop'
    ? html`<p class="callout callout-stop">${t.reason}</p>`
    : html`<p>Send day: <strong>${t.dayText}</strong>. ${t.reason}</p>`
  : ''}
<p class="hint">On send, this happens right after Square confirms the prices, and only for prices Square confirmed. Mailchimp is read again then, so what it holds at that moment decides which email is changed.</p>
${p.titleFix ? (p.titleFix.from === '' ? html`<p>The copy is named "${p.titleFix.to}".</p>` : html`<p>Name: "${p.titleFix.from}" becomes "${p.titleFix.to}".</p>`) : ''}
${p.dateLine ? html`<p>Date line at the top: ${p.dateLine.from === null ? html`added, reading "${p.dateLine.to}"` : p.dateLine.from === p.dateLine.to ? html`already reads "${p.dateLine.to}"` : html`"${p.dateLine.from}" becomes "${p.dateLine.to}"`}.</p>` : ''}
${p.dateLineProblem ? html`<p class="callout callout-warn">${p.dateLineProblem}</p>` : ''}
${p.changes.length
  ? html`<h3>Prices that change (${p.changes.length})</h3><ul class="stack">${p.changes.map((c) => html`<li><strong>${c.key}</strong>: ${c.fromText}/${c.unit} becomes ${c.toText}/${c.unit}${c.section ? html` <span class="hint">(${c.section})</span>` : ''}${snippets(c.before, c.after)}</li>`)}</ul>`
  : p.planned.length && !p.problem && t?.kind !== 'stop'
    ? html`<p>No price in the email changes.</p>`
    : ''}
${p.heldNote ? html`<p class="callout">${p.heldNote}</p>` : ''}
${p.same.length ? html`<p class="hint">Already at the new price: ${p.same.join(', ')}.</p>` : ''}
${p.drift && p.drift.length ? html`<h3>Prices that differ from the register (${p.drift.length})</h3><p class="hint">Set to the register price in the same edit.</p><ul>${p.drift.map((d) => html`<li><strong>${d.key}</strong>: ${d.from} becomes ${d.to}</li>`)}</ul>` : ''}
${rowList('Not changed', p.notChanged)}
${p.unmatched.length ? html`<details><summary>${p.unmatched.length} email ${p.unmatched.length === 1 ? 'row has' : 'rows have'} no confirmed Square match, so ShelfReady never changes ${p.unmatched.length === 1 ? 'it' : 'them'}</summary><p>${p.unmatched.join(', ')}</p></details>` : ''}
</section>`;
}

/** The fish email part of the send page. */
export function mailchimpSendSection(task: MailchimpTask | null, preview: MailchimpPreview | null): SafeHtml {
  if (!task) {
    if (!preview) return html``;
    return html`<section class="stack" aria-labelledby="mc-s"><h2 id="mc-s">Fish email</h2><p>The fish email changes right after Square confirms the prices. Nothing has gone to Mailchimp yet.</p></section>`;
  }
  const r = task.result;
  const cls = task.alert === 'red' ? 'callout callout-stop' : task.alert === 'warn' ? 'callout callout-warn' : '';
  return html`<section class="stack" aria-labelledby="mc-s"><h2 id="mc-s">Fish email</h2>
<p><strong>${STATE[task.state]}.</strong></p>
${task.message ? html`<p class="${cls}">${task.message}</p>` : ''}
${r && r.campaignId ? html`<p>Campaign ${r.campaignId}${r.campaignTitle ? html`, "${r.campaignTitle}"` : ''}${r.mode === 'copy' ? ', copied from the last one sent' : ''}.${r.scheduledFor ? html` Scheduled for ${r.scheduledFor}.` : ''}</p>` : ''}
${r?.title ? html`<p>Name: "${r.title.from}" became "${r.title.to}".</p>` : ''}
${r?.dateLine ? html`<p>Date line: ${r.dateLine.from === null ? 'added' : html`"${r.dateLine.from}" became`} "${r.dateLine.to}".</p>` : ''}
${r && r.changes.length ? html`<h3>Prices changed</h3><ul class="stack">${r.changes.map((c) => html`<li><strong>${c.key}</strong>: ${c.from} became ${c.to}${c.why === 'drift' ? ' (set to the register price)' : ''}${snippets(c.before, c.after)}</li>`)}</ul>` : ''}
${task.plan && task.plan.length && (!r || !r.changes.length) ? html`<p class="hint">Prices to change: ${task.plan.map((p) => `${p.key} to ${centsText(p.toCents)}`).join(', ')}.</p>` : ''}
${r ? rowList('Not changed', r.notChanged) : ''}
${r && r.notCompared && r.notCompared.length ? html`<details><summary>${r.notCompared.length} ${r.notCompared.length === 1 ? 'row was' : 'rows were'} not compared with the register</summary><ul>${r.notCompared.map((n) => html`<li>${n.key}: ${n.why}</li>`)}</ul></details>` : ''}
${r && r.problems.length ? html`<ul>${r.problems.map((x) => html`<li>${x}</li>`)}</ul>` : ''}
</section>`;
}

/** Alerts and notes for the home page, each with a button to mark it seen. */
export function mailchimpAlerts(user: SessionUser, alerts: readonly MailchimpTask[]): SafeHtml {
  if (!alerts.length) return html``;
  const reds = alerts.filter((a) => a.alert === 'red');
  return html`<section aria-labelledby="mc-alerts-h">
<h2 id="mc-alerts-h">Fish email</h2>
${reds.length ? html`<p class="error" role="alert"><strong>A fish email needs a person now. It may not go out, or may go out wrong.</strong></p>` : ''}
<ul class="stack">${alerts.map(
    (a) => html`<li class="${a.alert === 'red' ? 'callout callout-stop' : a.alert === 'warn' ? 'callout callout-warn' : 'callout'}">
<p>${a.kind === 'check' ? 'Evening or morning check' : html`Invoice <a href="/runs/${String(a.runId)}/send">${String(a.runId)}</a>`}: ${a.message}</p>
${a.state === 'running' || a.state === 'queued'
  ? ''
  : html`<form method="post" action="/mailchimp/alerts/${String(a.id)}/clear">${csrfField(user)}<button type="submit" class="button button-outline">${a.alert === 'red' ? 'I have dealt with it' : 'Seen'}</button></form>`}
</li>`,
  )}</ul>
</section>`;
}

/** Admin only: held price changes over three weeks old, each with a button to set it aside. */
export function mailchimpOldHeld(user: SessionUser, rows: readonly HeldRow[]): SafeHtml {
  if (!rows.length) return html``;
  return html`<section aria-labelledby="mc-old-h">
<h2 id="mc-old-h">Old fish email price changes</h2>
<p class="callout callout-warn">These invoice price changes are over three weeks old and never went into a fish email. ShelfReady will not put them in on its own. Check each in Mailchimp, then set it aside.</p>
<ul class="stack">${rows.map(
    (r) => html`<li><strong>${r.rowKey}</strong>: ${centsText(r.toCents)}, for ${r.day}${r.runId !== null ? html`, from invoice ${String(r.runId)}` : ''}.
<form method="post" action="/mailchimp/held/${String(r.id)}/dismiss">${csrfField(user)}<button type="submit" class="button button-outline">Set aside</button></form></li>`,
  )}</ul>
</section>`;
}
