// Development only: one invoice run end to end, from upload to dry run, against the saved copy of
// the live catalog. It writes nothing to Square or the scales and contacts neither.
//
//   nice -n 19 node scripts/runs/dry-run-local.ts --invoice NAME [--labels] [--case N=UNITS,...]
//     [--unit-weight N=LB,...] [--arrived N=none,...] [--tick-big] [--write-copy] [--check-cards] [--catalog FILE]
//     [--cards FILE | --no-cards] [--real-model [--stand-in-copy]] [--card-sheet [--sheet-out DIR]] [--keep]
//
// NAME is a ground truth file in test-invoices/expected/ (without .json). Its photos are uploaded
// through the real upload route. The reading comes from a stand-in model that answers with that
// ground truth, or with --real-model from the Claude API, using ANTHROPIC_API_KEY from
// ~/.config/shelfready/dev.env (this costs money; the usual cost cap applies).
//
// Card copy: the existing cards (data/cards/imported.json, or --cards FILE) are imported into the
// temporary database first and linked against the same catalog, unless --no-cards. Products with
// no card get stand-in copy from a local fake that says so on the card, or with --real-model real
// copy from the Claude API with web search (this costs money too, under the card copy budget per
// invoice, $5 by default). --stand-in-copy keeps the fake copy with a real reading.
// --write-copy asks for copy for every card with none (the Write copy button), and --check-cards
// marks each written card checked, as a person would after reading it.
//
// Everything lives in a fresh temporary folder (database, master key, uploads), deleted at the
// end unless --keep is given. Store data stays on this PC: the catalog, the invoices and what
// this prints. No line is matched by guessing: lines that need a person are listed, not picked.
// With --labels, the hand-made labels in test-invoices/matching-labels.json are posted as the
// person's picks (a match, not for resale, or left out for a new item), through the same routes.
// --case and --unit-weight give a line's case size or unit weight, as typed in review. --tick-big
// ticks every price move over 30%, as a person would after looking at each one.
// --card-sheet approves the dry run (nothing is sent: this script never sends), makes the card
// sheet through the real route and runs its check with LibreOffice (nice 19, one at a time), then
// copies the .docx to --sheet-out DIR (default data/cards/render/, which git ignores).

import { randomBytes } from 'node:crypto';
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SYSTEM_ACTOR } from '../../src/db/audit.ts';
import { createUser } from '../../src/auth/users.ts';
import { expectedAsModelInvoice, type ExpectedInvoice } from '../../src/invoice/expected.ts';
import { createAnthropicModelClient, type InvoiceModelClient } from '../../src/invoice/extract.ts';
import { existsSync } from 'node:fs';
import type { ImportedCard } from '../../src/cards/import.ts';
import { createAnthropicCopyClient, type CopyModelClient } from '../../src/copy/client.ts';
import { importCards } from '../../src/copy/import.ts';
import { buildCatalogIndex } from '../../src/matching/catalog.ts';
import { createCardCopyStage } from '../../src/runs/card-copy.ts';
import { fileCatalogSource } from '../../src/square/catalog-source.ts';
import { buildApp } from '../../src/server/app.ts';
import { makeConfig } from '../../src/server/config.ts';
import { devAnthropicClient } from '../invoice/dev-env.ts';

