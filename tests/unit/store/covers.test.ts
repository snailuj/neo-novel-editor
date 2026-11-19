import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { harness } from './support.ts';

// Rules for a book's cover and painting. They are images in the book's own folder, so they
// travel with the library: the old cover is never removed before the new one is in, and an
// image that cannot be had reads as "no cover", never as an error the shelf has to survive.

const PNG = Buffer.from('iVBORw0KGgo=', 'base64');
const picked = (name: string, bytes: Buffer = PNG) => {
  const file = path.join(fs.mkdtempSync(path.join(tmpdir(), 'neo-picked-')), name);
  fs.writeFileSync(file, bytes);
  return file;
};
const covers = (dir: string) => fs.readdirSync(dir).filter((f) => /^cover-\d+\./.test(f));

test('a picked image becomes the book\'s one cover, and the one before it goes', async () => {
  const h = harness();
  const book = await h.withBook();
  const first = await h.store.setCover(book.id, picked('a.PNG'));
  assert.match(first as string, /^cover-\d+\.png$/);
  await new Promise((resolve) => setTimeout(resolve, 3)); // names carry the time they were made
  const second = await h.store.setCover(book.id, picked('b.jpeg', Buffer.from('jpg')));
  assert.match(second as string, /^cover-\d+\.jpg$/);
  assert.deepEqual(covers(h.at(book.id)), [second]);
});

test('a cover that cannot be copied leaves the old cover where it was', async () => {
  const h = harness();
  const book = await h.withBook();
  const first = await h.store.setCover(book.id, picked('a.png'));
  await assert.rejects(h.store.setCover(book.id, path.join(tmpdir(), 'neo-no-such-image.png')));
  assert.deepEqual(covers(h.at(book.id)), [first]);
});

test('the picked file may be the current cover itself', async () => {
  const h = harness();
  const book = await h.withBook();
  const first = (await h.store.setCover(book.id, picked('a.png'))) as string;
  await new Promise((resolve) => setTimeout(resolve, 3));
  const again = (await h.store.setCover(book.id, h.at(book.id, first))) as string;
  assert.notEqual(again, first);
  assert.deepEqual(covers(h.at(book.id)), [again]);
  assert.deepEqual(fs.readFileSync(h.at(book.id, again)), PNG);
});

test('a file that is not an image type, or a book that is not there, sets nothing', async () => {
  const h = harness();
  const book = await h.withBook();
  assert.equal(await h.store.setCover(book.id, picked('notes.txt')), null);
  assert.equal(await h.store.setCover('book-nope', picked('a.png')), null);
  assert.deepEqual(covers(h.at(book.id)), []);
  assert.equal(fs.existsSync(h.at('book-nope')), false);
});

test('removing covers takes every cover of the book and nothing else', async () => {
  const h = harness();
  const book = await h.withBook();
  h.write([book.id, 'cover-1.png'], 'x');
  h.write([book.id, 'cover-2.jpg'], 'x');
  h.write([book.id, 'art-3.png'], 'x');
  assert.equal(await h.store.removeCover(book.id), true);
  assert.deepEqual(covers(h.at(book.id)), []);
  assert.ok(fs.existsSync(h.at(book.id, 'art-3.png')), 'the painting is not a cover');
  assert.equal(await h.store.removeCover('book-nope'), true);
});

test('a cover reads back as base64 with its type, and anything that is not a cover name or not readable is null', async () => {
  const h = harness();
  const book = await h.withBook();
  const name = (await h.store.setCover(book.id, picked('a.png'))) as string;
  assert.deepEqual(await h.store.readCover(book.id, name), { base64: PNG.toString('base64'), mime: 'image/png', ext: 'png' });
  h.write([book.id, 'art-7.webp'], 'w');
  assert.equal((await h.store.readCover(book.id, 'art-7.webp'))?.mime, 'image/webp');
  assert.equal(await h.store.readCover(book.id, 'cover-99.png'), null, 'not there');
  assert.equal(await h.store.readCover(book.id, '../book.json'), null, 'not a cover name');
  assert.equal(await h.store.readCover(book.id, 'book.json'), null);
  assert.equal(await h.store.readCover('..', 'cover-1.png'), null, 'not a book name');
});

test('a cover still in iCloud is asked for and reads as no cover until it is here', async () => {
  const h = harness();
  const book = await h.withBook();
  const name = (await h.store.setCover(book.id, picked('a.png'))) as string;
  h.away.add(h.at(book.id, name));
  assert.equal(await h.store.readCover(book.id, name), null);
  assert.ok(h.asked.includes(h.at(book.id, name)));
});
