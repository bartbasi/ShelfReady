// Formula price against today's Square price, for real invoice lines. Information for Bart,
// not a test: it shows where the register already disagrees with the formula.
//
//   node scripts/pricing/compare-real.ts [--pins test-invoices/pins.json]
//
// Reads test-invoices/expected/*.json (hand-made ground truth) and data/square/live-catalog.json
// (the read-only live catalog copy). Both are store data; nothing here is written anywhere, and
// no API is called. Output goes to the terminal only.
//
// A line is compared only when its Square item is pinned down safely:
//   - by exact UPC: the invoice UPC and one Square variation's UPC are the same valid code
//     (leading zeros aside), and no other variation has it; or
//   - by exact scale code: a pins file (store data, kept out of git) says that a supplier's item
//     number is a given scale code, and exactly one Square item, with one variation, ends in it.
// Names are never used to match here.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gtinCheckDigitValid } from '../../src/invoice/checks.ts';
import { validateExpected, type ExpectedInvoice } from '../../src/invoice/expected.ts';
import { basisInputFrom } from '../../src/pricing/basis.ts';
import { vendorKey } from '../../src/pricing/formula.ts';
import { memoryOverrideStore } from '../../src/pricing/overrides.ts';
import { priceLine, type PricedLine, type SquareItemState } from '../../src/pricing/price.ts';
import { perPoundUnitIds, squareItemState, trailingScaleCode } from '../../src/pricing/square-state.ts';
import { defaultSettings } from '../../src/settings/schema.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXPECTED = join(ROOT, 'test-invoices/expected');
const CATALOG = join(ROOT, 'data/square/live-catalog.json');

interface Pin {
  supplier: string;
  itemNumber: string;
  scaleCode: string;
}

function gtinKey(text: string): string | null {
  const d = text.replace(/[\s-]/g, '');
  if (!/^\d+$/.test(d) || ![8, 12, 13, 14].includes(d.length) || !gtinCheckDigitValid(d)) return null;
  return d.padStart(14, '0');
}

function dollars(c: number | null): string {
  if (c === null) return '-';
  const sign = c < 0 ? '-' : '';
  const a = Math.abs(c);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

function readPins(): Pin[] {
  const i = process.argv.indexOf('--pins');
  if (i < 0) return [];
  const path = process.argv[i + 1];
  if (!path) throw new Error('--pins needs a file.');
  const list = JSON.parse(readFileSync(path, 'utf8')) as Pin[];
  if (!Array.isArray(list)) throw new Error('The pins file must hold a list.');
  for (const p of list) {
    if (typeof p.supplier !== 'string' || typeof p.itemNumber !== 'string' || !/^\d{4}$/.test(String(p.scaleCode))) {
      throw new Error('Each pin needs supplier, itemNumber and a 4-digit scaleCode.');
    }
  }
  return list;
}

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
const locationId = String(catalog.location?.id ?? '');
const objects: any[] = catalog.objects ?? [];
const pounds = perPoundUnitIds(objects);

const live = objects.filter(
  (o) =>
    o.type === 'ITEM' &&
    !o.is_deleted &&
    !o.item_data?.is_archived &&
    (o.present_at_all_locations ? !(o.absent_at_location_ids ?? []).includes(locationId) : (o.present_at_location_ids ?? []).includes(locationId)),
);

// Exact UPC index. A key held by two variations is ambiguous and matches nothing.
const byUpc = new Map<string, { item: any; variation: any }[]>();
// Scale code index, from the end of the item name.
const byCode = new Map<string, any[]>();
for (const item of live) {
  for (const v of item.item_data?.variations ?? []) {
    if (v.is_deleted) continue;
    const key = gtinKey(String(v.item_variation_data?.upc ?? ''));
    if (key) byUpc.set(key, [...(byUpc.get(key) ?? []), { item, variation: v }]);
  }
  const code = trailingScaleCode(String(item.item_data?.name ?? ''));
  if (code) byCode.set(code, [...(byCode.get(code) ?? []), item]);
}

const pins = readPins();
const settings = defaultSettings().pricing;
const ctx = { settings, overrides: memoryOverrideStore(), decisions: [] };

interface Row {
  invoice: string;
  n: number;
  description: string;
  how: 'UPC' | 'scale code';
  squareName: string;
  priced: PricedLine;
}

const rows: Row[] = [];
const skipped = { noUpc: 0, badUpc: 0, upcNotInSquare: 0, upcAmbiguous: 0, pinNoItem: 0, pinAmbiguous: 0 };
let totalLines = 0;
const files = readdirSync(EXPECTED).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const e = JSON.parse(readFileSync(join(EXPECTED, f), 'utf8')) as ExpectedInvoice;
  const { reading } = validateExpected(e, new Date());
  for (const cl of reading.lines) {
    totalLines++;
    let hit: { item: any; variation: any } | null = null;
    let how: Row['how'] = 'UPC';
    const pin = pins.find((p) => vendorKey(p.supplier) === vendorKey(e.supplier) && p.itemNumber.trim() === cl.line.item_number.trim());
    if (pin) {
      how = 'scale code';
      const items = byCode.get(pin.scaleCode) ?? [];
      const variations = items.length === 1 ? (items[0].item_data?.variations ?? []).filter((v: any) => !v.is_deleted) : [];
      if (items.length === 0) skipped.pinNoItem++;
      else if (items.length > 1 || variations.length !== 1) skipped.pinAmbiguous++;
      else hit = { item: items[0], variation: variations[0] };
    } else if (!cl.line.upc.trim()) {
      skipped.noUpc++;
    } else {
      const key = gtinKey(cl.line.upc);
      const found = key ? (byUpc.get(key) ?? []) : [];
      if (!key) skipped.badUpc++;
      else if (found.length === 0) skipped.upcNotInSquare++;
      else if (found.length > 1) skipped.upcAmbiguous++;
      else hit = found[0]!;
    }
    if (!hit) continue;
    const square: SquareItemState = squareItemState(hit.item, hit.variation, locationId, pounds);
    const priced = priceLine({ n: cl.n, basis: basisInputFrom(cl), square, vendor: null }, ctx);
    rows.push({ invoice: e.name, n: cl.n, description: cl.line.description.split(' | ')[0]!.slice(0, 32), how, squareName: String(hit.item.item_data?.name ?? '').slice(0, 36), priced });
  }
}

