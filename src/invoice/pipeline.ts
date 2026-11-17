// Reads one invoice: first-pass model, code checks, fallback model, cost cap, review.
//
// - The first pass uses settings.firstPassModel. If any blocking check fails, the model rates
//   itself low confidence, or the call fails, the fallback model reads the invoice again.
// - If the fallback also fails, the result is "review", with every failed check listed in plain
//   words. A reading is "ok" only when it exists and every blocking check passed. Unchecked data
//   is never returned as good.
// - The cost cap is hard and covers the first pass and the fallback together. Each call's output
//   limit is set so its worst case fits in what is left. A call that cannot fit with enough room
//   to finish returns "needs_approval", and nothing more is sent until an admin approves. A
//   token count for photos that is not a number also stops for approval.
// - A PDF is never sent unless the API counted its tokens. Its page count cannot be trusted
//   locally (pages can hide in compressed object streams), so a failed count returns "retry":
//   nothing more is sent, and the same upload can simply be tried again. Counting is free.
// - A call that fails after it may have been sent is booked at its worst case.
// - The audit record holds models, tokens, cost and checks. Never the key, headers or images.
//   Every error message in it has passed through redactSecrets.

import { randomUUID } from 'node:crypto';
import { checkReading, type KnownItemLookup } from './checks.ts';
import {
  affordableOutputTokens,
  estimateCost,
  estimateIsUsable,
  localInputTokens,
  outputEstimate,
  usageCostUsd,
  type CostEstimate,
  type TokenUsage,
} from './cost.ts';
import { classifyError, ModelCallError, type CallErrorKind, type InvoiceModelClient, type ModelRequest } from './extract.ts';
import { findRepeatedUploads, prepareImage, preparePdf, sha256, sniffUpload, type PdfInput, type PreparedImage, type RepeatedUpload } from './images.ts';
import { buildUserContent, SYSTEM_PROMPT, type InvoiceContent } from './prompt.ts';
import { redactSecrets } from './redact.ts';
import { asModelInvoice, INVOICE_SCHEMA } from './schema.ts';
import { effortFor, priceOf, type Effort, type InvoiceReadingSettings } from './settings.ts';
import type { CheckedReading, CheckId, Notice } from './types.ts';

export interface InvoiceFile {
  name: string;
  bytes: Buffer;
}

/** An upload that cannot be read: too many files, too large, the wrong type. Safe to show. */
export class InvoiceInputError extends Error {
  constructor(message: string) {
    super(redactSecrets(message));
    this.name = 'InvoiceInputError';
  }
}

export interface ReaderDeps {
  client: InvoiceModelClient;
  settings: InvoiceReadingSettings;
  now?: () => Date;
  /**
   * The matching step's hook (src/matching/known-item.ts). When given, an unmatched line whose
   * code looks misread sends the reading to the fallback model; other unmatched lines go to review.
   */
  knownItem?: KnownItemLookup;
  /** Every unmatched line blocks, as the brief first said. Default false. */
  knownItemsBlocking?: boolean;
}

export type AttemptOutcome =
  | 'checked'
  | 'refusal'
  | 'max_tokens'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'no_text'
  | 'stopped_other'
  | 'api_error'
  | 'check_error'
  | 'config_error';

export interface Attempt {
  role: 'first_pass' | 'fallback';
  model: string;
  effort: Effort;
  estimate: CostEstimate;
  startedAt: string;
  durationMs: number;
  outcome: AttemptOutcome;
  stopReason: string | null;
  refusalCategory: string | null;
  usage: TokenUsage | null;
  /** What the call cost. When costIsEstimate is true, the worst case was booked instead. */
  costUsd: number;
  costIsEstimate: boolean;
  requestId: string | null;
  error: { kind: CallErrorKind | 'config' | 'checks'; message: string } | null;
  schemaProblems: string[];
  /** The checked reading, when the answer matched the schema. */
  reading: CheckedReading | null;
}

