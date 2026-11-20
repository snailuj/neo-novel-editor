// Rule: when the library is a folder of a larger repository, git sees only that folder.
// Every commit holds paths under it and nothing else, every name that reaches the gate or
// a caller is relative to the library, and nothing is written into the repository's root.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitAll } from '../../../../server/history/commit.ts';
import { GitLayer, resolveSettings } from '../../../../server/history/layer.ts';
import { libraryNames, type LibraryRepo } from '../../../../server/history/pathspec.ts';
import { createGit } from '../../../../server/history/runner.ts';
import { ATTRIBUTES, attributeLines, keepHistory } from '../../../../server/history/start.ts';
import { isolateGitConfig, tempDir } from './git-support.ts';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const librarian = { name: 'Librarian', email: 'librarian@neo-hoard.invalid' };
const chapter = 'book-fox-1/chapters/c1.html';
type T = { after(fn: () => void): void };

/** A repo with the library one folder down and a file of someone else's beside it. */
function subfolder(t: T, name = 'library') {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const top = realpathSync(tempDir(t, 'neo-sub-'));
  const hooks = mkdtempSync(path.join(tempDir(t), 'hooks-'));
  const git = createGit({ hooksPath: hooks });
  execFileSync('git', ['init', '-q', top]);
  const repo: LibraryRepo = { top, prefix: `${name}/`, library: path.join(top, name), ignore: ['.neo-tmp-*'] };
  const write = (rel: string, text: string, base = repo.library) => {
    const file = path.join(base, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  const run = (...args: string[]) => execFileSync('git', args, { cwd: top, encoding: 'utf8' });
  write(chapter, '<p>One.</p><p>Two.</p>');
  write('library.json', '{"shelves":[]}');
  return { repo, git, write, run, top };
}

test('a commit of a library inside a larger repo holds only paths under the library, whatever else is modified or staged', async (t) => {
  const { repo, git, write, run, top } = subfolder(t);
  write('notes.txt', 'tracked', top);
  run('add', 'notes.txt');
  run('commit', '-q', '-m', 'someone else\'s file');
  write('notes.txt', 'modified, not staged', top);
  write('staged.txt', 'staged, never committed', top);
  run('add', 'staged.txt');
  write('untracked.txt', 'not added', top);

  const made = await commitAll(git, repo, { who: 'author', reason: 'idle', librarian });
  assert.ok(made);
  assert.equal(made.files, 2);
  assert.deepEqual(run('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['library/book-fox-1/chapters/c1.html', 'library/library.json']);
  assert.deepEqual(run('status', '--porcelain').split('\n').filter(Boolean).sort(), [' M notes.txt', '?? untracked.txt', 'A  staged.txt']);
  assert.equal(readFileSync(path.join(top, 'notes.txt'), 'utf8'), 'modified, not staged');
});

test('a commit with a list of paths in a subfolder library takes those paths and no others', async (t) => {
  const { repo, git, write, run } = subfolder(t);
  await commitAll(git, repo, { who: 'author', reason: 'idle', librarian });
  write(chapter, '<p>One, edited.</p>');
  write('library.json', '{"shelves":["a"]}');
  const made = await commitAll(git, repo, { who: 'author', reason: 'idle', librarian, paths: [chapter] });
  assert.equal(made?.files, 1);
  assert.deepEqual(run('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean), ['library/' + chapter]);
  assert.match(run('status', '--porcelain'), / M library\/library\.json/);
});

test('the gate sees library-relative names, and a path it holds is left out of the commit', async (t) => {
  const { repo, git, write, run } = subfolder(t);
  write('wiki/held.html', '<p>Held.</p>');
  const judged: string[][] = [];
  const gate = { held: () => ['wiki/held.html'], judge: (names: readonly string[]) => { judged.push([...names]); } };
  await commitAll(git, repo, { who: 'author', reason: 'idle', librarian, gate });
  assert.deepEqual(judged.map((names) => [...names].sort()), [[chapter, 'library.json']]);
  assert.match(run('status', '--porcelain'), /\?\? library\/wiki\//);
});

test('a name git reports outside the library is dropped and logged, never passed on', () => {
  const repo: LibraryRepo = { top: '/r', prefix: 'library/', library: '/r/library' };
  const logged: unknown[] = [];
  const names = libraryNames(repo, ['library/a.html', 'other/b.html', 'library/wiki/c.html', 'librarian/d.html'], (level, message, data) => logged.push([level, message, data]));
  assert.deepEqual(names, ['a.html', 'wiki/c.html']);
  assert.equal(logged.length, 1);
  assert.deepEqual((logged[0] as [string, string, { names: string[] }])[2].names, ['other/b.html', 'librarian/d.html']);
  assert.deepEqual(libraryNames({ top: '/l', prefix: '', library: '/l' }, ['a.html']), ['a.html']);
});

test('files the library ignores are never committed from a subfolder, and no ignore file is written outside it', async (t) => {
  const { repo, git, write, run, top } = subfolder(t);
  for (const rel of ['scratch.tmp', 'deep/er/scratch.bak', '.DS_Store', '.neo-tmp-abc', 'wiki/.neo-tmp-xyz', 'book-fox-1/snapshots/s1.html', 'Backups/b.html', 'Exports/e.html', 'neo-errors.log', '_catalog.txt']) write(rel, 'litter');
  const made = await commitAll(git, repo, { who: 'author', reason: 'idle', librarian });
  assert.equal(made?.files, 2);
  assert.deepEqual(run('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), ['library/' + chapter, 'library/library.json']);
  assert.equal(existsSync(path.join(top, '.gitignore')), false);
  assert.equal(existsSync(path.join(top, '.gitattributes')), false);
});

test('a book with a repository of its own is kept out of a subfolder library\'s commits', async (t) => {
  const { repo, git, write, run } = subfolder(t);
  write('book-own-1/book.json', '{}');
  mkdirSync(path.join(repo.library, 'book-own-1', '.git'));
  const made = await commitAll(git, repo, { who: 'author', reason: 'idle', librarian });
  assert.deepEqual(made?.leftOut, ['book-own-1']);
  assert.equal(run('show', '--name-only', '--format=', 'HEAD').includes('book-own-1'), false);
});

test('keep history refuses a library that is a folder of a larger repo, and writes nothing at the repo root', async (t) => {
  const { repo, git, top } = subfolder(t);
  await assert.rejects(keepHistory(git, repo, { librarian }), /folder of a larger repository/);
  assert.equal(existsSync(path.join(top, '.gitignore')), false);
  assert.equal(existsSync(path.join(top, '.gitattributes')), false);
  assert.equal(existsSync(path.join(repo.library, '.gitignore')), false);
});

test('head, show, changed and blame take and give names relative to the library when it is a subfolder', async (t) => {
  const { repo, git, write, run } = subfolder(t);
  const attributesFile = path.join(tempDir(t), 'attributes');
  writeFileSync(attributesFile, `${attributeLines(repo.prefix).join('\n')}\n`);
  const layer = new GitLayer({
    git, library: repo, settings: resolveSettings({}, () => {}), attributesFile,
    textconv: { command: `"${process.execPath}" "${path.join(root, 'tools', 'git', 'neo-textconv.js')}"` },
    log: () => {},
  });
  t.after(async () => { layer.stop(); await layer.drained(); });
  assert.equal((await layer.open()).state, 'tracked');
  await layer.drained();
  const start = await layer.head();
  assert.ok(start);
  write(chapter, '<p>One.</p><p>Two, edited.</p>');
  write('wiki/People/a.html', '<p>A.</p>');
  run('add', '-A', '--', 'library');
  run('-c', 'user.name=Librarian', '-c', 'user.email=librarian@neo-hoard.invalid', 'commit', '-q', '-m', 'edit');
  const end = await layer.head();
  assert.ok(end && end !== start);

  assert.equal(await layer.show(end, chapter), '<p>One.</p><p>Two, edited.</p>');
  assert.equal(await layer.show(start, 'wiki/People/a.html'), null);
  assert.deepEqual(await layer.changed(start, end, 'wiki/'), [{ rel: 'wiki/People/a.html', byAuthor: false }]);
  assert.deepEqual((await layer.changed(start, end, '')).map((c) => c.rel).sort(), [chapter, 'wiki/People/a.html']);

  const lines = await layer.blame({ bookId: 'book-fox-1', chId: 'c1' });
  assert.deepEqual(lines.map((l) => [l.html, l.who]), [['<p>One.</p>', 'author'], ['<p>Two, edited.</p>', 'librarian']]);

  // Lines without the prefix match nothing from the top, so the chapter would be one line: the baseline the prefix changes.
  writeFileSync(attributesFile, `${ATTRIBUTES}\n`);
  assert.equal((await layer.blame({ bookId: 'book-fox-1', chId: 'c1' })).length, 1);
});

test('the attribute lines carry the library prefix so a global attributes file matches root-relative names', () => {
  assert.deepEqual(attributeLines('library/'), [
    'library/book-*/chapters/*.html diff=neochapter merge=neochapter -text',
    'library/wiki/**/*.html diff=neochapter merge=neochapter -text',
    'library/sources/**/*.html diff=neochapter merge=neochapter -text',
  ]);
  assert.equal(attributeLines('')[0], 'book-*/chapters/*.html diff=neochapter merge=neochapter -text');
});
