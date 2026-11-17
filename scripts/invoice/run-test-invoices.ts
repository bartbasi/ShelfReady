// Runs the real test invoices through the real Claude API and scores each reading against the
// hand-made ground truth in test-invoices/expected/. Costs real money: every run prints its cost
// and the running total kept in the ledger file.
//
// The key is read by name from ~/.config/shelfready/dev.env and never printed. Nothing here
// logs request headers. Automated tests never run this. Invoice file names, the bad cases and
// every output live under test-invoices/, which git ignores.
//
// Usage:
//   node scripts/invoice/run-test-invoices.ts [options]
//     --only a,b        only these invoices (names from test-invoices/expected/)
//     --model ID        measure one model alone, with no fallback
//     --effort LEVEL    effort for every model in this run (low, medium, high, xhigh, max)
//     --bad NAME        a deliberately bad upload from test-invoices/bad-cases.json, or "all"
//     --estimate        count tokens only, send nothing to a model
//     --out DIR         save each result as JSON in DIR (must be ignored by git or outside the repo)
//     --ledger FILE     running cost total (default test-invoices/.ledger.json)
//     --budget USD      refuse to start if the ledger total is already over this (default 10)

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { compareReading, type Scorecard } from '../../src/invoice/compare.ts';
import { formatUsd } from '../../src/invoice/cost.ts';
import { createAnthropicModelClient } from '../../src/invoice/extract.ts';
import type { ExpectedInvoice } from '../../src/invoice/expected.ts';
import { prepareInput, readInvoice, type InvoiceFile, type ReadResult } from '../../src/invoice/pipeline.ts';
import { buildUserContent, SYSTEM_PROMPT } from '../../src/invoice/prompt.ts';
import { INVOICE_SCHEMA } from '../../src/invoice/schema.ts';
import { buildInvoiceSettings, effortFor, type Effort } from '../../src/invoice/settings.ts';
import { devAnthropicClient } from './dev-env.ts';
import { safeOutputPath } from './paths.ts';
import { loadExpected } from './validate-expected.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const invoicesDir = join(repo, 'test-invoices');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

const only = arg('--only')?.split(',');
const model = arg('--model');
const effort = arg('--effort') as Effort | undefined;
const badName = arg('--bad');
const outDir = arg('--out') ? safeOutputPath(arg('--out')!, repo) : undefined;
const ledgerFile = safeOutputPath(arg('--ledger') ?? join(invoicesDir, '.ledger.json'), repo);
const budget = Number(arg('--budget') ?? '10');
const estimateOnly = flag('--estimate');

interface Ledger {
  totalUsd: number;
  runs: Array<{ at: string; label: string; usd: number }>;
}

interface BadCase {
  name: string;
  why: string;
  files: string[];
  blur?: { file: string; left: number; top: number; width: number; height: number };
}

async function readLedger(): Promise<Ledger> {
  if (!existsSync(ledgerFile)) return { totalUsd: 0, runs: [] };
  return JSON.parse(await readFile(ledgerFile, 'utf8')) as Ledger;
}

async function addToLedger(label: string, usd: number): Promise<number> {
  const l = await readLedger();
  l.totalUsd += usd;
  l.runs.push({ at: new Date().toISOString(), label, usd });
  await writeFile(ledgerFile, JSON.stringify(l, null, 2));
  return l.totalUsd;
}

const baseSettings = buildInvoiceSettings();
const settings = effort
  ? buildInvoiceSettings({ effort: Object.fromEntries(Object.keys(baseSettings.prices).map((m) => [m, effort])) })
  : baseSettings;

async function filesFor(names: string[]): Promise<InvoiceFile[]> {
  return Promise.all(names.map(async (n) => ({ name: n, bytes: await readFile(join(invoicesDir, n)) })));
}

