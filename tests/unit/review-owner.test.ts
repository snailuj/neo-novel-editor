// Rule: a chapter is the librarian's only when its page sidecar says the librarian wrote
// it: provenance.author's first voice, or, with no voice recorded, a librarian-authored
// type. Everything else, a chapter with no page sidecar or one that does not read
// included, is the writer's, so the librarian never applies a change to a page whose
// owner is unknown.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PageRefused } from '../../src/hoard/pages/identity.ts';
import { librarianPages, ownerFromFrontmatter, ownerOf } from '../../src/hoard/review/owner.ts';

test('the first recorded voice decides', () => {
  assert.equal(ownerFromFrontmatter({ provenance: { author: 'Librarian' } }), 'librarian');
  assert.equal(ownerFromFrontmatter({ provenance: { author: ['librarian', 'Ada Author'] } }), 'librarian');
  assert.equal(ownerFromFrontmatter({ provenance: { author: 'librarian, Ada Author' } }), 'librarian');
  assert.equal(ownerFromFrontmatter({ provenance: { author: 'Ada Author, librarian' } }), 'author');
  // a recorded voice wins over the type
  assert.equal(ownerFromFrontmatter({ type: 'lore', provenance: { author: 'Ada Author' } }), 'author');
  assert.equal(ownerFromFrontmatter({ type: 'writing', provenance: { author: 'librarian' } }), 'librarian');
});

test('with no voice recorded, lore and project pages are the librarian\'s', () => {
  assert.equal(ownerFromFrontmatter({ type: 'lore' }), 'librarian');
  assert.equal(ownerFromFrontmatter({ type: 'project' }), 'librarian');
  assert.equal(ownerFromFrontmatter({ type: 'lore', provenance: { author: '  ' } }), 'librarian');
  assert.equal(ownerFromFrontmatter({ type: 'writing' }), 'author');
  assert.equal(ownerFromFrontmatter({ type: 'source' }), 'author');
});

test('a page with no frontmatter, or none that says, is the writer\'s', () => {
  assert.equal(ownerFromFrontmatter(null), 'author');
  assert.equal(ownerFromFrontmatter({}), 'author');
  assert.equal(ownerFromFrontmatter({ type: ['lore'] }), 'author');
  assert.equal(ownerFromFrontmatter({ provenance: 'librarian' }), 'author');
});

function library(pages: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-owner-'));
  const dir = path.join(root, '.neo', 'book-wiki-1', 'pages');
  mkdirSync(dir, { recursive: true });
  for (const [chId, data] of Object.entries(pages)) {
    writeFileSync(path.join(dir, `${chId}.json`), typeof data === 'string' ? data : JSON.stringify(data));
  }
  return root;
}

const page = (frontmatter: unknown) => ({
  version: 1, source: { path: '/synthetic/page.md', name: 'page', sha256: 'a'.repeat(64) }, frontmatter, imported: '2026-10-15T21:00:00.000Z',
});

test('librarianPages lists only the chapters whose sidecars name the librarian, and logs those that do not read', () => {
  const root = library({
    'ch-lore': page({ type: 'lore' }),
    'ch-mine': page({ type: 'writing' }),
    'ch-none': page(null),
    'ch-broken': '{ not json',
    'ch-wrong': { version: 2 },
  });
  const logged: string[] = [];
  const found = librarianPages(root, 'book-wiki-1', (level, message) => logged.push(`${level} ${message}`));
  assert.deepEqual(found, ['ch-lore']);
  assert.equal(logged.length, 2, logged.join('\n'));
  assert.ok(logged.every((l) => l.startsWith('warn ')));
});

test('a book with no page sidecars has no librarian pages, and a bad book id is refused', () => {
  const root = library({});
  assert.deepEqual(librarianPages(root, 'book-other', () => {}), []);
  assert.throws(() => librarianPages(root, '../x', () => {}), TypeError);
});

// A page named by its id: the sidecar at .neo/pages/<tree>/<path>.json decides, and only
// for wiki pages. Anything not provably the librarian's is the author's.
const pageSidecar = (frontmatter: unknown) => page(frontmatter);

function pagesLibrary(files: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'review-owner-pages-'));
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  }
  return root;
}

test('a wiki page is the librarian\'s only when its sidecar at .neo/pages/<tree>/<path>.json says so', async () => {
  const root = pagesLibrary({
    '.neo/pages/wiki/People/Harbour.html.json': pageSidecar({ type: 'lore' }),
    '.neo/pages/wiki/Mine.html.json': pageSidecar({ provenance: { author: 'Ada Author' }, type: 'lore' }),
    '.neo/pages/wiki/Voice.html.json': pageSidecar({ provenance: { author: 'librarian' } }),
    '.neo/pages/wiki/Null.html.json': pageSidecar(null),
  });
  assert.equal(await ownerOf(root, 'wiki/People/Harbour.html'), 'librarian');
  assert.equal(await ownerOf(root, 'wiki/Voice.html'), 'librarian');
  assert.equal(await ownerOf(root, 'wiki/Mine.html'), 'author');
  assert.equal(await ownerOf(root, 'wiki/Null.html'), 'author');
});

test('a sources page is always the author\'s, whatever its sidecar says', async () => {
  const root = pagesLibrary({ '.neo/pages/sources/Notes/Tides.html.json': pageSidecar({ type: 'lore', provenance: { author: 'librarian' } }) });
  assert.equal(await ownerOf(root, 'sources/Notes/Tides.html'), 'author');
  assert.equal(await ownerOf(root, 'sources/Missing.html'), 'author');
});

test('a wiki page with no sidecar, or one that does not read, is the author\'s and the log says why', async () => {
  const root = pagesLibrary({
    '.neo/pages/wiki/Torn.html.json': '{ not json',
    '.neo/pages/wiki/Wrong.html.json': { version: 2 },
    // a book's sidecar of the same name is not this page's
    '.neo/book-wiki-1/pages/Missing.html.json': pageSidecar({ type: 'lore' }),
  });
  const logged: string[] = [];
  const log = (level: string, message: string) => logged.push(`${level} ${message}`);
  for (const id of ['wiki/Torn.html', 'wiki/Wrong.html', 'wiki/Missing.html']) {
    const before = logged.length;
    assert.equal(await ownerOf(root, id, log), 'author', id);
    assert.equal(logged.length, before + 1, `${id} logged once: ${logged.join('\n')}`);
    assert.ok(logged[before].includes(id), logged[before]);
  }
  assert.ok(logged[0].startsWith('warn ') && logged[1].startsWith('warn '), logged.join('\n'));
});

test('a page id that escapes the library is refused', async () => {
  const root = pagesLibrary({});
  for (const id of ['wiki/../x.html', '../x.html', 'wiki/x.md', 'notes/x.html', '']) {
    await assert.rejects(ownerOf(root, id), PageRefused, JSON.stringify(id));
  }
});
