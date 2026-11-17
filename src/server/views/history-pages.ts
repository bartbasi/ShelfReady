// Pages for old invoices: the list with the downloads, the upload, and one invoice with its lines
// and photos. Record only: every page says nothing changes in Square, the scales or the cards.
// Every value is escaped by the html template. No inline script or style. The upload page uses
// the same static upload script as invoice runs, and works without it.
//
// The upload form puts the CSRF token first, so the server checks it before reading any file.

import type { SessionUser } from '../../auth/sessions.ts';
import type { PurchaseFile, PurchaseInvoice, PurchaseLineRow, PurchaseState } from '../../history/store.ts';
import { formatCents } from '../../invoice/money.ts';
import { html, type SafeHtml } from './html.ts';
import { csrfField, layout, messages } from './pages.ts';

export const RECORD_ONLY = 'Old invoice: record only. Nothing changes in Square, the scales or the cards.';

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function recordOnly(): SafeHtml {
  return html`<p class="notice record-only" role="note"><strong>Old invoice: record only.</strong> Nothing changes in Square, the scales or the cards.</p>`;
}

type Kind = 'ok' | 'wait' | 'stop' | 'mute';

const STATE: Record<PurchaseState, { label: string; kind: Kind }> = {
  uploaded: { label: 'Reading', kind: 'wait' },
  reading: { label: 'Reading', kind: 'wait' },
  done: { label: 'Done', kind: 'ok' },
  failed: { label: 'Failed', kind: 'mute' },
};

function tag(text: string, kind: Kind): SafeHtml {
  return html`<span class="tag tag-${kind}">${text}</span>`;
}

function money(cents: number | null): string {
  return cents === null ? '' : `$${formatCents(cents)}`;
}

function title(inv: PurchaseInvoice): string {
  const parts = [inv.vendor, inv.invoiceNumber ? `#${inv.invoiceNumber}` : ''].filter(Boolean).join(' ');
  const head = inv.source === 'run' ? `Invoice run ${inv.runId}` : `Old invoice ${inv.id}`;
  return parts ? `${head}: ${parts}` : head;
}

/** A run's lines are seen on the run's own page. */
function href(inv: PurchaseInvoice): string {
  return inv.source === 'run' ? `/runs/${inv.runId}` : `/history/${inv.id}`;
}

// ---- The list and the downloads ----

export function historyListPage(o: { user: SessionUser; invoices: PurchaseInvoice[]; from?: string; to?: string; error?: string }): string {
  const rows = o.invoices.map((inv) => {
    const st = STATE[inv.state];
    const date = inv.invoiceDateIso || inv.invoiceDate;
    return html`<li><a class="run-link" href="${href(inv)}">
  <span class="run-title">${title(inv)}</span>
  <span class="run-meta">${inv.source === 'run' ? tag('Invoice run', 'ok') : tag('Old invoice', 'mute')}${inv.runStopped ? tag('Stopped', 'stop') : tag(st.label, st.kind)}${inv.state === 'done' ? html`${tag(`${inv.lineCount} ${inv.lineCount === 1 ? 'line' : 'lines'}`, 'mute')}${inv.runStopped ? tag('all to check', 'wait') : inv.needsCheckCount ? tag(`${inv.needsCheckCount} to check`, 'wait') : ''}` : ''}<span class="hint">${date ? `Dated ${date}. ` : ''}Uploaded by ${inv.createdByName}, ${when(inv.createdAt)}</span></span>
</a></li>`;
  });
  return layout({
    title: 'Purchase history',
    user: o.user,
    nav: 'history',
    eyebrow: 'Every invoice',
    refreshSeconds: o.invoices.some((i) => i.state === 'uploaded' || i.state === 'reading') ? 10 : undefined,
    body: html`${recordOnly()}${messages(o.error)}
<p><a class="button button-accent" href="/history/new">Upload an old invoice</a></p>
<section aria-labelledby="dl-h" class="card">
  <h2 id="dl-h">Download the purchase history</h2>
  <p class="hint">One row per invoice line, from invoice runs and old invoices together. An invoice recorded both ways is in it once, from the run. Leave the dates empty for every invoice. With dates, invoices whose date could not be read are left out.</p>
  <p class="hint">The .xlsx also has one tab per vendor: each product once, at its latest purchase, with how many times it was bought and the change from the price before. The .csv has the lines only.</p>
  <form method="get" action="/history/download.xlsx" class="stack">
    <label for="from">From invoice date</label>
    <input id="from" name="from" type="date" value="${o.from ?? ''}">
    <label for="to">To invoice date</label>
    <input id="to" name="to" type="date" value="${o.to ?? ''}">
    <div class="inline">
      <button type="submit">Download .xlsx</button>
      <button type="submit" class="button-outline" formaction="/history/download.csv">Download .csv</button>
    </div>
  </form>
</section>
<h2>Recorded so far</h2>
<p class="hint">Invoice runs are added here when they are read. A run that was stopped stays, with every line to check, unless another copy of the invoice is recorded.</p>
${o.invoices.length ? html`<ul class="run-list">${rows}</ul>` : html`<p class="lead">No invoices yet. Upload an old one, or read an invoice run.</p>`}`,
  });
}

