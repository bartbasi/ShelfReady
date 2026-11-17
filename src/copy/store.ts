// The card store: one card per product, with every change kept (migration 5).
//
// - A card is linked to a Square variation, one link per catalog (card_links): variation ids
//   differ between the sandbox and live accounts, so a link holds only in the catalog it was made
//   in. A link survives the item gaining a scale code, since the variation id does not change;
//   the code is recorded too (recordScaleCode).
// - At most one card per variation in a catalog. When two cards could serve one product, an
//   edited card wins, then an imported one, then a generated one (decision 5). A card that loses
//   is retired, never deleted, and loses its links.
// - Every change writes card_history (who, when, before, after) and the audit log.
// - Imported text is kept exactly as printed. Edited text is cleaned of characters a card cannot
//   show and checked for shape, never for length: only the rendered checks judge it.
// - Every generated card needs a person's check of its current version before it prints,
//   whatever its verify list holds. A card the guard blocked needs an edit that removes the
//   finding (src/copy/checks.ts guardProblems).
// - Price and scale code are never card text. A printed card takes them from pricing and Square.

import { cardKey, type ImportedCard } from '../cards/import.ts';
import { appendAudit, type AuditActor } from '../db/audit.ts';
import { inTransaction, type Db } from '../db/db.ts';
import { fullName, guardProblems } from './checks.ts';
import { cleanText, nameKeyOf } from './text.ts';
import {
  CopyError,
  type CardContent,
  type CardLink,
  type CardReview,
  type CardSource,
  type CopyCatalog,
  type FirstSource,
  type LinkMethod,
  type PrintedInfo,
  type ProductFacts,
  type StoredCard,
} from './types.ts';

/** Which card wins when two could serve one product. */
export const PRECEDENCE: Readonly<Record<CardSource, number>> = { generated: 1, imported: 2, edited: 3 };

export type HistoryChange = 'created' | 'reimported' | 'edited' | 'linked' | 'unlinked' | 'code_seen' | 'checked' | 'retired';

