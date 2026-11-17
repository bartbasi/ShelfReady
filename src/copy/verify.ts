// The verify-before-printing list for a generated card (cc-case-cards: "That file is what keeps a
// wrong claim off a printed card"), and the sources kept with it.
//
// The model lists what it could not confirm. Code adds what it can check on its own:
// - no search was made, or every search failed;
// - pages the model cited that its searches did not return (cited from memory, or made up), and
//   any claim resting only on them;
// - the origin against the origin the invoice prints, and against the model's own sources;
// - a protected designation on the card that no source the model opened confirms;
// - a card name that shares nothing with the register name or the invoice description;
// - limits still broken after the retry, and a category the config does not have;
// - talk of price without an amount, which never blocks a card.
// Code findings come first and are never cut. The verify list helps a person check the card; it
// never stands in for the check: every generated card needs one (src/copy/store.ts needsCheck).

import { words } from '../matching/text.ts';
import type { CheckProblem } from './checks.ts';
import { fullName, priceTalk } from './checks.ts';
import type { ModelAnswer } from './schema.ts';
import { cleanText, designationTerms, foldCopy, safeUrl, urlKey } from './text.ts';
import type { CardContent, InvoiceFacts, ProductFacts, SearchRecord, SourceRef, VerifyItem, VerifyKind } from './types.ts';

/** Most items kept from the model's own list. Code findings are never cut. */
const MAX_MODEL_ITEMS = 15;
/** Longest verify item or source note kept. */
const MAX_TEXT = 300;

export interface ReviewInput {
  /** The research of the writing call: whether it found the product, origin, designation, sources. */
  research: Pick<ModelAnswer, 'product_identified' | 'origin_check' | 'designation_check' | 'sources'>;
  /** The claims and verify list of the answer that made the stored card: the retry's, when it was used. */
  claims: ModelAnswer['claims'];
  modelVerify: ModelAnswer['verify'];
  /** Every search of the writing call, continuations included. */
  searches: readonly SearchRecord[];
  /** The card as it will be stored. */
  content: CardContent;
  product: ProductFacts;
  invoice: InvoiceFacts | null;
  /** Limits still broken after the retry. */
  problems: readonly CheckProblem[];
  /** A category word the model proposed that the config does not have. */
  newCategory: string | null;
}

export interface ReviewOutput {
  /** Code findings first, never cut, then the model's own items. */
  verify: VerifyItem[];
  sources: SourceRef[];
  /** Pages the model cited that its searches did not return. */
  unreturnedUrls: string[];
}

const US_STATES = new Set(
  'alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota mississippi missouri montana nebraska nevada new-hampshire new-jersey new-mexico new-york north-carolina north-dakota ohio oklahoma oregon pennsylvania rhode-island south-carolina south-dakota tennessee texas utah vermont virginia washington west-virginia wisconsin wyoming'
    .split(' ')
    .map((s) => s.replace(/-/g, ' ')),
);

// Tried on the start of the folded text, so "Turkey (Türkiye)" is Turkey. "of" is removed first,
// so "United States of America" arrives as "united states america".
const COUNTRY_SYNONYMS: ReadonlyArray<[RegExp, string]> = [
  [/^(united states|usa|us|america|u s a|u s)( |$)/, 'usa'],
  [/^(turkiye|turkey)( |$)/, 'turkey'],
  [/^(holland|netherlands)( |$)/, 'netherlands'],
  [/^(united kingdom|uk|great britain|britain|england|scotland|wales|northern ireland)( |$)/, 'uk'],
];

/** The country an origin text names, folded so spellings compare equal. '' when it names none. */
export function countryKey(text: string): string {
  const t = foldCopy(text)
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\b(product|produce|made|blended|packed|grown|of|in|the|imported)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t === '') return '';
  // A US state anywhere ("United States (Wisconsin)", "PRODUCT OF WISCONSIN") is the USA.
  const padded = ` ${t} `;
  for (const s of US_STATES) if (padded.includes(` ${s} `)) return 'usa';
  for (const [re, key] of COUNTRY_SYNONYMS) if (re.test(t)) return key;
  return t;
}

/** The origin line defers to the package ("SEE CASE FOR ORIGIN"), so it states no country. */
function defersOrigin(origin: string): boolean {
  return /^SEE\b.*\bORIGIN$/i.test(origin.trim());
}

