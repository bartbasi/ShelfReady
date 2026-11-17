// Cost of writing card copy, before and after each call.
//
// A writing call searches the web on the server. Each search adds its results to the input, and
// the server reads the whole conversation again after each step, so input grows with every
// reading. The worst case counts settings.serverLoopLimit readings, not one per search: a search
// attempted past max_uses fails, but the reading after it is still billed. Search results cannot
// be sized before the call, so each search counts at the largest size set for the tool version:
// the worst case is an estimate, not a bound. The cap is checked against it, the output limit
// (max_tokens) and the number of searches (max_uses) are cut so it fits, actual spend is booked
// from the usage the API reports, and spend is checked against the cap after every call.

import type { TokenUsage } from '../invoice/cost.ts';
import { copyPriceOf, searchTokensFor, type CopySettings } from './settings.ts';

export interface CopyEstimate {
  model: string;
  promptTokens: number;
  promptSource: 'count_tokens' | 'local';
  /** Searches allowed in the call (max_uses). 0 for a call with no search tool. */
  searches: number;
  maxOutputTokens: number;
  /** Typical cost in US dollars. */
  usd: number;
  /** Cost with the most readings, every search at its largest and every output token used. */
  worstUsd: number;
}

function price(s: CopySettings, model: string) {
  const p = copyPriceOf(s, model);
  if (!p) throw new Error(`No price is set for ${model}. Set a price for this model in settings before it can be used.`);
  return { input: p.inputPerMTok / 1_000_000, output: p.outputPerMTok / 1_000_000 };
}

/**
 * Input tokens over the readings of one call: each reading carries the prompt, the results of
 * the searches made so far (at most `searches`), and the output written before it.
 */
function inputTokens(prompt: number, searches: number, perSearch: number, readings: number, rereadOutput: number): number {
  let total = 0;
  for (let k = 0; k < readings; k++) total += prompt + Math.min(k, searches) * perSearch;
  return total + rereadOutput * Math.max(0, readings - 1);
}

/** How many times the conversation can be read in one call. With no search tool, once. */
function readingsFor(s: CopySettings, searches: number): number {
  return searches > 0 ? s.serverLoopLimit : 1;
}

export function estimateCopy(s: CopySettings, model: string, promptTokens: number, promptSource: CopyEstimate['promptSource'], searches: number, maxOutputTokens: number): CopyEstimate {
  const p = price(s, model);
  const sizes = searchTokensFor(s);
  const typicalSearches = Math.min(searches, 2);
  const typicalOut = Math.min(maxOutputTokens, s.typicalOutputTokens);
  const usd = inputTokens(promptTokens, typicalSearches, sizes.typical, typicalSearches + 1, 0) * p.input + typicalOut * p.output + typicalSearches * s.usdPerSearch;
  const worstUsd = inputTokens(promptTokens, searches, sizes.worst, readingsFor(s, searches), maxOutputTokens) * p.input + maxOutputTokens * p.output + searches * s.usdPerSearch;
  return { model, promptTokens, promptSource, searches, maxOutputTokens, usd, worstUsd };
}

/**
 * The largest call that fits the budget. Room to answer matters more than searches (real cards
 * used one or two), so first the most searches that still leave the full output wanted, then,
 * if none does, the most searches that leave at least minOutput. Null when nothing fits.
 * searchesWanted 0 means a call with no search tool.
 */
export function fitCopyCall(
  s: CopySettings,
  model: string,
  promptTokens: number,
  promptSource: CopyEstimate['promptSource'],
  budgetUsd: number,
  searchesWanted: number,
  outputWanted: number,
  minOutput: number,
): CopyEstimate | null {
  const p = price(s, model);
  const sizes = searchTokensFor(s);
  const roomFor = (k: number): number => {
    const readings = readingsFor(s, k);
    const fixed = inputTokens(promptTokens, k, sizes.worst, readings, 0) * p.input + k * s.usdPerSearch;
    // Each output token is paid once as output and again as input at every later reading.
    const perOutputToken = (readings - 1) * p.input + p.output;
    const room = Math.floor((budgetUsd - fixed) / perOutputToken);
    return Number.isFinite(room) ? room : -1;
  };
  const lowest = searchesWanted > 0 ? 1 : 0;
  for (const need of [outputWanted, minOutput]) {
    for (let k = searchesWanted; k >= lowest; k--) {
      const room = roomFor(k);
      if (room >= need) return estimateCopy(s, model, promptTokens, promptSource, k, Math.min(outputWanted, room));
    }
  }
  return null;
}

/** Cost of a finished call: tokens, with cache writes at 1.25x input and reads at 0.1x, plus searches. */
export function copyCallCostUsd(s: CopySettings, model: string, u: TokenUsage, webSearchRequests: number): number {
  const p = price(s, model);
  const n = (x: number) => (Number.isFinite(x) && x > 0 ? x : 0);
  const input = n(u.inputTokens) * p.input + n(u.cacheWriteTokens) * p.input * 1.25 + n(u.cacheReadTokens) * p.input * 0.1;
  return input + n(u.outputTokens) * p.output + n(webSearchRequests) * s.usdPerSearch;
}

/** A count of prompt tokens when the counting endpoint cannot be reached. Errs high. */
export function localPromptTokens(promptChars: number, withSearchTool: boolean): number {
  return Math.ceil(promptChars / 3) + (withSearchTool ? 3000 : 0) + 500;
}
