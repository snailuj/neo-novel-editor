// Rules for the marks sidecars under .neo/:
// - a bad book or chapter name never reaches the disk;
// - a sidecar that does not read as the schema says is never written over;
// - each action reads the file afresh, so what another device wrote is kept;
// - actions on one file run one at a time, so none is lost;
// - page marks never read or write through a link that leaves .neo/marks;
// - reading never writes, and the main half, not the window, says when and by whom.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { validateHoardMarksV1 } from '../../src/generated/validators.cjs';
import { MarkFileError, MarkStore, pageSidecarPath, sidecarPath } from '../../src/hoard/marks/store.ts';
import { PageRefused } from '../../src/hoard/pages/identity.ts';
import { tempDir } from './git-support.ts';

const anchor = { exact: 'boats', prefix: 'counted the ', suffix: ' twice.', pIdx: 1, off: 17 };
const ids = { bookId: 'book-fox-1', chId: 'c1' };

function storeFor(t: { after(fn: () => void): void }, o: { head?: string | null } = {}) {
  const library = tempDir(t);
  const lines: { level: string; message: string; data?: unknown }[] = [];
  const wrote: string[] = [];
  let n = 0;
  let clock = Date.parse('2026-10-15T21:00:00.000Z');
  const store = new MarkStore({
    library: () => library,
    now: () => new Date((clock += 1000)),
    newId: (prefix) => `${prefix}-test${(n++).toString().padStart(3, '0')}`,
    head: async () => o.head ?? null,
    wrote: (name) => wrote.push(name),
    log: (level, message, data) => lines.push({ level, message, data }),
  });
  return { library, store, lines, wrote, file: sidecarPath(library, ids.bookId, ids.chId) };
}

const onDisk = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { version: 1; marks: Mark[] };

test('a comment is written to .neo/<book>/chapters/<chapter>.json, timed and signed by the main half', async (t) => {
  const sha = 'a'.repeat(40);
  const { library, store, wrote, file } = storeFor(t, { head: sha });
  assert.equal(file, path.join(library, '.neo', 'book-fox-1', 'chapters', 'c1.json'));
  const made = await store.add({ ...ids, kind: 'comment', anchor, body: 'Which boats?' }, 'author');
  assert.equal(made.id, 'm-test000');
  const saved = onDisk(file);
  assert.ok(validateHoardMarksV1(saved), JSON.stringify(validateHoardMarksV1.errors));
  assert.deepEqual(made.marks, saved.marks);
  const [mark] = saved.marks;
  assert.deepEqual(mark.anchor, { ...anchor, commit: sha });
  assert.deepEqual(mark.created, { who: 'author', at: '2026-10-15T21:00:01.000Z' });
  assert.deepEqual(mark.thread.map((e) => [e.who, e.body]), [['author', 'Which boats?']]);
  assert.deepEqual(wrote, ['.neo']);
  assert.deepEqual(readdirSync(path.dirname(file)), ['c1.json'], 'no temporary file left behind');
});

test('a bad book or chapter name is refused before anything is written', async (t) => {
  const { library, store } = storeFor(t);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'nul\0l', '../book-fox-1']) {
    assert.throws(() => sidecarPath(library, bad, 'c1'), TypeError, JSON.stringify(bad));
    assert.throws(() => sidecarPath(library, 'book-fox-1', bad), TypeError, JSON.stringify(bad));
    await assert.rejects(store.add({ bookId: bad, chId: 'c1', kind: 'comment', anchor, body: 'x' }, 'author'), TypeError);
    await assert.rejects(store.listBook(bad), TypeError);
  }
  assert.equal(existsSync(path.join(library, '.neo')), false);
});

test('a sidecar that does not fit the schema is reported and never written over', async (t) => {
  const { library, store, lines, file } = storeFor(t);
  await store.add({ bookId: 'book-fox-1', chId: 'c2', kind: 'comment', anchor, body: 'Fine.' }, 'author');
  mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ['{"version": 1, "marks": [', '{"version": 2, "marks": []}']) {
    writeFileSync(file, junk);
    await assert.rejects(store.add({ ...ids, kind: 'comment', anchor, body: 'Lost?' }, 'author'), MarkFileError);
    assert.equal(readFileSync(file, 'utf8'), junk, 'left exactly as it was');
    const listed = await store.listBook('book-fox-1');
    assert.deepEqual(listed.unreadable, ['c1']);
    assert.deepEqual(Object.keys(listed.chapters), ['c2'], 'the other chapter still reads');
  }
  assert.ok(lines.some((l) => l.level === 'error' && /c1\.json/.test(String(l.message) + JSON.stringify(l.data))));
  assert.ok(existsSync(path.join(library, '.neo', 'book-fox-1', 'chapters', 'c2.json')));
});

