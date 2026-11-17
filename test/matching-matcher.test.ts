// The matcher: what is confident, what is only a candidate, O and 0 lookalikes, misread codes.
// Invented catalog and invented invoice lines only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditActor } from '../src/db/audit.ts';
import { openDatabase, type Db } from '../src/db/db.ts';
import { checkReading } from '../src/invoice/checks.ts';
import { DEFAULT_INVOICE_SETTINGS } from '../src/invoice/settings.ts';
import type { ModelLine } from '../src/invoice/types.ts';
import type { CatalogIndex } from '../src/matching/catalog.ts';
import { confirmMapping, type MappingTarget } from '../src/matching/mapping.ts';
import { createLineMatcher, matchReading, type CandidatesLine, type LineMatch, type MatchedLine } from '../src/matching/matcher.ts';
import { createSupplier, setSupplierUpcRule, type Supplier } from '../src/matching/suppliers.ts';
import { invoice, line, TODAY } from './invoice-fixtures.ts';
import { codeUpc, item, LOCATION, testIndex, testObjects, upcA, UPC_ARCHIVED, UPC_CHIP_SALT, UPC_CRACKER, UPC_CRACKER_ROSE, UPC_SHARED } from './matching-fixtures.ts';
import { squareItemState } from '../src/pricing/square-state.ts';

const ACTOR: AuditActor = { userId: null, username: 'manager1' };
const T0 = Date.parse('2026-11-07T15:00:00Z');

interface Setup {
  db: Db;
  index: CatalogIndex;
  supplier: Supplier;
  save(itemNumber: string, description: string, target: MappingTarget, upc?: string, brand?: string): void;
  match(fields: Partial<ModelLine>, s?: Supplier | null): LineMatch;
}

function setup(t: { after(fn: () => void): void }, index: CatalogIndex = testIndex()): Setup {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const supplier = createSupplier(db, ACTOR, 'Acme Fish & Gourmet', T0);
  return {
    db,
    index,
    supplier,
    save(itemNumber, description, target, upc = '', brand = '') {
      confirmMapping(db, ACTOR, { supplierId: supplier.id, line: { itemNumber, upc, description, brand }, target, catalog: index }, T0);
    },
    match(fields, s = supplier) {
      return createLineMatcher({ db, index }, s)(line({ item_number: '', description: '', ...fields }), 1);
    },
  };
}

function asMatched(m: LineMatch): MatchedLine {
  assert.equal(m.status, 'matched', `expected matched, got ${m.status}: ${m.reasons.join(' ')}`);
  return m as MatchedLine;
}

function asCandidates(m: LineMatch): CandidatesLine {
  assert.equal(m.status, 'candidates', `expected candidates, got ${m.status}: ${m.reasons.join(' ')}`);
  return m as CandidatesLine;
}

test('confident: a first-time printed UPC on exactly one active Square variation', (t) => {
  const s = setup(t);
  const m = asMatched(s.match({ upc: UPC_CRACKER, description: 'SOMETHING ELSE ENTIRELY' }, null));
  assert.equal(m.method, 'exact_upc');
  assert.equal(m.match.variationId, 'V_CRACKER');
  assert.equal(m.facts.hasMakerUpc, true);
  assert.match(m.reasons.join(' '), /printed UPC is on this Square item, and on no other/);
  // The EAN-13 form of a variation's UPC-A, on one flavour of a multi-variation item.
  assert.equal(asMatched(s.match({ upc: `0${UPC_CHIP_SALT}` }, null)).match.variationId, 'V_CHIPS_SALT');
});

test('an exact UPC never matches a variation that is not offered at the store', (t) => {
  const v = item({ id: 'I_TWO', name: 'Twin Jam', variations: [{ id: 'V_TWO_A', name: 'Fig', upc: upcA('00012121212') }, { id: 'V_TWO_B', name: 'Plum', upc: upcA('00012121213') }] }) as { item_data: { variations: Record<string, unknown>[] } };
  v.item_data.variations[1]!.absent_at_location_ids = [LOCATION];
  const s = setup(t, testIndex([v]));
  assert.equal(asMatched(s.match({ upc: upcA('00012121212') })).match.variationId, 'V_TWO_A');
  const gone = asCandidates(s.match({ upc: upcA('00012121213') }));
  assert.match(gone.candidates[0]!.reasons.join(' '), /variation is not offered at this store/);
});

