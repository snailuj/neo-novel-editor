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

// Only blocks standing on the body get a line. A paragraph inside a list, a
// table, a figure or a pre is part of that element, and a line break put
// between two of them changes what is inside it (in a pre, how it is laid out).
test('paragraphs inside a list, table, figure or pre are left as they are', () => {
  for (const html of [
    '<ul><li><p>a</p><p>b</p></li></ul>',
    '<ol><li><p>a</p></li><li><div>b</div><div>c</div></li></ol>',
    '<table><tbody><tr><td><p>a</p><p>b</p></td></tr></tbody></table>',
    '<figure><p>a</p><p>b</p><figcaption><p>c</p><p>d</p></figcaption></figure>',
    '<pre><p>a</p><p>b</p></pre>'
  ]) assert.equal(paragraphLines(html), html);
});

test('the lines between the blocks on the body stay where they were', () => {
  assert.equal(paragraphLines('<p>a</p><p>b</p><ul><li>x</li></ul><p>c</p><p>d</p>'), '<p>a</p>\n<p>b</p><ul><li>x</li></ul><p>c</p>\n<p>d</p>\n');
  assert.equal(paragraphLines('<div>a</div><h2>b</h2><blockquote><p>c</p><p>d</p></blockquote>'), '<div>a</div>\n<h2>b</h2>\n<blockquote><p>c</p><p>d</p></blockquote>\n');
});

// Depth zero is the body, which is all dropLineBreaks (body children only)
// takes the line breaks off: so any element that is not void holds what is
// inside it, whatever its name.
test('paragraphs inside any other element are left as they are', () => {
  for (const html of [
    '<section><p>a</p><p>b</p></section>',
    '<details><summary>s</summary><p>a</p><p>b</p></details>',
    '<b><p>a</p><p>b</p></b>',
    '<span class="x"><div>a</div><div>b</div></span>',
    '<a href="https://example.org/"><p>a</p><p>b</p></a>',
    '<custom-box><p>a</p><p>b</p></custom-box>'
  ]) assert.equal(paragraphLines(html), html);
  // and the blocks around it are lined as before
  assert.equal(paragraphLines('<p>a</p><section><p>x</p><p>y</p></section><p>b</p><p>c</p>'),
    '<p>a</p><section><p>x</p><p>y</p></section><p>b</p>\n<p>c</p>\n');
});

// void elements have no end tag, so they hold nothing and take no depth
test('void elements do not hold the blocks after them', () => {
  assert.equal(paragraphLines('<p>a<br>b <img src="x.png"></p><p>c</p>'), '<p>a<br>b <img src="x.png"></p>\n<p>c</p>\n');
  assert.equal(paragraphLines('<p>a</p><hr><p>b</p><p>c</p>'), '<p>a</p><hr><p>b</p>\n<p>c</p>\n');
  assert.equal(paragraphLines('<section><img src="x.png"><p>a</p><p>b</p></section><p>c</p>'), '<section><img src="x.png"><p>a</p><p>b</p></section><p>c</p>\n');
  assert.equal(paragraphLines('<p>a</p><p>b<wbr>c</p>'), '<p>a</p>\n<p>b<wbr>c</p>\n');
});

// Files this reads wrong stay as they are rather than gaining a line break
// where the page would keep it: a comment holding a <p> counts as an open
// block (fewer lines), <p/> opens one, and a file lined an earlier way is
// not changed again.
test('a comment holding a tag, <p/>, and a file lined an earlier way are left as they are', () => {
  assert.equal(paragraphLines('<!-- <p> --><p>a</p><p>b</p>'), '<!-- <p> --><p>a</p><p>b</p>');
  assert.equal(paragraphLines('<p/><p>a</p><p>b</p>'), '<p/><p>a</p><p>b</p>');
  const earlier = '<ul><li><p>a</p>\n<p>b</p></li></ul>\n<p>c</p>\n';
  assert.equal(paragraphLines(earlier), earlier);
});