export interface CardHistoryEntry {
  id: number;
  cardId: number;
  version: number;
  at: string;
  userId: number | null;
  username: string;
  change: HistoryChange;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

interface CardRow {
  id: number;
  scale_code: string;
  name_key: string;
  import_key: string;
  source: CardSource;
  first_source: FirstSource;
  content: string;
  printed: string;
  review: string;
  blocked: string;
  version: number;
  checked_version: number;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  card_id: number;
  catalog: string;
  catalog_source: string;
  variation_id: string;
  item_id: string;
  label: string;
  method: LinkMethod;
  linked_at: string;
}

const iso = (now: number) => new Date(now).toISOString();
const CODE_RE = /^\d{4}$/;

/**
 * The key a catalog's links are kept under: its Square location id, which names its id space.
 * A catalog with no location id is refused: its links could not be told from another catalog's.
 */
export function catalogKey(catalog: CopyCatalog | { index: { locationId: string } }): string {
  const id = catalog.index.locationId.trim();
  if (id === '') throw new CopyError('This catalog has no Square location id, so card links cannot be kept for it. Set the location id in settings, or use a catalog saved with one.');
  return id;
}

function parseObject(text: string): Record<string, unknown> {
  const v = JSON.parse(text) as unknown;
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function toLink(r: LinkRow): CardLink {
  return { catalog: r.catalog, catalogSource: r.catalog_source, variationId: r.variation_id, itemId: r.item_id, label: r.label, method: r.method, linkedAt: r.linked_at };
}

function toCard(r: CardRow, links: CardLink[]): StoredCard {
  const printed = parseObject(r.printed);
  const review = parseObject(r.review);
  const blocked = JSON.parse(r.blocked) as unknown;
  return {
    id: r.id,
    links,
    scaleCode: r.scale_code,
    nameKey: r.name_key,
    importKey: r.import_key,
    source: r.source,
    firstSource: r.first_source,
    content: JSON.parse(r.content) as CardContent,
    printed: Object.keys(printed).length ? (printed as unknown as PrintedInfo) : null,
    review: Object.keys(review).length ? (review as unknown as CardReview) : null,
    blocked: Array.isArray(blocked) ? blocked.filter((b): b is string => typeof b === 'string') : [],
    version: r.version,
    checkedVersion: r.checked_version,
    retiredAt: r.retired_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function linksOf(db: Db, cardIds: number[] | null): Map<number, CardLink[]> {
  const rows = (
    cardIds === null
      ? db.prepare('SELECT * FROM card_links ORDER BY card_id, catalog').all()
      : cardIds.length === 0
        ? []
        : db.prepare(`SELECT * FROM card_links WHERE card_id IN (${cardIds.map(() => '?').join(',')}) ORDER BY card_id, catalog`).all(...cardIds)
  ) as unknown as LinkRow[];
  const out = new Map<number, CardLink[]>();
  for (const r of rows) out.set(r.card_id, [...(out.get(r.card_id) ?? []), toLink(r)]);
  return out;
}

export function getCard(db: Db, id: number): StoredCard | null {
  const r = db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
  return r ? toCard(r, linksOf(db, [r.id]).get(r.id) ?? []) : null;
}

/** Every live card, oldest first. A store has a few hundred, so this is cheap. */
export function liveCards(db: Db): StoredCard[] {
  const rows = db.prepare('SELECT * FROM cards WHERE retired_at IS NULL ORDER BY id').all() as unknown as CardRow[];
  const links = linksOf(db, null);
  return rows.map((r) => toCard(r, links.get(r.id) ?? []));
}

/** The card linked to a variation in a catalog, or null. Only live cards have links. */
export function liveCardForVariation(db: Db, catalog: string, variationId: string): StoredCard | null {
  const r = db.prepare('SELECT card_id FROM card_links WHERE catalog = ? AND variation_id = ?').get(catalog, variationId) as { card_id: number } | undefined;
  return r ? getCard(db, r.card_id) : null;
}

/** The card imported under this key, live or retired, or null. A key belongs to one card for good. */
export function cardByImportKey(db: Db, importKey: string): StoredCard | null {
  if (importKey === '') return null;
  const r = db.prepare('SELECT * FROM cards WHERE import_key = ?').get(importKey) as CardRow | undefined;
  return r ? toCard(r, linksOf(db, [r.id]).get(r.id) ?? []) : null;
}

/** The card's link in a catalog, if it has one. */
export function linkIn(card: StoredCard, catalog: string): CardLink | undefined {
  return card.links.find((l) => l.catalog === catalog);
}

export function cardHistory(db: Db, cardId: number): CardHistoryEntry[] {
  const rows = db.prepare('SELECT * FROM card_history WHERE card_id = ? ORDER BY id').all(cardId) as unknown as Array<{
    id: number;
    card_id: number;
    version: number;
    at: string;
    user_id: number | null;
    username: string;
    change: HistoryChange;
    before: string;
    after: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    cardId: r.card_id,
    version: r.version,
    at: r.at,
    userId: r.user_id,
    username: r.username,
    change: r.change,
    before: parseObject(r.before),
    after: parseObject(r.after),
  }));
}

function addHistory(db: Db, actor: AuditActor, cardId: number, version: number, change: HistoryChange, before: Record<string, unknown>, after: Record<string, unknown>, now: number): void {
  db.prepare('INSERT INTO card_history (card_id, version, at, user_id, username, change, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    cardId,
    version,
    iso(now),
    actor.userId,
    actor.username,
    change,
    JSON.stringify(before),
    JSON.stringify(after),
  );
}

function audit(db: Db, actor: AuditActor, action: string, cardId: number, details: Record<string, unknown>, now: number): void {
  appendAudit(db, actor, { action, entityType: 'card', entityId: cardId, details }, now);
}

// ---- Shape of card text ----

/** Longest text kept per field. Far above any real card: these only stop junk. */
const MAX_LEN = { origin: 80, eyebrow: 60, n1: 80, n2: 80, producer: 160, label: 40, value: 80, paragraph: 1500, unit: 40 } as const;
const MAX_PARAGRAPHS = 4;

/**
 * Checks that a value is card text: every field a string within MAX_LEN, three specs, one to
 * four paragraphs, a name, no line breaks or tabs (a card cell cannot hold them). Throws
 * CopyError naming the field.
 */
export function checkContentShape(value: unknown): CardContent {
  const c = value as Partial<Record<keyof CardContent, unknown>> | null;
  if (!c || typeof c !== 'object') throw new CopyError('The card text is missing.');
  const text = (field: keyof typeof MAX_LEN, v: unknown, label: string): string => {
    if (typeof v !== 'string') throw new CopyError(`${label} must be text.`);
    if (/[\n\r\t]/.test(v)) throw new CopyError(`${label} may not contain a line break or tab.`);
    if (v.length > MAX_LEN[field]) throw new CopyError(`${label} is longer than ${MAX_LEN[field]} characters.`);
    return v;
  };
  if (!Array.isArray(c.specs) || c.specs.length !== 3) throw new CopyError('A card needs exactly three specs.');
  const specs = c.specs.map((s, i) => {
    if (!Array.isArray(s) || s.length !== 2) throw new CopyError(`Spec ${i + 1} needs a label and a value.`);
    return [text('label', s[0], `Spec ${i + 1} label`), text('value', s[1], `Spec ${i + 1} value`)];
  }) as CardContent['specs'];
  if (!Array.isArray(c.copy) || c.copy.length < 1 || c.copy.length > MAX_PARAGRAPHS) throw new CopyError(`The copy needs one to ${MAX_PARAGRAPHS} paragraphs.`);
  const copy = c.copy.map((p, i) => text('paragraph', p, `Paragraph ${i + 1}`));
  if (copy.every((p) => p.trim() === '')) throw new CopyError('The copy is empty.');
  const out: CardContent = {
    origin: text('origin', c.origin, 'The origin'),
    eyebrow: text('eyebrow', c.eyebrow, 'The category'),
    n1: text('n1', c.n1, 'The first part of the name'),
    n2: text('n2', c.n2, 'The second part of the name'),
    producer: text('producer', c.producer, 'The producer'),
    specs,
    copy,
    unit: text('unit', c.unit, 'The unit'),
  };
  if (fullName(out) === '') throw new CopyError('The name is empty.');
  return out;
}

/**
 * An edit cleaned the way generated text is (src/copy/text.ts cleanText): only characters a
 * card can show, one plain space between words, n1 ending in a space. Values that are not text
 * are left as they are for checkContentShape to refuse.
 */
function cleanEdit(value: Record<string, unknown>): Record<string, unknown> {
  const t = (v: unknown) => (typeof v === 'string' ? cleanText(v) : v);
  const n1 = t(value.n1);
  return {
    origin: t(value.origin),
    eyebrow: t(value.eyebrow),
    n1: typeof n1 === 'string' && n1 !== '' ? `${n1} ` : n1,
    n2: t(value.n2),
    producer: t(value.producer),
    specs: Array.isArray(value.specs) ? value.specs.map((s) => (Array.isArray(s) ? s.map(t) : s)) : value.specs,
    copy: Array.isArray(value.copy) ? value.copy.map(t) : value.copy,
    unit: t(value.unit),
  };
}

function contentOf(card: ImportedCard): CardContent {
  return checkContentShape({
    origin: card.origin,
    eyebrow: card.eyebrow,
    n1: card.n1,
    n2: card.n2,
    producer: card.producer,
    specs: card.specs,
    copy: card.copy,
    unit: card.unit,
  });
}

function printedOf(card: ImportedCard): PrintedInfo {
  return { price: card.price, code: card.code, file: card.source.file, created: card.source.created, sheet: card.source.sheet, slot: card.source.slot };
}

/** The fields that differ, with their old and new values. */
function changedFields(a: CardContent, b: CardContent): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of Object.keys(a) as Array<keyof CardContent>) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
      before[k] = a[k];
      after[k] = b[k];
    }
  }
  return { before, after };
}

