// Rule: no commit is made, and no client reads the library, while a rebase in the clone
// holds conflict markers. One left by a crash is aborted before the tree opens; one that
// cannot be aborted stops the start; one begun while the server runs holds every commit
// until it ends.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempHoard, type Hoard } from './hoard.ts';
import { commits, git, NEW, openWithHistory } from './history-support.ts';

const file = (h: Hoard) => path.join(h.repo, 'library', 'wiki', 'shared.html');
const rebasing = (h: Hoard) => ['rebase-merge', 'rebase-apply'].some((d) => existsSync(path.join(h.repo, '.git', d)));

/** Two branches that edit one line, ready for `rebase side` to conflict; the clone is left on `main`. */
function diverged(h: Hoard): void {
  mkdirSync(path.dirname(file(h)), { recursive: true });
  writeFileSync(file(h), 'base\n');
  git(h.repo, 'checkout', '-q', '-b', 'main');
  git(h.repo, 'add', '-A');
  git(h.repo, 'commit', '-q', '-m', 'base');
  git(h.repo, 'checkout', '-q', '-b', 'side');
  writeFileSync(file(h), 'side edit\n');
  git(h.repo, 'commit', '-q', '-am', 'side');
  git(h.repo, 'checkout', '-q', 'main');
  writeFileSync(file(h), 'main edit\n');
  git(h.repo, 'commit', '-q', '-am', 'main');
}

/** Starts the rebase and leaves it stopped on its conflict, markers on disk. */
function conflictedRebase(h: Hoard): void {
  assert.throws(() => execFileSync('git', ['rebase', 'side'], { cwd: h.repo, stdio: 'pipe' }), 'the rebase must stop on a conflict');
  assert.ok(rebasing(h));
  assert.match(readFileSync(file(h), 'utf8'), /^<<<<<<< /m, 'the baseline holds conflict markers');
}

test('a conflicted rebase left by a crash is aborted when the server opens, before the tree reads the library', async (t) => {
  const h = tempHoard(t);
  diverged(h);
  conflictedRebase(h);
  const lib = await openWithHistory(t, h);
  assert.equal(rebasing(h), false);
  assert.equal(readFileSync(file(h), 'utf8'), 'main edit\n');
  assert.equal((await lib.tree.read('wiki/shared.html')).bytes.toString(), 'main edit\n', 'the tree serves no markers');
  assert.equal(git(h.repo, 'symbolic-ref', '--short', 'HEAD').trim(), 'main');
  assert.ok(lib.lines.some((l) => l.level === 'warn' && l.msg.startsWith('history.rebase_aborted')));
  assert.equal(commits(h.repo).some((c) => c.checkpoint === 'recovered'), false, 'nothing was left to recover');
});

test('a rebase in progress that cannot be aborted stops the start with an error that says so', async (t) => {
  const h = tempHoard(t);
  diverged(h);
  conflictedRebase(h);
  // A lock left by the same crash makes the abort fail.
  writeFileSync(path.join(h.repo, '.git', 'index.lock'), '');
  await assert.rejects(openWithHistory(t, h), /rebase/i);
  rmSync(path.join(h.repo, '.git', 'index.lock'));
});

test('a rebase begun while the server runs holds every commit, logged, and the commit is retried once it ends', async (t) => {
  const h = tempHoard(t);
  diverged(h);
  const lib = await openWithHistory(t, h);
  await lib.tree.put('wiki/new.html', Buffer.from('new'), { ...NEW, device: 'tablet' });
  conflictedRebase(h);
  await lib.time.advance(60_000);
  await lib.history.drained();
  assert.equal(git(h.repo, 'log', '--all', '--format=%(trailers:key=Neo-Checkpoint,valueonly)').trim(), '', 'no commit while the rebase holds markers');
  assert.ok(lib.lines.some((l) => /rebase/.test(String(l.message ?? l.msg)) && (l.level === 'warn' || l.level === 'error')));

  git(h.repo, 'rebase', '--abort');
  await lib.time.advance(60_000);
  await lib.history.drained();
  const [made] = commits(h.repo);
  assert.equal(made?.checkpoint, 'idle');
  assert.deepEqual(made.files, ['library/wiki/new.html']);
  assert.deepEqual(made.devices, ['tablet']);
});