test('lines stand after the blocks on the body and not inside the containers between them', () => {
  assert.equal(paragraphLines('<p>a</p><ul><li><p>x</p><p>y</p></li></ul><p>b</p><p>c</p>'),
    '<p>a</p><ul><li><p>x</p><p>y</p></li></ul><p>b</p>\n<p>c</p>\n');
  assert.equal(paragraphLines('<p>a</p><p>b</p><pre><p>x</p><p>y</p></pre>'), '<p>a</p>\n<p>b</p><pre><p>x</p><p>y</p></pre>');
  // what a file holds after a container is the file's own
  assert.equal(paragraphLines('<ul><li><p>x</p><p>y</p></li></ul>\n<p>b</p>\n<p>c</p>'), '<ul><li><p>x</p><p>y</p></li></ul>\n<p>b</p>\n<p>c</p>\n');
});

// The page keeps a chapter file's blocks, never the line breaks between
// them: dropLineBreaks, run on a body of child nodes. A part that starts
// with "<" is an element (its text is its html), any other is a text node.
const dropLineBreaks = vm.runInContext('dropLineBreaks', context);
function kept(...parts) {
  const body = { childNodes: [] };
  for (const data of parts) {
    const tag = /^<(\w+)/.exec(data);
    body.childNodes.push({ nodeType: tag ? 1 : 3, tagName: tag && tag[1].toUpperCase(), data, remove() { body.childNodes.splice(body.childNodes.indexOf(this), 1); } });
  }
  dropLineBreaks(body);
  return body.childNodes.map((n) => n.data);
}

test('a page filled from a chapter file keeps its paragraphs and drops the line breaks between them', () => {
  assert.deepEqual(kept('<p>First</p>', '\n', '<h2>Second</h2>', '\n\n  \t', '<blockquote>Third</blockquote>', '\n', '<div>Fourth</div>', '\n'),
    ['<p>First</p>', '<h2>Second</h2>', '<blockquote>Third</blockquote>', '<div>Fourth</div>']);
  // a no-break space is the writer's own, and stays
  assert.deepEqual(kept('<p>First</p>', '\u00a0', '<p>Second</p>'), ['<p>First</p>', '\u00a0', '<p>Second</p>']);
});

// paragraphLines writes a line break only after a top-level block that
// another block or the end follows, so the page drops no other whitespace.
// A file with words outside a paragraph, or whitespace first, is not
// NEO's own, but plain files get edited by hand and by other tools.
test('whitespace that no chapter file line break stands for stays on the page', () => {
  const stays = [
    ['<p>One.</p>', '<i>two</i>', ' ', '<b>three</b>'], // between two inline elements
    ['  ', '<p>One.</p>', '\n', '<p>Two.</p>', '\n'], // before the first block
    ['<p>One.</p>', '\n', 'words'], // between a block and words
    ['words', '\n', '<p>One.</p>'], // between words and a block
    ['<p>One.</p>', '<i>two</i>', '\n'], // after an inline element at the end
    ['<p>One.</p>', '\n', '<ul><li>a</li></ul>', '\n', '<p>Two.</p>'] // beside a list
  ];
  // the page and the file are the same file on disk (sameOnDisk)
  for (const parts of stays) assert.equal(paragraphLines(kept(...parts).join('')), paragraphLines(parts.join('')), JSON.stringify(parts));
  assert.deepEqual(kept('<p>One.</p>', '<i>two</i>', ' ', '<b>three</b>'), ['<p>One.</p>', '<i>two</i>', ' ', '<b>three</b>']);
  assert.deepEqual(kept('  ', '<p>One.</p>', '\n', '<p>Two.</p>', '\n'), ['  ', '<p>One.</p>', '<p>Two.</p>']);
  assert.deepEqual(kept('<p>One.</p>', '\n', 'words'), ['<p>One.</p>', '\n', 'words']);
  assert.deepEqual(kept('words', '\n', '<p>One.</p>'), ['words', '\n', '<p>One.</p>']);
  assert.deepEqual(kept('<p>One.</p>', '<i>two</i>', '\n'), ['<p>One.</p>', '<i>two</i>', '\n']);
  assert.deepEqual(kept('<p>One.</p>', '\n', '<ul><li>a</li></ul>', '\n', '<p>Two.</p>'), ['<p>One.</p>', '\n', '<ul><li>a</li></ul>', '\n', '<p>Two.</p>']);
});

