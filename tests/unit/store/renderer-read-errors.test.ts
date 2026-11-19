import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import vm from 'node:vm';
import { createFsStore, StoreError, type FsStore } from '../../../src/store/index.ts';

// Rules for how the window takes a failed read of a chapter or a page. The store says which
// way a read failed ([store:<code>] in the message, which is all Electron lets across); the
// window must never turn a failure into an empty page it then saves:
//   - a chapter that is new here or not yet synced, and known to be, reads as an empty new
//     chapter, whose base is '' so a file that arrives later is kept as a twin, never replaced;
//   - any other failed read leaves what the window holds as it was, and nothing is saved over it;
//   - a page the book has never had reads as null, and is saved against ''.
// The window's own code runs here, in a vm, against a real store on a temp library.

type Anything = any;
const root = path.join(import.meta.dirname, '..', '..', '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const core = read('app/core.js');
const saving = read('app/saving.js');
const editor = read('app/editor.js');
const cards = read('app/cards.js');

const slice = (source: string, from: string, to: string) => {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `the window's code moved: ${from}`);
  return source.slice(a, b);
};
const settle = () => new Promise((resolve) => setImmediate(resolve));

// what Electron makes of a handler's rejection on its way to the window
const overIpc = (channel: string) => (err: Error) => {
  throw new Error(`Error invoking remote method '${channel}': ${err.name}: ${err.message}`);
};

function library() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'neo-read-errors-'));
  const logs: string[] = [];
  const store = createFsStore({ root: dir, log: (s, d) => logs.push(`${s}: ${String(d)}`) });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store, logs };
}

// window.neo over the store, as the preload and main.js make it
function bridge(store: FsStore, logged: string[]) {
  const writes: { chId: string; html: string; expected?: string }[] = [];
  const neo: Record<string, (...args: Anything[]) => Anything> = {
    readChapter: (b, c) => store.readChapter(b, c).catch(overIpc('chapter:read')),
    writeChapter: (b, c, html, expected) => { writes.push({ chId: c, html, expected }); return store.writeChapter(b, c, html, expected); },
    chapterStamps: (b) => store.chapterStamps(b),
    readBookMeta: (b) => store.readBookMeta(b),
    writeBookMeta: (b, meta, known) => store.writeBookMeta(b, meta, known),
    readJSON: (b, n, f) => store.readJSON(b, n, f),
    readAux: (b, n) => store.readAux(b, n).catch(overIpc('aux:read')),
    writeAux: (b, n, html, expected) => store.writeAux(b, n, html, expected),
    logError: (m) => logged.push(String(m)),
  };
  return { neo, writes };
}

test('the window reads the code of a store error out of what Electron passes across, for every code', () => {
  const helper = slice(core, 'function storeErrorCode(', '\n}\n') + '\n}';
  const { storeErrorCode } = vm.runInNewContext(`${helper}; ({ storeErrorCode })`) as { storeErrorCode: (e: unknown) => string | null };
  for (const code of ['not_found', 'cloud_only', 'unreadable', 'bad_name', 'exists', 'blocked'] as const) {
    const err = new StoreError(code, 'a message');
    assert.equal(storeErrorCode(new Error(`Error invoking remote method 'chapter:read': ${err.name}: ${err.message}`)), code);
    assert.equal(storeErrorCode(err), code, 'and straight from the store');
  }
  assert.equal(storeErrorCode(new Error('ENOENT: no such file')), null);
  assert.equal(storeErrorCode(null), null);
  assert.equal(storeErrorCode('[store:not_found] as a string'), 'not_found');
});

// ---- the window's own code ----

