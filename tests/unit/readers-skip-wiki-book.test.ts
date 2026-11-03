// Rule: every reader finds wiki and source pages through the page store only; no reader
// opens the Wiki book. The readers are search, the companion, review, the git layer and
// the page store itself, and the marks store; none of them may name the Wiki book's
// store, its manifest (.neo/wiki.json), its id, or the channels that served its chapters.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hoard = fileURLToPath(new URL('../../src/hoard/', import.meta.url));
const READERS = ['search', 'companion', 'review', 'git', 'pages', 'marks/store.ts', 'marks/model.ts'];
const WIKI_BOOK = /wiki\/store|WikiStore|wikiBook|wikiId|wiki\.json|wiki\.edit|wiki\/write|librarianPages|book-wiki/;

function sources(entry: string): string[] {
  const full = path.join(hoard, entry);
  if (full.endsWith('.ts')) return [full];
  return readdirSync(full, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(path.join(entry, d.name)) : d.name.endsWith('.ts') ? [path.join(full, d.name)] : []));
}

test('no reader names the Wiki book', () => {
  const files = READERS.flatMap(sources);
  assert.ok(files.length > 20, `the readers were found: ${files.length} files`);
  const named = files.filter((file) => WIKI_BOOK.test(readFileSync(file, 'utf8'))).map((file) => path.relative(hoard, file));
  assert.deepEqual(named, []);
});

test('the check can fail: a reader that names the Wiki book is caught', () => {
  assert.ok(WIKI_BOOK.test("import { WikiStore } from '../wiki/store.ts';"));
  assert.ok(WIKI_BOOK.test("path.join(library, '.neo', 'wiki.json')"));
  assert.ok(!WIKI_BOOK.test("import { linksIn } from '../wiki/links.ts';"));
});

// Rule: the Wiki book is gone from src/hoard: no file names its store, its manifest, its
// schemas or the channels that served its chapters. Pages come in only as page files.
const GONE = /WikiStore|wiki\.edit|wiki\/store|wiki\.json|wiki\.pages|wiki\.imported-book|['"`]wiki\.page['"`]|HoardWikiV1|HoardWikiPageV1|hoard-wiki-v1|hoard-wiki-page-v1|open-imported-book/;

test('nothing in src/hoard names the Wiki book store, its file, its schemas or its channels', () => {
  const files = sources('.');
  assert.ok(files.length > 40, `src/hoard was found: ${files.length} files`);
  const named = files
    .map((file) => path.relative(hoard, file))
    .filter((rel) => GONE.test(readFileSync(path.join(hoard, rel), 'utf8')));
  assert.deepEqual(named, []);
});

test('the removed pieces are gone from disk', () => {
  for (const gone of ['wiki/store.ts', '../../schemas/hoard-wiki-v1.json', '../../schemas/ipc/hoard-wiki-page-v1.json']) {
    assert.equal(existsSync(path.join(hoard, gone)), false, gone);
  }
});

test('the check can fail: a file naming a removed piece is caught', () => {
  for (const text of ["host.handle('wiki.pages', f)", "neo.invoke('wiki.imported-book')", "validateHoardWikiV1(x)", "from './store.ts'; new WikiStore(o)"]) {
    assert.ok(GONE.test(text), text);
  }
  assert.ok(!GONE.test("host.handle('wiki.import', f)"));
});
