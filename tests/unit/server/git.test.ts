// Rule: a file's version is the blob id of its raw bytes, whatever the repository's
// attributes or autocrlf say, and hashing a file stores the blob in the object store.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createRepoGit } from '../../../server/git.ts';
import { tempHoard } from './hoard.ts';

const rawId = (repo: string, bytes: string) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: repo, input: bytes }).toString().trim();

test('hashBytes stores the raw bytes and ignores .gitattributes eol conversion', async (t) => {
  const { repo } = tempHoard(t);
  writeFileSync(path.join(repo, '.gitattributes'), '* text=auto eol=crlf\n');
  execFileSync('git', ['config', 'core.autocrlf', 'true'], { cwd: repo });
  const git = createRepoGit(repo);
  const id = await git.hashBytes(Buffer.from('one\ntwo\n'));
  assert.equal(id, rawId(repo, 'one\ntwo\n'));
  const stored = execFileSync('git', ['cat-file', 'blob', id], { cwd: repo });
  assert.equal(stored.toString(), 'one\ntwo\n');
});

test('hashPaths gives one id per path, in order, of the raw bytes', async (t) => {
  const { repo } = tempHoard(t);
  // Filters apply to a path inside the repo, so CRLF bytes would be converted without --no-filters.
  writeFileSync(path.join(repo, '.gitattributes'), '* text=auto eol=crlf\n');
  mkdirSync(path.join(repo, 'library'));
  const files = ['library/a.html', 'library/b.html'];
  files.forEach((f, i) => writeFileSync(path.join(repo, f), `<p>${i}\r\n</p>`));
  const git = createRepoGit(repo);
  const ids = await git.hashPaths(files.map((f) => path.join(repo, f)));
  assert.deepEqual(ids, [rawId(repo, '<p>0\r\n</p>'), rawId(repo, '<p>1\r\n</p>')]);
  assert.deepEqual(await git.hashPaths([]), []);
});

test('head is null before the first commit and the commit id after it', async (t) => {
  const { repo } = tempHoard(t);
  const git = createRepoGit(repo);
  assert.equal(await git.head(), null);
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'first'], { cwd: repo });
  assert.equal(await git.head(), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim());
});

test('a git failure keeps its exit code and stderr', async (t) => {
  const { root } = tempHoard(t);
  const git = createRepoGit(path.join(root, 'not-a-repo'));
  await assert.rejects(git.hashBytes(Buffer.from('x')), (e: Error & { kind?: string }) => e.name === 'GitError' && e.kind !== undefined);
});
