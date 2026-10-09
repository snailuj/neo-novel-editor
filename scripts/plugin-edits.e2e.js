// End-to-end tests for API 2 of the plugin host (plugins.js): where the
// writer is, going to a place, replacing the text there and highlighting
// places, on a throwaway library. A place is { chId, pIdx, off, len,
// scroll? }, counted as captureCaret counts: pIdx among the chapter's
// paragraphs on the page, off and len in UTF-16 units across any inline
// elements. The fixture plugins are those of scripts/fixtures/plugins: the
// probe, written for API 2, keeps what it was handed as window.__probe.neo;
// old-api is written for API 1; and fleeting, written for API 2, registers
// when asked, highlights, and fails.
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
const replace = (place, expected, text) => js(`window.__probe.neo.replace(${str(place)}, ${str(expected)}, ${str(text)})`);
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
// the text of each of a chapter's paragraphs on the page
const lines = (chId) => js(`[...document.querySelectorAll('.chapter[data-id="${chId}"] .chapter-body p')].map((p) => p.textContent)`);
// a section note for a chapter, shown on the page as a ghost line after a
// ***; and gone again
const addGhost = (chId) => js(`(() => {
  book.sectionNotes = { ...book.sectionNotes, ${str(chId)}: [{ id: 'sec-plugin-edits', text: 'An outline note.' }] };
  syncGhosts(${str(chId)});
})()`);
const dropGhost = (chId) => js(`(() => { book.sectionNotes[${str(chId)}] = []; syncGhosts(${str(chId)}); })()`);

// a chapter's file, as saved; and the error log
const chapterFile = (chId) => fs.readFileSync(path.join(LIBRARY, book.id, 'chapters', chId + '.html'), 'utf8');
const errorLog = () => {
  try { return fs.readFileSync(path.join(LIBRARY, 'neo-errors.log'), 'utf8'); } catch { return ''; }
};
// waits for check() to hold, up to ms
async function until(check, what, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await tick(50)) if (await check()) return;
  assert.fail(`waited ${ms} ms for ${what}`);
}
// the details of the events the probe heard by this name, and forgetting
// what it heard
const heard = (name) => js(`window.__probe.events.filter(([n]) => n === ${str(name)}).map(([, detail]) => detail)`);
const forget = () => js('window.__probe.events.length = 0');
// the writer's ⌘Z (Ctrl+Z)
const undoKey = () => {
  const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
  for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode: 'z', modifiers });
};

// the probe's highlight call
const highlight = (name, places) => js(`window.__probe.neo.highlight(${str(name)}, ${str(places)})`);
// what CSS.highlights holds under a key: each range's text, as captureCaret
// counts it, and whether the range lies in a chapter on the page; null when
// the key holds nothing
const marked = (key) => js(`(() => {
  const h = CSS.highlights.get(${str(key)});
  const inChapter = (node) => node.isConnected && !!(node.nodeType === Node.TEXT_NODE ? node.parentElement : node).closest('.chapter-body');
  return h ? [...h].map((r) => ({ text: r.toString(), onPage: inChapter(r.startContainer) && inChapter(r.endContainer) })) : null;
})()`);
// the keys CSS.highlights holds for a plugin
const keysOf = (id) => js(`[...CSS.highlights.keys()].filter((key) => key.startsWith(${str(`plugin-${id}-`)})).sort()`);
// every chapter save NEO has to make, made
const saved = () => js(`(async () => { flushAllSaves(); await Promise.allSettled(Object.values(chapterChain)); })()`);

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

// A place that starts or ends between the two halves of a character outside
// the Basic Multilingual Plane would cut it in two: there is no such place.
test('a place never cuts a character in two', async () => {
  const three = book.chapters[2];
  await setChapter(three, '<p>A\u{1F600}é <i>x</i>y</p>');
  await select(three, 0, 0);
  const before = await where();
  for (const half of [{ off: 2, len: 0 }, { off: 2, len: 1 }, { off: 1, len: 1 }, { off: 0, len: 2 }]) {
    assert.equal(await go({ chId: three, pIdx: 0, ...half }), false, str(half));
    assert.deepEqual(await where(), before, `nothing moved for ${str(half)}`);
  }
  assert.equal(await go({ chId: three, pIdx: 0, off: 1, len: 2 }), true, 'the whole character is a place');
  assert.equal((await selection()).text, '\u{1F600}');
});

