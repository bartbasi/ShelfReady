// Checks the hand-made ground truth in test-invoices/expected/ with the same code checks a model
// reading gets: every line's math, the sum against the printed total, the pages. Run it after
// editing a ground truth file.
//
// Usage: node scripts/invoice/validate-expected.ts

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateExpected, type ExpectedInvoice } from '../../src/invoice/expected.ts';
import { formatCents } from '../../src/invoice/money.ts';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const dir = join(repo, 'test-invoices/expected');

export async function loadExpected(): Promise<ExpectedInvoice[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  return Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), 'utf8')) as ExpectedInvoice));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let bad = 0;
  for (const e of await loadExpected()) {
    const missing = e.images.filter((f) => !existsSync(join(repo, 'test-invoices', f)));
    const { problems, reading } = validateExpected(e, new Date());
    if (missing.length) problems.push(`missing images: ${missing.join(', ')}`);
    const sum = `lines ${formatCents(reading.linesTotalCents ?? 0)} + charges ${formatCents(reading.chargesTotalCents ?? 0)} = total ${formatCents(reading.totalCents ?? 0)}`;
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${e.name.padEnd(22)} ${String(e.lines.length).padStart(2)} lines, ${sum}${e.uncertain.length ? `, ${e.uncertain.length} uncertain` : ''}`);
    for (const p of problems) console.log(`     ${p}`);
    if (problems.length) bad++;
  }
  process.exitCode = bad ? 1 : 0;
}
