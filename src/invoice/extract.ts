// One call to the model for one invoice, and token counting for the estimate.
//
// The pipeline talks to InvoiceModelClient, never to the SDK directly, so tests can stand in a
// fake and never reach the network. createAnthropicModelClient wraps the real SDK.
//
// Per the API docs for Claude Sonnet 5.5 and Claude Opus 5.5: thinking is left at its adaptive
// default (disabling it is a 400 on both), effort is set explicitly, there is no temperature,
// forced tool choice is not used, and the JSON shape comes from structured outputs
// (output_config.format). stop_reason is checked before any content is read. The call streams,
// because the SDK refuses long non-streaming calls and thinking can run for minutes.
//
// Secrets: the client is built only by createInvoiceAnthropicClient, which checks the key's shape
// and pins the API address. Error messages never carry raw text from outside the SDK, and every
// message passes through redactSecrets.

import Anthropic from '@anthropic-ai/sdk';
import type { TokenUsage } from './cost.ts';
import { redactSecrets } from './redact.ts';
import type { Effort } from './settings.ts';

/** The only API address ShelfReady talks to. ANTHROPIC_BASE_URL is ignored. */
export const ANTHROPIC_API_BASE = 'https://api.anthropic.com';

export interface ModelRequest {
  model: string;
  effort: Effort;
  maxTokens: number;
  system: string;
  content: Anthropic.ContentBlockParam[];
  schema: Record<string, unknown>;
}

export type StopKind = 'end_turn' | 'max_tokens' | 'refusal' | 'other';

export interface ModelResponse {
  stop: StopKind;
  /** The raw stop_reason, for the log. */
  stopReason: string | null;
  /** For a refusal: the policy category, when the API gives one. */
  refusalCategory: string | null;
  /** The JSON text of the answer. Null when the model gave no text. */
  text: string | null;
  usage: TokenUsage;
  requestId: string | null;
  /** The model that answered, as the API reports it. */
  model: string;
}

/** Why a call failed before any answer came back. */
export type CallErrorKind =
  | 'authentication'
  | 'permission'
  | 'not_found'
  | 'bad_request'
  | 'too_large'
  | 'rate_limit'
  | 'server'
  | 'connection'
  | 'timeout'
  | 'other';

export class ModelCallError extends Error {
  readonly kind: CallErrorKind;
  readonly status: number | null;
  readonly requestId: string | null;
  constructor(kind: CallErrorKind, message: string, status: number | null, requestId: string | null) {
    super(redactSecrets(message));
    this.name = 'ModelCallError';
    this.kind = kind;
    this.status = status;
    this.requestId = requestId === null ? null : redactSecrets(requestId, 100);
  }
  /** Errors another model cannot fix: the same key, account or input would fail again. */
  get sameForAnyModel(): boolean {
    return this.kind === 'authentication' || this.kind === 'permission' || this.kind === 'too_large';
  }
  /** Errors that may come after the request was sent and billed, so the worst case is booked. */
  get mayHaveBilled(): boolean {
    return this.kind === 'connection' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'other';
  }
}

export interface InvoiceModelClient {
  countTokens(req: ModelRequest): Promise<number>;
  call(req: ModelRequest): Promise<ModelResponse>;
}

/** Turns any error into a ModelCallError with a safe message. */
export function classifyError(err: unknown): ModelCallError {
  if (err instanceof ModelCallError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ModelCallError('timeout', 'The call to the model timed out.', null, null);
  if (err instanceof Anthropic.APIConnectionError) return new ModelCallError('connection', 'Could not reach the Claude API.', null, null);
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    const requestId = typeof err.requestID === 'string' ? err.requestID : null;
    // The message here is the API's own error text. It is still redacted and capped.
    const detail = redactSecrets(String(err.message ?? ''), 300);
    if (err instanceof Anthropic.AuthenticationError) return new ModelCallError('authentication', 'The Claude API key was refused. Check it in settings.', status, requestId);
    if (err instanceof Anthropic.PermissionDeniedError) return new ModelCallError('permission', `The Claude API refused this request: ${detail}`, status, requestId);
    if (err instanceof Anthropic.NotFoundError) return new ModelCallError('not_found', `The model was not found or is not available to this account: ${detail}`, status, requestId);
    if (err instanceof Anthropic.RateLimitError) return new ModelCallError('rate_limit', 'The Claude API is rate limiting this account. Try again in a minute.', status, requestId);
    if (err instanceof Anthropic.BadRequestError) return new ModelCallError('bad_request', `The Claude API rejected the request: ${detail}`, status, requestId);
    if (status === 413) return new ModelCallError('too_large', 'The invoice is too large to send in one request.', status, requestId);
    if (status === 402) return new ModelCallError('permission', 'The Claude API account has a billing problem.', status, requestId);
    if (status !== null && status >= 500) return new ModelCallError('server', `The Claude API had a server problem (HTTP ${status}). Try again later.`, status, requestId);
    if (status === null) return new ModelCallError('other', 'The Claude API connection failed partway through.', null, requestId);
    return new ModelCallError('other', `The Claude API returned an error (HTTP ${status}): ${detail}`, status, requestId);
  }
  // Anything else (a fetch TypeError, an SDK usage error) is described by fixed text only: its
  // message can quote a header, and so the key.
  return new ModelCallError('other', 'The request to the Claude API could not be sent. Check the API key in settings and the network.', null, null);
}

