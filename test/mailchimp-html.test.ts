// The fish email editor, on the invented fixture and, when present, on the real saved campaigns in
// data/mailchimp (store data, never in git; those tests are skipped without it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { editEmail, findDateLine, parseRows, rowProblem, setDateLine, verifyEmail } from '../src/mailchimp/html.ts';
import { loadMailchimpConfig } from '../src/mailchimp/config.ts';
import { unitCheck } from '../src/mailchimp/plan.ts';
import { SOURCE_NAME } from '../scripts/mailchimp/make-wednesday.ts';
import { FIXTURE_HTML, realCampaignFile, testConfig } from './mailchimp-fixtures.ts';

const cfg = testConfig();
const opts = (dateText: string | null) => ({ units: cfg.units, dateLine: cfg.dateLine, dateText });

/** Everything outside the replaced ranges must be byte for byte the same. */
function onlyChanged(before: string, after: string, allowed: string[]): void {
  let i = 0;
  while (i < before.length && before[i] === after[i]) i++;
  let j = 0;
  while (j < before.length - i && before[before.length - 1 - j] === after[after.length - 1 - j]) j++;
  const changed = after.slice(i, after.length - j);
  assert.ok(allowed.some((a) => a.includes(changed) || changed.includes(a)) || changed === '', `unexpected change: ${changed.slice(0, 200)}`);
}

test('parses every row of the invented email, with keys, units and sections', () => {
  const rows = parseRows(FIXTURE_HTML);
  assert.equal(rows.length, 12);
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys.slice(0, 5), ['Test King Salmon (Testland)', 'Test Atlantic Salmon', 'Salmon Heads', 'Sea Bass (Farmed)', 'Sea Bass (Wild)']);
  assert.ok(keys.includes('White Fish Bones & Scrap'));
  assert.ok(keys.includes("Example's Fish Stock (16 oz)"));
  const call = rows.find((r) => r.name === 'Giant Lobster')!;
  assert.equal(call.cents, null);
  assert.match(rowProblem(call, cfg.units)!, /not a price like/);
  const uni = rows.find((r) => r.name === 'Sea Urchin')!;
  assert.equal(uni.cents, null);
  const doz = rows.find((r) => r.name === 'Littlenecks')!;
  assert.equal(doz.cents, 599);
  assert.match(rowProblem(doz, cfg.units)!, /sold by the doz/);
  assert.equal(rows.find((r) => r.name === 'Sea Bass')!.section, 'Additional fresh fish');
  assert.equal(rows[0]!.section, 'Salmon & trout');
});

test('changes only the price text of the rows asked for, and adds the date line at the top', () => {
  const r = editEmail(FIXTURE_HTML, [{ key: 'Sea Bass (Wild)', toCents: 3399 }, { key: 'test king salmon  (testland)', toCents: 2599 }], opts('Monday, November 16, 2026'));
  assert.equal(r.changes.length, 2);
  assert.deepEqual(r.changes.map((c) => [c.key, c.fromText, c.toText]), [['Sea Bass (Wild)', '$31.99', '$33.99'], ['Test King Salmon (Testland)', '$24.99', '$25.99']]);
  assert.ok(r.changes[0]!.before.includes('$31.99') && r.changes[0]!.after.includes('$33.99'));
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.dateLine, { from: null, to: 'Monday, November 16, 2026', inserted: true });
  const rows = parseRows(r.html);
  assert.equal(rows.find((x) => x.key === 'Sea Bass (Farmed)')!.priceText, '$29.99');
  assert.equal(rows.find((x) => x.key === 'Sea Bass (Wild)')!.priceText, '$33.99');
  // The other price in the email (the ham) is untouched, and so is every other byte.
  assert.ok(r.html.includes('<div class="price" style="font:52px/54px Georgia,serif;">$6.49</div>'));
  const withoutDate = r.html.replace(/<tr><td class="sr-fish-date"[^>]*>[^<]*<\/td><\/tr>/, '');
  assert.equal(withoutDate.replace('$33.99', '$31.99').replace('$25.99', '$24.99'), FIXTURE_HTML);
  // The date line is the first row of the top table.
  assert.match(r.html, /class="wrap"[^>]*><tr><td class="sr-fish-date" align="center" style="padding:12px 20px;color:#c82c2c;text-align:center;">Monday, November 16, 2026<\/td><\/tr><tr><td style="border-bottom/);
  assert.deepEqual(verifyEmail(r.html, { dateText: 'Monday, November 16, 2026', prices: [{ key: 'Sea Bass (Wild)', toText: '$33.99' }], dateLineClass: cfg.dateLine.class }), []);
});

