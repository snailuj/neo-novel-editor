// Rules for links on the page: every [[link]] in a paragraph is found where it stands,
// code and embeds aside, and is a link to a page when its target names one, by the key
// Obsidian resolves with (case, a path and .md set aside; never an alias).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkAt, linksIn, pageIndex } from '../../src/hoard/wiki/links.ts';

test('links are found where they stand, with their targets; code and embeds are not links', () => {
  const found = linksIn(['See [[Harbour]] and [[lore/Tide Tables#High|tides]].', 'Code `[[Not]]` here, ![[map.png]] too.', '[[Fox]]']);
  assert.deepEqual(found, [
    { pIdx: 0, off: 4, len: 11, target: 'Harbour' },
    { pIdx: 0, off: 20, len: 31, target: 'lore/Tide Tables' },
    { pIdx: 2, off: 0, len: 7, target: 'Fox' },
  ]);
});

test('a link is under the caret from its first bracket to its last', () => {
  const text = 'See [[Harbour]] now.';
  assert.equal(linkAt(text, 3), null);
  assert.equal(linkAt(text, 4), 'Harbour');
  assert.equal(linkAt(text, 15), 'Harbour');
  assert.equal(linkAt(text, 16), null);
});

test('a target finds its page by title, whatever its case, path or .md; an alias finds nothing', () => {
  const index = pageIndex([{ chId: 'c1', title: 'Tide Tables' }, { chId: 'c2', title: 'Harbour' }]);
  assert.equal(index.get('lore/tide tables.md'), 'c1');
  assert.equal(index.get('HARBOUR'), 'c2');
  assert.equal(index.get('Tides'), undefined);
});
