// Old invoices are record only. This proves it from the source: nothing under src/history, and
// nothing those files load in turn, can reach Square, ScaleConnect, the cards, or the code that
// sends a run. The routes and pages for old invoices are held to the same rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths, from the repository root, that old invoices must never load. A trailing * is a prefix. */
const FORBIDDEN = [
  'src/square/*',
  'src/scaleconnect/*',
  'src/cards/*',
  'src/runs/send*',
  'src/runs/scale-push.ts',
  'src/runs/square-send.ts',
  'src/runs/card-*',
  // Not in the list Bart gave, but just as much part of a run: held out too.
  'src/runs/runner.ts',
  'src/runs/store.ts',
  'src/runs/actions.ts',
  'src/runs/preview.ts',
  'src/mailchimp/*',
  'src/copy/*',
  'src/matching/catalog.ts',
];

function forbidden(rel: string): string | null {
  for (const f of FORBIDDEN) {
    if (f.endsWith('*') ? rel.startsWith(f.slice(0, -1)) : rel === f) return f;
  }
  return null;
}

/** Every module a source file names: static imports, re-exports, type imports and import(). */
export function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [/\bimport\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bexport\s+(?:type\s+)?[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]!);
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Follows local imports from the start files. Returns each file reached and the file that first loaded it. */
function closure(starts: string[]): Map<string, string> {
  const seen = new Map<string, string>(starts.map((s) => [s, '(start)']));
  const queue = [...starts];
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue; // a package, not our code
      const target = resolve(dirname(file), spec);
      assert.ok(existsSync(target), `${relative(ROOT, file)} imports ${spec}, which does not exist`);
      if (!seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
    }
  }
  return seen;
}

test('the import scanner sees every way to load a module', () => {
  const src = `import a from './a.ts';\nimport type { B } from "../b.ts";\nimport { c,\n d } from './c.ts';\nexport { e } from './e.ts';\nimport './f.ts';\nconst g = await import('./g.ts');`;
  assert.deepEqual(specifiers(src).sort(), ['../b.ts', './a.ts', './c.ts', './e.ts', './f.ts', './g.ts']);
});

test('nothing under src/history, or anything it loads, reaches Square, the scales, the cards or sending a run', () => {
  const starts = sourceFiles(join(ROOT, 'src/history'));
  assert.ok(starts.length >= 5, 'the history module was found');
  const reached = closure(starts);
  const bad: string[] = [];
  for (const [file, from] of reached) {
    const rel = relative(ROOT, file);
    const rule = forbidden(rel);
    if (rule) bad.push(`${rel} (loaded by ${relative(ROOT, from)}, rule ${rule})`);
  }
  assert.deepEqual(bad, []);
  // The one piece of src/runs it uses is the file helpers.
  const runs = [...reached.keys()].map((f) => relative(ROOT, f)).filter((r) => r.startsWith('src/runs/'));
  assert.deepEqual(runs, ['src/runs/files.ts']);
});

test('the routes and pages for the purchase history, and all they load, reach nothing that sends', () => {
  const starts = ['src/server/history-routes.ts', 'src/server/views/history-pages.ts', 'src/server/upload-slots.ts'].map((r) => join(ROOT, r));
  const reached = closure(starts);
  const bad: string[] = [];
  for (const [file, from] of reached) {
    const rel = relative(ROOT, file);
    const rule = forbidden(rel);
    if (rule) bad.push(`${rel} (loaded by ${relative(ROOT, from)}, rule ${rule})`);
    if (rel === 'src/server/run-routes.ts' || rel === 'src/server/app.ts') bad.push(`${rel} (loaded by ${relative(ROOT, from)})`);
  }
  assert.deepEqual(bad, []);
  const runs = [...reached.keys()].map((f) => relative(ROOT, f)).filter((r) => r.startsWith('src/runs/'));
  assert.deepEqual(runs, ['src/runs/files.ts']);
});

test('the run code may call into the history; the history never calls back', () => {
  // The direction Bart chose: runs record their lines through src/history/runs.ts.
  const runner = readFileSync(join(ROOT, 'src/runs/runner.ts'), 'utf8');
  assert.ok(specifiers(runner).includes('../history/runs.ts'));
  for (const file of sourceFiles(join(ROOT, 'src/history'))) {
    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      const target = relative(ROOT, resolve(dirname(file), spec));
      assert.ok(!target.startsWith('src/runs/') || target === 'src/runs/files.ts', `${relative(ROOT, file)} imports ${target}`);
    }
  }
});
