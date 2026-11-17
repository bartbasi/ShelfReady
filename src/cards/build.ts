// C&C 4-up shelf card sheets. A TypeScript port of the build code in the
// cc-case-cards skill. Structure lives here; every size, colour, font and
// string that belongs to the store lives in config/cards/<store>.json.
import {
  BorderStyle,
  Document,
  HeightRule,
  LineRuleType,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { readFileSync } from 'node:fs';
import type { CardConfig, CardRecord, TextStyle } from './types.ts';

/**
 * Package parts pinned to the bytes in the reference cards. The reference
 * files were written by an older docx release. docx 9.15.2 adds default
 * styles (TableNormal, Caption, TOC1 to TOC9, Bibliography, LineNumber) to
 * styles.xml and a w:defaultTabStop to settings.xml. The cards use no named
 * styles and set every cell margin, so this pins the package to what Claude
 * shipped and keeps a future docx upgrade from changing it silently.
 */
const PINNED_PARTS = ['word/styles.xml', 'word/settings.xml'].map((path) => ({
  path,
  data: readFileSync(new URL(`./parts/${path.slice('word/'.length)}`, import.meta.url), 'utf8'),
}));

export const BLANK: Readonly<CardRecord> = Object.freeze({
  origin: '',
  eyebrow: '',
  n1: '',
  n2: '',
  producer: '',
  specs: [['', ''], ['', ''], ['', '']],
  copy: [''],
  price: '',
  unit: '',
  code: '',
}) as Readonly<CardRecord>;

export function cardName(c: Pick<CardRecord, 'n1' | 'n2'>): string {
  return (c.n1 + c.n2).trim();
}

// Natural order, so "Aged 8 Year" comes before "Aged 10 Year", which is how
// the reference sheets are ordered.
const collate = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

/** Eyebrow, then name, so like products sit together. Returns a new array. */
export function sortCards<T extends CardRecord>(cards: readonly T[]): T[] {
  return [...cards].sort(
    (a, b) => collate(a.eyebrow, b.eyebrow) || collate(cardName(a), cardName(b)),
  );
}

/** Pads with blank slots to a multiple of four. Returns a new array. */
export function padToFour(cards: readonly CardRecord[]): CardRecord[] {
  const out: CardRecord[] = [...cards];
  while (out.length % 4) out.push(BLANK as CardRecord);
  return out;
}

export interface BuildOptions {
  /** Sort by eyebrow then name before laying out. Default true. */
  sort?: boolean;
  /** Use the pinned styles.xml and settings.xml (see PINNED_PARTS). Default true. */
  pinParts?: boolean;
}

export interface BuildResult {
  buffer: Buffer;
  slots: number;
  sheets: number;
  /** The cards in printed order, blanks included. */
  layout: CardRecord[];
}

export async function buildCards(
  cards: readonly CardRecord[],
  cfg: CardConfig,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  if (cards.length === 0) throw new Error('No cards to build');
  for (const c of cards) checkRecord(c);
  const layout = padToFour(opts.sort === false ? cards : sortCards(cards));
  const doc = makeDocument(layout, cfg);
  const buffer = await Packer.toBuffer(doc, false, opts.pinParts === false ? [] : PINNED_PARTS);
  return { buffer, slots: layout.length, sheets: layout.length / 4, layout };
}

function checkRecord(c: CardRecord): void {
  const label = cardName(c) || c.code || '(unnamed card)';
  if (!Array.isArray(c.specs) || c.specs.length !== 3) throw new Error(`${label}: needs exactly three specs`);
  if (!Array.isArray(c.copy) || c.copy.length === 0) throw new Error(`${label}: needs copy`);
  const fields = [c.code, c.price, c.unit, c.origin, c.eyebrow, c.n1, c.n2, c.producer, ...c.specs.flat(), ...c.copy];
  for (const f of fields) {
    if (typeof f !== 'string') throw new Error(`${label}: every field must be a string`);
    // Google Docs fidelity: no literal newlines or tabs inside a run.
    if (/[\n\r\t]/.test(f)) throw new Error(`${label}: text may not contain newlines or tabs`);
  }
}

function makeDocument(layout: CardRecord[], cfg: CardConfig): Document {
  const g = cfg.geometry;
  const b = cfg.blocks;
  const color = (n: keyof CardConfig['colors']): string => cfg.colors[n];
  const INNER = g.labelWidth - g.padX * 2;

  const run = (text: string, s: TextStyle): TextRun => {
    // Only pass the keys the skill passes: docx writes an element for every key given.
    const o: { text: string; font: string; size: number; color: string; bold?: boolean; italics?: boolean; characterSpacing?: number } = {
      text,
      font: cfg.fonts[s.font],
      size: s.size,
      color: color(s.color),
    };
    if (s.bold) o.bold = true;
    if (s.italics) o.italics = true;
    if (s.characterSpacing !== undefined) o.characterSpacing = s.characterSpacing;
    return new TextRun(o);
  };
  const tab = (): TextRun => new TextRun({ children: [new Tab()] });

  const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noB = { top: NONE, bottom: NONE, left: NONE, right: NONE };
  const fillC = (hex: string) => ({ type: ShadingType.CLEAR, color: 'auto', fill: hex });
  const SPEC_TABS = [1, 3, 5].map((n) => ({ type: TabStopType.CENTER, position: Math.round((INNER * n) / 6) }));
  const RIGHT_TAB = [{ type: TabStopType.RIGHT, position: INNER }];
  const tiny = (): Paragraph =>
    new Paragraph({
      spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT },
      children: [new TextRun({ text: '', size: 2 })],
    });

  const cell = (kids: Paragraph[], blk: { fill: keyof CardConfig['colors']; margins: { top: number; bottom: number } }): TableCell =>
    new TableCell({
      children: kids,
      width: { size: g.labelWidth, type: WidthType.DXA },
      shading: fillC(color(blk.fill)),
      borders: noB,
      margins: { left: g.padX, right: g.padX, top: blk.margins.top, bottom: blk.margins.bottom },
      verticalAlign: VerticalAlign.CENTER,
    });
  const emptyCell = (w: number): TableCell =>
    new TableCell({ children: [tiny()], width: { size: w, type: WidthType.DXA }, borders: noB, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  const gut = (): TableCell => emptyCell(g.gutter);

  const BLOCKS: Array<(L: CardRecord) => TableCell> = [
    (L) =>
      cell(
        [
          new Paragraph({
            tabStops: RIGHT_TAB,
            spacing: { before: 0, after: 0 },
            children: [run(cfg.mark, b.header.mark), tab(), run(L.origin, b.header.origin)],
          }),
        ],
        b.header,
      ),

    (L) =>
      cell(
        [
          new Paragraph({ spacing: { before: 0, after: b.name.eyebrowAfter }, children: [run(L.eyebrow, b.name.eyebrow)] }),
          new Paragraph({
            spacing: { before: 0, after: 0, line: b.name.nameLine, lineRule: LineRuleType.EXACT },
            children: [run(L.n1, b.name.n1), run(L.n2, b.name.n2)],
          }),
          new Paragraph({ spacing: { before: b.name.producerBefore, after: 0 }, children: [run(L.producer, b.name.producer)] }),
        ],
        b.name,
      ),

    (L) =>
      cell(
        [
          new Paragraph({
            tabStops: SPEC_TABS,
            spacing: { before: 0, after: b.specs.labelAfter },
            children: L.specs.flatMap((s) => [tab(), run(s[0], b.specs.label)]),
          }),
          new Paragraph({
            tabStops: SPEC_TABS,
            spacing: { before: 0, after: 0 },
            children: L.specs.flatMap((s) => [tab(), run(s[1], b.specs.value)]),
          }),
        ],
        b.specs,
      ),

    (L) =>
      cell(
        L.copy.map(
          (t, i) =>
            new Paragraph({
              spacing: { before: 0, after: i === L.copy.length - 1 ? 0 : b.copy.paragraphAfter, line: b.copy.line, lineRule: LineRuleType.EXACT },
              children: [run(t, b.copy.text)],
            }),
        ),
        b.copy,
      ),

    (L) =>
      cell(
        [
          new Paragraph({
            tabStops: RIGHT_TAB,
            spacing: { before: 0, after: 0 },
            children: [run(L.price, b.price.price), tab(), run(L.unit, b.price.unit)],
          }),
        ],
        b.price,
      ),

    (L) =>
      cell(
        [
          new Paragraph({
            tabStops: RIGHT_TAB,
            spacing: { before: 0, after: 0 },
            children: [run(cfg.tagline, b.footer.tagline), tab(), run(L.code, b.footer.code)],
          }),
        ],
        b.footer,
      ),
  ];

  const sheet = (four: CardRecord[]): Table => {
    const pair = (a: CardRecord, c: CardRecord): TableRow[] =>
      BLOCKS.map(
        (f, i) =>
          new TableRow({
            children: [f(a), gut(), f(c)],
            cantSplit: true,
            height: { value: g.rowHeights[i], rule: i === g.exactRow ? HeightRule.EXACT : HeightRule.ATLEAST },
          }),
      );
    const gutRow = new TableRow({
      children: [emptyCell(g.labelWidth), gut(), emptyCell(g.labelWidth)],
      cantSplit: true,
      height: { value: g.gutter, rule: HeightRule.ATLEAST },
    });
    return new Table({
      columnWidths: [g.labelWidth, g.gutter, g.labelWidth],
      width: { size: g.labelWidth * 2 + g.gutter, type: WidthType.DXA },
      borders: noB,
      rows: [...pair(four[0], four[1]), gutRow, ...pair(four[2], four[3])],
    });
  };

  const kids: Array<Table | Paragraph> = [];
  for (let i = 0; i < layout.length; i += 4) {
    kids.push(sheet(layout.slice(i, i + 4)));
    if (i + 4 < layout.length) {
      kids.push(
        new Paragraph({ children: [new PageBreak()], spacing: { before: 0, after: 0, line: 20, lineRule: LineRuleType.EXACT } }),
      );
    } else kids.push(tiny());
  }

  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: g.sheetWidth, height: g.sheetHeight },
            margin: {
              top: g.marginTop,
              right: g.marginLeftRight,
              bottom: g.marginBottom,
              left: g.marginLeftRight,
              header: 0,
              footer: 0,
              gutter: 0,
            },
          },
        },
        children: kids,
      },
    ],
  });
}
