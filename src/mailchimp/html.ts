// Reading and editing the fish email's custom HTML. Pure: text in, text out, nothing sent.
//
// A fish row in the email is, with any attributes on each tag:
//   <b ...>$NN.NN<small>/UNIT</small></b><b ...>NAME</b><span ...> (ORIGIN)</span>
// The span is optional. Only the price text of a row is ever replaced, at its exact place, so
// every other byte of the email stays as staff wrote it. A price anywhere else in the email (the
// turkey's, for one) is not inside a row and is never touched.
//
// What ShelfReady changes:
// - the price text of rows whose price changed, only when the row has exactly the expected shape;
// - one date line at the very top, marked by a class so a later edit updates it instead of adding
//   another. Mailchimp keeps class attributes in custom HTML (the saved campaigns are full of
//   them); none of the saved campaigns hold an HTML comment or a data attribute, so neither is
//   relied on.
// Anything that does not have the expected shape is refused, with the reason, never guessed at.
//
// The HTML comes from Mailchimp, where anyone with access to the account can change it, so it is
// read in linear time: one pass finds every tag (a pattern that cannot backtrack), and rows, the
// date line and the top table are then found by walking that list in code. HTML over 1 MB is
// refused outright. A test checks 1 MB of hostile tags takes well under 200 ms.

import type { MailchimpConfig } from './config.ts';

export interface FishRow {
  /** The row's key: the name and the bracket text, as a reader sees them ("Striped Bass (Farmed)"). */
  key: string;
  name: string;
  origin: string;
  /** The price text as it stands ("$42.99", "Call", "$210"). */
  priceText: string;
  /** The unit text without the slash ("lb"), or "" when there is none. */
  unit: string;
  /** Cents, when the price has the expected shape ($NN.NN). */
  cents: number | null;
  /** The section heading above the row, or "". */
  section: string;
  /** Where the price text sits in the HTML. */
  priceStart: number;
  priceEnd: number;
}

export const PRICE_SHAPE = /^\$(\d{1,4})\.(\d{2})$/;
/** The fish email is about 100 to 160 KB. Anything over this is refused, not read. */
export const MAX_HTML_CHARS = 1_000_000;

export class HtmlTooBig extends Error {
  constructor() {
    super('The email is over 1 MB, so ShelfReady did not read it.');
    this.name = 'HtmlTooBig';
  }
}

interface Tag {
  name: string;
  close: boolean;
  attrs: string;
  start: number;
  end: number;
}

// One tag. The lookahead stops the name from giving characters back to the attributes, so a
// failed match never backtracks: each try ends at the next < or >.
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9])([^<>]*)>/g;

/** Every tag, in order, in one linear pass. Throws HtmlTooBig. */
function tagsOf(html: string): Tag[] {
  if (html.length > MAX_HTML_CHARS) throw new HtmlTooBig();
  const out: Tag[] = [];
  for (const m of html.matchAll(TAG)) out.push({ name: m[2]!.toLowerCase(), close: m[1] === '/', attrs: m[3]!, start: m.index!, end: m.index! + m[0].length });
  return out;
}

