import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { createICloud, hasBooks, insideFolder, libraryEntries, mergeLibraries, moveLibrary, pocketCloudLibrary } from '../../../src/store/index.ts';

// Rules for moving a library to another folder. The books are copied beside whatever is
// there, checked file by file, and the two library.json merged; nothing leaves the old folder
// (the caller trashes it once this has worked); and if anything fails, what was copied is
// taken away again, so the new folder is as it was.

const base = () => fs.mkdtempSync(path.join(tmpdir(), 'neo-move-'));
function book(lib: string, id: string, words = 'The stairs went down.') {
  fs.mkdirSync(path.join(lib, id, 'chapters'), { recursive: true });
  fs.writeFileSync(path.join(lib, id, 'book.json'), JSON.stringify({ id, title: id, chapterOrder: ['ch-1'] }));
  fs.writeFileSync(path.join(lib, id, 'chapters', 'ch-1.html'), `<p>${words}</p>`);
}
const libraryJson = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
const quiet = () => {};

function twoLibraries(ipad = true) {
  const root = base();
  const from = path.join(root, 'mac');
  const to = path.join(root, 'cloud');
  book(from, 'book-wool-1');
  book(from, 'book-shift-2');
  fs.writeFileSync(path.join(from, 'library.json'), JSON.stringify({
    authorName: 'Hugh Howey', penNames: [], firstRunDone: true, authors: [{ id: 'a1', name: 'Hugh Howey' }],
    shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: ['book-wool-1'] }, { id: 'shelf-mac', name: 'Silo', bookIds: ['book-shift-2'] }],
  }));
  if (ipad) {
    book(to, 'book-pocket-3', 'Written on the iPad.');
    fs.writeFileSync(path.join(to, 'library.json'), JSON.stringify({
      authorName: '', penNames: [], firstRunDone: true, authors: [{ id: 'a1', name: 'Anonymous' }],
      shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: ['book-pocket-3'] }],
    }));
  }
  return { root, from, to };
}

test('two libraries become one: shared shelves keep every book, the rest join', () => {
  const merged = mergeLibraries({
    authorName: '', penNames: ['A'], firstRunDone: true, authors: [{ id: 'a1', name: 'Anonymous' }],
    shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: ['b3'] }],
  }, {
    authorName: 'Hugh Howey', penNames: ['B'], authors: [{ id: 'a1', name: 'Hugh Howey' }, { id: 'a2', name: 'Margo Pruett' }],
    shelves: [{ id: 'shelf-1', name: 'Mine', bookIds: ['b1', 'b3'] }, { id: 'shelf-2', name: 'Silo', bookIds: ['b2'], authorId: 'a2' }],
  }) as unknown as { shelves: { id: string; name: string; bookIds: string[]; authorId?: string }[]; authors: { name: string }[]; penNames: string[]; authorName: string };
  assert.deepEqual(merged.shelves.map((s) => [s.id, s.name, s.bookIds]), [['shelf-1', 'Works in Progress', ['b3', 'b1']], ['shelf-2', 'Silo', ['b2']]]);
  assert.equal(merged.shelves[1].authorId, 'a2');
  assert.deepEqual(merged.authors.map((a) => a.name), ['Hugh Howey', 'Margo Pruett']);
  assert.deepEqual(merged.penNames, ['A', 'B']);
  assert.equal(merged.authorName, 'Hugh Howey');
  assert.deepEqual(mergeLibraries(null, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeLibraries({ a: 1 }, null), { a: 1 });
});

test('every book comes across beside the other library\'s, and the old folder is left whole', async () => {
  const { from, to } = twoLibraries();
  await moveLibrary(from, to, { log: quiet });
  for (const id of ['book-wool-1', 'book-shift-2', 'book-pocket-3']) assert.ok(fs.existsSync(path.join(to, id, 'chapters', 'ch-1.html')), id);
  assert.equal(fs.readFileSync(path.join(to, 'book-pocket-3', 'chapters', 'ch-1.html'), 'utf8'), '<p>Written on the iPad.</p>');
  const lib = libraryJson(to);
  assert.deepEqual(lib.shelves.find((s: { id: string }) => s.id === 'shelf-1').bookIds, ['book-pocket-3', 'book-wool-1']);
  assert.deepEqual(lib.shelves.find((s: { id: string }) => s.id === 'shelf-mac').bookIds, ['book-shift-2']);
  assert.equal(lib.authors[0].name, 'Hugh Howey');
  assert.ok(fs.existsSync(path.join(from, 'book-wool-1', 'book.json')), 'nothing leaves the old folder');
});

