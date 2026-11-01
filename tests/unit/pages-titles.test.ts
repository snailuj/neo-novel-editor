// Rules: a [[link]] target resolves by title, folded as librarian/links.ts folds it; a
// wiki page wins over a source page with the same title; two pages in one tree cannot
// share a folded title, but two trees can.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleIndex } from '../../src/hoard/pages/titles.ts';

const page = (id: string) => {
  const slash = id.indexOf('/');
  const path = id.slice(slash + 1);
  return { id, tree: id.slice(0, slash) as 'wiki' | 'sources', title: path.slice(path.lastIndexOf('/') + 1).replace(/\.html$/, '') };
};

test('a target resolves by the same folding the link grammar uses', () => {
  const index = titleIndex([page('wiki/People/Novin\'a.html'), page('wiki/Café.html')]);
  assert.equal(index.resolve('novin\'a')?.id, 'wiki/People/Novin\'a.html');
  assert.equal(index.resolve('People/Novin\'a')?.id, 'wiki/People/Novin\'a.html');
  assert.equal(index.resolve('NOVIN\'A.md')?.id, 'wiki/People/Novin\'a.html');
  assert.equal(index.resolve('Café')?.id, 'wiki/Café.html');
  assert.equal(index.resolve('Cafe'), undefined, 'diacritics are never folded');
  assert.equal(index.resolve('Nobody'), undefined);
});

test('a wiki page wins over a source page with the same title', () => {
  const index = titleIndex([page('sources/Tide.html'), page('wiki/deep/tide.html'), page('sources/Only Source.html')]);
  assert.equal(index.resolve('Tide')?.id, 'wiki/deep/tide.html');
  assert.equal(index.resolve('Only Source')?.id, 'sources/Only Source.html');
});

test('a title is taken within its own tree only, and a page does not clash with itself', () => {
  const index = titleIndex([page('wiki/A/Tide.html'), page('sources/Moon.html')]);
  assert.equal(index.taken('wiki', 'TIDE')?.id, 'wiki/A/Tide.html');
  assert.equal(index.taken('wiki', 'TIDE', 'wiki/A/Tide.html'), undefined);
  assert.equal(index.taken('sources', 'Tide'), undefined);
  assert.equal(index.taken('wiki', 'Moon'), undefined);
});

test('two files with one folded title in a tree: the first by id wins, and both are reported', () => {
  const index = titleIndex([page('wiki/b/Tide.html'), page('wiki/a/tide.html')]);
  assert.equal(index.resolve('Tide')?.id, 'wiki/a/tide.html');
  assert.deepEqual(index.duplicates.map((d) => d.map((p) => p.id)), [['wiki/a/tide.html', 'wiki/b/Tide.html']]);
});
