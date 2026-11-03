// Rules for the librarian reading a stored page the writer has left (companion.read {page}):
// - a page's new paragraphs get the same finding a chapter's do, as a librarian comment on
//   the page's own marks, once per page named, however many times the page is read;
// - a page never flags itself, and the caret and the quiet pages are kept as for a chapter;
// - the request is one form or the other: {bookId, chId} or {page}, never both or neither.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateHoardCompanionReadV1 } from '../../src/generated/validators.cjs';
import { Companion } from '../../src/hoard/companion/store.ts';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { pagesLibrary } from './pages-support.ts';

function setup(t: Parameters<typeof pagesLibrary>[0]) {
  const lib = pagesLibrary(t);
  lib.put('wiki/Kraken.html', '<p>Words.</p>');
  lib.put('wiki/Harbour.html', '<p>The harbour.</p>');
  lib.put('sources/Notes.html', '<p>Old notes.</p>');
  let n = 0;
  const marks = new MarkStore({ library: () => lib.library, now: () => new Date('2026-10-15T23:00:00.000Z'), newId: (p) => `${p}-t${String(n++).padStart(4, '0')}`, log: lib.log });
  const companion = new Companion({ library: () => lib.library, marks, pages: lib.store, now: () => new Date('2026-10-15T23:00:00.000Z'), newId: () => `m-t${String(n++).padStart(4, '0')}`, log: lib.log });
  return { ...lib, companion, marks };
}

const html = (...ps: string[]) => ps.map((p) => `<p>${p}</p>`).join('');

test('a stored page\'s new paragraph that names a page gets one librarian comment on the stored page\'s marks', async (t) => {
  const { companion, marks } = setup(t);
  const before = html('Old notes.');
  const after = html('Old notes.', 'The Kraken rose past the harbour wall.');
  assert.deepEqual(await companion.read({ page: 'sources/Notes.html', before, after }), { added: 2 });
  const found = await marks.list('sources/Notes.html');
  assert.deepEqual(found.map((m) => [m.created.who, m.kind, m.thread[0]!.body.split(':')[0]]), [['librarian', 'comment', '[[Kraken]]'], ['librarian', 'comment', '[[harbour]]']]);
});

test('a page is told about another page once, however often it is read again', async (t) => {
  const { companion, marks } = setup(t);
  const after = html('The Kraken rose.');
  assert.deepEqual(await companion.read({ page: 'sources/Notes.html', before: '', after }), { added: 1 });
  assert.deepEqual(await companion.read({ page: 'sources/Notes.html', before: '', after: html('The Kraken rose.', 'The Kraken sank.') }), { added: 0 });
  assert.equal((await marks.list('sources/Notes.html')).length, 1);
});

test('a page never flags itself by its own name', async (t) => {
  const { companion, marks } = setup(t);
  assert.deepEqual(await companion.read({ page: 'wiki/Kraken.html', before: '', after: html('The Kraken is old, and the Harbour knows it.') }), { added: 1 });
  assert.deepEqual((await marks.list('wiki/Kraken.html')).map((m) => m.thread[0]!.body.split(':')[0]), ['[[Harbour]]']);
});

test('the caret and the quiet pages are kept as they are for a chapter', async (t) => {
  const { companion, marks } = setup(t);
  companion.quiet('wiki/Harbour.html', true);
  const after = html('The Kraken and the Harbour.');
  // the caret sits just after "Kraken", so the word may not be finished
  assert.deepEqual(await companion.read({ page: 'sources/Notes.html', before: '', after, caret: { pIdx: 0, off: 10 } }), { added: 0 });
  assert.deepEqual(await companion.read({ page: 'sources/Notes.html', before: '', after, caret: null }), { added: 1 });
  assert.deepEqual((await marks.list('sources/Notes.html')).map((m) => m.thread[0]!.body.split(':')[0]), ['[[Kraken]]']);
});

test('a request that names no stored page is refused', async (t) => {
  const { companion } = setup(t);
  await assert.rejects(companion.read({ page: '../x.html', before: '', after: '' }), /page/i);
});

test('the schema takes the chapter form or the page form, and nothing else', () => {
  const ok = [
    { bookId: 'book-a', chId: 'c1', before: '', after: 'x' },
    { page: 'wiki/Kraken.html', before: '', after: 'x', caret: { pIdx: 0, off: 3 } },
    { page: 'wiki/Kraken.html', before: '', after: 'x', caret: null },
  ];
  const bad = [
    {}, { before: '', after: '' }, { page: 'wiki/Kraken.html', after: 'x' },
    { page: 'wiki/Kraken.html', bookId: 'book-a', before: '', after: '' },
    { page: 'wiki/Kraken.html', chId: 'c1', before: '', after: '' },
    { page: 'notes/Kraken.html', before: '', after: '' },
    { bookId: 'book-a', before: '', after: '' },
    { page: 'wiki/Kraken.html', before: '', after: '', extra: 1 },
  ];
  for (const p of ok) assert.ok(validateHoardCompanionReadV1(p), JSON.stringify(p));
  for (const p of bad) assert.ok(!validateHoardCompanionReadV1(p), JSON.stringify(p));
});
