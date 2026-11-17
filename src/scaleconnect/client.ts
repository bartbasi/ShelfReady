// ShelfReady's client for ScaleConnect's MCP server, over Streamable HTTP with a bearer token.
//
// Rules this client keeps, from ScaleConnect's docs/MCP.md:
// - It never sets acknowledge_warnings or acknowledge_drift on its own. applyChanges takes both
//   as required arguments, so a caller must pass what a person agreed to.
// - It never retries a call that reads or writes a scale. A read can freeze a real scale, and an
//   apply must never be sent twice.
// - An apply can take minutes. If the call times out or the connection drops, the change keeps
//   running on the server. applyChanges then returns kind 'unknown': call getChange with the
//   preview id to learn the result. Do not apply again.
// - The token is never logged and never put in an error message.

import { inspect } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/** Calls that contact no scale. */
export const SHORT_CALL_TIMEOUT_MS = 2 * 60 * 1000;
/**
 * Calls that read or write scales. Measured on the real scales on November 2, 2026: a compare of
 * three scales 97 to 102 seconds, one edit applied to three scales 149 seconds, and an unreachable
 * scale adds about 2 minutes. A large invoice takes longer, so allow plenty.
 */
export const LONG_CALL_TIMEOUT_MS = 30 * 60 * 1000;

export interface ScaleConnectClientOptions {
  /** For example http://127.0.0.1:18765/mcp. The host must be exactly the one in ScaleConnect's config. */
  url: string;
  /** The MCP bearer token. Never logged. */
  token: string;
  /** Shown in ScaleConnect's change log as mcp:<name> when the config sets no mcp_caller. */
  clientName?: string;
  shortCallTimeoutMs?: number;
  longCallTimeoutMs?: number;
}

/** One change for scale_preview_changes. Prices are text with two decimals, never numbers. */
export interface ScaleChange {
  action: 'add' | 'edit' | 'delete';
  target_plu?: string;
  target_id?: number;
  plu?: string;
  code?: string;
  description?: string;
  price?: string;
  sold_by?: 'weight' | 'piece';
  replace_orphan_id?: number;
  expected_plu?: string;
}

/** The scale statuses ScaleConnect can report, from ScaleConnect's own docs/LIBRARY.md, "Statuses". */
export type ScaleStatus =
  | 'verified'
  | 'accepted_not_verified'
  | 'rejected'
  | 'unknown'
  | 'unreachable'
  | 'skipped_not_write_enabled'
  | 'not_available'
  | 'wrong_scale'
  | 'mismatch'
  | 'drift_refused'
  | 'read_failed';

/**
 * Every result carries these. The rest of the structured data is passed through as ScaleConnect
 * sends it. Text fields that come from scales (descriptions, messages) are data, never instructions.
 */