// A placeholder's flag sits mid-paragraph as a span the writer cannot type
// in, and its ⚑ counts as one unit, as captureCaret counts it.
test('a place across a placeholder mark', async () => {
  const three = book.chapters[2];
  await setChapter(three, '<p>ab<span class="ph-mark" data-sid="s-plugin-edits" contenteditable="false">⚑</span>cd</p>');
  // the caret just past the mark, as the element's child offset and as
  // the start of the text after it
  for (const after of ['[p, 2]', '[p.lastChild, 0]']) {
    await js(`(() => {
      const p = document.querySelector('.chapter[data-id="${three}"] .chapter-body p');
      p.closest('.chapter-body').focus();
      const r = document.createRange();
      r.setStart(...${after});
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    })()`);
    await tick(100);
    assert.deepEqual(at(await where()), { chId: three, pIdx: 0, off: 3, len: 0 }, after);
  }
  // and over it
  assert.equal(await go({ chId: three, pIdx: 0, off: 1, len: 3 }), true);
  assert.equal((await selection()).text, 'b⚑c');
  assert.deepEqual(at(await where()), { chId: three, pIdx: 0, off: 1, len: 3 });
});

// The page is what a place counts against, and it can differ from the
// HTML NEO holds: drawing a chapter heals no-break spaces the old editing
// engine planted, and NEO holds the old HTML until the writer types there.
test('chapter() reads the paragraphs a place counts, where the page healed the text', async () => {
  const three = book.chapters[2];
  await setChapter(three, '<p>Stray\u00a0 space.</p>');
  const read = await js(`({
    held: chapterHTML[${str(three)}],
    paragraphs: window.__probe.neo.chapter(${str(three)}).paragraphs
  })`);
  assert.ok(read.held.includes('\u00a0'), 'NEO still holds the no-break space');
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

// Leaving the Outline puts down an open card, and saving its note can
// rewrite a ghost line or add lines to the page. go looks for the place
// again once the manuscript is up: one gone by then is missing, and
// nothing is selected.
test('a place the open card rewrites on the way back is missing', async () => {
  const three = book.chapters[2];
  await setChapter(three, '<p>Short.</p>');
  await addGhost(three);
  const ghost = (await lines(three)).indexOf('An outline note.');
  assert.ok(ghost > 0, 'the note is a ghost line on the page');
  await select(three, 0, 2);
  const before = await where();
  await js(`switchTab('outline')`);
  await tick(300);
  // the card open, its note shortened and not yet saved
  await js(`(() => {
    openCard(document.querySelector('.ob-cell[data-sec="sec-plugin-edits"]'));
    cardEditor.text.textContent = 'Note.';
  })()`);
  // "outline", on the page until the card is put down
  assert.equal(await go({ chId: three, pIdx: ghost, off: 3, len: 7 }), false);
  assert.equal(await js('currentTab'), 'manuscript');
  assert.equal((await lines(three))[ghost], 'Note.');
  assert.deepEqual(await where(), before, 'the caret is where the writer left it');
  await dropGhost(three);
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

// "paragraph" in "One paragraph.", chapter one's first line, and the place
// "passage" takes once it is written there
const word = () => ({ chId: book.chapters[0], pIdx: 0, off: 4, len: 9 });
const written = () => ({ ...word(), len: 7 });

test('replace saves', async () => {
  const [one] = book.chapters;
  await select(one, 1, 0);
  await forget();
  assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: true });
  assert.equal((await lines(one))[0], 'One passage.');
  const saves = async () => (await heard('chapter-saved')).filter((saved) => saved.chId === one);
  await until(async () => (await saves()).length, 'chapter-saved');
  assert.deepEqual(await saves(), [{ bookId: book.id, chId: one }]);
  assert.match(chapterFile(one), /One passage\./);
});

// the engine's own undo, as for typing: "replace saves" left "One passage."
test('undo restores', async () => {
  const [one] = book.chapters;
  assert.equal((await lines(one))[0], 'One passage.');
  undoKey();
  await until(async () => (await lines(one))[0] === 'One paragraph.', 'the undo');
  await until(() => chapterFile(one).includes('One paragraph.'), 'the next save to write it');
});

test('stale is refused once', async () => {
  const [one] = book.chapters;
  await select(one, 1, 0);
  const page = await lines(one);
  const file = chapterFile(one);
  await forget();
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await replace(word(), 'paragrap!', 'x'), { ok: false, reason: 'stale' });
    assert.deepEqual(await lines(one), page);
  }
  await tick(1500); // past the save's wait
  assert.deepEqual((await heard('chapter-saved')).filter((saved) => saved.chId === one), [], 'nothing is written');
  assert.equal(chapterFile(one), file);
});

