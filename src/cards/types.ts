// Shelf card records and the store card template.

export type Spec = [label: string, value: string];

export interface CardRecord {
  /** 4-digit scale code for weight goods, printed in the footer. Empty for unit goods. */
  code: string;
  price: string;
  /** PER POUND for weight goods, otherwise the pack size. */
  unit: string;
  origin: string;
  eyebrow: string;
  /** Set in black. May be empty when the whole name goes in n2. */
  n1: string;
  /** Set in red italic. */
  n2: string;
  producer: string;
  specs: [Spec, Spec, Spec];
  copy: string[];
  /** What must be confirmed before printing. Never printed. */
  verify?: string;
}

export type ColorName = 'ink' | 'cream' | 'yellow' | 'white' | 'red' | 'inkMid' | 'inkDim' | 'footDim';
export type FontRole = 'display' | 'body';

export interface TextStyle {
  font: FontRole;
  size: number;
  color: ColorName;
  bold?: boolean;
  italics?: boolean;
  characterSpacing?: number;
}

export interface BlockBase {
  fill: ColorName;
  margins: { top: number; bottom: number };
}

/** The taller name block used on sheets built on or before October 28, 2026. */
export interface LegacyNameBlock {
  nameRowHeight: number;
  nameMargins: { top: number; bottom: number };
  eyebrowAfter: number;
  producerBefore: number;
}

export interface CardConfig {
  store: string;
  mark: string;
  tagline: string;
  eyebrows: string[];
  colors: Record<ColorName, string>;
  fonts: Record<FontRole, string>;
  geometry: {
    sheetWidth: number;
    sheetHeight: number;
    labelWidth: number;
    gutter: number;
    marginLeftRight: number;
    marginTop: number;
    marginBottom: number;
    padX: number;
    rowHeights: number[];
    exactRow: number;
    history?: {
      untilOct28?: LegacyNameBlock;
    };
  };
  blocks: {
    header: BlockBase & { mark: TextStyle; origin: TextStyle };
    name: BlockBase & {
      eyebrowAfter: number;
      eyebrow: TextStyle;
      nameLine: number;
      n1: TextStyle;
      n2: TextStyle;
      producerBefore: number;
      producer: TextStyle;
    };
    specs: BlockBase & { labelAfter: number; label: TextStyle; value: TextStyle };
    copy: BlockBase & { line: number; paragraphAfter: number; text: TextStyle };
    price: BlockBase & { price: TextStyle; unit: TextStyle };
    footer: BlockBase & { tagline: TextStyle; code: TextStyle };
  };
  limits?: Record<string, unknown>;
}