test('a second edit updates the date line in place instead of adding another', () => {
  const first = editEmail(FIXTURE_HTML, [], opts('Monday, November 16, 2026')).html;
  const second = editEmail(first, [], opts('Wednesday, November 18, 2026'));
  assert.deepEqual(second.dateLine, { from: 'Monday, November 16, 2026', to: 'Wednesday, November 18, 2026', inserted: false });
  assert.equal(second.html.match(/sr-fish-date/g)!.length, 1);
  assert.equal(findDateLine(second.html, 'sr-fish-date')!.text, 'Wednesday, November 18, 2026');
  onlyChanged(first, second.html, ['Monday, November 16', 'Wednesday, November 18']);
  // The same date again changes nothing.
  const third = editEmail(second.html, [], opts('Wednesday, November 18, 2026'));
  assert.equal(third.html, second.html);
  // Staff restyling the date line keep their style: only the text is replaced.
  const restyled = second.html.replace('style="padding:12px 20px;color:#c82c2c;text-align:center;"', 'style="color:blue"');
  const fourth = editEmail(restyled, [], opts('Friday, November 20, 2026'));
  assert.ok(fourth.html.includes('<td class="sr-fish-date" align="center" style="color:blue">Friday, November 20, 2026</td>'));
});

test('a unit named like a built-in property is not a known unit', () => {
  const odd = FIXTURE_HTML.replace('$12.99<small>/lb</small>', '$12.99<small>/constructor</small>').replace('$5.99<small>/doz</small>', '$5.99<small>/toString</small>');
  const rows = parseRows(odd);
  for (const r of rows.filter((x) => x.unit === 'constructor' || x.unit === 'toString')) assert.match(rowProblem(r, cfg.units)!, /a unit ShelfReady does not compare/);
  const e = editEmail(odd, [{ key: 'White Fish Bones & Scrap', toCents: 1399 }, { key: 'Littlenecks', toCents: 699 }], opts(null));
  assert.equal(e.changes.length, 0);
  assert.equal(e.refused.length, 2);
  assert.equal(unitCheck(odd, [{ key: 'White Fish Bones & Scrap', itemId: 'I1', variationId: 'V1', label: 'x', toCents: 1399, perPound: true }], cfg).edits.length, 1);
});

test('refuses rather than guesses', () => {
  const r = editEmail(
    FIXTURE_HTML,
    [
      { key: 'Giant Lobster (Special order)', toCents: 9999 },
      { key: 'Sea Urchin (100 g package)', toCents: 15999 },
      { key: 'Littlenecks', toCents: 699 },
      { key: 'No Such Fish', toCents: 999 },
      { key: 'Salmon Heads', toCents: 399 },
      { key: 'Salmon Heads', toCents: 499 },
      { key: 'Mussels (Sold in 2 lb units)', toCents: 0 },
    ],
    opts(null),
  );
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.same, ['Salmon Heads']);
  assert.deepEqual(
    r.refused.map((x) => x.key),
    ['Giant Lobster (Special order)', 'Sea Urchin (100 g package)', 'Littlenecks', 'No Such Fish', 'Salmon Heads', 'Mussels (Sold in 2 lb units)'],
  );
  assert.equal(r.html, FIXTURE_HTML);
  // Two rows with the same name: neither is changed.
  const twice = FIXTURE_HTML.replace('Sea Bass</b><span style="color:#888"> (Wild)</span>', 'Sea Bass</b><span style="color:#888"> (Farmed)</span>');
  const t = editEmail(twice, [{ key: 'Sea Bass (Farmed)', toCents: 3099 }], opts(null));
  assert.equal(t.changes.length, 0);
  assert.match(t.refused[0]!.why, /more than one row/);
  // A row whose name holds markup is not a row ShelfReady knows, so it is never changed.
  const marked = FIXTURE_HTML.replace('>Salmon Heads</b>', '><i>Salmon</i> Heads</b>');
  assert.equal(editEmail(marked, [{ key: 'Salmon Heads', toCents: 499 }], opts(null)).refused[0]!.key, 'Salmon Heads');
});

test('the date line is refused when the top of the email is not the expected shape', () => {
  const noWrap = FIXTURE_HTML.replace('class="wrap"', 'class="other"');
  const r = setDateLine(noWrap, cfg.dateLine, 'Monday, November 16, 2026');
  assert.equal(r.html, noWrap);
  assert.match(r.problem, /top table/);
  const two = editEmail(FIXTURE_HTML, [], opts('Monday, November 16, 2026')).html;
  const doubled = two.replace('<tr><td style="border-bottom', '<tr><td class="sr-fish-date">Old</td></tr><tr><td style="border-bottom');
  assert.match(setDateLine(doubled, cfg.dateLine, 'Friday, November 20, 2026').problem, /more than one date line/);
  // The price edits still stand when the date line cannot be set.
  const e = editEmail(noWrap, [{ key: 'Salmon Heads', toCents: 499 }], opts('Monday, November 16, 2026'));
  assert.equal(e.changes.length, 1);
  assert.match(e.dateLineProblem, /top table/);
});

