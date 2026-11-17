// Cost of reading an invoice, before and after the call. Prices come from settings.
//
// The cap is hard. Each call's output limit (max_tokens) is set so that its worst case, every
// input token plus every allowed output token, fits in what is left of the cap. The typical
// estimate is shown to people; the worst case is what the cap is checked against.

import { priceOf, type InvoiceReadingSettings, type ModelPrice } from './settings.ts';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Part of outputTokens spent thinking, when the API reports it. */
  thinkingTokens: number | null;
}

export interface CostEstimate {
  model: string;
  inputTokens: number;
  /** Where the input count came from: the token counting endpoint, or a local count for photos. */
  inputSource: 'count_tokens' | 'local';
  /** Output tokens a reading usually needs. */
  outputTokensEstimate: number;
  /** The output limit the call is sent with. */
  maxOutputTokens: number;
  /** Typical cost in US dollars. */
  usd: number;
  /** Most the call can cost, in US dollars: every input token and every allowed output token. */
  worstUsd: number;
}

export function priceFor(settings: InvoiceReadingSettings, model: string): ModelPrice {
  const p = priceOf(settings, model);
  if (!p) throw new Error(`No price is set for ${model}. Set a price for this model in settings before it can be used.`);
  return p;
}

/** Cost of a finished call. Cache writes bill at 1.25x input and reads at 0.1x. */
export function usageCostUsd(settings: InvoiceReadingSettings, model: string, u: TokenUsage): number {
  const p = priceFor(settings, model);
  const n = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
  const input = n(u.inputTokens) * p.inputPerMTok + n(u.cacheWriteTokens) * p.inputPerMTok * 1.25 + n(u.cacheReadTokens) * p.inputPerMTok * 0.1;
  return (input + n(u.outputTokens) * p.outputPerMTok) / 1_000_000;
}

/** Output tokens a reading of this many pages usually needs. */
export function outputEstimate(settings: InvoiceReadingSettings, model: string, pages: number): number {
  const perPage = settings.outputTokensPerPage[model] ?? settings.defaultOutputTokensPerPage;
  return Math.min(settings.maxOutputTokens, perPage * Math.max(1, pages));
}

export function estimateCost(
  settings: InvoiceReadingSettings,
  model: string,
  inputTokens: number,
  inputSource: CostEstimate['inputSource'],
  pages: number,
  maxOutputTokens: number,
): CostEstimate {
  const p = priceFor(settings, model);
  const outputTokensEstimate = Math.min(maxOutputTokens, outputEstimate(settings, model, pages));
  const inputUsd = (inputTokens * p.inputPerMTok) / 1_000_000;
  return {
    model,
    inputTokens,
    inputSource,
    outputTokensEstimate,
    maxOutputTokens,
    usd: inputUsd + (outputTokensEstimate * p.outputPerMTok) / 1_000_000,
    worstUsd: inputUsd + (maxOutputTokens * p.outputPerMTok) / 1_000_000,
  };
}

/** True when every money figure in an estimate is a usable, non-negative number. */
export function estimateIsUsable(e: CostEstimate): boolean {
  const ok = (n: number) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return ok(e.usd) && ok(e.worstUsd) && Number.isSafeInteger(e.inputTokens) && e.inputTokens >= 0 && Number.isSafeInteger(e.maxOutputTokens) && e.maxOutputTokens > 0;
}

/**
 * Output tokens that fit in what is left of the cap after the input, rounded down.
 * Zero or less means the call cannot fit.
 */
export function affordableOutputTokens(settings: InvoiceReadingSettings, model: string, inputTokens: number, budgetLeftUsd: number): number {
  const p = priceFor(settings, model);
  const leftAfterInput = budgetLeftUsd - (inputTokens * p.inputPerMTok) / 1_000_000;
  const n = Math.floor((leftAfterInput * 1_000_000) / p.outputPerMTok);
  return Number.isFinite(n) ? n : 0;
}

/** A count of input tokens for photos when the token counting endpoint cannot be reached. Errs high. */
export function localInputTokens(images: Array<{ width: number; height: number }>, promptChars: number): number {
  const imageTokens = images.reduce((sum, i) => sum + Math.ceil((i.width * i.height) / 750), 0);
  return imageTokens + Math.ceil(promptChars / 3) + 2000;
}

export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}
