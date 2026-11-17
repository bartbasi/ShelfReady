// Settings for writing card copy, with defaults. Nothing store-specific lives here.
//
// The model defaults to the invoice first-pass model and the cost cap to the invoice cost cap,
// both from the admin's saved settings (copySettingsFrom). Prices are the invoice price table.
//
// The web search tool version is a setting because Anthropic ships new versions. What was
// measured, on November 7, 2026, with one product question and one search each, on Sonnet 5.5:
// web_search_20250305 used 12,700 input tokens; web_search_20260318, which runs the search
// through code execution, used 33,000 for the same answer. web_search_20260209 was only token
// counted (its tool definition adds about 3,100 prompt tokens), never called. One product is a
// small sample: re-measure at 2 and 3 searches (store/docs/FOLLOWUPS.md). The cost estimate needs the
// size of one search's results for the version in use, so only the measured version has one;
// another version cannot be used until its sizes are measured and set.

import { parseDecimal } from '../invoice/money.ts';
import { DEFAULT_INVOICE_SETTINGS, type Effort, type ModelPrice } from '../invoice/settings.ts';

export const WEB_SEARCH_TOOL_TYPES = ['web_search_20250305', 'web_search_20260209', 'web_search_20260318'] as const;
export type WebSearchToolType = (typeof WEB_SEARCH_TOOL_TYPES)[number];

/** Input tokens one search adds: usually, and at most as far as is known. */
export interface SearchTokens {
  typical: number;
  worst: number;
}

export interface CopySettings {
  model: string;
  effort: Effort;
  /** Most room for thinking plus the answer in the writing call. Less is sent if the cap needs it. */
  maxOutputTokens: number;
  /** A writing call is not sent with less room than this. */
  minOutputTokens: number;
  /** Room for the one shortening retry, which only rewrites the card. */
  retryMaxOutputTokens: number;
  webSearchTool: WebSearchToolType;
  /** Most searches in one writing call (the tool's max_uses). */
  maxSearches: number;
  /** US dollars per search, billed on top of tokens. */
  usdPerSearch: number;
  /** The size of one search's results, per tool version. The version in use must have one. */
  searchTokens: Partial<Record<WebSearchToolType, SearchTokens>>;
  /**
   * Most times the server reads the conversation in one call before it pauses (pause_turn). A
   * search attempted past max_uses fails but still costs a reading, so the worst case counts
   * this many readings, not one per search.
   */
  serverLoopLimit: number;
  /** Output tokens a writing call usually needs. */
  typicalOutputTokens: number;
  /** Price per model id. A model with no price is never called. */
  prices: Record<string, ModelPrice>;
  /** Most one product's copy may cost, the retry included, in US dollars, unless an admin approves more. */
  costCapUsd: number;
  /** Times a paused call is continued before it goes to review. Each needs a search left and must fit the cap. */
  maxContinuations: number;
  /** Stored cards shown to the model as examples of the store's voice. */
  voiceExamples: number;
}

export const DEFAULT_COPY_SETTINGS: CopySettings = {
  model: DEFAULT_INVOICE_SETTINGS.firstPassModel,
  effort: 'medium',
  maxOutputTokens: 8000,
  minOutputTokens: 3000,
  retryMaxOutputTokens: 3000,
  webSearchTool: 'web_search_20250305',
  maxSearches: 3,
  usdPerSearch: 0.01,
  // Measured November 7, 2026: one search of 9 results added about 10,000 input tokens.
  searchTokens: { web_search_20250305: { typical: 10_000, worst: 16_000 } },
  // The server's default loop limit for server tools as remembered from the API documentation.
  // The bundled docs were missing, so it is unconfirmed (store/docs/FOLLOWUPS.md).
  serverLoopLimit: 10,
  typicalOutputTokens: 3000,
  prices: { ...DEFAULT_INVOICE_SETTINGS.prices },
  costCapUsd: DEFAULT_INVOICE_SETTINGS.costCapUsd,
  maxContinuations: 1,
  voiceExamples: 3,
};

export function isWebSearchToolType(v: unknown): v is WebSearchToolType {
  return typeof v === 'string' && (WEB_SEARCH_TOOL_TYPES as readonly string[]).includes(v);
}

/** The search size for the version in use. buildCopySettings has checked it exists. */
export function searchTokensFor(s: CopySettings): SearchTokens {
  const t = s.searchTokens[s.webSearchTool];
  if (!t) throw new Error(`No search size is set for ${s.webSearchTool}.`);
  return t;
}

/** Fills in defaults and refuses values that cannot work. */
export function buildCopySettings(partial: Partial<CopySettings> = {}): CopySettings {
  const d = DEFAULT_COPY_SETTINGS;
  const s: CopySettings = {
    ...d,
    ...partial,
    searchTokens: { ...d.searchTokens, ...partial.searchTokens },
    prices: { ...d.prices, ...partial.prices },
  };
  if (!isWebSearchToolType(s.webSearchTool)) throw new Error(`The web search tool must be one of ${WEB_SEARCH_TOOL_TYPES.join(', ')}.`);
  const whole = (n: number, min: number) => Number.isSafeInteger(n) && n >= min;
  const t = s.searchTokens[s.webSearchTool];
  if (!t) throw new Error(`No search size is set for ${s.webSearchTool}. Measure one search with it and set searchTokens before using it.`);
  if (!whole(t.typical, 1) || !whole(t.worst, 1) || t.typical > t.worst) throw new Error(`The search size for ${s.webSearchTool} must be whole numbers, typical no more than worst.`);
  if (!whole(s.maxSearches, 1) || s.maxSearches > 10) throw new Error('Searches per card must be 1 to 10.');
  if (!whole(s.serverLoopLimit, s.maxSearches + 1) || s.serverLoopLimit > 100) throw new Error('The server loop limit must be more than the searches per card, and at most 100.');
  if (!whole(s.maxOutputTokens, 1) || !whole(s.minOutputTokens, 1) || !whole(s.retryMaxOutputTokens, 1) || s.minOutputTokens > s.maxOutputTokens) {
    throw new Error('The output token limits for card copy are not usable.');
  }
  if (!whole(s.maxContinuations, 0) || !whole(s.voiceExamples, 0)) throw new Error('Continuations and voice examples must be whole numbers.');
  const money = (n: number) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!money(s.costCapUsd) || !money(s.usdPerSearch)) throw new Error('The card copy cost settings are not usable.');
  return s;
}

/** The app settings fields that card copy uses, as src/settings names them. */
export interface AppCopyFields {
  anthropicFirstPassModel?: string;
  /** US dollars, decimal text, for example "1.00". */
  invoiceCostCapUsd?: string;
}

/** Maps the admin's saved settings onto the copy settings. */
export function copySettingsFrom(app: AppCopyFields, extra: Partial<CopySettings> = {}): CopySettings {
  const partial: Partial<CopySettings> = { ...extra };
  if (app.anthropicFirstPassModel && extra.model === undefined) partial.model = app.anthropicFirstPassModel;
  const cap = parseDecimal(app.invoiceCostCapUsd ?? '');
  if (cap !== null && cap.units >= 0 && extra.costCapUsd === undefined) partial.costCapUsd = cap.units / 10 ** cap.scale;
  return buildCopySettings(partial);
}

/** The price for a model, or null when none is set or it is not a usable number. */
export function copyPriceOf(s: CopySettings, model: string): ModelPrice | null {
  const p = s.prices[model];
  if (!p) return null;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return ok(p.inputPerMTok) && ok(p.outputPerMTok) ? p : null;
}
