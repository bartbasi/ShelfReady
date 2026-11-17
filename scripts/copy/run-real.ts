// The real check for card copy (Plan, Phase 1 step 5): for the products on the real test
// invoices, how many have stored copy, then new copy for a few that have none, so Bart can
// judge the voice.
//
// 1. Imports data/cards/imported.json into a database in memory, linked against the saved live
//    catalog (data/square/live-catalog.json).
// 2. Looks up every product the confirmed labels (test-invoices/matching-labels.json) match on
//    the expected readings (test-invoices/expected/*.json) and reports stored, to confirm, or none.
// 3. Writes copy for at most --max products that have none (default 5), picked to vary: a cheese,
//    a salami, a seafood item, a packaged item, then another packaged item. --pick "a,b" picks by
//    Square name instead. Real API calls, under --budget dollars in all (default 1.50). Each card
//    gets the rendered check (LibreOffice, nice 19) unless --no-render.
// 4. Prints each card with its verify list, sources and cost, and writes them all to
//    test-invoices/copy-samples.json, which git ignores.
//
// --dry stops before any API call and prints the picks and their estimates.
// The API key is read by name from ~/.config/shelfready/dev.env and never printed.
//
// Usage: node scripts/copy/run-real.ts [--dry] [--max N] [--budget USD] [--pick "name,name"] [--no-render]

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCardConfig } from '../../src/cards/config.ts';
import type { ImportedCard } from '../../src/cards/import.ts';
import { openDatabase } from '../../src/db/db.ts';
import { createAnthropicCopyClient } from '../../src/copy/client.ts';
import { copyConfigFrom } from '../../src/copy/config.ts';
import { estimateCopy, localPromptTokens } from '../../src/copy/cost.ts';
import { generateCopy, type CopyResult } from '../../src/copy/generate.ts';
import { importCards } from '../../src/copy/import.ts';
import { lookupCopy, type CopyLookup } from '../../src/copy/lookup.ts';
import { renderCheckFor } from '../../src/copy/render-check.ts';
import { copySettingsFrom } from '../../src/copy/settings.ts';
import type { CopyCatalog, InvoiceFacts } from '../../src/copy/types.ts';
import { buildCatalogIndex } from '../../src/matching/catalog.ts';
import { devAnthropicClient } from '../invoice/dev-env.ts';
import { safeOutputPath } from '../invoice/paths.ts';
import { loadExpected } from '../invoice/validate-expected.ts';
import type { LabelFile } from '../matching/run-real.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

interface Product {
  lookup: CopyLookup;
  invoice: InvoiceFacts;
}

/** The kinds of product to try, in order. Each takes the first product of its kind with no copy. */
const KINDS: Array<{ name: string; fits: (p: Product, chosen: Product[]) => boolean }> = [
  { name: 'a cheese', fits: (p) => p.lookup.product.categoryNames.some((c) => /cheese/i.test(c)) },
  { name: 'a salami', fits: (p) => /salam|sopress|soppress/i.test(`${p.invoice.description} ${p.lookup.product.baseName}`) },
  { name: 'a seafood item', fits: (p) => p.lookup.product.soldByWeight && p.lookup.product.categoryNames.some((c) => /seafood|fish/i.test(c)) },
  { name: 'a packaged item', fits: (p) => !p.lookup.product.soldByWeight },
  {
    name: 'another packaged item',
    fits: (p, chosen) => !p.lookup.product.soldByWeight && !chosen.some((c) => !c.lookup.product.soldByWeight && c.lookup.product.categoryNames.join() === p.lookup.product.categoryNames.join()),
  },
];

