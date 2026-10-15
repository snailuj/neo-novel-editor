// Rule: the layer commits only in a library that is the top of its own repository.
// Every other state (no repository, a repository in a folder above, no git at all) is
// told apart, so none of them is mistaken for the library's own history.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { repoState, syncedFolder } from '../../src/hoard/git/repo.ts';
import { createGit } from '../../src/hoard/git/runner.ts';

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hoard-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a library with no repository is untracked', async (t) => {
  const dir = tempDir(t);
  const git = createGit({ hooksPath: dir });
  assert.deepEqual(await repoState(git, dir), { state: 'untracked' });
});

test('a library that is the top of its own repository is tracked', async (t) => {
  const dir = tempDir(t);
  const git = createGit({ hooksPath: dir });
  await git.run(dir, ['init', '-q']);
  assert.equal((await repoState(git, dir)).state, 'tracked');
});

test('a library inside a repository that starts above it is not tracked', async (t) => {
  const dir = tempDir(t);
  const git = createGit({ hooksPath: dir });
  await git.run(dir, ['init', '-q']);
  const library = path.join(dir, 'NEO Library');
  mkdirSync(library);
  const state = await repoState(git, library);
  assert.equal(state.state, 'inside-another-repo');
  assert.ok(state.state === 'inside-another-repo' && path.resolve(state.top) === path.resolve(dir));
});

test('no git at all is its own state', async (t) => {
  const dir = tempDir(t);
  const git = createGit({ git: path.join(dir, 'no-such-git'), hooksPath: dir });
  assert.equal((await repoState(git, dir)).state, 'no-git');
});

test('a library Syncthing or iCloud Drive syncs is noticed', (t) => {
  const dir = tempDir(t);
  assert.equal(syncedFolder(dir), null);
  writeFileSync(path.join(dir, '.stfolder'), '');
  assert.equal(syncedFolder(dir), 'Syncthing');
  assert.equal(syncedFolder('/Users/a/Library/Mobile Documents/com~apple~CloudDocs/NEO Library'), 'iCloud Drive');
  assert.equal(syncedFolder('C:\\Users\\a\\iCloudDrive\\NEO Library'), 'iCloud Drive');
});