// Insertions beside the body's text (a darling put back at a caret between
// paragraphs) can leave two whitespace nodes side by side, one gap to the file
test('whitespace nodes side by side between two blocks all go', () => {
  assert.deepEqual(kept('<p>One.</p>', '\n', ' ', '<p>Two.</p>'), ['<p>One.</p>', '<p>Two.</p>']);
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

// A file written compact (a book from before the switch, an import) is
// rewritten by structural undo and Restore Whole Book with the text they
// hold, which is lined when it came from a snapshot.
const C = '<p>Beta one.</p><p>Beta two.</p>';

test('text that is the saved text in all but line breaks goes to disk as the saved bytes', async () => {
  const { page, writes } = bookInMemory({ x: C });
  await page.persistChapter('x', paragraphLines(C));
  await page.persistChapter('x', C);
  assert.deepEqual(writes, [{ chId: 'x', html: C }, { chId: 'x', html: C }]);
  assert.equal(page.savedHTML.x, C);
});

test('the page\'s copy takes the saved bytes when the text is the same', async () => {
  const { page } = bookInMemory({ x: C });
  page.chapterHTML.x = paragraphLines(C);
  await page.persistChapter('x');
  assert.equal(page.chapterHTML.x, C);
});

test('a chapter with a change goes to disk one paragraph per line', async () => {
  const { page, writes } = bookInMemory({ x: C });
  await page.persistChapter('x', C + '<p>Beta three.</p>');
  assert.deepEqual(writes, [{ chId: 'x', html: '<p>Beta one.</p>\n<p>Beta two.</p>\n<p>Beta three.</p>\n' }]);
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

// The book's snapshots (SNAPSHOTS) over the book in memory, each kept as
// { file: text } under its name. A word is any run without a tag or a space.
function withSnapshots(page) {
  const snaps = new Map();
  Object.assign(page.window.neo, {
    snapshotList: async () => [...snaps].map(([name, files]) => ({ name, files: Object.keys(files) })),
    snapshotRead: async (bookId, name, file) => (snaps.get(name) || {})[file] || '',
    snapshotWrite: async (bookId, name, file, text) => {
      if (!snaps.has(name)) snaps.set(name, {});
      if (file in snaps.get(name)) return false;
      snaps.get(name)[file] = text;
      return true;
    },
    snapshotRemove: async (bookId, name) => snaps.delete(name),
    logError: () => {}
  });
  const element = page.document.createElement;
  page.document = {
    addEventListener: () => {},
    createElement: (tag) => (tag !== 'template' ? element(tag) : {
      innerHTML: '',
      get content() { return { text: this.innerHTML.replace(/<[^>]*>/g, ' '), querySelectorAll: () => [] }; }
    })
  };
  Object.assign(page, { UNCOUNTED: '', plainText: (root) => root.text, countWords: (text) => text.split(/\s+/).filter(Boolean).length });
  const at = app.indexOf('/*  SNAPSHOTS');
  vm.runInContext(app.slice(at, app.indexOf('/*  REFRESH', at)), page);
  return snaps;
}

// The day's first snapshot holds savedHTML, lined; a capture of the page
// with nothing typed holds the same text compact. A snapshot of it after
// finds no chapter changed, and another after that nothing new.
test('a capture of the page with nothing typed is no change to a snapshot', async () => {
  const { page } = bookInMemory({ x: F });
  withSnapshots(page);
  page.maybeDailySnapshot();
  await vm.runInContext('snapChain', page);
  page.chapterHTML.x = F.replace(/\n/g, '');
  const kept = await page.takeSnapshot('k');
  assert.equal(kept.snap.changed, 0);
  assert.deepEqual([...kept.snap.files], ['snapshot.json']);
  page.chapterHTML.x = F;
  assert.equal((await page.takeSnapshot('k')).same, true);
});
