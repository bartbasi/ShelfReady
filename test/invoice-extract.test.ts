// The Claude call wrapper: error messages never carry a key, the key's shape is checked where the
// client is built, the API address is pinned, and the request has the documented shape. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_API_BASE,
  apiKeyProblem,
  classifyError,
  createAnthropicModelClient,
  createInvoiceAnthropicClient,
  messageParams,
  ModelCallError,
  type ModelRequest,
} from '../src/invoice/extract.ts';
import { redactSecrets, REMOVED } from '../src/invoice/redact.ts';
import { INVOICE_SCHEMA } from '../src/invoice/schema.ts';
import { fakeKey } from './invoice-fixtures.ts';

const KEY_START = ['sk', 'ant', ''].join('-');

function noKey(text: string) {
  assert.ok(!text.includes(KEY_START), 'a key prefix leaked');
  assert.ok(!text.includes('Z'.repeat(20)), 'part of the key leaked');
  assert.ok(!/bearer/i.test(text), 'a bearer value leaked');
}

test('an error from fetch that quotes the key is reported with fixed text only', () => {
  // A key with a line break makes fetch throw before the SDK can wrap the error.
  const broken = `${fakeKey().slice(0, 30)}\n${fakeKey().slice(30)}`;
  const err = new TypeError(`Headers.append: "${broken}" is an invalid header value. Bearer ${fakeKey()}`);
  const e = classifyError(err);
  assert.equal(e.kind, 'other');
  noKey(e.message);
  assert.match(e.message, /could not be sent/);
});

test('an SDK error whose text carries a key is redacted', () => {
  const apiErr = new Anthropic.BadRequestError(400, { error: { message: `bad header ${fakeKey()}` } }, `400 bad header ${fakeKey()}`, new Headers());
  const e = classifyError(apiErr);
  assert.equal(e.kind, 'bad_request');
  noKey(e.message);
  const direct = new ModelCallError('other', `oops ${fakeKey()}`, null, null);
  noKey(direct.message);
});

test('known SDK errors map to kinds with plain messages', () => {
  assert.equal(classifyError(new Anthropic.AuthenticationError(401, {}, 'nope', new Headers())).kind, 'authentication');
  assert.equal(classifyError(new Anthropic.RateLimitError(429, {}, 'slow down', new Headers())).kind, 'rate_limit');
  assert.equal(classifyError(new Anthropic.InternalServerError(529, {}, 'overloaded', new Headers())).kind, 'server');
  assert.equal(classifyError(new Anthropic.APIConnectionError({ message: 'socket hang up' })).kind, 'connection');
  assert.equal(classifyError(new Error('anything')).message.includes('anything'), false);
});

test('redaction drops a whole message that mentions anything key-like', () => {
  assert.equal(redactSecrets(`x ${fakeKey()} y`), REMOVED);
  assert.equal(redactSecrets('the x-api-key header was missing'), REMOVED);
  assert.equal(redactSecrets('line one\nline two'), 'line one line two');
  assert.equal(redactSecrets('a'.repeat(600)).length, 503);
});

test('a key split by a control or invisible character is still found', () => {
  // NUL, line feed, carriage return, tab, zero-width space, non-joiner, joiner, word joiner,
  // byte order mark, soft hyphen, right-to-left override, line separator.
  const splitters = [0x00, 0x0a, 0x0d, 0x09, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x00ad, 0x202e, 0x2028];
  for (const cp of splitters) {
    const sp = String.fromCharCode(cp);
    const split = ['sk', sp, '-an', sp, 't-api03-', 'Z'.repeat(30)].join('');
    assert.equal(redactSecrets(`header value ${split}`), REMOVED, `splitter U+${cp.toString(16)}`);
    assert.equal(redactSecrets(`Bea${sp}rer ${'Z'.repeat(30)}`), REMOVED, `bearer split by U+${cp.toString(16)}`);
  }
});

test('full-width letters and a prefix split by spaces are found too; plain text stays readable', () => {
  // Full-width s, k, hyphen, a, n, t become plain letters under NFKC.
  const fullWidth = String.fromCharCode(0xff53, 0xff4b, 0xff0d, 0xff41, 0xff4e, 0xff54) + '-' + 'Z'.repeat(30);
  assert.equal(redactSecrets(fullWidth), REMOVED);
  assert.equal(redactSecrets(`sk - ant - ${'Z'.repeat(30)}`), REMOVED);
  assert.equal(redactSecrets(`one${String.fromCharCode(0x200b)}two\nthree`), 'onetwo three');
  assert.equal(redactSecrets('The Claude API key was refused.'), 'The Claude API key was refused.');
});

