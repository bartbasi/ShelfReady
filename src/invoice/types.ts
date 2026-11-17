// Types for invoice reading. The model's answer (ModelInvoice) mirrors the JSON schema in
// schema.ts field for field. Numbers stay as the text printed on the invoice; checks.ts
// parses them exactly. An empty string always means "not printed".

export type Confidence = 'high' | 'medium' | 'low';
export type Readability = 'good' | 'fair' | 'poor';

/** What the printed invoice says about a line. Handwriting goes in annotations instead. */
export type PrintedStatus = 'shipped' | 'out_of_stock' | 'short_shipped' | 'credit' | 'other';

export type AnnotationKind = 'handwritten' | 'stamp' | 'highlight' | 'check_mark' | 'printed_note';
export type AnnotationMeaning =
  | 'received'
  | 'not_received'
  | 'short'
  | 'damaged'
  | 'returned'
  | 'price_note'
  | 'signature'
  | 'other';

export type ChargeKind = 'fuel_surcharge' | 'delivery_fee' | 'fee' | 'deposit' | 'discount' | 'credit' | 'other';

export interface ModelAnnotation {
  kind: AnnotationKind;
  /** The words as written, or a short description of a mark ("check mark"). */
  text: string;
  meaning: AnnotationMeaning;
}

export interface ModelImage {
  /** 1-based, in the order the images were sent. For a PDF, the page of the document. */
  image_index: number;
  invoice_number: string;
  page_number: string;
  page_count: string;
  /** The page says the invoice continues on another page ("CONTINUED"). */
  continued_marker: boolean;
  /** The page shows the invoice total or balance due. */
  has_totals: boolean;
  /** 0, or the earlier image that shows the same page (a second photo). */
  same_page_as_image: number;
  readability: Readability;
  notes: string;
}

export interface ModelLine {
  image_index: number;
  line_ref: string;
  category_header: string;
  item_number: string;
  upc: string;
  description: string;
  brand: string;
  pack_size: string;
  units_per_pack: string;
  origin: string;
  qty_ordered: string;
  qty_shipped: string;
  unit: string;
  weight: string;
  unit_price: string;
  price_unit: string;
  allowance: string;
  extension: string;
  printed_status: PrintedStatus;
  annotations: ModelAnnotation[];
  confidence: Confidence;
  confidence_note: string;
}

export interface ModelCharge {
  image_index: number;
  description: string;
  amount: string;
  kind: ChargeKind;
}

export interface ModelInvoice {
  supplier_name: string;
  invoice_number: string;
  invoice_date: string;
  /** YYYY-MM-DD, or empty when the model is not sure. */
  invoice_date_iso: string;
  images: ModelImage[];
  lines: ModelLine[];
  charges: ModelCharge[];
  subtotal: string;
  tax: string;
  total: string;
  previous_balance: string;
  printed_total_quantity: string;
  invoice_annotations: ModelAnnotation[];
  overall_confidence: Confidence;
  problems: string[];
}

/** Whether the goods on a line arrived, as far as the invoice and its notes say. */
export type Received = 'yes' | 'no' | 'check';

/** One check on a reading. Blocking checks send the invoice to the fallback model, then to review. */
export interface CheckResult {
  id: CheckId;
  passed: boolean;
  blocking: boolean;
  /** Plain words for the review screen. */
  message: string;
  /** Plain-word details, one per problem found. */
  details: string[];
}

export type CheckId =
  | 'schema'
  | 'pages_complete'
  | 'same_invoice'
  | 'line_math'
  | 'totals'
  | 'subtotal'
  | 'total_quantity'
  | 'ranges'
  | 'catch_weight'
  | 'invoice_date'
  | 'upc_check_digits'
  | 'duplicate_pages_agree'
  | 'model_confidence'
  | 'misread_codes'
  | 'known_items';

/** A line after checks: the model's text plus what the code worked out. */
export interface CheckedLine {
  /** Position in the reading, 1-based, after duplicate pages are dropped. */
  n: number;
  line: ModelLine;
  /** Expected extension from qty or weight x price, in cents, when it can be computed. */
  computedCents: number | null;
  extensionCents: number | null;
  basis: 'weight' | 'quantity' | 'none';
  received: Received;
  /** Plain-word flags for the review screen, for example "Marked not received: never arrived". */
  flags: string[];
  pack: PackInfo;
}

/** What a line's unit price is for. */
export type PricePer = 'case' | 'unit' | 'lb' | 'unclear';

export interface PackInfo {
  /**
   * What the unit price is per. Pricing divides the net price by unitsPerCase only when this is
   * 'case'. A 'unit' price is already per sellable unit, even when a pack such as "2/CS" is printed.
   * 'unclear' is flagged for a person and must not be guessed.
   */
  pricePer: PricePer;
  /** Sellable units in one case, when it can be worked out. */
  unitsPerCase: number | null;
  /** Size of one unit as printed, for example "5.3Z" or "6 OZ". */
  unitSize: string;
  sure: boolean;
  note: string;
}

export interface Notice {
  /** Plain words for the review screen. */
  message: string;
}

/** A reading that has been through every check. */
export interface CheckedReading {
  invoice: ModelInvoice;
  lines: CheckedLine[];
  checks: CheckResult[];
  /** Blocking checks that failed. Empty means the reading may be shown as good. */
  failed: CheckResult[];
  notices: Notice[];
  /** Image numbers dropped as repeats of an earlier image of the same page. */
  duplicateImages: number[];
  linesTotalCents: number | null;
  chargesTotalCents: number | null;
  totalCents: number | null;
}