/**
 * ok: every blocking check passed. review: a person must look, with every reason listed.
 * needs_approval: over the cost cap, waiting for an admin. retry: the invoice could not be
 * measured right now and nothing more was sent; run the same upload again later.
 */
export type ReadStatus = 'ok' | 'review' | 'needs_approval' | 'retry';

/**
 * A reading stopped for an admin's approval.
 *
 * Keep it on the server only, never in the browser or any other place a user can edit. Store it
 * with the admin who must approve, the model and the worst-case estimate shown to them, and
 * resume only from that stored copy. On resume the files must be the same, the model must be
 * the one approved, the new worst case must not exceed the approved one, and every earlier
 * reading is checked again from scratch.
 */
export interface PendingApproval {
  stage: 'first_pass' | 'fallback';
  model: string;
  /** The worst case of the call waiting for approval, in US dollars. */
  estimateUsd: number;
  spentUsd: number;
  capUsd: number;
  /** Plain words for the admin. */
  message: string;
  /** Attempts already made, kept so approval does not pay for them again. */
  attempts: Attempt[];
  /** Fingerprint of the uploaded files. A resume must send the same files. */
  inputFingerprint: string;
}

export interface AuditAttempt {
  role: Attempt['role'];
  model: string;
  effort: Effort;
  outcome: AttemptOutcome;
  stopReason: string | null;
  refusalCategory: string | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number | null;
  maxOutputTokens: number;
  estimateUsd: number;
  worstUsd: number;
  costUsd: number;
  costIsEstimate: boolean;
  durationMs: number;
  requestId: string | null;
  checksPassed: CheckId[];
  checksFailed: Array<{ id: CheckId; message: string; details: string[] }>;
  error: string | null;
}

export interface ReadAudit {
  runId: string;
  startedAt: string;
  finishedAt: string;
  input: {
    kind: 'images' | 'pdf';
    files: Array<{ name: string; bytes: number; sha256: string; sentWidth: number | null; sentHeight: number | null }>;
    repeatedUploads: RepeatedUpload[];
  };
  attempts: AuditAttempt[];
  status: ReadStatus;
  /** The model whose reading is returned. */
  finalModel: string | null;
  totalCostUsd: number;
}

export interface ReadResult {
  status: ReadStatus;
  /** The reading to show: the one that passed, or the best one for review. Null when none could be made. */
  reading: CheckedReading | null;
  /** Why a person must look, in plain words. Empty when status is ok. */
  reviewReasons: string[];
  attempts: Attempt[];
  /** About the upload itself, for example a photo sent twice. */
  notices: Notice[];
  /** Image number to file name, for the review screen. */
  images: Array<{ index: number; name: string }>;
  approval: PendingApproval | null;
  audit: ReadAudit;
}

export interface ReadOptions {
  /** An admin approved the call described in resume. Ignored without resume. */
  approvedOverCap?: boolean;
  /** Resume from a needs_approval result, from the copy kept on the server. */
  resume?: PendingApproval;
  /** Measurement only: use this one model and never fall back. */
  onlyModel?: string;
}

/** Shown when a PDF's tokens could not be counted. Nothing was sent for it. */
export const MEASURE_PDF_FAILED = 'Could not measure this PDF, so it was not sent. Try again in a minute.';

interface PreparedInput {
  /** SHA-256 over every uploaded file's SHA-256, in upload order. */
  fingerprint: string;
  content: InvoiceContent;
  pages: number;
  sent: Array<{ index: number; name: string }>;
  repeated: RepeatedUpload[];
  notices: Notice[];
  files: ReadAudit['input']['files'];
}

/** A file name safe to show: one line, no secrets, not too long. */
function safeName(name: string): string {
  return redactSecrets(String(name), 80) || 'unnamed file';
}

/**
 * Prepares the upload. Limits and file types are checked before anything is decoded: photos
 * are oriented, resized and de-duplicated; a PDF goes as it is.
 */