test('refusals', async () => {
  const [one, , three] = book.chapters;
  await select(one, 1, 0);
  const page = await lines(one);
  // off the manuscript, the writer stays where they are
  await js(`switchTab('notes')`);
  await tick(300);
  assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: false, reason: 'hidden' });
  assert.equal(await js('currentTab'), 'notes');
  await js(`switchTab('manuscript')`);
  await tick(300);
  assert.deepEqual(await lines(one), page);
  assert.deepEqual(await replace({ ...word(), pIdx: 99 }, 'paragraph', 'passage'), { ok: false, reason: 'missing' });
  assert.deepEqual(await lines(one), page);
  // a ghost line is the outline's note, not the writer's words
  await setChapter(three, '<p>Short.</p>');
  await addGhost(three);
  const ghost = (await lines(three)).indexOf('An outline note.');
  await select(one, 1, 0);
  assert.deepEqual(await replace({ chId: three, pIdx: ghost, off: 3, len: 7 }, 'outline', 'inline'), { ok: false, reason: 'blocked' });
  assert.equal((await lines(three))[ghost], 'An outline note.');
  await dropGhost(three);
  // vim keys' moving mode refuses whatever would be typed
  await select(one, 1, 0);
  await js('(() => { vimEnabled = true; vimSetNav(true); })()');
  try {
    assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: false, reason: 'blocked' });
  } finally {
    await js('(() => { vimSetNav(false); vimEnabled = false; applyVim(); })()');
  }
  assert.deepEqual(await lines(one), page);
});

// Text that comes out other than meant, because something changed it as it
// was written, is taken back by the engine's undo, once, and both texts go
// to the log
test('a mismatch is taken back', async () => {
  const [one] = book.chapters;
  const html = await js(`chapterHTML[${str(one)}]`);
  await select(one, 1, 0);
  // the something: a listener that adds a ! to the line behind the engine
  await js(`document.querySelector('.chapter[data-id="${one}"] .chapter-body').addEventListener('input', (e) => {
    e.currentTarget.querySelector('p').firstChild.data += '!';
  }, { once: true, capture: true })`);
  assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: false, reason: 'blocked' });
  assert.equal((await lines(one))[0], 'One paragraph.!', 'the edit is undone, and only the edit');
  await until(() => errorLog().includes('replace was undone'), 'the log');
  assert.match(errorLog(), /plugin probe: replace was undone: the paragraph read "One passage\.!" where "One passage\." was meant/);
  await setChapter(one, html);
  assert.equal((await lines(one))[0], 'One paragraph.');
});

// A listener that refuses the insert and changes the line itself, as
// app.js's ghost handler does, leaves nothing of replace's to take back:
// the engine's undo would take the writer's last typing instead
test('a refusal undoes nothing', async () => {
  const [one] = book.chapters;
  const html = await js(`chapterHTML[${str(one)}]`);
  await select(one, 1, 4); // after "Rain"
  wc.sendInputEvent({ type: 'char', keyCode: 'y' });
  await until(async () => (await lines(one))[1] === 'Rainy fell on the harbor.', 'the writer\'s typing');
  await js(`document.addEventListener('beforeinput', (e) => {
    e.preventDefault();
    document.querySelector('.chapter[data-id="${one}"] .chapter-body p').firstChild.data += '!';
  }, { once: true, capture: true })`);
  assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: false, reason: 'blocked' });
  assert.deepEqual((await lines(one)).slice(0, 2), ['One paragraph.!', 'Rainy fell on the harbor.'], 'the writer\'s typing stays');
  await until(() => errorLog().includes('replace was refused'), 'the log');
  assert.match(errorLog(), /plugin probe: replace was refused, and nothing undone: the paragraph read "One paragraph\.!" where "One paragraph\." was/);
  await setChapter(one, html);
  assert.equal((await lines(one))[0], 'One paragraph.');
});

