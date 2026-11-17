// Suppliers, their aliases and the saved mapping, with the audit log. Invented values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAudit, type AuditActor } from '../src/db/audit.ts';
import { openDatabase, schemaVersion } from '../src/db/db.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import { confirmMapping, getMapping, lineKeys, lookupMapping, MappingError, removeMapping, setMappingStoreName, staleMappings } from '../src/matching/mapping.ts';
import { addSupplierAlias, createSupplier, findSupplier, removeSupplierAlias, setSupplierUpcRule, suggestSuppliers, SupplierError, supplierKey, vendorForSupplier } from '../src/matching/suppliers.ts';
import { item, testIndex, upcA } from './matching-fixtures.ts';

const MANAGER: AuditActor = { userId: null, username: 'manager1' };
const T0 = Date.parse('2026-11-07T15:00:00Z');

function db() {
  return openDatabase(':memory:');
}

test('migration 4 adds suppliers, aliases and the saved mapping', (t) => {
  const d = db();
  t.after(() => d.close());
  assert.equal(schemaVersion(d), MIGRATIONS.length);
  const tables = (d.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const name of ['suppliers', 'supplier_aliases', 'item_mappings']) assert.ok(tables.includes(name), name);
  const now = new Date(T0).toISOString();
  d.prepare("INSERT INTO suppliers (id, name, created_at, updated_at) VALUES (1, 'Test Supplier', ?, ?)").run(now, now);
  // A Square row needs a variation; a not-for-resale row must not have one.
  assert.throws(() => d.prepare("INSERT INTO item_mappings (supplier_id, line_key, kind, confirmed_at) VALUES (1, 'n:1', 'square', ?)").run(now));
  assert.throws(() => d.prepare("INSERT INTO item_mappings (supplier_id, line_key, kind, square_variation_id, confirmed_at) VALUES (1, 'n:1', 'not_for_resale', 'V', ?)").run(now));
  assert.throws(() => d.prepare("INSERT INTO item_mappings (supplier_id, line_key, kind, confirmed_at) VALUES (1, 'x:1', 'not_for_resale', ?)").run(now), 'line key kind');
  assert.throws(() => d.prepare("INSERT INTO suppliers (name, upc_item_rule, created_at, updated_at) VALUES ('X', 'not json', ?, ?)").run(now, now));
});

test('supplier names: one key for every way a name is printed', () => {
  assert.equal(supplierKey('Acme Fish & Gourmet, Inc.'), 'acme fish and gourmet');
  assert.equal(supplierKey('ACME FISH AND GOURMET'), 'acme fish and gourmet');
  assert.equal(supplierKey('The Acme Company LLC'), 'acme');
  assert.equal(supplierKey('Café Provisions Co.'), 'cafe provisions');
});

test('suppliers: created once, aliases added only for the same supplier, every change audited', (t) => {
  const d = db();
  t.after(() => d.close());
  const s = createSupplier(d, MANAGER, 'Acme Fish & Gourmet', T0);
  assert.equal(findSupplier(d, 'ACME FISH AND GOURMET, INC.')?.id, s.id);
  assert.equal(findSupplier(d, 'Acme Fish'), null, 'a shorter name is not the same supplier until a person says so');
  assert.deepEqual(suggestSuppliers(d, 'Acme Fish').map((x) => x.id), [s.id], 'but it is suggested');
  assert.deepEqual(suggestSuppliers(d, 'Zenith Dairy'), []);
  addSupplierAlias(d, MANAGER, s.id, 'Acme Fish', T0 + 1);
  assert.equal(findSupplier(d, 'acme fish')?.id, s.id);
  const other = createSupplier(d, MANAGER, 'Zenith Dairy', T0 + 2);
  assert.throws(() => addSupplierAlias(d, MANAGER, other.id, 'Acme Fish Inc'), SupplierError);
  assert.throws(() => createSupplier(d, MANAGER, 'ACME FISH'), SupplierError);
  assert.throws(() => createSupplier(d, MANAGER, 'Inc.'), SupplierError);
  assert.throws(() => createSupplier(d, MANAGER, 'Bad\u0000Name'), SupplierError);
  removeSupplierAlias(d, MANAGER, s.id, 'acme fish', T0 + 3);
  assert.equal(findSupplier(d, 'Acme Fish'), null);
  assert.throws(() => removeSupplierAlias(d, MANAGER, other.id, 'Zenith Dairy'), /at least one name/);
  setSupplierUpcRule(d, MANAGER, s.id, { prefixes: ['000333'], from: 7, to: 11 }, T0 + 4);
  assert.deepEqual(findSupplier(d, 'Acme Fish & Gourmet')?.upcItemRule, { prefixes: ['000333'], from: 7, to: 11 });
  assert.throws(() => setSupplierUpcRule(d, MANAGER, s.id, { prefixes: [], from: 7, to: 11 }), SupplierError);
  setSupplierUpcRule(d, MANAGER, s.id, null, T0 + 5);
  assert.equal(findSupplier(d, 'Acme Fish & Gourmet')?.upcItemRule, null);
  const actions = listAudit(d).map((r) => `${r.action} ${r.username}`).reverse();
  assert.deepEqual(actions, [
    'supplier.create manager1',
    'supplier.alias_add manager1',
    'supplier.create manager1',
    'supplier.alias_remove manager1',
    'supplier.upc_rule manager1',
    'supplier.upc_rule manager1',
  ]);
});