function windowFor(store: FsStore, bookId: string) {
  const logged: string[] = [];
  const { neo, writes } = bridge(store, logged);
  const toasts: string[] = [];
  const none = () => {};
  const context = vm.createContext({
    window: { neo, addEventListener: none },
    document: { addEventListener: none, execCommand: none, createElement: () => ({ children: [], innerHTML: '', textContent: '' }), visibilityState: 'visible' },
    console,
    setTimeout,
    setInterval: () => 0,
    clearTimeout,
    $: () => ({ scrollTop: 0, dataset: {}, hidden: false }),
    $$: () => [{}],
    t: (s: string, v?: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k) => v?.[k] ?? ''),
    toast: (m: string) => toasts.push(m),
    NeoI18n: { getLocale: () => 'en' },
    // the page and the rest of the window, which do not matter here
    renderChapters: none, renderStickies: none, renderDarlings: none, renderNav: none, updateCounters: none, scheduleNavRefresh: none,
    scheduleMetaSave: none, captureCaret: () => null, restoreCaret: none, showTitleStyle: none, isUntitled: () => false, tabName: () => '',
    resumePosition: () => false, applyDeviceLook: (l: unknown) => l, renderShelves: none, writeSidecar: async () => {}, saveMeta: async () => {},
    writeBookMeta: async (id: string, meta: unknown) => store.writeBookMeta(id, meta as Anything),
    bookWordCount: () => 0, sprint: null, wordMode: 'book', refreshOpenAux: async () => {}, flushAux: none, flushStickiesSave: none, flushSidecars: none,
    bookMetaCache: { clear: none, set: none }, shelfExport: false, library: { shelves: [], hintShown: true }, libraryGeneration: 0, libraryWritesPending: 0, lastHereActivity: 0,
    onlyDrops: () => false, wordsBeyond: (a: string, b: string) => a !== b, mergeSidecar: (_b: unknown, _l: unknown, r: unknown) => r,
    undoStack: [], redoStack: [], tabPlaces: {}, currentTab: 'manuscript', currentChapterId: null,
    chapterTitles: {}, chapterKind: () => 'chapter',
    showWindowTitle: none, forgetSnapshots: none, forgetSpelling: none, applyBright: none, spEditorMode: none, migrateDarlingAnchors: none, reconcileMarks: none,
    switchTab: none, isScript: () => false, vimRest: none, requestAnimationFrame: none, KHELP: 'Ctrl', spReportState: none, writeLibrary: async () => {},
  });
  // the window's state, and the code under test
  vm.runInContext(`
    let book = null, chapterHTML = {}, savedHTML = {}, savedMetaSig = '', knownChapters = new Set(), savedOrder = [], diskStamps = {}, writing = {};
    let stickies = [], darlings = [], wordCache = {}, saveTimers = {}, sidecarPending = {}, sidecarBase = {}, daySeen = null, auxDirty = false;
    const metaSig = (b) => JSON.stringify(b.chapterOrder);
    const todayStr = () => '2026-11-19';
  `, context);
  vm.runInContext(slice(core, 'function storeErrorCode(', '\n}\n') + '\n}\n' + slice(core, 'async function readNewChapter(', '\n}\n') + '\n}\n', context);
  vm.runInContext(slice(saving, 'const diskKnown = {};', '// Another device\'s version of a chapter'), context);
  vm.runInContext(slice(saving, 'function worthKeeping(', 'async function keepOtherDeviceVersion('), context);
  vm.runInContext(slice(saving, 'async function keepOtherDeviceVersion(', '// book.json minus the parts'), context);
  vm.runInContext(slice(saving, 'const dayWords = ', '// ---- end of daily words rules ----'), context);
  vm.runInContext('function wordsFromDisk() {}', context);
  vm.runInContext(slice(saving, 'let refreshing = false;', 'window.addEventListener(\'focus\''), context);
  vm.runInContext(slice(editor, 'let openGeneration = 0;', 'function renderChapters('), context);
  vm.runInContext(slice(cards, 'const auxPending = {};', '// The same promise for the JSON beside a book'), context);
  const run = (code: string) => vm.runInContext(code, context) as Anything;
  const plain = (code: string) => JSON.parse(JSON.stringify(run(code)));
  const open = async (chapters: Record<string, string>) => {
    const meta = (await store.readBookMeta(bookId))!;
    run(`book = ${JSON.stringify(meta)}; knownChapters = new Set(book.chapterOrder); savedOrder = [...book.chapterOrder]; savedMetaSig = metaSig(book);`);
    for (const [id, html] of Object.entries(chapters)) run(`chapterHTML[${JSON.stringify(id)}] = savedHTML[${JSON.stringify(id)}] = ${JSON.stringify(html)}; knowDisk(${JSON.stringify(bookId)}, ${JSON.stringify(id)}, ${JSON.stringify(html)});`);
  };
  return { run, plain, open, logged, writes, toasts, neo, context };
}

async function bookWith(h: ReturnType<typeof library>, chapters: Record<string, string>, listed: string[] = Object.keys(chapters)) {
  const book = await h.store.createBook({ title: 'Salt Roads' });
  for (const [id, html] of Object.entries(chapters)) fs.writeFileSync(path.join(h.dir, book.id, 'chapters', id + '.html'), html);
  book.chapterOrder = listed;
  await h.store.writeBookMeta(book.id, book);
  return book;
}