console.log(`Formula: ${ctx.settings.default.addBefore} | ${ctx.settings.default.multiplier} | ${ctx.settings.default.addAfter} (default from settings), allowances ignored (regular cost).`);
console.log(`${files.length} invoices, ${totalLines} lines. Pinned: ${rows.length} (${rows.filter((r) => r.how === 'UPC').length} by UPC, ${rows.filter((r) => r.how === 'scale code').length} by scale code).`);
console.log(
  `Not pinned: ${skipped.noUpc} with no UPC printed, ${skipped.badUpc} with a UPC that fails its check digit, ` +
    `${skipped.upcNotInSquare} with a UPC no Square variation has, ${skipped.upcAmbiguous} with a UPC on two or more variations, ` +
    `${skipped.pinNoItem} pins with no Square item, ${skipped.pinAmbiguous} pins that are ambiguous.`,
);
if (pins.length === 0) console.log('No pins file given. Pass --pins <file> to pin supplier item numbers to scale codes.');

if (rows.length) {
  console.log('');
  console.log(['invoice', 'line', 'invoice text', 'square item', 'by', 'cost', 'formula', 'square', 'diff', 'flags'].join('\t'));
  for (const r of rows) {
    const p = r.priced;
    const cost = p.cost.ok ? `${p.cost.costText}/${p.cost.per}` : 'none';
    const diff = p.formulaCents !== null && p.squareCents !== null ? dollars(p.formulaCents - p.squareCents) : '-';
    const flags = p.flags.map((x) => x.id).filter((id) => id !== 'price_drop' && id !== 'big_jump');
    console.log([r.invoice, r.n, r.description, r.squareName, r.how, cost, dollars(p.formulaCents), dollars(p.squareCents), diff, flags.join(',') || (p.reason ?? '')].join('\t'));
  }
}

const compared = rows.filter((r) => r.priced.formulaCents !== null && r.priced.squareCents !== null);
const same = compared.filter((r) => r.priced.formulaCents === r.priced.squareCents).length;
const higher = compared.filter((r) => r.priced.formulaCents! > r.priced.squareCents!).length;
console.log('');
console.log(`Compared ${compared.length}: ${same} match Square, ${higher} where the formula is higher, ${compared.length - same - higher} where it is lower. ${rows.length - compared.length} pinned lines had no formula price or no Square price.`);
