// Rules for a search over chapters: titles that hold the phrase come first, then every
// match in the order given, each a place on the words as written with a little of the
// paragraph either side; a phrase never runs from one paragraph into the next; and the
// count stops at the cap, saying so, while only the first few hits are handed back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchChapters } from '../../src/hoard/search/scan.ts';

const chapters = [
  { bookId: 'b1', chId: 'c1', title: 'The Harbour', paragraphs: ['Gulls over the harbour wall.', 'Nothing here.'] },
  { bookId: 'b1', chId: 'c2', title: 'Tides', paragraphs: ['The HARBOUR at dawn, and the harbour at dusk.'] },
  { bookId: 'b2', chId: 'c9', title: 'Elsewhere', paragraphs: ['harbour', 'wall'] },
];

test('titles first, then each match in order, as places on the words as written', () => {
  const found = searchChapters(chapters, 'Harbour', { limit: 10, cap: 100 });
  assert.deepEqual(found.hits.map((h) => [h.kind, h.chId, h.pIdx, h.off, h.len]), [
    ['title', 'c1', 0, 0, 0],
    ['text', 'c1', 0, 15, 7],
    ['text', 'c2', 0, 4, 7],
    ['text', 'c2', 0, 29, 7],
    ['text', 'c9', 0, 0, 7],
  ]);
  assert.deepEqual([found.total, found.capped], [5, false]);
  assert.deepEqual(found.hits.map((h) => h.match), ['The Harbour', 'harbour', 'HARBOUR', 'harbour', 'harbour']);
});

test('each hit carries the words either side, cut at a word', () => {
  const long = `${'word '.repeat(30)}the harbour wall ${'more '.repeat(30)}`;
  const [hit] = searchChapters([{ bookId: 'b', chId: 'c', title: '', paragraphs: [long] }], 'harbour', { limit: 1, cap: 1 }).hits;
  assert.equal(hit!.match, 'harbour');
  assert.ok(hit!.before.endsWith('word the '), hit!.before);
  assert.match(hit!.before, /^word /);
  assert.match(hit!.after, /more$/);
  assert.ok(hit!.before.length <= 40);
  assert.ok(hit!.after.startsWith(' wall more'));
  assert.ok(hit!.after.length <= 60);
});

test('a phrase never runs across paragraphs', () => {
  assert.equal(searchChapters(chapters, 'harbour wall', { limit: 10, cap: 10 }).total, 1);
});

test('the count stops at the cap and says so; only the first hits come back', () => {
  const many = [{ bookId: 'b', chId: 'c', title: '', paragraphs: Array.from({ length: 50 }, () => 'a a a') }];
  const found = searchChapters(many, 'a', { limit: 3, cap: 100 });
  assert.deepEqual([found.hits.length, found.total, found.capped], [3, 100, true]);
});

test('an empty query finds nothing', () => {
  assert.deepEqual(searchChapters(chapters, '  ', { limit: 10, cap: 10 }), { hits: [], total: 0, capped: false });
});
