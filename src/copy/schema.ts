// The JSON schema the model answers in (structured outputs, output_config.format), and the code
// that parses an answer and checks it against the same schema.
//
// As for invoices: every field is required, nothing is nullable, and an empty string means
// "none". The schema has no price and no scale code, so the model cannot set either. The
// category is a fixed list from the store's card config, plus OTHER for a product that fits
// none of them. validateAgainstSchema (src/invoice/schema.ts) re-checks every answer in code.

import { validateAgainstSchema } from '../invoice/schema.ts';
import type { CopyConfig } from './config.ts';
import { MAX_FIELD } from './text.ts';

type Schema = Record<string, unknown>;

export const MODEL_VERIFY_KINDS = ['claim', 'origin', 'designation', 'naming', 'packaging', 'cooking', 'other'] as const;
export type ModelVerifyKind = (typeof MODEL_VERIFY_KINDS)[number];

/** The category answer for a product that fits no category in the config. */
export const OTHER_CATEGORY = 'OTHER';

export interface ModelSpec {
  label: string;
  value: string;
}

export interface ModelCard {
  origin: string;
  category: string;
  new_category: string;
  n1: string;
  n2: string;
  producer: string;
  spec1: ModelSpec;
  spec2: ModelSpec;
  spec3: ModelSpec;
  paragraph1: string;
  paragraph2: string;
  unit: string;
}

export interface ModelCheck {
  confirmed: boolean;
  source_urls: string[];
  note: string;
}

export interface ModelAnswer {
  product_identified: boolean;
  card: ModelCard;
  unique_selling_point: string;
  origin_check: ModelCheck & { country: string };
  designation_check: ModelCheck & { designation: string };
  claims: Array<{ claim: string; confirmed: boolean; source_urls: string[] }>;
  verify: Array<{ kind: ModelVerifyKind; text: string }>;
  sources: Array<{ url: string; title: string; used_for: string }>;
}

/** The retry sends back the card with its own claims and verify list: no new research, so no new facts. */
export interface RetryAnswer {
  card: ModelCard;
  /** The checkable facts on the rewritten card, citing pages the first call's searches returned. */
  claims: ModelAnswer['claims'];
  verify: ModelAnswer['verify'];
}

/** Most list entries kept from one answer. */
export const MAX_LIST = 20;

const str = (description: string): Schema => ({ type: 'string', description });
const urls = (description: string): Schema => ({ type: 'array', items: { type: 'string' }, description });

const spec: Schema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'value'],
  properties: {
    label: str('One short word in capitals, for example MILK.'),
    value: str('A short value, for example Cow’s.'),
  },
};

function cardSchema(cfg: CopyConfig): Schema {
  const L = cfg.limits;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['origin', 'category', 'new_category', 'n1', 'n2', 'producer', 'spec1', 'spec2', 'spec3', 'paragraph1', 'paragraph2', 'unit'],
    properties: {
      origin: str('The origin line in capitals, for example PRODUCT OF FRANCE.'),
      category: { type: 'string', enum: [...cfg.categories.map((c) => c.word), OTHER_CATEGORY], description: `The card category. ${OTHER_CATEGORY} only when none fits.` },
      new_category: str(`Only when category is ${OTHER_CATEGORY}: one category word in capitals. Otherwise empty.`),
      n1: str('The first part of the name, set in black, ending in a space. Empty for a one-word name.'),
      n2: str('The rest of the name, set in red italic.'),
      producer: str(`The maker, a middle dot, then the town and region. At most ${L.producer.maxChars} characters.`),
      spec1: spec,
      spec2: spec,
      spec3: spec,
      paragraph1: str('The first paragraph: what the product is and what sets it apart.'),
      paragraph2: str('The second paragraph: how it eats or how to use it.'),
      unit: str('PER POUND for goods sold by weight, otherwise the size of one package in capitals, for example 500 GRAMS.'),
    },
  };
}

