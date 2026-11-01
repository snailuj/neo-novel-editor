// Rules for reading an import list:
// - each line of a text list that is not blank or a # comment names one page, read from
//   the list's own folder unless absolute;
// - ` -> Name` after the path names the page in the wiki, and `#Heading` after `.md`
//   takes only that section, and `#L12-L40` only those lines, with `@` and the start of
//   the file's hash after it;
// - a `book: Title` line sends the entries after it into that book, and `book: Wiki`
//   back into the wiki;
// - a .csv list gives the `path` of each row whose `verdict` is Move, named by a `name`
//   column and sent to a `book` column's book, and lists the other rows it leaves out
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
    { line: 3, path: path.join(dir, 'lore/Harbour.md'), section: null, name: null, book: null, sha: null },
    { line: 4, path: path.join(dir, 'Writing/Tide Tables.md'), section: null, name: null, book: null, sha: null },
    { line: 5, path: path.resolve('/elsewhere/Quay.md'), section: null, name: null, book: null, sha: null },
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
  assert.deepEqual(list.entries.map((e) => [rel(e.path), e.section, e.name, e.book, e.sha]), [
    ['lore/Harbour.md', null, null, null, null],
    ['Daily/2025-12-15.md', 'Morning Pages', '2025-12-15', 'Morning Pages', null],
    ['Daily/2026-01-23.md', 'L60-L66', '2026-01-23', 'Morning Pages', 'abcdef0123'],
    ['Daily/2026-01-23.md', 'L68-L96', '2026-01-23', 'Morning Pages', null],
    ['Garuda.md', 'L3-L9', 'Garuda-Ideas', null, null],
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
  assert.deepEqual(list.entries.map((e) => [e.line, rel(e.path), e.name, e.book]), [[2, 'lore/Harbour.md', null, null], [4, 'lore/The "Quay", North.md', null, null]]);
  assert.deepEqual(list.left.map((l) => [l.line, l.why]), [
    [5, 'its verdict is Split: name its sections in a text list'],
    [6, 'its verdict is Hold'],
  ]);
});

test('a csv list\'s name and book columns name the page and its book', () => {
  const csv = ['path,verdict,name,book', 'Daily/a.md,Move,2025-12-15,Morning Pages', 'lore/b.md,Move,,', 'lore/c.md,Move,Sea-(place),Wiki'].join('\n');
  const list = readImportList(path.join(dir, 'keep-move.csv'), csv);
  assert.deepEqual(list.entries.map((e) => [rel(e.path), e.name, e.book]), [
    ['Daily/a.md', '2025-12-15', 'Morning Pages'], ['lore/b.md', null, null], ['lore/c.md', 'Sea-(place)', null],
  ]);
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
  assert.throws(() => readImportList(path.join(dir, 'l.txt'), 'a.md -> x/y\n'), (err: unknown) =>
    err instanceof ListError && /line 1/.test(err.message));
  assert.throws(() => readImportList(path.join(dir, 'l.txt'), '# nothing\n'), (err: unknown) =>
    err instanceof ListError && /no page/.test(err.message));
});
