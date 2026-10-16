// Rules for drawing marks: every open mark whose quote is found is drawn under its
// kind's name, once, at the words it quotes; a closed mark is never drawn; a mark whose
// quote is gone is listed as stale, never dropped; the caret is in the smallest mark
// around it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { anchorAt, anchorPoint } from '../../src/hoard/marks/anchor.ts';
import { newMark, transition } from '../../src/hoard/marks/model.ts';
import { drawChapter, label, markAt, orderForList } from '../../src/hoard/marks/view.ts';

const at = '2026-10-15T21:00:00.000Z';
const text = ['The tide came in at dusk.', 'Mara counted the boats twice.'];
const mark = (id: string, place: { pIdx: number; off: number; len: number }, kind: Mark['kind'] = 'comment'): Mark =>
  newMark({ id, kind, anchor: anchorAt(text, place), body: kind === 'comment' ? 'Note.' : undefined, who: 'author', at });

test('open marks are drawn at their words under their kind; closed ones are not drawn but still listed', () => {
  const marks = [
    mark('m-aaaa1', { pIdx: 1, off: 5, len: 7 }),
    mark('m-aaaa2', { pIdx: 0, off: 4, len: 4 }, 'highlight'),
    transition(mark('m-aaaa3', { pIdx: 0, off: 20, len: 4 }), 'resolved', 'author', at),
  ];
  const drawn = drawChapter('c1', marks, text);
  assert.deepEqual(drawn.places.comment, [{ chId: 'c1', pIdx: 1, off: 5, len: 7 }]);
  assert.deepEqual(drawn.places.highlight, [{ chId: 'c1', pIdx: 0, off: 4, len: 4 }]);
  assert.deepEqual(drawn.places.flagged, []);
  assert.deepEqual([...drawn.found.keys()].sort(), ['m-aaaa1', 'm-aaaa2', 'm-aaaa3']);
  assert.deepEqual(drawn.stale, []);
});

test('a mark whose quote is gone is stale, not drawn, and still listed', () => {
  const marks = [mark('m-aaaa1', { pIdx: 1, off: 5, len: 7 })];
  const drawn = drawChapter('c1', marks, [text[0], 'Mara counts the boats twice.']);
  assert.deepEqual(drawn.places.comment, []);
  assert.deepEqual(drawn.stale, ['m-aaaa1']);
  assert.deepEqual(orderForList(marks, drawn).map((m) => m.id), ['m-aaaa1']);
});

test('the list follows the page, with stale marks at their old place', () => {
  const marks = [
    mark('m-late1', { pIdx: 1, off: 17, len: 5 }),
    mark('m-gone1', { pIdx: 1, off: 0, len: 4 }),
    mark('m-first', { pIdx: 0, off: 0, len: 3 }),
  ];
  const page = [text[0], 'Ana counted the boats twice.'];
  assert.deepEqual(orderForList(marks, drawChapter('c1', marks, page)).map((m) => m.id), ['m-first', 'm-gone1', 'm-late1']);
});

test('the caret is in the smallest drawn mark around it, at either edge, and in none outside', () => {
  const marks = [mark('m-wide1', { pIdx: 1, off: 0, len: 0 }), mark('m-narro', { pIdx: 1, off: 5, len: 7 })];
  const drawn = drawChapter('c1', marks, text);
  assert.equal(markAt(drawn, marks, { chId: 'c1', pIdx: 1, off: 6, len: 0 }), 'm-narro');
  assert.equal(markAt(drawn, marks, { chId: 'c1', pIdx: 1, off: 5, len: 0 }), 'm-narro');
  assert.equal(markAt(drawn, marks, { chId: 'c1', pIdx: 1, off: 12, len: 0 }), 'm-narro');
  assert.equal(markAt(drawn, marks, { chId: 'c1', pIdx: 1, off: 20, len: 0 }), 'm-wide1');
  assert.equal(markAt(drawn, marks, { chId: 'c1', pIdx: 0, off: 3, len: 0 }), null);
  const resolved = [transition(marks[1], 'resolved', 'author', at)];
  assert.equal(markAt(drawChapter('c1', resolved, text), resolved, { chId: 'c1', pIdx: 1, off: 6, len: 0 }), null, 'a closed mark is not under the caret');
});

// Rule: a card names what its mark is about in words: a note quotes its words, and a
// suggestion says the change it asks for.
test('a card names a note by its quote and a suggestion by its change', () => {
  assert.equal(label(mark('m-l1', { pIdx: 0, off: 4, len: 4 })), '“tide”');
  assert.equal(label(newMark({ id: 'm-l2', kind: 'deletion', anchor: anchorAt(text, { pIdx: 0, off: 4, len: 4 }), who: 'author', at })), 'Delete “tide”');
  assert.equal(label(newMark({ id: 'm-l3', kind: 'insertion', anchor: anchorPoint(text, { pIdx: 0, off: 4 }), proposed: 'evening ', who: 'author', at })), 'Insert “evening ”');
  assert.equal(label(newMark({ id: 'm-l4', kind: 'substitution', anchor: anchorAt(text, { pIdx: 0, off: 4, len: 4 }), proposed: 'sea', who: 'author', at })), 'Replace “tide” with “sea”');
});

test('an insertion that is found is listed where it is, though there are no words to draw', () => {
  const ins = newMark({ id: 'm-l5', kind: 'insertion', anchor: anchorPoint(text, { pIdx: 1, off: 4 }), proposed: ',', who: 'author', at });
  const drawn = drawChapter('c1', [ins], text);
  assert.deepEqual(drawn.found.get('m-l5'), { pIdx: 1, off: 4, len: 0 });
  assert.deepEqual(drawn.stale, []);
  assert.deepEqual(drawn.places.suggestion, []);
});
