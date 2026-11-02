// Rules for the page library ripple reads (ripple/library.ts):
// - a page under sources/ is the author's whatever the owner reader says, and a wiki page
//   whose owner cannot be read is the author's too, with the reason logged;
// - candidates come from both trees, and a wiki page wins a title clash with a source,
//   in a [[link]] and in a name a judge gives;
// - a page is named by its id, so the same title in two trees is two corpus entries;
// - aliases come from the page sidecar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findPage, pagesCorpus, pageText, readLibrary } from '../../src/hoard/ripple/library.ts';
import type { OwnerOf } from '../../src/hoard/ripple/ports.ts';
import { pagesLibrary } from './pages-support.ts';

const sidecar = (frontmatter: unknown) => JSON.stringify({
  version: 1, source: { path: '/v/x.md', name: 'x', sha256: 'a'.repeat(64) }, frontmatter, imported: '2026-11-01T12:00:00.000Z',
});

function fixture(t: { after(fn: () => void): void }, ownerOf: OwnerOf = async () => 'librarian') {
  const lib = pagesLibrary(t);
  lib.put('wiki/Harbour.html', '<p data-block="a1">The wall is timber.</p><p data-block="a2">Boats come in.</p>');
  lib.put('wiki/People/Keeper.html', '<p data-block="b1">The keeper lives in the [[Lighthouse]].</p>');
  lib.put('sources/Harbour.html', '<p data-block="c1">Field notes on the harbour.</p>');
  lib.put('sources/Notes/Lighthouse.html', '<p data-block="d1">The tower is tall.</p>');
  lib.put('.neo/pages/wiki/People/Keeper.html.json', sidecar({ aliases: ['The Keeper', 'Warden'] }));
  const read = () => readLibrary({ root: lib.library, store: lib.store, ownerOf, log: lib.log });
  return { ...lib, read };
}

test('a page under sources/ is the author\'s whatever the owner reader says', async (t) => {
  const { read } = fixture(t);
  const pages = await read();
  assert.deepEqual(pages.pages.map((p) => [p.id, p.tree, p.owner]), [
    ['sources/Harbour.html', 'sources', 'author'],
    ['sources/Notes/Lighthouse.html', 'sources', 'author'],
    ['wiki/Harbour.html', 'wiki', 'librarian'],
    ['wiki/People/Keeper.html', 'wiki', 'librarian'],
  ]);
});

test('a wiki page whose owner cannot be read is the author\'s, and the log says why', async (t) => {
  const { read, logged } = fixture(t, async () => { throw new Error('sidecar torn'); });
  const pages = await read();
  assert.ok(pages.pages.every((p) => p.owner === 'author'));
  assert.equal(logged('ripple: a page\'s owner does not read, so the page is the author\'s').length, 2);
});

test('a page carries its title, its words and the aliases its sidecar names', async (t) => {
  const { read } = fixture(t);
  const keeper = (await read()).pages.find((p) => p.id === 'wiki/People/Keeper.html')!;
  assert.deepEqual([keeper.title, keeper.text, keeper.aliases], ['Keeper', 'The keeper lives in the [[Lighthouse]].', ['The Keeper', 'Warden']]);
  assert.equal(pageText('<p>One</p><p><br></p><p>Two</p>'), 'One\n\nTwo');
});

test('a wiki page wins a title clash with a source, by title, by alias and by id', async (t) => {
  const { read } = fixture(t);
  const library = await read();
  assert.equal(findPage(library, 'Harbour')?.id, 'wiki/Harbour.html');
  assert.equal(findPage(library, '[[harbour|the port]]')?.id, 'wiki/Harbour.html');
  assert.equal(findPage(library, 'Lighthouse')?.id, 'sources/Notes/Lighthouse.html', 'a title only a source holds');
  assert.equal(findPage(library, 'warden')?.id, 'wiki/People/Keeper.html');
  assert.equal(findPage(library, 'sources/Harbour.html')?.id, 'sources/Harbour.html', 'an id names its page when titles clash');
  assert.equal(findPage(library, 'Nowhere'), null);
});

test('candidates come from both trees, keyed by page id, and a link resolves to the wiki page', async (t) => {
  const { read } = fixture(t);
  const { corpus, byPath } = pagesCorpus(await read());
  assert.deepEqual([...byPath.values()].map((p) => p.id).sort(), [
    'sources/Harbour.html', 'sources/Notes/Lighthouse.html', 'wiki/Harbour.html', 'wiki/People/Keeper.html',
  ]);
  assert.equal(corpus.docs.length, 4, 'two pages called Harbour are two entries');
  assert.equal(byPath.get(corpus.index.resolveAny('Harbour')!.relpath)?.id, 'wiki/Harbour.html');
  assert.equal(byPath.get(corpus.index.resolveAny('Warden')!.relpath)?.id, 'wiki/People/Keeper.html');
});
