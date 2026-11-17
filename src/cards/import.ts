// Reads shelf card .docx files (as built by the cc-case-cards skill, or by
// build.ts) back into card records.
import { readDocxParts } from './docx-zip.ts';
import { decodeXmlEntities } from './xml.ts';
import { cardName } from './build.ts';
import type { CardRecord, Spec } from './types.ts';

/** Rows per card pair in the skill layout: header, name, specs, copy, price, footer. */
const BLOCK_ROWS = 6;
/** Two card pairs plus the gutter row between them. */
const ROWS_PER_SHEET = BLOCK_ROWS * 2 + 1;

interface Run {
  text: string | null;
  italic: boolean;
}

const decode = decodeXmlEntities;

const all = (re: RegExp, s: string): string[] => [...s.matchAll(re)].map((m) => m[1] ?? '');

const tables = (xml: string) => all(/<w:tbl>([\s\S]*?)<\/w:tbl>/g, xml);
const rows = (tbl: string) => all(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g, tbl);
const cells = (tr: string) => all(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g, tr);
const paras = (tc: string) => all(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g, tc);

function runs(p: string): Run[] {
  return all(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g, p).map((r) => {
    const t = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/.exec(r);
    return { text: t ? decode(t[1] ?? '') : null, italic: /<w:i\/>|<w:i w:val="(true|1|on)"\/>/.test(r) };
  });
}

/** The text runs of a paragraph, ignoring tab-only runs. */
const texts = (p: string): string[] => runs(p).flatMap((r) => (r.text === null ? [] : [r.text]));

function one(p: string | undefined, where: string, wantRuns: number): string[] {
  if (p === undefined) throw new Error(`${where}: paragraph missing`);
  const t = texts(p);
  if (t.length !== wantRuns) throw new Error(`${where}: expected ${wantRuns} text runs, found ${t.length}`);
  return t;
}

/** The store's own text printed on every card, blank slots included. */
export interface CardTemplateText {
  mark: string;
  tagline: string;
}

/** Parses one card from its six block cells. card is null for a blank padding slot. */
function parseCard(blockCells: string[], where: string): { card: CardRecord | null; template: CardTemplateText } {
  const [header, name, specs, copy, price, footer] = blockCells.map(paras);
  const [mark, origin] = one(header[0], `${where} header`, 2);
  const [eyebrow] = one(name[0], `${where} eyebrow`, 1);
  const nameRuns = runs(name[1] ?? '').filter((r) => r.text !== null);
  if (nameRuns.length !== 2) throw new Error(`${where} name: expected 2 text runs, found ${nameRuns.length}`);
  if (nameRuns[0].italic || !nameRuns[1].italic) throw new Error(`${where} name: expected roman n1 then italic n2`);
  const [producer] = one(name[2], `${where} producer`, 1);
  const labels = one(specs[0], `${where} spec labels`, 3);
  const values = one(specs[1], `${where} spec values`, 3);
  const copyParas = copy.map((p, i) => {
    const t = texts(p);
    if (t.length !== 1) throw new Error(`${where} copy paragraph ${i + 1}: expected 1 text run, found ${t.length}`);
    return t[0];
  });
  const [priceText, unit] = one(price[0], `${where} price`, 2);
  const [tagline, code] = one(footer[0], `${where} footer`, 2);
  const card: CardRecord = {
    code,
    price: priceText,
    unit,
    origin,
    eyebrow,
    n1: nameRuns[0].text as string,
    n2: nameRuns[1].text as string,
    producer,
    specs: [0, 1, 2].map((i) => [labels[i], values[i]] as Spec) as [Spec, Spec, Spec],
    copy: copyParas,
  };
  const blank =
    [card.code, card.price, card.unit, card.origin, card.eyebrow, card.n1, card.n2, card.producer, ...card.specs.flat(), ...card.copy].every(
      (s) => s === '',
    );
  return { card: blank ? null : card, template: { mark, tagline } };
}

export interface ParsedSheetFile {
  /** Every slot in printed order; null marks a blank padding slot. */
  slots: Array<CardRecord | null>;
  /** The non-blank cards, in printed order. */
  cards: CardRecord[];
  sheets: number;
  /** Mark and tagline printed in each slot, parallel to slots. */
  templates: CardTemplateText[];
  /** Distinct marks and taglines in the file (normally one of each). */
  marks: string[];
  taglines: string[];
  /** Name row height found in the file (0 now, 1632 in older files). */
  nameRowHeight: number | null;
  /** dcterms:created from docProps/core.xml, if present. */
  created: string | null;
}

export function parseCardsDocumentXml(xml: string): Omit<ParsedSheetFile, 'created'> {
  const slots: Array<CardRecord | null> = [];
  const templates: CardTemplateText[] = [];
  let nameRowHeight: number | null = null;
  const tbls = tables(xml);
  if (tbls.length === 0) throw new Error('No card tables found');
  tbls.forEach((tbl, s) => {
    const trs = rows(tbl);
    if (trs.length !== ROWS_PER_SHEET) throw new Error(`Sheet ${s + 1}: expected ${ROWS_PER_SHEET} rows, found ${trs.length}`);
    const h = /<w:trHeight w:val="(\d+)"/.exec(trs[1]);
    if (h && nameRowHeight === null) nameRowHeight = Number(h[1]);
    for (const top of [0, BLOCK_ROWS + 1]) {
      const rowCells = trs.slice(top, top + BLOCK_ROWS).map(cells);
      for (const col of [0, 2]) {
        const where = `Sheet ${s + 1} slot ${slots.length % 4 + 1}`;
        const parsed = parseCard(rowCells.map((rc) => rc[col] ?? ''), where);
        slots.push(parsed.card);
        templates.push(parsed.template);
      }
    }
  });
  return {
    slots,
    cards: slots.filter((c): c is CardRecord => c !== null),
    templates,
    marks: [...new Set(templates.map((t) => t.mark))],
    taglines: [...new Set(templates.map((t) => t.tagline))],
    sheets: tbls.length,
    nameRowHeight,
  };
}