test('caret kept', async () => {
  const [one, two] = book.chapters;
  // a caret in another chapter, far down the page, stays, with the scroll
  await select(two, 20, 5);
  const away = await where();
  assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: true });
  assert.deepEqual(await where(), away);
  assert.equal(await js('document.activeElement.closest(".chapter").dataset.id'), two, 'and the focus');
  assert.deepEqual(await replace(written(), 'passage', 'paragraph'), { ok: true });
  // one in another paragraph of the chapter, or earlier in the same one, stays
  for (const [pIdx, off] of [[1, 5], [0, 2], [0, 4]]) {
    await select(one, pIdx, off);
    const before = await where();
    assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: true });
    assert.deepEqual(await where(), before, `the caret at ${pIdx}:${off}`);
    assert.deepEqual(await replace(written(), 'passage', 'paragraph'), { ok: true });
  }
  // one later in the same paragraph moves with the words after it, by -2
  await select(one, 0, 13); // before the full stop
  const later = await where();
  assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: true });
  assert.deepEqual(await where(), { ...later, off: 11 });
  assert.deepEqual(await replace(written(), 'passage', 'paragraph'), { ok: true });
  assert.equal((await lines(one))[0], 'One paragraph.');
});

// Review focus: replace while an input method composes is refused, and
// changes nothing
test('composition', async () => {
  const [one] = book.chapters;
  await select(one, 1, 0);
  const compose = (type) => js(`document.querySelector('.chapter[data-id="${one}"] .chapter-body').dispatchEvent(new CompositionEvent('${type}', { bubbles: true, data: '' }))`);
  await compose('compositionstart');
  try {
    assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: false, reason: 'busy' });
    assert.equal((await lines(one))[0], 'One paragraph.');
  } finally {
    await compose('compositionend');
  }
  assert.deepEqual(await replace(word(), 'paragraph', 'passage'), { ok: true });
  assert.equal((await lines(one))[0], 'One passage.');
  assert.deepEqual(await replace(written(), 'passage', 'paragraph'), { ok: true });
});

// Review focus: offsets across inline marks count as captureCaret counts,
// and what the engine wraps its edits in never reaches the file
test('inline marks', async () => {
  const three = book.chapters[2];
  await setChapter(three, '<p>The <i>owl</i> flew home.</p>');
  await select(three, 0, 0);
  // "wl fl", from inside the italics to past them
  assert.deepEqual(await replace({ chId: three, pIdx: 0, off: 5, len: 5 }, 'wl fl', 'ak dr'), { ok: true });
  assert.equal((await lines(three))[0], 'The oak drew home.');
  const text = (html) => html.replace(/<[^>]*>/g, '');
  await until(() => text(chapterFile(three)).includes('The oak drew home.'), 'the file to follow');
  assert.doesNotMatch(chapterFile(three), /style=/);
  assert.doesNotMatch(chapterFile(three), /<span/);
  // on either side of a placeholder's flag, which stays
  await setChapter(three, '<p>ab<span class="ph-mark" data-sid="s-plugin-edits" contenteditable="false">⚑</span>cd</p>');
  await select(three, 0, 0);
  assert.deepEqual(await replace({ chId: three, pIdx: 0, off: 3, len: 2 }, 'cd', 'xy'), { ok: true });
  assert.deepEqual(await replace({ chId: three, pIdx: 0, off: 1, len: 1 }, 'b', 'B'), { ok: true });
  assert.equal((await lines(three))[0], 'aB⚑xy');
  assert.equal(await js(`document.querySelectorAll('.chapter[data-id="${three}"] .ph-mark').length`), 1);
  // and past a flag that ends its paragraph
  await setChapter(three, '<p>ab<span class="ph-mark" data-sid="s-plugin-edits" contenteditable="false">⚑</span></p>');
  await select(three, 0, 0);
  assert.deepEqual(await replace({ chId: three, pIdx: 0, off: 3, len: 0 }, '', 'z'), { ok: true });
  assert.equal((await lines(three))[0], 'ab⚑z');
});

test('bad input', async () => {
  const [one] = book.chapters;
  const thrown = await js(`(async () => {
    const out = [];
    for (const [place, expected, text] of [
      [${str(word())}, 'paragrap', 'x'],
      [${str(word())}, 'paragraph', 'two\\nlines'],
      [${str(word())}, 'paragraph', 'two\\rlines'],
      [${str(word())}, 'paragraph', 7],
      [${str(word())}, null, 'x'],
      [{ chId: ${str(one)}, pIdx: -1, off: 0, len: 0 }, '', 'x']
    ]) {
      try {
        await window.__probe.neo.replace(place, expected, text);
        out.push('replaced');
      } catch (err) {
        out.push(err.name + ': ' + err.message);
      }
    }
    return out;
  })()`);
  assert.equal(thrown.length, 6);
  for (const line of thrown) assert.match(line, /^TypeError: replace (takes|writes) /);
  assert.equal((await lines(one))[0], 'One paragraph.');
});