test('an action reads the file afresh, so a mark another device wrote is kept', async (t) => {
  const { store, file } = storeFor(t);
  const first = await store.add({ ...ids, kind: 'comment', anchor, body: 'Mine.' }, 'author');
  const theirs = { ...first.marks[0], id: 'm-other1', thread: [{ ...first.marks[0].thread[0], id: 'm-other1-0', body: 'Theirs.' }] };
  writeFileSync(file, JSON.stringify({ version: 1, marks: [...onDisk(file).marks, theirs] }));
  await store.reply({ ...ids, markId: first.id, body: 'A reply.' }, 'author');
  const marks = onDisk(file).marks;
  assert.deepEqual(marks.map((m) => m.id), [first.id, 'm-other1']);
  assert.deepEqual(marks[0].thread.map((e) => e.body), ['Mine.', 'A reply.']);
});

test('replies and comments sent all at once are all kept, in the order sent', async (t) => {
  const { store, file } = storeFor(t);
  const { id } = await store.add({ ...ids, kind: 'comment', anchor, body: 'Start.' }, 'author');
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.reply({ ...ids, markId: id, body: `Reply ${i}.` }, 'author')));
  const thread = onDisk(file).marks[0].thread.map((e) => e.body);
  assert.deepEqual(thread, ['Start.', ...Array.from({ length: 10 }, (_, i) => `Reply ${i}.`)]);
  assert.equal(new Set(onDisk(file).marks[0].thread.map((e) => e.id)).size, 11, 'every entry has its own id');
  // an add waits on git for the commit between its read and its write
  await Promise.all(Array.from({ length: 5 }, (_, i) => store.add({ ...ids, kind: 'comment', anchor, body: `Add ${i}.` }, 'author')));
  assert.deepEqual(onDisk(file).marks.slice(1).map((m) => m.thread[0].body), Array.from({ length: 5 }, (_, i) => `Add ${i}.`));
});

test('resolving and reopening are recorded; a move the mark cannot make changes nothing', async (t) => {
  const { store, file } = storeFor(t);
  const { id } = await store.add({ ...ids, kind: 'comment', anchor, body: 'Check.' }, 'author');
  await store.setState({ ...ids, markId: id, state: 'resolved' }, 'author');
  await store.setState({ ...ids, markId: id, state: 'open' }, 'librarian');
  const before = readFileSync(file, 'utf8');
  await assert.rejects(store.setState({ ...ids, markId: id, state: 'accepted' }, 'author'), RangeError);
  await assert.rejects(store.reply({ ...ids, markId: 'm-nowhere', body: 'x' }, 'author'), RangeError);
  await assert.rejects(store.reply({ bookId: 'book-fox-1', chId: 'c9', markId: id, body: 'x' }, 'author'), RangeError);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(onDisk(file).marks[0].history.map((h) => `${h.state}:${h.who}`), ['resolved:author', 'open:librarian']);
});

test('listing reads every chapter of a book and writes nothing', async (t) => {
  const { library, store, wrote, file } = storeFor(t);
  assert.deepEqual(await store.listBook('book-fox-1'), { chapters: {}, unreadable: [] });
  assert.equal(existsSync(path.join(library, '.neo')), false, 'a book with no marks makes no folder');
  await store.add({ ...ids, kind: 'comment', anchor, body: 'One.' }, 'author');
  await store.add({ bookId: 'book-fox-1', chId: 'c2', kind: 'highlight', anchor }, 'author');
  writeFileSync(file + '.tmp', '{"torn');
  const stamp = statSync(file).mtimeMs;
  wrote.length = 0;
  const listed = await store.listBook('book-fox-1');
  assert.deepEqual(Object.keys(listed.chapters).sort(), ['c1', 'c2']);
  assert.equal(listed.chapters.c2[0].kind, 'highlight');
  assert.deepEqual(listed.unreadable, []);
  assert.equal(statSync(file).mtimeMs, stamp);
  assert.deepEqual(wrote, []);
});

// Page marks: the same marks, on a page named by its id (<tree>/<path>) instead of a chapter.
const pageId = 'wiki/People/Harbour.html';

