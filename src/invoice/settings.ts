// Settings for invoice reading, with defaults. The settings screen (src/settings, built by the
// backend) stores the admin's choices; invoiceSettingsFrom() maps them in and
// buildInvoiceSettings() fills in anything missing. Nothing store-specific lives here.

import { parseDecimal } from './money.ts';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelPrice {
  /** US dollars per million input tokens. */
  inputPerMTok: number;
  /** US dollars per million output tokens, thinking included. */
  outputPerMTok: number;
}

export interface SaneRanges {
  maxLines: number;
  maxQuantity: number;
  maxWeightLb: number;
  maxUnitPrice: number;
  maxLineAmount: number;
  maxTotal: number;
  /** An invoice dated more than this many days ago is flagged. */
  maxInvoiceAgeDays: number;
  /** An invoice dated more than this many days ahead is flagged. */
  maxFutureDays: number;
  /** Catch-weight lines ship whole pieces: at most this many on one line. */
  maxPiecesPerWeightLine: number;
  /** Weight of one piece on a catch-weight line, in pounds. */
  minLbPerPiece: number;
  maxLbPerPiece: number;
  /** How far a piece may weigh from the printed size (for example "6 LB"), as a fraction. */
  nominalWeightTolerance: number;
}

/** Limits on what may be uploaded, checked before anything is decoded. */
export interface UploadLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxPdfPages: number;
}

export interface ImageSettings {
  /** Longest side sent to the model, in pixels. */
  maxLongEdge: number;
  /** Most pixels sent per image. */
  maxPixels: number;
  jpegQuality: number;
  /** Two uploads whose thumbnails differ by at most this many grey levels are the same picture. */
  sameImageMaxDiff: number;
  /** Largest picture decoded at all, in pixels, so a crafted file cannot exhaust memory. */
  maxInputPixels: number;
}

export interface InvoiceReadingSettings {
  firstPassModel: string;
  fallbackModel: string;
  /** Effort per model id. A model not listed uses defaultEffort. */
  effort: Record<string, Effort>;
  defaultEffort: Effort;
  /** Most room for thinking plus the JSON answer in one call. Each call gets less if the cost cap needs it. */
  maxOutputTokens: number;
  /** Price per model id. A model with no price cannot be estimated, so it is never called. */
  prices: Record<string, ModelPrice>;
  /**
   * Most one invoice may cost to read, first pass and fallback together, in US dollars. It is a
   * hard limit: each call's output is capped so the worst case fits what is left, and a call that
   * cannot fit stops and asks an admin first.
   */
  costCapUsd: number;
  /** Output tokens a page usually needs, thinking included. A call is not sent with less room than this. */
  outputTokensPerPage: Record<string, number>;
  defaultOutputTokensPerPage: number;
  image: ImageSettings;
  upload: UploadLimits;
  ranges: SaneRanges;
  /** Allowed gap between qty x price and the printed line amount, in cents. */
  lineToleranceCents: number;
  /** Allowed gap between the sum and the printed total, in cents. */
  totalToleranceCents: number;
  /** A printed UPC that fails its check digit sends the invoice to the fallback model. */
  upcCheckDigitsBlocking: boolean;
}

export const DEFAULT_INVOICE_SETTINGS: InvoiceReadingSettings = {
  firstPassModel: 'claude-sonnet-5-5',
  fallbackModel: 'claude-opus-5-5',
  // Measured on the five real test invoices, November 6, 2026, with scripts/invoice/run-test-invoices.ts:
  // at low effort Sonnet read every line, amount and check right (one faded letter in one
  // description), twice in a row, and Opus read everything right. Low is the cheapest setting
  // that gets them right, so it is the default for both.
  effort: { 'claude-sonnet-5-5': 'low', 'claude-opus-5-5': 'low' },
  defaultEffort: 'medium',
  maxOutputTokens: 48000,
  prices: {
    'claude-sonnet-5-5': { inputPerMTok: 2, outputPerMTok: 10 },
    'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 },
  },
  costCapUsd: 1,
  // Measured at low effort: about 220 output tokens per invoice line, 2,800 to 5,400 per invoice.
  // A full page of 25 lines is about 5,500, so 6,000 per page errs high.
  outputTokensPerPage: { 'claude-sonnet-5-5': 6000, 'claude-opus-5-5': 6000 },
  defaultOutputTokensPerPage: 8000,
  // Measured November 6, 2026 with scripts/invoice/measure-images.ts: both models accept up to
  // about 3.67 megapixels (1659x2212 for a portrait page, 4,752 tokens) and refuse anything larger
  // when oversized_image is "error". Stay just under that.
  image: { maxLongEdge: 2576, maxPixels: 3_660_000, jpegQuality: 90, sameImageMaxDiff: 3, maxInputPixels: 100_000_000 },
  upload: { maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, maxPdfPages: 20 },
  ranges: {
    maxLines: 200,
    maxQuantity: 1000,
    maxWeightLb: 500,
    maxUnitPrice: 2000,
    maxLineAmount: 10000,
    maxTotal: 100000,
    maxInvoiceAgeDays: 400,
    maxFutureDays: 7,
    maxPiecesPerWeightLine: 100,
    minLbPerPiece: 0.05,
    maxLbPerPiece: 100,
    nominalWeightTolerance: 0.35,
  },
  lineToleranceCents: 1,
  totalToleranceCents: 1,
  upcCheckDigitsBlocking: true,
};

/** Fills in defaults for anything the stored settings leave out. */
export function buildInvoiceSettings(partial: Partial<InvoiceReadingSettings> = {}): InvoiceReadingSettings {
  const d = DEFAULT_INVOICE_SETTINGS;
  return {
    ...d,
    ...partial,
    effort: { ...d.effort, ...partial.effort },
    prices: { ...d.prices, ...partial.prices },
    outputTokensPerPage: { ...d.outputTokensPerPage, ...partial.outputTokensPerPage },
    image: { ...d.image, ...partial.image },
    upload: { ...d.upload, ...partial.upload },
    ranges: { ...d.ranges, ...partial.ranges },
  };
}

export function effortFor(settings: InvoiceReadingSettings, model: string): Effort {
  return settings.effort[model] ?? settings.defaultEffort;
}

/** The price for a model, or null when none is set or it is not a usable number. */
export function priceOf(settings: InvoiceReadingSettings, model: string): ModelPrice | null {
  const p = settings.prices[model];
  if (!p) return null;
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return ok(p.inputPerMTok) && ok(p.outputPerMTok) ? p : null;
}

/** The app settings fields that invoice reading uses, as src/settings names them. */
export interface AppInvoiceFields {
  anthropicFirstPassModel?: string;
  anthropicFallbackModel?: string;
  /** US dollars, decimal text, for example "1.00". */
  invoiceCostCapUsd?: string;
}

/** Maps the admin's saved settings onto the invoice reading settings. */
export function invoiceSettingsFrom(app: AppInvoiceFields, extra: Partial<InvoiceReadingSettings> = {}): InvoiceReadingSettings {
  const partial: Partial<InvoiceReadingSettings> = { ...extra };
  if (app.anthropicFirstPassModel) partial.firstPassModel = app.anthropicFirstPassModel;
  if (app.anthropicFallbackModel) partial.fallbackModel = app.anthropicFallbackModel;
  const cap = parseDecimal(app.invoiceCostCapUsd ?? '');
  if (cap !== null && cap.units >= 0) partial.costCapUsd = cap.units / 10 ** cap.scale;
  return buildInvoiceSettings(partial);
}
