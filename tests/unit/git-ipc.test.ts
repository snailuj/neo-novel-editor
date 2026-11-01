// Rule: a git request from the window names its place either as a chapter ({bookId, chId})
// or as a page ({page}), never both, never neither, never half a chapter, and a page is
// an id in one of the two trees.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateHoardGitBlameV1, validateHoardGitLibrarianBeginV1 } from '../../src/generated/validators.cjs';

const chapter = { bookId: 'book-fox-1', chId: 'c1' };
const page = 'wiki/People/Harbour.html';

const requests: [string, (d: unknown) => boolean, Record<string, unknown>][] = [
  ['git.blame', validateHoardGitBlameV1, {}],
  ['git.librarian-begin', validateHoardGitLibrarianBeginV1, { html: '<p>One.</p>' }],
];

test('every git request names a chapter or a page, never both, never neither, never half a chapter', () => {
  for (const [name, valid, rest] of requests) {
    assert.ok(valid({ ...chapter, ...rest }), `${name} takes a chapter`);
    assert.ok(valid({ page, ...rest }), `${name} takes a page`);
    assert.ok(valid({ page: 'sources/Notes/Tides.html', ...rest }), `${name} takes a sources page`);
    assert.ok(!valid({ ...rest }), `${name} needs a place`);
    assert.ok(!valid({ page, bookId: chapter.bookId, ...rest }), `${name} refuses a page with a book`);
    assert.ok(!valid({ page, ...chapter, ...rest }), `${name} refuses a page with a chapter`);
    assert.ok(!valid({ page: '', ...rest }), `${name} refuses an empty page`);
    assert.ok(!valid({ page: 'notes/x.html', ...rest }), `${name} refuses a page outside the two trees`);
    assert.ok(!valid({ bookId: chapter.bookId, ...rest }), `${name} refuses a book with no chapter`);
  }
});