test('line keys: the item number as printed, else the UPC, else the description', () => {
  assert.deepEqual(lineKeys({ itemNumber: ' o12 00 ', upc: '', description: 'X' }), { lineKey: 'n:O1200', rawItem: 'O1200', itemKey: '01200', upcKey: '' });
  const upc = upcA('00011122233');
  assert.deepEqual(lineKeys({ itemNumber: '', upc, description: 'X' }), { lineKey: `u:00${upc}`, rawItem: '', itemKey: '', upcKey: `00${upc}` });
  assert.equal(lineKeys({ itemNumber: '', upc: '', description: 'SMOKED GOUDA LOG | more' })?.lineKey, 'd:smok gouda log', 'the same words matching uses');
  assert.equal(lineKeys({ itemNumber: '', upc: '123', description: '' }), null);
});

test('saved mapping: confirm, change, the same choice again, store name, remove; each audited with user and time', (t) => {
  const d = db();
  t.after(() => d.close());
  const index = testIndex();
  const s = createSupplier(d, MANAGER, 'Acme Fish & Gourmet', T0);
  const line = { itemNumber: 'A100', upc: '', description: 'SMOKED GOUDA LOG' };
  const m = confirmMapping(d, MANAGER, { supplierId: s.id, line, target: { kind: 'square', variationId: 'V_GOUDA' }, catalog: index }, T0 + 1);
  assert.equal(m.variationId, 'V_GOUDA');
  assert.equal(m.itemId, 'I_GOUDA');
  assert.equal(m.storeName, 'Gouda Smoked 7101', 'the store name defaults to the Square name');
  assert.equal(m.invoiceName, 'SMOKED GOUDA LOG');
  assert.equal(m.confirmedByName, 'manager1');
  assert.equal(m.confirmedAt, new Date(T0 + 1).toISOString());
  // The same choice again changes nothing and logs nothing.
  assert.equal(confirmMapping(d, MANAGER, { supplierId: s.id, line, target: { kind: 'square', variationId: 'V_GOUDA' }, catalog: index }, T0 + 2).id, m.id);
  const boss: AuditActor = { userId: null, username: 'admin1' };
  const changed = confirmMapping(d, boss, { supplierId: s.id, line, target: { kind: 'square', variationId: 'V_CHEDDAR' }, catalog: index }, T0 + 3);
  assert.equal(changed.id, m.id);
  assert.equal(changed.variationId, 'V_CHEDDAR');
  assert.equal(changed.confirmedByName, 'admin1');
  setMappingStoreName(d, boss, m.id, 'Hilltop Cheddar', T0 + 4);
  assert.equal(getMapping(d, m.id)?.storeName, 'Hilltop Cheddar');
  assert.throws(() => setMappingStoreName(d, boss, m.id, '   '), MappingError);
  const nfr = confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber: 'B200', upc: '', description: 'UNSALTED BUTTER 30/1LB' }, target: { kind: 'not_for_resale' }, catalog: index }, T0 + 5);
  assert.equal(nfr.kind, 'not_for_resale');
  assert.equal(nfr.variationId, null);
  removeMapping(d, boss, m.id, T0 + 6);
  assert.equal(getMapping(d, m.id), null);
  assert.throws(() => removeMapping(d, boss, m.id), MappingError);
  const rows = listAudit(d).reverse().filter((r) => r.action.startsWith('mapping.'));
  assert.deepEqual(rows.map((r) => `${r.action} ${r.username}`), ['mapping.confirm manager1', 'mapping.change admin1', 'mapping.change admin1', 'mapping.confirm manager1', 'mapping.remove admin1']);
  assert.equal(rows[1]!.at, new Date(T0 + 3).toISOString());
  const details = JSON.parse(rows[1]!.details) as { from: { variationId: string }; to: { variationId: string } };
  assert.equal(details.from.variationId, 'V_GOUDA');
  assert.equal(details.to.variationId, 'V_CHEDDAR');
  assert.equal(JSON.parse(rows[4]!.details).from.variationId, 'V_CHEDDAR', 'a removal keeps what was removed');
});

