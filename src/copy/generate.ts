// Writes card copy for a product that has none (decision 5): one call to the model with the
// server-side web search tool, code checks, at most one retry, the verify list, then the card is
// stored, linked to its Square variation in the run's catalog. A written card never prints until
// a person has checked its current version (src/copy/store.ts needsCheck).
//
// - Cost: the prompt is counted first (free). The call is fitted to what is left of the cap,
//   first by allowing fewer searches, then by a lower output limit. A call that cannot fit is not
//   sent: the result is needs_approval, and the same product can be sent again with an admin's
//   approval of that amount. Cost is booked from the usage the API reports, and checked against
//   the cap after every call: past it, no further call is made. Calls are never retried by the
//   SDK, and a call that fails after it may have been sent is booked at its worst case.
// - A call the server paused (pause_turn) is continued only while it has a search left, with
//   max_uses set to the searches left and the continuation fitted on a real token count.
//   Otherwise nothing is stored and the product goes to a person.
// - The answer is parsed against the schema, cleaned and checked in code. A card out of limits
//   gets one retry with no search tool, stating each measured overage. The retry returns its own
//   claims and verify list, citing only pages the first call's searches returned.
// - A price, phone number or web address still on the card after the retry stores it blocked:
//   it cannot print until a person edits the finding out.
// - The model's text is data. It is never run, never sent anywhere but the card store, and it
//   cannot carry a price or a code: the schema has no such fields.
// - The audit log gets the model, tokens, cost, searches, sources and any approval. Never the key.

import { appendAudit, type AuditActor } from '../db/audit.ts';
import type { Db } from '../db/db.ts';
import type { TokenUsage } from '../invoice/cost.ts';
import { classifyError } from '../invoice/extract.ts';
import { redactSecrets } from '../invoice/redact.ts';
import type { Effort } from '../invoice/settings.ts';
import { checkContent, normalizeContent, type CheckProblem } from './checks.ts';
import type { CopyModelClient, CopyRequest, CopyResponse } from './client.ts';
import type { CopyConfig } from './config.ts';
import { copyCallCostUsd, estimateCopy, fitCopyCall, localPromptTokens, type CopyEstimate } from './cost.ts';
import { pickVoiceExamples, retryContent, systemPrompt, userContent } from './prompt.ts';
import { generationSchema, OTHER_CATEGORY, parseAnswer, retrySchema, type ModelAnswer, type ModelCard, type RetryAnswer } from './schema.ts';
import { copyPriceOf, type CopySettings } from './settings.ts';
import { checkContentShape, insertGeneratedCard, liveCardForVariation, liveCards } from './store.ts';
import { cleanText } from './text.ts';
import { CopyError, type CardContent, type CardReview, type InvoiceFacts, type ProductFacts, type SearchRecord, type StoredCard } from './types.ts';
import { buildReview } from './verify.ts';

/** A rendered check of one card: lines its copy takes, lines the panel holds, and whether the end is cut off. */
export type RenderCheck = (content: CardContent, product: ProductFacts) => Promise<{ copyLines: number; maxCopyLines: number; clipped: boolean } | null>;

export interface CopyDeps {
  db: Db;
  client: CopyModelClient;
  settings: CopySettings;
  config: CopyConfig;
  actor: AuditActor;
  /** Milliseconds since 1970, from the app's clock so tests can move it. */
  now?: () => number;
  /** The rendered check (src/copy/render-check.ts), when LibreOffice may run. */
  renderCheck?: RenderCheck | null;
}

export interface CopyAttempt {
  role: 'write' | 'continue' | 'shorten';
  model: string;
  effort: Effort;
  estimate: CopyEstimate;
  stopReason: string | null;
  refusalCategory: string | null;
  usage: TokenUsage | null;
  webSearchRequests: number;
  /** Readings the server reported (usage.iterations), or null when it did not say. */
  serverReadings: number | null;
  costUsd: number;
  /** The cost is the worst case, booked because the call failed after it may have been billed. */
  costIsEstimate: boolean;
  requestId: string | null;
  durationMs: number;
  error: { kind: string; message: string } | null;
}

/**
 * written: stored and within limits, waiting for a person's check like every generated card.
 * review: stored, with problems, or blocked. needs_approval: nothing sent, over the cap.
 * failed: nothing stored.
 */
export type CopyStatus = 'written' | 'review' | 'needs_approval' | 'failed';

/** An admin's approval to spend up to an amount on one product, shown as needs_approval before. */
export interface CopyApproval {
  model: string;
  approvedUsd: number;
  approvedBy: string;
}