const check = (what: string, field: string, fieldText: string): Schema => ({
  type: 'object',
  additionalProperties: false,
  required: [field, 'confirmed', 'source_urls', 'note'],
  properties: {
    [field]: str(fieldText),
    confirmed: { type: 'boolean', description: `True only when a page your searches returned confirms the ${what}.` },
    source_urls: urls(`The pages your searches returned that confirm the ${what}. Empty when none did.`),
    note: str('Anything a person should know, in one short sentence. Empty if nothing.'),
  },
});

/** Each checkable fact on a card, with the pages that state it. */
const CLAIMS: Schema = {
  type: 'array',
  description: 'Each fact on the card that a person could check: how it is made, ageing, awards, packaging claims, cook times.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['claim', 'confirmed', 'source_urls'],
    properties: {
      claim: str('The fact, in the words the card uses.'),
      confirmed: { type: 'boolean', description: 'True only when a page your searches returned states it.' },
      source_urls: urls('The pages your searches returned that state it.'),
    },
  },
};

/** What the owner must confirm before printing. */
const VERIFY: Schema = {
  type: 'array',
  description: 'Everything the owner must confirm before printing.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'text'],
    properties: {
      kind: { type: 'string', enum: [...MODEL_VERIFY_KINDS] },
      text: str('What to confirm, in one plain sentence.'),
    },
  },
};

/** The schema for a first answer, with research. */
export function generationSchema(cfg: CopyConfig): Schema {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['product_identified', 'card', 'unique_selling_point', 'origin_check', 'designation_check', 'claims', 'verify', 'sources'],
    properties: {
      product_identified: { type: 'boolean', description: 'True when your searches found this exact product: the same maker and the same product.' },
      card: cardSchema(cfg),
      unique_selling_point: str('The one specific fact that sets this product apart, as the copy uses it. Empty when there is none you could confirm.'),
      origin_check: check('country of origin', 'country', 'The country where the product is made, as your sources give it. Empty if you could not find it.'),
      designation_check: check(
        'protected designation',
        'designation',
        'The protected designation the product holds (for example DOP, IGP, AOP, PDO, PGI), as the official register or consortium gives it. Empty when it holds none or you could not confirm one.',
      ),
      claims: CLAIMS,
      verify: VERIFY,
      sources: {
        type: 'array',
        description: 'The pages you used. Only pages your searches returned in this conversation.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['url', 'title', 'used_for'],
          properties: {
            url: str('The page address exactly as the search returned it.'),
            title: str('The page title.'),
            used_for: str('What you took from it, in a few words.'),
          },
        },
      },
    },
  };
}

/** The schema for the one retry: the card, its claims and its verify list. */
export function retrySchema(cfg: CopyConfig): Schema {
  return { type: 'object', additionalProperties: false, required: ['card', 'claims', 'verify'], properties: { card: cardSchema(cfg), claims: CLAIMS, verify: VERIFY } };
}

/** Strings over MAX_FIELD or lists over MAX_LIST, which no honest answer has. */
function oversized(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return value.length > MAX_FIELD ? [`${path}: longer than ${MAX_FIELD} characters`] : [];
  if (Array.isArray(value)) {
    const own = value.length > MAX_LIST * 2 ? [`${path}: more than ${MAX_LIST * 2} entries`] : [];
    return [...own, ...value.flatMap((v, i) => oversized(v, `${path}[${i}]`))];
  }
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => oversized(v, `${path}.${k}`));
  return [];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problems: string[] };

/** Parses the model's JSON text and checks it against the schema. Problems name paths only, never long text. */
export function parseAnswer<T>(text: string | null, schema: Schema): Parsed<T> {
  if (text === null || text.trim() === '') return { ok: false, problems: ['The model gave no answer text.'] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['The answer was not valid JSON.'] };
  }
  const problems = [...validateAgainstSchema(value, schema), ...oversized(value)];
  if (problems.length) return { ok: false, problems: problems.slice(0, 20).map((p) => (p.length > 200 ? `${p.slice(0, 200)}...` : p)) };
  return { ok: true, value: value as T };
}
