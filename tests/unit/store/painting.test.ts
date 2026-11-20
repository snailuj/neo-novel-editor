import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mock, test } from 'node:test';
import { harness } from './support.ts';

// Rule: art.json never names a painting that is not on disk. The new painting and its
// art.json are in place before the old painting goes, so a write that fails at any step
// leaves the book with the painting it had.

const art = { brief: 'a lighthouse at dusk', provider: 'openai', textModel: 't', imageModel: 'i' };
const paintings = (h: ReturnType<typeof harness>, id: string) => fs.readdirSync(h.at(id)).filter((f) => /^art-\d+\./.test(f));
const named = (h: ReturnType<typeof harness>, id: string) => JSON.parse(h.read(id, 'art.json')).file as string;

// refuses to start the durable write of any file whose name matches
function refuse(pattern: RegExp) {
  const real = fs.openSync;
  return mock.method(fs, 'openSync', ((file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string' && pattern.test(file)) throw Object.assign(new Error('refused: ' + file), { code: 'EACCES' });
    return (real as (...a: unknown[]) => number)(file, ...rest);
  }) as typeof fs.openSync);
}

test('a painting is written with its brief, art.json names it, and older paintings go', async () => {
  const h = harness();
  const book = await h.withBook();
  h.write([book.id, 'art-1.png'], 'old');
  h.write([book.id, 'cover-5.png'], 'mine');
  const name = await h.store.writePainting(book.id, { buffer: Buffer.from('new'), ext: 'webp', art });
  assert.match(name, /^art-\d+\.webp$/);
  assert.deepEqual(paintings(h, book.id), [name]);
  assert.equal(h.read(book.id, name), 'new');
  const json = JSON.parse(h.read(book.id, 'art.json'));
  assert.equal(json.file, name);
  assert.equal(json.brief, art.brief);
  assert.equal(json.provider, 'openai');
  assert.ok(!Number.isNaN(Date.parse(json.painted)));
  assert.equal(h.read(book.id, 'cover-5.png'), 'mine', 'the writer\'s own cover is untouched');
});

test('a painting that cannot be written leaves the old painting and art.json as they were', async () => {
  const h = harness();
  const book = await h.withBook();
  const before = await h.store.writePainting(book.id, { buffer: Buffer.from('old'), ext: 'png', art });
  const jsonBefore = h.read(book.id, 'art.json');
  await new Promise((resolve) => setTimeout(resolve, 3));
  const refusing = refuse(/art-\d+\.jpg\.tmp$/);
  try {
    await assert.rejects(h.store.writePainting(book.id, { buffer: Buffer.from('new'), art }), /refused/);
  } finally { refusing.mock.restore(); }
  assert.deepEqual(paintings(h, book.id), [before]);
  assert.equal(h.read(book.id, 'art.json'), jsonBefore);
  assert.equal(named(h, book.id), before);
});

test('an art.json that cannot be written leaves the old pair, and the new image is not left behind', async () => {
  const h = harness();
  const book = await h.withBook();
  const before = await h.store.writePainting(book.id, { buffer: Buffer.from('old'), ext: 'png', art });
  const jsonBefore = h.read(book.id, 'art.json');
  await new Promise((resolve) => setTimeout(resolve, 3));
  const refusing = refuse(/art\.json\.tmp$/);
  try {
    await assert.rejects(h.store.writePainting(book.id, { buffer: Buffer.from('new'), ext: 'png', art }), /refused/);
  } finally { refusing.mock.restore(); }
  assert.deepEqual(paintings(h, book.id), [before]);
  assert.equal(h.read(book.id, 'art.json'), jsonBefore);
});

test('a book that is not there is a not_found error, and hasBook tells beforehand', async () => {
  const h = harness();
  const book = await h.withBook();
  assert.equal(await h.store.hasBook(book.id), true);
  assert.equal(await h.store.hasBook('book-nope'), false);
  await assert.rejects(h.store.writePainting('book-nope', { buffer: Buffer.from('x'), art }), (e: { code?: string }) => e.code === 'not_found');
  assert.equal(fs.existsSync(h.at('book-nope')), false);
});
