import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { harness } from './support.ts';

// Rules for the library index and the books in it. A library is a folder of plain files
// the writer can inspect, sync and back up, so: nothing is ever replaced by something
// emptier, a recovery is logged, and what iCloud has not brought down is waited for and
// never written over.

const shelves = (lib: Record<string, unknown>) => lib.shelves as { id: string; name: string; bookIds: string[] }[];

test('a new library gets one empty shelf, and a library.json that exists is never reseeded', async () => {
  const h = harness({ dir: path.join(fs.mkdtempSync(path.join(tmpdir(), 'neo-new-')), 'NEO Library'), t: (s) => `<${s}>` });
  const lib = await h.store.readLibrary();
  assert.equal(shelves(lib)[0].name, '<Works in Progress>');
  assert.deepEqual(shelves(lib)[0].bookIds, []);
  assert.equal(lib.firstRunDone, false);
  assert.equal(JSON.parse(h.read('library.json')).pageTheme, 'night');
  h.write(['library.json'], JSON.stringify({ shelves: [{ id: 's', name: 'Mine', bookIds: ['book-x'] }] }));
  assert.equal(shelves(await h.store.readLibrary())[0].name, 'Mine');
  fs.rmSync(path.dirname(h.dir), { recursive: true, force: true });
});

test('an emptied library.json comes back from its .bak, and the recovery is logged', async () => {
  const h = harness();
  const book = await h.withBook();
  fs.writeFileSync(h.at('library.json'), '');
  assert.ok(shelves(await h.store.readLibrary())[0].bookIds.includes(book.id));
  assert.match(h.logs.join('\n'), /recovered: .*library\.json was unreadable; restored from library\.json\.bak/);
  assert.ok(shelves(JSON.parse(h.read('library.json')))[0].bookIds.includes(book.id), 'and the file is whole again');
});

test('library.json deleted outright: its .bak brings the shelves back, not an empty seed', async () => {
  const h = harness();
  const book = await h.withBook();
  fs.rmSync(h.at('library.json'));
  assert.ok(shelves(await h.store.readLibrary())[0].bookIds.includes(book.id));
});

test('library.json and every copy gone: the book folders fill one shelf, and nothing disappears', async () => {
  const h = harness();
  const book = await h.withBook();
  fs.rmSync(h.at('library.json.bak'));
  fs.writeFileSync(h.at('library.json'), '{"shel');
  const lib = await h.store.readLibrary();
  assert.ok(shelves(lib)[0].bookIds.includes(book.id));
  assert.equal(lib.firstRunDone, true);
  assert.match(h.logs.join('\n'), /recovered: library\.json was lost; 1 books put back on one shelf/);
});

test('library.json deleted beside its books is not a new library, so no empty seed hides them', async () => {
  const h = harness();
  const book = await h.withBook();
  fs.rmSync(h.at('library.json'));
  fs.rmSync(h.at('library.json.bak'));
  await h.store.readLibrary();
  assert.ok(shelves(JSON.parse(h.read('library.json')))[0].bookIds.includes(book.id));
});

test('library.json in iCloud arrives and is read; one that never arrives is an error and is not written over', async () => {
  const h = harness();
  await h.withBook();
  const words = h.read('library.json');
  fs.writeFileSync(h.at('library.json'), '');
  h.away.add(h.at('library.json'));
  h.arrive.set(h.at('library.json'), words);
  const lib = await h.store.readLibrary();
  assert.equal(shelves(lib).length, 1);
  assert.ok(h.asked.includes(h.at('library.json')));

  h.away.add(h.at('library.json'));
  h.arrive.delete(h.at('library.json'));
  fs.writeFileSync(h.at('library.json'), 'placeholder');
  await assert.rejects(h.store.readLibrary(), { code: 'cloud_only' });
  assert.equal(h.read('library.json'), 'placeholder');
});

test('peeking at the library reads the file as it is, and says nothing when there is nothing to read', async () => {
  const h = harness();
  assert.equal(await h.store.peekLibrary(), null);
  assert.deepEqual(fs.readdirSync(h.dir), [], 'nothing is created');
  h.write(['library.json'], JSON.stringify({ spellLanguage: 'fr' }));
  assert.deepEqual(await h.store.peekLibrary(), { spellLanguage: 'fr' });
  h.write(['library.json'], '[1]');
  assert.equal(await h.store.peekLibrary(), null);
  h.away.add(h.at('library.json'));
  await assert.rejects(h.store.peekLibrary(), { code: 'cloud_only' });
});