export async function prepareInput(files: InvoiceFile[], settings: InvoiceReadingSettings): Promise<PreparedInput> {
  const u = settings.upload;
  if (files.length === 0) throw new InvoiceInputError('No invoice file was uploaded.');
  if (files.length > u.maxFiles) throw new InvoiceInputError(`At most ${u.maxFiles} files can be read at once. ${files.length} were uploaded.`);
  const kinds = files.map((f) => {
    if (f.bytes.length > u.maxFileBytes) {
      throw new InvoiceInputError(`${safeName(f.name)} is larger than ${Math.round(u.maxFileBytes / (1024 * 1024))} MB.`);
    }
    const kind = sniffUpload(f.bytes);
    if (kind === null) throw new InvoiceInputError(`${safeName(f.name)} is not a JPEG, PNG, WebP or HEIF photo, or a PDF.`);
    return kind;
  });
  const fingerprint = sha256(Buffer.from(files.map((f) => sha256(f.bytes)).join(',')));
  const pdfCount = kinds.filter((k) => k === 'pdf').length;
  if (pdfCount && files.length > 1) throw new InvoiceInputError('Upload either photos of the pages or one PDF, not both and not several PDFs.');
  if (pdfCount === 1) {
    const pdf: PdfInput = preparePdf(files[0]!.bytes, safeName(files[0]!.name));
    if (pdf.pagesEstimate > u.maxPdfPages) throw new InvoiceInputError(`${pdf.name} has more than ${u.maxPdfPages} pages.`);
    return {
      fingerprint,
      content: { kind: 'pdf', pdf },
      pages: pdf.pagesEstimate,
      sent: Array.from({ length: pdf.pagesEstimate }, (_, i) => ({ index: i + 1, name: `${pdf.name} page ${i + 1}` })),
      repeated: [],
      notices: [],
      files: [{ name: pdf.name, bytes: pdf.data.length, sha256: pdf.sha256, sentWidth: null, sentHeight: null }],
    };
  }
  const prepared: PreparedImage[] = [];
  for (const [i, f] of files.entries()) {
    try {
      prepared.push(await prepareImage(f.bytes, safeName(f.name), i + 1, settings.image));
    } catch {
      throw new InvoiceInputError(`${safeName(f.name)} could not be read as a picture. Take the photo again or upload it as JPEG or PNG.`);
    }
  }
  const repeated = findRepeatedUploads(prepared, settings.image.sameImageMaxDiff);
  const dropped = new Set(repeated.map((r) => r.index));
  const notices: Notice[] = repeated.map((r) => ({
    message: `${prepared[r.index - 1]!.name} is ${r.exact ? 'the same file as' : 'the same photo as'} ${prepared[r.sameAs - 1]!.name}. It was not sent again.`,
  }));
  const kept = prepared.filter((p) => !dropped.has(p.index));
  // Renumber in upload order, so the model sees images 1..n.
  const images = kept.map((p, i) => ({ ...p, index: i + 1 }));
  return {
    fingerprint,
    content: { kind: 'images', images },
    pages: images.length,
    sent: images.map((p) => ({ index: p.index, name: p.name })),
    repeated,
    notices,
    files: prepared.map((p) => ({
      name: p.name,
      bytes: p.data.length,
      sha256: p.sha256,
      sentWidth: dropped.has(p.index) ? null : p.width,
      sentHeight: dropped.has(p.index) ? null : p.height,
    })),
  };
}

function requestFor(model: string, settings: InvoiceReadingSettings, input: PreparedInput, maxTokens: number): ModelRequest {
  return {
    model,
    effort: effortFor(settings, model),
    maxTokens,
    system: SYSTEM_PROMPT,
    content: buildUserContent(input.content),
    schema: INVOICE_SCHEMA,
  };
}

function emptyEstimate(model: string): CostEstimate {
  return { model, inputTokens: 0, inputSource: 'local', outputTokensEstimate: 0, maxOutputTokens: 0, usd: 0, worstUsd: 0 };
}

