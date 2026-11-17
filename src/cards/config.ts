// Loads a store card template from config/cards/<store>.json.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CardConfig } from './types.ts';

export const DEFAULT_CARD_CONFIG = fileURLToPath(
  new URL('../../config/cards/cheese-and-crackers.json', import.meta.url),
);

export function loadCardConfig(path: string = DEFAULT_CARD_CONFIG): CardConfig {
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as CardConfig;
  const g = cfg.geometry;
  if (!Array.isArray(g?.rowHeights) || g.rowHeights.length !== 6) {
    throw new Error(`${path}: geometry.rowHeights must list 6 rows`);
  }
  if (g.exactRow < 0 || g.exactRow > 5) throw new Error(`${path}: geometry.exactRow must be 0 to 5`);
  for (const key of ['mark', 'tagline'] as const) {
    if (typeof cfg[key] !== 'string') throw new Error(`${path}: ${key} must be a string`);
  }
  return cfg;
}

/**
 * The config as it was for sheets built on or before October 28, 2026: name
 * row floor 1632 and more padding in the name block. Only for rebuilding and
 * checking old sheets.
 */
export function withLegacyNameBlock(cfg: CardConfig): CardConfig {
  const old = cfg.geometry.history?.untilOct28;
  if (!old) throw new Error('Card config has no geometry.history.untilOct28');
  const rowHeights = [...cfg.geometry.rowHeights];
  rowHeights[1] = old.nameRowHeight;
  return {
    ...cfg,
    geometry: { ...cfg.geometry, rowHeights },
    blocks: {
      ...cfg.blocks,
      name: { ...cfg.blocks.name, margins: { ...old.nameMargins }, eyebrowAfter: old.eyebrowAfter, producerBefore: old.producerBefore },
    },
  };
}
