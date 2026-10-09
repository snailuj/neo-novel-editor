'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// how a chapter file is laid out on disk (paragraphLines), run on its own
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const context = vm.createContext({});
vm.runInContext(app.slice(app.indexOf('function paragraphLines('), app.indexOf('// One write at a time per chapter')), context);
vm.runInContext('this.api = { paragraphLines };', context);
const { paragraphLines } = context.api;

test('each paragraph of a chapter file stands on its own line', () => {
  assert.equal(paragraphLines('<p>a</p><p class="scene-break">***</p><p><br></p>'),
    '<p>a</p>\n<p class="scene-break">***</p>\n<p><br></p>\n');
});

test('a chapter already set one paragraph per line is left as it is', () => {
  const once = paragraphLines('<p>a</p><p class="scene-break">***</p><p><br></p>');
  assert.equal(paragraphLines(once), once);
});

test('a line break inside a paragraph is the paragraph\'s own and stays', () => {
  assert.equal(paragraphLines('<p>a <i>b</i>\nc</p>'), '<p>a <i>b</i>\nc</p>\n');
});

test('blank lines and spaces between paragraphs come down to one line break', () => {
  assert.equal(paragraphLines('<p>a</p>\n\n  <p>b</p>'), '<p>a</p>\n<p>b</p>\n');
});

// The page keeps a chapter file's blocks, never the line breaks between
// them: dropLineBreaks, run on a body of paragraphs and text nodes
test('a page filled from a chapter file keeps its paragraphs and drops the line breaks between them', () => {
  const dropLineBreaks = vm.runInContext('dropLineBreaks', context);
  const body = { childNodes: [] };
  const node = (nodeType, data) => ({ nodeType, data, remove() { body.childNodes.splice(body.childNodes.indexOf(this), 1); } });
  body.childNodes.push(node(1, 'First'), node(3, '\n'), node(1, 'Second'), node(3, '\n\n  \t'), node(3, 'loose words'), node(3, '\u00a0'), node(1, 'Third'), node(3, '\n'));
  dropLineBreaks(body);
  // a no-break space is the writer's own, and stays
  assert.deepEqual(body.childNodes.map((n) => n.data), ['First', 'Second', 'loose words', '\u00a0', 'Third']);
});

// A book in memory, saved through persistChapter to a disk that notes what
// it is handed, flushed by flushAllSaves, looked at again by refreshFromDisk
// and undone by structuralUndo; the page's drawing is left out.
const SLICES = [
  ['const diskKnown = {};', '// Another device\'s version of a chapter'],
  ['function metaSig(', 'function scheduleMetaSave('],
  ['function flushAllSaves(', '/*  SNAPSHOTS'],
  ['function mergeSidecar(', 'function writeSidecar('],
  ['function onlyDrops(', 'window.addEventListener(\'focus\''],
  ['function sealUndo(', '// after undoing a double-Enter break'],
  ['async function duplicateBook(', '// The cover as a picture file']
];
function bookInMemory(chapters) {
  const writes = [];
  const disk = { ...chapters };
  const none = () => {};
  const page = vm.createContext({
    window: { neo: {
      writeChapter: async (bookId, chId, html) => { writes.push({ chId, html }); disk[chId] = html; return true; },
      readChapter: async (bookId, chId) => disk[chId],
      readBookMeta: async () => JSON.parse(JSON.stringify(page.book)),
      readJSON: async () => null,
      duplicateBook: async (bookId, title) => ({ id: bookId + '-copy', title })
    } },
    book: { id: 'b', chapterOrder: Object.keys(chapters), chapterKinds: {}, chapterTitles: {}, chapterNotes: {}, sectionNotes: {}, looseCards: [], sceneNotes: {} },
    chapterHTML: { ...chapters },
    savedHTML: { ...chapters },
    savedMetaSig: '',
    writing: {},
    wordCache: {},
    diskStamps: {},
    sidecarPending: {},
    sidecarBase: {},
    saveTimers: {},
    tabPlaces: {},
    darlings: [],
    stickies: [],
    undoStack: [],
    currentTab: 'manuscript',
    currentChapterId: null,
    shelfExport: false,
    library: { shelves: [{ id: 's', bookIds: ['b'] }] },
    lastHereActivity: 0,
    bookMetaCache: { clear: none, set: none },
    isBound: () => false,
    writeLibrary: async () => {},
    renderShelves: none,
    console,
    setTimeout,
    document: { createElement: () => ({ children: [] }) },
    $: () => ({ scrollTop: 0 }),
    t: (text) => text,
    twinChapterTitle: (title) => (title || '') + ' from other device',
    captureCaret: () => null,
    saveMeta: async () => {},
    writeSidecar: async () => {},
    maybeDailySnapshot: none, // snapshotStructure's day snapshot (SNAPSHOTS) is not saving's
    restoreCaret: none, renderChapters: none, renderStickies: none, updateCounters: none, rejoinAtCaret: none, resetNativeUndo: none,
    flushAux: none, flushStickiesSave: none, flushSidecars: none, scheduleMetaSave: none, scheduleNavRefresh: none, toast: none
  });
  for (const [from, to] of SLICES) {
    const at = app.indexOf(from);
    vm.runInContext(app.slice(at, app.indexOf(to, at)), page);
  }
  page.savedMetaSig = page.metaSig(page.book);
  return { page, writes, disk };
}
// every chapter write started so far, to the end
const settled = (page) => vm.runInContext('Promise.all(Object.values(chapterChain))', page);

