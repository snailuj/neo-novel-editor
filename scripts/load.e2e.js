// NEO opens without a single uncaught error: on the shelf, then with a book
// open, then back. The window's code is many files that load one after
// another; a timer, an observer or an event that fires between two of them
// and calls into one not yet loaded throws here. Run with
// `npm run test:e2e -- load`.

'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-load-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
fs.mkdirSync(path.join(tmp, 'NEO Library'));
fs.writeFileSync(path.join(tmp, 'NEO Library', 'library.json'), JSON.stringify({
  authorName: '', penNames: [], firstRunDone: true, pageTheme: 'night', nbspMarks: true,
  features: { cards: true, notesPages: true, poetry: true, footnotes: true, formatting: true, penNames: true, covers: true, pages: true, focus: true, readAloud: true, vim: false, exports: true },
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
const errors = [];
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (...args) => {
    const msg = typeof args[0] === 'object' && args[0] && 'message' in args[0] ? args[0].message : args[2];
    if (/Uncaught|is not defined|before initialization/.test(String(msg))) errors.push(String(msg));
  });
});
// no window of the run reaches the screen or takes the keyboard (see isolate-test-app.js)
require('./isolate-test-app.js').hideWindows();
require('../main.js');

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code, true);
    while (!(await js(`typeof library !== 'undefined' && !!library && !!library.features`).catch(() => false))) await tick(50);
    win.setBounds({ width: 900, height: 700 });
    await tick(800);
    await js(`(async () => {
      await addImportedBooks([{ name: 'Load Test', chapters: [{ title: 'One', paras: [{ text: 'A line of words to set the page.' }] }] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      await openBook(ids[ids.length - 1]);
    })()`);
    await tick(800);
    win.setBounds({ width: 1100, height: 760 });
    await tick(500);
    await js(`document.getElementById('back-to-shelf').click()`);
    await tick(600);
    try {
      assert.deepEqual(errors, []);
      console.log('ok   NEO opens, opens a book and goes back with no uncaught error');
    } catch (err) {
      failed++;
      console.log('FAIL NEO opens, opens a book and goes back with no uncaught error\n     ' + errors.join('\n     '));
    }

    // A chapter whose file cannot be read (a folder stands where it should
    // be, as an antivirus lock or an iCloud placeholder would refuse it) does
    // not stop the book opening: the chapter is shown not loaded, not open
    // for writing, the writer is told, nothing goes over the file, and the
    // next look at the disk that can read it loads it.
    const passedBefore = 1;
    let ran = 0;
    const check = async (name, fn) => {
      ran++;
      try { await fn(); console.log('ok   ' + name); } catch (err) { failed++; console.log('FAIL ' + name + '\n     ' + (err && err.message || err)); }
    };
    const bookId = await js(`(async () => {
      await addImportedBooks([{ name: 'Stuck Chapter', chapters: [{ title: 'One', paras: [{ text: 'The first chapter.' }] }, { title: 'Two', paras: [{ text: 'The second chapter.' }] }] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      return ids[ids.length - 1];
    })()`);
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'NEO Library', bookId, 'book.json'), 'utf8'));
    const stuckId = meta.chapterOrder[1];
    const stuckFile = path.join(tmp, 'NEO Library', bookId, 'chapters', stuckId + '.html');
    const words = fs.readFileSync(stuckFile, 'utf8');
    fs.rmSync(stuckFile);
    fs.mkdirSync(stuckFile);
    await js(`openBook(${JSON.stringify(bookId)})`);
    await tick(600);
    await check('a book with a chapter that cannot be read still opens', async () => {
      assert.equal(await js('book && book.id'), bookId);
      assert.equal(await js(`document.querySelectorAll('.chapter').length`), 2);
    });
    await check('that chapter is shown not loaded, not open for writing, and the writer is told', async () => {
      const sel = `.chapter[data-id=${JSON.stringify(stuckId)}]`;
      assert.equal(await js(`document.querySelector(${JSON.stringify(sel)}).classList.contains('unloaded')`), true);
      assert.equal(await js(`document.querySelector(${JSON.stringify(sel + ' .chapter-body')}).isContentEditable`), false);
      assert.match(await js(`document.getElementById('hint').textContent`), /could not be read/);
      assert.equal(await js(`document.querySelector('.chapter:not(.unloaded) .chapter-body').isContentEditable`), true, 'the other chapter is open for writing');
    });
    await js('flushAllSaves()');
    await tick(400);
    await check('nothing is written over its file', async () => {
      assert.equal(fs.statSync(stuckFile).isDirectory(), true);
    });
    fs.rmdirSync(stuckFile);
    fs.writeFileSync(stuckFile, words);
    await js('refreshFromDisk()');
    await tick(400);
    await check('a later look that can read it loads it, open for writing', async () => {
      const sel = `.chapter[data-id=${JSON.stringify(stuckId)}] .chapter-body`;
      assert.equal(await js(`document.querySelector(${JSON.stringify(sel)}).isContentEditable`), true);
      assert.match(await js(`document.querySelector(${JSON.stringify(sel)}).textContent`), /The second chapter/);
    });
    await check('and no uncaught error on the way', async () => assert.deepEqual(errors, []));
    console.log(`\n${passedBefore + ran - failed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    app.exit(failed ? 1 : 0);
  }
}
main();