export interface CopyResult {
  status: CopyStatus;
  product: ProductFacts;
  card: StoredCard | null;
  /** Plain words: why the result is not written cleanly. */
  reasons: string[];
  attempts: CopyAttempt[];
  costUsd: number;
  /** For needs_approval: what to approve to send it. */
  approval: { model: string; worstUsd: number; capUsd: number; spentUsd: number } | null;
  /** Things worth knowing that do not change the status, such as a rendered check that could not run. */
  notes: string[];
}

/** Characters one line of copy holds, for stating a rendered overage in characters. */
const CHARS_PER_LINE = 36;

/**
 * The model's card as card text, normalized. The category is stored as its word only, and its
 * number is taken from the config at print time, so numbers never repeat (src/copy/card.ts).
 */
export function cardFromModel(card: ModelCard, cfg: CopyConfig, product: ProductFacts): { content: CardContent; newCategory: string | null; fixes: string[] } {
  const proposed = cleanText(card.new_category).toUpperCase().replace(/[^A-Z &]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const word = card.category === OTHER_CATEGORY ? proposed || OTHER_CATEGORY : card.category;
  const known = cfg.categories.some((c) => c.word === word);
  const raw: CardContent = {
    origin: card.origin,
    eyebrow: word,
    n1: card.n1,
    n2: card.n2,
    producer: card.producer,
    specs: [
      [card.spec1.label, card.spec1.value],
      [card.spec2.label, card.spec2.value],
      [card.spec3.label, card.spec3.value],
    ],
    copy: [card.paragraph1, card.paragraph2],
    unit: card.unit,
  };
  const { content, fixes } = normalizeContent(raw, { soldByWeight: product.soldByWeight, curlyApostrophes: cfg.guide.curlyApostrophes });
  return { content, newCategory: known ? null : word, fixes };
}

/** Card text back in the model's shape, for the retry. */
function asModelCard(c: CardContent, cfg: CopyConfig): ModelCard {
  const known = cfg.categories.some((x) => x.word === c.eyebrow);
  return {
    origin: c.origin,
    category: known ? c.eyebrow : OTHER_CATEGORY,
    new_category: known ? '' : c.eyebrow,
    n1: c.n1,
    n2: c.n2,
    producer: c.producer,
    spec1: { label: c.specs[0][0], value: c.specs[0][1] },
    spec2: { label: c.specs[1][0], value: c.specs[1][1] },
    spec3: { label: c.specs[2][0], value: c.specs[2][1] },
    paragraph1: c.copy[0] ?? '',
    paragraph2: c.copy[1] ?? '',
    unit: c.unit,
  };
}

function stopReasonText(res: CopyResponse): string {
  if (res.stop === 'refusal') return `The model declined to write this card${res.refusalCategory ? ` (${redactSecrets(res.refusalCategory, 40)})` : ''}.`;
  if (res.stop === 'max_tokens') return 'The answer was cut off at the output limit.';
  if (res.stop === 'pause_turn') return 'The model paused its search and could not be continued within its searches and the cap. Nothing was stored; a person can send it again.';
  return `The call stopped early (${redactSecrets(res.stopReason ?? 'no reason given', 40)}).`;
}

/**
 * Writes, checks and stores the copy for one product. budgetUsd lowers the cap, for a run's
 * total. approval raises it, for one product an admin approved after needs_approval.
 * onReserve gets the worst case spent so far plus the next call's, just before each call.
 */
export async function generateCopy(
  deps: CopyDeps,
  product: ProductFacts,
  invoice: InvoiceFacts | null,
  opts: { budgetUsd?: number; approval?: CopyApproval; onReserve?: (worstUsd: number) => void } = {},
): Promise<CopyResult> {
  const s = deps.settings;
  const cfg = deps.config;
  const now = deps.now ?? (() => Date.now());
  const model = s.model;
  const approved = opts.approval && opts.approval.model === model && Number.isFinite(opts.approval.approvedUsd) && opts.approval.approvedUsd > 0 ? opts.approval : null;
  const cap = approved ? approved.approvedUsd : Math.min(s.costCapUsd, opts.budgetUsd ?? Number.POSITIVE_INFINITY);
  const attempts: CopyAttempt[] = [];
  const searches: SearchRecord[] = [];
  const notes: string[] = [];
  const spent = () => attempts.reduce((sum, a) => sum + a.costUsd, 0);
  const overCap = () => spent() > cap + 1e-9;
  const result = (status: CopyStatus, reasons: string[], card: StoredCard | null = null, approval: CopyResult['approval'] = null): CopyResult => ({
    status,
    product,
    card,
    reasons: reasons.map((r) => redactSecrets(r, 400)),
    attempts,
    costUsd: spent(),
    approval,
    notes,
  });

  if (liveCardForVariation(deps.db, product.catalog, product.variationId)) return result('failed', [`${product.label} already has a card. Use it, or edit it.`]);
  if (!copyPriceOf(s, model)) return result('failed', [`No price is set for ${model}, so its cost cannot be estimated and it is not called.`]);

  const examples = pickVoiceExamples(liveCards(deps.db), product, invoice, s.voiceExamples);
  const schema = generationSchema(cfg);
  const first: CopyRequest = {
    model,
    effort: s.effort,
    maxTokens: s.maxOutputTokens,
    system: systemPrompt(cfg, { research: true, maxSearches: s.maxSearches }),
    messages: [{ role: 'user', content: userContent(product, invoice, examples) }],
    schema,
    webSearch: { type: s.webSearchTool, maxUses: s.maxSearches },
  };

  const count = async (req: CopyRequest): Promise<{ tokens: number; source: CopyEstimate['promptSource'] } | { error: string }> => {
    const chars = req.system.length + JSON.stringify(req.messages).length + JSON.stringify(req.schema).length;
    try {
      const n = await deps.client.countTokens(req);
      if (Number.isSafeInteger(n) && n > 0) return { tokens: n, source: 'count_tokens' };
    } catch (err) {
      const e = classifyError(err);
      if (e.sameForAnyModel) return { error: e.message };
    }
    return { tokens: localPromptTokens(chars, req.webSearch !== null), source: 'local' };
  };

  const call = async (role: CopyAttempt['role'], req: CopyRequest, estimate: CopyEstimate): Promise<CopyResponse | null> => {
    const started = now();
    const base: CopyAttempt = {
      role,
      model,
      effort: req.effort,
      estimate,
      stopReason: null,
      refusalCategory: null,
      usage: null,
      webSearchRequests: 0,
      serverReadings: null,
      costUsd: 0,
      costIsEstimate: false,
      requestId: null,
      durationMs: 0,
      error: null,
    };
    // The caller books the worst case so far before the call goes out, so a restart in the middle
    // of it never leaves a budget counting less than may have been spent.
    opts.onReserve?.(spent() + estimate.worstUsd);
    try {
      const res = await deps.client.call(req);
      attempts.push({
        ...base,
        durationMs: now() - started,
        stopReason: res.stopReason === null ? null : redactSecrets(res.stopReason, 40),
        refusalCategory: res.refusalCategory === null ? null : redactSecrets(res.refusalCategory, 40),
        usage: res.usage,
        webSearchRequests: res.webSearchRequests,
        serverReadings: res.serverReadings,
        costUsd: copyCallCostUsd(s, model, res.usage, res.webSearchRequests),
        requestId: res.requestId === null ? null : redactSecrets(res.requestId, 100),
      });
      searches.push(...res.searches);
      return res;
    } catch (err) {
      const e = classifyError(err);
      attempts.push({
        ...base,
        durationMs: now() - started,
        error: { kind: e.kind, message: e.message },
        requestId: e.requestId,
        costUsd: e.mayHaveBilled ? estimate.worstUsd : 0,
        costIsEstimate: e.mayHaveBilled,
      });
      return null;
    }
  };

  const auditDetails = (review: CardReview | null, reasons: string[]): Record<string, unknown> => ({
    model,
    effort: s.effort,
    webSearchTool: s.webSearchTool,
    capUsd: Math.round(cap * 1e6) / 1e6,
    approvedBy: approved?.approvedBy ?? null,
    totalCostUsd: Math.round(spent() * 1e6) / 1e6,
    attempts: attempts.map((a) => ({
      role: a.role,
      stopReason: a.stopReason,
      inputTokens: a.usage?.inputTokens ?? 0,
      outputTokens: a.usage?.outputTokens ?? 0,
      cacheReadTokens: a.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: a.usage?.cacheWriteTokens ?? 0,
      thinkingTokens: a.usage?.thinkingTokens ?? null,
      webSearchRequests: a.webSearchRequests,
      serverReadings: a.serverReadings,
      costUsd: Math.round(a.costUsd * 1e6) / 1e6,
      costIsEstimate: a.costIsEstimate,
      estimateWorstUsd: Math.round(a.estimate.worstUsd * 1e6) / 1e6,
      requestId: a.requestId,
      durationMs: a.durationMs,
      error: a.error,
    })),
    searches: searches.map((x) => ({ query: redactSecrets(x.query, 200), results: x.results.length, error: x.error })),
    sources: (review?.sources ?? []).map((x) => ({ url: redactSecrets(x.url, 500), title: redactSecrets(x.title, 200) })),
    verifyItems: review?.verify.length ?? 0,
    problems: review?.problems ?? [],
    reasons: reasons.map((r) => redactSecrets(r, 300)),
  });

  const failed = (reasons: string[]): CopyResult => {
    if (attempts.length) appendAudit(deps.db, deps.actor, { action: 'card_generate_failed', entityType: 'variation', entityId: product.variationId, details: { catalog: product.catalog, ...auditDetails(null, reasons) } }, now());
    return result('failed', reasons);
  };
  const lastError = () => `The call to the model failed: ${attempts[attempts.length - 1]!.error!.message}`;
  const overCapText = () => `This card has cost $${spent().toFixed(2)}, more than its $${cap.toFixed(2)} cap. No further call was made.`;

  // 1. Estimate, and fit the call to the cap.
  const counted = await count(first);
  if ('error' in counted) return failed([counted.error]);
  const fit = fitCopyCall(s, model, counted.tokens, counted.source, cap, s.maxSearches, s.maxOutputTokens, s.minOutputTokens);
  if (!fit) {
    const worst = estimateCopy(s, model, counted.tokens, counted.source, s.maxSearches, s.maxOutputTokens).worstUsd;
    return result('needs_approval', [`Writing this card with ${model} could cost up to $${worst.toFixed(2)}, more than the $${cap.toFixed(2)} allowed. An admin must approve that amount first.`], null, {
      model,
      worstUsd: worst,
      capUsd: cap,
      spentUsd: 0,
    });
  }

  // 2. The writing call. A paused call is continued only while it has a search left, fitted on a
  // real token count of the continuation, and never past the cap.
  const req: CopyRequest = { ...first, maxTokens: fit.maxOutputTokens, webSearch: { type: s.webSearchTool, maxUses: fit.searches } };
  let res = await call('write', req, fit);
  if (!res) return failed([lastError()]);
  let messages = req.messages;
  let continuations = 0;
  while (res.stop === 'pause_turn' && res.paused && continuations < s.maxContinuations) {
    if (overCap()) return failed([overCapText()]);
    const searchesLeft = fit.searches - searches.length;
    if (searchesLeft < 1) break;
    messages = [...messages, { role: 'assistant', content: res.paused }];
    const next: CopyRequest = { ...req, messages, webSearch: { type: s.webSearchTool, maxUses: searchesLeft } };
    const c = await count(next);
    if ('error' in c || c.source !== 'count_tokens') break;
    const cFit = fitCopyCall(s, model, c.tokens, 'count_tokens', cap - spent(), searchesLeft, req.maxTokens, s.minOutputTokens);
    if (!cFit) break;
    res = await call('continue', { ...next, maxTokens: cFit.maxOutputTokens, webSearch: { type: s.webSearchTool, maxUses: cFit.searches } }, cFit);
    if (!res) return failed([lastError()]);
    continuations++;
  }
  if (res.stop !== 'end_turn') return failed([stopReasonText(res)]);

  // 3. Parse and check.
  const parsed = parseAnswer<ModelAnswer>(res.text, schema);
  if (!parsed.ok) return failed(['The answer did not match the card format.', ...parsed.problems]);
  const answer = parsed.value;
  let { content, newCategory } = cardFromModel(answer.card, cfg, product);
  let claims = answer.claims;
  let modelVerify = answer.verify;

  const renderProblems = async (c: CardContent): Promise<CheckProblem[]> => {
    if (!deps.renderCheck) return [];
    try {
      const r = await deps.renderCheck(c, product);
      if (!r) return [];
      const out: CheckProblem[] = [];
      if (r.copyLines > r.maxCopyLines) {
        out.push({ field: 'render', message: `Printed, the copy takes ${r.copyLines} lines and the panel holds ${r.maxCopyLines}. Cut about ${(r.copyLines - r.maxCopyLines) * CHARS_PER_LINE} characters.` });
      }
      if (r.clipped) out.push({ field: 'render', message: 'Printed, the end of the copy is cut off. Shorten it.' });
      return out;
    } catch (err) {
      // A check that cannot run never blocks the card, but it is said, since the printed line
      // count is then unknown. The card is checked again when the sheet is built (step 8).
      notes.push(redactSecrets(`The rendered check could not run: ${err instanceof Error ? err.message : 'unknown error'}`, 300));
      return [];
    }
  };
  const allProblems = async (c: CardContent): Promise<CheckProblem[]> => {
    const own = checkContent(c, cfg.limits, { flagPhrases: cfg.guide.flagPhrases, soldByWeight: product.soldByWeight });
    // Rendering is slow, so it runs only on a card that already passes the code checks.
    return own.length ? own : renderProblems(c);
  };
  let problems = await allProblems(content);
  const reasons: string[] = [];

  // 4. One retry, with no search tool, when the card is out of limits.
  if (problems.length && overCap()) reasons.push(overCapText());
  else if (problems.length) {
    const rSchema = retrySchema(cfg);
    const pages = [...new Set(searches.flatMap((x) => x.results.map((r) => r.url)))];
    const retry: CopyRequest = {
      model,
      effort: s.effort,
      maxTokens: s.retryMaxOutputTokens,
      system: systemPrompt(cfg, { research: false, maxSearches: 0 }),
      messages: [{ role: 'user', content: retryContent(asModelCard(content, cfg), problems, answer.claims, pages) }],
      schema: rSchema,
      webSearch: null,
    };
    const rc = await count(retry);
    const rFit = 'error' in rc ? null : fitCopyCall(s, model, rc.tokens, rc.source, cap - spent(), 0, s.retryMaxOutputTokens, Math.min(1000, s.retryMaxOutputTokens));
    if (!rFit) reasons.push('The card is out of limits, and the retry was not sent: it would pass the cost cap.');
    else {
      const r2 = await call('shorten', { ...retry, maxTokens: rFit.maxOutputTokens }, rFit);
      const p2 = r2 && r2.stop === 'end_turn' ? parseAnswer<RetryAnswer>(r2.text, rSchema) : null;
      if (p2?.ok) {
        const next = cardFromModel(p2.value.card, cfg, product);
        const nextProblems = await allProblems(next.content);
        if (nextProblems.length <= problems.length) {
          content = next.content;
          newCategory = next.newCategory;
          problems = nextProblems;
          claims = p2.value.claims;
          modelVerify = p2.value.verify;
        } else {
          notes.push(redactSecrets(`The retry came back with more problems, so the first card is kept: ${nextProblems.map((p) => p.message).join(' ')}`, 600));
        }
      } else reasons.push('The retry gave no usable card, so the first one is kept.');
      if (overCap()) reasons.push(overCapText());
    }
  }

  // 5. The verify list, then store. Guard findings left now block the card until a person edits them out.
  const blocked = problems.filter((p) => p.field === 'guard').map((p) => p.message);
  const review = buildReview({ research: answer, claims, modelVerify, searches, content, product, invoice, problems, newCategory });
  const cardReview: CardReview = {
    verify: review.verify,
    sources: review.sources,
    searches: searches.map((x) => ({ query: x.query, results: x.results.length, error: x.error })),
    problems: problems.map((p) => p.message),
    uniqueSellingPoint: cleanText(answer.unique_selling_point).slice(0, 300),
    productIdentified: answer.product_identified,
    model: res.model || model,
    costUsd: Math.round(spent() * 1e6) / 1e6,
    generatedAt: new Date(now()).toISOString(),
  };
  if (problems.length) reasons.push(...problems.map((p) => p.message));
  if (blocked.length) reasons.push('The card is stored blocked: it cannot print until a person edits out the price, phone number or web address.');
  if (newCategory) reasons.push(`The category ${newCategory} is not in the card config, so the card cannot print until it is added or another is picked.`);
  if (!answer.product_identified) reasons.push('The model could not find this exact product on the web.');
  try {
    checkContentShape(content);
  } catch (err) {
    return failed([`The card cannot be stored: ${err instanceof CopyError ? err.message : 'its text has the wrong shape'}`]);
  }
  let card: StoredCard;
  try {
    card = insertGeneratedCard(deps.db, deps.actor, { product, content, review: cardReview, blocked, auditDetails: auditDetails(cardReview, reasons) }, now());
  } catch (err) {
    if (err instanceof CopyError) return failed([err.message]);
    throw err;
  }
  return result(reasons.length ? 'review' : 'written', reasons, card);
}

export interface BatchItem {
  product: ProductFacts;
  invoice: InvoiceFacts | null;
}

/**
 * Writes copy for several products, one at a time, under one total. A product whose call would
 * not fit what is left of the total is not sent and comes back needs_approval.
 */
export async function generateCopyBatch(deps: CopyDeps, items: readonly BatchItem[], opts: { totalCapUsd: number }): Promise<{ results: CopyResult[]; spentUsd: number }> {
  const results: CopyResult[] = [];
  let spentUsd = 0;
  for (const item of items) {
    const r = await generateCopy(deps, item.product, item.invoice, { budgetUsd: Math.max(0, opts.totalCapUsd - spentUsd) });
    spentUsd += r.costUsd;
    results.push(r);
  }
  return { results, spentUsd };
}
