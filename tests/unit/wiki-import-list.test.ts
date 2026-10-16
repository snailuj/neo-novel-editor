// Rules for reading an import list:
// - each line of a text list that is not blank or a # comment names one page, read from
//   the list's own folder unless absolute;
// - ` -> Name` after the path names the page in the wiki, and `#Heading` after `.md`
//   takes only that section;
// - a .csv list gives the `path` of each row whose `verdict` is Move, and lists the
//   other rows it leaves out with the reason;
// - a list that cannot be read as a list says which line and why.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { ListError, readImportList } from '../../src/hoard/wiki/import-list.ts';

const dir = path.resolve('/vault');

test('each line of a text list names one page, read from the list\'s folder', () => {
  const list = readImportList(path.join(dir, 'move.txt'), [
    '# pages to move',
    '',
    'lore/Harbour.md',
    '  Writing/Tide Tables.md  ',
    '/elsewhere/Quay.md',
  ].join('\n'));
  assert.deepEqual(list.entries, [
    { line: 3, path: path.join(dir, 'lore/Harbour.md'), section: null, name: null },
    { line: 4, path: path.join(dir, 'Writing/Tide Tables.md'), section: null, name: null },
    { line: 5, path: path.resolve('/elsewhere/Quay.md'), section: null, name: null },
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
  assert.deepEqual(list.entries.map(({ path: p, section, name }) => [path.relative(dir, p), section, name]), [
    ['lore/Harbour.md', null, 'Harbour-(place)'],
    ['projects/tide-(project).md', 'Overview', 'tide-(era)'],
    ['projects/tide-(project).md', 'Peoples and Places', 'tide-(era)'],
    ['lore/C# notes.md', null, null],
  ]);
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
  assert.deepEqual(list.entries.map((e) => [e.line, path.relative(dir, e.path)]), [[2, 'lore/Harbour.md'], [4, 'lore/The "Quay", North.md']]);
  assert.deepEqual(list.left.map((l) => [l.line, l.why]), [
    [5, 'its verdict is Split: name its sections in a text list'],
    [6, 'its verdict is Hold'],
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
