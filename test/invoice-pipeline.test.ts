// The reading flow with a fake model client: first pass, fallback, review, cost cap, errors.
// No network: the fake stands in for the Claude API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelCallError } from '../src/invoice/extract.ts';
import { InvoiceInputError, MEASURE_PDF_FAILED, readInvoice, type InvoiceFile, type PendingApproval } from '../src/invoice/pipeline.ts';
import { buildInvoiceSettings, invoiceSettingsFrom } from '../src/invoice/settings.ts';
import { fakeClient, fakeKey, invoice, line, testImage, TODAY } from './invoice-fixtures.ts';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const settings = buildInvoiceSettings();
const now = () => TODAY;

const good = invoice();
const badMath = invoice({ lines: [line({ extension: '21.00' })], total: '21.00' });

async function onePage(): Promise<InvoiceFile[]> {
  return [{ name: 'page1.jpg', bytes: await testImage(1) }];
}

test('a reading that passes on the first model is ok, with no fallback', async () => {
  const client = fakeClient({ [SONNET]: [{ json: good }] });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'ok');
  assert.equal(client.calls.length, 1);
  assert.equal(r.audit.finalModel, SONNET);
  assert.deepEqual(r.reviewReasons, []);
  assert.equal(r.attempts[0]!.effort, 'low');
  assert.ok(r.audit.totalCostUsd > 0);
  assert.ok(r.audit.attempts[0]!.checksPassed.includes('totals'));
});

test('a failed check sends the invoice to the fallback model', async () => {
  const client = fakeClient({ [SONNET]: [{ json: badMath }], [OPUS]: [{ json: good }] });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'ok');
  assert.deepEqual(client.calls.map((c) => c.model), [SONNET, OPUS]);
  assert.equal(r.audit.finalModel, OPUS);
  assert.equal(r.audit.attempts[0]!.checksFailed[0]!.id, 'line_math');
});

test('when both models fail, the invoice goes to review with every failed check listed', async () => {
  const client = fakeClient({ [SONNET]: [{ json: badMath }], [OPUS]: [{ json: badMath }] });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'review');
  assert.ok(r.reading, 'the best reading is still shown for review');
  const text = r.reviewReasons.join('\n');
  assert.match(text, /First reading \(claude-sonnet-5-5\)/);
  assert.match(text, /Second reading \(claude-opus-5-5\)/);
  assert.match(text, /quantity 2 x 10.00 = 20.00, but the line amount reads 21.00/);
});

test('low confidence alone triggers the fallback', async () => {
  const unsure = invoice({ lines: [line({ confidence: 'low', confidence_note: 'price smudged' })] });
  const client = fakeClient({ [SONNET]: [{ json: unsure }], [OPUS]: [{ json: good }] });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'ok');
  assert.equal(client.calls.length, 2);
});

test('refusals and cut-off answers are handled before any content is read', async () => {
  const client = fakeClient({
    [SONNET]: [{ stop: 'refusal', stopReason: 'refusal', refusalCategory: 'general_harms', text: '{"partial":' }],
    [OPUS]: [{ stop: 'max_tokens', stopReason: 'max_tokens', text: null }],
  });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'review');
  assert.equal(r.reading, null);
  const text = r.reviewReasons.join('\n');
  assert.match(text, /declined to read the invoice \(general_harms\)/);
  assert.match(text, /ran out of room/);
});

test('bad JSON and the wrong shape are failures, not readings', async () => {
  const client = fakeClient({ [SONNET]: [{ text: 'not json' }], [OPUS]: [{ json: { hello: 1 } }] });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'review');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['invalid_json', 'schema_mismatch']);
});

test('checks that throw become a failed attempt with its cost in the audit, not a crash', async () => {
  const client = fakeClient({ [SONNET]: [{ json: good }], [OPUS]: [{ json: good }] });
  const r = await readInvoice(await onePage(), {
    client,
    settings,
    now,
    knownItem: () => {
      throw new Error('lookup broke');
    },
  });
  assert.equal(r.status, 'review');
  assert.deepEqual(r.attempts.map((a) => a.outcome), ['check_error', 'check_error']);
  assert.ok(r.audit.attempts.every((a) => a.costUsd > 0));
  assert.match(r.reviewReasons.join('\n'), /checks could not run/);
});

