// Rules for searching the library's files:
// - every book's chapters are searched, in their order, the books by title, each book its
//   own group; the open book is left to the window;
// - every page in wiki/ and sources/ is searched too, each tree its own group ahead of
//   the books, and a hit names its page by id;
// - before each search only chapters whose files changed are read again, and one gone
//   from a book, or a book gone, is gone from the results;
// - an iCloud placeholder is never read, and a book.json that does not read is passed
//   over; both are counted;
// - the pages scope keeps the search to the two page trees, and scope all searches both.
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
  const page = (id: string, html: string) => {
    const file = path.join(root, ...id.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, html);
  };
  return { root, book, touch, page };
}

const shape = (r: Awaited<ReturnType<LibraryIndex['search']>>) =>
  r.groups.map((g) => ['bookId' in g ? g.bookTitle : g.title, g.hits.map((h) => `${'page' in h ? h.page : h.chapter}:${h.pIdx}:${h.match}`)]);

test('books are searched by title, each its own group, the open book left out', async (t) => {
  const { root, book } = library(t);
  book('book-zed-1', 'Zed', { c1: '<p>The harbour at night.</p>' });
  book('book-abe-1', 'Abe', { c1: '<p>No.</p>', c2: '<p>A <i>harbour</i> wall.</p>' }, { c2: 'Walls' });
  book('book-open-1', 'Open', { c1: '<p>harbour</p>' });
  book('book-wiki-1', 'Wiki', { p1: '<p class="wiki-h1" data-block="a1">Harbour</p><p data-block="a2">Stone harbour.</p>' }, { p1: 'Harbour' });
  const index = new LibraryIndex();
  const found = await index.search(root, { text: 'harbour', scope: 'all', open: 'book-open-1', limit: 50, cap: 500 });
  assert.deepEqual(shape(found), [
    ['Abe', ['Walls:0:harbour']],
    ['Wiki', ['Harbour:0:Harbour', 'Harbour:0:Harbour', 'Harbour:1:harbour']],
    ['Zed', ['Chapter 1:0:harbour']],
  ]);
  assert.deepEqual([found.total, found.capped], [5, false]);
  assert.deepEqual(found.groups[1]!.hits.map((h) => h.kind), ['title', 'text', 'text']);
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
  assert.deepEqual(shape(found), [['A', ['Chapter 1:0:words', 'Chapter 2:0:words']]]);
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

test('a word in a sources page is found and the hit names that page id', async (t) => {
  const { root, page } = library(t);
  page('sources/Notes.html', '<p>Nothing.</p><p>The lamp stood by the quay.</p>');
  const found = await new LibraryIndex().search(root, { text: 'lamp', scope: 'all', open: null, limit: 50, cap: 500 });
  assert.deepEqual(shape(found), [['Sources', ['sources/Notes.html:1:lamp']]]);
  const [hit] = found.groups[0]!.hits;
  assert.deepEqual(['page' in hit!, 'bookId' in hit!, hit!.kind], [true, false, 'text']);
  assert.equal('tree' in found.groups[0]! && found.groups[0].tree, 'sources');
});

test('a word in a nested wiki page is found, and a page title is searched too', async (t) => {
  const { root, page } = library(t);
  page('wiki/Places/Harbour Town/Quay.html', '<p>Nets hang on the quay.</p>');
  const found = await new LibraryIndex().search(root, { text: 'quay', scope: 'all', open: null, limit: 50, cap: 500 });
  assert.deepEqual(shape(found), [['Wiki', ['wiki/Places/Harbour Town/Quay.html:0:Quay', 'wiki/Places/Harbour Town/Quay.html:0:quay']]]);
  assert.deepEqual(found.groups[0]!.hits.map((h) => h.kind), ['title', 'text']);
});

test('scope pages finds no book chapters and scope all finds both, the wiki tree ahead of sources', async (t) => {
  const { root, book, page } = library(t);
  book('book-a-1', 'A', { c1: '<p>A tide rose.</p>' });
  page('sources/Almanac.html', '<p>The tide table.</p>');
  page('wiki/Moon.html', '<p>It pulls the tide.</p>');
  const index = new LibraryIndex();
  const pages = await index.search(root, { text: 'tide', scope: 'pages', open: null, limit: 50, cap: 500 });
  assert.deepEqual(pages.groups.map((g) => 'tree' in g && g.tree), ['wiki', 'sources']);
  assert.equal(pages.total, 2);
  const all = await index.search(root, { text: 'tide', scope: 'all', open: null, limit: 50, cap: 500 });
  assert.deepEqual(all.groups.map((g) => ('tree' in g ? g.tree : g.bookTitle)), ['wiki', 'sources', 'A']);
  assert.equal(all.total, 3);
});

test('limit and cap bound page hits as they bound chapter hits', async (t) => {
  const { root, page } = library(t);
  for (const n of [1, 2, 3, 4]) page(`sources/S${n}.html`, '<p>reef reef</p>');
  const index = new LibraryIndex();
  const limited = await index.search(root, { text: 'reef', scope: 'pages', open: null, limit: 3, cap: 500 });
  assert.deepEqual([limited.total, limited.groups[0]!.hits.length, limited.groups[0]!.total, limited.capped], [8, 3, 8, false]);
  const capped = await index.search(root, { text: 'reef', scope: 'pages', open: null, limit: 3, cap: 5 });
  assert.deepEqual([capped.total, capped.capped], [5, true]);
});

test('only changed pages are read again, and a page gone drops out', async (t) => {
  const { root, page, touch } = library(t);
  page('sources/A.html', '<p>old surf</p>');
  page('wiki/B.html', '<p>surf</p>');
  const index = new LibraryIndex();
  await index.search(root, { text: 'surf', scope: 'pages', open: null, limit: 50, cap: 500 });
  assert.equal(index.stats().read, 2);
  touch('sources/A.html', '<p>new surf</p>');
  rmSync(path.join(root, 'wiki', 'B.html'));
  const found = await index.search(root, { text: 'surf', scope: 'pages', open: null, limit: 50, cap: 500 });
  assert.equal(index.stats().read, 1);
  assert.deepEqual(shape(found), [['Sources', ['sources/A.html:0:surf']]]);
  assert.equal(found.groups[0]!.hits[0]!.before, 'new ');
});

test('a page placeholder is never read, and counted', async (t) => {
  const { root, page } = library(t);
  page('sources/Here.html', '<p>shoal here</p>');
  page('sources/Away.html', '<p>shoal away</p>');
  const away = path.join(root, 'sources', 'Away.html');
  const index = new LibraryIndex({
    platform: 'darwin',
    stat: async (file) => Object.assign(await stat(file), { blocks: file === away ? 0 : 8 }),
  });
  const found = await index.search(root, { text: 'shoal', scope: 'pages', open: null, limit: 50, cap: 500 });
  assert.deepEqual(shape(found), [['Sources', ['sources/Here.html:0:shoal']]]);
  assert.equal(found.cloud, 1);
});