test('not confident: a UPC on two items, a scale-code UPC, an archived or absent item', (t) => {
  const s = setup(t);
  const dup = asCandidates(s.match({ upc: UPC_SHARED }));
  assert.deepEqual(dup.candidates.map((c) => c.variationId).sort(), ['V_DUP_A', 'V_DUP_B']);
  assert.match(dup.candidates[0]!.reasons.join(' '), /2 Square items carry this UPC/);
  const scale = asCandidates(s.match({ upc: codeUpc('7101') }));
  assert.equal(scale.candidates[0]!.variationId, 'V_GOUDA');
  assert.match(scale.candidates[0]!.reasons.join(' '), /built from a scale code/);
  assert.match(asCandidates(s.match({ upc: UPC_ARCHIVED })).candidates[0]!.reasons.join(' '), /archived/);
  assert.match(asCandidates(s.match({ upc: upcA('00011166666') })).candidates[0]!.reasons.join(' '), /not offered at this store/);
});

test('confident: a saved mapping a person confirmed, however the supplier prints its name', (t) => {
  const s = setup(t);
  s.save('A100', 'HILLTOP AGED CHEDDAR', { kind: 'square', variationId: 'V_CHEDDAR' });
  const m = asMatched(s.match({ item_number: 'A100', description: 'HILLTOP AGED CHEDDAR' }));
  assert.equal(m.method, 'saved_mapping');
  assert.equal(m.match.variationId, 'V_CHEDDAR');
  assert.ok(m.mappingId);
  assert.match(m.reasons.join(' '), /Saved by manager1 on 2026-11-07/);
  const r = matchReading({ db: s.db, index: s.index }, checkReading(invoice({ supplier_name: 'ACME FISH AND GOURMET, INC.', lines: [line({ item_number: 'a 100', description: 'HILLTOP AGED CHEDDAR' })] }), { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY }));
  assert.equal(r.supplier.status, 'known');
  assert.equal(r.lines[0]!.status, 'matched');
});

test('not for resale: decided once per supplier item, then skipped', (t) => {
  const s = setup(t);
  s.save('B200', 'UNSALTED BUTTER 30/1LB', { kind: 'not_for_resale' });
  const m = s.match({ item_number: 'B200', description: 'UNSALTED BUTTER 30/1LB' });
  assert.equal(m.status, 'not_for_resale');
  assert.match(m.reasons.join(' '), /Marked not for resale/);
});

test('names only ever give candidates, ranked, with the right variation first', (t) => {
  const s = setup(t);
  const chips = asCandidates(s.match({ description: 'RIDGEWAY CHIPS BLACK TRUFFLE SM', pack_size: '1.41 OZ', unit: 'CS' }));
  assert.equal(chips.candidates[0]!.variationId, 'V_CHIPS_TRUFFLE');
  assert.equal(chips.candidates[0]!.method, 'name');
  assert.match(chips.reasons.join(' '), /Only the name suggests these items/);
  const wafer = asCandidates(s.match({ description: 'WAFER CRACKERS CRACKED PEPPER', brand: 'NORTHFIELD' }));
  assert.equal(wafer.candidates[0]!.variationId, 'V_WAFER');
  const salt = asCandidates(s.match({ description: 'SEA SALT CRACKERS', brand: 'BLUECREST' }));
  assert.equal(salt.candidates[0]!.variationId, 'V_CRACKER');
  assert.ok(salt.candidates.findIndex((c) => c.variationId === 'V_CRACKER_ROSE') > 0);
  // By weight: invoice capitals and abbreviations against "Maker - Product" with a code.
  const ham = asCandidates(s.match({ description: 'TAVERN HAM WHOLE', unit: 'EA', weight: '15.66', qty_shipped: '1', unit_price: '5.00', extension: '78.30' }));
  assert.equal(ham.candidates[0]!.variationId, 'V_HAM');
  assert.match(ham.candidates[0]!.reasons.join(' '), /Shares the words Tavern, Ham/);
});

test('nothing plausible is a new item, not a misread', (t) => {
  const s = setup(t);
  const m = s.match({ item_number: 'Z900', description: 'QUANTUM WIDGET' });
  assert.equal(m.status, 'new_item');
  assert.equal(m.status === 'new_item' && m.possibleMisread, false);
});