test('a chapter of the open book that has no file yet is left as it is, and the look at the disk still takes in the rest', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>', b: '<p>two</p>' }, ['a', 'b', 'fresh']);
  const w = windowFor(h.store, book.id);
  await w.open({ a: '<p>one</p>', b: '<p>two</p>', fresh: '' });
  fs.writeFileSync(path.join(h.dir, book.id, 'chapters', 'b.html'), '<p>two, written on the other device</p>');
  await w.run('refreshFromDisk()');
  assert.equal(w.run('chapterHTML.b'), '<p>two, written on the other device</p>', 'b was taken in: one missing file did not stop the look');
  assert.equal(w.run('chapterHTML.fresh'), '', 'the chapter with no file is as it was');
  assert.equal(w.run('savedHTML.fresh'), '');
  assert.equal(w.writes.length, 0, 'and nothing was written');
  assert.deepEqual(w.logged, [], 'a chapter that is not written yet is not an error to log');
});

test('a chapter that cannot be read is left as it is, the others are still looked at, and the failure is logged once, not at every look', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>', b: '<p>two</p>' });
  const w = windowFor(h.store, book.id);
  await w.open({ a: '<p>one</p>', b: '<p>two</p>' });
  // a folder where the chapter's file should be: it cannot be read
  fs.rmSync(path.join(h.dir, book.id, 'chapters', 'a.html'));
  fs.mkdirSync(path.join(h.dir, book.id, 'chapters', 'a.html'));
  fs.writeFileSync(path.join(h.dir, book.id, 'chapters', 'b.html'), '<p>two, written on the other device</p>');
  await w.run('refreshFromDisk()');
  assert.equal(w.run('chapterHTML.b'), '<p>two, written on the other device</p>');
  assert.equal(w.run('chapterHTML.a'), '<p>one</p>', 'the words on the page stay');
  assert.equal(w.run('savedHTML.a'), '<p>one</p>');
  assert.equal(w.writes.length, 0);
  assert.equal(w.logged.filter((m) => /unreadable/.test(m)).length, 1, 'logged');
  await w.run('refreshFromDisk()');
  assert.equal(w.logged.filter((m) => /unreadable/.test(m)).length, 1, 'but once');
});

test('a chapter in iCloud that never arrives is left as it is too', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>' });
  const w = windowFor(h.store, book.id);
  await w.open({ a: '<p>one</p>' });
  w.neo.readChapter = async () => { throw new Error("Error invoking remote method 'chapter:read': StoreError: [store:cloud_only] still in iCloud"); };
  await w.run('refreshFromDisk()');
  assert.equal(w.run('chapterHTML.a'), '<p>one</p>');
  assert.equal(w.writes.length, 0);
});

test('a chapter another device\'s book.json lists, not yet synced here, comes in empty with a base of \'\', so what arrives later is kept, not replaced', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>' });
  const w = windowFor(h.store, book.id);
  await w.open({ a: '<p>one</p>' });
  // the other device's book.json arrives before its new chapter's file
  const theirs = (await h.store.readBookMeta(book.id))!;
  theirs.chapterOrder = ['a', 'new-there'];
  theirs.modified = 'later';
  await h.store.writeBookMeta(book.id, theirs);
  await w.run('refreshFromDisk()');
  assert.deepEqual(w.plain('[...book.chapterOrder]'), ['a', 'new-there'], 'the chapter is in the book');
  assert.equal(w.run('chapterHTML["new-there"]'), '', 'empty for now');
  assert.equal(w.run(`diskKnown[${JSON.stringify(book.id + '/new-there')}]`), '', 'its base is \'\': the disk was seen to hold nothing');
  assert.equal(w.writes.length, 0, 'and nothing is written for it');
  // its words arrive from the other device, while this window has typed into the chapter
  fs.writeFileSync(path.join(h.dir, book.id, 'chapters', 'new-there.html'), '<p>written over there</p>');
  w.run('chapterHTML["new-there"] = "<p>typed here</p>"');
  await w.run('persistChapter("new-there")');
  assert.equal(w.writes[0].expected, '', 'the save was checked against the base');
  const twin = w.run('book.chapterOrder').find((c: string) => c !== 'a' && c !== 'new-there');
  assert.ok(twin, 'the file that arrived was kept as a chapter of its own');
  assert.equal(w.run(`chapterHTML[${JSON.stringify(twin)}]`), '<p>written over there</p>');
  assert.equal(fs.readFileSync(path.join(h.dir, book.id, 'chapters', 'new-there.html'), 'utf8'), '<p>typed here</p>', 'and then the typed words were written');
});