// ---- Upload ----

export function historyUploadPage(o: { user: SessionUser; maxFiles: number; maxFileMb: number; maxPdfPages: number; error?: string }): string {
  return layout({
    title: 'Upload an old invoice',
    user: o.user,
    nav: 'history',
    eyebrow: 'Purchase history',
    scripts: ['upload'],
    body: html`${recordOnly()}${messages(o.error)}
<form method="post" action="/history" enctype="multipart/form-data" class="stack" data-upload data-max-files="${String(o.maxFiles)}" data-max-file-mb="${String(o.maxFileMb)}">
  ${csrfField(o.user)}
  <label class="button button-accent button-xl pick" for="photos">Take photos of the old invoice
    <input id="photos" class="sr-only" name="files" type="file" accept="image/*,application/pdf" capture="environment" multiple data-take>
  </label>
  <p class="hint">One invoice at a time. One photo per page. After each one, take the next.</p>
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
    <li>An invoice already recorded, or a photo already uploaded, is refused.</li>
  </ul>
  <div class="action-bar"><button type="submit" data-submit>Upload and record</button></div>
</form>
<p class="hint">The invoice is read and its lines are saved for the purchase history. It is never priced, and it never goes to Square, the scales or the shelf cards.</p>`,
  });
}

// ---- One invoice ----

function photoLink(inv: PurchaseInvoice, files: PurchaseFile[], position: number, page: number): SafeHtml | string {
  const f = files.find((x) => x.position === position);
  if (!f) return page ? `Page ${page}` : '';
  const label = f.kind === 'pdf' ? `PDF page ${page}` : `Photo ${f.position}`;
  return html`<a href="/history/${inv.id}/files/${f.id}">${label}</a>`;
}

function lineRow(inv: PurchaseInvoice, files: PurchaseFile[], l: PurchaseLineRow): SafeHtml {
  const ext = l.extensionCents === null ? l.extension : money(l.extensionCents);
  // Notes about the whole invoice are shown once, above the table, not on every row.
  const own = l.notes.filter((n) => !n.startsWith('Invoice: '));
  return html`<tr id="line-${l.n}"${l.needsCheck ? html` class="needs-check"` : ''}>
  <td>${l.n}</td>
  <td>${l.product}${l.itemNumber ? html`<br><span class="hint">Item ${l.itemNumber}</span>` : ''}</td>
  <td>${l.pack}</td>
  <td>${l.qty || l.qtyShipped}</td>
  <td>${l.qtyUnit}</td>
  <td>${l.unitPrice}</td>
  <td>${l.pricePer}</td>
  <td>${ext}</td>
  <td>${l.needsCheck ? html`${tag('Check', 'wait')} ${l.reasons.join(' ')}` : 'No'}${own.length ? html`<br><span class="hint">${own.join(' ')}</span>` : ''}</td>
  <td>${photoLink(inv, files, l.filePosition, l.page)}</td>
</tr>`;
}

function photos(inv: PurchaseInvoice, files: PurchaseFile[]): SafeHtml {
  if (!files.length) return html`<p class="hint">No photos are kept for this invoice.</p>`;
  return html`<ul class="history-photos">${files.map((f) => {
    const href = `/history/${inv.id}/files/${f.id}`;
    const inline = f.kind === 'jpeg' || f.kind === 'png' || f.kind === 'webp';
    return html`<li>${inline
      ? html`<a href="${href}"><img src="${href}" alt="Photo ${f.position} of the invoice" loading="lazy" width="480"></a><span class="hint">Photo ${f.position}: ${f.originalName}</span>`
      : html`<a class="button button-outline" href="${href}">${f.kind === 'pdf' ? 'Open the PDF' : `Download photo ${f.position}`}</a><span class="hint">${f.originalName}</span>`}</li>`;
  })}</ul>`;
}

