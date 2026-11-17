// Small synthetic invoices for the invoice reading tests. Invented values, never store data,
// and never the real test invoices: automated tests must not read test-invoices/.

import sharp from 'sharp';
import type { InvoiceModelClient, ModelRequest, ModelResponse } from '../src/invoice/extract.ts';
import type { ModelImage, ModelInvoice, ModelLine } from '../src/invoice/types.ts';

export function line(fields: Partial<ModelLine> = {}): ModelLine {
  return {
    image_index: 1,
    line_ref: '',
    category_header: '',
    item_number: 'A100',
    upc: '',
    description: 'TEST CHEESE WHEEL',
    brand: '',
    pack_size: '',
    units_per_pack: '',
    origin: '',
    qty_ordered: '',
    qty_shipped: '2',
    unit: 'EA',
    weight: '',
    unit_price: '10.00',
    price_unit: '',
    allowance: '',
    extension: '20.00',
    printed_status: 'shipped',
    annotations: [],
    confidence: 'high',
    confidence_note: '',
    ...fields,
  };
}

export function image(fields: Partial<ModelImage> = {}): ModelImage {
  return {
    image_index: 1,
    invoice_number: 'INV-1',
    page_number: '1',
    page_count: '',
    continued_marker: false,
    has_totals: true,
    same_page_as_image: 0,
    readability: 'good',
    notes: '',
    ...fields,
  };
}

export function invoice(fields: Partial<ModelInvoice> = {}): ModelInvoice {
  return {
    supplier_name: 'Test Supplier',
    invoice_number: 'INV-1',
    invoice_date: '11/01/26',
    invoice_date_iso: '2026-11-01',
    images: [image()],
    lines: [line()],
    charges: [],
    subtotal: '',
    tax: '',
    total: '20.00',
    previous_balance: '',
    printed_total_quantity: '',
    invoice_annotations: [],
    overall_confidence: 'high',
    problems: [],
    ...fields,
  };
}

export const TODAY = new Date('2026-11-06T12:00:00Z');

/** A plain test picture: white with a dark bar placed by seed, so different seeds differ. */
export async function testImage(seed: number, width = 300, height = 400): Promise<Buffer> {
  const bar = await sharp({ create: { width: Math.floor(width / 2), height: 30, channels: 3, background: { r: 20, g: 20, b: 20 } } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: 250, g: 250, b: 245 } } })
    .composite([{ input: bar, left: (seed * 37) % Math.floor(width / 2), top: (seed * 53) % (height - 30) }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** A fake key built at run time, so no key-like text sits in the source. */
export function fakeKey(): string {
  return ['sk', 'ant', 'api03', 'Z'.repeat(40)].join('-');
}

export interface FakeCall {
  model: string;
  maxTokens: number;
  imageCount: number;
  hasDocument: boolean;
}

/**
 * A stand-in for the Claude API. answers maps a model id to the responses it gives, in order.
 * A response may be an Error to throw. Records every call.
 */
export function fakeClient(
  answers: Record<string, Array<(Partial<ModelResponse> & { json?: unknown }) | Error>>,
  opts: { inputTokens?: number; countError?: Error } = {},
): InvoiceModelClient & { calls: FakeCall[]; counts: number } {
  const queues = new Map(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  const fake = {
    calls: [] as FakeCall[],
    counts: 0,
    async countTokens(_req: ModelRequest): Promise<number> {
      fake.counts++;
      if (opts.countError) throw opts.countError;
      return opts.inputTokens ?? 10_000;
    },
    async call(req: ModelRequest): Promise<ModelResponse> {
      fake.calls.push({
        model: req.model,
        maxTokens: req.maxTokens,
        imageCount: req.content.filter((b) => b.type === 'image').length,
        hasDocument: req.content.some((b) => b.type === 'document'),
      });
      const next = queues.get(req.model)?.shift();
      if (!next) throw new Error(`fake client: no answer queued for ${req.model}`);
      if (next instanceof Error) throw next;
      const { json, ...rest } = next;
      return {
        stop: 'end_turn',
        stopReason: 'end_turn',
        refusalCategory: null,
        text: json === undefined ? null : JSON.stringify(json),
        usage: { inputTokens: 10_000, outputTokens: 3_000, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 500 },
        requestId: 'req_test',
        model: req.model,
        ...rest,
      };
    },
  };
  return fake;
}