/** The class names on a tag. */
function classesOf(t: Tag): string[] {
  const i = t.attrs.search(/(^|\s)class="/i);
  if (i < 0) return [];
  const from = t.attrs.indexOf('"', i) + 1;
  const to = t.attrs.indexOf('"', from);
  return to < 0 ? [] : t.attrs.slice(from, to).split(/\s+/).filter(Boolean);
}

/** The text between two tags, or null when it holds anything that is not plain text. */
function between(html: string, a: Tag, b: Tag): string | null {
  const text = html.slice(a.end, b.start);
  return text.includes('<') || text.includes('>') ? null : text;
}

function isTag(t: Tag | undefined, name: string, close: boolean): t is Tag {
  return t !== undefined && t.name === name && t.close === close;
}

/** The section headings, with where each starts. */
function sectionsOf(html: string, tags: readonly Tag[]): Array<{ at: number; name: string }> {
  const out: Array<{ at: number; name: string }> = [];
  for (let i = 0; i + 1 < tags.length; i++) {
    const t = tags[i]!;
    if (!isTag(t, 'span', false) || !t.attrs.includes('font:24px') || !isTag(tags[i + 1], 'span', true)) continue;
    const text = between(html, t, tags[i + 1]!);
    if (text !== null) out.push({ at: t.start, name: decodeEntities(text).trim() });
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', ndash: '\u2013', mdash: '\u2014', rsquo: '\u2019', lsquo: '\u2018', rarr: '→' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10});/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The key a row is matched by: decoded, spaces folded, the bracket text kept. */
export function rowKey(name: string, origin: string): string {
  return `${name} ${origin}`.replace(/\s+/g, ' ').trim();
}

/** Folds a key for comparing: case, curly quotes and spacing do not count. */
export function foldKey(key: string): string {
  return key.normalize('NFKC').replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function centsText(cents: number): string {
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/**
 * Every fish row in the email, in order. A row is these tags in a row, with only plain text
 * between them and nothing else (spaces allowed between the two b tags and before the span):
 *   <b ...> price <small> unit </small></b> <b ...> name </b> [<span ...> origin </span>]
 * HTML over 1 MB gives no rows.
 */
export function parseRows(html: string): FishRow[] {
  let tags: Tag[];
  try {
    tags = tagsOf(html);
  } catch {
    return [];
  }
  const sections = sectionsOf(html, tags);
  let si = -1;
  const out: FishRow[] = [];
  for (let i = 0; i + 5 < tags.length; i++) {
    const [b1, sm1, sm2, b2, n1, n2] = [tags[i], tags[i + 1], tags[i + 2], tags[i + 3], tags[i + 4], tags[i + 5]];
    if (!isTag(b1, 'b', false) || !isTag(sm1, 'small', false) || sm1.attrs !== '' || !isTag(sm2, 'small', true) || sm2.attrs !== '') continue;
    if (!isTag(b2, 'b', true) || !isTag(n1, 'b', false) || !isTag(n2, 'b', true) || b2.attrs !== '' || n2.attrs !== '') continue;
    const priceText = between(html, b1, sm1);
    const unitRaw = between(html, sm1, sm2);
    const nameRaw = between(html, n1, n2);
    if (priceText === null || unitRaw === null || nameRaw === null || html.slice(sm2.end, b2.start) !== '') continue;
    const gap = between(html, b2, n1);
    if (gap === null || gap.trim() !== '') continue;
    let originRaw = '';
    const [o1, o2] = [tags[i + 6], tags[i + 7]];
    if (isTag(o1, 'span', false) && isTag(o2, 'span', true) && o2.attrs === '') {
      const gap2 = between(html, n2, o1);
      const text = between(html, o1, o2);
      if (gap2 !== null && gap2.trim() === '' && text !== null) originRaw = text;
    }
    const name = decodeEntities(nameRaw).replace(/\s+/g, ' ').trim();
    const origin = decodeEntities(originRaw).replace(/\s+/g, ' ').trim();
    const unit = unitRaw.trim();
    const shape = PRICE_SHAPE.exec(priceText);
    // Sections and rows are both in order, so one pointer walks the sections.
    while (si + 1 < sections.length && sections[si + 1]!.at < b1.start) si++;
    out.push({
      key: rowKey(name, origin),
      name,
      origin,
      priceText,
      unit: unit.startsWith('/') ? unit.slice(1) : unit,
      cents: shape ? Number(shape[1]) * 100 + Number(shape[2]) : null,
      section: si >= 0 ? sections[si]!.name : '',
      priceStart: b1.end,
      priceEnd: b1.end + priceText.length,
    });
    i += 5;
  }
  return out;
}

/**
 * Not used yet: kept for step 11b. The section headings, in order. Step 11b (new fish) adds a row at the end of a section: by
 * default the config's newFishSection, or a salmon, tuna or shellfish section when the fish is
 * clearly one of those. The insert belongs here, beside editEmail, built from the row shape above.
 */
export function sectionNames(html: string): string[] {
  try {
    return sectionsOf(html, tagsOf(html)).map((x) => x.name);
  } catch {
    return [];
  }
}

/** Why a row cannot be changed by ShelfReady, or null when it can. */
export function rowProblem(row: FishRow, units: MailchimpConfig['units']): string | null {
  if (row.cents === null) return `its price "${row.priceText}" is not a price like $12.99, so ShelfReady will not change it. Change it by hand in Mailchimp.`;
  if (!Object.hasOwn(units, row.unit)) return `it is sold by the ${row.unit || 'piece'} in the email, a unit ShelfReady does not compare with Square. Change it by hand in Mailchimp.`;
  return null;
}

export interface PriceEdit {
  /** The row key, as in the matches file. */
  key: string;
  toCents: number;
}

export interface RowChange {
  key: string;
  section: string;
  unit: string;
  fromText: string;
  toText: string;
  /** A short before and after of the HTML around the price, for review. */
  before: string;
  after: string;
}

export interface RowRefusal {
  key: string;
  why: string;
}

export interface DateLine {
  /** The text there now, or null when the email has no date line yet. */
  from: string | null;
  to: string;
  inserted: boolean;
}

export interface EditResult {
  html: string;
  changes: RowChange[];
  /** Rows already at the new price. */
  same: string[];
  refused: RowRefusal[];
  dateLine: DateLine | null;
  /** Why the date line could not be set, or ''. The rest of the edit still stands. */
  dateLineProblem: string;
}

/** Finds the date line: a cell carrying the marker class, holding plain text. Null when there is none. HTML over 1 MB throws HtmlTooBig. */
export function findDateLine(html: string, cls: string, known?: readonly Tag[]): { start: number; end: number; text: string; count: number } | null {
  const tags = known ?? tagsOf(html);
  const all: Array<{ start: number; end: number; text: string }> = [];
  for (let i = 0; i + 1 < tags.length; i++) {
    const t = tags[i]!;
    if (!isTag(t, 'td', false) || !classesOf(t).includes(cls) || !isTag(tags[i + 1], 'td', true)) continue;
    const text = between(html, t, tags[i + 1]!);
    if (text !== null) all.push({ start: t.end, end: t.end + text.length, text: decodeEntities(text).trim() });
  }
  if (!all.length) return null;
  return { ...all[0]!, count: all.length };
}

/** The new date line row, in the email's own style from the config. */
export function dateLineRow(cfg: MailchimpConfig['dateLine'], text: string): string {
  return `<tr><td class="${cfg.class}" align="center" style="${cfg.style}">${escapeText(text)}</td></tr>`;
}

/** Sets the date line, adding it as the first row of the top table when the email has none. */
export function setDateLine(html: string, cfg: MailchimpConfig['dateLine'], text: string): { html: string; line: DateLine | null; problem: string } {
  let tags: Tag[];
  try {
    tags = tagsOf(html);
  } catch (err) {
    return { html, line: null, problem: (err as Error).message };
  }
  const found = findDateLine(html, cfg.class, tags);
  if (found) {
    if (found.count > 1) return { html, line: null, problem: 'The email has more than one date line. Remove the extra one in Mailchimp.' };
    if (found.text === text) return { html, line: { from: found.text, to: text, inserted: false }, problem: '' };
    return { html: html.slice(0, found.start) + escapeText(text) + html.slice(found.end), line: { from: found.text, to: text, inserted: false }, problem: '' };
  }
  if (html.includes(`${cfg.class}`)) return { html, line: null, problem: 'The date line marker is in the email, but not in the expected shape. Fix it in Mailchimp, or remove it so ShelfReady adds it again.' };
  const tables = tags.map((t, i) => ({ t, i })).filter(({ t }) => isTag(t, 'table', false) && classesOf(t).includes(cfg.topTableClass));
  if (tables.length !== 1) return { html, line: null, problem: 'The email does not have the expected top table, so ShelfReady did not add the date line. The layout may have changed.' };
  const { t, i } = tables[0]!;
  // The top table's first row must be a plain <tr>, so the new row sits beside it.
  const next = tags[i + 1];
  const gap = next ? between(html, t, next) : null;
  if (!isTag(next, 'tr', false) || gap === null || gap.trim() !== '') return { html, line: null, problem: 'The top of the email is not in the expected shape, so ShelfReady did not add the date line.' };
  return { html: html.slice(0, t.end) + dateLineRow(cfg, text) + html.slice(t.end), line: { from: null, to: text, inserted: true }, problem: '' };
}

function snippet(html: string, start: number, end: number, replacement: string): { before: string; after: string } {
  const a = Math.max(0, start - 60);
  const b = Math.min(html.length, end + 80);
  return { before: html.slice(a, b), after: html.slice(a, start) + replacement + html.slice(end, b) };
}

/**
 * Applies price edits and the date line. A row is changed only when it is found exactly once
 * and has the expected shape and a unit ShelfReady compares. Everything else is refused, listed
 * with its reason, and left as it is.
 */
export function editEmail(html: string, edits: readonly PriceEdit[], opts: { units: MailchimpConfig['units']; dateLine: MailchimpConfig['dateLine']; dateText: string | null }): EditResult {
  if (html.length > MAX_HTML_CHARS) {
    const why = new HtmlTooBig().message;
    return { html, changes: [], same: [], refused: edits.map((e) => ({ key: e.key, why })), dateLine: null, dateLineProblem: why };
  }
  const rows = parseRows(html);
  const byKey = new Map<string, FishRow[]>();
  for (const r of rows) {
    const k = foldKey(r.key);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  const changes: RowChange[] = [];
  const same: string[] = [];
  const refused: RowRefusal[] = [];
  const replace: Array<{ start: number; end: number; text: string }> = [];
  const seen = new Set<string>();
  for (const e of edits) {
    const k = foldKey(e.key);
    if (seen.has(k)) {
      refused.push({ key: e.key, why: 'asked to change twice in one edit.' });
      continue;
    }
    seen.add(k);
    const found = byKey.get(k) ?? [];
    if (found.length === 0) {
      refused.push({ key: e.key, why: 'this row is not in the email now. Staff may have removed or renamed it.' });
      continue;
    }
    if (found.length > 1) {
      refused.push({ key: e.key, why: 'the email has more than one row with this name, so ShelfReady cannot tell which to change.' });
      continue;
    }
    const row = found[0]!;
    const problem = rowProblem(row, opts.units);
    if (problem) {
      refused.push({ key: e.key, why: problem });
      continue;
    }
    if (!Number.isInteger(e.toCents) || e.toCents <= 0 || e.toCents >= 1_000_000) {
      refused.push({ key: e.key, why: 'the new price is not a usable amount.' });
      continue;
    }
    if (row.cents === e.toCents) {
      same.push(row.key);
      continue;
    }
    const toText = centsText(e.toCents);
    const s = snippet(html, row.priceStart, row.priceEnd, toText);
    changes.push({ key: row.key, section: row.section, unit: row.unit, fromText: row.priceText, toText, before: s.before, after: s.after });
    replace.push({ start: row.priceStart, end: row.priceEnd, text: toText });
  }
  // Replace from the end, so earlier offsets stay right.
  let out = html;
  for (const r of replace.sort((a, b) => b.start - a.start)) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  let dateLine: DateLine | null = null;
  let dateLineProblem = '';
  if (opts.dateText !== null) {
    const d = setDateLine(out, opts.dateLine, opts.dateText);
    out = d.html;
    dateLine = d.line;
    dateLineProblem = d.problem;
  }
  return { html: out, changes, same, refused, dateLine, dateLineProblem };
}

/**
 * Checks what Mailchimp holds after an edit: the date line reads as it should, and every changed
 * row shows its new price. Returns what is wrong, or [] when all is right.
 */
export function verifyEmail(html: string, expected: { dateText: string | null; prices: Array<{ key: string; toText: string }>; dateLineClass: string }): string[] {
  const out: string[] = [];
  if (html.length > MAX_HTML_CHARS) return [new HtmlTooBig().message];
  if (expected.dateText !== null) {
    const d = findDateLine(html, expected.dateLineClass);
    if (!d || d.count !== 1 || d.text !== expected.dateText) out.push('the date line does not read as it should');
  }
  const rows = parseRows(html);
  const byKey = new Map<string, FishRow[]>();
  for (const x of rows) {
    const k = foldKey(x.key);
    const list = byKey.get(k);
    if (list) list.push(x);
    else byKey.set(k, [x]);
  }
  for (const p of expected.prices) {
    const r = byKey.get(foldKey(p.key)) ?? [];
    if (r.length !== 1 || r[0]!.priceText !== p.toText) out.push(`${p.key} does not show ${p.toText}`);
  }
  return out;
}

/** One span cut out of the email by a removal: the row itself, or the divider of the new last row. */
export interface Cut {
  what: 'row' | 'divider';
  start: number;
  end: number;
  text: string;
}

export type RowRemoval =
  | { kind: 'removed'; html: string; cuts: Cut[]; row: FishRow; dividerFrom: string | null }
  | { kind: 'absent' }
  | { kind: 'refused'; why: string };

/** A divider is one inline style declaration like "border-bottom:1px solid #d0cdc5;". */
export const DIVIDER_SHAPE = /^border-bottom:[^;"<>]*;$/;

interface Cell {
  row: FishRow;
  tr: number;
  td: number;
  trClose: number;
}

/** The table row holding a fish row, when it is exactly one cell starting with the row's price. */
function cellOf(html: string, tags: readonly Tag[], rows: readonly FishRow[], row: FishRow): Cell | string {
  const b = tags.findIndex((t) => isTag(t, 'b', false) && t.end === row.priceStart);
  const td = tags[b - 1];
  const tr = tags[b - 2];
  const blank = (a: Tag, z: Tag): boolean => html.slice(a.end, z.start).trim() === '';
  if (b < 2 || !isTag(td, 'td', false) || !isTag(tr, 'tr', false) || !blank(tr, td) || !blank(td, tags[b]!)) {
    return 'The row is not the only thing at the start of its own table row, so ShelfReady will not guess what to remove.';
  }
  // The cell must close before any other cell, row or table opens, then the row must close.
  let i = b + 1;
  for (; i < tags.length; i++) if (['td', 'tr', 'table', 'th', 'tbody'].includes(tags[i]!.name)) break;
  const tdClose = tags[i];
  const trClose = tags[i + 1];
  if (!isTag(tdClose, 'td', true) || !isTag(trClose, 'tr', true) || !blank(tdClose, trClose)) {
    return "The row's table cell holds other cells, rows or tables, so ShelfReady will not guess what to remove.";
  }
  if (rows.some((r) => r !== row && r.priceStart >= tr.start && r.priceStart < trClose.end)) return 'Another fish row shares the same table row, so ShelfReady will not remove it.';
  return { row, tr: b - 2, td: b - 1, trClose: i + 1 };
}

/** True when the table ends right after this cell: the row is the last in its section's list. */
function lastInTable(html: string, tags: readonly Tag[], c: Cell): boolean {
  const next = tags[c.trClose + 1];
  return isTag(next, 'table', true) && html.slice(tags[c.trClose]!.end, next.start).trim() === '';
}

/**
 * Removes one row from the email: the smallest element that is exactly that row, a table row
 * (<tr>) holding one cell (<td>) whose content starts with the row's price. Refused when the row
 * is there more than once, or its markup is not exactly that shape.
 *
 * When the row is the last in its section, the row above becomes last. In the fish email the last
 * row of every section has no bottom divider, and the others have one. So the divider of the new
 * last row goes too, found by comparing its cell with the last rows of the other sections: those
 * must all be built the same, and the new last row's cell must be exactly that plus one
 * declaration shaped like "border-bottom:...;". That declaration is the only other thing cut. If
 * anything is not exactly so, nothing is removed. A one-off edit Bart authorizes by hand; the
 * worker never removes rows.
 */
export function removeRow(html: string, key: string): RowRemoval {
  let tags: Tag[];
  try {
    tags = tagsOf(html);
  } catch (err) {
    return { kind: 'refused', why: (err as Error).message };
  }
  const rows = parseRows(html);
  const found = rows.filter((r) => foldKey(r.key) === foldKey(key));
  if (found.length === 0) return { kind: 'absent' };
  if (found.length > 1) return { kind: 'refused', why: `The email has ${found.length} rows named "${key}", so ShelfReady cannot tell which to remove.` };
  const row = found[0]!;
  const cell = cellOf(html, tags, rows, row);
  if (typeof cell === 'string') return { kind: 'refused', why: cell };
  const cuts: Cut[] = [{ what: 'row', start: tags[cell.tr]!.start, end: tags[cell.trClose]!.end, text: html.slice(tags[cell.tr]!.start, tags[cell.trClose]!.end) }];
  let dividerFrom: string | null = null;
  if (lastInTable(html, tags, cell)) {
    const cells = rows.map((r) => (r === row ? null : cellOf(html, tags, rows, r))).filter((c): c is Cell => c !== null && typeof c !== 'string');
    const prev = cells.find((c) => c.trClose === cell.tr - 1 && html.slice(tags[c.trClose]!.end, tags[cell.tr]!.start).trim() === '');
    if (!prev) return { kind: 'refused', why: 'The row is the last in its section, and the row above it is not a fish row in the expected shape, so ShelfReady removed nothing.' };
    const others = cells.filter((c) => c !== prev && lastInTable(html, tags, c)).map((c) => tags[c.td]!.attrs);
    if (!others.length) return { kind: 'refused', why: 'No other section has a last row to compare with, so ShelfReady cannot tell how a last row is built. It removed nothing.' };
    if (others.some((a) => a !== others[0])) return { kind: 'refused', why: "The other sections' last rows are not all built the same, so ShelfReady cannot tell how a last row is built. It removed nothing." };
    const last = others[0]!;
    const mine = tags[prev.td]!.attrs;
    if (mine !== last) {
      let p = 0;
      while (p < last.length && mine[p] === last[p]) p++;
      const mid = mine.slice(p, p + mine.length - last.length);
      const rebuilt = mine.slice(0, p) + mine.slice(p + mid.length);
      if (mine.length <= last.length || rebuilt !== last || !DIVIDER_SHAPE.test(mid) || last.includes('border-bottom')) {
        return { kind: 'refused', why: "The row above differs from the other sections' last rows in a way that is not just a bottom divider, so ShelfReady removed nothing." };
      }
      // The cell's attributes start right after "<td".
      const start = tags[prev.td]!.start + 3 + p;
      cuts.push({ what: 'divider', start, end: start + mid.length, text: mid });
      dividerFrom = prev.row.key;
    }
  }
  cuts.sort((a, b) => a.start - b.start);
  return { kind: 'removed', html: cutOut(html, cuts), cuts, row, dividerFrom };
}

function cutOut(html: string, cuts: readonly Cut[]): string {
  let out = '';
  let at = 0;
  for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
    out += html.slice(at, c.start);
    at = c.end;
  }
  return out + html.slice(at);
}

/**
 * Checks a removal: after must be before with exactly these cuts and nothing else: the one row,
 * and at most one divider shaped like "border-bottom:...;" inside a cell's opening tag. Then the
 * rows are read again: the rows after must be the rows before minus the one removed, each with the
 * same name, bracket text, price, unit and section, in order. Returns what is wrong, or [].
 */
export function checkRemoval(before: string, after: string, key: string, cuts: readonly Cut[]): string[] {
  const out: string[] = [];
  const rowCuts = cuts.filter((c) => c.what === 'row');
  const dividers = cuts.filter((c) => c.what === 'divider');
  if (rowCuts.length !== 1 || dividers.length > 1 || rowCuts.length + dividers.length !== cuts.length) out.push('The removal is not one row and at most one divider.');
  for (const c of cuts) if (before.slice(c.start, c.end) !== c.text) out.push('A cut does not match the email.');
  for (const d of dividers) {
    const open = before.lastIndexOf('<', d.start);
    const close = before.indexOf('>', d.end);
    if (!DIVIDER_SHAPE.test(d.text) || !/^<td\s/i.test(before.slice(open, open + 4)) || before.slice(d.end, close).includes('<')) out.push('The divider cut is not one declaration inside a cell.');
  }
  if (after !== cutOut(before, cuts)) out.push('The email is not exactly the original minus the row and the divider.');
  const k = foldKey(key);
  const a = parseRows(before).filter((r) => foldKey(r.key) !== k);
  const b = parseRows(after);
  if (b.some((r) => foldKey(r.key) === k)) out.push(`"${key}" is still in the email.`);
  const same = (x: FishRow, y: FishRow): boolean => x.key === y.key && x.priceText === y.priceText && x.unit === y.unit && x.section === y.section;
  if (a.length !== b.length) out.push(`The email has ${b.length} rows, not the ${a.length} expected.`);
  else
    a.forEach((x, i) => {
      if (!same(x, b[i]!)) out.push(`Row ${i + 1} changed: "${x.key}" ${x.priceText} became "${b[i]!.key}" ${b[i]!.priceText}.`);
    });
  return out;
}
