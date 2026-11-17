// Geometry guard that needs no store data. Builds a sheet from made-up cards
// and compares word/document.xml, word/styles.xml and word/settings.xml with
// the committed copies in test/fixtures/cards-golden/. Any change to a
// margin, colour, size, spacing, font or the pinned parts fails here.
// After a deliberate, approved change, regenerate with:
//   UPDATE_CARD_GOLDEN=1 node --test test/cards-golden.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCards } from '../src/cards/build.ts';
import { loadCardConfig, withLegacyNameBlock } from '../src/cards/config.ts';
import { readDocxParts } from '../src/cards/docx-zip.ts';
import type { CardRecord } from '../src/cards/types.ts';

const DIR = resolve(import.meta.dirname, 'fixtures/cards-golden');
const PARTS = ['word/document.xml', 'word/styles.xml', 'word/settings.xml'];
const update = process.env.UPDATE_CARD_GOLDEN === '1';

/** Placeholder cards: a weight item with a code, unit items, a one-word name, one and two paragraphs, and a blank slot. */
const GOLDEN_CARDS: CardRecord[] = [
  {
    code: '7001', price: '$10.99', unit: 'PER POUND', origin: 'PRODUCT OF SOMEWHERE', eyebrow: '01 / CHEESE',
    n1: 'Sample ', n2: 'Cheese', producer: 'Example Dairy · Hometown',
    specs: [['MILK', 'Cow’s'], ['AGE', '6 Months'], ['CUT', 'To Order']],
    copy: ['A placeholder first paragraph that stands in for real copy & keeps the test free of store data.', 'A shorter second paragraph, with Joe\'s straight apostrophe.'],
  },
  {
    code: '', price: '$9.99', unit: '500 GRAMS', origin: 'PRODUCT OF ELSEWHERE', eyebrow: '03 / PASTA',
    n1: '', n2: 'Placeholder', producer: 'Example Mill · Village',
    specs: [['DIE', 'Bronze'], ['SHAPE', 'Long'], ['COOK', '9-11 Min']],
    copy: ['One paragraph only, to cover the case with no paragraph gap.'],
  },
  {
    code: '', price: '$4.99', unit: '70 GRAMS', origin: 'MADE NEARBY', eyebrow: '04 / PANTRY',
    n1: 'Sample ', n2: 'Crackers <Plain>', producer: 'Example Bakery',
    specs: [['BASE', 'Wheat'], ['SALT', 'Sea'], ['SIZE', '70 g']],
    copy: ['First paragraph of filler text for the third card.', 'Second paragraph of filler text "quoted" here.'],
  },
];

for (const [label, legacy] of [['current', false], ['legacy', true]] as const) {
  test(`golden: ${label} geometry matches test/fixtures/cards-golden`, async () => {
    const base = loadCardConfig();
    const cfg = legacy ? withLegacyNameBlock(base) : base;
    const out = await buildCards(GOLDEN_CARDS, cfg);
    assert.equal(out.slots, 4);
    const parts = readDocxParts(out.buffer);
    for (const part of PARTS) {
      const file = join(DIR, label, part.replace('/', '-'));
      const ours = parts.get(part) ?? '';
      if (update) {
        mkdirSync(join(DIR, label), { recursive: true });
        writeFileSync(file, ours);
        continue;
      }
      assert.ok(ours === readFileSync(file, 'utf8'), `${part} differs from ${file}. Geometry, colours, fonts or pinned parts changed.`);
    }
  });
}
