// Rule: before an import the writer is told, in words, what will come in and what will
// not and why, naming the pages and the book they go into; a long list names the first
// few and counts the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeSort } from '../../src/hoard/wiki/summary.ts';
import type { Verdict } from '../../src/hoard/wiki/store.ts';
import { convertPage } from '../../src/hoard/wiki/convert.ts';

const v = (kind: Verdict['kind'], name: string, extra: object = {}) => ({ kind, name, path: `/v/${name}.md`, ...extra }) as Verdict;
const converted = (text: string, extra: object = {}) => ({ sha256: 'a'.repeat(64), page: convertPage(text), attachments: [], missing: [], ...extra });
const fresh = (name: string, text = 'x', extra: object = {}) => v('new', name, converted(text, extra));

test('the summary counts what comes in and names what does not, with why', () => {
  const s = describeSort({ verdicts: [
    fresh('Harbour', 'The {++grey ++}gulls.\nA {==bay==}{>>Which?<<}.', { attachments: [{ target: 'Map.png', file: '/v/Map.png' }], missing: ['Gone.png'] }),
    fresh('Tide', 'x', { attachments: [{ target: 'map.png', file: '/v/Map.png' }] }),
    v('update', 'Owl', { ...converted('y'), chId: 'ch-1' }), v('beside', 'Wren (source changed 2026-10-15)', { ...converted('z'), chId: 'ch-2' }),
    v('same', 'Fox'), v('through-hoard', 'Quay'), v('hoard-older', 'Bay'), v('clash', 'Hare'), v('unreadable', 'Bad', { why: 'malformed frontmatter: x' }),
  ] });
  assert.equal(s.count, 4);
  assert.equal(s.message, 'Import 4 pages into the wiki?');
  assert.equal(s.detail, [
    'Coming in: Harbour, Tide.',
    'Updated from a newer source, since NEO has not changed the page: Owl.',
    'Coming in beside its page, because the source and the page in NEO have both changed: Wren (source changed 2026-10-15).',
    '2 CriticMarkup marks become comments and suggestions.',
    '1 image or PDF the pages show is copied into the wiki.',
    'Not found beside the pages, so not copied: Gone.png.',
    'Already in the wiki: Fox.',
    'Already in hoard, so they come in with hoard\'s pages: Quay.',
    'Not imported, because hoard holds an older copy, which comes in with hoard\'s pages: Bay.',
    'Not imported, because a page of that name is already in the wiki or earlier in the list: Hare.',
    'Not read: Bad (malformed frontmatter: x).',
  ].join('\n\n'));
});

test('with nothing new the summary says so, and one page is one page', () => {
  assert.equal(describeSort({ verdicts: [v('same', 'Fox')] }).message, 'Every page picked is already in the wiki, or cannot come in.');
  assert.equal(describeSort({ verdicts: [fresh('One')] }).message, 'Import 1 page into the wiki?');
  assert.equal(describeSort({ verdicts: [fresh('2025-12-15')] }, 'Morning Pages').message, 'Import 1 page into Morning Pages?');
  assert.equal(describeSort({ verdicts: [v('same', 'Fox')] }, 'Morning Pages').detail, 'Already in Morning Pages: Fox.');
});

test('a long list names twelve and counts the rest', () => {
  const many = Array.from({ length: 15 }, (_, i) => v('same', `P${String(i).padStart(2, '0')}`));
  assert.match(describeSort({ verdicts: many }).detail, /^Already in the wiki: P00, .*, P11 and 3 more\.$/);
});
