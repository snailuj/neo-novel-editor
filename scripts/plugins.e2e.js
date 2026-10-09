// End-to-end tests for the plugin host in the window (plugins.js), on a
// throwaway library, with the fixture plugins in scripts/fixtures/plugins:
// probe writes down every event, broken throws while it activates, late
// registers only when asked, and missing-script has no script at all.
// Run with `npm run test:plugins`.

'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A folder of its own for each run. Chromium writes to its profile until
// the process is gone, so a run can't remove its own; it removes those of
// earlier runs whose process has ended instead, leaving any still running.
for (const name of fs.readdirSync(os.tmpdir())) {
  const pid = /^neo-plugins-test-(\d+)-/.exec(name);
  if (!pid || +pid[1] === process.pid) continue;
  try { process.kill(+pid[1], 0); continue; } catch (err) { if (err.code === 'EPERM') continue; }
  fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `neo-plugins-test-${process.pid}-`));
const LIBRARY = path.join(tmp, 'NEO Library');
app.setPath('userData', path.join(tmp, 'app'));
app.setPath('documents', tmp);
fs.mkdirSync(LIBRARY);
// hintShown: the once-per-library Enter hint would otherwise fill #hint
fs.writeFileSync(path.join(LIBRARY, 'library.json'), JSON.stringify({
  authorName: '', penNames: [], firstRunDone: true, pageTheme: 'night', hintShown: true,
  shelves: [{ id: 'shelf-1', name: 'Works in Progress', bookIds: [] }]
}));
// Windows stops a window's animation frames while it counts the window as
// covered, even a focused one, and the selection and chapter-change events
// come once a frame: the test window counts as uncovered whatever lies on it
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// the fixture plugins, found the way a developer's own would be
process.env.NEO_PLUGIN_DIRS = 'scripts/fixtures/plugins';
// everything the window writes to its console, where Chromium reports a
// script the CSP refused
const consoleLines = [];
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (e) => consoleLines.push(String(e.message)));
});
// run from scripts/, NEO's window would look for scripts/index.html
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, opts) {
  return loadFile.call(this, path.resolve(__dirname, '..', file), opts);
};
require('../main.js');

let wc;
const js = (code) => wc.executeJavaScript(code, true);
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const str = JSON.stringify;

// the books imported in main(), each { id, chapters }
let owls;
let other;
// #hint as the plugins left it at launch, before anything else spoke
let hintAtLaunch;

const errorLog = () => {
  try { return fs.readFileSync(path.join(LIBRARY, 'neo-errors.log'), 'utf8'); } catch { return ''; }
};
// the window logs through IPC, so a line lands a moment after it is sent
async function logWith(text) {
  for (let i = 0; i < 60 && !errorLog().includes(text); i++) await tick(50);
  return errorLog();
}
const chapterFile = (bookId, chId) => fs.readFileSync(path.join(LIBRARY, bookId, 'chapters', chId + '.html'), 'utf8');
// what the probe heard, by event name; selection comes every frame the
// caret moves, so it is left out unless asked for
const heard = (...names) => js(`window.__probe.events.filter(([name]) => ${names.length
  ? `${str(names)}.includes(name)` : `name !== 'selection'`})`);
const forget = () => js('window.__probe.events.length = 0');

// typed as keys
async function type(keys) {
  for (const k of keys) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: k });
    wc.sendInputEvent({ type: 'char', keyCode: k });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k });
  }
  await tick(300);
}

