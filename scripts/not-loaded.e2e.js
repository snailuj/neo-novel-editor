// A chapter whose file cannot be read here (a folder stands where it should be, as an
// antivirus lock or an iCloud placeholder would refuse it) is not loaded: the window
// holds none of its words. Rule: nothing NEO does while it is not loaded writes over,
// deletes, or empties that chapter, or drops a loaded chapter's words into it; each such
// action is refused up front with a toast that names it, and changes nothing. When it can
// be read at last it loads, and today's count does not take its words as typed today.
// Run with `xvfb-run -a electron --no-sandbox scripts/not-loaded.e2e.js`.

'use strict';

const { app, BrowserWindow, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-not-loaded-test-${process.pid}-`));
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
const LIB = path.join(tmp, 'NEO Library');
fs.mkdirSync(LIB);
fs.writeFileSync(path.join(LIB, 'library.json'), JSON.stringify({
  authorName: 'Ada', penNames: [], firstRunDone: true, hintShown: true, emailAddress: 'ada@example.com', emailMethod: 'gmail',
  features: { cards: true, notesPages: true, poetry: true, footnotes: true, formatting: true, penNames: true, covers: true, pages: true, focus: true, readAloud: true, vim: false, exports: true },
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
// an export or a draft that got as far as the disk or the mail program
const reached = [];
dialog.showSaveDialog = async (...args) => { reached.push('save dialog'); void args; return { canceled: true }; };
shell.openExternal = async (url) => { reached.push('open ' + url); };
shell.showItemInFolder = () => { reached.push('show in folder'); };
const errors = [];
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (...args) => {
    const msg = typeof args[0] === 'object' && args[0] && 'message' in args[0] ? args[0].message : args[2];
    if (/Uncaught|is not defined|before initialization/.test(String(msg))) errors.push(String(msg));
  });
});
require('./isolate-test-app.js').hideWindows();
require('../main.js');

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  let failed = 0;
  let passed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code, true);
    while (!(await js(`typeof library !== 'undefined' && !!library && !!library.features`).catch(() => false))) await tick(50);
    win.setBounds({ width: 1000, height: 760 });
    await tick(600);
    const check = async (name, fn) => {
      try { await fn(); passed++; console.log('ok   ' + name); } catch (err) { failed++; console.log('FAIL ' + name + '\n     ' + (err && err.message || err)); }
    };

    const bookId = await js(`(async () => {
      await addImportedBooks([{ name: 'Stuck Chapter', chapters: [
        { title: 'One', paras: [{ text: 'The first chapter.' }] },
        { title: 'Two', paras: [{ text: 'The second chapter, whose words only the disk holds.' }] },
        { title: 'Three', paras: [{ text: 'The third chapter.' }] }] }], library.shelves[0]);
      const ids = library.shelves[0].bookIds;
      return ids[ids.length - 1];
    })()`);
    const dir = path.join(LIB, bookId);
    const order = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8')).chapterOrder;
    const [A, B, C] = order;
    const fileOf = (c) => path.join(dir, 'chapters', c + '.html');
    // a snapshot of the whole book, taken while every chapter could be read
    await js(`openBook(${JSON.stringify(bookId)})`);
    await tick(500);
    await js('snapshotNow()');
    await tick(300);
    const snapName = await js(`loadSnaps(book.id, true).then((s) => s[s.length - 1].name)`);
    assert.ok(snapName, 'a snapshot was taken to restore later');
    await js('flushAllSaves()');
    await tick(300);

    // now B cannot be read, and the book is opened again
    const words = fs.readFileSync(fileOf(B), 'utf8');
    fs.rmSync(fileOf(B));
    fs.mkdirSync(fileOf(B));
    await js(`openBook(${JSON.stringify(bookId)})`);
    await tick(600);
    assert.equal(await js(`chapterUnloaded(book.id, ${JSON.stringify(B)})`), true, 'B is not loaded');

    const state = () => js(`JSON.stringify({ order: book.chapterOrder, titles: book.chapterTitles || {}, notes: book.sectionNotes || {}, chNotes: book.chapterNotes || {}, loose: book.looseCards || [], a: chapterHTML[${JSON.stringify(A)}], c: chapterHTML[${JSON.stringify(C)}] })`);
    const untouched = () => {
      assert.equal(fs.statSync(fileOf(B)).isDirectory(), true, 'B\'s file is as it was');
      assert.ok(fs.existsSync(fileOf(A)) && fs.existsSync(fileOf(C)), 'A and C are on disk');
    };
    const refused = async (name, action) => {
      await check(name, async () => {
        await js(`document.getElementById('hint').textContent = ''`);
        const before = await state();
        await js(`(async () => { ${action} })()`).catch(() => {});
        await tick(400);
        assert.equal(await state(), before, 'nothing in the book changed');
        untouched();
        assert.match(await js(`document.getElementById('hint').textContent`), /could not be read/, 'the writer is told');
      });
    };

    await check('a save of the chapter that is not loaded throws, so no save-then-delete carries on', async () => {
      const r = await js(`persistChapter(${JSON.stringify(B)}).then(() => 'saved', (err) => 'threw: ' + err.message)`);
      assert.match(r, /^threw: /);
      untouched();
    });
    await refused('joining a chapter into the one not loaded (Tab in the Outline, a card dropped on it) is refused', `await joinChapter(${JSON.stringify(C)}, ${JSON.stringify(B)});`);
    await refused('joining the chapter not loaded into another is refused', `await joinChapter(${JSON.stringify(B)}, ${JSON.stringify(A)});`);
    await refused('setting the chapter not loaded aside on a loose card is refused', `await chapterToLoose(${JSON.stringify(B)});`);
    await refused('moving a section into the chapter not loaded is refused', `moveSection(${JSON.stringify(A)}, 0, { ch: ${JSON.stringify(B)}, before: null });`);
    await js(`book.looseCards = [{ id: 'lc-test', held: 'section', text: 'a loose note', html: '<p>Loose words.</p>' }]`);
    await refused('placing a loose card in the chapter not loaded is refused', `looseToSection('lc-test', { ch: ${JSON.stringify(B)}, before: null });`);
    await check('the loose card is still loose', async () => assert.equal(await js(`(book.looseCards || []).some((c) => c.id === 'lc-test')`), true));
    await js(`book.looseCards = []`);
    await refused('merging a chapter up into the chapter not loaded (Backspace at its start) is refused', `
      const body = document.querySelector('.chapter[data-id=${JSON.stringify(C)}] .chapter-body');
      const r = document.createRange(); r.setStart(body.querySelector('p'), 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      chapterStartBackspace({ key: 'Backspace', preventDefault() {} }, body, ${JSON.stringify(C)});`);

    const snapCount = () => js('loadSnaps(book.id, true).then((s) => s.length)');
    const snaps = await snapCount();
    await refused('taking a snapshot of the book is refused', 'await snapshotNow();');
    await check('and no snapshot was taken', async () => assert.equal(await snapCount(), snaps));
    await js(`switchTab('darlings')`);
    await tick(300);
    await js(`showSnapshot(${JSON.stringify(snapName)})`);
    await tick(500);
    await check('the snapshot to restore is on show', async () => assert.equal(await js('!!snapShown'), true));
    await refused('restoring the whole book is refused', 'await restoreSnapshot();');
    await refused('restoring one chapter while another is not loaded is refused', `await restoreSnapshot(${JSON.stringify(A)});`);
    await refused('restoring the chapter not loaded is refused', `await restoreSnapshot(${JSON.stringify(B)});`);
    await check('and no snapshot was taken on the way', async () => assert.equal(await snapCount(), snaps));
    await js(`hideSnapshot(); switchTab('manuscript')`);
    await tick(300);

    for (const fmt of ['txt', 'epub', 'pdf', 'manuscript', 'paperback']) {
      await refused(`exporting the book as ${fmt} is refused`, `await doExport(${JSON.stringify(fmt)});`);
    }
    await refused('an email draft of the book is refused', 'await doEmailDraft();');
    await check('no export or draft reached the disk or the mail program', async () => assert.deepEqual(reached, []));

    // B arrives at last
    const today = await js('dayWords((book.dailyCounts || {})[todayStr()])');
    fs.rmdirSync(fileOf(B));
    fs.writeFileSync(fileOf(B), words);
    await js('refreshFromDisk()');
    await tick(500);
    await check('when it can be read it loads', async () => {
      assert.equal(await js(`chapterUnloaded(book.id, ${JSON.stringify(B)})`), false);
      assert.match(await js(`chapterHTML[${JSON.stringify(B)}]`), /only the disk holds/);
    });
    await check('and today\'s count does not take its words as typed today', async () => {
      assert.equal(await js('dayWords((book.dailyCounts || {})[todayStr()])'), today);
    });
    await check('no uncaught error on the way', async () => assert.deepEqual(errors, []));
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    console.log(`\n${passed} passed, ${failed} failed`);
    app.exit(failed ? 1 : 0);
  }
}
main();