/** Designation terms folded to one family, so DOP, PDO and AOP compare equal, and IGP with PGI. */
function designationFamily(term: string): string {
  if (['DOP', 'PDO', 'AOP', 'AOC', 'DOQ', 'protected designation', 'appellation d origine', 'denominazione di origine', 'denominacion de origen'].includes(term.replace(/[’']/g, ' '))) return 'PDO';
  if (['IGP', 'PGI', 'protected geographical indication', 'indicazione geografica'].includes(term)) return 'PGI';
  if (term === 'STG' || term === 'TSG') return 'TSG';
  return term;
}

const clip = (s: string) => {
  const t = cleanText(s);
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}...` : t;
};

export function buildReview(input: ReviewInput): ReviewOutput {
  const { research, content, product, invoice } = input;
  const codeItems: VerifyItem[] = [];
  const modelItems: VerifyItem[] = [];
  const seen = new Set<string>();
  const add = (kind: VerifyKind, text: string, from: VerifyItem['from'] = 'code') => {
    const t = clip(text);
    if (t === '' || seen.has(t)) return;
    seen.add(t);
    (from === 'code' ? codeItems : modelItems).push({ kind, text: t, from });
  };

  // What the searches returned: the only pages that count as sources.
  const returned = new Map<string, { url: string; title: string }>();
  for (const s of input.searches) for (const r of s.results) returned.set(urlKey(r.url), r);
  const isReturned = (u: string) => {
    const safe = safeUrl(u);
    return safe !== null && returned.has(urlKey(safe));
  };
  const okSearches = input.searches.filter((s) => s.error === '').length;
  if (okSearches === 0) {
    const failed = input.searches.map((s) => s.error).filter(Boolean);
    add('sources', `Nothing was looked up on the web for this card${failed.length ? ` (the searches failed: ${[...new Set(failed)].join(', ')})` : ''}. Check the origin, any protected designation and every claim before printing.`);
  }

  // Sources the model used, kept only when its searches returned them, with the search's own
  // title: the model's words for a page are not kept as its title.
  const unreturned = new Set<string>();
  const sources: SourceRef[] = [];
  for (const s of research.sources) {
    const safe = safeUrl(s.url);
    if (!safe) continue;
    const hit = returned.get(urlKey(safe));
    if (!hit) {
      unreturned.add(safe);
      continue;
    }
    if (sources.some((x) => urlKey(x.url) === urlKey(hit.url))) continue;
    sources.push({ url: hit.url, title: hit.title, usedFor: clip(s.used_for) });
  }
  const cited = [...research.origin_check.source_urls, ...research.designation_check.source_urls, ...input.claims.flatMap((c) => c.source_urls)];
  for (const u of cited) {
    const safe = safeUrl(u);
    if (safe && !isReturned(safe)) unreturned.add(safe);
  }
  if (unreturned.size) {
    const list = [...unreturned].slice(0, 3).join(', ');
    add('sources', `The model named ${unreturned.size === 1 ? 'a page' : `${unreturned.size} pages`} its searches did not return, so nothing on ${unreturned.size === 1 ? 'it' : 'them'} was checked: ${list}${unreturned.size > 3 ? ', and more' : ''}.`);
  }

  if (!research.product_identified) add('claim', 'The model could not find this exact product on the web. Treat the copy as a draft from general knowledge.');

  // Origin.
  const originConfirmed = research.origin_check.confirmed && research.origin_check.source_urls.some(isReturned);
  if (!defersOrigin(content.origin)) {
    const cardCountry = countryKey(content.origin);
    if (!originConfirmed) add('origin', `No source the model opened confirms the origin: ${content.origin}.`);
    if (invoice && invoice.origin.trim() !== '' && countryKey(invoice.origin) !== '' && countryKey(invoice.origin) !== cardCountry) {
      add('origin', `The invoice prints the origin as ${clip(invoice.origin)}, but the card says ${content.origin}.`);
    }
    const found = countryKey(research.origin_check.country);
    if (found !== '' && cardCountry !== '' && found !== cardCountry) add('origin', `The model’s sources give the origin as ${clip(research.origin_check.country)}, but the card says ${content.origin}.`);
  }

  // Protected designations.
  const cardText = [content.origin, content.n1, content.n2, content.producer, ...content.specs.flat(), ...content.copy].join(' ');
  const onCard = designationTerms(cardText);
  if (onCard.length) {
    const confirmed = research.designation_check.confirmed && research.designation_check.source_urls.some(isReturned);
    if (!confirmed) add('designation', `The card says ${onCard.join(', ')}, but no source the model opened confirms it. Check the official register.`);
    const fromSources = designationTerms(research.designation_check.designation).map(designationFamily);
    if (fromSources.length && !onCard.map(designationFamily).some((t) => fromSources.includes(t))) {
      add('designation', `The card says ${onCard.join(', ')}, but the model’s sources say ${clip(research.designation_check.designation)}.`);
    }
  }

  // Every claim the model could not confirm, or confirmed only with pages it never opened.
  for (const c of input.claims) {
    if (!(c.confirmed && c.source_urls.some(isReturned))) add('claim', `Not confirmed by a source: ${c.claim}`);
  }

  // Naming: the card name should share a word with the register or the invoice.
  const nameWords = new Set(words(fullName(content)));
  const registerWords = words(`${product.baseName} ${product.variationName}`);
  const invoiceWords = invoice ? words(`${invoice.description} ${invoice.brand}`) : [];
  if (nameWords.size && !registerWords.some((w) => nameWords.has(w)) && !invoiceWords.some((w) => nameWords.has(w))) {
    add('naming', `The card calls it ${fullName(content)}, the register calls it ${product.baseName}${invoice?.description ? `, and the invoice ${clip(invoice.description)}` : ''}.`);
  }

  // Talk of price without an amount never blocks a card, but a person should see it.
  const talk = priceTalk(content);
  if (talk.length) add('price', `The card talks about price (${talk.join(', ')}). It prints its own price; check that the wording is wanted.`);

  for (const p of input.problems) add('limits', p.message);
  if (input.newCategory) {
    add('category', `No category in the card config fits. The model suggests ${input.newCategory}. Add it at the end of the config with the next free number, or pick an existing one. The card cannot print until its category is in the config.`);
  }

  // The model's own list, after every code finding, and only what fits.
  for (const v of input.modelVerify) add(v.kind, v.text, 'model');
  return { verify: [...codeItems, ...modelItems.slice(0, MAX_MODEL_ITEMS)], sources: sources.slice(0, 20), unreturnedUrls: [...unreturned] };
}
