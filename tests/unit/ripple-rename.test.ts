// Rule: a change that only rewrites link targets makes no job. A page rename rewrites
// [[links]] in other pages in the author's commit; those pages' words are the same, so
// ripple takes no job for them. The renamed page itself is a new id and is judged again.
// A change of the words around a link, or of a link's shown text, is still a change.
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

test('a real change to the words around or inside a link is still a change', () => {
  const before = 'See [[Harbour]] now and [[Harbour|the port]].';
  assert.equal(wordsOf(`<p>${before}</p>`), wordsOf('<p>See [[Port]] now and [[Port|the port]].</p>'), 'targets rewritten');
  assert.notEqual(wordsOf(`<p>${before}</p>`), wordsOf('<p>See [[Harbour]] later and [[Harbour|the port]].</p>'), 'words around');
  assert.notEqual(wordsOf(`<p>${before}</p>`), wordsOf('<p>See [[Harbour]] now and [[Harbour|the quay]].</p>'), 'shown text');
});
