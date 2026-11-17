// One call to the model for card copy, with the server-side web search tool, and token counting
// for the estimate. Built on the invoice client: the same pinned address, key check, error
// classes and redaction (src/invoice/extract.ts). generate.ts talks to CopyModelClient only, so
// tests use a fake and never reach the network.
//
// Request shape, from the SDK's types and two measured calls (November 7, 2026): no
// temperature, no forced tool choice, thinking left adaptive, effort and the JSON format in
// output_config. Structured output works alongside the web search tool. stop_reason is checked
// before any content is read. pause_turn means the server paused its search loop: the caller
// sends the content back to continue it.
//
// Web content: search results are read only for their address, title and age. The page text
// inside them is encrypted by the API and never read here. Everything the model writes is data:
// it is parsed, checked and shown for review, and it never triggers any action.

import Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from '../invoice/cost.ts';
import { ANTHROPIC_API_BASE, classifyError } from '../invoice/extract.ts';
import type { Effort } from '../invoice/settings.ts';
import type { WebSearchToolType } from './settings.ts';
import { cleanText, safeUrl } from './text.ts';
import type { SearchRecord } from './types.ts';

export interface CopyRequest {
  model: string;
  effort: Effort;
  maxTokens: number;
  system: string;
  /** The user turn, and after a pause, the paused assistant turn. */
  messages: Anthropic.MessageParam[];
  schema: Record<string, unknown>;
  /** The server-side web search tool, or null for a call with no tool (the retry). */
  webSearch: { type: WebSearchToolType; maxUses: number } | null;
}

export type CopyStop = 'end_turn' | 'pause_turn' | 'max_tokens' | 'refusal' | 'other';

export interface CopyResponse {
  stop: CopyStop;
  /** The raw stop_reason, for the log. */
  stopReason: string | null;
  refusalCategory: string | null;
  /** The JSON text of the answer. Only on end_turn, otherwise null. */
  text: string | null;
  /** The assistant content to send back to continue. Only on pause_turn, otherwise null. */
  paused: Anthropic.ContentBlockParam[] | null;
  /** Searches in this response, in order. */
  searches: SearchRecord[];
  usage: TokenUsage;
  webSearchRequests: number;
  /** How many times the server read the conversation, when the API reports it (usage.iterations). */
  serverReadings: number | null;
  requestId: string | null;
  /** The model that answered, as the API reports it. */
  model: string;
}

export interface CopyModelClient {
  countTokens(req: CopyRequest): Promise<number>;
  call(req: CopyRequest): Promise<CopyResponse>;
}

/** Longest search query or page title kept. */
const MAX_QUERY = 300;

/** The search tool definition for one of the known versions. */
export function webSearchTool(type: WebSearchToolType, maxUses: number): Anthropic.ToolUnion {
  switch (type) {
    case 'web_search_20250305':
      return { type, name: 'web_search', max_uses: maxUses };
    case 'web_search_20260209':
      return { type, name: 'web_search', max_uses: maxUses };
    case 'web_search_20260318':
      return { type, name: 'web_search', max_uses: maxUses };
  }
}

/** The parameters of one copy call. Exported so tests can check the request shape. */
export function copyMessageParams(req: CopyRequest) {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: req.messages,
    output_config: { effort: req.effort, format: { type: 'json_schema' as const, schema: req.schema } },
    ...(req.webSearch ? { tools: [webSearchTool(req.webSearch.type, req.webSearch.maxUses)] } : {}),
  };
}

type Block = { type?: unknown; [k: string]: unknown };