// the caret at the end of a chapter, as a click after its last word leaves it
async function caretAtEnd(chId) {
  await js(`(() => {
    const body = document.querySelector('.chapter[data-id="${chId}"] .chapter-body');
    body.focus();
    const r = document.createRange();
    r.selectNodeContents(body.lastElementChild);
    r.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(100);
}

// letters `from` to `to` of a chapter's paragraph `pIdx` selected
async function select(chId, pIdx, from, to) {
  await js(`(() => {
    const body = document.querySelector('.chapter[data-id="${chId}"] .chapter-body');
    body.focus();
    const text = body.querySelectorAll('p')[${pIdx}].firstChild;
    const r = document.createRange();
    r.setStart(text, ${from});
    r.setEnd(text, ${to});
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  })()`);
  await tick(200);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('registers', async () => {
  assert.notEqual(await js('typeof window.__probe'), 'undefined', 'window.__probe is undefined: the probe never loaded');
  assert.equal(await js('window.__probe.activated'), true);
});

test('refusals', async () => {
  await js(`(() => {
    window.__refused = [];
    NeoPlugins.register({ id: 'stranger', apiVersion: 1, activate() { window.__refused.push('stranger'); } });
    NeoPlugins.register({ id: 'probe', apiVersion: 99, activate() { window.__refused.push('probe'); } });
  })()`);
  const log = await logWith('plugin probe:');
  assert.match(log, /plugin stranger: .*not activated/);
  assert.match(log, /plugin probe: apiVersion 99\b.*not activated/);
  assert.deepEqual(await js('window.__refused'), []);
});

test('a plugin whose script does not load is logged and the rest carry on', async () => {
  const log = await logWith('plugin missing-script:');
  assert.match(log, /plugin missing-script: .*scripts\/fixtures\/plugins\/missing-script\/renderer\.js/);
  assert.equal(await js('window.__probe.activated'), true);
});

test('events', async () => {
  await forget();
  await js(`openBook(${str(owls.id)})`);
  await tick(300);
  await caretAtEnd(owls.chapters[0]);
  await type('Owl');
  await tick(2000);
  const events = await heard();
  const order = events.map(([name]) => name).filter((name, i, all) => name !== all[i - 1]);
  assert.deepEqual(order, ['book-open', 'rendered', 'chapter-change', 'chapter-saved']);
  const first = (name) => events.find(([n]) => n === name)[1];
  assert.deepEqual(first('book-open'), { bookId: owls.id });
  assert.deepEqual(first('rendered'), { bookId: owls.id });
  assert.deepEqual(first('chapter-change'), { bookId: owls.id, chId: owls.chapters[0] });
  assert.deepEqual(first('chapter-saved'), { bookId: owls.id, chId: owls.chapters[0] });
  assert.match(chapterFile(owls.id, owls.chapters[0]), /Owl/);
});

test('selection', async () => {
  await forget();
  await select(owls.chapters[0], 0, 4, 13); // "paragraph" in "One paragraph."
  const [, { place }] = (await heard('selection')).pop();
  const { scroll, ...at } = place;
  assert.deepEqual(at, { chId: owls.chapters[0], pIdx: 0, off: 4, len: 9 });
  assert.equal(typeof scroll, 'number');
  // off the manuscript, the place is null
  await js(`switchTab('notes')`);
  await js(`(() => {
    const notes = document.getElementById('aux-editor');
    notes.focus();
    getSelection().selectAllChildren(notes);
  })()`);
  await tick(200);
  assert.deepEqual((await heard('selection')).pop(), ['selection', { place: null }]);
  await js(`switchTab('manuscript')`);
  await tick(200);
});

test('book-close on the shelf', async () => {
  await forget();
  await js('backToShelf()');
  await tick(200);
  assert.deepEqual(await heard('book-open', 'book-close'), [['book-close', { bookId: owls.id }]]);
});

test('book switch', async () => {
  await js(`openBook(${str(owls.id)})`);
  await tick(300);
  await forget();
  await js(`openBook(${str(other.id)})`);
  await tick(300);
  assert.deepEqual(await heard('book-open', 'book-close'), [
    ['book-close', { bookId: owls.id }],
    ['book-open', { bookId: other.id }]
  ]);
  await js('backToShelf()');
  await tick(200);
  // a shelf export borrows `book` while an openBook waits on its reads:
  // that book was never open, so nothing closes. The book that opens is
  // open, and readable, though the export has not finished.
  await forget();
  const order = await js(`(async () => {
    const order = [];
    const neo = window.__probe.neo;
    const reads = () => (neo.book() && neo.book().id) + (neo.chapter(${str(owls.chapters[0])}) ? ' and its chapter' : '');
    const off = neo.on('book-open', () => order.push('book-open reads ' + reads()));
    const realExport = doExport;
    let release = null;
    doExport = () => {
      order.push('export holds the book');
      return new Promise((resolve) => { release = resolve; });
    };
    try {
      const opening = openBook(${str(owls.id)}).then(() => order.push('opened'));
      const exporting = exportFromShelf(${str(other.id)}, 'txt');
      await opening;
      order.push('then reads ' + reads());
      if (release) release();
      await exporting;
    } finally {
      doExport = realExport;
      off();
    }
    return order;
  })()`);
  assert.deepEqual(order, [
    'export holds the book',
    `book-open reads ${owls.id} and its chapter`,
    'opened',
    `then reads ${owls.id} and its chapter`
  ], 'the export held the book while openBook read, and the opened book reads as open');
  await tick(300);
  assert.deepEqual(await heard('book-open', 'book-close'), [['book-open', { bookId: owls.id }]]);
});

test('late activation', async () => {
  assert.equal(await js('book && book.id'), owls.id);
  await js('window.__registerLate()');
  assert.deepEqual(await js('window.__late.events'), [['book-open', { bookId: owls.id }]]);
});

test('coalescing', async () => {
  await caretAtEnd(owls.chapters[0]);
  // twenty inputs in one burst, each marked in the probe's list as it lands
  const names = await js(`(async () => {
    const body = document.querySelector('.chapter[data-id="${owls.chapters[0]}"] .chapter-body');
    const mark = () => window.__probe.events.push(['input']);
    window.__probe.events.length = 0;
    body.addEventListener('input', mark);
    try {
      for (let i = 0; i < 20; i++) document.execCommand('insertText', false, 'z');
    } finally {
      body.removeEventListener('input', mark);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    return window.__probe.events.map(([name]) => name).filter((name) => name === 'input' || name === 'chapter-change');
  })()`);
  const changes = names.filter((name) => name === 'chapter-change').length;
  assert.equal(names.filter((name) => name === 'input').length, 20);
  assert.ok(changes >= 1 && changes <= 3, `${changes} chapter-change events for 20 inputs`);
  assert.equal(names[names.length - 1], 'chapter-change', 'the last chapter-change comes after the final input');
  await tick(1500); // the save lands before the next test
});

test('reads', async () => {
  const chId = owls.chapters[0];
  const read = await js(`(() => {
    const neo = window.__probe.neo;
    const copy = neo.book();
    const same = JSON.stringify(copy) === JSON.stringify(book);
    copy.title = 'Changed by a plugin';
    copy.chapterOrder.push('ch-made-up');
    return {
      same,
      untouched: book.title !== copy.title && !book.chapterOrder.includes('ch-made-up'),
      chapter: neo.chapter(${str(chId)}),
      html: chapterHTML[${str(chId)}],
      page: [...document.querySelectorAll('.chapter[data-id="${chId}"] .chapter-body p')].map((p) => p.textContent),
      missing: neo.chapter('ch-nope')
    };
  })()`);
  assert.ok(read.same, 'book() holds the open book');
  assert.ok(read.untouched, 'book() is a copy: changing it leaves the open book alone');
  assert.equal(read.chapter.id, chId);
  assert.equal(read.chapter.html, read.html);
  assert.deepEqual(read.chapter.paragraphs, read.page);
  assert.ok(read.page.length >= 2 && read.page[0] === 'One paragraph.', read.page.join(' | '));
  assert.equal(read.missing, null);

  await js('backToShelf()');
  await tick(200);
  assert.deepEqual(await js(`[window.__probe.neo.book(), window.__probe.neo.chapter(${str(chId)})]`), [null, null]);

  // a shelf export borrows `book` for a moment: still nothing to read
  const during = await js(`(async () => {
    const realExport = doExport;
    let seen = null;
    doExport = async () => {
      seen = { borrowed: book && book.id, book: window.__probe.neo.book(), chapter: window.__probe.neo.chapter(${str(other.chapters[0])}) };
    };
    try {
      await exportFromShelf(${str(other.id)}, 'txt');
    } finally {
      doExport = realExport;
    }
    return seen;
  })()`);
  assert.deepEqual(during, { borrowed: other.id, book: null, chapter: null });
  await js(`openBook(${str(owls.id)})`);
  await tick(300);
});

test('broken plugin', async () => {
  assert.equal(hintAtLaunch, '', 'nothing was shown to the writer');
  const log = await logWith('plugin broken:');
  assert.match(log, /plugin broken: Error: broken on purpose\r?\n\s+at /);
  // writing goes on, and the listener it added before it threw never runs
  await forget();
  await caretAtEnd(owls.chapters[0]);
  await type('Fox');
  await tick(1500);
  assert.deepEqual((await heard('chapter-saved')).pop(), ['chapter-saved', { bookId: owls.id, chId: owls.chapters[0] }]);
  assert.match(chapterFile(owls.id, owls.chapters[0]), /Fox/);
  assert.equal(await js('window.__brokenHeard'), 0);
});

test('listeners that throw or reject', async () => {
  const chId = owls.chapters[0];
  // the probe adds listeners as any plugin might: one throws, the next
  // one's promise rejects, and one comes after them. chapter-saved goes out
  // from inside the save itself. A Symbol has no text form.
  await js(`(() => {
    const neo = window.__probe.neo;
    window.__calls = [];
    window.__off = [
      neo.on('chapter-saved', () => { window.__calls.push('throws'); throw new Error('a listener throws on purpose'); }),
      neo.on('chapter-saved', async () => { window.__calls.push('rejects'); throw new Error('a listener rejects on purpose'); }),
      neo.on('chapter-saved', () => { window.__calls.push('after'); }),
      neo.on('book-close', () => { throw Symbol('boom'); })
    ];
    document.getElementById('hint').textContent = '';
  })()`);
  await caretAtEnd(chId);
  await type('Elk');
  await tick(1500);
  assert.match(chapterFile(owls.id, chId), /Elk/);
  assert.deepEqual((await js('window.__calls')).slice(0, 3), ['throws', 'rejects', 'after']);
  const log = await logWith('a listener rejects on purpose');
  assert.match(log, /plugin probe: Error: a listener throws on purpose\r?\n\s+at /);
  assert.match(log, /plugin probe: Error: a listener rejects on purpose\r?\n\s+at /);
  // nothing reached NEO's own net for errors, which would tell the writer
  assert.doesNotMatch(log, /Unhandled: .*on purpose/);
  assert.equal(await js(`document.getElementById('hint').textContent`), '', 'nothing was shown to the writer');
  // the Symbol thrown as the book closes is logged, and the writer reaches the shelf
  await js('backToShelf()');
  await tick(200);
  assert.equal(await js(`book === null && !document.getElementById('bookshelf-view').hidden`), true, 'back on the shelf');
  assert.match(await logWith('Symbol(boom)'), /plugin probe: Symbol\(boom\)/);
  await js(`openBook(${str(owls.id)})`);
  await tick(300);
  // unsubscribed, they are not called again
  await js('window.__off.forEach((off) => off())');
  const calls = (await js('window.__calls')).length;
  await caretAtEnd(chId);
  await type('Yak');
  await tick(1500);
  assert.match(chapterFile(owls.id, chId), /Yak/);
  assert.equal((await js('window.__calls')).length, calls);
});

test('CSP', async () => {
  const refused = () => consoleLines.filter((line) => /Content Security Policy/i.test(line));
  assert.deepEqual(refused(), []);
  assert.deepEqual(await js('window.__probe.csp'), []);
  // the check can fail: an inline script is refused, and both ways see it
  await js(`(() => {
    const s = document.createElement('script');
    s.textContent = 'window.__inline = true';
    document.body.appendChild(s);
  })()`);
  await tick(300);
  assert.equal(await js('window.__inline'), undefined);
  assert.ok(refused().length > 0, 'the console reports the refused inline script');
  assert.ok((await js('window.__probe.csp')).length > 0, 'securitypolicyviolation reports it too');
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
    // the plugin scripts load after app.js; without a host they never do
    for (let i = 0; i < 100 && !(await js('!!(window.__probe && window.__probe.activated)')); i++) await tick(50);
    await tick(300);
    hintAtLaunch = await js(`document.getElementById('hint').textContent`);
    const books = await js(`(async () => {
      document.getElementById('firstrun').hidden = true;
      await addImportedBooks([
        { name: 'Owls', chapters: [
          { title: 'One', paras: [{ text: 'One paragraph.' }, { text: 'Rain fell on the harbor.' }] },
          // more chapters than Other has, so opening this book takes longer
          // than reading Other for an export (the book switch test)
          ...Array.from({ length: 5 }, (_, i) => ({ title: 'More ' + i, paras: [{ text: 'Rain again.' }] }))
        ] },
        { name: 'Other', chapters: [{ title: 'Elsewhere', paras: [{ text: 'Another book.' }] }] }
      ], library.shelves[0]);
      const out = {};
      for (const id of library.shelves[0].bookIds) {
        const meta = await window.neo.readBookMeta(id);
        out[meta.title] = { id, chapters: meta.chapterOrder };
      }
      return out;
    })()`);
    owls = books.Owls;
    other = books.Other;
    await tick(300);
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