function blankAttempt(role: Attempt['role'], model: string, effort: Effort, estimate: CostEstimate, startedAt: string): Attempt {
  return {
    role,
    model,
    effort,
    estimate,
    startedAt,
    durationMs: 0,
    outcome: 'api_error',
    stopReason: null,
    refusalCategory: null,
    usage: null,
    costUsd: 0,
    costIsEstimate: false,
    requestId: null,
    error: null,
    schemaProblems: [],
    reading: null,
  };
}

/** Runs every check, turning anything that throws into a failed attempt instead of a crash. */
function safeCheck(invoice: unknown, deps: ReaderDeps, input: PreparedInput, today: Date): { reading: CheckedReading | null; schemaProblems: string[]; error: string | null } {
  const v = asModelInvoice(invoice);
  if (!v.ok) return { reading: null, schemaProblems: v.problems.slice(0, 20).map((p) => redactSecrets(p, 200)), error: null };
  try {
    const reading = checkReading(v.invoice, {
      settings: deps.settings,
      today,
      imagesSent: input.content.kind === 'images' ? input.pages : undefined,
      knownItem: deps.knownItem,
      knownItemsBlocking: deps.knownItemsBlocking,
    });
    return { reading, schemaProblems: [], error: null };
  } catch {
    return { reading: null, schemaProblems: [], error: 'The checks could not run on this reading, so it is not used.' };
  }
}

async function attempt(role: Attempt['role'], model: string, deps: ReaderDeps, input: PreparedInput, req: ModelRequest, estimate: CostEstimate): Promise<Attempt> {
  const now = deps.now ?? (() => new Date());
  const started = now();
  const base = blankAttempt(role, model, req.effort, estimate, started.toISOString());
  let res;
  try {
    res = await deps.client.call(req);
  } catch (err) {
    const e = classifyError(err);
    // It may have been sent and billed, so the worst case is booked against the cap.
    const booked = e.mayHaveBilled;
    return {
      ...base,
      durationMs: now().getTime() - started.getTime(),
      error: { kind: e.kind, message: e.message },
      requestId: e.requestId,
      costUsd: booked ? estimate.worstUsd : 0,
      costIsEstimate: booked,
    };
  }
  const done: Attempt = {
    ...base,
    durationMs: now().getTime() - started.getTime(),
    stopReason: res.stopReason === null ? null : redactSecrets(res.stopReason, 40),
    refusalCategory: res.refusalCategory === null ? null : redactSecrets(res.refusalCategory, 40),
    usage: res.usage,
    costUsd: usageCostUsd(deps.settings, model, res.usage),
    requestId: res.requestId === null ? null : redactSecrets(res.requestId, 100),
  };
  if (res.stop === 'refusal') return { ...done, outcome: 'refusal' };
  if (res.stop === 'max_tokens') return { ...done, outcome: 'max_tokens' };
  if (res.stop !== 'end_turn') return { ...done, outcome: 'stopped_other' };
  if (res.text === null) return { ...done, outcome: 'no_text' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    return { ...done, outcome: 'invalid_json' };
  }
  const checked = safeCheck(parsed, deps, input, now());
  if (checked.error) return { ...done, outcome: 'check_error', error: { kind: 'checks', message: checked.error } };
  if (!checked.reading) return { ...done, outcome: 'schema_mismatch', schemaProblems: checked.schemaProblems };
  return { ...done, outcome: 'checked', reading: checked.reading };
}