test('saved mapping refuses an unknown Square item, an unknown supplier and a line with nothing to go by', (t) => {
  const d = db();
  t.after(() => d.close());
  const index = testIndex();
  const s = createSupplier(d, MANAGER, 'Acme', T0);
  const line = { itemNumber: 'A100', upc: '', description: 'X' };
  assert.throws(() => confirmMapping(d, MANAGER, { supplierId: s.id, line, target: { kind: 'square', variationId: 'V_NOPE' }, catalog: index }), /not in the catalog/);
  assert.throws(() => confirmMapping(d, MANAGER, { supplierId: 999, line, target: { kind: 'not_for_resale' }, catalog: index }), /supplier does not exist/);
  assert.throws(() => confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber: '', upc: '', description: '' }, target: { kind: 'not_for_resale' }, catalog: index }), MappingError);
  assert.equal(listAudit(d).filter((r) => r.action.startsWith('mapping.')).length, 0, 'nothing refused reaches the log');
});

test('lookup: the exact key first; item numbers that differ only by O and 0 come back apart', (t) => {
  const d = db();
  t.after(() => d.close());
  const index = testIndex();
  const s = createSupplier(d, MANAGER, 'Acme', T0);
  const letter = confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber: 'O1200', upc: '', description: 'TAVERN HAM' }, target: { kind: 'square', variationId: 'V_HAM' }, catalog: index }, T0);
  const digit = confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber: '01200', upc: '', description: 'ROASTED TURKEY' }, target: { kind: 'square', variationId: 'V_TURKEY' }, catalog: index }, T0);
  assert.notEqual(letter.id, digit.id, 'two real item numbers that collide under O as 0 are both kept');
  const found = lookupMapping(d, s.id, lineKeys({ itemNumber: 'O1200', upc: '', description: '' })!);
  assert.equal(found.exact?.id, letter.id);
  assert.deepEqual(found.lookalikes.map((m) => m.id), [digit.id]);
  const neither = lookupMapping(d, s.id, lineKeys({ itemNumber: '0I200', upc: '', description: '' })!);
  assert.equal(neither.exact, null);
  assert.deepEqual(neither.lookalikes.map((m) => m.id).sort(), [letter.id, digit.id].sort());
});