// ---- The real saved campaigns (store data). Skipped when data/mailchimp is not there.

const REAL_DIR = join(import.meta.dirname, '..', 'data', 'mailchimp');
const realFiles = existsSync(REAL_DIR) ? readdirSync(REAL_DIR).filter((f) => /^content-[a-z0-9]+\.html$/.test(f)) : [];
const realCampaigns: Array<{ id: string; status: string; send_time?: string }> = existsSync(join(REAL_DIR, 'campaigns.json'))
  ? (JSON.parse(readFileSync(join(REAL_DIR, 'campaigns.json'), 'utf8')) as { campaigns: Array<{ id: string; status: string; send_time?: string }> }).campaigns
  : [];
// The current layout started with the email sent October 16, 2026. Older emails use another
// layout, and campaigns.json holds whatever the last read-recent run listed, so it can include them.
const LAYOUT_SINCE = '2026-10-16';
const sentFiles = realFiles.filter((f) => realCampaigns.some((c) => c.status === 'sent' && (c.send_time ?? '') >= LAYOUT_SINCE && f === `content-${c.id}.html`));
// A sent email that ShelfReady has not edited yet (no date line), so the date line test starts clean.
// Monday November 9 when it is saved on disk (it was sent, then deleted from Mailchimp, so a new
// campaigns.json no longer lists it), otherwise the first such email. Refreshing data/mailchimp
// adds ShelfReady's own emails, which already hold a date line.
// Its id is store data, so it comes from config/local/mailchimp.json (campaigns.makeWednesdaySource).
const mondayPath = realCampaignFile(SOURCE_NAME);
const MONDAY_NOV_9 = mondayPath ? basename(mondayPath) : '';
const undatedFiles = sentFiles.filter((f) => !readFileSync(join(REAL_DIR, f), 'utf8').includes('sr-fish-date'));
const undatedFile = MONDAY_NOV_9 && existsSync(join(REAL_DIR, MONDAY_NOV_9)) && !readFileSync(join(REAL_DIR, MONDAY_NOV_9), 'utf8').includes('sr-fish-date') ? MONDAY_NOV_9 : undatedFiles[0];

test('real campaigns: every row is found, and only the expected ones are refused', { skip: sentFiles.length === 0 && 'no saved campaigns in data/mailchimp' }, () => {
  const real = loadMailchimpConfig();
  for (const f of sentFiles) {
    const html = readFileSync(join(REAL_DIR, f), 'utf8');
    const rows = parseRows(html);
    // Every price set in the float style is a row: none is missed.
    const priceTags = html.match(/<b style="float:right[^"]*">/g) ?? [];
    assert.equal(rows.length, priceTags.length, f);
    const editable = rows.filter((r) => rowProblem(r, real.units) === null);
    const units = new Set(rows.filter((r) => r.cents !== null).map((r) => r.unit));
    for (const u of units) assert.ok(['lb', 'doz', 'can', 'unit', 'pkg'].includes(u), `${f}: unit ${u}`);
    // Rows with an expected price shape and unit lb, doz, can or unit.
    assert.ok(rows.filter((r) => r.cents !== null && ['lb', 'doz', 'can', 'unit'].includes(r.unit)).length >= 90, f);
    assert.ok(editable.length > 50, f);
    for (const r of rows.filter((x) => x.cents === null)) assert.ok(rowProblem(r, real.units), `${f}: ${r.key} must be refused`);
  }
});

