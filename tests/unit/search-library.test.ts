// Rules for searching the library's files:
// - every book's chapters are searched, in their order, the wiki's first and the others
//   by title, each book its own group; the open book is left to the window;
// - before each search only chapters whose files changed are read again, and one gone
//   from a book, or a book gone, is gone from the results;
// - an iCloud placeholder is never read, and a book.json that does not read is passed
//   over; both are counted;
// - the wiki scope keeps the search to the wiki (the window searches the open book).
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { LibraryIndex } from '../../src/hoard/search/library.ts';
import { tempDir } from './git-support.ts';

type T = Parameters<typeof tempDir>[0];

function library(t: T) {
  const root = tempDir(t);
  const book = (id: string, title: string, chapters: Record<string, string>, titles: Record<string, string> = {}) => {
    mkdirSync(path.join(root, id, 'chapters'), { recursive: true });
    writeFileSync(path.join(root, id, 'book.json'), JSON.stringify({ id, title, chapterOrder: Object.keys(chapters), chapterTitles: titles }));
    for (const [chId, html] of Object.entries(chapters)) writeFileSync(path.join(root, id, 'chapters', `${chId}.html`), html);
  };
  const touch = (rel: string, html: string) => {
    const file = path.join(root, rel);
    writeFileSync(file, html);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);
  };
  return { root, book, touch };
}

const shape = (r: Awaited<ReturnType<LibraryIndex['search']>>) =>
  r.groups.map((g) => [g.bookTitle, g.wiki, g.hits.map((h) => `${h.chapter}:${h.pIdx}:${h.match}`)]);

test('books are searched wiki first, then by title, each its own group, the open book left out', async (t) => {
  const { root, book } = library(t);
  book('book-zed-1', 'Zed', { c1: '<p>The harbour at night.</p>' });
  book('book-abe-1', 'Abe', { c1: '<p>No.</p>', c2: '<p>A <i>harbour</i> wall.</p>' }, { c2: 'Walls' });
  book('book-open-1', 'Open', { c1: '<p>harbour</p>' });
  book('book-wiki-1', 'Wiki', { p1: '<p class="wiki-h1" data-block="a1">Harbour</p><p data-block="a2">Stone harbour.</p>' }, { p1: 'Harbour' });
  mkdirSync(path.join(root, '.neo'));
  writeFileSync(path.join(root, '.neo', 'wiki.json'), JSON.stringify({ version: 1, bookId: 'book-wiki-1' }));
  const index = new LibraryIndex();
  const found = await index.search(root, { text: 'harbour', scope: 'all', open: 'book-open-1', limit: 50, cap: 500 });
  assert.deepEqual(shape(found), [
    ['Wiki', true, ['Harbour:0:Harbour', 'Harbour:0:Harbour', 'Harbour:1:harbour']],
    ['Abe', false, ['Walls:0:harbour']],
    ['Zed', false, ['Chapter 1:0:harbour']],
  ]);
  assert.deepEqual([found.total, found.capped], [5, false]);
  assert.deepEqual(found.groups[0]!.hits.map((h) => h.kind), ['title', 'text', 'text']);
});

test('only changed chapters are read again, and gone ones drop out', async (t) => {
  const { root, book, touch } = library(t);
  book('book-a-1', 'A', { c1: '<p>old words</p>', c2: '<p>kept words</p>' });
  book('book-b-1', 'B', { c1: '<p>words</p>' });
  const index = new LibraryIndex();
  await index.search(root, { text: 'words', scope: 'all', open: null, limit: 50, cap: 500 });
  const first = index.stats();
  assert.equal(first.read, 5, 'two book.json files and three chapters');
  touch('book-a-1/chapters/c1.html', '<p>new words</p>');
  rmSync(path.join(root, 'book-b-1'), { recursive: true });
  const found = await index.search(root, { text: 'words', scope: 'all', open: null, limit: 50, cap: 500 });
  assert.equal(index.stats().read, 1);
  assert.deepEqual(shape(found), [['A', false, ['Chapter 1:0:words', 'Chapter 2:0:words']]]);
  assert.equal(found.groups[0]!.hits[0]!.before, 'new ');
});

test('a placeholder is never read and a book.json that does not read is passed over, both counted', async (t) => {
  const { root, book } = library(t);
  book('book-a-1', 'A', { c1: '<p>here</p>', c2: '<p>in the cloud</p>' });
  mkdirSync(path.join(root, 'book-bad-1'));
  writeFileSync(path.join(root, 'book-bad-1', 'book.json'), '{not json');
  const cloud = path.join(root, 'book-a-1', 'chapters', 'c2.html');
  const index = new LibraryIndex({
    platform: 'darwin',
    stat: async (file) => {
      const real = await stat(file);
      return file === cloud ? Object.assign(real, { blocks: 0 }) : Object.assign(real, { blocks: 8 });
    },
  });
  const found = await index.search(root, { text: 'cloud', scope: 'all', open: null, limit: 50, cap: 500 });
  assert.equal(found.total, 0);
  assert.deepEqual([found.cloud, found.unreadable], [1, 1]);
});

test('the wiki scope keeps the search to the wiki, unless it is the open book', async (t) => {
  const { root, book } = library(t);
  book('book-a-1', 'A', { c1: '<p>tide</p>' });
  book('book-wiki-1', 'Wiki', { p1: '<p>tide</p>' });
  mkdirSync(path.join(root, '.neo'));
  writeFileSync(path.join(root, '.neo', 'wiki.json'), JSON.stringify({ version: 1, bookId: 'book-wiki-1' }));
  const index = new LibraryIndex();
  const titles = async (open: string | null) =>
    (await index.search(root, { text: 'tide', scope: 'wiki', open, limit: 50, cap: 500 })).groups.map((g) => g.bookTitle);
  assert.deepEqual(await titles('book-a-1'), ['Wiki']);
  assert.deepEqual(await titles('book-wiki-1'), []);
});
