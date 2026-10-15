// Rules for the wiki pages a chapter's new paragraphs name, ported from hoard's companion
// extract: a page's title or alias as a whole phrase, any case, hyphens and spaces alike,
// three letters at least; a [[link]] the writer typed is never a mention, nor code; the
// longest match wins; one mention per page, its first in the chapter. NEO's own typing
// adds two folds hoard did not need: a curly apostrophe is a straight one, and a
// no-break space is a space.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mentionsIn, type WikiPage } from '../../src/hoard/companion/mentions.ts';

const page = (id: string, title: string, aliases: string[] = []): WikiPage => ({ id, title, aliases, pantsing: false });
const pages = [
  page('p1', 'Kraken'),
  page('p2', 'Gull-Clan', ['the Gulls']),
  page('p3', 'Fox'),
  page('p4', 'Fox-Den'),
  page('p5', "Ana'la"),
  page('p6', 'Ox'),
  page('p7', 'Café'),
];
const found = (paragraphs: string[], which = paragraphs.map((_, i) => i), from = pages) =>
  mentionsIn(paragraphs, which, from).map((m) => [m.page.id, m.pIdx, m.off, m.text]);

test('a title as a whole phrase, any case, at the words as written', () => {
  assert.deepEqual(found(['Then the KRAKEN rose.']), [['p1', 0, 9, 'KRAKEN']]);
});

test('a word that holds a title inside it is not a mention', () => {
  assert.deepEqual(found(['Krakens and foxes, outfoxed, a subkraken.']), []);
});

test('an alias names its page', () => {
  assert.deepEqual(found(['Ask the gulls.']), [['p2', 0, 4, 'the gulls']]);
});

test('hyphens and spaces fold together, but the whole name must be there', () => {
  assert.deepEqual(found(['The Gull Clan sailed.', 'A gull-clan boat.']), [['p2', 0, 4, 'Gull Clan']]);
  assert.deepEqual(found(['A gull, a clan.']), []);
});

test('the longest match wins, so a name inside a longer one is not also found', () => {
  assert.deepEqual(found(['The Fox-Den met.']), [['p4', 0, 4, 'Fox-Den']]);
  assert.deepEqual(found(['The Fox-Den met.', 'A fox ran.']), [['p4', 0, 4, 'Fox-Den'], ['p3', 1, 2, 'fox']]);
});

test('a typed link is never a mention, target or display words', () => {
  assert.deepEqual(found(['[[Kraken]] and [[Fox-Den|the fox]] and [[Kraken#^b1|it]].']), []);
});

test('a page linked once is still found where it is named bare', () => {
  assert.deepEqual(found(['[[Kraken]] rose.', 'The kraken sank.']), [['p1', 1, 4, 'kraken']]);
});

test('code is not prose', () => {
  assert.deepEqual(found(['Run `kraken --help` now.']), []);
});

test('three letters are enough, two are not', () => {
  assert.deepEqual(found(['A fox and an ox.']), [['p3', 0, 2, 'fox']]);
});

test('accents are not folded', () => {
  assert.deepEqual(found(['A cafe, then the Café.']), [['p7', 0, 17, 'Café']]);
});

test('a curly apostrophe matches a straight one, and a no-break space a space', () => {
  assert.deepEqual(found(['Ana’la waved.', 'The Gull Clan.']), [['p5', 0, 0, 'Ana’la'], ['p2', 1, 4, 'Gull Clan']]);
});

test('a dotted capital I neither hides a page nor moves the words after it', () => {
  const istanbul = [page('i1', 'İzmir'), page('i2', 'Kraken'), page('i3', 'Istanbul')];
  assert.deepEqual(found(['İZMİR and the Kraken.'], [0], istanbul), [['i1', 0, 0, 'İZMİR'], ['i2', 0, 14, 'Kraken']]);
  assert.deepEqual(found(['izmir by İstanbul.'], [0], istanbul), [['i1', 0, 0, 'izmir'], ['i3', 0, 9, 'İstanbul']]);
});

test('a name ending in a separator is left out, since it would match the name beside it', () => {
  assert.deepEqual(found(['A fox.'], [0], [page('x', 'Fox-')]), []);
});

test('only the paragraphs asked about are read, and each page once, at its first mention', () => {
  assert.deepEqual(found(['Kraken.', 'The kraken, the Kraken.', 'Kraken!'], [1, 2]), [['p1', 1, 4, 'kraken']]);
});

test('of two pages with one name the first is kept, and a title beats another page\'s alias', () => {
  const two = [page('a', 'Harbour', ['Port']), page('b', 'harbour'), page('c', 'Port')];
  assert.deepEqual(found(['The harbour, the port.'], [0], two), [['a', 0, 4, 'harbour'], ['c', 0, 17, 'port']]);
});
