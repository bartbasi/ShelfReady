// Rebuilds each reference card sheet from its own imported records and
// compares the result with the file Claude made.
//
// What is normalized, and why:
// - word/document.xml: nothing. docx writes no rsids, paragraph ids or random
//   ids into these cards, so the rebuilt file must match byte for byte.
// - docProps/core.xml: the dcterms:created and dcterms:modified timestamps are
//   replaced with a fixed value. They record when the file was built.
// - Every other part (styles, settings, numbering, rels, fonts, theme,
//   content types) must match byte for byte. styles.xml and settings.xml match
//   because build.ts pins them; see PINNED_PARTS there.
// - The zip container itself (compression, entry times) is not compared.
//
// reference/cards is store data and is not in git, so this skips when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCards, sortCards } from '../src/cards/build.ts';
import { loadCardConfig, withLegacyNameBlock } from '../src/cards/config.ts';
import { readDocxParts } from '../src/cards/docx-zip.ts';
import { parseCardsDocx, parseCardsDocumentXml, templateWarnings } from '../src/cards/import.ts';

const REF_DIR = resolve(import.meta.dirname, '../reference/cards');
const files = existsSync(REF_DIR) ? readdirSync(REF_DIR).filter((f) => f.endsWith('.docx')).sort() : [];
const skip = files.length ? false : `reference/cards is absent (store data, not in git). Copy the reference .docx files there to run the fidelity test.`;

const cfg = loadCardConfig();
const LEGACY_ROW = cfg.geometry.history?.untilOct28?.nameRowHeight;

const normalizeCore = (xml: string): string =>
  xml.replace(/(<dcterms:(created|modified)[^>]*>)[^<]*(<\/dcterms:\2>)/g, '$1TIMESTAMP$3');

const tokens = (xml: string): string[] => xml.match(/<[^>]+>|[^<]+/g) ?? [];

function load(file: string) {
  const buf = readFileSync(join(REF_DIR, file));
  return { parts: readDocxParts(buf), parsed: parseCardsDocx(buf) };
}

// Files are sorted into the current and the older layout by their name row
// height, so no store file names live in this test.
const loaded = files.map((file) => ({ file, ...load(file) }));
const current = loaded.filter((f) => f.parsed.nameRowHeight === cfg.geometry.rowHeights[1]);
const older = loaded.filter((f) => f.parsed.nameRowHeight === LEGACY_ROW);

test('fidelity: every reference file has a known layout', { skip }, () => {
  const unknown = loaded.filter((f) => !current.includes(f) && !older.includes(f)).map((f) => `${f.file} (name row ${f.parsed.nameRowHeight})`);
  assert.deepEqual(unknown, []);
});

for (const ref of current) {
  test(`fidelity: ${ref.file} rebuilds identically`, async () => {
    const out = await buildCards(ref.parsed.cards, cfg, { sort: false });
    const ours = readDocxParts(out.buffer);

    assert.equal(out.slots, ref.parsed.slots.length, 'slot count');
    assert.ok(ours.get('word/document.xml') === ref.parts.get('word/document.xml'), 'word/document.xml differs');

    assert.deepEqual([...ours.keys()].sort(), [...ref.parts.keys()].sort(), 'same package parts');
    for (const [part, xml] of ref.parts) {
      const a = part === 'docProps/core.xml' ? normalizeCore(xml) : xml;
      const b = part === 'docProps/core.xml' ? normalizeCore(ours.get(part) ?? '') : ours.get(part);
      assert.ok(a === b, `${part} differs`);
    }

    // The reference order is the skill's sort, so sorting changes nothing.
    assert.deepEqual(sortCards(ref.parsed.cards), ref.parsed.cards, 'reference is in eyebrow then name order');
    // The mark and tagline printed on the file are the config's.
    assert.deepEqual(templateWarnings(ref.parsed, cfg), []);
    // And reading our file back gives the same records.
    assert.deepEqual(parseCardsDocumentXml(ours.get('word/document.xml') ?? '').slots, ref.parsed.slots);
  });
}

// Sheets built on or before October 28 used a taller name block. Only these
// name block values may differ from a rebuild with the current config.
const LEGACY_DIFFS = new Set([
  '<w:trHeight w:val="1632" w:hRule="atLeast"/> => <w:trHeight w:val="0" w:hRule="atLeast"/>',
  '<w:top w:type="dxa" w:w="170"/> => <w:top w:type="dxa" w:w="105"/>',
  '<w:bottom w:type="dxa" w:w="140"/> => <w:bottom w:type="dxa" w:w="85"/>',
  '<w:spacing w:after="90" w:before="0"/> => <w:spacing w:after="55" w:before="0"/>',
  '<w:spacing w:after="0" w:before="110"/> => <w:spacing w:after="0" w:before="70"/>',
]);

for (const ref of older) {
  test(`fidelity: ${ref.file} differs only in the old name block`, async () => {
    const refXml = ref.parts.get('word/document.xml') ?? '';

    const rebuilt = await buildCards(ref.parsed.cards, cfg, { sort: false });
    const a = tokens(refXml);
    const b = tokens(readDocxParts(rebuilt.buffer).get('word/document.xml') ?? '');
    assert.equal(b.length, a.length, 'same XML structure');
    const diffs = new Map<string, number>();
    a.forEach((t, i) => {
      if (t !== b[i]) diffs.set(`${t} => ${b[i]}`, (diffs.get(`${t} => ${b[i]}`) ?? 0) + 1);
    });
    for (const d of diffs.keys()) assert.ok(LEGACY_DIFFS.has(d), `unexpected difference: ${d}`);
    // One name row per card pair: two per sheet.
    assert.equal(diffs.get([...LEGACY_DIFFS][0]), ref.parsed.sheets * 2, 'every name row and only name rows');

    const legacy = await buildCards(ref.parsed.cards, withLegacyNameBlock(cfg), { sort: false });
    assert.ok(readDocxParts(legacy.buffer).get('word/document.xml') === refXml, 'legacy rebuild differs');
  });
}