const F = '<p>First line.</p>\n<p>Second line.</p>\n<p>Third line.</p>\n';

test('a chapter goes to disk one paragraph per line', async () => {
  const { page, writes } = bookInMemory({ x: F });
  await page.persistChapter('x', '<p>a</p><p>b</p>');
  assert.deepEqual(writes, [{ chId: 'x', html: '<p>a</p>\n<p>b</p>\n' }]);
  assert.equal(page.savedHTML.x, '<p>a</p>\n<p>b</p>\n');
});

// flushAllSaves writes every chapter whose page copy differs from savedHTML
test('the page\'s copy takes the saved form, so the flush finds nothing left to write', async () => {
  const { page } = bookInMemory({ x: F, twin: F });
  // a paragraph typed on the page has no line break of its own yet
  page.chapterHTML.x = F + '<p>Fourth.</p>';
  await page.persistChapter('x');
  assert.equal(page.chapterHTML.x, F + '<p>Fourth.</p>\n');
  assert.equal(page.chapterHTML.x, page.savedHTML.x);
  // another device's copy, handed in compact as keepOtherDeviceVersion does
  page.chapterHTML.twin = '<p>Other.</p><p>Device.</p>';
  await page.persistChapter('twin', '<p>Other.</p><p>Device.</p>');
  assert.equal(page.chapterHTML.twin, '<p>Other.</p>\n<p>Device.</p>\n');
  assert.equal(page.chapterHTML.twin, page.savedHTML.twin);
});

test('text handed in that the page no longer holds leaves the page alone', async () => {
  const { page } = bookInMemory({ x: '<p>Newer.</p>' });
  await page.persistChapter('x', '<p>Older.</p>');
  assert.equal(page.chapterHTML.x, '<p>Newer.</p>');
  assert.equal(page.savedHTML.x, '<p>Older.</p>\n');
});

// The page holds none of a chapter file's line breaks, so capturing it
// after a save (here of a paragraph made by Enter), with nothing typed,
// gives back the compact form of the text the file holds lined.
const ENTERED = '<p>First line.</p><p>Second line.</p><p>New.</p><p>Third line.</p>';

test('a capture of the page with nothing typed gives the flush nothing to write', async () => {
  const { page, writes } = bookInMemory({ x: F });
  page.chapterHTML.x = ENTERED;
  await page.persistChapter('x');
  writes.length = 0;
  page.chapterHTML.x = ENTERED;
  page.flushAllSaves();
  await settled(page);
  assert.deepEqual(writes, []);
});

