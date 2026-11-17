// Card copy: the parts of a shelf card that a person or the model writes.
//
// Price and scale code are never part of it. A printed card always takes them from pricing and
// Square (src/copy/card.ts), so neither a stored card nor the model can set them.

import type { Spec } from '../cards/types.ts';
import type { CatalogIndex } from '../matching/catalog.ts';

/** A card as written, without price and code. */
export interface CardContent {
  origin: string;
  eyebrow: string;
  /** Set in black. Empty when the whole name goes in n2. */
  n1: string;
  /** Set in red italic. */
  n2: string;
  producer: string;
  specs: [Spec, Spec, Spec];
  copy: string[];
  /** PER POUND for weight goods, otherwise the pack size. */
  unit: string;
}

/** Where a card's text comes from now. An edit by a person always wins. */
export type CardSource = 'imported' | 'generated' | 'edited';
export type FirstSource = 'imported' | 'generated';

/**
 * How a card was linked to a Square variation. same_item: carried over from a link in another
 * catalog to the one item there with the same name.
 */
export type LinkMethod = 'scale_code' | 'name' | 'person' | 'generated' | 'same_item';

/**
 * A catalog the copy step works against. Square variation ids differ between accounts (the
 * sandbox holds copies of the live items under new ids), so a link holds only for the catalog
 * it was made in. The key is the catalog's Square location id, which names its id space.
 */
export interface CopyCatalog {
  index: CatalogIndex;
  /** Where the catalog came from, as the runs name it (square_sandbox, file). Recorded on each link. */
  source: string;
}

/** Where one card is linked, in one catalog. */
export interface CardLink {
  /** The catalog's key: its Square location id. */
  catalog: string;
  catalogSource: string;
  variationId: string;
  itemId: string;
  /** The variation's label when the link was made, so the link can carry to a catalog with the same item. */
  label: string;
  method: LinkMethod;
  linkedAt: string;
}

export type VerifyKind = 'claim' | 'origin' | 'designation' | 'naming' | 'packaging' | 'cooking' | 'sources' | 'category' | 'limits' | 'price' | 'other';

/** One thing a person must confirm before the card is printed. */
export interface VerifyItem {
  kind: VerifyKind;
  text: string;
  /** Raised by the model itself, or found by a code check. */
  from: 'model' | 'code';
}

/** A web page the model used, and that its own searches returned in the same call. */
export interface SourceRef {
  url: string;
  title: string;
  usedFor: string;
}

export interface SearchRecord {
  query: string;
  results: Array<{ url: string; title: string; pageAge: string }>;
  /** The search tool's error code, or '' when the search worked. */
  error: string;
}

/** What generation left for the review screen. Generated cards only. */
export interface CardReview {
  verify: VerifyItem[];
  sources: SourceRef[];
  searches: Array<{ query: string; results: number; error: string }>;
  /** Limits still out after the one retry. Empty when the card is within every limit. */
  problems: string[];
  uniqueSellingPoint: string;
  productIdentified: boolean;
  model: string;
  costUsd: number;
  generatedAt: string;
}

/** What an imported card printed when it was made. Kept for reference only, never printed again. */
export interface PrintedInfo {
  price: string;
  code: string;
  file: string;
  created: string | null;
  sheet: number;
  slot: number;
}

export interface StoredCard {
  id: number;
  /** Where the card is linked, one entry per catalog. Empty until it is linked; a retired card has none. */
  links: CardLink[];
  /** The code the card was printed with, or the item's code when last seen. Empty when none. */
  scaleCode: string;
  /** The folded product name, for linking by name. */
  nameKey: string;
  /** The card's key in the imported file, or empty. */
  importKey: string;
  source: CardSource;
  firstSource: FirstSource;
  content: CardContent;
  printed: PrintedInfo | null;
  review: CardReview | null;
  /**
   * Why the card cannot print until a person edits it: a price, phone number or web address the
   * model left in after its retry. Empty when nothing blocks it.
   */
  blocked: string[];
  version: number;
  /** The version a person checked, or 0. Every generated card needs a check of its current version. */
  checkedVersion: number;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Facts about a matched product, read from the Square catalog. */
export interface ProductFacts {
  /** The catalog the facts come from: its key (Square location id) and source. */
  catalog: string;
  catalogSource: string;
  variationId: string;
  itemId: string;
  /** The item name as Square has it, code included. */
  itemName: string;
  /** What the manager sees: item name, plus the variation name when it tells them apart. */
  label: string;
  /** The item name without the scale code. */
  baseName: string;
  maker: string;
  product: string;
  /** The variation name when it tells variations apart, else empty. */
  variationName: string;
  scaleCode: string | null;
  soldByWeight: boolean;
  categoryNames: string[];
  archived: boolean;
  availableHere: boolean;
}

/** What the invoice line printed about the product. Every field may be empty. */
export interface InvoiceFacts {
  supplier: string;
  description: string;
  brand: string;
  packSize: string;
  unitsPerPack: string;
  origin: string;
}

/** A request that cannot be done. The message is plain and safe to show. */
export class CopyError extends Error {}