/** The files of one bad case. A blurred case gets an edited copy, saved under test-invoices/. */
async function badCaseFiles(c: BadCase): Promise<InvoiceFile[]> {
  const files = await filesFor(c.files);
  if (!c.blur) return files;
  const b = c.blur;
  const upright = await sharp(join(invoicesDir, b.file)).autoOrient().toBuffer();
  const region = { left: b.left, top: b.top, width: b.width, height: b.height };
  const patch = await sharp(upright).extract(region).blur(25).toBuffer();
  const edited = await sharp(upright).composite([{ input: patch, left: region.left, top: region.top }]).jpeg({ quality: 92 }).toBuffer();
  const dir = safeOutputPath(join(invoicesDir, '.bad-cases'), repo);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${c.name}.jpg`), edited);
  return files.map((f) => (f.name === b.file ? { name: `${c.name}.jpg`, bytes: edited } : f));
}

function short(m: string): string {
  return m.replace(/^claude-/, '');
}

function attemptsSummary(r: ReadResult): string {
  return r.attempts
    .map((a) => {
      const failed = a.reading ? a.reading.failed.length : null;
      const how = a.outcome === 'checked' ? (failed === 0 ? 'pass' : `${failed} failed`) : a.outcome;
      return `${short(a.model)} ${a.effort} ${how} ${formatUsd(a.costUsd)}${a.costIsEstimate ? ' (booked worst case)' : ''} ${Math.round(a.durationMs / 1000)}s out ${a.usage?.outputTokens ?? 0}/${a.estimate.maxOutputTokens}`;
    })
    .join(' -> ');
}

function printScore(name: string, r: ReadResult, sc: Scorecard | null) {
  const checks = r.reading ? `${r.reading.checks.filter((c) => c.passed).length}/${r.reading.checks.length} checks` : 'no reading';
  const cost = r.attempts.reduce((s, a) => s + a.costUsd, 0);
  const lines = sc ? `lines ${sc.linesMatched}/${sc.linesExpected} (read ${sc.linesFound})` : '';
  const wrong = sc ? `wrong ${sc.wrong.length}/${sc.fieldsCompared}` : '';
  console.log(`${name.padEnd(22)} ${r.status.padEnd(14)} ${lines.padEnd(22)} ${wrong.padEnd(13)} ${checks.padEnd(12)} ${formatUsd(cost)}`);
  console.log(`  ${attemptsSummary(r)}`);
  if (sc) {
    for (const w of sc.wrong.slice(0, 12)) console.log(`  wrong: ${w.where}: ${w.field} expected "${w.expected}" got "${w.got}"`);
    if (sc.wrong.length > 12) console.log(`  ... and ${sc.wrong.length - 12} more`);
    for (const m of sc.missingLines) console.log(`  missing: ${m}`);
    for (const x of sc.extraLines) console.log(`  extra: ${x}`);
  }
  if (r.status !== 'ok') for (const reason of r.reviewReasons.slice(0, 14)) console.log(`  review: ${reason}`);
  if (r.reading) for (const n of r.reading.notices.filter((x) => /not received|another photo|Marked|Check how much/.test(x.message))) console.log(`  notice: ${n.message}`);
}

async function main() {
  const ledger = await readLedger();
  if (!estimateOnly && ledger.totalUsd > budget) {
    console.log(`The ledger shows ${formatUsd(ledger.totalUsd)} spent, over the budget of ${formatUsd(budget)}. Not starting.`);
    process.exitCode = 1;
    return;
  }
  const client = createAnthropicModelClient(devAnthropicClient());
  type Job = { name: string; files: InvoiceFile[]; expected: ExpectedInvoice | null };
  const jobs: Job[] = [];
  if (badName) {
    const all = (JSON.parse(await readFile(join(invoicesDir, 'bad-cases.json'), 'utf8')) as { cases: BadCase[] }).cases;
    const chosen = badName === 'all' ? all : all.filter((c) => c.name === badName);
    if (!chosen.length) throw new Error(`No bad case named ${badName}. Known: ${all.map((c) => c.name).join(', ')}`);
    for (const c of chosen) jobs.push({ name: `bad-${c.name}`, files: await badCaseFiles(c), expected: null });
  } else {
    for (const e of await loadExpected()) if (!only || only.includes(e.name)) jobs.push({ name: e.name, files: await filesFor(e.images), expected: e });
  }
  const modelsLabel = model ? `${model} alone` : `${settings.firstPassModel} then ${settings.fallbackModel}`;
  const effortLabel = model ? effortFor(settings, model) : `${effortFor(settings, settings.firstPassModel)} / ${effortFor(settings, settings.fallbackModel)}`;
  console.log(`Models: ${modelsLabel}. Effort: ${effortLabel}. Ledger so far: ${formatUsd(ledger.totalUsd)}.`);

  if (estimateOnly) {
    for (const job of jobs) {
      const input = await prepareInput(job.files, settings);
      for (const m of model ? [model] : [settings.firstPassModel, settings.fallbackModel]) {
        const req = { model: m, effort: effortFor(settings, m), maxTokens: settings.maxOutputTokens, system: SYSTEM_PROMPT, content: buildUserContent(input.content), schema: INVOICE_SCHEMA };
        const tokens = await client.countTokens(req);
        console.log(`${job.name.padEnd(22)} ${short(m).padEnd(12)} ${input.pages} images sent, ${tokens} input tokens${input.notices.length ? ` (${input.notices.map((n) => n.message).join(' ')})` : ''}`);
      }
    }
    return;
  }

  let runTotal = 0;
  for (const job of jobs) {
    const r = await readInvoice(job.files, { client, settings }, model ? { onlyModel: model } : {});
    const cost = r.attempts.reduce((s, a) => s + a.costUsd, 0);
    runTotal += cost;
    const total = await addToLedger(`${job.name} ${model ?? 'pipeline'} ${effort ?? ''}`.trim(), cost);
    const sc = job.expected && r.reading ? compareReading(job.expected, r.reading) : null;
    printScore(job.name, r, sc);
    console.log(`  running total ${formatUsd(total)}`);
    if (outDir) {
      await mkdir(outDir, { recursive: true });
      const save = { name: job.name, status: r.status, reviewReasons: r.reviewReasons, notices: r.notices, audit: r.audit, attempts: r.attempts, scorecard: sc };
      await writeFile(join(outDir, `${job.name}${model ? `-${short(model)}` : ''}${effort ? `-${effort}` : ''}.json`), JSON.stringify(save, null, 2));
    }
  }
  console.log(`This run: ${formatUsd(runTotal)}.`);
}

await main();