test('old API', async () => {
  assert.equal(await js('window.__oldApi.activated'), true);
  assert.deepEqual(await js('[...NeoPlugins.apiVersions]'), [1, 2]);
  assert.deepEqual(await js('[typeof window.__oldApi.neo.where, typeof window.__oldApi.neo.go, typeof window.__oldApi.neo.replace, typeof window.__oldApi.neo.highlight]'), ['undefined', 'undefined', 'undefined', 'undefined']);
});

// A highlight is drawn with the CSS Highlight API, which marks text without
// touching the page: nothing reaches the chapter's HTML, its file or the
// undo history.
test('marks without writing', async () => {
  const [one] = book.chapters;
  // what earlier tests left to save is saved first
  await saved();
  const file = path.join(LIBRARY, book.id, 'chapters', `${one}.html`);
  const state = async () => ({
    ...(await js(`({
      held: chapterHTML[${str(one)}],
      page: document.querySelector('.chapter[data-id="${one}"] .chapter-body').innerHTML,
      undo: undoStack.length
    })`)),
    mtime: fs.statSync(file).mtimeMs
  });
  const before = await state();
  await highlight('claims', [{ chId: one, pIdx: 0, off: 4, len: 9 }]);
  assert.deepEqual(await marked('plugin-probe-claims'), [{ text: 'paragraph', onPage: true }]);
  // the probe's own stylesheet, linked once, styles it by that name
  assert.deepEqual(await js(`[...document.styleSheets]
    .filter((s) => (s.href || '').endsWith('/probe/style.css'))
    .map((s) => [...s.cssRules].map((r) => r.selectorText))`), [['::highlight(plugin-probe-claims)']]);
  await saved();
  assert.deepEqual(await state(), before, 'the page, NEO\'s copy, the undo history and the file are as they were');
});

// Drawing the chapters again ends every Range into them; the host builds
// them again from the places it keeps. A place no longer on the page is
// left out, and counted on the console.
test('survives re-render', async () => {
  const [one, two] = book.chapters;
  await highlight('claims', [
    { chId: one, pIdx: 0, off: 4, len: 9 },
    { chId: two, pIdx: 1, off: 0, len: 6 },
    { chId: one, pIdx: 999, off: 0, len: 1 }
  ]);
  const both = [{ text: 'paragraph', onPage: true }, { text: 'Second', onPage: true }];
  assert.deepEqual(await marked('plugin-probe-claims'), both);
  const debug = await js(`(() => {
    const lines = [];
    const real = console.debug;
    console.debug = (...args) => lines.push(args.join(' '));
    try { renderChapters(); } finally { console.debug = real; }
    return lines.filter((line) => line.startsWith('plugin probe: '));
  })()`);
  assert.deepEqual(await marked('plugin-probe-claims'), both);
  assert.equal(debug.length, 1, debug.join('\n'));
  assert.match(debug[0], /\bclaims\b.*\b1 of 3 places\b/);
});

test('clears', async () => {
  const [one] = book.chapters;
  const place = { chId: one, pIdx: 0, off: 4, len: 9 };
  await highlight('claims', [place]);
  await highlight('others', [place]);
  await highlight('claims', []);
  assert.deepEqual(await keysOf('probe'), ['plugin-probe-others']);
  // a cleared name stays cleared when the chapters are drawn again
  await js('renderChapters()');
  assert.deepEqual(await keysOf('probe'), ['plugin-probe-others']);
  // a plugin that marks while it activates and then fails: disposal takes
  // every highlight it made, and no other plugin's
  await js(`window.__registerFleeting(${str([place])})`);
  assert.deepEqual(await keysOf('fleeting'), ['plugin-fleeting-one', 'plugin-fleeting-two']);
  await js('window.__fleeting.fail()');
  await tick();
  assert.deepEqual(await keysOf('fleeting'), []);
  assert.deepEqual(await marked('plugin-probe-others'), [{ text: 'paragraph', onPage: true }]);
  // once disposed, it marks nothing
  await js(`window.__fleeting.neo.highlight('three', ${str([place])})`);
  assert.deepEqual(await keysOf('fleeting'), []);
  await highlight('others', []);
  assert.deepEqual(await keysOf('probe'), []);
});

