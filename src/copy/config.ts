// The copy rules a store sets: the length limits and categories from its card config, and its
// writing guide (the copyWriting section). Everything store-specific is in
// config/cards/<store>.json, never in code. src/copy/prompt.ts turns these into the model's
// instructions, and src/copy/checks.ts checks the answer against the same numbers.

import { DEFAULT_CARD_CONFIG, loadCardConfig } from '../cards/config.ts';
import type { CardConfig } from '../cards/types.ts';

export interface CopyLimits {
  copy: { paragraphs: number; maxLines: number; targetChars: number; maxChars: number };
  name: { oneLineChars: number; maxLines: number; maxChars: number };
  producer: { maxChars: number };
  specValue: { targetChars: number; maxChars: number };
  specLabel: { maxChars: number };
}

export interface WritingGuide {
  /** How the store's cards read. */
  voice: string[];
  /** Accuracy rules and the kinds of mistakes made before. */
  accuracy: string[];
  /** How the origin line is written. */
  origin: string[];
  /** Other field conventions. */
  fields: string[];
  /** Words that read like marketing. A card that uses one is sent back once. */
  flagPhrases: string[];
  /** Straight apostrophes become curly ones, as on the existing cards. */
  curlyApostrophes: boolean;
}

export interface Category {
  /** Two digits, for example "01". Fixed for good: never reused or renumbered. */
  number: string;
  /** The category word, for example "CHEESE". */
  word: string;
}

export interface CopyConfig {
  /** As printed, for example "01 / CHEESE". */
  eyebrows: string[];
  categories: Category[];
  limits: CopyLimits;
  guide: WritingGuide;
}

const EYEBROW_RE = /^(\d{2}) \/ ([A-Z][A-Z &]{0,30})$/;

/** Splits "01 / CHEESE" into its number and word, or null when it is not in that form. */
export function parseEyebrow(eyebrow: string): Category | null {
  const m = EYEBROW_RE.exec(eyebrow.trim());
  return m ? { number: m[1]!, word: m[2]!.trim() } : null;
}

function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) throw new Error(`${where} must be a whole number above 0`);
  return v;
}

function strings(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) throw new Error(`${where} must be a list of text lines`);
  return v as string[];
}

function section(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where} is missing`);
  return v as Record<string, unknown>;
}

/** Reads the copy rules out of a loaded card config. Throws with the field name when one is missing. */
export function copyConfigFrom(cfg: CardConfig, where = 'card config'): CopyConfig {
  const categories = cfg.eyebrows.map((e) => {
    const c = parseEyebrow(e);
    if (!c) throw new Error(`${where}: eyebrow "${e}" must look like 01 / CHEESE`);
    return c;
  });
  const numbers = new Set(categories.map((c) => c.number));
  const words = new Set(categories.map((c) => c.word));
  if (numbers.size !== categories.length || words.size !== categories.length) throw new Error(`${where}: each eyebrow number and word must be used once`);

  const l = section(cfg.limits, `${where}: limits`);
  const copy = section(l.copy, `${where}: limits.copy`);
  const name = section(l.name, `${where}: limits.name`);
  const producer = section(l.producer, `${where}: limits.producer`);
  const specValue = section(l.specValue, `${where}: limits.specValue`);
  const specLabel = section(l.specLabel, `${where}: limits.specLabel`);
  const limits: CopyLimits = {
    copy: {
      paragraphs: num(copy.paragraphs, `${where}: limits.copy.paragraphs`),
      maxLines: num(copy.maxLines, `${where}: limits.copy.maxLines`),
      targetChars: num(copy.targetChars, `${where}: limits.copy.targetChars`),
      maxChars: num(copy.maxChars, `${where}: limits.copy.maxChars`),
    },
    name: {
      oneLineChars: num(name.oneLineChars, `${where}: limits.name.oneLineChars`),
      maxLines: num(name.maxLines, `${where}: limits.name.maxLines`),
      maxChars: num(name.maxChars, `${where}: limits.name.maxChars`),
    },
    producer: { maxChars: num(producer.maxChars, `${where}: limits.producer.maxChars`) },
    specValue: {
      targetChars: num(specValue.targetChars, `${where}: limits.specValue.targetChars`),
      maxChars: num(specValue.maxChars, `${where}: limits.specValue.maxChars`),
    },
    specLabel: { maxChars: num(specLabel.maxChars, `${where}: limits.specLabel.maxChars`) },
  };
  if (limits.copy.targetChars > limits.copy.maxChars || limits.specValue.targetChars > limits.specValue.maxChars) {
    throw new Error(`${where}: a target length is above its maximum`);
  }

  const g = section((cfg as unknown as Record<string, unknown>).copyWriting, `${where}: copyWriting`);
  const guide: WritingGuide = {
    voice: strings(g.voice, `${where}: copyWriting.voice`),
    accuracy: strings(g.accuracy, `${where}: copyWriting.accuracy`),
    origin: strings(g.origin, `${where}: copyWriting.origin`),
    fields: strings(g.fields, `${where}: copyWriting.fields`),
    flagPhrases: strings(g.flagPhrases, `${where}: copyWriting.flagPhrases`).map((p) => p.trim()).filter((p) => p !== ''),
    curlyApostrophes: g.curlyApostrophes === true,
  };
  if (guide.voice.length === 0) throw new Error(`${where}: copyWriting.voice is empty`);
  return { eyebrows: [...cfg.eyebrows], categories, limits, guide };
}

/** Loads the copy rules from a store card config file. */
export function loadCopyConfig(path: string = DEFAULT_CARD_CONFIG): CopyConfig {
  return copyConfigFrom(loadCardConfig(path), path);
}
