// Rules: link edits for the open book's chapters reach the editor only through the host's
// `replace`, one link at a time, later offsets first; a refused edit is counted and the
// rest still go; and a rename with a book open, once the window has made its edits, leaves
// that book's text as a rename with no book open would have.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paragraphTexts } from '../../src/hoard/html.ts';
import { applyChapterEdits, renamePage } from '../../src/hoard/pages/window.ts';
import { rewriteHtml } from '../../src/hoard/pages/rewrite.ts';
import { key } from '../../src/librarian/links.ts';
import { pagesLibrary } from './pages-support.ts';

// A window with one open book: replace edits an in-memory chapter as the host does.
function fakeWindow(chapters: Record<string, string[]>, store?: { rename(id: string, to: string, open: string | null): Promise<unknown> }) {
  const calls: { chId: string; pIdx: number; off: number; len: number; expected: string; text: string }[] = [];
  const neo = {
    book: () => ({ id: 'book-fox-1' }),
    async replace(place: { chId: string; pIdx: number; off: number; len: number }, expected: string, text: string) {
      calls.push({ chId: place.chId, pIdx: place.pIdx, off: place.off, len: place.len, expected, text });
      const p = chapters[place.chId]?.[place.pIdx];
      if (p === undefined || p.slice(place.off, place.off + place.len) !== expected) return { ok: false as const, reason: 'stale' as const };
      chapters[place.chId]![place.pIdx] = p.slice(0, place.off) + text + p.slice(place.off + place.len);
      return { ok: true as const };
    },
    async invoke(channel: string, payload: unknown) {
      assert.equal(channel, 'pages.rename');
      const { id, newPath, openBookId } = payload as { id: string; newPath: string; openBookId: string | null };
      return store!.rename(id, newPath, openBookId);
    },
  };
  return { neo, calls };
}

test('edits go through replace one link at a time, the later ones in a paragraph first', async () => {
  const chapters = { c1: ['See [[Old]] and [[Old|x]] end'] };
  const { neo, calls } = fakeWindow(chapters);
  const edits = [
    { pIdx: 0, off: 4, len: 7, expected: '[[Old]]', replacement: '[[New]]' },
    { pIdx: 0, off: 16, len: 9, expected: '[[Old|x]]', replacement: '[[New|x]]' },
  ];
  const done = await applyChapterEdits(neo, [{ bookId: 'book-fox-1', chId: 'c1', edits }]);
  assert.deepEqual(calls.map((c) => c.off), [16, 4]);
  assert.deepEqual(chapters.c1, ['See [[New]] and [[New|x]] end']);
  assert.deepEqual(done, { applied: 2, refused: [] });
});

test('a refused edit is counted with its reason and the others still go', async () => {
  const chapters = { c1: ['[[Old]]', 'typed since: [[Different]]'] };
  const { neo } = fakeWindow(chapters);
  const done = await applyChapterEdits(neo, [{
    bookId: 'book-fox-1', chId: 'c1',
    edits: [
      { pIdx: 0, off: 0, len: 7, expected: '[[Old]]', replacement: '[[New]]' },
      { pIdx: 1, off: 13, len: 7, expected: '[[Old]]', replacement: '[[New]]' },
    ],
  }]);
  assert.equal(done.applied, 1);
  assert.deepEqual(done.refused, [{ chId: 'c1', pIdx: 1, reason: 'stale' }]);
  assert.deepEqual(chapters.c1, ['[[New]]', 'typed since: [[Different]]']);
});

test('renaming with a book open leaves that book\'s text as a rename with the shelf showing would have', async (t) => {
  const html = '<p>Down to [[Harbour]] at dusk.</p><p>Café &amp; [[HARBOUR#^z|the port]] and `[[Harbour]]`.</p>';
  const open = pagesLibrary(t);
  open.put('wiki/Harbour.html', '<p>x</p>');
  open.put('book-fox-1/chapters/c1.html', html);
  const closed = pagesLibrary(t);
  closed.put('wiki/Harbour.html', '<p>x</p>');
  closed.put('book-fox-1/chapters/c1.html', html);

  const chapters = { c1: paragraphTexts(html) };
  const { neo } = fakeWindow(chapters, open.store);
  const done = await renamePage(neo, 'wiki/Harbour.html', 'Port.html');

  assert.equal(open.get('book-fox-1/chapters/c1.html'), html, 'the main half left the open chapter alone');
  assert.deepEqual(done.applied, 2);
  await closed.store.rename('wiki/Harbour.html', 'Port.html', null);
  assert.deepEqual(chapters.c1, paragraphTexts(closed.get('book-fox-1/chapters/c1.html')));
  assert.deepEqual(chapters.c1, paragraphTexts(rewriteHtml(html, (t) => (key(t) === 'harbour' ? 'Port' : null)).html));
});

// Rule: by the time the edits are made the rename has happened, so an edit the host throws
// on is listed as refused like any other, and the rest still go; the rename still resolves.
test('an edit the host throws on is listed as refused, and the rest still go', async () => {
  const chapters = { c1: ['See [[Old]] here'], c2: ['And [[Old]] there'] };
  const { neo } = fakeWindow(chapters);
  const replace = neo.replace.bind(neo);
  neo.replace = async (place, expected, text) => {
    if (place.chId === 'c1') throw new TypeError('the chapter is not in the window');
    return replace(place, expected, text);
  };
  const edit = { pIdx: 0, off: 4, len: 7, expected: '[[Old]]', replacement: '[[New]]' };
  const done = await applyChapterEdits(neo, [{ bookId: 'book-fox-1', chId: 'c1', edits: [edit] }, { bookId: 'book-fox-1', chId: 'c2', edits: [edit] }]);
  assert.deepEqual(done, { applied: 1, refused: [{ chId: 'c1', pIdx: 0, reason: 'the chapter is not in the window' }] });
  assert.deepEqual(chapters, { c1: ['See [[Old]] here'], c2: ['And [[New]] there'] });
});