// Review focus 5: a placeholder's flag is text on the page, one UTF-16
// unit, and captureCaret counts it; a place across it marks what it counts.
test('inside a placeholder', async () => {
  const three = book.chapters[2];
  await setChapter(three, '<p>Fix <span class="ph-mark" data-sid="s-probe" contenteditable="false">⚑</span> this later.</p>');
  await highlight('claims', [{ chId: three, pIdx: 0, off: 4, len: 6 }]);
  assert.deepEqual(await marked('plugin-probe-claims'), [{ text: '⚑ this', onPage: true }]);
  // the caret after "this", in the text after the flag, is where the place ends
  await js(`(() => {
    const p = document.querySelector('.chapter[data-id="${three}"] .chapter-body p');
    p.closest('.chapter-body').focus();
    const r = document.createRange();
    r.setStart(p.lastChild, 5);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
  assert.deepEqual(at(await where()), { chId: three, pIdx: 0, off: 10, len: 0 });
  assert.equal((await js(`window.__probe.neo.chapter(${str(three)}).paragraphs[0]`)).slice(4, 10), '⚑ this');
  await highlight('claims', []);
});

// go finds its place through rangeOfPlace and a highlight finds its places
// through rangesOfPlaces, by the same rules. Each place here is one both
// take, with the same text, or both leave out, so a rule added to one of
// them alone fails here.
test('highlight and go agree on every place', async () => {
  const [one, , three] = book.chapters;
  // A, an emoji of two UTF-16 units, an e with its accent, a space, then x
  // in italics and y after them: seven units
  await setChapter(three, '<p>A\u{1F600}é <i>x</i>y</p>');
  // the text go selects and the text the highlight marks, each null when it
  // takes nothing, as JSON, which keeps a lone surrogate; with unordered,
  // the place's chapter stays on the page but is out of the book's order
  const verdicts = (place, unordered = false) => js(`(() => {
    const neo = window.__probe.neo;
    const order = book.chapterOrder;
    if (${unordered}) book.chapterOrder = order.filter((id) => id !== ${str(place.chId)});
    try {
      const went = neo.go(${str(place)});
      neo.highlight('agree', [${str(place)}]);
      const marks = [...CSS.highlights.get('plugin-probe-agree')];
      return {
        go: went ? JSON.stringify(getSelection().getRangeAt(0).toString()) : null,
        highlight: marks.length ? JSON.stringify(marks[0].toString()) : null
      };
    } finally {
      book.chapterOrder = order;
    }
  })()`);
  const both = (text) => ({ go: text === null ? null : str(text), highlight: text === null ? null : str(text) });
  for (const [place, text] of [
    [{ chId: one, pIdx: 0, off: 4, len: 9 }, 'paragraph'],
    [{ chId: one, pIdx: 1, off: 24, len: 0 }, ''], // the end of "Rain fell on the harbor."
    [{ chId: three, pIdx: 0, off: 1, len: 2 }, '\u{1F600}'],
    [{ chId: three, pIdx: 0, off: 3, len: 4 }, 'é xy'],
    [{ chId: 'nope', pIdx: 0, off: 0, len: 0 }, null],
    [{ chId: one, pIdx: 999, off: 0, len: 0 }, null],
    [{ chId: one, pIdx: 1, off: 99, len: 0 }, null],
    [{ chId: one, pIdx: 1, off: 20, len: 9 }, null],
    [{ chId: three, pIdx: 0, off: 7, len: 1 }, null] // past the y
  ]) {
    assert.deepEqual(await verdicts(place), both(text), str(place));
  }
  // a chapter on the page that the book no longer orders
  const x = { chId: three, pIdx: 0, off: 5, len: 1 };
  assert.deepEqual(await verdicts(x), both('x'));
  assert.deepEqual(await verdicts(x, true), both(null), 'out of the book\'s order');
  // half of the emoji: whether a place may split one is pointIn's to say,
  // for both of them alike
  const half = await verdicts({ chId: three, pIdx: 0, off: 1, len: 1 });
  assert.equal(half.go, half.highlight, 'half of the emoji');
  await highlight('agree', []);
});

// A place names no book, so a highlight holds for the open book alone: it
// goes when the book closes, and on the shelf there is nothing to mark.
test('a book closing clears them', async () => {
  const [one] = book.chapters;
  const place = { chId: one, pIdx: 0, off: 4, len: 9 };
  await highlight('claims', [place]);
  await js('backToShelf()');
  await tick(300);
  assert.deepEqual(await keysOf('probe'), []);
  await highlight('claims', [place]);
  assert.deepEqual(await keysOf('probe'), []);
  await js(`openBook(${str(book.id)})`);
  await tick(500);
  assert.deepEqual(await keysOf('probe'), [], 'the book opened again shows none of them');
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
