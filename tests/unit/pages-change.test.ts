// Rules for the page store's change event:
// - Change-Fires-Once-Per-Changed-Save: each write, create and rename that changed bytes
//   fires onChange once, after the file holds the new text and before the next queued
//   change starts;
// - Change-Never-Fires-For-Nothing: an unchanged write, a stale or missing write, a refused
//   create and a rename that moved nothing fire nothing;
// - Change-Names-Who: the change says who saved (the author unless the caller says otherwise);
// - Failing-Listener-Does-Not-Fail-The-Save: a listener that throws is logged; the save and
//   the other listeners go on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageChange } from '../../src/hoard/pages/store.ts';
import { pagesLibrary } from './pages-support.ts';

function watched(t: Parameters<typeof pagesLibrary>[0]) {
  const lib = pagesLibrary(t);
  const seen: PageChange[] = [];
  lib.store.onChange((c) => { seen.push(c); });
  return { ...lib, seen };
}

test('Change-Fires-Once-Per-Changed-Save: a write fires one edit change that names the page, both texts and the author', async (t) => {
  const { store, put, seen } = watched(t);
  put('wiki/Tide.html', '<p>one</p>');
  assert.deepEqual(await store.write('wiki/Tide.html', '<p>one</p>', '<p>two</p>'), { ok: true });
  assert.deepEqual(seen, [{ page: 'wiki/Tide.html', kind: 'edit', who: 'author', before: '<p>one</p>', after: '<p>two</p>' }]);
});

test('Change-Names-Who: a write, create and rename carry the who they were given', async (t) => {
  const { store, put, seen } = watched(t);
  put('wiki/Tide.html', 'a');
  await store.write('wiki/Tide.html', 'a', 'b', 'librarian');
  await store.create('wiki', 'Moon.html', '<p>m</p>', 'librarian');
  await store.rename('wiki/Moon.html', 'Sun.html', null, 'librarian');
  assert.deepEqual(seen.map((c) => [c.kind, c.who]), [['edit', 'librarian'], ['create', 'librarian'], ['rename', 'librarian']]);
});

test('Change-Fires-Once-Per-Changed-Save: a create fires with an empty before, and a rename names where the page came from', async (t) => {
  const { store, seen } = watched(t);
  await store.create('sources', 'Notes.html', '<p>n</p>');
  await store.rename('sources/Notes.html', 'People/Notes.html', null);
  assert.deepEqual(seen, [
    { page: 'sources/Notes.html', kind: 'create', who: 'author', before: '', after: '<p>n</p>' },
    { page: 'sources/People/Notes.html', from: 'sources/Notes.html', kind: 'rename', who: 'author', before: '<p>n</p>', after: '<p>n</p>' },
  ]);
});

test('Change-Never-Fires-For-Nothing: an unchanged, stale or missing write fires nothing', async (t) => {
  const { store, put, seen, logged } = watched(t);
  put('wiki/Tide.html', '<p>one</p>');
  assert.deepEqual(await store.write('wiki/Tide.html', '<p>one</p>', '<p>one</p>'), { ok: true });
  assert.deepEqual(await store.write('wiki/Tide.html', '<p>old</p>', '<p>x</p>'), { ok: false, reason: 'stale' });
  assert.deepEqual(await store.write('wiki/Gone.html', 'a', 'b'), { ok: false, reason: 'missing' });
  assert.deepEqual(seen, []);
  assert.equal(logged('pages.write.refused').length, 2, 'the refusals were reached');
});

test('Change-Never-Fires-For-Nothing: a refused create and a rename that moved nothing fire nothing', async (t) => {
  const { store, put, seen } = watched(t);
  put('wiki/Tide.html', '<p>one</p>');
  await assert.rejects(store.create('wiki', 'Tide.html', 'x'), /already a page/);
  await store.rename('wiki/Tide.html', 'Tide.html', null);
  await assert.rejects(store.rename('wiki/Nope.html', 'Other.html', null), /not a page/);
  assert.deepEqual(seen, []);
});

test('Change-Fires-Once-Per-Changed-Save: the file already holds the new text, and the next queued save has not started', async (t) => {
  const { store, put, get, library } = pagesLibrary(t);
  put('wiki/Tide.html', 'a');
  const onDisk: string[] = [];
  store.onChange((c) => { onDisk.push(`${c.after}=${get('wiki/Tide.html')}`); });
  await Promise.all([store.write('wiki/Tide.html', 'a', 'b'), store.write('wiki/Tide.html', 'b', 'c')]);
  assert.deepEqual(onDisk, ['b=b', 'c=c']);
  assert.ok(library);
});

test('Failing-Listener-Does-Not-Fail-The-Save: a throwing listener is logged and the others still hear the save', async (t) => {
  const { store, put, get, logged } = pagesLibrary(t);
  put('wiki/Tide.html', 'a');
  const heard: string[] = [];
  store.onChange(() => { throw new Error('boom'); });
  store.onChange((c) => { heard.push(c.after); });
  assert.deepEqual(await store.write('wiki/Tide.html', 'a', 'b'), { ok: true });
  assert.equal(get('wiki/Tide.html'), 'b');
  assert.deepEqual(heard, ['b']);
  const failed = logged('pages.change.listener-failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.level, 'error');
});

test('onChange returns an unsubscribe', async (t) => {
  const { store, put } = pagesLibrary(t);
  put('wiki/Tide.html', 'a');
  const heard: string[] = [];
  const off = store.onChange((c) => { heard.push(c.after); });
  await store.write('wiki/Tide.html', 'a', 'b');
  off();
  off();
  await store.write('wiki/Tide.html', 'b', 'c');
  assert.deepEqual(heard, ['b']);
});

test('Change-Fires-Once-Per-Changed-Save: an announced import reaches the listeners in the queue, behind the save before it', async (t) => {
  const { store, put, seen } = watched(t);
  put('wiki/Tide.html', 'a');
  const first = store.write('wiki/Tide.html', 'a', 'b');
  await store.announce({ page: 'wiki/Moon.html', kind: 'import', who: 'librarian', before: '', after: '<p>m</p>' });
  await first;
  assert.deepEqual(seen.map((c) => [c.kind, c.page]), [['edit', 'wiki/Tide.html'], ['import', 'wiki/Moon.html']]);
});
