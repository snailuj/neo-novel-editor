// Rule: a search finds the words however they were typed (capitals, accents, curly or
// straight quotes, extra spaces) and the place it gives back is the words as written,
// so selecting it selects exactly them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold, foldQuery, originalSpan } from '../../src/hoard/search/fold.ts';

const find = (text: string, query: string) => {
  const f = fold(text);
  const q = foldQuery(query);
  const a = f.text.indexOf(q);
  if (a < 0) return null;
  const { off, len } = originalSpan(text, f.at, a, a + q.length);
  return text.slice(off, off + len);
};

test('plain lower-case text folds to itself, with no map', () => {
  const f = fold('the quay at dawn');
  assert.equal(f.text, 'the quay at dawn');
  assert.equal(f.at, null);
});

test('capitals and accents fold, and an accented letter keeps its place', () => {
  const f = fold('Ștefan Café');
  assert.equal(f.text, 'stefan cafe');
  assert.equal(f.at, null);
  assert.equal(find('Ștefan Café, then', 'cafe'), 'Café');
});

test('curly quotes and apostrophes match straight ones, both ways', () => {
  assert.equal(find('It was Ana’s “boat”.', 'ana\'s "boat"'), 'Ana’s “boat”');
  assert.equal(find('Ana\'s boat', 'Ana’s'), 'Ana\'s');
});

test('a run of white space is one space, and the query is trimmed', () => {
  assert.equal(find('the  old \tquay', '  old quay '), 'old \tquay');
  assert.equal(find('the old  quay', 'the old quay'), 'the old  quay');
});

test('a character that folds to two takes its whole self when a match ends inside it', () => {
  assert.equal(fold('ﬁsh').text, 'fish');
  assert.equal(find('a ﬁsh', 'a f'), 'a ﬁ');
  assert.equal(find('a ﬁsh', 'ish'), 'ﬁsh');
});

test('characters outside the basic plane keep both halves', () => {
  assert.equal(find('x 𝒜b y', '𝒜b'), '𝒜b');
  assert.equal(find('x 😀 Ab y', 'ab'), 'Ab');
  assert.equal(find('x  𝒜 y', 'x 𝒜'), 'x  𝒜');
});

test('a query of only white space is empty', () => {
  assert.equal(foldQuery(' \t\u00a0 '), '');
});