test('writing the library regenerates the catalog and drops a hand edit, and leaves an unchanged catalog alone', async () => {
  const h = harness();
  const book = await h.withBook();
  const lib = await h.store.readLibrary();
  assert.equal(await h.store.writeLibrary(lib), true);
  const text = h.read('_catalog.txt');
  assert.match(text, /NEO LIBRARY CATALOG — which folder is which book/);
  assert.match(text, /regenerated automatically; edits here do nothing/);
  assert.match(text, new RegExp(`The Long Night  —  ${book.id}  —  shelf: Works in Progress`));

  const before = fs.statSync(h.at('_catalog.txt'));
  await new Promise((resolve) => setTimeout(resolve, 15));
  await h.store.writeLibrary(lib);
  assert.equal(fs.statSync(h.at('_catalog.txt')).mtimeMs, before.mtimeMs, 'not rewritten when nothing changed');

  fs.writeFileSync(h.at('_catalog.txt'), 'a writer edited this file\n');
  await h.store.writeLibrary(lib);
  assert.doesNotMatch(h.read('_catalog.txt'), /a writer edited/);
});

test('a book still in iCloud is never dropped from the catalog: the catalog is left as it was', async () => {
  const h = harness();
  const book = await h.withBook();
  const lib = await h.store.readLibrary();
  await h.store.writeLibrary(lib);
  const before = h.read('_catalog.txt');
  h.away.add(h.at(book.id, 'book.json'));
  await h.store.writeLibrary({ ...lib, shelves: [] });
  assert.equal(h.read('_catalog.txt'), before);
  assert.ok(h.asked.includes(h.at(book.id, 'book.json')), 'iCloud was asked for it');
});

test('a new book is a folder with its book.json, chapters folder, notes, outline and sidecars', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Capítulo', author: 'Ada' });
  assert.match(book.id, /^book-capitulo-[0-9a-z]+-[0-9a-z]{5}$/);
  assert.equal(book.title, 'Capítulo');
  assert.equal(book.author, 'Ada');
  assert.deepEqual(book.chapterOrder, []);
  assert.equal(JSON.parse(h.read(book.id, 'book.json')).id, book.id);
  assert.ok(fs.statSync(h.at(book.id, 'chapters')).isDirectory());
  assert.equal(h.read(book.id, 'notes.html'), '');
  assert.equal(h.read(book.id, 'outline.html'), '');
  assert.deepEqual(JSON.parse(h.read(book.id, 'darlings.json')), []);
  assert.deepEqual(JSON.parse(h.read(book.id, 'stickies.json')), []);
  const blank = await h.store.createBook({ title: '' });
  assert.match(blank.id, /^book-[0-9a-z]+-[0-9a-z]{5}$/);
  assert.equal(blank.title, 'Untitled');
  assert.equal(blank.author, 'Anonymous');
});

test('every folder in the library that is a book is listed under its folder name, shelved or not', async () => {
  const h = harness();
  const book = await h.withBook();
  fs.cpSync(h.at(book.id), h.at(book.id + ' copy'), { recursive: true });
  fs.mkdirSync(h.at('book-empty'));
  fs.mkdirSync(h.at('Backups'));
  h.write(['book-broken', 'book.json'], '{"id":');
  const listed = await h.store.listBooks();
  assert.deepEqual(listed.map((b) => b.id).sort(), [book.id, book.id + ' copy'].sort());
  assert.equal(listed.find((b) => b.id === book.id)?.title, 'The Long Night');
});

test('a book whose book.json is in iCloud is left out of the listing, not read or rebuilt', async () => {
  const h = harness();
  const book = await h.withBook();
  h.away.add(h.at(book.id, 'book.json'));
  assert.deepEqual(await h.store.listBooks(), []);
  assert.ok(h.asked.includes(h.at(book.id, 'book.json')));
});

test('an emptied book.json comes back from its .bak and is whole again on disk', async () => {
  const h = harness();
  const book = await h.withBook();
  fs.writeFileSync(h.at(book.id, 'book.json'), '');
  const meta = await h.store.readBookMeta(book.id);
  assert.equal(meta?.title, 'The Long Night');
  assert.deepEqual(meta?.chapterOrder, ['ch-aaa', 'ch-bbb']);
  assert.equal(JSON.parse(h.read(book.id, 'book.json')).title, 'The Long Night');
});

test('a half-written book.json is read from the .tmp it left', async () => {
  const h = harness();
  const book = await h.withBook();
  const whole = h.read(book.id, 'book.json');
  fs.writeFileSync(h.at(book.id, 'book.json.tmp'), whole);
  fs.writeFileSync(h.at(book.id, 'book.json'), whole.slice(0, 20));
  assert.equal((await h.store.readBookMeta(book.id))?.title, 'The Long Night');
});

