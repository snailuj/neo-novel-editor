// Rules for which paragraphs of a chapter are new writing: a paragraph counts when its
// words were not in the chapter before, each copy counted, so a paragraph moved, or
// changed only in its formatting or white space, is not new. Empty paragraphs never
// count, and a chapter with no text before is new throughout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newParagraphs } from '../../src/hoard/companion/delta.ts';

test('nothing changed gives nothing', () => {
  assert.deepEqual(newParagraphs(['One.', 'Two.'], ['One.', 'Two.']), []);
});

test('a typed paragraph and an edited one are new, by their place in the text after', () => {
  assert.deepEqual(newParagraphs(['One.', 'Two.'], ['One.', 'Between.', 'Two, edited.']), [1, 2]);
});

test('white space alone is not a change', () => {
  assert.deepEqual(newParagraphs(['The  harbour wall.'], [' The harbour wall. ']), []);
});

test('a moved paragraph is not new', () => {
  assert.deepEqual(newParagraphs(['One.', 'Two.', 'Three.'], ['Three.', 'One.', 'Two.']), []);
});

test('each copy is counted, so a second copy of a paragraph is new', () => {
  assert.deepEqual(newParagraphs(['Again.'], ['Again.', 'Again.']), [1]);
});

test('a chapter with no text before is new throughout, its empty paragraphs aside', () => {
  assert.deepEqual(newParagraphs([], ['One.', '', '  ', 'Two.']), [0, 3]);
});