test('a page\'s marks live under .neo/marks/<tree>/<path>.json and survive a reload', async (t) => {
  const { library, store } = storeFor(t);
  const made = await store.add({ page: pageId, kind: 'comment', anchor, body: 'Which harbour?' }, 'author');
  const file = path.join(library, '.neo', 'marks', 'wiki', 'People', 'Harbour.html.json');
  const saved = onDisk(file);
  assert.ok(validateHoardMarksV1(saved), JSON.stringify(validateHoardMarksV1.errors));
  assert.deepEqual(saved.marks, made.marks);
  assert.equal(saved.marks[0].id, made.id);
  assert.equal(pageSidecarPath(library, pageId), file);
  // a second store over the same library, as after a restart, reads the same marks
  const again = new MarkStore({ library: () => library, log: () => {} });
  assert.deepEqual(await again.list(pageId), saved.marks);
  const source = await store.add({ page: 'sources/Notes/Tides.html', kind: 'highlight', anchor }, 'author');
  assert.deepEqual(onDisk(path.join(library, '.neo', 'marks', 'sources', 'Notes', 'Tides.html.json')).marks.map((m) => m.id), [source.id]);
});

test('listing a page with no marks gives none and writes nothing', async (t) => {
  const { library, store, wrote } = storeFor(t);
  assert.deepEqual(await store.list(pageId), []);
  assert.equal(existsSync(path.join(library, '.neo')), false);
  assert.deepEqual(wrote, []);
});

test('a page id that escapes the library or its tree is refused before anything is written', async (t) => {
  const { library, store } = storeFor(t);
  const bad = ['../x.html', 'wiki/../x.html', 'wiki/a/../../x.html', 'wiki//x.html', 'wiki/.hidden/x.html', 'wiki/x.md', 'wiki/', 'wiki', 'notes/x.html', '/wiki/x.html', 'wiki\\x.html', 'wiki/x\0.html', ''];
  for (const page of bad) {
    assert.throws(() => pageSidecarPath(library, page), PageRefused, JSON.stringify(page));
    await assert.rejects(store.add({ page, kind: 'comment', anchor, body: 'x' }, 'author'), PageRefused, JSON.stringify(page));
    await assert.rejects(store.list(page), PageRefused, JSON.stringify(page));
    await assert.rejects(store.addAll(page, []), PageRefused, JSON.stringify(page));
    await assert.rejects(store.reply({ page, markId: 'm-1', body: 'x' }, 'author'), PageRefused, JSON.stringify(page));
    await assert.rejects(store.setState({ page, markId: 'm-1', state: 'resolved' }, 'author'), PageRefused, JSON.stringify(page));
  }
  assert.equal(existsSync(path.join(library, '.neo')), false);
  assert.equal(existsSync(path.join(library, '..', 'x.html.json')), false);
});

test('a page\'s marks take replies, states, a review and imported marks like a chapter\'s', async (t) => {
  const { library, store } = storeFor(t);
  const file = pageSidecarPath(library, pageId);
  const comment = await store.add({ page: pageId, kind: 'comment', anchor, body: 'Check.' }, 'author');
  await store.reply({ page: pageId, markId: comment.id, body: 'Done.' }, 'librarian');
  await store.setState({ page: pageId, markId: comment.id, state: 'resolved' }, 'author');
  const suggestion = await store.add({ page: pageId, kind: 'substitution', anchor, proposed: 'vessels' }, 'librarian');
  const reviewed = await store.review({ page: pageId, markId: suggestion.id, state: 'accepted' }, 'librarian', 'Applied.');
  const marks = onDisk(file).marks;
  assert.deepEqual(reviewed.marks, marks);
  assert.deepEqual(marks.map((m) => m.id), [comment.id, suggestion.id]);
  assert.deepEqual(marks[0].thread.map((e) => `${e.who}:${e.body}`), ['author:Check.', 'librarian:Done.']);
  assert.equal(marks[0].history.at(-1)?.state, 'resolved');
  assert.equal(marks[1].history.at(-1)?.state, 'accepted');
  await assert.rejects(store.review({ page: pageId, markId: comment.id, state: 'accepted' }, 'librarian'), RangeError);
  await assert.rejects(store.reply({ page: pageId, markId: 'm-nowhere', body: 'x' }, 'author'), RangeError);
  await assert.rejects(store.reply({ page: 'wiki/Other.html', markId: comment.id, body: 'x' }, 'author'), RangeError);
  // imported marks go after the page's own
  const extra = { ...marks[0], id: 'm-import1', thread: [{ ...marks[0].thread[0], id: 'm-import1-0' }] };
  await store.addAll(pageId, [extra]);
  await store.addAll(pageId, []);
  assert.deepEqual((await store.list(pageId)).map((m) => m.id), [comment.id, suggestion.id, 'm-import1']);
  // many at once are all kept, in the order sent
  await Promise.all(Array.from({ length: 6 }, (_, i) => store.reply({ page: pageId, markId: comment.id, body: `Reply ${i}.` }, 'author')));
  assert.deepEqual(onDisk(file).marks[0].thread.slice(2).map((e) => e.body), Array.from({ length: 6 }, (_, i) => `Reply ${i}.`));
});