// ---- Writes ----

/** Adds a card imported from an existing card file. Not linked yet: see src/copy/import.ts. */
export function insertImportedCard(db: Db, actor: AuditActor, card: ImportedCard, now: number = Date.now()): StoredCard {
  const content = contentOf(card);
  const printed = printedOf(card);
  const code = CODE_RE.test(card.code.trim()) ? card.code.trim() : '';
  const importKey = cardKey(card);
  return inTransaction(db, () => {
    if (cardByImportKey(db, importKey)) throw new CopyError(`A card was imported under ${importKey} before.`);
    const res = db
      .prepare(
        `INSERT INTO cards (scale_code, name_key, import_key, source, first_source, content, printed, review, blocked, version, created_at, updated_at)
         VALUES (?, ?, ?, 'imported', 'imported', ?, ?, '{}', '[]', 1, ?, ?)`,
      )
      .run(code, nameKeyOf(fullName(content)), importKey, JSON.stringify(content), JSON.stringify(printed), iso(now), iso(now));
    const id = Number(res.lastInsertRowid);
    addHistory(db, actor, id, 1, 'created', {}, { source: 'imported', importKey, file: printed.file, sheet: printed.sheet, slot: printed.slot }, now);
    audit(db, actor, 'card_import', id, { importKey, name: fullName(content), file: printed.file, sheet: printed.sheet, slot: printed.slot }, now);
    return getCard(db, id)!;
  });
}

