// Rule: before an import the writer is told, in words, what will come in and what will
// not and why, naming the pages; a long list names the first few and counts the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSort } from '../../src/hoard/wiki/summary.ts';
import type { Verdict } from '../../src/hoard/wiki/store.ts';
import { convertPage } from '../../src/hoard/wiki/convert.ts';

const v = (kind: Verdict['kind'], name: string, extra: object = {}) => ({ kind, name, path: `/v/${name}.md`, ...extra }) as Verdict;
const fresh = (name: string, text = 'x') => v('new', name, { sha256: 'a'.repeat(64), page: convertPage(text) });

test('the summary counts what comes in and names what does not, with why', () => {
  const s = describeSort({ verdicts: [
    fresh('Harbour', 'The {++grey ++}gulls.\nA {==bay==}{>>Which?<<}.'), fresh('Tide'),
    v('same', 'Fox'), v('changed', 'Owl'), v('clash', 'Hare'), v('unreadable', 'Bad', { why: 'malformed frontmatter: x' }),
  ] });
  assert.equal(s.count, 2);
  assert.equal(s.message, 'Import 2 pages into the wiki?');
  assert.equal(s.detail, [
    'Coming in: Harbour, Tide. Their 2 CriticMarkup marks become comments and suggestions.',
    'Already in the wiki: Fox.',
    'Not imported, because the file changed since it came in and the wiki page may hold newer words: Owl.',
    'Not imported, because a page of that name is already in the wiki or earlier in the list: Hare.',
    'Not read: Bad (malformed frontmatter: x).',
  ].join('\n\n'));
});

test('with nothing new the summary says so, and one page is one page', () => {
  assert.equal(describeSort({ verdicts: [v('same', 'Fox')] }).message, 'Every page picked is already in the wiki, or cannot come in.');
  assert.equal(describeSort({ verdicts: [fresh('One')] }).message, 'Import 1 page into the wiki?');
});

test('a long list names twelve and counts the rest', () => {
  const many = Array.from({ length: 15 }, (_, i) => v('same', `P${String(i).padStart(2, '0')}`));
  assert.match(describeSort({ verdicts: many }).detail, /^Already in the wiki: P00, .*, P11 and 3 more\.$/);
});