test('a chapter that arrives later, with nothing typed in the meantime, is taken in', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>' });
  const w = windowFor(h.store, book.id);
  await w.open({ a: '<p>one</p>' });
  const theirs = (await h.store.readBookMeta(book.id))!;
  theirs.chapterOrder = ['a', 'new-there'];
  await h.store.writeBookMeta(book.id, theirs);
  await w.run('refreshFromDisk()');
  fs.writeFileSync(path.join(h.dir, book.id, 'chapters', 'new-there.html'), '<p>written over there</p>');
  await w.run('refreshFromDisk()');
  assert.equal(w.run('chapterHTML["new-there"]'), '<p>written over there</p>');
  assert.equal(w.writes.length, 0);
});

test('readNewChapter: a chapter with no file reads as empty; any other failure is the caller\'s, never turned into empty', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>' });
  const w = windowFor(h.store, book.id);
  assert.equal(await w.run(`readNewChapter(${JSON.stringify(book.id)}, 'not-yet')`), '');
  assert.equal(await w.run(`readNewChapter(${JSON.stringify(book.id)}, 'a')`), '<p>one</p>');
  fs.mkdirSync(path.join(h.dir, book.id, 'chapters', 'odd.html'));
  await assert.rejects(w.run(`readNewChapter(${JSON.stringify(book.id)}, 'odd')`), /\[store:unreadable\]/);
  await assert.rejects(w.run(`readNewChapter(${JSON.stringify(book.id)}, '../x')`), /\[store:bad_name\]/);
});

test('opening a book whose chapter has not synced opens it empty against a base of \'\'; one that cannot be read does not open it', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>' }, ['a', 'gone']);
  const w = windowFor(h.store, book.id);
  await w.run(`openBook(${JSON.stringify(book.id)})`);
  assert.equal(w.run('chapterHTML["gone"]'), '', 'the missing file is an empty chapter');
  assert.equal(w.run(`diskKnown[${JSON.stringify(book.id + '/gone')}]`), '', 'whose base is \'\'');
  assert.equal(w.writes.length, 0);
  fs.mkdirSync(path.join(h.dir, book.id, 'chapters', 'odd.html'));
  const meta = (await h.store.readBookMeta(book.id))!;
  meta.chapterOrder = ['a', 'odd'];
  await h.store.writeBookMeta(book.id, meta);
  const w2 = windowFor(h.store, book.id);
  await assert.rejects(w2.run(`openBook(${JSON.stringify(book.id)})`), /\[store:unreadable\]/);
  assert.equal(w2.run('book'), null, 'nothing was opened');
  assert.equal(w2.writes.length, 0);
});

test('a notes page the book has never had reads as no text, and is saved against \'\', so a page made on the other device meanwhile is kept', async () => {
  const h = library();
  const book = await bookWith(h, { a: '<p>one</p>' });
  const w = windowFor(h.store, book.id);
  assert.equal(await h.store.readAux(book.id, 'notes-a'), null, 'the channel hands null across');
  const html = await w.run(`auxRead(${JSON.stringify(book.id)}, 'notes-a')`);
  assert.equal(html, '', 'the page shows empty');
  assert.equal(w.run(`auxBase[${JSON.stringify(book.id + '/notes-a')}]`), '', 'with a base of \'\'');
  fs.writeFileSync(path.join(h.dir, book.id, 'notes-a.html'), '<p>from the other device</p>');
  const ed = { dataset: { book: book.id, kind: 'notes-a' }, innerHTML: '<p>mine</p>' };
  w.context.$ = () => ed;
  w.run('auxDirty = true');
  w.run('flushAux()');
  await settle();
  await settle();
  assert.equal(fs.readFileSync(path.join(h.dir, book.id, 'notes-a.html.bak'), 'utf8'), '<p>from the other device</p>');
  assert.equal(fs.readFileSync(path.join(h.dir, book.id, 'notes-a.html'), 'utf8'), '<p>mine</p>');
});
