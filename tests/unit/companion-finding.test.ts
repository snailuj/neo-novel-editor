// Rules for what the librarian says about a page a chapter names, ported from hoard's
// companion note: the page as a link, marked as a guess and never as a link the writer
// typed; a pantsing page as an offering from the pantsing shelf; never advice, never
// continuity, never an em dash. And which pages a chapter has already been told about:
// those its librarian comments link to, whatever state they are in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { findingWords, reported } from '../../src/hoard/companion/finding.ts';
import type { Mention, WikiPage } from '../../src/hoard/companion/mentions.ts';

const page = (id: string, title: string, pantsing = false): WikiPage => ({ id, title, aliases: [], pantsing });
const mention = (p: WikiPage, text: string): Mention => ({ page: p, pIdx: 0, off: 0, len: text.length, text });

test('the page as a link, marked as a guess', () => {
  assert.equal(findingWords(mention(page('p', 'Kraken'), 'Kraken')),
    '[[Kraken]]: matched as a bare name in your prose (a guess, not a link you typed).');
});

test('the writer\'s own casing when only case differs; the words written as display text otherwise', () => {
  assert.match(findingWords(mention(page('p', 'Kraken'), 'KRAKEN')), /^\[\[KRAKEN\]\]:/);
  assert.match(findingWords(mention(page('p', 'Gull-Clan'), 'the gulls')), /^\[\[Gull-Clan\|the gulls\]\]:/);
  assert.match(findingWords(mention(page('p', "Ana'la"), 'Ana’la')), /^\[\[Ana'la\|Ana’la\]\]:/);
});

test('a pantsing page is an offering from the pantsing shelf', () => {
  assert.equal(findingWords(mention(page('p', 'Whatif Dolphins', true), 'Whatif Dolphins')),
    '[[Whatif Dolphins]]: an offering from the pantsing shelf; matched as a bare name in your prose (a guess, not a link you typed).');
});

test('never advice, never continuity, never an em dash', () => {
  for (const pantsing of [false, true]) {
    const words = findingWords(mention(page('p', 'Kraken', pantsing), 'Kraken')).toLowerCase();
    for (const banned of ['should', 'consider', 'suggest', 'recommend', 'ought', 'need to', 'continuity', '—']) {
      assert.ok(!words.includes(banned), banned);
    }
  }
});

const mark = (id: string, who: 'author' | 'librarian', body: string, state: Mark['state'] = 'open'): Mark => ({
  id, kind: 'comment', state,
  anchor: { exact: 'x', prefix: '', suffix: '', pIdx: 0, off: 0, commit: null },
  created: { who, at: '2026-10-15T00:00:00Z' },
  thread: [{ id: `${id}-0`, who, at: '2026-10-15T00:00:00Z', body }],
  history: [],
});

const GUESS = 'matched as a bare name in your prose (a guess, not a link you typed).';

test('a chapter has been told about the pages the librarian\'s findings link to, open or resolved, and no others', () => {
  const pages = [page('p1', 'Kraken'), page('p2', 'Gull-Clan'), page('p3', 'Fox')];
  const marks = [
    mark('m-aaaa1', 'librarian', `[[KRAKEN]]: ${GUESS}`),
    mark('m-aaaa2', 'librarian', `[[Gull-Clan|the gulls]]: ${GUESS}`, 'resolved'),
    mark('m-aaaa3', 'author', `[[Fox]]: ${GUESS}`),
    mark('m-aaaa4', 'librarian', '[[Fox]] says otherwise, so this is flagged.'),
  ];
  assert.deepEqual([...reported(marks, pages)].sort(), ['p1', 'p2']);
});

test('of two pages with one name the link tells about the first, as mentions finds it', () => {
  assert.deepEqual([...reported([mark('m-aaaa1', 'librarian', `[[kraken]]: ${GUESS}`)], [page('p1', 'Kraken'), page('p9', 'kraken')])], ['p1']);
});

test('a librarian comment linking to no page tells about none', () => {
  assert.deepEqual([...reported([mark('m-aaaa1', 'librarian', `[[Gone]]: ${GUESS}`)], [page('p1', 'Kraken')])], []);
});