test('an API error on the first model falls back; a refused key does not', async () => {
  const conn = fakeClient({ [SONNET]: [new ModelCallError('connection', 'Could not reach the Claude API.', null, null)], [OPUS]: [{ json: good }] });
  assert.equal((await readInvoice(await onePage(), { client: conn, settings, now })).status, 'ok');
  const auth = fakeClient({ [SONNET]: [new ModelCallError('authentication', 'The Claude API key was refused. Check it in settings.', 401, null)] });
  const r = await readInvoice(await onePage(), { client: auth, settings, now });
  assert.equal(r.status, 'review');
  assert.equal(auth.calls.length, 1);
  assert.match(r.reviewReasons.join('\n'), /key was refused/);
});

test('an error that quotes the key never reaches the audit, the reasons or the attempts', async () => {
  const leak = new TypeError(`Headers.append: "${fakeKey()}" is an invalid header value`);
  const client = fakeClient({ [SONNET]: [leak], [OPUS]: [new Error(`Bearer ${fakeKey()}`)] });
  const r = await readInvoice(await onePage(), { client, settings, now });
  const everything = JSON.stringify({ audit: r.audit, reasons: r.reviewReasons, attempts: r.attempts });
  assert.ok(!everything.includes('Z'.repeat(20)));
  assert.ok(!everything.includes(['sk', 'ant', ''].join('-')));
});

test('a call that fails after it may have been sent is booked at its worst case', async () => {
  const client = fakeClient({ [SONNET]: [new ModelCallError('connection', 'Could not reach the Claude API.', null, null)], [OPUS]: [{ json: good }] });
  const r = await readInvoice(await onePage(), { client, settings, now });
  const first = r.attempts[0]!;
  assert.equal(first.costIsEstimate, true);
  assert.equal(first.costUsd, first.estimate.worstUsd);
  // The fallback gets only what is left of the cap.
  const second = r.attempts[1]!;
  assert.ok(first.costUsd + second.estimate.worstUsd <= settings.costCapUsd + 1e-9);
});

test('the cap is hard: every call is sent with an output limit whose worst case fits what is left', async () => {
  const capped = buildInvoiceSettings({ costCapUsd: 0.1 });
  const client = fakeClient({ [SONNET]: [{ json: good }] });
  const r = await readInvoice(await onePage(), { client, settings: capped, now });
  assert.equal(r.status, 'ok');
  // $0.10 less $0.02 of input leaves room for 8,000 output tokens at $10 per million.
  assert.ok(client.calls[0]!.maxTokens <= 8000 && client.calls[0]!.maxTokens >= 7990);
  assert.ok(r.attempts[0]!.estimate.worstUsd <= 0.1 + 1e-9);
});

test('over the cost cap before the first call: needs approval, nothing sent, then resumes', async () => {
  const tight = buildInvoiceSettings({ costCapUsd: 0.01 });
  const client = fakeClient({ [SONNET]: [{ json: good }] });
  const files = await onePage();
  const r = await readInvoice(files, { client, settings: tight, now });
  assert.equal(r.status, 'needs_approval');
  assert.equal(client.calls.length, 0);
  assert.equal(r.approval!.stage, 'first_pass');
  assert.match(r.approval!.message, /could cost up to \$0\.50/);
  assert.match(r.approval!.message, /An admin must approve/);
  const noResume = await readInvoice(files, { client, settings: tight, now }, { approvedOverCap: true });
  assert.equal(noResume.status, 'needs_approval', 'approval without the saved copy is ignored');
  const resumed = await readInvoice(files, { client, settings: tight, now }, { approvedOverCap: true, resume: r.approval! });
  assert.equal(resumed.status, 'ok');
  assert.equal(client.calls.length, 1);
});

test('over the cap before the fallback: stops, then resumes without paying for the first pass again', async () => {
  const capped = buildInvoiceSettings({ costCapUsd: 0.1 });
  const client = fakeClient({ [SONNET]: [{ json: badMath }], [OPUS]: [{ json: good }] });
  const files = await onePage();
  const r = await readInvoice(files, { client, settings: capped, now });
  assert.equal(r.status, 'needs_approval');
  assert.equal(r.approval!.stage, 'fallback');
  assert.equal(r.approval!.model, OPUS);
  assert.deepEqual(client.calls.map((c) => c.model), [SONNET]);
  assert.ok(r.reading, 'the first reading is shown while waiting');
  const resumed = await readInvoice(files, { client, settings: capped, now }, { approvedOverCap: true, resume: r.approval! });
  assert.equal(resumed.status, 'ok');
  assert.deepEqual(client.calls.map((c) => c.model), [SONNET, OPUS]);
  assert.equal(resumed.attempts.length, 2);
});

