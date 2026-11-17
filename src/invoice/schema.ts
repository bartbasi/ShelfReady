// The JSON schema the model must answer in (structured outputs, output_config.format).
//
// Every field is required and no field is nullable: an empty string means "not printed".
// That keeps the schema free of unions. Numbers are text exactly as printed, so nothing is
// lost to float rounding and checks.ts can parse them digit by digit.
// validateAgainstSchema() checks the answer against this same schema in code, because a
// reading is never trusted on the model's word alone.

import type { ModelInvoice } from './types.ts';

type Schema = Record<string, unknown>;

const str = (description: string): Schema => ({ type: 'string', description });
const num = (description: string): Schema => ({
  type: 'string',
  description: `${description} Digits and a decimal point exactly as printed, a leading minus for negative, no $ or commas. Empty if not printed.`,
});

const annotation: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'text', 'meaning'],
  properties: {
    kind: { type: 'string', enum: ['handwritten', 'stamp', 'highlight', 'check_mark', 'printed_note'] },
    text: str('The words as written, or a short description of a mark, for example "check mark".'),
    meaning: {
      type: 'string',
      enum: ['received', 'not_received', 'short', 'damaged', 'returned', 'price_note', 'signature', 'other'],
    },
  },
};

const image: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'image_index',
    'invoice_number',
    'page_number',
    'page_count',
    'continued_marker',
    'has_totals',
    'same_page_as_image',
    'readability',
    'notes',
  ],
  properties: {
    image_index: { type: 'integer', description: 'Image number, 1-based, in the order given.' },
    invoice_number: str('Invoice number printed on this image. Empty if none is visible.'),
    page_number: str('Page number printed on this image, for example "2". Empty if not printed.'),
    page_count: str('Total pages if printed, for example the 3 in "2 of 3". Empty if not printed.'),
    continued_marker: { type: 'boolean', description: 'True if the page says the invoice continues on another page.' },
    has_totals: { type: 'boolean', description: 'True if this image shows the invoice total or balance due.' },
    same_page_as_image: {
      type: 'integer',
      description: 'If this image is another photo of a page already shown in an earlier image, that earlier image number. Otherwise 0.',
    },
    readability: { type: 'string', enum: ['good', 'fair', 'poor'] },
    notes: str('Anything unusual about this image, in a few words. Empty if nothing.'),
  },
};

const line: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'image_index',
    'line_ref',
    'category_header',
    'item_number',
    'upc',
    'description',
    'brand',
    'pack_size',
    'units_per_pack',
    'origin',
    'qty_ordered',
    'qty_shipped',
    'unit',
    'weight',
    'unit_price',
    'price_unit',
    'allowance',
    'extension',
    'printed_status',
    'annotations',
    'confidence',
    'confidence_note',
  ],
  properties: {
    image_index: { type: 'integer', description: 'The image this line is printed on.' },
    line_ref: str('Printed line number, if any.'),
    category_header: str('Section header the line sits under, for example "10 - DAIRY". Empty if none.'),
    item_number: str("Supplier's item number exactly as printed, letters included."),
    upc: str('Any UPC, EAN or other long product code printed on the line, digits only. Empty if none.'),
    description: str('Full description. Join continuation lines with " | ".'),
    brand: str('Brand if printed in its own column or clearly part of the line. Empty if none.'),
    pack_size: str('Pack or size text as printed, for example "12/5.3Z", "24/9.5oz", "6 OZ". Empty if none.'),
    units_per_pack: str('Units per case or pack when printed in its own column, for example "10". Empty if none.'),
    origin: str('Product origin if printed. Empty if none.'),
    qty_ordered: num('Quantity ordered, if printed in its own column.'),
    qty_shipped: num('Quantity shipped, even when its unit is LB.'),
    unit: str('Unit of the shipped quantity as printed, for example EA, CS, LB, PC.'),
    weight: num('Catch weight printed for this line, the actual weight shipped. Empty if the weight column is blank or .00.'),
    unit_price: num('Price per unit as printed, before any allowance.'),
    price_unit: str('Unit the price is per, for example LB, CS, EA, PC, if printed. Empty if not printed.'),
    allowance: num('Per-unit allowance or discount printed for this line, as a positive number.'),
    extension: num('Line amount as printed.'),
    printed_status: { type: 'string', enum: ['shipped', 'out_of_stock', 'short_shipped', 'credit', 'other'] },
    annotations: { type: 'array', items: annotation },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    confidence_note: str('Why confidence is not high. Empty when high.'),
  },
};