test('a book.json lost with no copy is rebuilt from its chapter files, titled from the catalog, and logged', async () => {
  const h = harness();
  const book = await h.withBook();
  for (const f of ['book.json', 'book.json.bak', 'book.json.tmp']) fs.rmSync(h.at(book.id, f), { force: true });
  fs.writeFileSync(h.at(book.id, 'book.json'), '\0\0\0');
  const meta = await h.store.readBookMeta(book.id);
  assert.equal(meta?.id, book.id);
  assert.equal(meta?.title, 'The Long Night');
  assert.deepEqual(meta?.chapterOrder, ['ch-aaa', 'ch-bbb']);
  assert.match(h.logs.join('\n'), /recovered: .*book\.json was lost; rebuilt from 2 chapter files/);
  assert.equal(JSON.parse(h.read(book.id, 'book.json')).title, 'The Long Night');
});

test('a book folder with no chapters folder has nothing to rebuild from', async () => {
  const h = harness();
  h.write(['book-bare', 'notes.html'], '');
  assert.equal(await h.store.readBookMeta('book-bare'), null);
  assert.equal(fs.existsSync(h.at('book-bare', 'book.json')), false);
});

test('a copied folder answers to its own name', async () => {
  const h = harness();
  const book = await h.withBook();
  fs.cpSync(h.at(book.id), h.at(book.id + ' copy'), { recursive: true });
  assert.equal((await h.store.readBookMeta(book.id + ' copy'))?.id, book.id + ' copy');
});

test('a book.json iCloud never brings down is a book that waits: null, never rebuilt or rolled back', async () => {
  const h = harness();
  const book = await h.withBook();
  h.away.add(h.at(book.id, 'book.json'));
  assert.equal(await h.store.readBookMeta(book.id), null);
  const stub = harness();
  stub.write(['book-x', 'chapters', 'c.html'], '<p>x</p>');
  stub.write(['book-x', '.book.json.icloud'], '');
  assert.equal(await stub.store.readBookMeta('book-x'), null, 'the older stand-in too');
  assert.equal(fs.existsSync(stub.at('book-x', 'book.json')), false);
});

test('book.json is not written over a chapter list naming a chapter the window has never seen', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Two', author: 'Ada' });
  const mine = { ...book, chapterOrder: ['c1', 'c2'] };
  assert.equal(typeof await h.store.writeBookMeta(book.id, mine, ['c1', 'c2']), 'string');
  // another device adds c3 and its book.json arrives
  h.write([book.id, 'book.json'], JSON.stringify({ ...mine, chapterOrder: ['c1', 'c2', 'c3'] }));
  assert.deepEqual(await h.store.writeBookMeta(book.id, { ...mine, wordCount: 9 }, ['c1', 'c2']), { unseen: ['c3'] });
  assert.deepEqual(JSON.parse(h.read(book.id, 'book.json')).chapterOrder, ['c1', 'c2', 'c3'], 'left as the other device wrote it');
  // once the window has taken c3 in, or taken it out on purpose, the save lands
  assert.equal(typeof await h.store.writeBookMeta(book.id, { ...mine, chapterOrder: ['c1', 'c2', 'c3'] }, ['c1', 'c2', 'c3']), 'string');
  assert.equal(typeof await h.store.writeBookMeta(book.id, mine, ['c1', 'c2', 'c3']), 'string');
  assert.deepEqual(JSON.parse(h.read(book.id, 'book.json')).chapterOrder, ['c1', 'c2']);
  // a save that names no chapters it knows (the shelf's own) is not checked
  h.write([book.id, 'book.json'], JSON.stringify({ ...mine, chapterOrder: ['c1', 'c2', 'c4'] }));
  assert.equal(typeof await h.store.writeBookMeta(book.id, mine), 'string');
});

test('a book.json that cannot be compared with does not hold up a save', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Two' });
  h.write([book.id, 'book.json'], '{"id":');
  assert.equal(typeof await h.store.writeBookMeta(book.id, book, ['c1']), 'string');
});

test('a save stamps modified, and the stamp is what it returns', async () => {
  const h = harness();
  const book = await h.store.createBook({ title: 'Two' });
  const stamp = await h.store.writeBookMeta(book.id, { ...book, modified: 'old' });
  assert.equal(JSON.parse(h.read(book.id, 'book.json')).modified, stamp);
  assert.notEqual(stamp, 'old');
});