test('confident: the supplier item number inside a maker UPC, when the description fits', (t) => {
  const s = setup(t);
  assert.notEqual(s.match({ item_number: '45678', description: 'TORCHIO PASTA' }).status, 'matched', 'no rule, no match by number');
  const ruled = setSupplierUpcRule(s.db, ACTOR, s.supplier.id, { prefixes: ['000333'], from: 7, to: 11 }, T0);
  const m = asMatched(s.match({ item_number: '45678', description: 'TORCHIO PASTA' }, ruled));
  assert.equal(m.method, 'upc_item_number');
  assert.equal(m.match.variationId, 'V_IMPORT');
  assert.match(m.reasons.join(' '), /45678 is digits 7 to 11/);
  // A description that does not fit the Square name: offered first, never matched.
  const misnamed = asCandidates(s.match({ item_number: '45678', description: 'SOMETHING MISNAMED' }, ruled));
  assert.equal(misnamed.candidates[0]!.variationId, 'V_IMPORT');
  assert.match(misnamed.candidates[0]!.reasons.join(' '), /does not fit this Square name/);
  assert.equal(misnamed.possibleMisread, false);
  // Two variations fit under the rule's prefixes: a person picks.
  const two = setup(t, testIndex([item({ id: 'I_IMP3', name: 'Other Importer Pasta', variations: [{ id: 'V_IMP3', upc: upcA('00033445678') }] })]));
  const wide = setSupplierUpcRule(two.db, ACTOR, two.supplier.id, { prefixes: ['000333', '000334'], from: 7, to: 11 }, T0);
  assert.deepEqual(asCandidates(two.match({ item_number: '45678', description: 'TORCHIO PASTA' }, wide)).candidates.slice(0, 2).map((c) => c.variationId).sort(), ['V_IMP3', 'V_IMPORT']);
});

test('the UPC rule: a misread digit pointing at the neighbouring number, or a different printed UPC, is never a match', (t) => {
  const s = setup(t);
  const ruled = setSupplierUpcRule(s.db, ACTOR, s.supplier.id, { prefixes: ['000333'], from: 7, to: 11 }, T0);
  // 45678 is the torchio and 45679 the trenne. The torchio's number read with a 9 at the end.
  const slip = asCandidates(s.match({ item_number: '45679', description: 'TORCHIO PASTA' }, ruled));
  assert.deepEqual(slip.candidates.slice(0, 2).map((c) => c.variationId).sort(), ['V_IMPORT', 'V_IMPORT2']);
  assert.equal(slip.possibleMisread, true);
  assert.match(slip.reasons.join(' '), /one character from 45678/);
  assert.equal(asMatched(s.match({ item_number: '45679', description: 'TRENNE PASTA' }, ruled)).match.variationId, 'V_IMPORT2');
  // A valid UPC on the line that is not the Square item's: candidates and a misread flag.
  const other = asCandidates(s.match({ item_number: '45678', upc: upcA('00099988877'), description: 'TORCHIO PASTA' }, ruled));
  assert.equal(other.candidates[0]!.variationId, 'V_IMPORT');
  assert.equal(other.possibleMisread, true);
  assert.match(other.reasons.join(' '), /printed UPC differs/);
});

test('a scale code written on the line is a strong candidate, never a match', (t) => {
  const s = setup(t);
  const note = asCandidates(s.match({ description: 'AGED WHEEL', annotations: [{ kind: 'handwritten', text: '7102', meaning: 'other' }] }));
  assert.equal(note.candidates[0]!.variationId, 'V_CHEDDAR');
  assert.equal(note.candidates[0]!.method, 'scale_code');
  assert.match(note.candidates[0]!.reasons.join(' '), /shows 7102, the scale code/);
  // In the description, a code counts only when the names agree; supplier references never count.
  assert.equal(s.match({ description: 'QUANTUM WIDGET 7102' }).status, 'new_item');
  assert.equal(s.match({ description: 'QUANTUM WIDGET item#7102' }).status, 'new_item');
  assert.equal(s.match({ description: 'QUANTUM WIDGET PN7102' }).status, 'new_item');
});

