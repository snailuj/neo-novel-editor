import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { harness } from './support.ts';

// Rules for chapters. A read that fails says so with a typed error and never answers ''
// (an empty answer that is saved back wipes the chapter). A write never goes over words it
// has not seen: another device's text is handed back first, and a placeholder is never
// replaced.

test('a chapter round-trips, its stamp is mtime and size, and deleting is idempotent', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello', author: 'Ada' });
  const html = '<p>Once upon a time</p>';
  assert.equal(await h.store.writeChapter(book.id, 'c1', html), true);
  assert.equal(await h.store.readChapter(book.id, 'c1'), html);
  const st = fs.statSync(h.at(book.id, 'chapters', 'c1.html'));
  assert.deepEqual(await h.store.chapterStamps(book.id), { c1: st.mtimeMs + ':' + st.size });
  assert.equal(await h.store.deleteChapter(book.id, 'c1'), true);
  assert.equal(fs.existsSync(h.at(book.id, 'chapters', 'c1.html')), false);
  assert.equal(await h.store.deleteChapter(book.id, 'c1'), true);
  assert.deepEqual(await h.store.chapterStamps(book.id), {});
});

test('stamps cover chapter files only, and a book with no chapters folder has none', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  h.write([book.id, 'chapters', 'c1.html'], 'x');
  h.write([book.id, 'chapters', 'c1.html.tmp'], 'x');
  h.write([book.id, 'chapters', 'notes.txt'], 'x');
  assert.deepEqual(Object.keys(await h.store.chapterStamps(book.id)), ['c1']);
  fs.rmSync(h.at(book.id, 'chapters'), { recursive: true });
  assert.deepEqual(await h.store.chapterStamps(book.id), {});
  assert.deepEqual(await h.store.chapterStamps('..'), {});
});

test('a chapter with no file is not_found, never an empty string', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  await assert.rejects(h.store.readChapter(book.id, 'c1'), { code: 'not_found', message: /^\[store:not_found\] .*ENOENT/ });
});

test('a chapter the disk cannot read is unreadable, and an empty chapter reads as empty', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  fs.mkdirSync(h.at(book.id, 'chapters', 'c1.html'));
  await assert.rejects(h.store.readChapter(book.id, 'c1'), { code: 'unreadable' });
  h.write([book.id, 'chapters', 'c2.html'], '');
  assert.equal(await h.store.readChapter(book.id, 'c2'), '');
});

test('a chapter in iCloud is waited for and read; one that never comes is cloud_only, not empty', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const file = h.at(book.id, 'chapters', 'c1.html');
  h.write([book.id, 'chapters', 'c1.html'], 'placeholder');
  h.away.add(file);
  h.arrive.set(file, '<p>The harbor was empty.</p>');
  const answer = h.store.readChapter(book.id, 'c1');
  assert.equal(await answer, '<p>The harbor was empty.</p>');
  assert.ok(h.asked.includes(file));

  h.away.add(file);
  h.arrive.clear();
  await assert.rejects(h.store.readChapter(book.id, 'c1'), { code: 'cloud_only' });
});

test('a save never goes over a chapter still in iCloud: it fails, asks for the file, and leaves it', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const file = h.at(book.id, 'chapters', 'c1.html');
  h.write([book.id, 'chapters', 'c1.html'], 'placeholder');
  h.away.add(file);
  await assert.rejects(h.store.writeChapter(book.id, 'c1', '<p>new</p>', ''), { code: 'cloud_only' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'placeholder');
  assert.deepEqual(h.asked, [file]);
});

test('a chapter save makes the chapters folder when it is missing and leaves no .tmp behind', async () => {
  const h = harness();
  h.write([ 'book-x', 'book.json'], '{}');
  await h.store.writeChapter('book-x', 'c1', '<p>one</p>');
  await h.store.writeChapter('book-x', 'c1', '<p>two</p>');
  assert.deepEqual(fs.readdirSync(h.at('book-x', 'chapters')), ['c1.html']);
  assert.equal(await h.store.readChapter('book-x', 'c1'), '<p>two</p>');
});

// A write whose `expected` is not the disk's current text is refused and the disk text
// handed back, whatever the change was.
test('the disk text is handed back, and left alone, when another device changed it', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  await h.store.writeChapter(book.id, 'c1', '<p>red blue</p>');
  const remote = '<p><b>blue</b> red</p>';
  h.write([book.id, 'chapters', 'c1.html'], remote);
  assert.deepEqual(await h.store.writeChapter(book.id, 'c1', '<p>red blue green</p>', '<p>red blue</p>'), { conflict: remote });
  assert.equal(h.read(book.id, 'chapters', 'c1.html'), remote);
  assert.match(h.logs.join('\n'), /conflict: .*c1.* another device/);
});

test('formatting-only and reorder changes on disk are conflicts too', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const base = '<p>red blue</p>';
  for (const remote of ['<p><i>red</i> blue</p>', '<p>blue red</p>']) {
    await h.store.writeChapter(book.id, 'c1', base);
    h.write([book.id, 'chapters', 'c1.html'], remote);
    assert.deepEqual(await h.store.writeChapter(book.id, 'c1', '<p>red blue green</p>', base), { conflict: remote }, remote);
  }
});

test('a remote deletion is not restored by a stale save that holds the surviving words', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const base = '<p>red blue green</p>';
  await h.store.writeChapter(book.id, 'c1', base);
  h.write([book.id, 'chapters', 'c1.html'], '<p>red blue</p>');
  assert.deepEqual(await h.store.writeChapter(book.id, 'c1', base, base), { conflict: '<p>red blue</p>' });
  assert.equal(h.read(book.id, 'chapters', 'c1.html'), '<p>red blue</p>');
});

test('a repeated-word change is a conflict', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  await h.store.writeChapter(book.id, 'c1', '<p>red red blue</p>');
  h.write([book.id, 'chapters', 'c1.html'], '<p>red blue</p>');
  assert.deepEqual(await h.store.writeChapter(book.id, 'c1', '<p>red red blue red</p>', '<p>red red blue</p>'), { conflict: '<p>red blue</p>' });
});

test('an identical or retried write makes no twin', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  const remote = '<p><b>blue</b> red</p>';
  await h.store.writeChapter(book.id, 'c1', '<p>red blue</p>');
  h.write([book.id, 'chapters', 'c1.html'], remote);
  assert.equal(await h.store.writeChapter(book.id, 'c1', remote, '<p>red blue</p>'), true, 'the disk already holds what is written');
  h.write([book.id, 'chapters', 'c1.html'], remote);
  assert.deepEqual(await h.store.writeChapter(book.id, 'c1', '<p>red blue green</p>', '<p>red blue</p>'), { conflict: remote });
  assert.equal(await h.store.writeChapter(book.id, 'c1', '<p>red blue green</p>', remote), true, 'the retry is based on what is now on disk');
  assert.equal(await h.store.readChapter(book.id, 'c1'), '<p>red blue green</p>');
});

test('a disk chapter with no words is not a conflict, and a write that names no expected text is not checked', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  h.write([book.id, 'chapters', 'c1.html'], '<p><br></p>');
  assert.equal(await h.store.writeChapter(book.id, 'c1', '<p>new</p>', '<p>old</p>'), true);
  h.write([book.id, 'chapters', 'c1.html'], '<p>other device</p>');
  assert.equal(await h.store.writeChapter(book.id, 'c1', '<p>blind</p>'), true);
});

test('a first save of a chapter with an expected text finds nothing to keep', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Hello' });
  assert.equal(await h.store.writeChapter(book.id, 'c-new', '<p>one</p>', ''), true);
});