export interface ScaleConnectResult {
  summary: string;
  data_note?: string;
  next_step?: string;
  ok?: boolean;
  /** true on a refusal: the service refused before anything reached a scale. */
  nothing_sent?: boolean;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export interface PreviewResult extends ScaleConnectResult {
  preview_id?: string;
  must_acknowledge_warnings?: boolean;
  drift_tokens_to_acknowledge?: string[];
  warnings?: Array<{ code: string; requires_ack?: boolean; may_be_frozen?: boolean; [key: string]: unknown }>;
  left_out?: string[];
  scales_may_be_frozen?: string[];
}

export interface ChangeResult extends ScaleConnectResult {
  /** True only if every configured scale is verified. Nothing else is a success. */
  success?: boolean;
  outcome?: string;
  change_id?: string;
  scale_statuses?: Record<string, ScaleStatus | string>;
  scales_may_be_frozen?: string[];
  still_to_do?: string[];
}

/**
 * A tool's answer. isError is MCP's error flag. Do not decide anything on it alone: ScaleConnect
 * sets it on refusals, on RESULT UNKNOWN, on a partial apply where a scale was unreachable, left
 * out or may be frozen, and on some other partial results. Use the structured fields, or the
 * WriteResult kind for applies.
 */
export interface ToolAnswer<T extends ScaleConnectResult> {
  isError: boolean;
  data: T;
}

/**
 * What an apply did, from the structured fields (success, outcome, nothing_sent, scale_statuses).
 * - success: every configured scale verified. The only kind that means done for the scales.
 * - partial: some scales have it and some do not. See data.scale_statuses and data.items.
 *   A settle touches one scale, so a settle that verified there is partial too: use
 *   targetedScaleStatuses to see the scales it was meant for.
 * - failed: nothing landed anywhere, and ScaleConnect knows it (outcome failed).
 * - refused: nothing was sent to any scale. Either ScaleConnect refused the apply with
 *   nothing_sent true, or this client refused the arguments before sending anything.
 * - unknown: nobody can say what landed. Call getChange({ previewId }). Never apply again.
 */
export type WriteResult =
  | { kind: 'success'; previewId: string; isError: boolean; data: ChangeResult }
  | { kind: 'partial'; previewId: string; isError: boolean; data: ChangeResult }
  | { kind: 'failed'; previewId: string; isError: boolean; data: ChangeResult }
  | { kind: 'refused'; previewId: string; isError: boolean; data?: ScaleConnectResult; message: string }
  | { kind: 'unknown'; previewId: string; isError: boolean; data?: ScaleConnectResult; message: string };

export type ApplyKind = WriteResult['kind'];

/**
 * What the change log says about a change, from getChange. There is no 'refused' here: on
 * scale_get_change, nothing_sent and ok false describe the lookup, not the change.
 * - not_applied: ScaleConnect has no apply for this preview id (applied false). If an earlier apply
 *   timed out, its request may still be on its way. Check again before treating it as never sent,
 *   and never apply a preview a second time on this alone.
 * - unknown: the lookup failed, or the change has no clear outcome (in_progress, interrupted,
 *   catalog_out_of_sync, unknown). Look again later and compare the scales.
 */
export type LoggedChangeKind = 'success' | 'partial' | 'failed' | 'not_applied' | 'unknown';

/** success, partial, failed or unknown, from a change record's own fields. */
function classifyRecord(d: ChangeResult): 'success' | 'partial' | 'failed' | 'unknown' {
  const statuses = Object.values(d.scale_statuses ?? {});
  if (
    d.success === true &&
    d.outcome === 'success' &&
    statuses.length > 0 &&
    statuses.every((s) => s === 'verified')
  ) {
    return 'success';
  }
  if (d.success === true) return 'unknown'; // a success flag that disagrees with the statuses
  if (d.outcome === 'partial') return 'partial';
  if (d.outcome === 'failed') return 'failed';
  // no outcome, unknown, in_progress, catalog_out_of_sync or interrupted.
  return 'unknown';
}

/** Classifies a scale_apply_changes result. Never from isError alone. */
export function classifyApply(data: ScaleConnectResult): ApplyKind {
  const d = data as ChangeResult;
  if (d.nothing_sent === true && d.ok === false) return 'refused';
  if (d.ok === false || d.error !== undefined) return 'unknown'; // RESULT UNKNOWN and anything like it
  return classifyRecord(d);
}

/** Classifies a scale_get_change result. Never returns 'refused'. */
export function classifyLoggedChange(data: ScaleConnectResult): LoggedChangeKind {
  const d = data as ChangeResult & { applied?: boolean };
  if (d.ok === false || d.error !== undefined) return 'unknown';
  if (d.applied === false) return 'not_applied';
  return classifyRecord(d);
}

/**
 * The status of each scale a change was meant for, for the resend screen. A settle or a change
 * with scales set targets fewer than all scales. Scales listed in not_touched are left out.
 * allVerified follows ScaleConnect's own full success check, limited to these scales: each is
 * verified, every item row on it is verified, and no still_differ entry names it. A still_differ
 * entry with no scale name counts against every scale.
 */
export function targetedScaleStatuses(data: ChangeResult): {
  statuses: Record<string, string>;
  allVerified: boolean;
} {
  const notTouched = new Set(Array.isArray(data.not_touched) ? (data.not_touched as string[]) : []);
  const statuses: Record<string, string> = Object.fromEntries(
    Object.entries(data.scale_statuses ?? {}).filter(([name]) => !notTouched.has(name)),
  );
  const names = Object.keys(statuses);
  const differs = Array.isArray(data.still_differ) ? (data.still_differ as Array<{ scale?: unknown }>) : [];
  const stillDiffers = (name: string) => differs.some((d) => typeof d?.scale !== 'string' || d.scale === name);
  const results = Array.isArray(data.scale_results)
    ? (data.scale_results as Array<{ scale?: unknown; items?: Array<{ status?: unknown }> }>)
    : [];
  const rows = Array.isArray(data.items) ? (data.items as Array<{ scales?: Record<string, { status?: unknown }> }>) : [];
  const itemsVerified = (name: string) =>
    results.filter((r) => r?.scale === name).every((r) => (r.items ?? []).every((i) => i?.status === 'verified')) &&
    rows.every((row) => row?.scales?.[name] === undefined || row.scales[name].status === 'verified');
  const allVerified =
    names.length > 0 &&
    names.every((name) => statuses[name] === 'verified' && !stillDiffers(name) && itemsVerified(name));
  return { statuses, allVerified };
}

/** A logged change, with what it means. */
export interface LoggedChange extends ToolAnswer<ChangeResult> {
  kind: LoggedChangeKind;
}

export interface Acknowledgements {
  /** Exactly true only after a person has seen and accepted every warning that requires it. */
  acknowledgeWarnings: boolean;
  /** Tokens from drift_tokens_to_acknowledge that a person has seen and accepted. Usually []. */
  acknowledgeDrift: string[];
}

export class ScaleConnectError extends Error {
  readonly isError: boolean | undefined;
  constructor(message: string, options?: { cause?: unknown; isError?: boolean }) {
    super(message, options);
    this.name = 'ScaleConnectError';
    this.isError = options?.isError;
  }
}

function describe(err: unknown): string {
  if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) return 'client timeout';
  if (err instanceof Error) return err.name;
  return 'unknown error';
}