test('O and 0: two saved item numbers that collide are never crossed', (t) => {
  const s = setup(t);
  s.save('O1200', 'TAVERN HAM', { kind: 'square', variationId: 'V_HAM' });
  s.save('01200', 'ROASTED TURKEY BREAST', { kind: 'square', variationId: 'V_TURKEY' });
  assert.equal(asMatched(s.match({ item_number: 'O1200', description: 'TAVERN HAM' })).match.variationId, 'V_HAM');
  assert.equal(asMatched(s.match({ item_number: '01200', description: 'ROASTED TURKEY BREAST' })).match.variationId, 'V_TURKEY');
  // The ham's letter O read as a zero: the description says ham, so the turkey row is not used.
  const crossed = asCandidates(s.match({ item_number: '01200', description: 'TAVERN HAM' }));
  assert.deepEqual(crossed.candidates.slice(0, 2).map((c) => c.variationId).sort(), ['V_HAM', 'V_TURKEY']);
  assert.match(crossed.reasons.join(' '), /differ only by O and 0/);
});

test('O and 0: a row found only through the lookalike key needs the UPC or the description', (t) => {
  const s = setup(t);
  s.save('O4900', 'FENNEL SALAMI CHUB', { kind: 'square', variationId: 'V_SALAMI' });
  const ok = asMatched(s.match({ item_number: '04900', description: 'FENNEL SALAMI CHUB' }));
  assert.equal(ok.match.variationId, 'V_SALAMI');
  assert.match(ok.reasons.join(' '), /read as 04900; saved as O4900/);
  const no = asCandidates(s.match({ item_number: '04900', description: 'QUANTUM WIDGET' }));
  assert.equal(no.candidates[0]!.variationId, 'V_SALAMI');
  assert.match(no.reasons.join(' '), /could not be confirmed/);
  s.save('I777', 'MYSTERY BOX', { kind: 'square', variationId: 'V_TROUT' }, UPC_CRACKER_ROSE);
  assert.equal(asMatched(s.match({ item_number: '1777', upc: UPC_CRACKER_ROSE, description: 'NOTHING ALIKE' })).match.variationId, 'V_TROUT', 'the same UPC confirms it');
});

test('a saved row is set aside when the line plainly describes another product', (t) => {
  const s = setup(t);
  s.save('C300', 'LAKE TROUT FILLET', { kind: 'square', variationId: 'V_TROUT' });
  assert.equal(asMatched(s.match({ item_number: 'C300', description: 'LAKE TROUT FILLETS SKIN ON' })).match.variationId, 'V_TROUT');
  const other = asCandidates(s.match({ item_number: 'C300', description: 'BLUECREST SEA SALT CRACKERS' }));
  assert.ok(other.candidates.some((c) => c.variationId === 'V_TROUT'));
  assert.match(other.reasons.join(' '), /not close enough to the one saved for item C300/);
  assert.equal(other.possibleMisread, true, 'the number may be misread, so the fallback reads it again');
  // The same printing with other spacing is the same product.
  s.save('J900', 'ROSEMARY CRISPS', { kind: 'square', variationId: 'V_CRACKER_ROSE' });
  assert.equal(asMatched(s.match({ item_number: 'J900', description: 'ROSEMARYCRISPS' })).match.variationId, 'V_CRACKER_ROSE');
});

test('two neighbouring saved numbers: a misread that lands on the other is never matched', (t) => {
  const s = setup(t);
  s.save('E5000', 'FENNEL SALAMI CHUB', { kind: 'square', variationId: 'V_SALAMI' });
  s.save('E5001', 'TAVERN HAM BLOCK', { kind: 'square', variationId: 'V_HAM' });
  assert.equal(asMatched(s.match({ item_number: 'E5000', description: 'FENNEL SALAMI CHUB' })).match.variationId, 'V_SALAMI');
  assert.equal(asMatched(s.match({ item_number: 'E5001', description: 'TAVERN HAM BLOCK' })).match.variationId, 'V_HAM');
  const slip = asCandidates(s.match({ item_number: 'E5001', description: 'FENNEL SALAMI CHUB' }));
  assert.deepEqual(slip.candidates.slice(0, 2).map((c) => c.variationId).sort(), ['V_HAM', 'V_SALAMI']);
  assert.equal(slip.possibleMisread, true);
  assert.match(slip.reasons.join(' '), /E5000 \(one character away\) fits the description as well/);
  // Flavours of one brand, numbered in sequence: only the flavour tells them apart.
  s.save('F100', 'RIDGEWAY CHIPS SEA SALT SMALL', { kind: 'square', variationId: 'V_CHIPS_SALT' }, '', 'RIDGEWAY');
  s.save('F101', 'RIDGEWAY CHIPS BLACK TRUFFLE SMALL', { kind: 'square', variationId: 'V_CHIPS_TRUFFLE' }, '', 'RIDGEWAY');
  assert.equal(asMatched(s.match({ item_number: 'F101', description: 'RIDGEWAY CHIPS BLACK TRUFFLE SMALL', brand: 'RIDGEWAY' })).match.variationId, 'V_CHIPS_TRUFFLE');
  const flavour = asCandidates(s.match({ item_number: 'F101', description: 'RIDGEWAY CHIPS SEA SALT SMALL', brand: 'RIDGEWAY' }));
  assert.equal(flavour.possibleMisread, true);
  assert.ok(flavour.candidates.some((c) => c.variationId === 'V_CHIPS_SALT'));
});

