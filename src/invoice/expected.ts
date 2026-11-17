// Ground truth for the real test invoices, transcribed by hand from the photos and kept in
// test-invoices/expected/ (store data, never committed). validateExpected() runs the same code
// checks on a transcription, so a typo in the ground truth fails loudly instead of quietly
// marking a correct reading wrong.

import { checkReading } from './checks.ts';
import { DEFAULT_INVOICE_SETTINGS, type InvoiceReadingSettings } from './settings.ts';
import type { AnnotationKind, AnnotationMeaning, ChargeKind, CheckedReading, ModelInvoice, PrintedStatus, Received } from './types.ts';

export interface ExpectedAnnotation {
  kind: AnnotationKind;
  text: string;
  meaning: AnnotationMeaning;
}

export interface ExpectedLine {
  /** Image number within this invoice's images list, 1-based. */
  image: number;
  lineRef: string;
  categoryHeader: string;
  itemNumber: string;
  upc: string;
  /** The first description line as printed. */
  description: string;
  /** Continuation lines, joined with " | ". */
  descriptionMore: string;
  brand: string;
  packSize: string;
  unitsPerPack: string;
  origin: string;
  qtyShipped: string;
  unit: string;
  weight: string;
  unitPrice: string;
  priceUnit: string;
  allowance: string;
  extension: string;
  printedStatus: PrintedStatus;
  received: Received;
  annotations: ExpectedAnnotation[];
}

export interface ExpectedPage {
  image: number;
  /** The invoice number printed on this page, exactly as printed. Empty when the page shows none. */
  invoiceNumber: string;
  pageNumber: string;
  pageCount: string;
  /** 0, or the earlier image this one repeats. */
  samePageAs: number;
  continued: boolean;
  hasTotals: boolean;
}

export interface ExpectedCharge {
  image: number;
  description: string;
  amount: string;
  kind: ChargeKind;
}

export interface ExpectedInvoice {
  name: string;
  supplier: string;
  /** File names in test-invoices/, in upload order. */
  images: string[];
  invoiceNumber: string;
  invoiceDatePrinted: string;
  /** YYYY-MM-DD */
  invoiceDate: string;
  pages: ExpectedPage[];
  lines: ExpectedLine[];
  charges: ExpectedCharge[];
  subtotal: string;
  tax: string;
  total: string;
  previousBalance: string;
  printedTotalQuantity: string;
  invoiceAnnotations: ExpectedAnnotation[];
  /** Anything that could not be read with certainty, in plain words. */
  uncertain: string[];
  notes: string[];
}

/** The ground truth in the model's answer shape, so the same checks can run on it. */
export function expectedAsModelInvoice(e: ExpectedInvoice): ModelInvoice {
  return {
    supplier_name: e.supplier,
    invoice_number: e.invoiceNumber,
    invoice_date: e.invoiceDatePrinted,
    invoice_date_iso: e.invoiceDate,
    images: e.pages.map((p) => ({
      image_index: p.image,
      invoice_number: typeof p.invoiceNumber === 'string' ? p.invoiceNumber : '',
      page_number: p.pageNumber,
      page_count: p.pageCount,
      continued_marker: p.continued,
      has_totals: p.hasTotals,
      same_page_as_image: p.samePageAs,
      readability: 'good',
      notes: '',
    })),
    lines: e.lines.map((l) => ({
      image_index: l.image,
      line_ref: l.lineRef,
      category_header: l.categoryHeader,
      item_number: l.itemNumber,
      upc: l.upc,
      description: [l.description, l.descriptionMore].filter(Boolean).join(' | '),
      brand: l.brand,
      pack_size: l.packSize,
      units_per_pack: l.unitsPerPack,
      origin: l.origin,
      qty_ordered: '',
      qty_shipped: l.qtyShipped,
      unit: l.unit,
      weight: l.weight,
      unit_price: l.unitPrice,
      price_unit: l.priceUnit,
      allowance: l.allowance,
      extension: l.extension,
      printed_status: l.printedStatus,
      annotations: l.annotations,
      confidence: 'high',
      confidence_note: '',
    })),
    charges: e.charges.map((c) => ({ image_index: c.image, description: c.description, amount: c.amount, kind: c.kind })),
    subtotal: e.subtotal,
    tax: e.tax,
    total: e.total,
    previous_balance: e.previousBalance,
    printed_total_quantity: e.printedTotalQuantity,
    invoice_annotations: e.invoiceAnnotations,
    overall_confidence: 'high',
    problems: [],
  };
}

/**
 * Checks a transcription with the same code checks a reading gets, plus that each line's
 * received flag agrees with the code's. Returns plain-word problems; empty means valid.
 */
export function validateExpected(e: ExpectedInvoice, today: Date, settings: InvoiceReadingSettings = DEFAULT_INVOICE_SETTINGS): { problems: string[]; reading: CheckedReading } {
  const reading = checkReading(expectedAsModelInvoice(e), { settings, today, imagesSent: e.images.length });
  const problems: string[] = [];
  for (const c of reading.checks) {
    if (!c.passed) problems.push(`${c.id}: ${c.message} ${c.details.join(' ')}`);
  }
  for (const cl of reading.lines) {
    const want = e.lines[cl.n - 1]!.received;
    if (cl.received !== want) problems.push(`line ${cl.n}: received is "${want}" in the file but the checks say "${cl.received}"`);
  }
  if (e.pages.length !== e.images.length) problems.push(`${e.images.length} images but ${e.pages.length} pages listed`);
  for (const p of e.pages) {
    if (typeof p.invoiceNumber !== 'string') problems.push(`page for image ${p.image}: the invoice number printed on it is not recorded`);
  }
  return { problems, reading };
}
