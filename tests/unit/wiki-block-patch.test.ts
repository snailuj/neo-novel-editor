// Rules:
// Block-Patch-Keeps-Untouched-Bytes: a block patch changes the bytes of the blocks the
//   writer touched and of no other, and is refused when a touched block is not as it was
//   when the pane read the page.
// Join-Keeps-Both-Ids: the ids of a block an edit removed go to the nearest block above
//   still there (below when none is), as aliases; a block with words joined into an empty
//   one brings its own id, and the empty one's id becomes the alias. Only ids the page has
//   on disk are kept as aliases.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockKeys, joinedIds, patchBlocks, type NowBlock, type Was } from '../../src/hoard/wiki/edit.ts';

const PAGE = '<p class="wiki-h1" data-block="h">Vell</p><p  data-block="a" style="x">One &amp; two.</p><p data-block="b">Three.</p>';
const keep = (key: string): NowBlock => ({ key, id: key, alias: '', open: '', inner: '', touched: false });
const touch = (key: string, inner: string, alias = '', id = key): NowBlock => ({ key, id, alias, open: '', inner, touched: true });
const made = (id: string, inner: string): NowBlock => ({ key: null, id, alias: '', open: '<p>', inner, touched: true });

test('untouched blocks keep their bytes, a touched one keeps its opening tag, a made one is written', () => {
  const after = patchBlocks(PAGE, [keep('h'), touch('a', 'One'), made('c', ' &amp; two.'), keep('b')]);
  assert.equal(after, '<p class="wiki-h1" data-block="h">Vell</p><p  data-block="a" style="x">One</p><p data-block="c"> &amp; two.</p><p data-block="b">Three.</p>');
});

test('an untouched block keeps bytes the browser would write otherwise', () => {
  assert.equal(patchBlocks(PAGE, [keep('h'), keep('a'), touch('b', 'Four.')]), PAGE.replace('Three.', 'Four.'));
});

test('a block the pane no longer holds is gone, and an empty one is a break', () => {
  assert.equal(patchBlocks(PAGE, [keep('h'), touch('b', '')]), '<p class="wiki-h1" data-block="h">Vell</p><p data-block="b"><br></p>');
});

test('a touched block takes the pane\'s aliases and id into its stored opening tag', () => {
  assert.equal(patchBlocks(PAGE, [keep('h'), touch('a', 'One &amp; two. Three.', 'b')]),
    '<p class="wiki-h1" data-block="h">Vell</p><p  data-block="a" style="x" data-alias="b">One &amp; two. Three.</p>');
  const aliased = '<p data-alias="x y" data-block="a">One.</p>';
  assert.equal(patchBlocks(aliased, [touch('a', 'One.', '')]), '<p data-block="a">One.</p>');
  assert.equal(patchBlocks(aliased, [touch('a', 'One.', 'x y z')]), '<p data-alias="x y z" data-block="a">One.</p>');
  // a block that took the id of the block joined into it
  assert.equal(patchBlocks(aliased, [touch('a', 'Two.', 'x y a', 'q')]), '<p data-alias="x y a" data-block="q">Two.</p>');
});

test('a touched block that changed since the pane read the page is refused, an untouched one is taken as it is now', () => {
  const now = PAGE.replace('Three.', 'Four.');
  assert.equal(patchBlocks(now, [keep('h'), touch('a', 'One'), keep('b')], PAGE)?.endsWith('<p data-block="b">Four.</p>'), true);
  assert.equal(patchBlocks(now, [keep('h'), keep('a'), touch('b', 'Five.')], PAGE), null);
  // a block the pane still holds that is gone from the page now
  assert.equal(patchBlocks(PAGE.replace('<p data-block="b">Three.</p>', ''), [keep('h'), keep('a'), keep('b')], PAGE), null);
});

test('a repeated id is addressed by its turn and a block with none by its place', () => {
  const page = '<p data-block="x">1</p><p data-block="x">2</p><p>3</p>';
  assert.deepEqual(blockKeys(page), ['x', 'x#1', '@2']);
  assert.equal(patchBlocks(page, [keep('x'), touch('x#1', 'two', '', 'x'), touch('@2', 'three', '', '')]), '<p data-block="x">1</p><p data-block="x">two</p><p>three</p>');
  assert.equal(patchBlocks(page, [keep('x'), keep('x#1'), touch('@2', 'three', '', '')], page.replace('1', 'one')), null);
});

test('text between blocks the pane cannot place refuses the patch', () => {
  assert.equal(patchBlocks('<p data-block="a">1</p>\n<p data-block="b">2</p>', [keep('a'), keep('b')]), null);
});

const was = (id: string, live: boolean, empty = false, alias: string[] = []): Was => ({ id, alias, empty, live });
const ON_DISK = new Set(['a', 'b', 'c', 'd', 'x']);

test('Join-Keeps-Both-Ids: a joined block\'s id and aliases go to the block above as aliases', () => {
  const got = joinedIds([was('a', true), was('b', false, false, ['x'])], ON_DISK);
  assert.deepEqual([...got], [[0, { id: 'a', alias: ['b', 'x'] }]]);
});

test('Join-Keeps-Both-Ids: blocks removed together all go to the survivor above, and the first block\'s to the one below', () => {
  assert.deepEqual([...joinedIds([was('a', true, false, ['x']), was('b', false), was('c', false), was('d', true)], ON_DISK)],
    [[0, { id: 'a', alias: ['x', 'b', 'c'] }]]);
  assert.deepEqual([...joinedIds([was('a', false), was('b', true)], ON_DISK)], [[1, { id: 'b', alias: ['a'] }]]);
});

test('Join-Keeps-Both-Ids: words joined into an empty block keep their own id', () => {
  assert.deepEqual([...joinedIds([was('a', true, true), was('b', false, false, ['x'])], ON_DISK)], [[0, { id: 'b', alias: ['x', 'a'] }]]);
  // an empty block removed into words leaves the words' id alone
  assert.deepEqual([...joinedIds([was('a', true), was('b', false, true)], ON_DISK)], [[0, { id: 'a', alias: ['b'] }]]);
});

test('Join-Keeps-Both-Ids: an id never saved is not kept as an alias, and nothing goes when nothing is removed', () => {
  assert.deepEqual([...joinedIds([was('a', true), was('f00ba4', false)], ON_DISK)], [[0, { id: 'a', alias: [] }]]);
  assert.deepEqual([...joinedIds([was('a', true), was('b', true)], ON_DISK)], []);
  assert.deepEqual([...joinedIds([was('a', false)], ON_DISK)], []);
});