test('the same number, reworded: the saved item first for a person, no misread; once confirmed, the wording matches on its own', (t) => {
  const s = setup(t);
  s.save('R100', 'HILLTOP AGED CHEDDAR WHEEL', { kind: 'square', variationId: 'V_CHEDDAR' });
  const reworded = asCandidates(s.match({ item_number: 'R100', description: 'HILLTOP CHEDDAR' }));
  assert.equal(reworded.candidates[0]!.variationId, 'V_CHEDDAR');
  assert.equal(reworded.candidates[0]!.method, 'saved_mapping');
  assert.equal(reworded.possibleMisread, false, 'a second reading cannot change the wording');
  assert.match(reworded.reasons.join(' '), /R100 is worded differently from before/);
  // The manager confirms the same item: the new wording is kept with the match.
  s.save('R100', 'HILLTOP CHEDDAR', { kind: 'square', variationId: 'V_CHEDDAR' });
  assert.equal(asMatched(s.match({ item_number: 'R100', description: 'HILLTOP CHEDDAR' })).match.variationId, 'V_CHEDDAR');
  assert.equal(asMatched(s.match({ item_number: 'R100', description: 'HILLTOP AGED CHEDDAR WHEEL' })).match.variationId, 'V_CHEDDAR', 'the first wording still matches');
  // Far from every confirmed wording: a possible misread.
  assert.equal(asCandidates(s.match({ item_number: 'R100', description: 'BLUECREST SEA SALT CRACKERS' })).possibleMisread, true);
  // A reworded line whose number is one character from a saved item it fits better still flags.
  s.save('R101', 'FENNEL SALAMI CHUB', { kind: 'square', variationId: 'V_SALAMI' });
  const slip = asCandidates(s.match({ item_number: 'R100', description: 'FENNEL SALAMI CHUB LARGE' }));
  assert.equal(slip.possibleMisread, true);
  assert.ok(slip.candidates.slice(0, 2).some((c) => c.variationId === 'V_SALAMI'));
});

test('a new flavour read with a saved flavour\'s number: flagged, the right item first, the changed words shown', (t) => {
  const s = setup(t);
  // Only the sea salt flavour is saved. The smoked paprika flavour is new, and its line was read with the sea salt number.
  s.save('F100', 'RIDGEWAY CHIPS SEA SALT SMALL', { kind: 'square', variationId: 'V_CHIPS_SALT' }, '', 'RIDGEWAY');
  const m = asCandidates(s.match({ item_number: 'F100', description: 'RIDGEWAY CHIPS SMOKED PAPRIKA SMALL', brand: 'RIDGEWAY' }));
  assert.equal(m.possibleMisread, true, 'the fallback may read the number right');
  assert.equal(m.candidates[0]!.variationId, 'V_CHIPS_PAPRIKA');
  const saved = m.candidates.find((c) => c.variationId === 'V_CHIPS_SALT')!;
  assert.equal(saved.method, 'saved_mapping');
  assert.ok(saved.score < 1, 'the saved item carries its real name score');
  const text = m.reasons.join(' ');
  assert.match(text, /fit Ridgeway Chips: Smoked Paprika better than the saved item/);
  assert.match(text, /New words: SMOKED, PAPRIKA\. Words no longer printed: SEA, SALT\./);
  assert.doesNotMatch(text, /same product|If it is still/);
  // A plain rewording of the saved flavour still goes to a person unflagged, the saved item first.
  s.save('R100', 'HILLTOP AGED CHEDDAR WHEEL', { kind: 'square', variationId: 'V_CHEDDAR' });
  const plain = asCandidates(s.match({ item_number: 'R100', description: 'HILLTOP CHEDDAR' }));
  assert.equal(plain.possibleMisread, false);
  assert.equal(plain.candidates[0]!.variationId, 'V_CHEDDAR');
  assert.match(plain.reasons.join(' '), /Words no longer printed: AGED, WHEEL\. If it is still Hilltop Aged Cheddar 7102, confirm it/);
});

