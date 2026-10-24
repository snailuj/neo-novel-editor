// Rule: the librarian accepts the writer's suggestion on its page unless applying it
// would go wrong, and then it flags it with a reason: the words it changes are gone,
// another suggestion still waiting changes the same words, or the change leaves a
// [[link]] that names no page where the words before it had none. An accepted
// suggestion carries the span it changes now, and the text it expects there.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mark, MarkKind, MarkState } from '../../src/generated/hoard-marks-v1.js';
import { anchorAt, anchorPoint } from '../../src/hoard/marks/anchor.ts';
import { newMark, transition } from '../../src/hoard/marks/model.ts';
import { reviewSuggestion } from '../../src/hoard/review/rules.ts';
import { pageIndex } from '../../src/hoard/wiki/links.ts';

const at = '2026-10-15T21:00:00.000Z';
const PAGE = ['The harbour of Vell faces west.', 'Its keeper is [[Orrin]], who rows at dawn.'];
const pages = pageIndex([{ chId: 'ch-orrin', title: 'Orrin' }, { chId: 'ch-vell', title: 'Vell' }]);
let n = 0;

function suggest(kind: MarkKind, words: string, proposed?: string, pIdx = 0, paragraphs = PAGE, state: MarkState = 'open'): Mark {
  const text = paragraphs[pIdx];
  const off = text.indexOf(words);
  assert.notEqual(off, -1, `${words} is in paragraph ${pIdx}`);
  const anchor = kind === 'insertion' ? anchorPoint(paragraphs, { pIdx, off }) : anchorAt(paragraphs, { pIdx, off, len: words.length });
  let mark = newMark({ id: `m-test${++n}`, kind, anchor, proposed, who: 'author', at });
  if (state !== 'open') mark = transition(mark, state, 'librarian', at);
  return mark;
}

test('a clean change is accepted, with the span and the words it replaces', () => {
  const mark = suggest('substitution', 'west', 'the west');
  const review = reviewSuggestion(mark, [mark], PAGE, pages);
  assert.deepEqual(review, { verdict: 'accept', place: { pIdx: 0, off: 26, len: 4 }, expected: 'west', text: 'the west' });
  const del = suggest('deletion', ' at dawn', undefined, 1);
  assert.deepEqual(reviewSuggestion(del, [del], PAGE, pages), { verdict: 'accept', place: { pIdx: 1, off: 33, len: 8 }, expected: ' at dawn', text: '' });
  const ins = suggest('insertion', 'faces', 'still ');
  assert.deepEqual(reviewSuggestion(ins, [ins], PAGE, pages), { verdict: 'accept', place: { pIdx: 0, off: 20, len: 0 }, expected: '', text: 'still ' });
});

test('a suggestion whose words are gone is flagged, never applied elsewhere', () => {
  const mark = suggest('substitution', 'west', 'east');
  const now = ['The harbour of Vell faces north.', PAGE[1]];
  const review = reviewSuggestion(mark, [mark], now, pages);
  assert.equal(review.verdict, 'flag');
  assert.match(review.verdict === 'flag' ? review.reason : '', /no longer on the page/);
});

test('a suggestion over words another waiting suggestion changes is flagged', () => {
  const first = suggest('substitution', 'faces west', 'looks west');
  const second = suggest('deletion', 'west');
  const flagged = reviewSuggestion(second, [first, second], PAGE, pages);
  assert.equal(flagged.verdict, 'flag');
  assert.match(flagged.verdict === 'flag' ? flagged.reason : '', /Another suggestion/);
  // an insertion inside the other's words overlaps; one at its edge does not
  const inside = suggest('insertion', 'west', 'far ');
  assert.equal(reviewSuggestion(inside, [first, inside], PAGE, pages).verdict, 'flag');
  const edge = suggest('insertion', ' faces', ',');
  assert.equal(reviewSuggestion(edge, [first, edge], PAGE, pages).verdict, 'accept');
  // two insertions at one point overlap
  const again = suggest('insertion', ' faces', ' still');
  assert.equal(reviewSuggestion(again, [edge, again], PAGE, pages).verdict, 'flag');
});

test('a closed suggestion, a comment or a stale suggestion never blocks another', () => {
  const second = suggest('deletion', 'west');
  const done = ['accepted', 'rejected'] as const;
  for (const state of done) {
    const other = suggest('substitution', 'faces west', 'looks west', 0, PAGE, state);
    assert.equal(reviewSuggestion(second, [other, second], PAGE, pages).verdict, 'accept', state);
  }
  const comment = newMark({ id: 'm-comment1', kind: 'comment', anchor: anchorAt(PAGE, { pIdx: 0, off: 20, len: 10 }), body: 'Why west?', who: 'author', at });
  assert.equal(reviewSuggestion(second, [comment, second], PAGE, pages).verdict, 'accept');
  const gone = suggest('substitution', 'faces west', 'looks west');
  gone.anchor.exact = 'faces south';
  assert.equal(reviewSuggestion(second, [gone, second], PAGE, pages).verdict, 'accept');
  // a flagged one still waits, so it blocks
  const waiting = suggest('substitution', 'faces west', 'looks west', 0, PAGE, 'flagged');
  assert.equal(reviewSuggestion(second, [waiting, second], PAGE, pages).verdict, 'flag');
});

test('a change that leaves a link naming no page is flagged; one already missing is not', () => {
  const broken = suggest('substitution', 'Orrin', 'Orin', 1);
  const review = reviewSuggestion(broken, [broken], PAGE, pages);
  assert.equal(review.verdict, 'flag');
  assert.match(review.verdict === 'flag' ? review.reason : '', /\[\[Orin\]\] names no wiki page/);
  const added = suggest('insertion', 'faces', 'by [[Nowhere]] ');
  assert.equal(reviewSuggestion(added, [added], PAGE, pages).verdict, 'flag');
  const linked = suggest('substitution', 'Vell', '[[Vell]]');
  assert.equal(reviewSuggestion(linked, [linked], PAGE, pages).verdict, 'accept');
  const page = ['See [[Lost]] for more.'];
  const near = suggest('substitution', 'more', 'the rest', 0, page);
  assert.equal(reviewSuggestion(near, [near], page, pages).verdict, 'accept');
});

test('only suggestions are reviewed', () => {
  const comment = newMark({ id: 'm-comment2', kind: 'comment', anchor: anchorAt(PAGE, { pIdx: 0, off: 0, len: 3 }), body: 'Hm', who: 'author', at });
  assert.throws(() => reviewSuggestion(comment, [comment], PAGE, pages), RangeError);
  const done = suggest('deletion', 'west', undefined, 0, PAGE, 'accepted');
  assert.throws(() => reviewSuggestion(done, [done], PAGE, pages), RangeError);
});