export function parseCardsDocx(buf: Uint8Array): ParsedSheetFile {
  const parts = readDocxParts(buf);
  const xml = parts.get('word/document.xml');
  if (xml === undefined) throw new Error('Not a .docx: word/document.xml is missing');
  const created = /<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/.exec(parts.get('docProps/core.xml') ?? '')?.[1] ?? null;
  return { ...parseCardsDocumentXml(xml), created };
}

/**
 * Warnings when a file's printed mark or tagline is not the store config's.
 * The file's own text is kept on each imported card either way.
 */
export function templateWarnings(parsed: Pick<ParsedSheetFile, 'marks' | 'taglines'>, expected: CardTemplateText): string[] {
  const out: string[] = [];
  for (const m of parsed.marks) if (m !== expected.mark) out.push(`mark is "${m}", config has "${expected.mark}"`);
  for (const t of parsed.taglines) if (t !== expected.tagline) out.push(`tagline is "${t}", config has "${expected.tagline}"`);
  return out;
}

// ---- Merging several files into one store of card copy ----

export interface CardSource {
  file: string;
  created: string | null;
  sheet: number;
  slot: number;
  /** Mark and tagline as printed on this card in the source file. */
  mark: string;
  tagline: string;
}

export type ImportedCard = CardRecord & { source: CardSource };

export interface ImportFile {
  file: string;
  parsed: ParsedSheetFile;
  /** Fallback ordering when the file has no created time, for example the file mtime. */
  fallbackTime?: string;
}

export interface DuplicateNote {
  key: string;
  name: string;
  kept: string;
  dropped: string[];
  /** True when every dropped version had the same printed text as the kept one. */
  identical: boolean;
}

export interface ImportResult {
  cards: ImportedCard[];
  duplicates: DuplicateNote[];
  /** Names shared by more than one kept card (different producer or pack size). For review. */
  sharedNames: Array<{ name: string; cards: string[] }>;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Dedupe key: the scale code for weight goods. Unit goods carry no code, so
 * their full name is the name plus the producer (the part before the middle
 * dot) plus the pack size. The name alone is not enough: the reference cards
 * hold the same product name from two makers, and one product sold both by
 * the pound and in a fixed pack.
 */
export function cardKey(c: CardRecord): string {
  if (c.code.trim()) return `code:${c.code.trim()}`;
  const brand = c.producer.split('·')[0] ?? '';
  return `name:${norm(cardName(c))}|${norm(brand)}|${norm(c.unit)}`;
}

const printed = (c: CardRecord): string =>
  JSON.stringify([c.code, c.price, c.unit, c.origin, c.eyebrow, c.n1, c.n2, c.producer, c.specs, c.copy]);

/** Merges files, keeping the newest file's version of each card. */
export function mergeImports(files: ImportFile[]): ImportResult {
  const time = (f: ImportFile) => f.parsed.created ?? f.fallbackTime ?? '';
  // Oldest first, so a newer file overwrites an older one.
  const ordered = [...files].sort((a, b) => time(a).localeCompare(time(b)) || a.file.localeCompare(b.file));
  const byKey = new Map<string, ImportedCard>();
  const history = new Map<string, ImportedCard[]>();
  for (const f of ordered) {
    f.parsed.slots.forEach((c, i) => {
      if (!c) return;
      const card: ImportedCard = {
        ...c,
        source: {
          file: f.file,
          created: f.parsed.created,
          sheet: Math.floor(i / 4) + 1,
          slot: (i % 4) + 1,
          mark: f.parsed.templates[i]?.mark ?? '',
          tagline: f.parsed.templates[i]?.tagline ?? '',
        },
      };
      const key = cardKey(c);
      const prev = byKey.get(key);
      if (prev) history.set(key, [...(history.get(key) ?? []), prev]);
      byKey.set(key, card);
    });
  }
  const duplicates: DuplicateNote[] = [...history].map(([key, older]) => {
    const kept = byKey.get(key) as ImportedCard;
    return {
      key,
      name: cardName(kept),
      kept: kept.source.file,
      dropped: older.map((o) => `${o.source.file} sheet ${o.source.sheet} slot ${o.source.slot}`),
      identical: older.every((o) => printed(o) === printed(kept)),
    };
  });
  const cards = [...byKey.values()];
  const byName = new Map<string, ImportedCard[]>();
  for (const c of cards) byName.set(norm(cardName(c)), [...(byName.get(norm(cardName(c))) ?? []), c]);
  const sharedNames = [...byName.values()]
    .filter((v) => v.length > 1)
    .map((v) => ({ name: cardName(v[0]), cards: v.map((c) => `${c.producer} ${c.unit} ${c.price} (${c.source.file})`) }));
  return { cards, duplicates, sharedNames };
}
