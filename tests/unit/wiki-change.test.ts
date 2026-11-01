// Rule: typing in the Wiki pane is saved as one change per paragraph: the shortest span
// of what the paragraph read that, written over with the new words, makes what it reads
// now. A span never cuts a character outside the Basic Multilingual Plane in two.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textChange } from '../../src/hoard/wiki/change.ts';

const apply = (was: string, c: { off: number; len: number; text: string }) => was.slice(0, c.off) + c.text + was.slice(c.off + c.len);

test('nothing changed is no change', () => {
  assert.equal(textChange('The harbour', 'The harbour'), null);
  assert.equal(textChange('', ''), null);
});

test('words typed, taken out or written over are the span that differs', () => {
  assert.deepEqual(textChange('The harbour', 'The old harbour'), { off: 4, len: 0, expected: '', text: 'old ' });
  assert.deepEqual(textChange('The old harbour', 'The harbour'), { off: 4, len: 4, expected: 'old ', text: '' });
  assert.deepEqual(textChange('The red door', 'The blue door'), { off: 4, len: 3, expected: 'red', text: 'blue' });
  assert.deepEqual(textChange('', 'New'), { off: 0, len: 0, expected: '', text: 'New' });
  assert.deepEqual(textChange('Gone', ''), { off: 0, len: 4, expected: 'Gone', text: '' });
});

test('a repeated letter is counted once, from the front', () => {
  assert.deepEqual(textChange('aa', 'aaa'), { off: 2, len: 0, expected: '', text: 'a' });
  assert.deepEqual(textChange('abab', 'ab'), { off: 2, len: 2, expected: 'ab', text: '' });
});

test('a span never cuts a surrogate pair', () => {
  // two emoji that share their high surrogate
  const a = '\u{1F600}';
  const b = '\u{1F601}';
  const c = textChange(`x${a}y`, `x${b}y`)!;
  assert.deepEqual(c, { off: 1, len: 2, expected: a, text: b });
  // two that share their low surrogate
  const d = '\u{10000}';
  const e = '\u{10400}';
  assert.deepEqual(textChange(`${d}z`, `${e}z`), { off: 0, len: 2, expected: d, text: e });
  for (const [was, now] of [[`${a}`, `${b}`], [`${a}${a}`, `${a}${b}`], [`${b}z`, `${a}z`], ['q', `q${a}`], [`${d}${d}`, `${e}${d}`]]) {
    const got = textChange(was, now)!;
    assert.equal(apply(was, got), now, `${was} -> ${now}`);
    assert.equal(was.slice(got.off, got.off + got.len), got.expected);
    assert.ok(got.expected.isWellFormed() && got.text.isWellFormed(), JSON.stringify(got));
  }
});

test('whatever the two texts, the change makes one from the other', () => {
  const pieces = ['a', 'b', ' ', '\u{1F600}', '\u{1F601}', 'é'];
  const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => pieces[(seed * 7 + i * 3 + (seed >> i)) % pieces.length]).join('');
  for (let s = 0; s < 400; s++) {
    const was = words(s % 6, s);
    const now = words((s >> 2) % 7, s + 13);
    const c = textChange(was, now);
    if (was === now) { assert.equal(c, null); continue; }
    assert.ok(c);
    assert.equal(apply(was, c), now, `${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
    assert.equal(was.slice(c.off, c.off + c.len), c.expected);
    assert.ok(c.expected.isWellFormed() && c.text.isWellFormed(), JSON.stringify({ was, now, c }));
  }
});