test('a book both folders have keeps the copy that is already there', async () => {
  const { from, to } = twoLibraries();
  book(to, 'book-wool-1', 'Already here.');
  await moveLibrary(from, to, { log: quiet });
  assert.equal(fs.readFileSync(path.join(to, 'book-wool-1', 'chapters', 'ch-1.html'), 'utf8'), '<p>Already here.</p>');
});

test('a copy that fails part way leaves both folders as they were', async () => {
  const { from, to } = twoLibraries();
  const real = fs.cpSync;
  let n = 0;
  const failing = mock.method(fs, 'cpSync', ((...a: Parameters<typeof fs.cpSync>) => {
    if (++n === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return real(...a);
  }) as typeof fs.cpSync);
  try {
    await assert.rejects(moveLibrary(from, to, { log: quiet }), /disk full/);
  } finally { failing.mock.restore(); }
  assert.deepEqual(fs.readdirSync(to).sort(), ['book-pocket-3', 'library.json']);
  assert.deepEqual(libraryJson(to).shelves[0].bookIds, ['book-pocket-3']);
  assert.ok(fs.existsSync(path.join(from, 'book-wool-1')) && fs.existsSync(path.join(from, 'book-shift-2')));
});

test('a book that arrives short is not counted as moved, and is taken away again', async () => {
  const { from, to } = twoLibraries(false);
  const real = fs.cpSync;
  const short = mock.method(fs, 'cpSync', ((src: string, dst: string, o: fs.CopySyncOptions) => {
    real(src, dst, o);
    if (String(dst).endsWith('book-wool-1')) fs.writeFileSync(path.join(dst, 'chapters', 'ch-1.html'), '<p>The</p>');
  }) as typeof fs.cpSync);
  try {
    await assert.rejects(moveLibrary(from, to, { log: quiet }), (e: { code?: string; message: string }) => e.code === 'EINCOMPLETE' && /book-wool-1/.test(e.message));
  } finally { short.mock.restore(); }
  assert.equal(fs.existsSync(path.join(to, 'book-wool-1')), false);
});

test('a library.json at the other end that iCloud has not brought down stops the move before anything is copied', async () => {
  const { from, to } = twoLibraries();
  const theirs = path.join(to, 'library.json');
  const icloud = createICloud({ platform: 'darwin', waitMs: 100, pollMs: 10, detect: (files) => new Set(files.filter((f) => f === theirs)), download: (_f, done) => setTimeout(done, 5) });
  await assert.rejects(moveLibrary(from, to, { log: quiet, icloud }), (e: { code?: string }) => e.code === 'cloud_only');
  assert.equal(fs.existsSync(path.join(to, 'book-wool-1')), false);
});

test('what a move carries is the books and what the writer keeps there, not NEO\'s half-written spares', () => {
  const dir = base();
  book(dir, 'book-a');
  for (const f of ['library.json', 'library.json.bak', 'library.json.tmp', '.neo-write-test', '.DS_Store', 'notes.txt']) fs.writeFileSync(path.join(dir, f), 'x');
  assert.deepEqual(libraryEntries(dir).sort(), ['book-a', 'notes.txt']);
  assert.equal(hasBooks(dir), true);
  fs.rmSync(path.join(dir, 'book-a'), { recursive: true });
  assert.equal(hasBooks(dir), false, 'a notes file is not a book');
  assert.deepEqual(libraryEntries(path.join(dir, 'nowhere')), []);
});

test('one folder inside another, or the same folder, is found by its path', () => {
  assert.equal(insideFolder('/a/b/c', '/a/b'), true);
  assert.equal(insideFolder('/a/b', '/a/b'), true);
  assert.equal(insideFolder('/a/b', '/a/b/c'), false);
  assert.equal(insideFolder('/a/bc', '/a/b'), false);
});

test('NEO Pocket\'s folder is found only on a Mac that has made it', () => {
  const home = base();
  assert.equal(pocketCloudLibrary({ home, platform: 'darwin' }), null);
  const docs = path.join(home, 'Library', 'Mobile Documents', 'iCloud~com~hughhowey~neo~pocket', 'Documents');
  fs.mkdirSync(docs, { recursive: true });
  assert.equal(pocketCloudLibrary({ home, platform: 'darwin' }), path.join(docs, 'NEO Library'));
  assert.equal(pocketCloudLibrary({ home, platform: 'linux' }), null);
  assert.equal(pocketCloudLibrary({ home, platform: 'win32' }), null);
});