test('approval of the first pass does not approve the fallback', async () => {
  const tight = buildInvoiceSettings({ costCapUsd: 0.01 });
  const client = fakeClient({ [SONNET]: [{ json: badMath }], [OPUS]: [{ json: good }] });
  const files = await onePage();
  const first = await readInvoice(files, { client, settings: tight, now });
  const r = await readInvoice(files, { client, settings: tight, now }, { approvedOverCap: true, resume: first.approval! });
  assert.equal(r.status, 'needs_approval');
  assert.equal(r.approval!.stage, 'fallback');
});

test('an approval does not cover a different model or a larger worst case', async () => {
  const tight = buildInvoiceSettings({ costCapUsd: 0.01 });
  const client = fakeClient({ [SONNET]: [{ json: good }] });
  const files = await onePage();
  const first = await readInvoice(files, { client, settings: tight, now });
  const otherModel: PendingApproval = { ...first.approval!, model: OPUS };
  assert.equal((await readInvoice(files, { client, settings: tight, now }, { approvedOverCap: true, resume: otherModel })).status, 'needs_approval');
  const cheaper: PendingApproval = { ...first.approval!, estimateUsd: 0.05 };
  assert.equal((await readInvoice(files, { client, settings: tight, now }, { approvedOverCap: true, resume: cheaper })).status, 'needs_approval');
  assert.equal(client.calls.length, 0);
});

test('a resume with different files, a damaged cost or a tampered reading is refused or re-checked', async () => {
  const tight = buildInvoiceSettings({ costCapUsd: 0.01 });
  const client = fakeClient({ [SONNET]: [{ json: good }] });
  const files = await onePage();
  const first = await readInvoice(files, { client, settings: tight, now });
  const other = [{ name: 'page1.jpg', bytes: await testImage(7) }];
  await assert.rejects(readInvoice(other, { client, settings: tight, now }, { approvedOverCap: true, resume: first.approval! }), /not the files/);

  // A saved attempt with a negative cost is refused.
  const capped = buildInvoiceSettings({ costCapUsd: 0.1 });
  const c2 = fakeClient({ [SONNET]: [{ json: badMath }], [OPUS]: [{ json: good }, { json: good }] });
  const waiting = await readInvoice(files, { client: c2, settings: capped, now });
  const negative: PendingApproval = { ...waiting.approval!, attempts: waiting.approval!.attempts.map((a) => ({ ...a, costUsd: -5 })) };
  await assert.rejects(readInvoice(files, { client: c2, settings: capped, now }, { approvedOverCap: true, resume: negative }), InvoiceInputError);

  // A stored reading edited to look passed is checked again and still fails.
  const tampered: PendingApproval = {
    ...waiting.approval!,
    attempts: waiting.approval!.attempts.map((a) => ({ ...a, reading: a.reading ? { ...a.reading, failed: [] } : null })),
  };
  const r = await readInvoice(files, { client: c2, settings: capped, now }, { approvedOverCap: true, resume: tampered });
  assert.equal(r.attempts[0]!.reading!.failed[0]!.id, 'line_math');
  assert.equal(r.audit.finalModel, OPUS);
});

test('a token count that is not a number stops for approval', async () => {
  const client = fakeClient({ [SONNET]: [{ json: good }] }, { inputTokens: Number.NaN });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'needs_approval');
  assert.match(r.approval!.message, /came back unusable/);
  assert.equal(client.calls.length, 0);
});