/** The searches in a response: each query with the addresses and titles it returned, or its error code. */
export function readSearches(content: readonly unknown[]): SearchRecord[] {
  const queries = new Map<string, string>();
  const out: SearchRecord[] = [];
  for (const raw of content) {
    const b = raw as Block;
    if (b?.type === 'server_tool_use' && b.name === 'web_search' && typeof b.id === 'string') {
      const input = b.input as { query?: unknown } | null;
      queries.set(b.id, typeof input?.query === 'string' ? cleanText(input.query).slice(0, MAX_QUERY) : '');
    }
    if (b?.type === 'web_search_tool_result') {
      const query = typeof b.tool_use_id === 'string' ? (queries.get(b.tool_use_id) ?? '') : '';
      const c = b.content as unknown;
      if (Array.isArray(c)) {
        const results = c
          .map((r) => r as Block)
          .filter((r) => r?.type === 'web_search_result' && typeof r.url === 'string')
          .map((r) => ({
            url: safeUrl(r.url as string),
            title: typeof r.title === 'string' ? cleanText(r.title).slice(0, MAX_QUERY) : '',
            pageAge: typeof r.page_age === 'string' ? cleanText(r.page_age).slice(0, 40) : '',
          }))
          .filter((r): r is { url: string; title: string; pageAge: string } => r.url !== null);
        out.push({ query, results, error: '' });
      } else {
        const code = (c as Block | null)?.error_code;
        out.push({ query, results: [], error: typeof code === 'string' ? cleanText(code).slice(0, 40) : 'unknown' });
      }
    }
  }
  return out;
}

/**
 * The answer text: the text blocks after the last tool block, joined. Text written before or
 * between searches is narration, not the answer. Null when there is none.
 */
export function finalText(content: readonly unknown[]): string | null {
  let start = 0;
  content.forEach((raw, i) => {
    const t = (raw as Block)?.type;
    if (t !== 'text' && t !== 'thinking' && t !== 'redacted_thinking') start = i + 1;
  });
  const parts = content
    .slice(start)
    .map((raw) => raw as Block)
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string);
  return parts.length ? parts.join('') : null;
}

function stopKind(reason: string | null): CopyStop {
  if (reason === 'end_turn' || reason === 'pause_turn' || reason === 'max_tokens' || reason === 'refusal') return reason;
  return 'other';
}

function assertPinned(client: Pick<Anthropic, 'baseURL'>): void {
  if (String(client.baseURL).replace(/\/+$/, '') !== ANTHROPIC_API_BASE) {
    throw new Error(`The Claude client must talk to ${ANTHROPIC_API_BASE}. Build it with createInvoiceAnthropicClient.`);
  }
}

/** Wraps the Anthropic SDK. The client must come from createInvoiceAnthropicClient (src/invoice/extract.ts). */
export function createAnthropicCopyClient(client: Anthropic, opts: { timeoutMs?: number } = {}): CopyModelClient {
  assertPinned(client);
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  return {
    async countTokens(req) {
      assertPinned(client);
      try {
        const { max_tokens: _unused, ...params } = copyMessageParams(req);
        const r = await client.messages.countTokens(params, { timeout: 60_000 });
        return r.input_tokens;
      } catch (err) {
        throw classifyError(err);
      }
    },
    async call(req) {
      assertPinned(client);
      try {
        // Streamed, as for invoices: thinking plus searches can run for minutes. No automatic
        // retries: a resent call may be billed twice, and only what generate.ts books counts
        // against the cap. A failure is booked at its worst case instead.
        const stream = client.messages.stream(copyMessageParams(req), { timeout, maxRetries: 0 });
        const msg = await stream.finalMessage();
        const reason = msg.stop_reason ?? null;
        const stop = stopKind(reason);
        const content = msg.content as unknown[];
        const u = msg.usage;
        // Not in this SDK's types yet: read loosely, to confirm the worst case counts enough readings.
        const iterations = (u as unknown as { iterations?: unknown }).iterations;
        return {
          stop,
          stopReason: reason,
          refusalCategory: stop === 'refusal' ? (msg.stop_details?.category ?? null) : null,
          // Content is read only after the stop reason: a refusal or a cut-off answer is not data.
          text: stop === 'end_turn' ? finalText(content) : null,
          paused: stop === 'pause_turn' ? (msg.content as unknown as Anthropic.ContentBlockParam[]) : null,
          searches: readSearches(content),
          usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            thinkingTokens: u.output_tokens_details?.thinking_tokens ?? null,
          },
          webSearchRequests: u.server_tool_use?.web_search_requests ?? 0,
          serverReadings: Array.isArray(iterations) ? iterations.length : null,
          requestId: stream.request_id ?? null,
          model: msg.model,
        };
      } catch (err) {
        throw classifyError(err);
      }
    },
  };
}
