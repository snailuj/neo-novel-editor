// End-to-end tests for API 2 of the plugin host (plugins.js): where the
// writer is, and going to a place, on a throwaway library. A place is
// { chId, pIdx, off, len, scroll? }, counted as captureCaret counts: pIdx
// among the chapter's paragraphs on the page, off and len in UTF-16 units
// across any inline elements. The fixture plugins are those of
// scripts/fixtures/plugins: the probe, written for API 2, keeps what it was
// handed as window.__probe.neo, and old-api is written for API 1.
// Run with `npm run test:plugin-edits`.

'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A folder of its own for each run (see plugins.e2e.js for why earlier
// runs' folders are the ones removed).
for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-plugin-edits-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-plugin-edits-test-${process.pid}-`));
const LIBRARY = path.join(tmp, 'NEO Library');
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
fs.mkdirSync(LIBRARY);
fs.writeFileSync(path.join(LIBRARY, 'library.json'), JSON.stringify({
  authorName: '', penNames: [], firstRunDone: true, pageTheme: 'night', hintShown: true,
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
// a covered window gets no animation frames on Windows (see plugins.e2e.js)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
process.env.NEO_PLUGIN_DIRS = 'scripts/fixtures/plugins';
// run from scripts/, NEO's window would look for scripts/index.html
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');

let wc;
// the value of an expression in the window; what it throws comes back with
// its message, where executeJavaScript alone says only that the script failed
const js = async (code) => {
  const r = await wc.executeJavaScript(`(async () => {
    try { return { value: await (${code}) }; } catch (err) { return { error: String((err && err.stack) || err) }; }
  })()`, true);
  if ('error' in r) throw new Error(r.error);
  return r.value;
};
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const str = JSON.stringify;

// the book imported in main(): { id, chapters }
let book;

// the probe's calls
const where = () => js('window.__probe.neo.where()');
const go = (place) => js(`window.__probe.neo.go(${str(place)})`);
// a place without its scroll
const at = (place) => {
  if (!place) return place;
  const { scroll, ...rest } = place;
  return rest;
};

// letters `from` to `to` of a chapter's paragraph `pIdx` selected, or the
// caret at `from`; with toPara, the selection ends in that paragraph
async function select(chId, pIdx, from, to = from, toPara = pIdx) {
  await js(`(() => {
    const body = document.querySelector('.chapter[data-id="${chId}"] .chapter-body');
    body.focus();
    const ps = body.querySelectorAll('p');
    const r = document.createRange();
    r.setStart(ps[${pIdx}].firstChild, ${from});
    r.setEnd(ps[${toPara}].firstChild, ${to});
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
}

// what the selection holds, as captureCaret counts text (a Range's, not the
// Selection's own toString, which gives the text as laid out); how far down
// the page its start sits, as a share of the page's height; and the scroll
const selection = () => js(`(() => {
  const r = getSelection().getRangeAt(0);
  const sc = document.getElementById('paper-scroll');
  let rect = r.getBoundingClientRect();
  if (!rect.height) rect = (r.startContainer.nodeType === Node.ELEMENT_NODE ? r.startContainer : r.startContainer.parentElement).getBoundingClientRect();
  return { text: r.toString(), down: (rect.top - sc.getBoundingClientRect().top) / sc.clientHeight, scroll: sc.scrollTop };
})()`);

// a chapter's text set as NEO holds it, and the chapters drawn again
const setChapter = (chId, html) => js(`(() => { chapterHTML[${str(chId)}] = ${str(html)}; renderChapters(); })()`);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('place round trip', async () => {
  const [one, two] = book.chapters;
  // the caret at chapter 2, paragraph 3, offset 5, with the page scrolled
  // to put it near the top
  await select(two, 2, 5);
  await js(`(() => {
    const sc = document.getElementById('paper-scroll');
    const p = document.querySelectorAll('.chapter[data-id="${two}"] .chapter-body p')[2];
    sc.scrollTop += Math.round(p.getBoundingClientRect().top - sc.getBoundingClientRect().top - 120);
  })()`);
  const scroll = await js(`document.getElementById('paper-scroll').scrollTop`);
  assert.ok(scroll > 0, 'the page is scrolled');
  const back = await where();
  assert.deepEqual(back, { chId: two, pIdx: 2, off: 5, len: 0, scroll });
  // somewhere else, with no scroll given: the caret a third of the way down
  assert.equal(await go({ chId: one, pIdx: 20, off: 3, len: 0 }), true);
  assert.deepEqual(at(await where()), { chId: one, pIdx: 20, off: 3, len: 0 });
  const there = await selection();
  assert.ok(Math.abs(there.down - 1 / 3) < 0.02, `the caret sits ${there.down} of the way down`);
  assert.notEqual(there.scroll, scroll);
  // and back: the caret and the scroll as they were
  assert.equal(await go(back), true);
  assert.deepEqual(await where(), back);
  assert.equal((await selection()).scroll, scroll);
  assert.equal(await js('document.activeElement.closest(".chapter").dataset.id'), two, 'the chapter has the focus');
});

test('selection length', async () => {
  const [one] = book.chapters;
  await select(one, 0, 4, 13); // "paragraph" in "One paragraph."
  const place = await where();
  assert.deepEqual(at(place), { chId: one, pIdx: 0, off: 4, len: 9 });
  assert.equal(typeof place.scroll, 'number');
  // a selection across two paragraphs has no length within one
  await select(one, 0, 4, 4, 1);
  assert.deepEqual(at(await where()), { chId: one, pIdx: 0, off: 4, len: 0 });
  // go selects the length it is given
  await select(one, 1, 0);
  assert.equal(await go({ chId: one, pIdx: 0, off: 4, len: 9 }), true);
  assert.equal((await selection()).text, 'paragraph');
  assert.deepEqual(at(await where()), { chId: one, pIdx: 0, off: 4, len: 9 });
});

test('astral offsets', async () => {
  const three = book.chapters[2];
  // A, an emoji of two UTF-16 units, an e with its accent, a space, then x
  // in italics and y after them: seven units
  await setChapter(three, '<p>A\u{1F600}é <i>x</i>y</p>');
  await js(`(() => {
    const p = document.querySelector('.chapter[data-id="${three}"] .chapter-body p');
    p.closest('.chapter-body').focus();
    const r = document.createRange();
    r.setStart(p.lastChild, 1); // after "y"
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
  assert.deepEqual(at(await where()), { chId: three, pIdx: 0, off: 7, len: 0 });
  // go counts the same way, into and across the italics
  const picks = [[1, 2, '\u{1F600}'], [5, 1, 'x'], [3, 4, 'é xy']];
  for (const [off, len, text] of picks) {
    assert.equal(await go({ chId: three, pIdx: 0, off, len }), true, text);
    assert.equal((await selection()).text, text);
    assert.deepEqual(at(await where()), { chId: three, pIdx: 0, off, len }, text);
  }
});

// The page is what a place counts against, and it can differ from the
// HTML NEO holds: drawing a chapter heals no-break spaces the old editing
// engine planted, and NEO holds the old HTML until the writer types there.
test('chapter() reads the paragraphs a place counts, where the page healed the text', async () => {
  const three = book.chapters[2];
  await setChapter(three, '<p>Stray  space.</p>');
  const read = await js(`({
    held: chapterHTML[${str(three)}],
    paragraphs: window.__probe.neo.chapter(${str(three)}).paragraphs
  })`);
  assert.ok(read.held.includes(' '), 'NEO still holds the no-break space');
  assert.deepEqual(read.paragraphs, ['Stray  space.']);
  const place = { chId: three, pIdx: 0, off: 3, len: 5 };
  assert.equal(await go(place), true);
  assert.equal((await selection()).text, read.paragraphs[0].slice(place.off, place.off + place.len));
});

test('missing place', async () => {
  const [one] = book.chapters;
  await select(one, 1, 4);
  const before = await where();
  for (const place of [
    { chId: 'nope', pIdx: 0, off: 0, len: 0 },
    { chId: one, pIdx: 999, off: 0, len: 0 },
    // past the end of "Rain fell on the harbor.", or running past it
    { chId: one, pIdx: 1, off: 99, len: 0 },
    { chId: one, pIdx: 1, off: 20, len: 9 }
  ]) {
    assert.equal(await go(place), false, str(place));
    assert.deepEqual(await where(), before, `nothing moved for ${str(place)}`);
  }
  // from Notes: a missing place leaves the writer there, and a place that
  // is there brings them to the manuscript
  await js(`switchTab('notes')`);
  await tick(300);
  assert.equal(await go({ chId: 'nope', pIdx: 0, off: 0, len: 0 }), false);
  assert.equal(await js('currentTab'), 'notes');
  assert.equal(await go({ chId: one, pIdx: 0, off: 4, len: 9 }), true);
  assert.equal(await js('currentTab'), 'manuscript');
  assert.equal(await js(`document.getElementById('paper').checkVisibility()`), true);
  assert.equal((await selection()).text, 'paragraph');
  assert.deepEqual(at(await where()), { chId: one, pIdx: 0, off: 4, len: 9 });
});

test('a place that is not one', async () => {
  const [one] = book.chapters;
  const thrown = await js(`[
    null, 'ch', {}, { chId: ${str(one)}, pIdx: 0, off: 0 },
    { chId: ${str(one)}, pIdx: -1, off: 0, len: 0 },
    { chId: ${str(one)}, pIdx: 0, off: 0.5, len: 0 },
    { chId: ${str(one)}, pIdx: 0, off: 0, len: 0, scroll: 'top' },
    { chId: ${str(one)}, pIdx: 0, off: 0, len: 0, note: 'extra' }
  ].map((place) => { try { window.__probe.neo.go(place); return 'went'; } catch (err) { return err.name + ': ' + err.message; } })`);
  assert.equal(thrown.length, 8);
  for (const line of thrown) assert.match(line, /^TypeError: .*\bplace\b/);
});

test('old API', async () => {
  assert.equal(await js('window.__oldApi.activated'), true);
  assert.deepEqual(await js('[...NeoPlugins.apiVersions]'), [1, 2]);
  assert.deepEqual(await js('[typeof window.__oldApi.neo.where, typeof window.__oldApi.neo.go]'), ['undefined', 'undefined']);
});

/* ---------- runner ---------- */

async function main() {
  await app.whenReady();
  let failed = 0;
  try {
    let win;
    while (!(win = BrowserWindow.getAllWindows()[0])) await tick(50);
    wc = win.webContents;
    while (!(await js(`typeof library !== 'undefined' && !!library`).catch(() => false))) await tick(50);
    for (let i = 0; i < 100 && !(await js('!!(window.__probe && window.__probe.activated)')); i++) await tick(50);
    const filler = (n, what) => Array.from({ length: n }, (_, i) => ({ text: `Line ${i + 1} of the ${what}, long enough to fill the page with words.` }));
    book = await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([{ name: 'Places', chapters: [
        { title: 'One', paras: [{ text: 'One paragraph.' }, { text: 'Rain fell on the harbor.' }, ...${str(filler(40, 'first chapter'))}] },
        { title: 'Two', paras: [{ text: 'First of two.' }, { text: 'Second of two.' }, { text: 'Third of two.' }, ...${str(filler(40, 'second chapter'))}] },
        { title: 'Three', paras: [{ text: 'Short.' }] }
      ] }], library.shelves[0]);
      const id = library.shelves[0].bookIds[0];
      const meta = await window.neo.readBookMeta(id);
      return { id, chapters: meta.chapterOrder };
    })()`);
    await js(`openBook(${str(book.id)})`);
    await tick(500);
    win.focus();
    for (const t of tests) {
      try {
        await t.fn();
        console.log('ok   ' + t.name);
      } catch (err) {
        failed++;
        console.log('FAIL ' + t.name + '\n     ' + String(err.message).replace(/\n/g, '\n     '));
      }
    }
    console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  } catch (err) {
    failed++;
    console.error(err);
  } finally {
    app.exit(failed ? 1 : 0);
  }
}
main();
