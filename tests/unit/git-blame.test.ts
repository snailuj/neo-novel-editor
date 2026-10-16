// Rule: each paragraph is credited to whoever last changed it, from git blame, on a
// machine with no chapter driver set up; a paragraph the window shows but no commit
// holds is credited to no one rather than to the wrong person.
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { alignBlame } from '../../src/hoard/git/align.ts';
import { blameChapter, textconvCommand } from '../../src/hoard/git/blame.ts';
import { commitAll } from '../../src/hoard/git/commit.ts';
import { ATTRIBUTES } from '../../src/hoard/git/start.ts';
import { isolateGitConfig, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const librarian = { name: 'Librarian', email: 'librarian@neo-hoard.invalid' };
const chapter = path.join('book-fox-1', 'chapters', 'c1.html');

async function history(t: { after(fn: () => void): void }) {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  const attributesFile = path.join(tempDir(t), 'attributes');
  writeFileSync(attributesFile, `${ATTRIBUTES}\n`);
  await lib.git.run(lib.library, ['init', '-q']);
  lib.write(chapter, '<p>One.</p><p>Two.</p><p>Three.</p>');
  await commitAll(lib.git, lib.library, { who: 'author', reason: 'idle', librarian });
  lib.write(chapter, '<p>One.</p><p>Two, as the librarian has it.</p><p>Three.</p>');
  await commitAll(lib.git, lib.library, { who: 'librarian', reason: 'librarian-after', librarian });
  const options = {
    librarian,
    attributesFile,
    textconv: textconvCommand(process.execPath, path.join(root, 'tools', 'git', 'neo-textconv.js')),
  };
  return { ...lib, options };
}

test('blame credits each paragraph to its last hand, with no driver in any config', async (t) => {
  const { git, library, options } = await history(t);
  const lines = await blameChapter(git, library, { bookId: 'book-fox-1', chId: 'c1' }, options);
  assert.deepEqual(lines.map((l) => [l.html, l.who, l.author]), [
    ['<p>One.</p>', 'author', 'Ada Author'],
    ['<p>Two, as the librarian has it.</p>', 'librarian', 'Librarian'],
    ['<p>Three.</p>', 'author', 'Ada Author'],
  ]);
  assert.ok(lines.every((l) => /^[0-9a-f]{40}$/.test(l.commit) && l.time > 0));
});

test('a paragraph written since the last commit is uncommitted', async (t) => {
  const { git, library, options, write } = await history(t);
  write(chapter, '<p>One.</p><p>Two, as the librarian has it.</p><p>Three.</p><p>Four.</p>');
  const lines = await blameChapter(git, library, { bookId: 'book-fox-1', chId: 'c1' }, options);
  assert.deepEqual(lines.map((l) => l.who), ['author', 'librarian', 'author', 'uncommitted']);
});

test('without the chapter driver the whole chapter would be one line', async (t) => {
  // The baseline the driver is there to change, so the test above cannot pass by luck.
  const { git, library, options } = await history(t);
  unlinkSync(options.attributesFile);
  const lines = await blameChapter(git, library, { bookId: 'book-fox-1', chId: 'c1' }, options);
  assert.equal(lines.length, 1);
});

test('ids that leave the library are refused before git runs', async (t) => {
  const { git, library, options } = await history(t);
  for (const ids of [
    { bookId: '..', chId: 'c1' },
    { bookId: 'book-fox-1', chId: '../book' },
    { bookId: 'book-fox-1/chapters', chId: 'c1' },
    { bookId: 'book-fox-1', chId: 'c1\0' },
  ]) {
    await assert.rejects(blameChapter(git, library, ids, options), /one name/, JSON.stringify(ids));
  }
});

test('lines map onto the window\'s paragraphs, several to a line in a list or quote', () => {
  const line = (html: string, who: 'author' | 'librarian') =>
    ({ html, who, commit: 'c'.repeat(40), author: who, email: '', time: 1 });
  const lines = [
    line('<p>One &amp; only.</p>', 'author'),
    line('<blockquote><p>Quoted.</p><p>Still quoted.</p></blockquote>', 'librarian'),
    line('<h2>Heading</h2>', 'author'),
    line('<p class="x">Three <em>here</em>.</p>', 'author'),
  ];
  const aligned = alignBlame(lines, ['One & only.', 'Quoted.', 'Still quoted.', 'Three here.']);
  assert.deepEqual(aligned.map((l) => l && l.who), ['author', 'librarian', 'librarian', 'author']);
});

test('a paragraph whose text differs from the blamed file is credited to no one', () => {
  const lines = [{ html: '<p>One.</p>', who: 'author' as const, commit: 'c'.repeat(40), author: 'A', email: '', time: 1 }];
  assert.deepEqual(alignBlame(lines, ['One, edited.', 'Two.']), [null, null]);
});

test('blame works on a machine with no git identity', async (t) => {
  // textconv's cache is written as a commit under refs/notes; it must not need the writer.
  const { git, library, options } = await history(t);
  isolateGitConfig(t, null);
  const lines = await blameChapter(git, library, { bookId: 'book-fox-1', chId: 'c1' }, options);
  assert.equal(lines.length, 3);
});
