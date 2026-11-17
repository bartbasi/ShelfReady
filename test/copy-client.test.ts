// The copy call wrapper: the request shape, reading searches and the final answer from response
// content, stop reasons, and the pinned address. A stand-in for the SDK object, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { copyMessageParams, createAnthropicCopyClient, finalText, readSearches, type CopyRequest } from '../src/copy/client.ts';
import { ANTHROPIC_API_BASE } from '../src/invoice/extract.ts';

// Written as numbers, so no editor or tool can turn an escape into the character itself.
const ZWSP = String.fromCodePoint(0x200b);

const req: CopyRequest = {
  model: 'claude-sonnet-5-5',
  effort: 'medium',
  maxTokens: 8000,
  system: 'system text',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'facts' }] }],
  schema: { type: 'object' },
  webSearch: { type: 'web_search_20250305', maxUses: 3 },
};

test('the request carries the web search tool, the effort and the JSON format, and nothing else', () => {
  const p = copyMessageParams(req) as Record<string, unknown>;
  assert.deepEqual(p.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
  assert.deepEqual(p.output_config, { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.equal(p.max_tokens, 8000);
  for (const k of ['temperature', 'tool_choice', 'thinking', 'top_p']) assert.ok(!(k in p), `${k} must not be sent`);
  const none = copyMessageParams({ ...req, webSearch: null }) as Record<string, unknown>;
  assert.ok(!('tools' in none), 'the retry sends no tools');
});

const content = [
  { type: 'text', text: 'Let me search.' },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'maker cheddar' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [
      { type: 'web_search_result', url: 'https://maker.example/a', title: `Maker${ZWSP} page`, page_age: '2 days', encrypted_content: 'opaque' },
      { type: 'web_search_result', url: 'javascript:alert(1)', title: 'Bad', page_age: null, encrypted_content: 'opaque' },
    ],
  },
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'second' } },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
  { type: 'text', text: '{"a":' },
  { type: 'text', text: '1}' },
];

test('searches are read for their query, safe addresses, titles and errors only', () => {
  const s = readSearches(content);
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { query: 'maker cheddar', results: [{ url: 'https://maker.example/a', title: 'Maker page', pageAge: '2 days' }], error: '' });
  assert.deepEqual(s[1], { query: 'second', results: [], error: 'max_uses_exceeded' });
  assert.ok(!JSON.stringify(s).includes('opaque'), 'the encrypted page text is never kept');
});

test('the answer is the text after the last tool block', () => {
  assert.equal(finalText(content), '{"a":1}');
  assert.equal(finalText([{ type: 'text', text: '{"b":2}' }]), '{"b":2}');
  assert.equal(finalText([{ type: 'server_tool_use', id: 'x', name: 'web_search', input: {} }]), null);
});

function fakeSdk(message: Record<string, unknown>, baseURL = ANTHROPIC_API_BASE) {
  const sent: unknown[] = [];
  const options: Array<Record<string, unknown>> = [];
  const sdk = {
    baseURL,
    messages: {
      stream(params: unknown, opts: Record<string, unknown>) {
        sent.push(params);
        options.push(opts);
        return { request_id: 'req_1', finalMessage: async () => message };
      },
      async countTokens(params: unknown) {
        sent.push(params);
        return { input_tokens: 4321 };
      },
    },
  };
  return { sdk: sdk as unknown as Anthropic, sent, options };
}

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 }, output_tokens_details: { thinking_tokens: 10 } };

test('end_turn gives the answer text, the searches and the usage, with search requests counted', async () => {
  const { sdk, sent, options } = fakeSdk({ stop_reason: 'end_turn', content, usage, model: 'claude-sonnet-5-5', stop_details: null });
  const client = createAnthropicCopyClient(sdk);
  const r = await client.call(req);
  assert.equal(r.stop, 'end_turn');
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.paused, null);
  assert.equal(r.webSearchRequests, 2);
  assert.equal(r.usage.thinkingTokens, 10);
  assert.equal(r.searches.length, 2);
  assert.equal(r.requestId, 'req_1');
  assert.equal(await client.countTokens(req), 4321);
  assert.ok(!('max_tokens' in (sent[1] as object)), 'token counting sends no output limit');
  assert.equal(options[0]!.maxRetries, 0, 'a copy call is never resent by the SDK, so no spend goes unbooked');
});

test('a refusal and a pause carry no answer text; a pause carries its content to send back', async () => {
  const refused = await createAnthropicCopyClient(fakeSdk({ stop_reason: 'refusal', content: [{ type: 'text', text: '{"x":1}' }], usage, model: 'm', stop_details: { category: 'cyber' } }).sdk).call(req);
  assert.equal(refused.stop, 'refusal');
  assert.equal(refused.text, null, 'content is not read after a refusal');
  assert.equal(refused.refusalCategory, 'cyber');
  const paused = await createAnthropicCopyClient(fakeSdk({ stop_reason: 'pause_turn', content, usage, model: 'm', stop_details: null }).sdk).call(req);
  assert.equal(paused.stop, 'pause_turn');
  assert.equal(paused.text, null);
  assert.equal(paused.paused?.length, content.length);
  const odd = await createAnthropicCopyClient(fakeSdk({ stop_reason: 'tool_use', content, usage, model: 'm', stop_details: null }).sdk).call(req);
  assert.equal(odd.stop, 'other');
  assert.equal(odd.text, null);
});

test('the readings the server reports are kept, and null when it does not say', async () => {
  const withIterations = await createAnthropicCopyClient(fakeSdk({ stop_reason: 'end_turn', content, usage: { ...usage, iterations: [{}, {}, {}] }, model: 'm', stop_details: null }).sdk).call(req);
  assert.equal(withIterations.serverReadings, 3);
  const without = await createAnthropicCopyClient(fakeSdk({ stop_reason: 'end_turn', content, usage, model: 'm', stop_details: null }).sdk).call(req);
  assert.equal(without.serverReadings, null);
});

test('a client that does not talk to the pinned address is refused', () => {
  assert.throws(() => createAnthropicCopyClient(fakeSdk({}, 'https://proxy.example').sdk), /must talk to https:\/\/api\.anthropic\.com/);
});