test('a capture of the page with nothing typed leaves another device\'s change to be adopted', async () => {
  const { page, writes, disk } = bookInMemory({ x: F });
  page.chapterHTML.x = ENTERED;
  await page.persistChapter('x');
  writes.length = 0;
  page.chapterHTML.x = ENTERED;
  const theirs = '<p>First line.</p>\n<p>Second line.</p>\n<p>New.</p>\n<p>Third line, from the other device.</p>\n';
  disk.x = theirs;
  await page.refreshFromDisk();
  await settled(page);
  assert.deepEqual([...page.book.chapterOrder], ['x']);
  assert.equal(page.chapterHTML.x, theirs);
  assert.deepEqual(writes, []);
});

// another device's book.json keeps only the chapters it has, plus those
// holding words this device has not saved yet
test('a capture of the page with nothing typed lets another device remove the chapter', async () => {
  const { page } = bookInMemory({ x: F, y: F });
  page.chapterHTML.y = ENTERED;
  await page.persistChapter('y');
  page.chapterHTML.y = ENTERED;
  page.window.neo.readBookMeta = async () => ({ ...JSON.parse(JSON.stringify(page.book)), chapterOrder: ['x'] });
  await page.refreshFromDisk();
  assert.deepEqual([...page.book.chapterOrder], ['x']);
});

// duplicateBook writes the open book's unsaved chapters before the copy
test('a capture of the page with nothing typed is not written again before the book is copied', async () => {
  const { page, writes } = bookInMemory({ x: F });
  page.chapterHTML.x = ENTERED;
  await page.persistChapter('x');
  writes.length = 0;
  page.chapterHTML.x = ENTERED;
  await page.duplicateBook({ id: 'b', title: 'Book' });
  await settled(page);
  assert.deepEqual(writes, []);
});

// structural undo hands back chapters whose files the action deleted, and
// savedHTML still holds their last write
test('a write the same as the last one still goes to disk', async () => {
  const { page, writes } = bookInMemory({ x: F });
  await page.persistChapter('x', F);
  assert.deepEqual(writes, [{ chId: 'x', html: F }]);
});

// Enter twice at a chapter's end makes a section break and a third splits
// the chapter. Undoing the split saves the chapter, which lines the page's
// copy, while the break's undo holds the copy as typed.
test('undoing a section break after the chapter split it led to sends nothing to Darlings', async () => {
  const { page } = bookInMemory({ x: F });
  page.snapshotStructure('section break');
  const broken = '<p>First line.</p>\n<p>Second line.</p>\n<p>Third line.</p><p class="scene-break">***</p><p><br></p>\n';
  page.chapterHTML.x = broken;
  page.snapshotStructure('new chapter');
  page.chapterHTML.x = '<p>First line.</p>\n<p>Second line.</p>\n<p>Third line.</p><p class="scene-break">***</p>\n';
  page.chapterHTML.y = '<p><br></p>';
  page.book.chapterOrder.push('y');
  await page.structuralUndo();
  assert.equal(page.chapterHTML.x, paragraphLines(broken));
  await page.structuralUndo();
  assert.equal(JSON.stringify(page.darlings), '[]');
  assert.equal(page.chapterHTML.x, F);
});

// A save that lands after an action, before the first edit seals its undo,
// lines the page's copy of a chapter the action did not touch.
test('undo keeps the words typed since in a chapter the action left alone', async () => {
  const { page } = bookInMemory({ x: F, y: '<p>Elsewhere.</p>\n' });
  const typed = F + '<p>Fourth.</p>';
  page.chapterHTML.x = typed;
  page.snapshotStructure('move');
  page.chapterHTML.y = '<p>Moved.</p>\n<p>Elsewhere.</p>\n';
  await page.persistChapter('x');
  page.sealUndo(page.undoStack[0]);
  const since = paragraphLines(typed) + '<p>Fifth.</p>';
  page.chapterHTML.x = since;
  await page.structuralUndo();
  assert.equal(JSON.stringify(page.darlings), '[]');
  assert.equal(page.chapterHTML.x, paragraphLines(since));
  assert.equal(page.chapterHTML.y, '<p>Elsewhere.</p>\n');
});