export type ReimportOutcome = 'reimported' | 'unchanged' | 'edited_kept' | 'retired_kept';

/**
 * A newer printing of an imported card replaces the stored text, unless a person edited it (an
 * edit is used until the next edit, decision 5) or the card was retired (it stays retired).
 */
export function reimportCard(db: Db, actor: AuditActor, existing: StoredCard, card: ImportedCard, now: number = Date.now()): ReimportOutcome {
  if (existing.retiredAt) return 'retired_kept';
  if (existing.source === 'edited') return 'edited_kept';
  const content = contentOf(card);
  const printed = printedOf(card);
  if (JSON.stringify(content) === JSON.stringify(existing.content) && JSON.stringify(printed) === JSON.stringify(existing.printed)) return 'unchanged';
  return inTransaction(db, () => {
    const version = existing.version + 1;
    const code = CODE_RE.test(card.code.trim()) ? card.code.trim() : existing.scaleCode;
    db.prepare('UPDATE cards SET content = ?, printed = ?, scale_code = ?, name_key = ?, version = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(content),
      JSON.stringify(printed),
      code,
      nameKeyOf(fullName(content)),
      version,
      iso(now),
      existing.id,
    );
    const diff = changedFields(existing.content, content);
    addHistory(db, actor, existing.id, version, 'reimported', { ...diff.before, printed: existing.printed }, { ...diff.after, printed }, now);
    audit(db, actor, 'card_reimport', existing.id, { file: printed.file, changed: Object.keys(diff.after) }, now);
    return 'reimported';
  });
}

/** Where a card is to be linked: a variation in one catalog. */
export interface LinkTarget {
  catalog: string;
  catalogSource: string;
  variationId: string;
  itemId: string;
  label: string;
  /** The item's scale code today, or null. */
  scaleCode: string | null;
}

export function linkTargetOf(p: ProductFacts): LinkTarget {
  return { catalog: p.catalog, catalogSource: p.catalogSource, variationId: p.variationId, itemId: p.itemId, label: p.label, scaleCode: p.scaleCode };
}