process.umask(0o077);
const repo = fileURLToPath(new URL('../..', import.meta.url));
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const name = arg('--invoice');
if (!name || !/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('Pass --invoice NAME, a file in test-invoices/expected/ without .json.');
const expected = JSON.parse(readFileSync(join(repo, 'test-invoices/expected', `${name}.json`), 'utf8')) as ExpectedInvoice;
const catalog = arg('--catalog') ?? join(repo, 'data/square/live-catalog.json');

function standIn(e: ExpectedInvoice): InvoiceModelClient {
  const text = JSON.stringify(expectedAsModelInvoice(e));
  return {
    countTokens: async () => 5000,
    call: async (req) => ({
      stop: 'end_turn',
      stopReason: 'end_turn',
      refusalCategory: null,
      text,
      usage: { inputTokens: 5000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
      requestId: 'local',
      model: req.model,
    }),
  };
}

/** Stand-in copy: a card that says on its face it was not written by a model. No network. */
function standInCopy(): CopyModelClient {
  const card = {
    origin: 'PRODUCT OF NOWHERE',
    category: 'PANTRY',
    new_category: '',
    n1: 'Stand-in ',
    n2: 'Copy',
    producer: 'Local Dry Run · Nowhere',
    spec1: { label: 'STAND', value: 'In' },
    spec2: { label: 'FOR', value: 'Testing' },
    spec3: { label: 'NOT', value: 'Real' },
    paragraph1: 'Stand-in copy written by the local dry run, not by a model.',
    paragraph2: 'Replace it before anything is printed.',
    unit: '1 EACH',
  };
  const answer = {
    product_identified: true,
    card,
    unique_selling_point: '',
    origin_check: { country: '', confirmed: false, source_urls: [], note: '' },
    designation_check: { designation: '', confirmed: false, source_urls: [], note: '' },
    claims: [],
    verify: [{ kind: 'other', text: 'This is stand-in copy from the local dry run.' }],
    sources: [],
  };
  return {
    countTokens: async () => 4000,
    call: async (req) => ({
      stop: 'end_turn',
      stopReason: 'end_turn',
      refusalCategory: null,
      text: JSON.stringify(answer),
      paused: null,
      searches: [],
      usage: { inputTokens: 4000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0 },
      webSearchRequests: 0,
      serverReadings: null,
      requestId: 'local',
      model: req.model,
    }),
  };
}

const dir = mkdtempSync(join(tmpdir(), 'shelfready-dry-run-'));
const config = makeConfig({
  dbPath: join(dir, 'data', 'shelfready.sqlite3'),
  masterKeyPath: join(dir, 'keys', 'master.key'),
  devCatalogFile: catalog,
  scaleNames: ['FRONT', 'KITCHEN', 'COUNTER'],
  logLevel: 'silent',
  // The real invoice is dated in the past; the date check is a note, not a stop.
});
const real = process.argv.includes('--real-model');
const model = real ? createAnthropicModelClient(devAnthropicClient()) : standIn(expected);
const copyClient = real && !process.argv.includes('--stand-in-copy') ? createAnthropicCopyClient(devAnthropicClient()) : standInCopy();
const app = await buildApp(config, { modelClient: model, startRunner: false, cardCopy: createCardCopyStage({ client: () => copyClient }) });
try {
  // The existing cards, linked against the same catalog the run reads.
  const cardsFile = arg('--cards') ?? join(repo, 'data/cards/imported.json');
  if (!process.argv.includes('--no-cards') && existsSync(cardsFile)) {
    const data = await fileCatalogSource(catalog).load();
    const r = importCards(app.shelf.db, SYSTEM_ACTOR, { index: buildCatalogIndex({ objects: data.objects, locationId: data.locationId }), source: data.source }, JSON.parse(readFileSync(cardsFile, 'utf8')) as { cards: ImportedCard[] });
    console.log(`Cards imported: ${r.created}. Linked by code ${r.linkedByCode}, by name ${r.linkedByName}; ${r.toConfirm.length} for a person to confirm.`);
  } else {
    console.log('No cards imported.');
  }
  const password = randomBytes(18).toString('base64url');
  await createUser(app.shelf.db, { username: 'local', role: 'manager', password, mustChangePassword: false }, { scrypt: config.scrypt, minLength: 12, actor: SYSTEM_ACTOR });
  const origin = config.publicOrigins[0]!;
  const loginPage = await app.inject({ method: 'GET', url: '/login' });
  const loginCookie = loginPage.cookies.find((c) => c.name === 'sr_login')!.value;
  const loginCsrf = /name="_csrf" value="([^"]+)"/.exec(loginPage.body)![1]!;
  const signedIn = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { origin, cookie: `sr_login=${loginCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ _csrf: loginCsrf, username: 'local', password }).toString(),
  });
  const cookie = `sr_session=${signedIn.cookies.find((c) => c.name === 'sr_session')!.value}`;
  const csrf = /name="_csrf" value="([^"]+)"/.exec((await app.inject({ method: 'GET', url: '/', headers: { cookie } })).body)![1]!;
  const post = (url: string, fields: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ _csrf: csrf, ...fields }).toString() });

  // Upload the invoice photos through the real route.
  const boundary = '----shelfreadylocal';
  const chunks: Buffer[] = [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrf}\r\n`)];
  for (const img of expected.images) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${img}"\r\nContent-Type: image/jpeg\r\n\r\n`));
    chunks.push(readFileSync(join(repo, 'test-invoices', img)));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const up = await app.inject({ method: 'POST', url: '/runs', headers: { cookie, origin, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat(chunks) });
  if (up.statusCode !== 303) throw new Error(`Upload refused (HTTP ${up.statusCode}).`);
  const runId = Number(String(up.headers.location).split('/').pop());
  await app.shelf.runner.drain();

  const state = () => (app.shelf.db.prepare('SELECT state, message FROM runs WHERE id = ?').get(runId) as { state: string; message: string });
  console.log(`Run ${runId}: ${state().state}. ${state().message}`);
  if (state().state === 'review') {
    // A new supplier is added, as a person would on first sight. Nothing else is decided here.
    const ev = JSON.parse((app.shelf.db.prepare('SELECT evaluation FROM runs WHERE id = ?').get(runId) as { evaluation: string }).evaluation);
    if (ev.blockers.some((b: { id: string }) => b.id === 'supplier_unknown')) await post(`/runs/${runId}/supplier`, { create: '1' });
  }
  if (process.argv.includes('--labels') && ['review', 'ready'].includes(state().state)) {
    // The hand-made labels stand in for the person's picks (test-invoices/matching-labels.json).
    const labels = JSON.parse(readFileSync(join(repo, 'test-invoices/matching-labels.json'), 'utf8')) as { invoices: Record<string, Array<{ line: number; label: string; variationId?: string }>> };
    for (const l of labels.invoices[name] ?? []) {
      if (l.label === 'match' && l.variationId) await post(`/runs/${runId}/lines/${l.line}/pick`, { variationId: l.variationId });
      else if (l.label === 'not_for_resale') await post(`/runs/${runId}/lines/${l.line}/not-for-resale`, { confirm: '1' });
      else await post(`/runs/${runId}/lines/${l.line}/skip`, { skip: '1' });
    }
  }
  // Case sizes and unit weights a person would type: --case 13=12,14=12 --unit-weight 1=0.5
  for (const [flag, field] of [['--case', 'unitsPerCase'], ['--unit-weight', 'poundsPerUnit']] as const) {
    for (const pair of (arg(flag) ?? '').split(',').filter(Boolean)) {
      const [line, value] = pair.split('=');
      const res = await post(`/runs/${runId}/lines/${line}/pack`, { [field]: value ?? '' });
      if (res.statusCode !== 303) console.log(`Line ${line}: ${flag} refused (HTTP ${res.statusCode}).`);
    }
  }
  // What arrived, as a person would confirm it: --arrived 23=none,4=pieces:6,9=pounds:3.5
  for (const pair of (arg('--arrived') ?? '').split(',').filter(Boolean)) {
    const [line, what = ''] = pair.split('=');
    const [kind, amount = ''] = what.split(':');
    const fields: Record<string, string> = kind === 'pieces' ? { arrived: 'some', pieces: amount } : kind === 'pounds' ? { arrived: 'some', pounds: amount } : { arrived: kind ?? '' };
    const res = await post(`/runs/${runId}/lines/${line}/arrived`, fields);
    if (res.statusCode !== 303) console.log(`Line ${line}: --arrived refused (HTTP ${res.statusCode}).`);
  }
  // --tick-big: tick every price that moves more than 30%, as a person would after looking.
  if (process.argv.includes('--tick-big')) {
    const page = (await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: { cookie } })).body;
    for (const m of page.matchAll(/action="\/runs\/\d+\/big-change"[^>]*>[\s\S]*?name="variationId" value="([^"]+)"[\s\S]*?name="fromCents" value="(\d+)"[\s\S]*?name="toCents" value="(\d+)"/g)) {
      await post(`/runs/${runId}/big-change`, { variationId: m[1]!, fromCents: m[2]!, toCents: m[3]! });
    }
  }
  // --write-copy: ask for copy for every card with none, as a person would with the button.
  if (process.argv.includes('--write-copy')) {
    const res = await post(`/runs/${runId}/cards/write`, { all: '1' });
    if (res.statusCode !== 303) console.log(`Write copy refused (HTTP ${res.statusCode}).`);
    await app.shelf.runner.drain();
  }
  // --check-cards: mark each written card checked, as a person would after reading it.
  if (process.argv.includes('--check-cards')) {
    const page = (await app.inject({ method: 'GET', url: `/runs/${runId}`, headers: { cookie } })).body;
    for (const m of page.matchAll(/action="\/runs\/\d+\/cards\/check"[^>]*>[\s\S]*?name="variationId" value="([^"]+)"[\s\S]*?name="cardId" value="(\d+)"[\s\S]*?name="version" value="(\d+)"/g)) {
      await post(`/runs/${runId}/cards/check`, { variationId: m[1]!, cardId: m[2]!, version: m[3]!, confirm: '1' });
    }
  }
  const copyRows = app.shelf.db
    .prepare("SELECT c.state, count(*) AS n, coalesce(sum((SELECT sum(usd) FROM model_spend m WHERE m.run_id = c.run_id AND m.kind = 'copy' AND m.variation_id = c.variation_id)), 0) AS usd FROM run_copy c WHERE c.run_id = ? GROUP BY c.state")
    .all(runId) as Array<{ state: string; n: number; usd: number }>;
  if (copyRows.length) console.log(`\nCard copy: ${copyRows.map((r) => `${r.n} ${r.state} ($${Number(r.usd).toFixed(4)})`).join(', ')}.`);
  const ev = JSON.parse((app.shelf.db.prepare('SELECT evaluation FROM runs WHERE id = ?').get(runId) as { evaluation: string }).evaluation);
  console.log(`\nLines: ${ev.lines.length}`);
  for (const l of ev.lines) console.log(`  ${String(l.n).padStart(2)} ${l.outcome}${l.status ? ` (${l.status}${l.newCents !== null ? ` ${(l.newCents / 100).toFixed(2)}` : ''})` : ''}`);
  console.log(`\nTo settle (${ev.blockers.length}):`);
  for (const b of ev.blockers) console.log(`  ${b.message}`);
  if (state().state === 'ready') {
    await post(`/runs/${runId}/dry-run`);
    await app.shelf.runner.drain();
    const p = JSON.parse((app.shelf.db.prepare('SELECT dry_run FROM runs WHERE id = ?').get(runId) as { dry_run: string }).dry_run);
    console.log(`\nDRY RUN (nothing written): ${p.square.length} Square items, ${p.scales.changes.length} scale prices, ${p.cards.cards.length} cards.`);
    for (const s of p.square) console.log(`  ${s.label}: ${JSON.stringify({ price: s.price, switch: s.switchToWeight ? 'yes' : undefined, stock: s.stock, tracking: s.tracking.turnOn || undefined })}`);
    for (const c of p.cards.cards) console.log(`  card: ${c.record.n1}${c.record.n2} | ${c.record.price} ${c.record.unit}${c.record.code ? ` | ${c.record.code}` : ''} | ${c.source}`);
    for (const c of p.cards.leftOut) console.log(`  no card: ${c.title}: ${c.why}`);
    if (process.argv.includes('--card-sheet')) {
      const hash = (app.shelf.db.prepare('SELECT dry_run_hash FROM runs WHERE id = ?').get(runId) as { dry_run_hash: string }).dry_run_hash;
      const ok = await post(`/runs/${runId}/approve`, { hash });
      if (ok.statusCode !== 303) throw new Error(`Approval refused (HTTP ${ok.statusCode}).`);
      const made = await post(`/runs/${runId}/card-sheet`);
      if (made.statusCode !== 303) throw new Error(`Card sheet refused (HTTP ${made.statusCode}): ${/<p class="error"[^>]*>([^<]*)/.exec(made.body)?.[1] ?? ''}`);
      console.log('\nCARD SHEET: checking with LibreOffice (nice 19).');
      await app.shelf.sheetChecker.drain();
      const sheet = app.shelf.db.prepare("SELECT file_name, stored_name, slots, cards, check_state, check_message, check_result FROM card_sheets WHERE run_id = ? AND kind = 'run'").get(runId) as { file_name: string; stored_name: string; slots: number; cards: string; check_state: string; check_message: string; check_result: string };
      const result = JSON.parse(sheet.check_result) as { pages: number; expectedPages: number; failures: Array<{ page: number; slot: number; name: string; problems: string[] }> } | null;
      console.log(`  ${JSON.parse(sheet.cards).length} cards in ${sheet.slots} slots. Check: ${sheet.check_state}. ${sheet.check_message}`);
      if (result) console.log(`  pages: ${result.pages} of ${result.expectedPages} expected`);
      for (const f of result?.failures ?? []) console.log(`  page ${f.page} card ${f.slot} ${f.name}: ${f.problems.join(' ')}`);
      const outDir = arg('--sheet-out') ?? join(repo, 'data/cards/render');
      mkdirSync(outDir, { recursive: true, mode: 0o700 });
      const out = join(outDir, sheet.file_name);
      copyFileSync(join(dir, 'data', 'card-sheets', sheet.stored_name), out);
      chmodSync(out, 0o600);
      console.log(`  file: ${out}`);
    }
  } else {
    console.log('\nNo dry run: something needs a person. Start the server with this catalog file to settle it in the browser.');
  }
} finally {
  await app.close();
  if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true });
  else console.log(`\nKept: ${dir}`);
}
