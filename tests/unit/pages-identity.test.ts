// Rules: a page's id is its tree and its path, and no id or path can name a file outside
// its tree folder or inside a hidden one; a page's title is its file name without .html.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPath, checkTitle, idOf, parseId, PageRefused, titleOf } from '../../src/hoard/pages/identity.ts';

test('an id is the tree and the path, and parses back to the same page', () => {
  const ref = { tree: 'wiki', path: 'People/Novin\'a.html' } as const;
  assert.equal(idOf(ref), 'wiki/People/Novin\'a.html');
  assert.deepEqual(parseId(idOf(ref)), ref);
  assert.deepEqual(parseId('sources/a b/c.html'), { tree: 'sources', path: 'a b/c.html' });
});

test('a title is the file name without .html, whatever the folder', () => {
  assert.equal(titleOf('People/Novin\'a.html'), 'Novin\'a');
  assert.equal(titleOf('Plain.html'), 'Plain');
  assert.equal(titleOf('Dotted.name.html'), 'Dotted.name');
});

test('a path that could leave its tree is refused', () => {
  const bad = [
    '../x.html', 'a/../../x.html', 'a/./b.html', '/etc/x.html', 'C:/x.html', 'C:x.html', 'a\\b.html', '..\\x.html',
    'a//b.html', 'a/b/', '', 'a\0b.html', '.hidden/x.html', 'a/.hidden/x.html', '.x.html', 'noext', 'a.md', '.html', 'a/.html',
  ];
  for (const p of bad) assert.throws(() => checkPath(p), PageRefused, JSON.stringify(p));
});

test('an id for a tree that does not exist, or with a bad path, is refused', () => {
  for (const id of ['other/x.html', 'wiki', 'wiki/', 'wiki/../sources/x.html', '/wiki/x.html', 'wiki/..%2fx.html/..']) {
    assert.throws(() => parseId(id), PageRefused, id);
  }
  assert.throws(() => parseId(42 as unknown as string), PageRefused);
});

// Rule: a title is refused, in the window as in the store, when no [[link]] could name it:
// empty, spaces at an end, or one of the link grammar's stops or a control character.
test('a title no link could name is refused, from the path alone', () => {
  assert.equal(checkTitle('People/Ada Vell.html'), 'Ada Vell');
  for (const bad of ['.html', ' .html', 'A /B .html', 'A[1].html', 'A|B.html', 'A#B.html', 'A^B.html', 'A\u0007.html', 'A].html']) {
    assert.throws(() => checkTitle(bad), (e: PageRefused) => e.code === 'title', bad);
  }
});