function insertLink(db: Db, cardId: number, t: LinkTarget, method: LinkMethod, now: number): void {
  db.prepare('INSERT INTO card_links (card_id, catalog, catalog_source, variation_id, item_id, label, method, linked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    cardId,
    t.catalog,
    t.catalogSource,
    t.variationId,
    t.itemId,
    t.label,
    method,
    iso(now),
  );
}

export interface GeneratedCardInput {
  product: ProductFacts;
  content: CardContent;
  review: CardReview;
  /** Guard findings left after the retry. The card cannot print until a person edits them out. */
  blocked: string[];
  /** Model, tokens, cost and sources, for the audit log. Never a key. */
  auditDetails: Record<string, unknown>;
}

/** Stores copy the model wrote, linked to its product. Refused when the product already has a card. */
export function insertGeneratedCard(db: Db, actor: AuditActor, input: GeneratedCardInput, now: number = Date.now()): StoredCard {
  const content = checkContentShape(input.content);
  const p = input.product;
  return inTransaction(db, () => {
    const existing = liveCardForVariation(db, p.catalog, p.variationId);
    if (existing) throw new CopyError(`${p.label} already has a card (number ${existing.id}). Use it, or edit it.`);
    const res = db
      .prepare(
        `INSERT INTO cards (scale_code, name_key, import_key, source, first_source, content, printed, review, blocked, version, created_at, updated_at)
         VALUES (?, ?, '', 'generated', 'generated', ?, '{}', ?, ?, 1, ?, ?)`,
      )
      .run(p.scaleCode ?? '', nameKeyOf(fullName(content)), JSON.stringify(content), JSON.stringify(input.review), JSON.stringify(input.blocked), iso(now), iso(now));
    const id = Number(res.lastInsertRowid);
    insertLink(db, id, linkTargetOf(p), 'generated', now);
    addHistory(db, actor, id, 1, 'created', {}, { source: 'generated', catalog: p.catalog, variationId: p.variationId, model: input.review.model, blocked: input.blocked }, now);
    audit(db, actor, 'card_generate', id, { catalog: p.catalog, variationId: p.variationId, label: p.label, blocked: input.blocked, ...input.auditDetails }, now);
    return getCard(db, id)!;
  });
}

const EDITABLE = ['origin', 'eyebrow', 'n1', 'n2', 'producer', 'specs', 'copy', 'unit'];

/**
 * A person's edit. expectedVersion is the version the person was shown, so an edit made over
 * someone else's newer one is refused. Price and code cannot be edited here: they are not card
 * text. A blocked card stays blocked while the guard still finds a price, phone number or web
 * address. Returns the card unchanged when nothing differs.
 */
export function editCard(db: Db, actor: AuditActor, id: number, expectedVersion: number, patch: Partial<CardContent>, now: number = Date.now()): StoredCard {
  for (const k of Object.keys(patch)) {
    if (!EDITABLE.includes(k)) throw new CopyError(`${k} cannot be edited on a card.`);
  }
  return inTransaction(db, () => {
    const card = getCard(db, id);
    if (!card || card.retiredAt) throw new CopyError('That card no longer exists.');
    if (card.version !== expectedVersion) throw new CopyError('Someone changed this card since you opened it. Open it again to see the change.');
    const next = checkContentShape(cleanEdit({ ...card.content, ...patch }));
    const diff = changedFields(card.content, next);
    if (Object.keys(diff.after).length === 0) return card;
    const blocked = card.blocked.length ? guardProblems(next).map((p) => p.message) : [];
    const version = card.version + 1;
    db.prepare("UPDATE cards SET content = ?, source = 'edited', name_key = ?, blocked = ?, version = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(next),
      nameKeyOf(fullName(next)),
      JSON.stringify(blocked),
      version,
      iso(now),
      id,
    );
    const blockChange = JSON.stringify(blocked) !== JSON.stringify(card.blocked) ? { before: { blocked: card.blocked }, after: { blocked } } : { before: {}, after: {} };
    addHistory(db, actor, id, version, 'edited', { ...diff.before, ...blockChange.before }, { ...diff.after, ...blockChange.after }, now);
    audit(db, actor, 'card_edit', id, { version, before: diff.before, after: diff.after, blocked }, now);
    return getCard(db, id)!;
  });
}