/** Plain-word reasons an attempt is not good enough. Empty means it passed. */
export function attemptProblems(a: Attempt): string[] {
  const who = `${a.model}`;
  switch (a.outcome) {
    case 'checked':
      return a.reading ? a.reading.failed.flatMap((c) => [c.message, ...c.details.map((d) => `  ${d}`)]) : [`${who} returned no reading.`];
    case 'refusal':
      return [`${who} declined to read the invoice${a.refusalCategory ? ` (${a.refusalCategory})` : ''}.`];
    case 'max_tokens':
      return [`${who} ran out of room before finishing the reading. Raise the output limit or the cost cap in settings.`];
    case 'invalid_json':
    case 'no_text':
      return [`${who} did not return a reading.`];
    case 'schema_mismatch':
      return [`${who} returned a reading in the wrong shape: ${a.schemaProblems.slice(0, 3).join('; ')}`];
    case 'stopped_other':
      return [`${who} stopped early (${a.stopReason}).`];
    case 'api_error':
    case 'check_error':
    case 'config_error':
      return [a.error?.message ?? `${who} could not be used.`];
  }
}

function passed(a: Attempt): boolean {
  return a.outcome === 'checked' && a.reading !== null && a.reading.failed.length === 0;
}

/** The reading to show in review: the one with fewer failed checks, the later one on a tie. */
function bestReading(attempts: Attempt[]): Attempt | null {
  const read = attempts.filter((a) => a.reading !== null);
  if (read.length === 0) return null;
  return read.reduce((best, a) => (a.reading!.failed.length <= best.reading!.failed.length ? a : best));
}

function auditOf(a: Attempt): AuditAttempt {
  return {
    role: a.role,
    model: a.model,
    effort: a.effort,
    outcome: a.outcome,
    stopReason: a.stopReason,
    refusalCategory: a.refusalCategory,
    inputTokens: a.usage?.inputTokens ?? 0,
    outputTokens: a.usage?.outputTokens ?? 0,
    thinkingTokens: a.usage?.thinkingTokens ?? null,
    maxOutputTokens: a.estimate.maxOutputTokens,
    estimateUsd: a.estimate.usd,
    worstUsd: a.estimate.worstUsd,
    costUsd: a.costUsd,
    costIsEstimate: a.costIsEstimate,
    durationMs: a.durationMs,
    requestId: a.requestId,
    checksPassed: a.reading ? a.reading.checks.filter((c) => c.passed).map((c) => c.id) : [],
    checksFailed: a.reading ? a.reading.checks.filter((c) => !c.passed).map((c) => ({ id: c.id, message: c.message, details: c.details })) : [],
    error: a.error ? redactSecrets(`${a.error.kind}: ${a.error.message}`) : null,
  };
}

const DAMAGED = 'The saved approval is damaged or does not belong to these files. Upload the invoice again.';
const ROLES = new Set(['first_pass', 'fallback']);
const OUTCOMES = new Set<AttemptOutcome>(['checked', 'refusal', 'max_tokens', 'invalid_json', 'schema_mismatch', 'no_text', 'stopped_other', 'api_error', 'check_error', 'config_error']);

