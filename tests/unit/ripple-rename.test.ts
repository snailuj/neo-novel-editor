// Rule: only a rename's own link rewrites are ignored. A page rename rewrites [[links]] in
// other pages in the author's commit; ripple maps the old title to the new through the
// rename in the commit range, so those pages' words are the same and make no job. The
// renamed page itself is a new id and is judged again. An author retargeting a link to
// another page, or changing the words around a link or its shown text, is a change.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { PageStore } from '../../src/hoard/pages/store.ts';
import { Ripple } from '../../src/hoard/ripple/engine.ts';
import { wordsOf } from '../../src/hoard/ripple/reconcile.ts';
import { ownerOf } from '../../src/hoard/review/owner.ts';
import { isolateGitConfig, tempDir, tempLibrary } from './git-support.ts';

async function gitRipple(t: { after(fn: () => void): void }) {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const layer = new GitLayer({
    git: lib.git, library: lib.library, settings: resolveSettings({}, () => {}),
    attributesFile: path.join(tempDir(t), 'attributes'), textconv: { command: 'unused' }, log: () => {},
  });
  t.after(async () => { layer.stop(); await layer.drained(); });
  await layer.open();
  await layer.keepHistory();
  const store = new PageStore({ library: () => lib.library, layer, log: () => {} });
  const marks = new MarkStore({ library: () => lib.library, wrote: (n) => layer.wrote(n), log: () => {} });
  const ripple = new Ripple({ library: () => lib.library, pages: store, marks, ownerOf: (root, id) => ownerOf(root, id), layer, log: () => {} });
  return { ...lib, layer, store, ripple };
}

test('a rename that only rewrites link targets makes no job for the pages it touched', async (t) => {
  const { write, layer, store, ripple } = await gitRipple(t);
  write('wiki/Harbour.html', '<p data-block="a1">The wall is timber.</p>');
  write('wiki/Quay.html', '<p data-block="b1">The quay by the [[Harbour]] and the [[Harbour#^a1]] wall.</p>');
  write('sources/Notes.html', '<p data-block="c1">See [[Harbour|the port]] and [[harbour]].</p>');
  await layer.commitNow('import-author');
  assert.equal((await ripple.run()).baseline, true);

  const renamed = await store.rename('wiki/Harbour.html', 'Port.html', null);
  assert.ok(renamed.rewrittenLinks >= 4, 'the rename did rewrite the links');
  const done = await ripple.run();
  assert.deepEqual(ripple.overview().jobs.map((j) => j.title), ['Port'], 'only the renamed page is judged again');
  assert.equal(done.made, 1);
});

test('an author retargeting a link to another page is a change, rename or none', async (t) => {
  const { write, layer, ripple } = await gitRipple(t);
  write('wiki/Alice.html', '<p data-block="a1">Alice.</p>');
  write('wiki/Bob.html', '<p data-block="a2">Bob.</p>');
  write('wiki/Quay.html', '<p data-block="b1">The quay is run by [[Alice]].</p>');
  await layer.commitNow('import-author');
  await ripple.run();
  write('wiki/Quay.html', '<p data-block="b1">The quay is run by [[Bob]].</p>');
  await layer.commitNow('import-author');
  await ripple.run();
  assert.deepEqual(ripple.overview().jobs.map((j) => j.title), ['Quay']);
});

test('a rename elsewhere in the range does not hide an author retargeting a link', async (t) => {
  const { write, layer, store, ripple } = await gitRipple(t);
  write('wiki/Alice.html', '<p data-block="a1">Alice.</p>');
  write('wiki/Bob.html', '<p data-block="a2">Bob.</p>');
  write('wiki/Quay.html', '<p data-block="b1">The quay is run by [[Alice]], near the [[Bob]].</p>');
  await layer.commitNow('import-author');
  await ripple.run();
  await store.rename('wiki/Bob.html', 'Robert.html', null);
  write('wiki/Quay.html', '<p data-block="b1">The quay is run by [[Robert]], near the [[Robert]].</p>');
  await layer.commitNow('import-author');
  await ripple.run();
  assert.deepEqual(ripple.overview().jobs.map((j) => j.title), ['Quay', 'Robert'].sort(), 'Alice to Robert is a change; Bob to Robert is the rename');
});

test('links compare by target and shown text; a rename maps old titles to new', () => {
  const before = 'See [[Harbour]] now and [[Harbour|the port]].';
  const renamed = new Map([['harbour', 'port']]);
  assert.equal(wordsOf(`<p>${before}</p>`, renamed), wordsOf('<p>See [[Port]] now and [[Port|the port]].</p>'), 'targets rewritten by the rename');
  assert.notEqual(wordsOf(`<p>${before}</p>`), wordsOf('<p>See [[Port]] now and [[Port|the port]].</p>'), 'no rename, no excuse');
  assert.equal(wordsOf('<p>[[Harbour#^a1]] and [[harbour]]</p>', renamed), wordsOf('<p>[[Port#^a1]] and [[Port]]</p>'), 'anchors and case');
  assert.notEqual(wordsOf(`<p>${before}</p>`), wordsOf('<p>See [[Harbour]] later and [[Harbour|the port]].</p>'), 'words around');
  assert.notEqual(wordsOf(`<p>${before}</p>`), wordsOf('<p>See [[Harbour]] now and [[Harbour|the quay]].</p>'), 'shown text');
});
