// Where the invoice scripts may write: outside the repository, or at a path git ignores.
// Only the parts that need no git run here, so the test passes anywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isOutsideRepo, safeOutputPath } from '../scripts/invoice/paths.ts';

const repo = '/work/shop/repo';

test('a folder named "..results" inside the repository is inside', () => {
  assert.equal(isOutsideRepo(join(repo, '..results'), repo), false);
  assert.equal(isOutsideRepo(join(repo, '..results', 'run.json'), repo), false);
  assert.equal(isOutsideRepo(join(repo, '...'), repo), false);
});

test('paths at or above the repository are outside; paths in it are inside', () => {
  assert.equal(isOutsideRepo('/work/shop', repo), true);
  assert.equal(isOutsideRepo('/work/shop/other', repo), true);
  assert.equal(isOutsideRepo(join(repo, '..', 'sibling'), repo), true);
  assert.equal(isOutsideRepo('/tmp/results', repo), true);
  assert.equal(isOutsideRepo(repo, repo), false);
  assert.equal(isOutsideRepo(join(repo, 'test-invoices', 'out'), repo), false);
});

test('outside paths are allowed as they are; inside paths that git does not ignore are refused', () => {
  assert.equal(safeOutputPath('/tmp/results', repo), '/tmp/results');
  // There is no git repository at this made-up path, so the check fails closed.
  assert.throws(() => safeOutputPath(join(repo, '..results'), repo), /Refusing to write to \.\.results/);
  assert.throws(() => safeOutputPath(repo, repo), /Refusing to write to the repository root/);
});