/** Why a key cannot be used, in words that never repeat it. Null when its shape is fine. */
export function apiKeyProblem(key: unknown): string | null {
  if (typeof key !== 'string' || key === '') return 'No Claude API key is set.';
  if (/[\u0000-\u001f\u007f]/.test(key)) return 'The Claude API key contains a line break or control character. Enter it again.';
  if (/\s/.test(key)) return 'The Claude API key contains a space. Enter it again.';
  if (!key.startsWith('sk-ant-')) return 'The Claude API key must start with sk-ant-. Check that the right key was entered.';
  if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key)) return 'The Claude API key has characters or a length an API key does not have. Enter it again.';
  return null;
}

/**
 * The only way ShelfReady builds a Claude client: the key's shape is checked first, the address
 * is pinned, no second credential is picked up from the environment, and an ANTHROPIC_LOG
 * setting cannot turn on request logging.
 */
export function createInvoiceAnthropicClient(apiKey: string): Anthropic {
  const problem = apiKeyProblem(apiKey);
  if (problem) throw new Error(problem);
  return new Anthropic({ apiKey, authToken: null, baseURL: ANTHROPIC_API_BASE, logLevel: 'warn', maxRetries: 2 });
}

function assertPinned(client: Pick<Anthropic, 'baseURL'>): void {
  if (String(client.baseURL).replace(/\/+$/, '') !== ANTHROPIC_API_BASE) {
    throw new Error(`The Claude client must talk to ${ANTHROPIC_API_BASE}. Build it with createInvoiceAnthropicClient.`);
  }
}

function stopKind(reason: string | null): StopKind {
  if (reason === 'end_turn' || reason === 'max_tokens' || reason === 'refusal') return reason;
  return 'other';
}

/** The parameters of one invoice call. Exported so tests can check the request shape. */
export function messageParams(req: ModelRequest) {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user' as const, content: req.content }],
    output_config: { effort: req.effort, format: { type: 'json_schema' as const, schema: req.schema } },
  };
}

/** Wraps the Anthropic SDK. The client must come from createInvoiceAnthropicClient. */
export function createAnthropicModelClient(client: Anthropic, opts: { timeoutMs?: number } = {}): InvoiceModelClient {
  assertPinned(client);
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
  return {
    async countTokens(req) {
      assertPinned(client);
      try {
        const { max_tokens: _unused, ...params } = messageParams(req);
        const r = await client.messages.countTokens(params, { timeout: 60_000 });
        return r.input_tokens;
      } catch (err) {
        throw classifyError(err);
      }
    },
    async call(req) {
      assertPinned(client);
      try {
        const stream = client.messages.stream(messageParams(req), { timeout });
        const msg = await stream.finalMessage();
        const reason = msg.stop_reason ?? null;
        const kind = stopKind(reason);
        // Read content only after the stop reason: a refusal or a cut-off answer is not data.
        let text: string | null = null;
        if (kind === 'end_turn') {
          const parts = msg.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text);
          text = parts.length ? parts.join('') : null;
        }
        const u = msg.usage;
        return {
          stop: kind,
          stopReason: reason,
          refusalCategory: kind === 'refusal' ? (msg.stop_details?.category ?? null) : null,
          text,
          usage: {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
            thinkingTokens: u.output_tokens_details?.thinking_tokens ?? null,
          },
          requestId: stream.request_id ?? null,
          model: msg.model,
        };
      } catch (err) {
        throw classifyError(err);
      }
    },
  };
}
