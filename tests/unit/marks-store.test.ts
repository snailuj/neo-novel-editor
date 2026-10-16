// Rules for the marks sidecars under .neo/:
// - a bad book or chapter name never reaches the disk;
// - a sidecar that does not read as the schema says is never written over;
// - each action reads the file afresh, so what another device wrote is kept;
// - actions on one file run one at a time, so none is lost;
// - reading never writes, and the main half, not the window, says when and by whom.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { validateHoardMarksV1 } from '../../src/generated/validators.cjs';
import { MarkFileError, MarkStore, sidecarPath } from '../../src/hoard/marks/store.ts';
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
    await assert.rejects(store.list(bad), TypeError);
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
    const listed = await store.list('book-fox-1');
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
  assert.deepEqual(await store.list('book-fox-1'), { chapters: {}, unreadable: [] });
  assert.equal(existsSync(path.join(library, '.neo')), false, 'a book with no marks makes no folder');
  await store.add({ ...ids, kind: 'comment', anchor, body: 'One.' }, 'author');
  await store.add({ bookId: 'book-fox-1', chId: 'c2', kind: 'highlight', anchor }, 'author');
  writeFileSync(file + '.tmp', '{"torn');
  const stamp = statSync(file).mtimeMs;
  wrote.length = 0;
  const listed = await store.list('book-fox-1');
  assert.deepEqual(Object.keys(listed.chapters).sort(), ['c1', 'c2']);
  assert.equal(listed.chapters.c2[0].kind, 'highlight');
  assert.deepEqual(listed.unreadable, []);
  assert.equal(statSync(file).mtimeMs, stamp);
  assert.deepEqual(wrote, []);
});
