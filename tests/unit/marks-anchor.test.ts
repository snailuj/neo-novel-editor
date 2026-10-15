// Rule: a mark finds its own words wherever they moved, and nothing else. It is found
// by its exact quote inside one paragraph, the context either side picks between
// copies of the quote, the place it was made breaks a full tie, and a quote that is
// gone finds nothing rather than something near it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorAt, locate } from '../../src/hoard/marks/anchor.ts';

const book = ['The tide came in at dusk.', 'Mara counted the boats twice.', 'Nobody spoke of the lighthouse.'];

test('a mark is found where it was made', () => {
  const anchor = anchorAt(book, { pIdx: 1, off: 5, len: 7 });
  assert.equal(anchor.exact, 'counted');
  assert.equal(anchor.prefix, 'The tide came in at dusk.\nMara ');
  assert.equal(anchor.suffix, ' the boats twice.\nNobody spoke o');
  assert.deepEqual(locate(book, anchor), { pIdx: 1, off: 5, len: 7 });
});

test('a place with no length anchors the whole paragraph', () => {
  const anchor = anchorAt(book, { pIdx: 2, off: 4, len: 0 });
  assert.equal(anchor.exact, book[2]);
  assert.deepEqual(locate(book, anchor), { pIdx: 2, off: 0, len: book[2].length });
});

test('context either side is cut at 32 units', () => {
  const long = ['x'.repeat(50) + 'mark' + 'y'.repeat(50)];
  const anchor = anchorAt(long, { pIdx: 0, off: 50, len: 4 });
  assert.equal(anchor.prefix, 'x'.repeat(32));
  assert.equal(anchor.suffix, 'y'.repeat(32));
});

test('a mark follows its words when paragraphs come before it and text grows around it', () => {
  const anchor = anchorAt(book, { pIdx: 1, off: 5, len: 7 });
  const edited = ['A new opening.', 'Another one.', book[0], 'Mara, tired, counted the boats twice.', book[2]];
  assert.deepEqual(locate(edited, anchor), { pIdx: 3, off: 13, len: 7 });
});

test('of two copies of the quote, the one whose context matches wins, whichever comes first', () => {
  const twice = ['She said yes at the door.', 'Later she said yes at the gate.'];
  const atGate = anchorAt(twice, { pIdx: 1, off: 15, len: 3 });
  const atDoor = anchorAt(twice, { pIdx: 0, off: 9, len: 3 });
  assert.deepEqual(locate(twice, atGate), { pIdx: 1, off: 15, len: 3 });
  assert.deepEqual(locate(twice, atDoor), { pIdx: 0, off: 9, len: 3 });
  // swapped round, each still finds its own
  const swapped = [twice[1], twice[0]];
  assert.deepEqual(locate(swapped, atGate), { pIdx: 0, off: 15, len: 3 });
  assert.deepEqual(locate(swapped, atDoor), { pIdx: 1, off: 9, len: 3 });
});

test('the context before the quote decides when the context after is the same', () => {
  const pair = ['At the door, yes. Then on.', 'At the gate, yes. Then on.'];
  const atGate = anchorAt(pair, { pIdx: 1, off: 13, len: 3 });
  assert.deepEqual(locate([pair[1], pair[0]], atGate), { pIdx: 0, off: 13, len: 3 });
});

test('a full tie goes to the copy nearest where the mark was made', () => {
  const same = ['Echo.', 'Echo.', 'Echo.'];
  for (const pIdx of [0, 1, 2]) {
    assert.deepEqual(locate(same, anchorAt(same, { pIdx, off: 0, len: 0 })), { pIdx, off: 0, len: 5 });
  }
  // the context is gone everywhere, so only the stored place can choose
  const anchor = { ...anchorAt(same, { pIdx: 2, off: 0, len: 4 }), prefix: 'zzz', suffix: 'qqq' };
  assert.deepEqual(locate(['Echo here.', 'Echo there.', 'Echo where.'], anchor), { pIdx: 2, off: 0, len: 4 });
});

test('a quote that is gone is found nowhere, even when something close is there', () => {
  const anchor = anchorAt(book, { pIdx: 1, off: 5, len: 7 });
  assert.equal(locate([book[0], 'Mara counts the boats twice.', book[2]], anchor), null);
  assert.equal(locate([], anchor), null);
});

test('a quote is never found across a paragraph boundary', () => {
  const anchor = { exact: 'dusk.Mara', prefix: '', suffix: '', pIdx: 0, off: 0, commit: null };
  assert.equal(locate(book, anchor), null);
  const joined = { exact: 'dusk.\nMara', prefix: '', suffix: '', pIdx: 0, off: 0, commit: null };
  assert.equal(locate(book, joined), null);
});

test('context never splits a surrogate pair', () => {
  const owl = ['🦉'.repeat(20) + 'hoot' + '🦉'.repeat(20)];
  const anchor = anchorAt(owl, { pIdx: 0, off: 40, len: 4 });
  assert.equal(anchor.prefix, '🦉'.repeat(16));
  assert.equal(anchor.suffix, '🦉'.repeat(16));
  // 32 units either side of the quote land inside an owl: the half owl is left out
  const odd = ['a' + '🦉'.repeat(20) + 'ehoot' + 'd' + '🦉'.repeat(16)];
  const cut = anchorAt(odd, { pIdx: 0, off: 42, len: 4 });
  assert.equal(cut.prefix, '🦉'.repeat(15) + 'e');
  assert.equal(cut.suffix, 'd' + '🦉'.repeat(15));
  assert.deepEqual(locate(odd, cut), { pIdx: 0, off: 42, len: 4 });
});

test('a place outside the text is refused', () => {
  assert.throws(() => anchorAt(book, { pIdx: 3, off: 0, len: 0 }), RangeError);
  assert.throws(() => anchorAt(book, { pIdx: 0, off: 20, len: 10 }), RangeError);
});
