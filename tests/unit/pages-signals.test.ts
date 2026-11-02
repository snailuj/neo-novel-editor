// Rules for what main does with the page store's change event (pages/signals.ts):
// - Every-Page-Save-Reaches-The-Gate-And-Pair-Once: each stored-page save that changed
//   bytes wakes the librarian pair once, whoever saved, and tells the gate once when the
//   author saved; the librarian's save never frees a held page;
// - No-Signal-For-Nothing: an unchanged, stale or refused save signals nothing;
// - Nothing-Is-Signalled-Twice: pages.write and pages.edit each signal one save once, with
//   no other call site saying it again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPages } from '../../src/hoard/pages/main.ts';
import { signalPageChanges } from '../../src/hoard/pages/signals.ts';
import { editPage } from '../../src/hoard/review/edit.ts';
import { pagesLibrary } from './pages-support.ts';

function wired(t: Parameters<typeof pagesLibrary>[0]) {
  const lib = pagesLibrary(t);
  const gate: string[] = [];
  const pair: { page: string }[] = [];
  const off = signalPageChanges(lib.store, { saved: (p) => { gate.push(p); } }, { landed: ((p: { page: string }) => { pair.push(p); }) as never }, lib.log);
  return { ...lib, gate, pair, off };
}

test('Every-Page-Save-Reaches-The-Gate-And-Pair-Once: an author write tells both, a librarian write only the pair', async (t) => {
  const { store, put, gate, pair } = wired(t);
  put('wiki/Tide.html', 'a');
  await store.write('wiki/Tide.html', 'a', 'b');
  assert.deepEqual([gate, pair], [['wiki/Tide.html'], [{ page: 'wiki/Tide.html' }]]);
  await store.write('wiki/Tide.html', 'b', 'c', 'librarian');
  assert.deepEqual([gate, pair], [['wiki/Tide.html'], [{ page: 'wiki/Tide.html' }, { page: 'wiki/Tide.html' }]]);
});

test('Every-Page-Save-Reaches-The-Gate-And-Pair-Once: a create and a rename name the page where it now is', async (t) => {
  const { store, gate, pair } = wired(t);
  await store.create('wiki', 'Moon.html', '<p>m</p>');
  await store.rename('wiki/Moon.html', 'Sun.html', null);
  await store.create('sources', 'Notes.html', 'n', 'librarian');
  assert.deepEqual(gate, ['wiki/Moon.html', 'wiki/Sun.html']);
  assert.deepEqual(pair.map((p) => p.page), ['wiki/Moon.html', 'wiki/Sun.html', 'sources/Notes.html']);
});

test('No-Signal-For-Nothing: an unchanged, stale or missing write signals nothing', async (t) => {
  const { store, put, gate, pair } = wired(t);
  put('wiki/Tide.html', 'a');
  await store.write('wiki/Tide.html', 'a', 'a');
  await store.write('wiki/Tide.html', 'x', 'b');
  await store.write('wiki/Gone.html', 'a', 'b');
  assert.deepEqual([gate, pair], [[], []]);
});

test('a failing gate does not stop the pair hearing the save, and the save is kept', async (t) => {
  const lib = pagesLibrary(t);
  const pair: string[] = [];
  signalPageChanges(lib.store, { saved: () => { throw new Error('gate down'); } }, { landed: ((p: { page: string }) => { pair.push(p.page); }) as never }, lib.log);
  lib.put('wiki/Tide.html', 'a');
  assert.deepEqual(await lib.store.write('wiki/Tide.html', 'a', 'b'), { ok: true });
  assert.deepEqual(pair, ['wiki/Tide.html']);
  assert.equal(lib.get('wiki/Tide.html'), 'b');
  assert.equal(lib.logged('pages.change.signal-failed').length, 1);
});

test('the returned function stops the signals', async (t) => {
  const { store, put, gate, off } = wired(t);
  put('wiki/Tide.html', 'a');
  off();
  await store.write('wiki/Tide.html', 'a', 'b');
  assert.deepEqual(gate, []);
});

test('Nothing-Is-Signalled-Twice: pages.write and pages.edit each signal a save once', async (t) => {
  const { put, library, log } = pagesLibrary(t);
  put('wiki/Tide.html', 'a');
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const host = { handle: (c: string, fn: (payload: unknown) => unknown) => { handlers.set(c, fn); }, log, paths: { library: () => library } };
  const { store } = startPages(host as never, undefined);
  const [gate, pair]: string[][] = [[], []];
  signalPageChanges(store, { saved: (p) => { gate.push(p); } }, { landed: ({ page }) => { pair.push(page); } }, log);
  assert.deepEqual(await handlers.get('pages.write')!({ id: 'wiki/Tide.html', before: 'a', after: 'b' }), { ok: true });
  assert.deepEqual([gate.length, pair.length], [1, 1]);
  const layer = { around: async (_p: unknown, fn: () => Promise<unknown>) => ({ result: await fn(), before: null, after: null }), release: () => {}, held: () => [] };
  assert.deepEqual(await editPage({ library: () => library, store, layer, log } as never, { page: 'wiki/Tide.html', before: 'b', after: 'c', as: 'author' }), { ok: true });
  assert.deepEqual([gate.length, pair.length], [2, 2]);
});

test('Every-Page-Save-Reaches-The-Gate-And-Pair-Once: a librarian pages.edit wakes the pair once and never tells the gate', async (t) => {
  const { store, put, gate, pair, library, log } = wired(t);
  put('wiki/Tide.html', 'a');
  put('.neo/pages/wiki/Tide.html.json', JSON.stringify({
    version: 1, source: { path: '/v/Tide.md', name: 'Tide', sha256: 'a'.repeat(64) }, frontmatter: { type: 'lore', provenance: { author: 'librarian' } }, imported: '2026-10-15T10:00:00Z',
  }));
  const layer = { around: async (_p: unknown, fn: () => Promise<unknown>) => ({ result: await fn(), before: null, after: null }), release: () => {}, held: () => [] };
  assert.deepEqual(await editPage({ library: () => library, store, layer, log } as never, { page: 'wiki/Tide.html', before: 'a', after: 'b', as: 'librarian' }), { ok: true });
  assert.deepEqual([gate, pair], [[], [{ page: 'wiki/Tide.html' }]]);
});
