// Rule: every reader finds wiki and source pages through the page store only; no reader
// opens the Wiki book. The readers are search, the companion, review, the git layer and
// the page store itself, and the marks store; none of them may name the Wiki book's
// store, its manifest (.neo/wiki.json), its id, or the channels that served its chapters.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