const charge: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['image_index', 'description', 'amount', 'kind'],
  properties: {
    image_index: { type: 'integer' },
    description: str('As printed, for example "Delivery Fee".'),
    amount: num('Amount added to the invoice. Negative for a discount or credit.'),
    kind: { type: 'string', enum: ['fuel_surcharge', 'delivery_fee', 'fee', 'deposit', 'discount', 'credit', 'other'] },
  },
};

export const INVOICE_SCHEMA: Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'supplier_name',
    'invoice_number',
    'invoice_date',
    'invoice_date_iso',
    'images',
    'lines',
    'charges',
    'subtotal',
    'tax',
    'total',
    'previous_balance',
    'printed_total_quantity',
    'invoice_annotations',
    'overall_confidence',
    'problems',
  ],
  properties: {
    supplier_name: str('Supplier name as printed at the top.'),
    invoice_number: str('Invoice number as printed.'),
    invoice_date: str('Invoice date as printed.'),
    invoice_date_iso: str('Invoice date as YYYY-MM-DD. Empty if unsure.'),
    images: { type: 'array', items: image },
    lines: { type: 'array', items: line },
    charges: { type: 'array', items: charge },
    subtotal: num('Printed subtotal.'),
    tax: num('Printed tax. Empty if not printed.'),
    total: num('Printed total due for this invoice only, never including a previous balance.'),
    previous_balance: num('Previous balance or past amounts owed, kept separate from the total.'),
    printed_total_quantity: num('The invoice\'s own printed total count of units shipped, only if printed as one number, for example "QTY: 31". Do not add it up yourself.'),
    invoice_annotations: { type: 'array', items: annotation },
    overall_confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    problems: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Checks a value against INVOICE_SCHEMA (or a part of it). Returns a list of problems,
 * each naming the path, for example "lines[3].extension: expected a string".
 */
export function validateAgainstSchema(value: unknown, schema: Schema = INVOICE_SCHEMA, path = '$'): string[] {
  const problems: string[] = [];
  const type = schema['type'];
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path}: expected an object`];
    const props = (schema['properties'] ?? {}) as Record<string, Schema>;
    const required = (schema['required'] ?? []) as string[];
    const obj = value as Record<string, unknown>;
    for (const key of required) if (!(key in obj)) problems.push(`${path}.${key}: missing`);
    for (const key of Object.keys(obj)) {
      const sub = props[key];
      if (!sub) {
        problems.push(`${path}.${key}: not expected`);
        continue;
      }
      problems.push(...validateAgainstSchema(obj[key], sub, `${path}.${key}`));
    }
    return problems;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected a list`];
    const items = schema['items'] as Schema;
    value.forEach((v, i) => problems.push(...validateAgainstSchema(v, items, `${path}[${i}]`)));
    return problems;
  }
  if (type === 'string') {
    if (typeof value !== 'string') return [`${path}: expected a string`];
    const allowed = schema['enum'] as string[] | undefined;
    if (allowed && !allowed.includes(value)) return [`${path}: "${value}" is not one of ${allowed.join(', ')}`];
    return [];
  }
  if (type === 'integer') {
    return Number.isInteger(value) ? [] : [`${path}: expected a whole number`];
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? [] : [`${path}: expected true or false`];
  }
  return [`${path}: unknown schema type`];
}

/** Narrows a parsed answer to ModelInvoice when it matches the schema. */
export function asModelInvoice(value: unknown): { ok: true; invoice: ModelInvoice } | { ok: false; problems: string[] } {
  const problems = validateAgainstSchema(value);
  if (problems.length) return { ok: false, problems };
  return { ok: true, invoice: value as ModelInvoice };
}