test('a copy of a book has every file but the spare copies, under a new id and title, and the original is untouched', async () => {
  const h = harness();
  const book = await h.withBook();
  h.write([book.id, 'covers', 'cover.png'], 'png');
  h.write([book.id, 'chapters', 'ch-aaa.html.tmp'], 'half');
  fs.writeFileSync(h.at(book.id, 'book.json'), JSON.stringify({ ...JSON.parse(h.read(book.id, 'book.json')), uuid: 'u-1' }));
  const before = h.read(book.id, 'book.json');
  const copy = await h.store.duplicateBook(book.id, 'Second Draft');
  assert.notEqual(copy.id, book.id);
  assert.equal(copy.title, 'Second Draft');
  assert.equal('uuid' in copy, false, 'an ebook store sees a new book');
  assert.equal(h.read(copy.id, 'chapters', 'ch-aaa.html'), '<p>First chapter.</p>');
  assert.equal(h.read(copy.id, 'covers', 'cover.png'), 'png');
  assert.deepEqual(fs.readdirSync(h.at(copy.id, 'chapters')).sort(), ['ch-aaa.html', 'ch-bbb.html']);
  assert.equal(fs.existsSync(h.at(copy.id, 'book.json.bak')), false);
  assert.equal(JSON.parse(h.read(copy.id, 'book.json')).id, copy.id);
  assert.match(h.read('_catalog.txt'), /Second Draft/);
  assert.equal(h.read(book.id, 'book.json'), before);
});

test('a book with something still in iCloud is not copied: iCloud is asked, and the writer is told to try again', async () => {
  const h = harness();
  const book = await h.withBook();
  h.away.add(h.at(book.id, 'chapters', 'ch-aaa.html'));
  await assert.rejects(h.store.duplicateBook(book.id, 'Copy'), { code: 'cloud_only' });
  assert.ok(h.asked.includes(h.at(book.id, 'chapters', 'ch-aaa.html')));
  assert.deepEqual(fs.readdirSync(h.dir).filter((d) => d.startsWith('book-')), [book.id]);
  h.away.clear();
  h.write([book.id, 'chapters', '.ch-ccc.html.icloud'], '');
  await assert.rejects(h.store.duplicateBook(book.id, 'Copy'), { code: 'cloud_only' });
});

test('a copy that fails half-way is removed and the error goes to the caller; a book that cannot be read is not copied', async () => {
  const h = harness();
  const book = await h.withBook();
  const real = fs.readFileSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file).endsWith('ch-bbb.html')) throw Object.assign(new Error('EIO: disk gone'), { code: 'EIO' });
    return (real as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  try {
    await assert.rejects(h.store.duplicateBook(book.id, 'Copy'), { code: 'EIO' });
  } finally {
    fs.readFileSync = real;
  }
  assert.deepEqual(fs.readdirSync(h.dir).filter((d) => d.startsWith('book-')), [book.id], 'no half-made copy');
  assert.match(h.logs.join('\n'), /duplicate: EIO/);
  await assert.rejects(h.store.duplicateBook('book-nothing', 'Copy'), { code: 'unreadable' });
});

test('a book goes to the system trash through the mover; when it cannot, the book is untouched and shown to the writer', async () => {
  const h = harness();
  const book = await h.withBook();
  const trashed: string[] = [];
  assert.equal(await h.store.trashBook(book.id, { trash: async (f) => { trashed.push(f); }, reveal: () => assert.fail('revealed') }), true);
  assert.deepEqual(trashed, [h.at(book.id)]);

  const revealed: string[] = [];
  const refused = await h.store.trashBook(book.id, {
    trash: async () => { throw new Error('no trash on this drive'); },
    reveal: (f) => { revealed.push(f); },
  });
  assert.equal(refused, false);
  assert.deepEqual(revealed, [h.at(book.id)]);
  assert.match(h.logs.join('\n'), /trash: no trash on this drive/);
  assert.ok(fs.existsSync(h.at(book.id, 'book.json')));
});

test('opening a library makes the folder and one shelf when it is new, and changes nothing when it is not', () => {
  const h = harness({ dir: path.join(fs.mkdtempSync(path.join(tmpdir(), 'neo-open-')), 'NEO Library') });
  h.store.ensureLibrary();
  const seeded = h.read('library.json');
  assert.equal(shelves(JSON.parse(seeded)).length, 1);
  h.write(['library.json'], '{"shelves":[]}');
  h.store.ensureLibrary();
  assert.equal(h.read('library.json'), '{"shelves":[]}');
  fs.rmSync(path.dirname(h.dir), { recursive: true, force: true });
});