test('another size or count of a saved item never matches on its own: a person confirms the pack change once', (t) => {
  const extra = [
    item({ id: 'I_SCALLOP', name: 'Dry Sea Scallops 4120', category: 'CAT_FISH', variations: [{ id: 'V_SCALLOP', cents: 2999, unit: 'UNIT_POUND_TEST' }] }),
    item({ id: 'I_OIL', name: 'Valley Grove - Olive Oil Tin', variations: [{ id: 'V_OIL', cents: 3999 }] }),
  ];
  const s = setup(t, testIndex(extra));
  s.save('S200', 'SALMON ATLANTIC FILLET SKIN ON 3-4 LB', { kind: 'square', variationId: 'V_SALMON' });
  s.save('S300', 'SCALLOPS DRY 10/20', { kind: 'square', variationId: 'V_SCALLOP' });
  s.save('S400', 'EXTRA VIRGIN OLIVE OIL TIN 3 LTR', { kind: 'square', variationId: 'V_OIL' }, '', 'VALLEY GROVE');
  const pairs: [string, string, string, string][] = [
    ['S200', 'SALMON ATLANTIC FILLET SKIN ON 2-3 LB', '', 'V_SALMON'],
    ['S300', 'SCALLOPS DRY U10', '', 'V_SCALLOP'],
    ['S400', 'EXTRA VIRGIN OLIVE OIL TIN 1 LTR', 'VALLEY GROVE', 'V_OIL'],
  ];
  for (const [itemNumber, description, brand, variationId] of pairs) {
    const m = asCandidates(s.match({ item_number: itemNumber, description, brand }));
    assert.equal(m.possibleMisread, false, `${description}: no second reading for a pack change`);
    assert.equal(m.candidates[0]!.variationId, variationId);
    assert.match(m.reasons.join(' '), /New words: .*Words no longer printed: /);
  }
  // Same size, spaced differently: still automatic.
  assert.equal(asMatched(s.match({ item_number: 'S200', description: 'SALMON ATLANTIC FILLET SKIN ON 3-4LB' })).match.variationId, 'V_SALMON');
  // Once a person confirms the new size under that number, it matches on its own.
  s.save('S200', 'SALMON ATLANTIC FILLET SKIN ON 2-3 LB', { kind: 'square', variationId: 'V_SALMON' });
  assert.equal(asMatched(s.match({ item_number: 'S200', description: 'SALMON ATLANTIC FILLET SKIN ON 2-3 LB' })).match.variationId, 'V_SALMON');
});

test('a not-for-resale row is checked like any saved match', (t) => {
  const s = setup(t);
  s.save('B200', 'UNSALTED BUTTER 30/1LB', { kind: 'not_for_resale' });
  s.save('B201', 'HILLTOP AGED CHEDDAR', { kind: 'square', variationId: 'V_CHEDDAR' });
  // The cheddar's number read as the butter's: not skipped as not for resale.
  const toButter = s.match({ item_number: 'B200', description: 'HILLTOP AGED CHEDDAR' });
  assert.notEqual(toButter.status, 'not_for_resale');
  assert.equal((toButter as CandidatesLine).possibleMisread, true);
  // The butter's number read as the cheddar's: not matched to the cheddar.
  const toCheddar = s.match({ item_number: 'B201', description: 'UNSALTED BUTTER 30/1LB' });
  assert.notEqual(toCheddar.status, 'matched');
  assert.match(toCheddar.reasons.join(' '), /saved as not for resale/);
});

