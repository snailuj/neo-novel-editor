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
import { librarianPages, ownerOf } from '../../src/hoard/review/owner.ts';

test('the first recorded voice decides', () => {
  assert.equal(ownerOf({ provenance: { author: 'Librarian' } }), 'librarian');
  assert.equal(ownerOf({ provenance: { author: ['librarian', 'Ada Author'] } }), 'librarian');
  assert.equal(ownerOf({ provenance: { author: 'librarian, Ada Author' } }), 'librarian');
  assert.equal(ownerOf({ provenance: { author: 'Ada Author, librarian' } }), 'author');
  // a recorded voice wins over the type
  assert.equal(ownerOf({ type: 'lore', provenance: { author: 'Ada Author' } }), 'author');
  assert.equal(ownerOf({ type: 'writing', provenance: { author: 'librarian' } }), 'librarian');
});

test('with no voice recorded, lore and project pages are the librarian\'s', () => {
  assert.equal(ownerOf({ type: 'lore' }), 'librarian');
  assert.equal(ownerOf({ type: 'project' }), 'librarian');
  assert.equal(ownerOf({ type: 'lore', provenance: { author: '  ' } }), 'librarian');
  assert.equal(ownerOf({ type: 'writing' }), 'author');
  assert.equal(ownerOf({ type: 'source' }), 'author');
});

test('a page with no frontmatter, or none that says, is the writer\'s', () => {
  assert.equal(ownerOf(null), 'author');
  assert.equal(ownerOf({}), 'author');
  assert.equal(ownerOf({ type: ['lore'] }), 'author');
  assert.equal(ownerOf({ provenance: 'librarian' }), 'author');
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