test('real campaigns: changing every editable row touches only those prices, never another price, and the date line goes on top', { skip: undatedFile === undefined && 'no saved campaign without a date line in data/mailchimp' }, () => {
  const real = loadMailchimpConfig();
  const html = readFileSync(join(REAL_DIR, undatedFile!), 'utf8');
  const rows = parseRows(html);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.key.toLowerCase(), (counts.get(r.key.toLowerCase()) ?? 0) + 1);
  const editable = rows.filter((r) => rowProblem(r, real.units) === null && counts.get(r.key.toLowerCase()) === 1);
  const edits = editable.map((r) => ({ key: r.key, toCents: r.cents! + 100 }));
  const out = editEmail(html, edits, { units: real.units, dateLine: real.dateLine, dateText: 'Monday, November 16, 2026' });
  assert.equal(out.changes.length, edits.length);
  assert.equal(out.refused.length, 0);
  assert.equal(out.dateLineProblem, '');
  // Every dollar amount outside the edited rows is the same, in the same order.
  const others = (h: string): string[] => {
    const inRows = new Set(parseRows(h).filter((r) => editable.some((e) => e.key === r.key)).map((r) => r.priceStart));
    return [...h.matchAll(/\$\d+(\.\d{2})?/g)].filter((m) => ![...inRows].some((s) => m.index! === s)).map((m) => m[0]);
  };
  assert.deepEqual(others(out.html), others(html));
  assert.ok(others(html).includes('$8.99'), 'the turkey price is outside every row');
  // Undo the prices and the date line: the rest is byte for byte the original.
  let back = out.html.replace(/<tr><td class="sr-fish-date"[^>]*>[^<]*<\/td><\/tr>/, '');
  const undo = parseRows(back).filter((r) => editable.some((e) => e.key === r.key));
  for (const r of undo.sort((a, b) => b.priceStart - a.priceStart)) {
    const orig = editable.find((e) => e.key === r.key)!;
    back = back.slice(0, r.priceStart) + orig.priceText + back.slice(r.priceEnd);
  }
  assert.equal(back, html);
  // The date line sits right after the opening of the top table, before the header row.
  const at = out.html.indexOf('sr-fish-date');
  assert.ok(at > 0 && at < out.html.indexOf('The Fish List', out.html.indexOf('<body')));
});

test('real campaigns: the paused old campaign has another layout, so ShelfReady refuses the date line there', { skip: !realFiles.length && 'no saved campaigns' }, () => {
  const real = loadMailchimpConfig();
  const paused = realCampaigns.find((c) => c.status === 'paused');
  if (!paused || !existsSync(join(REAL_DIR, `content-${paused.id}.html`))) return;
  const html = readFileSync(join(REAL_DIR, `content-${paused.id}.html`), 'utf8');
  const r = editEmail(html, [], { units: real.units, dateLine: real.dateLine, dateText: 'Monday, November 16, 2026' });
  assert.equal(r.html, html);
  assert.ok(r.dateLineProblem);
});

// The shapes that make a backtracking pattern slow (unclosed tags, long names, long attribute
// runs) must each take under 1000 ms at the 1 MB limit. They take up to about 200 ms here; backtracking would
// take seconds or more, and the store PC is often busy, so the bound is loose on purpose.
// Floods of well-formed tags are real work (over 100,000 tags), linear, and get their own bound.
test('hostile HTML is read in linear time, and over 1 MB is refused', () => {
  const fill = (unit: string): string => unit.repeat(Math.floor(990_000 / unit.length));
  const hostile = [
    fill('<b '),
    fill('<b style="float:right">'),
    fill('<td class="sr-fish-date '),
    fill('<table class="wrap '),
    `<${'a'.repeat(980_000)}`,
    `<b ${'x'.repeat(980_000)}`,
    fill('&aaaaaaaaaaa'),
    fill('<span style="font:24px">'),
  ];
  const calls: Array<[string, (h: string) => unknown]> = [
    ['parseRows', (h) => parseRows(h)],
    ['editEmail', (h) => editEmail(h, [{ key: 'x', toCents: 100 }], opts('Monday, November 16, 2026'))],
    ['verifyEmail', (h) => verifyEmail(h, { dateText: 'Monday, November 16, 2026', prices: [{ key: 'x', toText: '$1.00' }], dateLineClass: cfg.dateLine.class })],
  ];
  for (const h of hostile) {
    for (const [name, call] of calls) {
      const t0 = performance.now();
      call(h);
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${name} on ${h.slice(0, 30)}... took ${Math.round(ms)} ms`);
    }
  }
  // 1 MB of well-formed rows and sections, 14,000 of each, about 100,000 tags: real work, about
  // 150 ms here, and over a second when the PC is busy, so the bound is 3000 ms. Before the lookups
  // were made linear this took over a second on an idle PC.
  for (const dense of [fill('<span style="font:24px">S</span><b>$1.00<small>/lb</small></b><b>N</b>'), fill('<b>$1<small>/lb</small></b> ')]) {
    for (const [name, call] of calls) {
      const t0 = performance.now();
      call(dense);
      const ms = performance.now() - t0;
      assert.ok(ms < 3000, `${name} on dense tags took ${Math.round(ms)} ms`);
    }
  }
  const big = fill('<b ').repeat(3);
  const t0 = performance.now();
  assert.deepEqual(parseRows(big), []);
  const e = editEmail(big, [{ key: 'x', toCents: 100 }], opts('Monday, November 16, 2026'));
  assert.equal(e.html, big);
  assert.match(e.dateLineProblem, /over 1 MB/);
  assert.match(e.refused[0]!.why, /over 1 MB/);
  assert.ok(performance.now() - t0 < 1000);
});