test('a vendor formula in settings applies to the supplier whose names include it', (t) => {
  const d = db();
  t.after(() => d.close());
  const s = createSupplier(d, MANAGER, 'Hilltop Cheese Cellars, Inc.', T0);
  assert.deepEqual(vendorForSupplier(s, ['Hilltop Cheese Cellars', 'Zenith Dairy']), { status: 'one', vendor: 'Hilltop Cheese Cellars' });
  // A shorter name in settings is not guessed at: a person adds it as one of the supplier's names.
  assert.deepEqual(vendorForSupplier(s, ["Hilltop's"]), { status: 'none' });
  const linked = addSupplierAlias(d, MANAGER, s.id, "Hilltop's", T0 + 1);
  assert.deepEqual(vendorForSupplier(linked, ["Hilltop's", 'Zenith Dairy']), { status: 'one', vendor: "Hilltop's" });
  // Two settings vendors that both fit one supplier: said plainly, never a silent default.
  const two = vendorForSupplier(linked, ["Hilltop's", 'Hilltop Cheese Cellars']);
  assert.equal(two.status, 'ambiguous');
  assert.match(two.status === 'ambiguous' ? two.problem : '', /^Ambiguous vendor formula: Hilltop's, Hilltop Cheese Cellars in settings all fit/);
});

test('a refresh report lists saved matches whose Square item is gone, archived or not offered here', (t) => {
  const d = db();
  t.after(() => d.close());
  const extra = [
    item({ id: 'I_GOING', name: 'Going Cheese 7190', variations: [{ id: 'V_GOING', unit: 'UNIT_POUND_TEST' }] }),
  ];
  const before = testIndex(extra);
  const s = createSupplier(d, MANAGER, 'Acme', T0);
  const save = (itemNumber: string, variationId: string) => confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber, upc: '', description: itemNumber }, target: { kind: 'square', variationId }, catalog: before }, T0);
  save('S1', 'V_GOUDA');
  save('S2', 'V_GOING');
  save('S3', 'V_OLD');
  save('S4', 'V_AWAY');
  confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber: 'S5', upc: '', description: 'BUTTER' }, target: { kind: 'not_for_resale' }, catalog: before }, T0);
  const after = testIndex();
  const stale = staleMappings(d, after).map((x) => [x.mapping.itemNumber, x.kind]);
  assert.deepEqual(stale, [['S2', 'missing'], ['S3', 'archived'], ['S4', 'not_offered_here']]);
  assert.match(staleMappings(d, after)[0]!.message, /S2 \(saved as Going Cheese 7190\): the Square item is no longer in the catalog/);
});

test('the brand on the line is saved with the match', (t) => {
  const d = db();
  t.after(() => d.close());
  const s = createSupplier(d, MANAGER, 'Acme', T0);
  const m = confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber: 'A1', upc: '', description: 'SEA SALT CRACKERS', brand: 'BLUECREST' }, target: { kind: 'square', variationId: 'V_CRACKER' }, catalog: testIndex() }, T0);
  assert.equal(m.invoiceBrand, 'BLUECREST');
  assert.equal(JSON.parse(listAudit(d, { action: 'mapping.confirm' })[0]!.details).to.invoiceBrand, 'BLUECREST');
});

test('each wording a person confirms is kept with the match; a new choice starts them again', (t) => {
  const d = db();
  t.after(() => d.close());
  const index = testIndex();
  const s = createSupplier(d, MANAGER, 'Acme', T0);
  const save = (description: string, variationId: string, at: number) =>
    confirmMapping(d, MANAGER, { supplierId: s.id, line: { itemNumber: 'W1', upc: '', description, brand: 'HILLTOP' }, target: { kind: 'square', variationId }, catalog: index }, at);
  save('AGED CHEDDAR WHEEL', 'V_CHEDDAR', T0);
  assert.equal(save('aged  cheddar, wheel', 'V_CHEDDAR', T0 + 1).wordings.length, 1, 'the same printing with other spacing is one wording');
  const two = save('AGED CHEDDAR', 'V_CHEDDAR', T0 + 2);
  assert.deepEqual(two.wordings.map((w) => w.description), ['AGED CHEDDAR WHEEL', 'AGED CHEDDAR']);
  assert.equal(two.invoiceName, 'AGED CHEDDAR', 'the latest wording is shown');
  assert.deepEqual(listAudit(d).reverse().map((r) => r.action), ['supplier.create', 'mapping.confirm', 'mapping.wording_add']);
  for (let i = 0; i < 25; i++) save(`AGED CHEDDAR LOT ${i}`, 'V_CHEDDAR', T0 + 10 + i);
  const capped = getMapping(d, two.id)!;
  assert.equal(capped.wordings.length, 20, 'at most 20 kept, the newest');
  assert.equal(capped.wordings.at(-1)!.description, 'AGED CHEDDAR LOT 24');
  const moved = save('AGED CHEDDAR', 'V_GOUDA', T0 + 100);
  assert.deepEqual(moved.wordings.map((w) => w.description), ['AGED CHEDDAR'], 'a different choice starts the wordings again');
  removeMapping(d, MANAGER, moved.id, T0 + 101);
  assert.equal((d.prepare('SELECT count(*) AS n FROM item_mapping_wordings').get() as { n: number }).n, 0, 'removing a match removes its wordings');
});

