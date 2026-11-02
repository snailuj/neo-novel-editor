// Rules for reading an import list:
// - each line of a text list that is not blank or a # comment names one page, read from
//   the list's own folder unless absolute;
// - ` -> Name` after the path names the page in the wiki, and `#Heading` after `.md`
//   takes only that section, and `#L12-L40` only those lines, with `@` and the start of
//   the file's hash after it;
// - entries go to sources/ until a `to: wiki` line, and a `to: sources` line sends them
//   back; ` -> Folder/Name` puts a page in that folder of its tree;
// - a `book: Title` line sends the entries after it into that book, and `book: Wiki`
//   reads as `to: wiki`;
// - a .csv list gives the `path` of each row whose `verdict` is Move, named by a `name`
//   column, sent to a `to` column's tree or a `book` column's book, and lists the other rows it leaves out
//   with the reason;
// - a list that cannot be read as a list says which line and why.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { lineRange, ListError, readImportList } from '../../src/hoard/wiki/import-list.ts';

const dir = path.resolve('/vault');
// The parser gives native paths ('lore\Harbour.md' on Windows); the tests compare in '/'.
const rel = (p: string) => path.relative(dir, p).split(path.sep).join('/');

test('each line of a text list names one page, read from the list\'s folder', () => {
  const list = readImportList(path.join(dir, 'move.txt'), [
    '# pages to move',
    '',
    'lore/Harbour.md',
    '  Writing/Tide Tables.md  ',
    '/elsewhere/Quay.md',
  ].join('\n'));
  assert.deepEqual(list.entries, [
    { line: 3, path: path.join(dir, 'lore/Harbour.md'), section: null, name: null, folder: null, to: 'sources', book: null, sha: null },
    { line: 4, path: path.join(dir, 'Writing/Tide Tables.md'), section: null, name: null, folder: null, to: 'sources', book: null, sha: null },
    { line: 5, path: path.resolve('/elsewhere/Quay.md'), section: null, name: null, folder: null, to: 'sources', book: null, sha: null },
  ]);
  assert.deepEqual(list.left, []);
});

test('a name after an arrow and a heading after .md are kept apart from the path', () => {
  const list = readImportList(path.join(dir, 'move.txt'), [
    'lore/Harbour.md -> Harbour-(place)',
    'projects/tide-(project).md#Overview -> tide-(era)',
    'projects/tide-(project).md#Peoples and Places->tide-(era)',
    'lore/C# notes.md',
  ].join('\r\n'));
  assert.deepEqual(list.entries.map(({ path: p, section, name }) => [rel(p), section, name]), [
    ['lore/Harbour.md', null, 'Harbour-(place)'],
    ['projects/tide-(project).md', 'Overview', 'tide-(era)'],
    ['projects/tide-(project).md', 'Peoples and Places', 'tide-(era)'],
    ['lore/C# notes.md', null, null],
  ]);
});

test('a line range keeps the hash it was read against, and book lines route the entries after them', () => {
  const list = readImportList(path.join(dir, 'move.txt'), [
    'lore/Harbour.md',
    'book: Morning Pages',
    'Daily/2025-12-15.md#Morning Pages -> 2025-12-15',
    'Daily/2026-01-23.md#L60-L66@ABCDEF0123 -> 2026-01-23',
    'Daily/2026-01-23.md#L68-L96 -> 2026-01-23',
    'BOOK: wiki',
    'Garuda.md#L3-L9 -> Garuda-Ideas',
  ].join('\n'));
  assert.deepEqual(list.entries.map((e) => [rel(e.path), e.section, e.name, e.to, e.book, e.sha]), [
    ['lore/Harbour.md', null, null, 'sources', null, null],
    ['Daily/2025-12-15.md', 'Morning Pages', '2025-12-15', null, 'Morning Pages', null],
    ['Daily/2026-01-23.md', 'L60-L66', '2026-01-23', null, 'Morning Pages', 'abcdef0123'],
    ['Daily/2026-01-23.md', 'L68-L96', '2026-01-23', null, 'Morning Pages', null],
    ['Garuda.md', 'L3-L9', 'Garuda-Ideas', 'wiki', null, null],
  ]);
  assert.deepEqual([lineRange('L3-L9'), lineRange('Overview'), lineRange('L3-L9@abc')], [{ start: 3, end: 9 }, null, null]);
  assert.throws(() => readImportList(path.join(dir, 'l.txt'), 'a.md#L9-L3\n'), (err: unknown) =>
    err instanceof ListError && /line 1/.test(err.message) && /backwards/.test(err.message));
  assert.throws(() => readImportList(path.join(dir, 'l.txt'), 'book: a/b\na.md\n'), (err: unknown) =>
    err instanceof ListError && /line 1/.test(err.message));
});