test('a valid printed UPC decides: on another Square item it refuses the saved row, on the saved item it confirms it', (t) => {
  const s = setup(t);
  s.save('H800', 'BLUECREST SEA SALT', { kind: 'square', variationId: 'V_CRACKER' });
  const elsewhere = asCandidates(s.match({ item_number: 'H800', upc: UPC_CRACKER_ROSE, description: 'BLUECREST SEA SALT' }));
  assert.deepEqual(elsewhere.candidates.slice(0, 2).map((c) => c.variationId).sort(), ['V_CRACKER', 'V_CRACKER_ROSE']);
  assert.equal(elsewhere.possibleMisread, true);
  const confirmed = asMatched(s.match({ item_number: 'H800', upc: UPC_CRACKER, description: 'SOMETHING ODD' }));
  assert.equal(confirmed.match.variationId, 'V_CRACKER');
  assert.match(confirmed.reasons.join(' '), /printed UPC confirms the saved item/);
});

test('a different brand on the line than the one saved: a person checks it', (t) => {
  const s = setup(t);
  s.save('K100', 'SEA SALT CRACKERS', { kind: 'square', variationId: 'V_CRACKER' }, '', 'BLUECREST');
  assert.equal(asMatched(s.match({ item_number: 'K100', description: 'SEA SALT CRACKERS', brand: 'BLUECREST' })).match.variationId, 'V_CRACKER');
  assert.equal(asMatched(s.match({ item_number: 'K100', description: 'SEA SALT CRACKERS', brand: 'BLUECRE' })).match.variationId, 'V_CRACKER', 'a brand cut short is the same brand');
  const sub = asCandidates(s.match({ item_number: 'K100', description: 'SEA SALT CRACKERS', brand: 'NORTHFIELD' }));
  assert.match(sub.reasons.join(' '), /brand on the invoice \(NORTHFIELD\) differs/);
});

test('pricing gets the item its own scale code, so a wine year that is another item\'s code stays a year', () => {
  const salami = item({ id: 'I_YEAR_SALAMI', name: 'Spiced Salami 2021', category: 'CAT_MEAT', variations: [{ id: 'V_YEAR_SALAMI', cents: 1999, unit: 'UNIT_POUND_TEST' }] });
  const index = testIndex([salami]);
  assert.equal(index.byScaleCode.has('2021'), true, '2021 is a real code on the salami');
  const wine = index.itemById.get('I_WINE')!;
  assert.equal(wine.scaleCode, null);
  const wineObject = testObjects().find((o) => o.id === 'I_WINE') as { item_data: { variations: unknown[] } };
  const state = squareItemState(wineObject, wineObject.item_data.variations[0], LOCATION, index.perPoundUnitIds, wine.scaleCode);
  assert.equal(state.scaleCode, null);
});


test('a printed UPC that contradicts the saved one: candidates, and a possible misread', (t) => {
  const s = setup(t);
  s.save('D400', 'BLUECREST SEA SALT', { kind: 'square', variationId: 'V_CRACKER' }, UPC_CRACKER);
  const m = asCandidates(s.match({ item_number: 'D400', upc: UPC_CRACKER_ROSE, description: 'BLUECREST SEA SALT' }));
  assert.deepEqual(m.candidates.slice(0, 2).map((c) => c.variationId).sort(), ['V_CRACKER', 'V_CRACKER_ROSE'], 'both codes first, then names');
  assert.equal(m.possibleMisread, true);
});