test('a PDF whose tokens cannot be counted is never sent: the result is retry', async () => {
  const pdf = [{ name: 'inv.pdf', bytes: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\n') }];
  const down = fakeClient({ [SONNET]: [{ json: invoice() }] }, { countError: new ModelCallError('connection', 'down', null, null) });
  const r = await readInvoice(pdf, { client: down, settings, now });
  assert.equal(r.status, 'retry');
  assert.equal(r.reviewReasons[0], MEASURE_PDF_FAILED);
  assert.equal(r.approval, null);
  assert.equal(down.calls.length, 0);
  // An approval does not change that: an uncounted PDF is never sent.
  const unusable = fakeClient({ [SONNET]: [{ json: invoice() }] }, { inputTokens: Number.NaN });
  assert.equal((await readInvoice(pdf, { client: unusable, settings, now })).status, 'retry');
  assert.equal(unusable.calls.length, 0);
});

test('a retry at the fallback keeps the paid first pass in the audit', async () => {
  const pdf = [{ name: 'inv.pdf', bytes: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\n') }];
  const client = fakeClient({ [SONNET]: [{ json: badMath }] });
  let counts = 0;
  const flaky = {
    ...client,
    async countTokens() {
      counts++;
      if (counts > 1) throw new ModelCallError('server', 'busy', 529, null);
      return 10_000;
    },
  };
  const r = await readInvoice(pdf, { client: flaky, settings, now });
  assert.equal(r.status, 'retry');
  assert.equal(r.audit.attempts.length, 1);
  assert.ok(r.audit.totalCostUsd > 0);
  assert.ok(r.reading, 'the first reading is still shown');
});

test('photos whose tokens cannot be counted use a local count and still go out', async () => {
  const client = fakeClient({ [SONNET]: [{ json: good }] }, { countError: new ModelCallError('connection', 'down', null, null) });
  const r = await readInvoice(await onePage(), { client, settings, now });
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts[0]!.estimate.inputSource, 'local');
});

test('a model with no price is never called, with a plain message', async () => {
  const noPrice = buildInvoiceSettings({ fallbackModel: 'claude-unpriced-1' });
  const client = fakeClient({ [SONNET]: [{ json: badMath }] });
  const r = await readInvoice(await onePage(), { client, settings: noPrice, now });
  assert.equal(r.status, 'review');
  assert.deepEqual(client.calls.map((c) => c.model), [SONNET]);
  assert.match(r.reviewReasons.join('\n'), /No price is set for claude-unpriced-1\. Set a price for this model in settings/);
});

test('upload limits are checked before anything is decoded', async () => {
  const client = fakeClient({});
  const img = await testImage(1);
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `p${i}.jpg`, bytes: img }));
  await assert.rejects(readInvoice(many, { client, settings, now }), /At most 10 files/);
  const big = Buffer.concat([img, Buffer.alloc(21 * 1024 * 1024)]);
  await assert.rejects(readInvoice([{ name: 'big.jpg', bytes: big }], { client, settings, now }), /larger than 20 MB/);
  const gif = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000\u0000');
  await assert.rejects(readInvoice([{ name: 'x.gif', bytes: gif }], { client, settings, now }), /not a JPEG, PNG, WebP or HEIF photo, or a PDF/);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>hi</text></svg>');
  await assert.rejects(readInvoice([{ name: 'x.svg', bytes: svg }], { client, settings, now }), InvoiceInputError);
  const longPdf = Buffer.from('%PDF-1.4\n' + '1 0 obj << /Type /Page >>\n'.repeat(25));
  await assert.rejects(readInvoice([{ name: 'long.pdf', bytes: longPdf }], { client, settings, now }), /more than 20 pages/);
  assert.equal(client.calls.length + client.counts, 0);
});

test('the same file uploaded twice is sent once', async () => {
  const bytes = await testImage(1);
  const client = fakeClient({ [SONNET]: [{ json: good }] });
  const r = await readInvoice([{ name: 'a.jpg', bytes }, { name: 'b.jpg', bytes }], { client, settings, now });
  assert.equal(client.calls[0]!.imageCount, 1);
  assert.match(r.notices[0]!.message, /b.jpg is the same file as a.jpg/);
  assert.equal(r.status, 'ok');
});

test('a PDF goes as a document; mixing a PDF with photos is refused', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >>\n');
  const client = fakeClient({ [SONNET]: [{ json: invoice() }] });
  await readInvoice([{ name: 'inv.pdf', bytes: pdf }], { client, settings, now });
  assert.equal(client.calls[0]!.hasDocument, true);
  await assert.rejects(readInvoice([{ name: 'inv.pdf', bytes: pdf }, ...(await onePage())], { client, settings, now }), /either photos/);
});

test('measuring one model alone never falls back', async () => {
  const client = fakeClient({ [OPUS]: [{ json: badMath }] });
  const r = await readInvoice(await onePage(), { client, settings, now }, { onlyModel: OPUS });
  assert.equal(r.status, 'review');
  assert.deepEqual(client.calls.map((c) => c.model), [OPUS]);
});

test('the admin settings map onto invoice reading settings', () => {
  const s = invoiceSettingsFrom({ anthropicFirstPassModel: 'claude-sonnet-5-5', anthropicFallbackModel: 'claude-opus-5-5', invoiceCostCapUsd: '2.50' });
  assert.equal(s.costCapUsd, 2.5);
  assert.equal(s.fallbackModel, OPUS);
  assert.equal(invoiceSettingsFrom({ invoiceCostCapUsd: 'abc' }).costCapUsd, 1);
});
