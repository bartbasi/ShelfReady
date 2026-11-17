// One folding for supplier names and vendor formula names, and what happens when settings saved
// before that folding hold two vendor lines that are now one name. Invented names only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '../src/db/db.ts';
import { companyKey } from '../src/lib/names.ts';
import { supplierKey } from '../src/matching/suppliers.ts';
import { chooseFormula, vendorKey, VendorFormulaClash, vendorNameClash } from '../src/pricing/formula.ts';
import { loadOrCreateMasterKey, seal } from '../src/settings/crypto.ts';
import { parseVendorLines, SettingError } from '../src/settings/schema.ts';
import { createSettings } from '../src/settings/store.ts';
import { tempDir } from './server-helpers.ts';

const STD = { addBefore: '0.00', multiplier: '2', addAfter: '1.00', rounding: 'up-to-99' as const };
const ADD = { addBefore: '2.25', multiplier: '2', addAfter: '0.00', rounding: 'up-to-99' as const };

test('supplier names and vendor formula names fold the same way', () => {
  for (const [a, b] of [
    ['Acme', 'Acme Inc.'],
    ['Example’s Cheese Co', "EXAMPLE'S CHEESE"],
    ['Café & Bar', 'cafe and bar'],
  ]) {
    assert.equal(vendorKey(a!), vendorKey(b!), `${a} vs ${b}`);
    assert.equal(supplierKey(a!), companyKey(a!));
    assert.equal(vendorKey(a!), companyKey(a!));
  }
  assert.notEqual(vendorKey('Example Foods'), vendorKey('Example Food'));
});

test('settings saved before the folding changed, holding "Acme" and "Acme Inc.": they load, then pricing refuses with plain words', (t) => {
  const dir = tempDir();
  const db = openDatabase(join(dir, 's.sqlite3'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const mk = loadOrCreateMasterKey(join(dir, 'master.key'), []);
  // Written the way an older version stored it, past today's check on save.
  const old = { default: STD, vendors: [{ vendor: 'Acme', formula: STD }, { vendor: 'Acme Inc.', formula: ADD }, { vendor: 'Zenith Dairy', formula: ADD }] };
  const sealed = seal(mk, JSON.stringify(old), 'value:pricing');
  db.prepare('INSERT INTO settings (name, key_id, nonce, ciphertext, tag, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('value:pricing', sealed.keyId, sealed.nonce, sealed.ciphertext, sealed.tag, '2026-11-01T00:00:00Z');
  const settings = createSettings(db, mk, { allowSquareProduction: false });

  const pricing = settings.getSetting('pricing');
  assert.equal(pricing.vendors.length, 3, 'loading does not crash');
  assert.deepEqual(settings.view().damaged, [], 'the settings page still opens');
  assert.match(vendorNameClash(pricing)!, /^Acme and Acme Inc\.: these vendor formulas in settings are now one name/);
  assert.throws(() => chooseFormula(pricing, 'ACME INC'), (err: unknown) => err instanceof VendorFormulaClash && /Acme and Acme Inc\./.test(err.message));
  assert.equal(chooseFormula(pricing, 'Zenith Dairy').source, 'vendor', 'other vendors still price');
  assert.equal(chooseFormula(pricing, null).source, 'default');
  // Saving the same two lines again is refused on the settings page.
  assert.throws(() => parseVendorLines('Acme | 0 | 2 | 1.00\nAcme Inc. | 2.25 | 2 | 0.00'), (err: unknown) => err instanceof SettingError && /listed twice/.test(err.message));
  assert.equal(vendorNameClash({ default: STD, vendors: [{ vendor: 'Acme', formula: STD }] }), null);
});