function retire(db: Db, actor: AuditActor, card: StoredCard, reason: string, now: number): void {
  db.prepare('UPDATE cards SET retired_at = ?, updated_at = ? WHERE id = ?').run(iso(now), iso(now), card.id);
  db.prepare('DELETE FROM card_links WHERE card_id = ?').run(card.id);
  addHistory(db, actor, card.id, card.version, 'retired', { links: card.links }, { reason }, now);
  audit(db, actor, 'card_retire', card.id, { links: card.links.map((l) => ({ catalog: l.catalog, variationId: l.variationId })), source: card.source, reason }, now);
}

export interface LinkResult {
  card: StoredCard;
  /** A card that lost its place to this one and was retired, or null. */
  retired: StoredCard | null;
}

/**
 * Links a card to a Square variation in one catalog. If another card holds the variation there,
 * the card with the higher precedence (edited, imported, generated) keeps it and the other is
 * retired. A tie or a weaker card is refused unless replace is set, which a person sets by
 * choosing this card over the other on screen.
 */
export function linkCard(db: Db, actor: AuditActor, id: number, target: LinkTarget, method: Exclude<LinkMethod, 'generated'>, opts: { replace?: boolean } = {}, now: number = Date.now()): LinkResult {
  if (target.variationId === '' || target.catalog === '') throw new CopyError('No Square item was chosen.');
  return inTransaction(db, () => {
    const card = getCard(db, id);
    if (!card || card.retiredAt) throw new CopyError('That card no longer exists.');
    const mine = linkIn(card, target.catalog);
    if (mine?.variationId === target.variationId) return { card, retired: null };
    if (mine) throw new CopyError('This card is linked to another Square item in this catalog. Unlink it first.');
    const other = liveCardForVariation(db, target.catalog, target.variationId);
    let retired: StoredCard | null = null;
    if (other) {
      const wins = PRECEDENCE[card.source] > PRECEDENCE[other.source];
      if (!wins && !opts.replace) {
        throw new CopyError(`${target.label} already has ${other.source === 'edited' ? 'an edited' : other.source === 'imported' ? 'an imported' : 'a generated'} card (number ${other.id}).`);
      }
      retire(db, actor, other, `replaced by card ${card.id} (${card.source})`, now);
      retired = getCard(db, other.id);
    }
    insertLink(db, id, target, method, now);
    const code = target.scaleCode ?? card.scaleCode;
    if (code !== card.scaleCode) db.prepare('UPDATE cards SET scale_code = ?, updated_at = ? WHERE id = ?').run(code, iso(now), id);
    addHistory(db, actor, id, card.version, 'linked', {}, { catalog: target.catalog, catalogSource: target.catalogSource, variationId: target.variationId, itemId: target.itemId, label: target.label, method, scaleCode: code }, now);
    audit(db, actor, 'card_link', id, { catalog: target.catalog, catalogSource: target.catalogSource, variationId: target.variationId, label: target.label, method, replaced: retired?.id ?? null }, now);
    return { card: getCard(db, id)!, retired };
  });
}

/** Removes a card's link in one catalog. */
export function unlinkCard(db: Db, actor: AuditActor, id: number, catalog: string, now: number = Date.now()): StoredCard {
  return inTransaction(db, () => {
    const card = getCard(db, id);
    if (!card || card.retiredAt) throw new CopyError('That card no longer exists.');
    const link = linkIn(card, catalog);
    if (!link) return card;
    db.prepare('DELETE FROM card_links WHERE card_id = ? AND catalog = ?').run(id, catalog);
    addHistory(db, actor, id, card.version, 'unlinked', { catalog, variationId: link.variationId, method: link.method }, { catalog, variationId: null }, now);
    audit(db, actor, 'card_unlink', id, { catalog, variationId: link.variationId }, now);
    return getCard(db, id)!;
  });
}