function printResult(r: CopyResult): void {
  const c = r.card;
  console.log(`\n=== ${r.product.label}: ${r.status}, $${r.costUsd.toFixed(4)}`);
  for (const why of r.reasons) console.log(`  reason: ${why}`);
  for (const n of r.notes) console.log(`  note: ${n}`);
  if (!c) return;
  const t = c.content;
  console.log(`  ${t.eyebrow} | ${t.origin} | unit ${t.unit}`);
  console.log(`  name: [${t.n1}][${t.n2}]  producer: ${t.producer}`);
  console.log(`  specs: ${t.specs.map(([l, v]) => `${l}: ${v}`).join(' | ')}`);
  t.copy.forEach((p, i) => console.log(`  p${i + 1} (${p.length}): ${p}`));
  console.log(`  copy characters: ${t.copy.join(' ').length}`);
  const rv = c.review!;
  if (rv.uniqueSellingPoint) console.log(`  selling point: ${rv.uniqueSellingPoint}`);
  console.log(`  searches: ${rv.searches.map((x) => `"${x.query}" (${x.error || `${x.results} results`})`).join('; ') || 'none'}`);
  for (const s of rv.sources) console.log(`  source: ${s.url} (${s.usedFor})`);
  for (const v of rv.verify) console.log(`  VERIFY [${v.kind}, ${v.from}]: ${v.text}`);
  for (const a of r.attempts) {
    console.log(`  call ${a.role}: ${a.stopReason ?? a.error?.kind}, in ${a.usage?.inputTokens ?? 0}, out ${a.usage?.outputTokens ?? 0} (thinking ${a.usage?.thinkingTokens ?? 0}), searches ${a.webSearchRequests}, server readings ${a.serverReadings ?? 'not reported'}, $${a.costUsd.toFixed(4)}, estimate up to $${a.estimate.worstUsd.toFixed(3)}, ${(a.durationMs / 1000).toFixed(1)} s`);
  }
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry');
  const max = Number(arg('--max') ?? 5);
  const budget = Number(arg('--budget') ?? 1.5);
  if (!Number.isInteger(max) || max < 0 || max > 5) throw new Error('--max must be 0 to 5.');
  if (!Number.isFinite(budget) || budget <= 0 || budget > 2) throw new Error('--budget must be above 0 and at most 2 dollars.');
  const catalogPath = join(repo, 'data/square/live-catalog.json');
  const labelsPath = join(repo, 'test-invoices/matching-labels.json');
  const cardsPath = join(repo, 'data/cards/imported.json');
  for (const p of [catalogPath, labelsPath, cardsPath]) if (!existsSync(p)) throw new Error(`Missing ${p}.`);
  const outPath = safeOutputPath(join(repo, 'test-invoices/copy-samples.json'), repo);

  const raw = JSON.parse(readFileSync(catalogPath, 'utf8')) as { objects: unknown[]; location?: { id?: string } };
  const index = buildCatalogIndex({ objects: raw.objects, locationId: raw.location?.id ?? '' });
  // The labels were made against the saved live catalog, so links here are in its id space.
  const catalog: CopyCatalog = { index, source: 'file' };
  const labels = JSON.parse(readFileSync(labelsPath, 'utf8')) as LabelFile;
  const cardFile = JSON.parse(readFileSync(cardsPath, 'utf8')) as { cards: ImportedCard[] };
  const cardConfig = loadCardConfig();
  const config = copyConfigFrom(cardConfig);
  const db = openDatabase(':memory:');
  const actor = { userId: null, username: 'run-real' };

  const imp = importCards(db, actor, catalog, cardFile);
  console.log(`Import: ${imp.created} cards, linked ${imp.linkedByCode} by code and ${imp.linkedByName} by name; not linked: ${imp.toConfirm.length} to confirm, ${imp.noCandidate.length} with nothing alike, ${imp.conflicts.length} in conflict.`);

  // Every product the labels match, once, with the first invoice line that shows it.
  const products = new Map<string, Product>();
  for (const e of await loadExpected()) {
    for (const l of labels.invoices[e.name] ?? []) {
      if (l.label !== 'match' || !l.variationId || products.has(l.variationId)) continue;
      const line = e.lines[l.line - 1];
      if (!line || !index.variationById.has(l.variationId)) continue;
      const invoice: InvoiceFacts = {
        supplier: e.supplier,
        description: [line.description, line.descriptionMore].filter(Boolean).join(' | '),
        brand: line.brand,
        packSize: line.packSize,
        unitsPerPack: line.unitsPerPack,
        origin: line.origin,
      };
      products.set(l.variationId, { lookup: lookupCopy(db, catalog, l.variationId), invoice });
    }
  }
  const all = [...products.values()];
  const stored = all.filter((p) => p.lookup.card);
  const confirm = all.filter((p) => p.lookup.next === 'confirm');
  const none = all.filter((p) => p.lookup.next === 'generate');
  console.log(`\nProducts on the 5 invoices: ${all.length}. Stored copy: ${stored.length} (by link ${stored.filter((p) => p.lookup.via === 'variation').length}, by code ${stored.filter((p) => p.lookup.via === 'scale_code').length}, by name ${stored.filter((p) => p.lookup.via === 'name').length}). A stored card to confirm: ${confirm.length}. No copy: ${none.length}.`);
  for (const p of all) {
    const what = p.lookup.card ? `stored (${p.lookup.card.source}, via ${p.lookup.via}): ${(p.lookup.card.content.n1 + p.lookup.card.content.n2).trim()}` : p.lookup.next === 'confirm' ? `confirm: ${p.lookup.suggestions.map((s) => (s.card.content.n1 + s.card.content.n2).trim()).join(' / ')}` : 'none';
    console.log(`  ${p.lookup.product.label.padEnd(48)} ${what}`);
  }

  // The picks.
  const picks: Array<{ kind: string; p: Product }> = [];
  const wanted = arg('--pick');
  if (wanted) {
    for (const w of wanted.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      const p = none.find((x) => x.lookup.product.label.toLowerCase().includes(w));
      if (!p) throw new Error(`No product with no copy matches "${w}".`);
      picks.push({ kind: 'picked', p });
    }
  } else {
    for (const k of KINDS) {
      if (picks.length >= max) break;
      const chosen = picks.map((x) => x.p);
      const p = none.find((x) => !chosen.includes(x) && k.fits(x, chosen));
      if (p) picks.push({ kind: k.name, p });
    }
  }
  const settings = copySettingsFrom({});
  console.log(`\nPicked ${picks.length}: ${picks.map((x) => `${x.p.lookup.product.label} (${x.kind})`).join('; ')}`);
  for (const x of picks) {
    const est = estimateCopy(settings, settings.model, localPromptTokens(9000, true), 'local', settings.maxSearches, settings.maxOutputTokens);
    console.log(`  ${x.p.lookup.product.label}: usually about $${est.usd.toFixed(2)}, at most about $${est.worstUsd.toFixed(2)}`);
  }
  if (dry || picks.length === 0) {
    console.log('\nDry run: no API call made.');
    return;
  }

  const client = createAnthropicCopyClient(devAnthropicClient());
  const renderCheck = process.argv.includes('--no-render') ? null : renderCheckFor(cardConfig, config.categories);
  const results: CopyResult[] = [];
  let spent = 0;
  for (const x of picks) {
    const r = await generateCopy({ db, client, settings, config, actor, renderCheck }, x.p.lookup.product, x.p.invoice, { budgetUsd: budget - spent });
    spent += r.costUsd;
    results.push(r);
    printResult(r);
  }
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        about: 'Card copy written by scripts/copy/run-real.ts for products on the real test invoices. Store data: never commit.',
        writtenAt: new Date().toISOString(),
        model: settings.model,
        effort: settings.effort,
        webSearchTool: settings.webSearchTool,
        spentUsd: spent,
        results: results.map((r) => ({ product: r.product.label, status: r.status, reasons: r.reasons, costUsd: r.costUsd, card: r.card?.content ?? null, review: r.card?.review ?? null, attempts: r.attempts })),
      },
      null,
      1,
    ),
    { mode: 0o600 },
  );
  console.log(`\nSpent $${spent.toFixed(4)} on ${results.length} products (limit $${budget.toFixed(2)}). Written to ${outPath}.`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : 'The real check failed.');
  process.exit(1);
}
