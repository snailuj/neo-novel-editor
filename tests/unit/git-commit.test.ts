// Rule: every commit names who applied it. The author's commits carry the identity
// from git config, the librarian's the one in the plugin settings; with no identity
// there is no commit, never a guessed one; an unchanged library makes no commit.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll } from '../../src/hoard/git/commit.ts';
import { GitError } from '../../src/hoard/git/runner.ts';
import { isolateGitConfig, log, tempLibrary } from './git-support.ts';

const librarian = { name: 'Librarian', email: 'librarian@neo-hoard.invalid' };

test('an author commit carries the identity from git config and names its reason', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  await git.run(library, ['init', '-q']);
  const made = await commitAll(git, library, { who: 'author', reason: 'idle', librarian });
  assert.ok(made);
  assert.equal(made.files, 3);
  assert.deepEqual(await log(git, library, '%an <%ae>|%cn'), ['Ada Author <ada@example.com>|Ada Author']);
  assert.deepEqual(await log(git, library, '%(trailers:key=Neo-Checkpoint,valueonly)'), ['idle']);
});

test('a librarian commit carries the librarian identity, not the author\'s', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git, write } = tempLibrary(t);
  await git.run(library, ['init', '-q']);
  await commitAll(git, library, { who: 'author', reason: 'idle', librarian });
  write('book-fox-1/chapters/c1.html', '<p>One.</p><p>Two, amended.</p>');
  await commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian });
  assert.deepEqual(await log(git, library, '%an <%ae>|%cn <%ce>'), [
    'Librarian <librarian@neo-hoard.invalid>|Librarian <librarian@neo-hoard.invalid>',
    'Ada Author <ada@example.com>|Ada Author <ada@example.com>',
  ]);
});

test('an author identity in the settings wins over git config', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  await git.run(library, ['init', '-q']);
  await commitAll(git, library, {
    who: 'author', reason: 'idle', librarian, author: { name: 'Pen Name', email: 'pen@example.com' },
  });
  assert.deepEqual(await log(git, library, '%an <%ae>'), ['Pen Name <pen@example.com>']);
});

test('with no identity anywhere the commit fails and nothing is guessed', async (t) => {
  isolateGitConfig(t, null);
  // Without user.useConfigOnly, git would take EMAIL and the login name as an identity.
  const savedEmail = process.env.EMAIL;
  process.env.EMAIL = 'guess@machine';
  t.after(() => {
    if (savedEmail === undefined) delete process.env.EMAIL;
    else process.env.EMAIL = savedEmail;
  });
  const { library, git } = tempLibrary(t);
  await git.run(library, ['init', '-q']);
  const err = await commitAll(git, library, { who: 'author', reason: 'idle', librarian }).then(
    () => assert.fail('resolved'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof GitError);
  assert.equal(err.kind, 'exit');
  const head = await git.run(library, ['rev-parse', '--verify', '-q', 'HEAD']).catch((e: GitError) => e);
  assert.ok(head instanceof GitError, 'no commit was made');
});

test('an unchanged library makes no commit', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git } = tempLibrary(t);
  await git.run(library, ['init', '-q']);
  assert.ok(await commitAll(git, library, { who: 'author', reason: 'idle', librarian }));
  assert.equal(await commitAll(git, library, { who: 'author', reason: 'idle', librarian }), null);
  assert.equal((await log(git, library, '%H')).length, 1);
});

test('a book that holds a repository of its own is left out and reported', async (t) => {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const { library, git, write } = tempLibrary(t);
  await git.run(library, ['init', '-q']);
  write('book-owl-2/book.json', '{"id":"book-owl-2","chapterOrder":[]}');
  mkdirSync(path.join(library, 'book-owl-2', 'chapters'));
  await git.run(path.join(library, 'book-owl-2'), ['init', '-q']);
  const made = await commitAll(git, library, { who: 'author', reason: 'idle', librarian });
  assert.ok(made);
  assert.deepEqual(made.leftOut, ['book-owl-2']);
  const { stdout } = await git.run(library, ['ls-files']);
  assert.ok(!stdout.includes('book-owl-2'), stdout);
  assert.ok(stdout.includes('book-fox-1/chapters/c1.html'));
});
