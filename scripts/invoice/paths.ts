// Where the invoice scripts may write. Their output holds store data, so it must land where git
// will never pick it up: outside the repository, or inside it at a path git ignores.

import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * True when a path is outside the repository. The relative path must be exactly ".." or start
 * with ".." and a separator: a folder inside the repository named "..results" is inside.
 */
export function isOutsideRepo(path: string, repo: string): boolean {
  const rel = relative(resolve(repo), resolve(path));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/** Resolves a path and refuses it unless git ignores it or it is outside the repository. */
export function safeOutputPath(path: string, repo: string): string {
  const full = resolve(path);
  if (isOutsideRepo(full, repo)) return full;
  const rel = relative(resolve(repo), full);
  try {
    // Exit status 0 means ignored. --no-index matches the ignore rules without reading the index.
    if (rel === '') throw new Error('the repository root itself');
    execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--no-index', rel], { stdio: 'ignore' });
    return full;
  } catch {
    throw new Error(`Refusing to write to ${rel || 'the repository root'}: git does not ignore it, and it would hold store data. Use a path under test-invoices/ or outside the repository.`);
  }
}