/** Records the scale code a linked card's item has now, for example one it gained since printing. */
export function recordScaleCode(db: Db, actor: AuditActor, id: number, code: string, now: number = Date.now()): StoredCard {
  if (!CODE_RE.test(code)) throw new CopyError('A scale code is four digits.');
  return inTransaction(db, () => {
    const card = getCard(db, id);
    if (!card || card.retiredAt) throw new CopyError('That card no longer exists.');
    if (card.scaleCode === code) return card;
    db.prepare('UPDATE cards SET scale_code = ?, updated_at = ? WHERE id = ?').run(code, iso(now), id);
    addHistory(db, actor, id, card.version, 'code_seen', { scaleCode: card.scaleCode }, { scaleCode: code }, now);
    audit(db, actor, 'card_code', id, { before: card.scaleCode, after: code }, now);
    return getCard(db, id)!;
  });
}

export interface CodeSync {
  /** Cards whose item gained or changed its scale code, now recorded. */
  updated: number;
  /** Cards linked in this catalog whose variation is no longer in it, for a person to look at. */
  missing: Array<{ cardId: number; variationId: string; name: string }>;
}

/** After a catalog refresh: records each linked card's current scale code and lists links gone stale. */
export function syncCardCodes(db: Db, actor: AuditActor, catalog: CopyCatalog, now: number = Date.now()): CodeSync {
  const key = catalogKey(catalog);
  const out: CodeSync = { updated: 0, missing: [] };
  for (const card of liveCards(db)) {
    const link = linkIn(card, key);
    if (!link) continue;
    const v = catalog.index.variationById.get(link.variationId);
    if (!v) {
      out.missing.push({ cardId: card.id, variationId: link.variationId, name: fullName(card.content) });
      continue;
    }
    const code = catalog.index.itemById.get(v.itemId)?.scaleCode ?? null;
    if (code && code !== card.scaleCode) {
      recordScaleCode(db, actor, card.id, code, now);
      out.updated++;
    }
  }
  return out;
}

/** A person has checked this version of the card. An edit after it makes a new version to check. */
export function markCardChecked(db: Db, actor: AuditActor, id: number, version: number, now: number = Date.now()): StoredCard {
  return inTransaction(db, () => {
    const card = getCard(db, id);
    if (!card || card.retiredAt) throw new CopyError('That card no longer exists.');
    if (card.version !== version) throw new CopyError('Someone changed this card since you opened it. Open it again to see the change.');
    if (card.checkedVersion === version) return card;
    db.prepare('UPDATE cards SET checked_version = ?, updated_at = ? WHERE id = ?').run(version, iso(now), id);
    addHistory(db, actor, id, version, 'checked', { checkedVersion: card.checkedVersion }, { checkedVersion: version }, now);
    audit(db, actor, 'card_checked', id, { version }, now);
    return getCard(db, id)!;
  });
}

/**
 * True when a person must check the card before it prints: every card the model wrote, until a
 * person has checked its current version, whatever its verify list holds. An empty verify list
 * proves nothing: a web page can tell the model to leave it empty.
 */
export function needsCheck(card: StoredCard): boolean {
  return card.firstSource === 'generated' && card.checkedVersion !== card.version;
}

/** Why a stored card cannot print as it is, in plain words. Empty when nothing in the card itself stops it. */
export function cardBlockers(card: StoredCard): string[] {
  const out: string[] = [];
  if (card.retiredAt) out.push('The card was replaced by another one.');
  for (const b of card.blocked) out.push(`Blocked until edited: ${b}`);
  if (needsCheck(card)) out.push('The model wrote this card. A person must check this version before it prints.');
  return out;
}