test('a key with a break, a space, NUL or the wrong start is refused without repeating it', () => {
  const k = fakeKey();
  for (const bad of [`${k}\n`, `${k.slice(0, 20)}\r${k.slice(20)}`, `${k} `, `${k}\u0000`, k.replace(KEY_START, 'sk-xyz-'), '']) {
    const problem = apiKeyProblem(bad);
    assert.ok(problem, JSON.stringify(bad.slice(-3)));
    assert.ok(!problem!.includes('Z'.repeat(20)), 'the message must not repeat the key');
    assert.throws(() => createInvoiceAnthropicClient(bad), (e: Error) => !e.message.includes('Z'.repeat(20)));
  }
  assert.equal(apiKeyProblem(k), null);
  assert.match(classifyError(new Anthropic.AuthenticationError(401, {}, 'nope', new Headers())).message, /API key was refused/);
});

test('the client is pinned to the Anthropic API even when ANTHROPIC_BASE_URL is set', () => {
  const before = process.env['ANTHROPIC_BASE_URL'];
  process.env['ANTHROPIC_BASE_URL'] = 'https://example.invalid';
  try {
    const client = createInvoiceAnthropicClient(fakeKey());
    assert.equal(client.baseURL, ANTHROPIC_API_BASE);
    const loose = new Anthropic({ apiKey: fakeKey() });
    assert.throws(() => createAnthropicModelClient(loose), /must talk to https:\/\/api.anthropic.com/);
  } finally {
    if (before === undefined) delete process.env['ANTHROPIC_BASE_URL'];
    else process.env['ANTHROPIC_BASE_URL'] = before;
  }
});

const req: ModelRequest = {
  model: 'claude-sonnet-5-5',
  effort: 'low',
  maxTokens: 12345,
  system: 'system text',
  content: [{ type: 'text', text: 'Image 1 of 1:' }],
  schema: INVOICE_SCHEMA,
};

/** A stand-in for the SDK client that records what it was asked. */
function fakeSdk(message: Record<string, unknown>) {
  const seen: { stream?: Record<string, unknown>; count?: Record<string, unknown> } = {};
  const sdk = {
    baseURL: ANTHROPIC_API_BASE,
    messages: {
      stream(params: Record<string, unknown>) {
        seen.stream = params;
        return { request_id: 'req_fake', finalMessage: async () => message };
      },
      async countTokens(params: Record<string, unknown>) {
        seen.count = params;
        return { input_tokens: 4321 };
      },
    },
  };
  return { sdk: sdk as unknown as Anthropic, seen };
}

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens_details: { thinking_tokens: 10 } };

test('the request has the documented shape: structured output and effort, no temperature or forced tools', async () => {
  const { sdk, seen } = fakeSdk({ stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: '{"a":1}' }], usage, model: 'claude-sonnet-5-5' });
  const client = createAnthropicModelClient(sdk);
  const res = await client.call(req);
  const p = seen.stream!;
  assert.equal(p['model'], 'claude-sonnet-5-5');
  assert.equal(p['max_tokens'], 12345);
  assert.deepEqual(p['output_config'], { effort: 'low', format: { type: 'json_schema', schema: INVOICE_SCHEMA } });
  for (const absent of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'thinking', 'stop_sequences']) assert.ok(!(absent in p), absent);
  assert.deepEqual(p['messages'], [{ role: 'user', content: req.content }]);
  assert.equal(p['system'], 'system text');
  assert.equal(res.text, '{"a":1}');
  assert.equal(res.requestId, 'req_fake');
  assert.equal(res.usage.thinkingTokens, 10);
  assert.equal(await client.countTokens(req), 4321);
  assert.ok(!('max_tokens' in seen.count!));
  assert.deepEqual(seen.count!['output_config'], p['output_config']);
  assert.deepEqual(messageParams(req).output_config.format.type, 'json_schema');
});

test('a refusal or a cut-off answer returns no text', async () => {
  const refused = fakeSdk({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [{ type: 'text', text: '{"partial"' }], usage, model: 'm' });
  const r = await createAnthropicModelClient(refused.sdk).call(req);
  assert.deepEqual([r.stop, r.text, r.refusalCategory], ['refusal', null, 'cyber']);
  const cut = fakeSdk({ stop_reason: 'max_tokens', stop_details: null, content: [{ type: 'text', text: '{"lines":[' }], usage, model: 'm' });
  const c = await createAnthropicModelClient(cut.sdk).call(req);
  assert.deepEqual([c.stop, c.text], ['max_tokens', null]);
});