test('a book chapter\'s marks are untouched by page marks, and the reverse', async (t) => {
  const { library, store, file } = storeFor(t);
  await store.add({ ...ids, kind: 'comment', anchor, body: 'Chapter.' }, 'author');
  const chapter = readFileSync(file, 'utf8');
  await store.add({ page: pageId, kind: 'comment', anchor, body: 'Page.' }, 'author');
  assert.equal(readFileSync(file, 'utf8'), chapter);
  assert.deepEqual(Object.keys((await store.listBook('book-fox-1')).chapters), ['c1']);
  assert.deepEqual((await store.list(pageId)).map((m) => m.thread[0].body), ['Page.']);
  // a page folder named like a book changes nothing for that book
  await store.add({ page: 'wiki/book-fox-1/chapters/c1.html', kind: 'comment', anchor, body: 'Look-alike.' }, 'author');
  assert.equal(readFileSync(file, 'utf8'), chapter);
  assert.equal(existsSync(path.join(library, '.neo', 'marks', 'wiki', 'book-fox-1', 'chapters', 'c1.html.json')), true);
});

test('a page sidecar that does not read is reported and never written over', async (t) => {
  const { library, store, lines } = storeFor(t);
  const file = pageSidecarPath(library, pageId);
  mkdirSync(path.dirname(file), { recursive: true });
  for (const junk of ['{"version": 1, "marks": [', '{"version": 2, "marks": []}']) {
    writeFileSync(file, junk);
    await assert.rejects(store.add({ page: pageId, kind: 'comment', anchor, body: 'Lost?' }, 'author'), MarkFileError);
    await assert.rejects(store.list(pageId), MarkFileError);
    await assert.rejects(store.addAll(pageId, [{} as Mark]), MarkFileError);
    assert.equal(readFileSync(file, 'utf8'), junk);
  }
  assert.ok(lines.some((l) => l.level === 'error' && /Harbour\.html\.json/.test(String(l.message) + JSON.stringify(l.data))));
});

// Rule: page marks never read or write through a link that leaves .neo/marks.
test('page marks are not read or written through a link that leaves .neo/marks', async (t) => {
  const { library, store, lines } = storeFor(t);
  const outside = path.join(library, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(path.join(library, '.neo', 'marks', 'wiki'), { recursive: true });
  const theirs = JSON.stringify({ version: 1, marks: [] });
  writeFileSync(path.join(outside, 'Leak.html.json'), theirs);
  symlinkSync(outside, path.join(library, '.neo', 'marks', 'wiki', 'link'), 'junction');
  symlinkSync(path.join(outside, 'Nowhere.json'), path.join(library, '.neo', 'marks', 'wiki', 'Gone.html.json'));
  assert.ok(existsSync(path.join(library, '.neo', 'marks', 'wiki', 'link', 'Leak.html.json')), 'the link leads out');
  const unsafe = (e: unknown) => e instanceof PageRefused && e.code === 'unsafe';

  await assert.rejects(store.list('wiki/link/Leak.html'), unsafe);
  await assert.rejects(store.add({ page: 'wiki/link/Leak.html', kind: 'comment', anchor, body: 'x' }, 'author'), unsafe);
  await assert.rejects(store.add({ page: 'wiki/link/deeper/New.html', kind: 'comment', anchor, body: 'x' }, 'author'), unsafe);
  await assert.rejects(store.add({ page: 'wiki/Gone.html', kind: 'comment', anchor, body: 'x' }, 'author'), unsafe, 'a link that leads nowhere');
  await assert.rejects(store.list('wiki/Gone.html'), unsafe);
  assert.deepEqual(readdirSync(outside).sort(), ['Leak.html.json'], 'nothing was written outside');
  assert.equal(readFileSync(path.join(outside, 'Leak.html.json'), 'utf8'), theirs);
  assert.ok(lines.some((l) => l.level === 'warn' && /marks/.test(l.message)), JSON.stringify(lines));

  assert.deepEqual(await store.list('wiki/Fine.html'), [], 'a page beside the links is read');
  await store.add({ page: 'wiki/Fine.html', kind: 'comment', anchor, body: 'ok' }, 'author');
  assert.equal((await store.list('wiki/Fine.html')).length, 1, 'and written');
});