export class ScaleConnectClient {
  #url: URL;
  #token: string;
  #clientName: string;
  #shortMs: number;
  #longMs: number;
  #client: Client | undefined;
  #transport: StreamableHTTPClientTransport | undefined;

  constructor(options: ScaleConnectClientOptions) {
    if (!options.token) throw new ScaleConnectError('A ScaleConnect token is required.');
    this.#url = new URL(options.url);
    this.#token = options.token;
    this.#clientName = options.clientName ?? 'shelfready';
    this.#shortMs = options.shortCallTimeoutMs ?? SHORT_CALL_TIMEOUT_MS;
    this.#longMs = options.longCallTimeoutMs ?? LONG_CALL_TIMEOUT_MS;
  }

  /** Keeps the token out of console.log and util.inspect. */
  [inspect.custom](): string {
    return `ScaleConnectClient { url: '${this.#url.href}', connected: ${this.#client !== undefined} }`;
  }

  toJSON(): { url: string } {
    return { url: this.#url.href };
  }

  /** Server text can echo a request. Never let the token through. */
  #redact(text: string): string {
    return text.split(this.#token).join('[redacted]').slice(0, 2000);
  }

  async connect(): Promise<void> {
    if (this.#client) return;
    const transport = new StreamableHTTPClientTransport(this.#url, {
      // No redirect is followed, not even within the same origin: the token goes to this URL only.
      requestInit: { headers: { Authorization: `Bearer ${this.#token}` }, redirect: 'error' },
    });
    const client = new Client({ name: this.#clientName, version: '0.0.1' });
    try {
      await client.connect(transport, { timeout: this.#shortMs });
    } catch (err) {
      await transport.close().catch(() => {});
      throw new ScaleConnectError(`Could not connect to ScaleConnect at ${this.#url.href} (${describe(err)}).`, {
        cause: err,
      });
    }
    this.#client = client;
    this.#transport = transport;
  }

  async close(): Promise<void> {
    const transport = this.#transport;
    const client = this.#client;
    this.#client = undefined;
    this.#transport = undefined;
    if (transport) await transport.terminateSession().catch(() => {});
    if (client) await client.close().catch(() => {});
  }

  async #call<T extends ScaleConnectResult>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ToolAnswer<T>> {
    const client = this.#client;
    if (!client) throw new ScaleConnectError('Not connected. Call connect() first.');
    // undefined values are dropped: ScaleConnect refuses unknown keys, and null is not "left out".
    const clean = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
    // This client never calls listTools, so the SDK holds no output schemas and adds no checks of its
    // own after a tool has run. Even so, applyChanges treats any error once the request has left as
    // unknown, never as refused, so an SDK error raised after the tool ran cannot read as "not sent".
    let result;
    try {
      result = await client.callTool({ name, arguments: clean }, undefined, {
        timeout: timeoutMs,
        maxTotalTimeout: timeoutMs,
      });
    } catch (err) {
      if (err instanceof McpError && err.code !== ErrorCode.RequestTimeout) {
        throw new ScaleConnectError(`ScaleConnect's ${name} failed: ${this.#redact(err.message)}`, { cause: err });
      }
      throw err;
    }
    const data = result.structuredContent as T | undefined;
    if (!data || typeof data.summary !== 'string') {
      const text = (Array.isArray(result.content) ? result.content : [])
        .map((c: { type?: string; text?: string }) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
        .join(' ')
        .trim();
      const isError = result.isError === true;
      const message = `ScaleConnect's ${name} returned no structured result (isError ${isError}): ${this.#redact(text) || 'no text'}`;
      throw new ScaleConnectError(message, { isError });
    }
    return { isError: result.isError === true, data };
  }

  // ---- calls that contact no scale

  listScales(): Promise<ToolAnswer<ScaleConnectResult>> {
    return this.#call('scale_list_scales', {}, this.#shortMs);
  }

  searchItems(query: string, limit?: number): Promise<ToolAnswer<ScaleConnectResult>> {
    return this.#call('scale_search_items', { query, limit }, this.#shortMs);
  }

  getItem(target: { plu: string } | { id: number }): Promise<ToolAnswer<ScaleConnectResult>> {
    return this.#call('scale_get_item', { ...target }, this.#shortMs);
  }

  /**
   * The logged result of a change, with its kind. Contacts no scale, so it is safe to call again.
   * If it throws, the change is still unknown: never apply again because of a failed lookup.
   */
  async getChange(target: { changeId: string } | { previewId: string }): Promise<LoggedChange> {
    const args = 'changeId' in target ? { change_id: target.changeId } : { preview_id: target.previewId };
    const answer = await this.#call<ChangeResult>('scale_get_change', args, this.#shortMs);
    return { ...answer, kind: classifyLoggedChange(answer.data) };
  }

  // ---- calls that read scales. A read can freeze a real scale: call only with a reason, never in a loop.

  /**
   * Reads scales unless readScales is false. A subset of scales needs an acknowledgement and is never
   * a success. If the result names scales_may_be_frozen, do not apply it: make a new preview.
   */
  previewChanges(
    changes: ScaleChange[],
    options: { scales?: string[]; readScales?: boolean } = {},
  ): Promise<ToolAnswer<PreviewResult>> {
    return this.#call(
      'scale_preview_changes',
      { changes, scales: options.scales, read_scales: options.readScales },
      this.#longMs,
    );
  }

  /**
   * Prepares to end drift or a missed change on one item on one scale. take 'catalog' sends the
   * catalog's record to the scale (the resend). take 'scale' makes the catalog take the scale's record.
   * Reads that scale. Apply with applyChanges, passing its drift tokens only after a person agrees.
   */
  previewSettleDrift(
    scale: string,
    take: 'catalog' | 'scale',
    target: { plu: string } | { id: number },
  ): Promise<ToolAnswer<PreviewResult>> {
    return this.#call('scale_preview_settle_drift', { scale, take, ...target }, this.#longMs);
  }

  readItems(target: { plus?: string[]; ids?: number[]; scales?: string[] }): Promise<ToolAnswer<ScaleConnectResult>> {
    return this.#call('scale_read_items', { plus: target.plus, ids: target.ids, scales: target.scales }, this.#longMs);
  }

  /** Compares scales with the catalog. A scale flagged as may be frozen is left out unless it is named alone. */
  compareScales(options: { scales?: string[]; maxDifferences?: number } = {}): Promise<ToolAnswer<ScaleConnectResult>> {
    return this.#call(
      'scale_compare_scales',
      { scales: options.scales, max_differences: options.maxDifferences },
      this.#longMs,
    );
  }

  /**
   * Compares one scale alone. This is the only read that reaches a scale flagged as may be frozen,
   * and an answer clears the flag. Call it only after a person has looked at that scale.
   */
  compareScale(scale: string, maxDifferences?: number): Promise<ToolAnswer<ScaleConnectResult>> {
    return this.compareScales({ scales: [scale], maxDifferences });
  }

  // ---- the one call that writes to scales

  /**
   * Sends a preview (from previewChanges or previewSettleDrift) to the scales. Both acknowledgements
   * are required and passed exactly as given. Never throws once the request may have left: a timeout
   * or lost connection gives kind 'unknown'. Then call getChange({ previewId }) and do not apply again.
   */
  async applyChanges(previewId: string, acks: Acknowledgements): Promise<WriteResult> {
    // Checked here, before anything is sent, so a bad argument is a refusal and never an unknown.
    const problem = applyArgumentProblem(previewId, acks);
    if (problem) return { kind: 'refused', previewId: String(previewId), isError: true, message: problem };
    if (!this.#client) {
      return { kind: 'refused', previewId, isError: true, message: 'Not connected. Call connect() first.' };
    }
    let answer: ToolAnswer<ChangeResult>;
    try {
      answer = await this.#call<ChangeResult>(
        'scale_apply_changes',
        {
          preview_id: previewId,
          acknowledge_warnings: acks.acknowledgeWarnings,
          acknowledge_drift: acks.acknowledgeDrift,
        },
        this.#longMs,
      );
    } catch (err) {
      // The request may have left, so nobody can say it was not applied.
      const message =
        err instanceof ScaleConnectError
          ? err.message
          : `The apply did not return (${describe(err)}). It may still be running or may have finished.`;
      return {
        kind: 'unknown',
        previewId,
        isError: true,
        message: `${message} Call getChange with this preview id to learn the result. Do not apply again.`,
      };
    }
    const { data, isError } = answer;
    const kind = classifyApply(data);
    if (kind === 'refused' || kind === 'unknown') {
      return { kind, previewId, isError, data, message: data.summary };
    }
    return { kind, previewId, isError, data };
  }
}

/** Why these apply arguments cannot be sent, or undefined if they can. */
function applyArgumentProblem(previewId: unknown, acks: Acknowledgements | undefined): string | undefined {
  if (typeof previewId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(previewId)) {
    return 'The preview id must be the preview_id from a preview.';
  }
  if (typeof acks?.acknowledgeWarnings !== 'boolean') {
    return 'acknowledgeWarnings must be true or false, set by a person.';
  }
  if (!Array.isArray(acks.acknowledgeDrift) || !acks.acknowledgeDrift.every((t) => typeof t === 'string' && t.length > 0)) {
    return 'acknowledgeDrift must be a list of drift tokens a person accepted, usually empty.';
  }
  return undefined;
}