test('a csv list takes the Move rows of its path column and says why it left the rest', () => {
  const csv = [
    'path,verdict,type,role,reason',
    'lore/Harbour.md,Move,lore,writer,"World-building, by the sea."',
    'inbox/Groceries.md,Keep,,,"Personal, not writing."',
    '"lore/The ""Quay"", North.md",move,lore,writer,"Quoted, with a comma."',
    'projects/tide-(project).md,Split,,,Sections move.',
    'inbox/Maybe.md,Hold,,,Ask.',
  ].join('\n');
  const list = readImportList(path.join(dir, 'keep-move.csv'), csv);
  assert.deepEqual(list.entries.map((e) => [e.line, rel(e.path), e.name, e.to, e.book]), [[2, 'lore/Harbour.md', null, 'sources', null], [4, 'lore/The "Quay", North.md', null, 'sources', null]]);
  assert.deepEqual(list.left.map((l) => [l.line, l.why]), [
    [5, 'its verdict is Split: name its sections in a text list'],
    [6, 'its verdict is Hold'],
  ]);
});

test('a csv list\'s name, to and book columns name the page and where it goes', () => {
  const csv = [
    'path,verdict,name,to,book',
    'Daily/a.md,Move,2025-12-15,,Morning Pages',
    'lore/b.md,Move,,,',
    'lore/c.md,Move,Sea-(place),,Wiki',
    'lore/d.md,Move,Places/Quay,Wiki,',
    'lore/e.md,Move,,sources,',
  ].join('\n');
  const list = readImportList(path.join(dir, 'keep-move.csv'), csv);
  assert.deepEqual(list.entries.map((e) => [rel(e.path), e.name, e.folder, e.to, e.book]), [
    ['Daily/a.md', '2025-12-15', null, null, 'Morning Pages'], ['lore/b.md', null, null, 'sources', null],
    ['lore/c.md', 'Sea-(place)', null, 'wiki', null], ['lore/d.md', 'Quay', 'Places', 'wiki', null], ['lore/e.md', null, null, 'sources', null],
  ]);
  assert.throws(() => readImportList(path.join(dir, 'l.csv'), 'path,verdict,to\na.md,Move,lore\n'), (err: unknown) =>
    err instanceof ListError && /line 2/.test(err.message) && /sources or wiki/.test(err.message));
});

test('to lines send the entries after them to sources or the wiki, and a folder before the name places the page', () => {
  const list = readImportList(path.join(dir, 'move.txt'), [
    'notes/Tide.md',
    'TO: wiki',
    'lore/Harbour.md -> Places/Harbour-(place)',
    'lore/Quay.md',
    'book: Morning Pages',
    'Daily/a.md -> 2025-12-15',
    'to: Sources',
    'notes/Ebb.md -> Ebb notes',
    'book: Wiki',
    'lore/Sea.md -> Places / Deep / Sea',
  ].join('\n'));
  assert.deepEqual(list.entries.map((e) => [rel(e.path), e.name, e.folder, e.to, e.book]), [
    ['notes/Tide.md', null, null, 'sources', null],
    ['lore/Harbour.md', 'Harbour-(place)', 'Places', 'wiki', null],
    ['lore/Quay.md', null, null, 'wiki', null],
    ['Daily/a.md', '2025-12-15', null, null, 'Morning Pages'],
    ['notes/Ebb.md', 'Ebb notes', null, 'sources', null],
    ['lore/Sea.md', 'Sea', 'Places/Deep', 'wiki', null],
  ]);
  for (const [text, why] of [
    ['to: lore\na.md\n', /sources or wiki/],
    ['a.md -> ../Up\n', /folder/],
    ['a.md -> .hidden/Up\n', /folder/],
    ['a.md -> a//b\n', /folder/],
    ['a.md -> a\\b\n', /slash/],
    ['book: Morning Pages\na.md -> Week/Monday\n', /book/],
  ] as const) {
    assert.throws(() => readImportList(path.join(dir, 'l.txt'), text), (err: unknown) =>
      err instanceof ListError && /line \d/.test(err.message) && why.test(err.message), text);
  }
});

test('a list that is not a list says which line and why', () => {
  assert.throws(() => readImportList(path.join(dir, 'l.csv'), 'file,verdict\na.md,Move\n'), (err: unknown) =>
    err instanceof ListError && /path/.test(err.message));
  assert.throws(() => readImportList(path.join(dir, 'l.csv'), 'path,verdict\n"a.md,Move\n'), (err: unknown) =>
    err instanceof ListError && /line 2/.test(err.message));
  assert.throws(() => readImportList(path.join(dir, 'l.txt'), 'a.md\nnotes.txt\n'), (err: unknown) =>
    err instanceof ListError && /line 2/.test(err.message) && /\.md/.test(err.message));
  assert.throws(() => readImportList(path.join(dir, 'l.txt'), 'a.md -> \n'), (err: unknown) =>
    err instanceof ListError && /line 1/.test(err.message));
  assert.throws(() => readImportList(path.join(dir, 'l.txt'), '# nothing\n'), (err: unknown) =>
    err instanceof ListError && /no page/.test(err.message));
});
