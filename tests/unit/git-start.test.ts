// Rule: Keep Library History is safe to run again. A second run leaves the same files
// and the same single commit, lines the writer already had in .gitignore are kept,
// and it refuses a library that sits inside another repository.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ATTRIBUTES, IGNORED, keepHistory } from '../../src/hoard/git/start.ts';
import { isolateGitConfig, log, tempLibrary } from './git-support.ts';

const librarian = { name: 'Librarian', email: 'librarian@neo-hoard.invalid' };
const read = (library: string, name: string) => readFileSync(path.join(library, name), 'utf8');

test('the first run makes the repository, its ignore and attribute files, and one commit', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git, write } = tempLibrary(t);
  write('book-fox-1/snapshots/20261015T101010Z-k-1-2-ab/snapshot.json', '{}');
  write('neo-errors.log', 'an error\n');
  const result = await keepHistory(git, library, { librarian });
  assert.equal(result.started, true);
  assert.equal(read(library, '.gitignore'), IGNORED.join('\n') + '\n');
  assert.equal(read(library, '.gitattributes'), ATTRIBUTES + '\n');
  assert.deepEqual(await log(git, library, '%(trailers:key=Neo-Checkpoint,valueonly)'), ['start']);
  const { stdout } = await git.run(library, ['ls-files']);
  assert.deepEqual(stdout.split('\n').filter(Boolean).sort(), [
    '.gitattributes', '.gitignore', 'book-fox-1/book.json', 'book-fox-1/chapters/c1.html', 'library.json',
  ]);
});

test('a second run changes nothing', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  await keepHistory(git, library, { librarian });
  const before = [read(library, '.gitignore'), read(library, '.gitattributes')];
  const again = await keepHistory(git, library, { librarian });
  assert.equal(again.started, false);
  assert.equal(again.committed, null);
  assert.deepEqual([read(library, '.gitignore'), read(library, '.gitattributes')], before);
  assert.equal((await log(git, library, '%H')).length, 1);
});

test('the writer\'s own ignore lines are kept and only missing ones are added', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  writeFileSync(path.join(library, '.gitignore'), 'drafts/\r\n*.bak');
  await keepHistory(git, library, { librarian });
  const lines = read(library, '.gitignore').split(/\r?\n/);
  assert.equal(lines[0], 'drafts/');
  assert.equal(lines.filter((l) => l === '*.bak').length, 1);
  for (const line of IGNORED) assert.ok(lines.includes(line), line);
});

test('a library inside another repository is refused and left alone', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  const parent = path.dirname(library);
  await git.run(parent, ['init', '-q']);
  await assert.rejects(keepHistory(git, library, { librarian }), /inside another repository/);
  assert.throws(() => read(library, '.gitignore'), /ENOENT/);
});

// Rule: every page file, in either tree and at any depth, takes the chapter diff and merge
// driver, in a new library and in one whose attributes file predates pages.
const OLD_LINE = 'book-*/chapters/*.html diff=neochapter merge=neochapter -text';
const PAGE_FILES = ['wiki/Harbour.html', 'wiki/People/Harbour.html', 'sources/Notes/Deep/Log.html', 'book-fox-1/chapters/c1.html'];

async function attrsOf(git: ReturnType<typeof tempLibrary>['git'], library: string, file: string) {
  const { stdout } = await git.run(library, ['check-attr', 'diff', 'merge', 'text', '--', file]);
  return stdout.trim().split('\n').map((l) => l.slice(l.indexOf(': ') + 2));
}

test('every page file takes the chapter driver, in a new library', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  await keepHistory(git, library, { librarian });
  for (const file of PAGE_FILES) assert.deepEqual(await attrsOf(git, library, file), ['diff: neochapter', 'merge: neochapter', 'text: unset'], file);
  assert.deepEqual(await attrsOf(git, library, 'wiki/Harbour.md'), ['diff: unspecified', 'merge: unspecified', 'text: unspecified']);
});

test('a library started before pages gets the page lines added once, with its own lines kept', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  writeFileSync(path.join(library, '.gitattributes'), `*.png binary\n${OLD_LINE}\n`);
  await keepHistory(git, library, { librarian });
  await keepHistory(git, library, { librarian });
  const lines = read(library, '.gitattributes').split('\n').filter(Boolean);
  assert.deepEqual(lines.slice(0, 2), ['*.png binary', OLD_LINE]);
  assert.equal(lines.length, 4);
  assert.deepEqual(await attrsOf(git, library, 'sources/Log.html'), ['diff: neochapter', 'merge: neochapter', 'text: unset']);
});