export function historyInvoicePage(o: { user: SessionUser; inv: PurchaseInvoice; lines: PurchaseLineRow[]; files: PurchaseFile[]; error?: string; /** An invoice run with the same vendor and number. */ runCopy?: number | null }): string {
  const inv = o.inv;
  const st = STATE[inv.state];
  const working = inv.state === 'uploaded' || inv.state === 'reading';
  const facts = html`<dl class="facts">
  <dt>Status</dt><dd>${tag(st.label, st.kind)} ${inv.message}</dd>
  ${inv.vendor ? html`<dt>Vendor</dt><dd>${inv.vendor}</dd>` : ''}
  ${inv.invoiceNumber ? html`<dt>Invoice #</dt><dd>${inv.invoiceNumber}</dd>` : ''}
  ${inv.invoiceDateIso || inv.invoiceDate ? html`<dt>Invoice date</dt><dd>${inv.invoiceDateIso || inv.invoiceDate}</dd>` : ''}
  ${inv.totalCents !== null ? html`<dt>Total</dt><dd>${money(inv.totalCents)}</dd>` : ''}
  ${inv.state === 'done' ? html`<dt>Lines</dt><dd>${inv.lineCount}, ${inv.needsCheckCount} to check</dd>` : ''}
  <dt>Uploaded</dt><dd>${inv.createdByName}, ${when(inv.createdAt)}</dd>
  ${inv.models ? html`<dt>Read with</dt><dd>${inv.models}. Cost about $${inv.costUsd.toFixed(2)}${inv.costIsEstimate ? ' (an estimate)' : ''}.</dd>` : ''}
</dl>`;
  const checks =
    inv.checks.length || inv.notes.length
      ? html`<section aria-labelledby="checks-h" class="card"><h2 id="checks-h">About the whole invoice</h2>
${inv.checks.length ? html`<p>These can make line values wrong, so every line is flagged for them:</p><ul>${inv.checks.map((c) => html`<li>${c}</li>`)}</ul>` : ''}
${inv.notes.length ? html`<p>Worth knowing. These do not flag the lines:</p><ul>${inv.notes.map((c) => html`<li>${c}</li>`)}</ul>` : ''}
</section>`
      : '';
  const table = o.lines.length
    ? html`<div class="table-wrap"><table>
<caption>Lines</caption>
<thead><tr><th scope="col">#</th><th scope="col">Product</th><th scope="col">Pack size</th><th scope="col">Qty</th><th scope="col">Unit</th><th scope="col">Unit price</th><th scope="col">Per</th><th scope="col">Extended</th><th scope="col">Needs check</th><th scope="col">Photo</th></tr></thead>
<tbody>${o.lines.map((l) => lineRow(inv, o.files, l))}</tbody>
</table></div>`
    : '';
  const admin = o.user.role === 'admin';
  const remove = admin && !working
    ? html`<section aria-labelledby="remove-h" class="card">
  <h2 id="remove-h">Remove this old invoice</h2>
  <p>For a wrong upload. Its lines and photos are deleted. The log keeps a note of it.</p>
  <form method="post" action="/history/${inv.id}/remove" class="stack">
    ${csrfField(o.user)}
    <label class="check"><input type="checkbox" name="confirm" value="1" required> Yes, remove old invoice ${inv.id}</label>
    <button type="submit" class="button-outline">Remove it</button>
  </form>
</section>`
    : '';
  return layout({
    title: title(inv),
    user: o.user,
    nav: 'history',
    eyebrow: 'Purchase history',
    refreshSeconds: working ? 5 : undefined,
    body: html`${recordOnly()}${messages(o.error)}
<p><a href="/history">Back to the purchase history</a></p>
${o.runCopy ? html`<p class="notice" role="note">Also sent as <a href="/runs/${o.runCopy}">invoice run ${o.runCopy}</a>. The spreadsheet uses the run.</p>` : ''}
${facts}
${checks}
${table}
<section aria-labelledby="photos-h">
  <h2 id="photos-h">Photos</h2>
  <p class="hint">Compare a flagged line with its photo.</p>
  ${photos(inv, o.files)}
</section>
${remove}`,
  });
}