function usableMoney(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/**
 * Checks a saved approval before resuming from it, and runs every earlier reading through the
 * schema and the checks again. Stored check results are never trusted.
 */
function restoreAttempts(p: PendingApproval, input: PreparedInput, deps: ReaderDeps, today: Date): Attempt[] {
  if (!p || typeof p !== 'object' || !Array.isArray(p.attempts) || p.attempts.length > 2) throw new InvoiceInputError(DAMAGED);
  if (p.inputFingerprint !== input.fingerprint) throw new InvoiceInputError('These are not the files that were waiting for approval. Upload the invoice again.');
  if (!ROLES.has(p.stage) || typeof p.model !== 'string' || !usableMoney(p.estimateUsd) || !usableMoney(p.spentUsd)) throw new InvoiceInputError(DAMAGED);
  return p.attempts.map((a) => {
    if (!a || !ROLES.has(a.role) || !OUTCOMES.has(a.outcome) || typeof a.model !== 'string' || !usableMoney(a.costUsd)) throw new InvoiceInputError(DAMAGED);
    const estimate: CostEstimate = a.estimate && estimateIsUsable(a.estimate) ? a.estimate : emptyEstimate(a.model);
    const restored: Attempt = { ...a, estimate, reading: null, schemaProblems: [] };
    if (a.reading) {
      const checked = safeCheck(a.reading.invoice, deps, input, today);
      if (checked.error) return { ...restored, outcome: 'check_error', error: { kind: 'checks', message: checked.error } };
      if (!checked.reading) return { ...restored, outcome: 'schema_mismatch', schemaProblems: checked.schemaProblems };
      return { ...restored, outcome: 'checked', reading: checked.reading };
    }
    // A saved "checked" attempt with no reading is not believable.
    return a.outcome === 'checked' ? { ...restored, outcome: 'schema_mismatch', schemaProblems: ['the saved reading is missing'] } : restored;
  });
}

/** Reads an invoice from uploaded photos or one PDF. */
export async function readInvoice(files: InvoiceFile[], deps: ReaderDeps, opts: ReadOptions = {}): Promise<ReadResult> {
  const now = deps.now ?? (() => new Date());
  const s = deps.settings;
  const startedAt = now().toISOString();
  const runId = randomUUID();
  const input = await prepareInput(files, s);
  const attempts: Attempt[] = opts.resume ? restoreAttempts(opts.resume, input, deps, now()) : [];
  const spent = () => attempts.reduce((sum, a) => sum + a.costUsd, 0);
  const promptChars = SYSTEM_PROMPT.length + JSON.stringify(INVOICE_SCHEMA).length;

  const finish = (status: ReadStatus, chosen: Attempt | null, reviewReasons: string[], approval: PendingApproval | null): ReadResult => {
    const audit: ReadAudit = {
      runId,
      startedAt,
      finishedAt: now().toISOString(),
      input: { kind: input.content.kind, files: input.files, repeatedUploads: input.repeated },
      attempts: attempts.map(auditOf),
      status,
      finalModel: chosen?.model ?? null,
      totalCostUsd: spent(),
    };
    return { status, reading: chosen?.reading ?? null, reviewReasons, attempts, notices: input.notices, images: input.sent, approval, audit };
  };

  // Nothing more is sent. Earlier attempts and their cost stay in the audit.
  const retryLater = (why: string): ReadResult => finish('retry', bestReading(attempts), [why, ...attempts.flatMap(attemptProblems)], null);

  const stopForApproval = (role: Attempt['role'], model: string, worstUsd: number, why: string): ReadResult => {
    const message = `${why} The limit per invoice is $${s.costCapUsd.toFixed(2)}${spent() > 0 ? `, and $${spent().toFixed(2)} is already spent` : ''}. An admin must approve before it is sent.`;
    const approval: PendingApproval = {
      stage: role,
      model,
      estimateUsd: worstUsd,
      spentUsd: spent(),
      capUsd: s.costCapUsd,
      message,
      attempts: [...attempts],
      inputFingerprint: input.fingerprint,
    };
    return finish('needs_approval', bestReading(attempts), [message, ...attempts.flatMap(attemptProblems)], approval);
  };

  const plan: Array<{ role: Attempt['role']; model: string }> = opts.onlyModel
    ? [{ role: 'first_pass', model: opts.onlyModel }]
    : [
        { role: 'first_pass', model: s.firstPassModel },
        { role: 'fallback', model: s.fallbackModel },
      ];

  for (const step of plan) {
    if (attempts.some((a) => a.role === step.role)) continue; // done before an approval
    const last = attempts[attempts.length - 1];
    if (last && passed(last)) break;
    if (last?.error && (last.error.kind === 'authentication' || last.error.kind === 'permission' || last.error.kind === 'too_large')) break;
    const effort = effortFor(s, step.model);
    if (!priceOf(s, step.model)) {
      attempts.push({
        ...blankAttempt(step.role, step.model, effort, emptyEstimate(step.model), now().toISOString()),
        outcome: 'config_error',
        error: { kind: 'config', message: `No price is set for ${step.model}. Set a price for this model in settings before it can be used.` },
      });
      continue;
    }

    // 1. Input tokens, counted by the API (free). A PDF is never sent without a count: its page
    //    count cannot be trusted locally, so a failed or unusable count returns "retry". Photos
    //    can be counted locally, since their sizes are known exactly; an unusable count for
    //    photos falls back to that local count and asks an admin.
    const countReq = requestFor(step.model, s, input, s.maxOutputTokens);
    let counted: number | null = null;
    try {
      counted = await deps.client.countTokens(countReq);
    } catch (err) {
      const e = classifyError(err);
      if (e.sameForAnyModel) {
        attempts.push({ ...blankAttempt(step.role, step.model, effort, emptyEstimate(step.model), now().toISOString()), error: { kind: e.kind, message: e.message }, requestId: e.requestId });
        break;
      }
    }
    const usable = counted !== null && Number.isSafeInteger(counted) && counted >= 0;
    if (!usable && input.content.kind === 'pdf') return retryLater(MEASURE_PDF_FAILED);
    let inputTokens: number;
    let inputSource: CostEstimate['inputSource'] = 'count_tokens';
    let askBecause = '';
    if (usable) {
      inputTokens = counted!;
    } else {
      inputTokens = input.content.kind === 'images' ? localInputTokens(input.content.images, promptChars) : 0;
      inputSource = 'local';
      if (counted !== null) askBecause = `The token count for ${step.model} came back unusable, so the photos were counted here instead.`;
    }

    // 2. Output room: what fits in the cap, unless an admin approved this exact call.
    const need = outputEstimate(s, step.model, input.pages);
    const fullWorst = estimateCost(s, step.model, inputTokens, inputSource, input.pages, s.maxOutputTokens);
    const r = opts.resume;
    const approved =
      opts.approvedOverCap === true &&
      r !== undefined &&
      r.stage === step.role &&
      r.model === step.model &&
      usableMoney(r.estimateUsd) &&
      fullWorst.worstUsd <= r.estimateUsd * 1.05 + 0.01;
    let maxTokens: number;
    if (approved) {
      maxTokens = s.maxOutputTokens;
    } else if (askBecause) {
      return stopForApproval(step.role, step.model, fullWorst.worstUsd, `${askBecause} Reading it could cost up to $${fullWorst.worstUsd.toFixed(2)}.`);
    } else {
      const affordable = affordableOutputTokens(s, step.model, inputTokens, s.costCapUsd - spent());
      if (affordable < need) {
        return stopForApproval(
          step.role,
          step.model,
          fullWorst.worstUsd,
          `Reading this invoice with ${step.model} could cost up to $${fullWorst.worstUsd.toFixed(2)} (usually about $${fullWorst.usd.toFixed(2)}).`,
        );
      }
      maxTokens = Math.min(s.maxOutputTokens, affordable);
    }
    const estimate = estimateCost(s, step.model, inputTokens, inputSource, input.pages, maxTokens);
    if (!estimateIsUsable(estimate)) {
      // Prices are checked above, so this means a setting is out of range. Fail closed.
      attempts.push({
        ...blankAttempt(step.role, step.model, effort, emptyEstimate(step.model), now().toISOString()),
        outcome: 'config_error',
        error: { kind: 'config', message: `The cost of ${step.model} could not be worked out from the settings. Check its price and the output limit.` },
      });
      continue;
    }
    attempts.push(await attempt(step.role, step.model, deps, input, { ...countReq, maxTokens }, estimate));
  }

  const winner = attempts.find(passed) ?? null;
  if (winner) return finish('ok', winner, [], null);
  const shown = bestReading(attempts);
  const reasons: string[] = [];
  for (const a of attempts) {
    const problems = attemptProblems(a);
    if (problems.length) reasons.push(`${a.role === 'first_pass' ? 'First reading' : 'Second reading'} (${a.model}):`, ...problems.map((p) => `  ${p}`));
  }
  if (attempts.length === 0) reasons.push('The invoice was not read.');
  return finish('review', shown, reasons, null);
}

/** A ModelCallError for tests and callers that need to tell kinds apart. */
export { ModelCallError };