test('misread codes: a failed check digit, a code one digit from a Square UPC, a near saved item number', (t) => {
  const x = upcA('00077705123');
  const s = setup(t, testIndex([item({ id: 'I_X', name: 'Unusual Preserve', variations: [{ id: 'V_X', upc: x }] })]));
  const bad = `${x.slice(0, 11)}${(Number(x[11]) + 3) % 10}`;
  const m1 = s.match({ upc: bad, description: 'QUANTUM WIDGET' });
  assert.equal(m1.status === 'new_item' && m1.possibleMisread, true);
  assert.match(m1.reasons.join(' '), /fails its check digit/);
  // Swapping a 0 and a 5 side by side keeps the check digit valid. It is still one edit away.
  const swapped = `${x.slice(0, 6)}${x[7]}${x[6]}${x.slice(8)}`;
  assert.notEqual(swapped, x);
  const m2 = s.match({ upc: swapped, description: 'QUANTUM WIDGET' });
  assert.equal(m2.status === 'new_item' && m2.possibleMisread, true);
  assert.match(m2.reasons.join(' '), /one digit away from a UPC in Square/);
  const dropped = `${x.slice(0, 4)}${x.slice(5)}`;
  assert.equal((s.match({ upc: dropped, description: 'QUANTUM WIDGET' }) as CandidatesLine).possibleMisread, true);
  s.save('E5000', 'FENNEL SALAMI CHUB', { kind: 'square', variationId: 'V_SALAMI' });
  const near = asCandidates(s.match({ item_number: 'E5001', description: 'FENNEL SALAMI CHUB' }));
  assert.equal(near.possibleMisread, true);
  assert.match(near.reasons.join(' '), /one character from saved item E5000/);
  // One character away but a different product: a new item from dense numbering, not a misread.
  assert.equal(s.match({ item_number: 'E5001', description: 'QUANTUM WIDGET' }).status === 'new_item', true);
  assert.equal((s.match({ item_number: 'E5001', description: 'QUANTUM WIDGET' }) as { possibleMisread: boolean }).possibleMisread, false);
});

test('an 11-digit UPC (no leading zero, or no check digit) is offered, not matched, and not a misread', (t) => {
  const s = setup(t);
  const m = asCandidates(s.match({ upc: UPC_CRACKER.slice(1), description: 'QUANTUM WIDGET' }));
  assert.equal(m.candidates[0]!.variationId, 'V_CRACKER');
  assert.match(m.candidates[0]!.reasons.join(' '), /leading zero/);
  assert.equal(m.possibleMisread, false);
  const noCheck = asCandidates(s.match({ upc: UPC_CRACKER.slice(0, 11), description: 'QUANTUM WIDGET' }));
  assert.equal(noCheck.candidates[0]!.variationId, 'V_CRACKER');
  assert.match(noCheck.candidates[0]!.reasons.join(' '), /check digit added/);
  assert.equal(noCheck.possibleMisread, false);
});

test('a matched item with a scale code that is not sold by weight carries the rule 12 warning', (t) => {
  const s = setup(t);
  s.save('F600', 'COHO SALMON FILLET', { kind: 'square', variationId: 'V_SALMON' });
  const m = asMatched(s.match({ item_number: 'F600', description: 'COHO SALMON FILLET' }));
  assert.equal(m.facts.scaleCode, '4101');
  assert.equal(m.facts.byWeight.ok, false);
  assert.equal(m.facts.pricing, 'variable');
  assert.match(m.warnings.join(' '), /scale code 4101, so it must be sold by weight/);
  assert.equal(m.facts.hasMakerUpc, false, 'a code-built UPC is not a maker UPC');
});

test('an unknown supplier: suggestions for a person, and no saved mapping is used', (t) => {
  const s = setup(t);
  s.save('A100', 'HILLTOP AGED CHEDDAR', { kind: 'square', variationId: 'V_CHEDDAR' });
  const reading = checkReading(invoice({ supplier_name: 'Acme Fish', lines: [line({ item_number: 'A100', description: 'HILLTOP AGED CHEDDAR' })] }), { settings: DEFAULT_INVOICE_SETTINGS, today: TODAY });
  const r = matchReading({ db: s.db, index: s.index }, reading);
  assert.equal(r.supplier.status, 'unknown');
  assert.deepEqual(r.supplier.status === 'unknown' ? r.supplier.suggestions.map((x) => x.id) : [], [s.supplier.id]);
  assert.equal(r.lines[0]!.status, 'candidates');
});

test('a saved Square item that left the catalog is reported and matched again from scratch', (t) => {
  const extra = item({ id: 'I_GONE', name: 'Vanished Cheese 7199', variations: [{ id: 'V_GONE', unit: 'UNIT_POUND_TEST' }] });
  const s = setup(t, testIndex([extra]));
  s.save('G700', 'HILLTOP AGED CHEDDAR', { kind: 'square', variationId: 'V_GONE' });
  const m = createLineMatcher({ db: s.db, index: testIndex() }, s.supplier)(line({ item_number: 'G700', description: 'HILLTOP AGED CHEDDAR' }), 1);
  assert.equal(m.status, 'candidates');
  assert.match(m.warnings.join(' '), /no longer in the catalog/);
});
