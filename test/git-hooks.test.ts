// The git hooks' store data checks (scripts/git-hooks): commit-msg refuses a message holding a
// private term or a store network value, and pre-commit refuses those network values in every
// staged file, docs included. Each runs in a throwaway repo with its own HOME, so the real
// private lists are never read. The private lists here hold invented values only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../scripts/git-hooks/', import.meta.url));
const TERM = 'zebrafjord'; // An invented term for the throwaway terms file.
// An invented private network list, as ~/.config/shelfready/store-net.txt would hold the store's.
const NET_LIST = '# invented values\n  shelfready.example.com \r\nstorepc\n\n198.51.100.\n';
// What the hooks refuse: the 192.168/16 prefix (built here, so the hooks never see it in this file)
// and the values in the list, in any case.
const R192 = ['192', '168'].join('.');
const NET = [`${R192}.7.9`, '198.51.100.9', 'ShelfReady.Example.COM', 'STOREPC', 'storepc-2'];
const FINE = ['192.0.2.10', '198.51.10.7', '10.0.0.20', '100.64.0.20', 'app.example.org', 'store pc', 'Bart Basi'];

/** No GIT_* from a hook this test may itself run under, a home of its own, and no system git config. */
function env(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) out[k] = v;
  return { ...out, HOME: home, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

function home(t: { after: (fn: () => void) => void }, terms: string | null = `# a comment\n  ${TERM}  \r\n\n`, net: string | null = NET_LIST): string {
  const dir = mkdtempSync(join(tmpdir(), 'shelfready-hooks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.config', 'shelfready'), { recursive: true });
  if (terms !== null) writeFileSync(join(dir, '.config', 'shelfready', 'store-terms.txt'), terms, { mode: 0o600 });
  if (net !== null) writeFileSync(join(dir, '.config', 'shelfready', 'store-net.txt'), net, { mode: 0o600 });
  return dir;
}

function commitMsg(h: string, message: string): { code: number | null; err: string } {
  const file = join(h, 'COMMIT_EDITMSG');
  writeFileSync(file, message);
  const r = spawnSync('sh', [join(HOOKS, 'commit-msg'), file], { env: env(h), encoding: 'utf8' });
  return { code: r.status, err: r.stderr };
}

test('commit-msg: a private term or a store network value in the message is refused, and never printed', (t) => {
  const h = home(t);
  assert.equal(commitMsg(h, 'Purchase history: a tab per vendor\n\nPlain words only.\n').code, 0);
  for (const fine of FINE) assert.equal(commitMsg(h, `Examples use ${fine}\n`).code, 0, fine);
  const term = commitMsg(h, `Fix the ${TERM.toUpperCase()} line\n`);
  assert.equal(term.code, 1);
  assert.match(term.err, /store-terms\.txt/);
  assert.ok(!term.err.toLowerCase().includes(TERM));
  for (const v of NET) {
    const r = commitMsg(h, `Subject\n\nThe server is at ${v} now.\n`);
    assert.equal(r.code, 1, v);
    assert.match(r.err, /store network address/);
    assert.ok(!r.err.includes(v), 'the value is not printed');
  }
  // A comment line counts: git keeps it with -m or -F.
  assert.equal(commitMsg(h, `Subject\n# ${NET[0]}\n`).code, 1);
  // The diff that commit -v puts under the scissors line is not part of the message.
  const scissors = `# ${'-'.repeat(24)} >8 ${'-'.repeat(24)}`;
  assert.equal(commitMsg(h, `Subject\n${scissors}\n# Do not modify or remove the line above.\n+${TERM} ${NET[0]}\n`).code, 0);
});

test('commit-msg: no terms file still checks the network values; an unreadable one is refused', (t) => {
  const none = home(t, null);
  assert.equal(commitMsg(none, `Fix the ${TERM} line\n`).code, 0);
  assert.equal(commitMsg(none, `Moved to ${NET[2]}\n`).code, 1);
  assert.doesNotMatch(commitMsg(none, 'Subject\n').err, /note/);
  if (process.getuid?.() === 0) return; // root reads any file.
  const locked = home(t);
  chmodSync(join(locked, '.config', 'shelfready', 'store-terms.txt'), 0o000);
  const r = commitMsg(locked, 'Subject\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot be read/);
});

test('commit-msg: with no private network list, a one-line note, and only the 192.168/16 prefix is checked; an unreadable list is refused', (t) => {
  const none = home(t, undefined, null);
  const plain = commitMsg(none, `Moved to ${NET[3]}\n`);
  assert.equal(plain.code, 0);
  assert.match(plain.err, /^commit-msg: note: no .*store-net\.txt, so only the 192\.168\/16 prefix is checked for store network values\.\n$/);
  assert.equal(commitMsg(none, `Moved to ${NET[0]}\n`).code, 1);
  if (process.getuid?.() === 0) return; // root reads any file.
  const locked = home(t);
  chmodSync(join(locked, '.config', 'shelfready', 'store-net.txt'), 0o000);
  const r = commitMsg(locked, 'Subject\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /store-net\.txt exists but cannot be read/);
  // A directory or a dangling link in its place refuses too, never falls back quietly.
  for (const kind of ['dir', 'link'] as const) {
    const odd = home(t);
    const path = join(odd, '.config', 'shelfready', 'store-net.txt');
    rmSync(path);
    if (kind === 'dir') mkdirSync(path);
    else symlinkSync(join(odd, 'nowhere.txt'), path);
    const o = commitMsg(odd, 'Subject\n');
    assert.equal(o.code, 1, kind);
    assert.match(o.err, /store-net\.txt exists but cannot be read/, kind);
  }
});

test('pre-commit: store network values are refused in staged code, docs and file names', (t) => {
  const h = home(t);
  const repo = join(h, 'repo');
  mkdirSync(repo);
  // A stand-in npm, so step 4 (typecheck and tests on the staged copy) passes at once.
  const bin = join(h, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const e = env(h, { PATH: `${bin}:${process.env.PATH ?? ''}` });
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, env: e, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git('init', '-q');
  const preCommit = () => spawnSync('sh', [join(HOOKS, 'pre-commit')], { cwd: repo, env: e, encoding: 'utf8' });
  const stage = (path: string, text: string) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
    git('add', '--', path);
  };
  const unstage = () => git('rm', '-rq', '--cached', '.');

  stage('src/ok.ts', "export const EXAMPLE = 'http://10.0.0.20:8765/mcp'; // app.example.org\n");
  assert.equal(preCommit().status, 0);
  unstage();

  for (const v of NET) {
    stage('src/net.ts', `export const URL = '${v}';\n`);
    const r = preCommit();
    assert.equal(r.status, 1, v);
    assert.match(r.stderr, /store network address/);
    assert.match(r.stderr, /Use invented values \(10\.0\.0\.x, shelfready\.example\.com\)/);
    assert.ok(!r.stderr.includes(v), 'the value is not printed');
    unstage();
  }

  for (const doc of ['docs/INSTALL.md', 'README.md', 'CLAUDE.md', 'ClaudeCodePrompt_ShelfReady.md']) {
    stage(doc, `The PC is at ${NET[0]}.\n`);
    const r = preCommit();
    assert.equal(r.status, 1, doc);
    assert.match(r.stderr, /store network address/);
    assert.ok(!r.stderr.includes(NET[0]), 'the value is not printed');
    unstage();
  }

  stage(`notes/${NET[4]}.txt`, 'plain\n');
  const named = preCommit();
  assert.equal(named.status, 1);
  assert.match(named.stderr, /file name holds a store network address/);
  unstage();

  // The private terms: in staged text, in code and docs alike.
  stage('docs/notes.md', `About ${TERM}.\n`);
  const term = preCommit();
  assert.equal(term.status, 1);
  assert.match(term.stderr, /store-terms\.txt/);
  assert.ok(!term.stderr.includes(TERM));
});
