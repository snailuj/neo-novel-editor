// End-to-end tests for the plugin host in the window (plugins.js), on a
// throwaway library, with the fixture plugins in scripts/fixtures/plugins:
// probe writes down every event and adds a pane, a command and a status;
// broken adds the same and throws while it activates; late registers only
// when asked; missing-script has no script at all; old-api, written for
// API 1, adds nothing (scripts/plugin-edits.e2e.js reads what it was handed);
// and fleeting registers only when scripts/plugin-edits.e2e.js asks.
// Run with `npm run test:plugins`.

'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
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
// main.js falls back on home for a library, and appData is where Electron keeps the rest
app.setPath('home', tmp);
app.setPath('appData', path.join(tmp, 'appData'));
// no dialog, browser, file manager or trash is reached from a run; a call that answers
// at once, a synchronous dialog's, must throw at once
for (const owner of [dialog, shell]) {
  for (const name of Object.keys(owner)) {
    owner[name] = () => { throw new Error(`${name} is disabled in tests`); };
  }
}
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

// The shelf leaves the last book's page in #chapters, and a book-open
// listener runs before openBook draws the book anew: what it reads is the
// chapter just read from the file, never that page, and nothing is found on
// the page until it is drawn.
test('a book-open listener reads the chapter as read from the file, not the page left behind', async () => {
  const chId = owls.chapters[2];
  await js('backToShelf()');
  await tick(200);
  // a sync that changed the chapter while the book was shut
  fs.writeFileSync(path.join(LIBRARY, owls.id, 'chapters', chId + '.html'), '<p>New text from the other device.</p>');
  const seen = await js(`(async () => {
    const neo = window.__probe.neo;
    const place = { chId: ${str(chId)}, pIdx: 0, off: 0, len: 3 };
    let seen = null;
    const off = neo.on('book-open', () => {
      seen = {
        chapter: neo.chapter(${str(chId)}),
        where: neo.where(),
        went: neo.go(place),
        replaced: neo.replace(place, 'New', 'Old')
      };
    });
    try {
      await openBook(${str(owls.id)});
    } finally {
      off();
    }
    seen.replaced = await seen.replaced;
    return seen;
  })()`);
  assert.deepEqual(seen.chapter.paragraphs, ['New text from the other device.']);
  assert.equal(seen.chapter.html, '<p>New text from the other device.</p>');
  assert.deepEqual([seen.where, seen.went, seen.replaced], [null, false, { ok: false, reason: 'missing' }], 'nothing is on the page yet');
  // drawn, the page and the read agree
  assert.deepEqual(await js(`window.__probe.neo.chapter(${str(chId)}).paragraphs`), ['New text from the other device.']);
  assert.equal(await js(`document.querySelector('.chapter[data-id="${chId}"] .chapter-body').textContent`), 'New text from the other device.');
  await tick(300);
});

test('a shelf export tells the plugins nothing; the save flushed on the way to the shelf is heard', async () => {
  // typed just before the shelf: the flush lands after the book has closed
  await caretAtEnd(owls.chapters[0]);
  await forget();
  await type('Gnu');
  await js('backToShelf()');
  await tick(500);
  const order = (await heard()).map(([name]) => name).filter((name, i, all) => name !== all[i - 1]);
  assert.deepEqual(order, ['chapter-change', 'book-close', 'chapter-saved']);
  assert.match(chapterFile(owls.id, owls.chapters[0]), /Gnu/);
  // an export that draws and saves the book it borrowed, as printPaperback
  // does with a dedication typed in its dialog
  await forget();
  await js(`(async () => {
    const realExport = doExport;
    doExport = async () => {
      renderChapters();
      await persistChapter(book.chapterOrder[0]);
    };
    try {
      await exportFromShelf(${str(other.id)}, 'txt');
    } finally {
      doExport = realExport;
    }
  })()`);
  await tick(300);
  assert.deepEqual(await heard(), []);
  await js(`openBook(${str(owls.id)})`);
  await tick(300);
});

// what the writer sees of the probe's pane, and of the tabs around it
const paneView = () => js(`(() => {
  const tab = document.querySelector('.tab[data-tab="plugin:probe:pane"]');
  const pane = window.__probe.pane.element;
  const editor = document.getElementById('aux-editor');
  return {
    tab: tab && tab.textContent,
    active: !!tab && tab.classList.contains('active') && tab.getAttribute('aria-selected') === 'true',
    pane: pane.checkVisibility() ? pane.textContent : null,
    title: document.getElementById('aux-title').checkVisibility() ? document.getElementById('aux-title').textContent : null,
    notes: editor.checkVisibility() ? editor.textContent : null,
    manuscript: document.getElementById('paper').checkVisibility()
  };
})()`);
const clickTab = async (name, ms = 300) => {
  await js(`document.querySelector('.tab[data-tab="${name}"]').click()`);
  await tick(ms);
};

// What the writer sees of the editor, read from the DOM alone, so any view or
// mark that a tab leaves behind shows, whichever it is. Scroll and caret are
// left out.
const sight = () => js(`(() => {
  const by = (id) => document.getElementById(id);
  const label = (el) => el.id || el.localName + (el.classList[0] ? '.' + el.classList[0] : '');
  const seen = (el) => [...el.children].filter((c) => c.checkVisibility()).map(label);
  return {
    body: [...document.body.classList].sort(),
    manuscript: by('paper').checkVisibility(),
    paper: seen(by('aux-paper')),
    title: by('aux-title').textContent,
    editor: [...by('editor-view').classList].sort(),
    side: { open: by('side-pane').classList.contains('open'), seen: seen(by('side-pane')) },
    highlights: [...CSS.highlights.keys()].sort(),
    tabs: [...document.querySelectorAll('.tab.active')].map((tab) => tab.dataset.tab),
    snapShown: snapShown && snapShown.name
  };
})()`);

const PANE = 'plugin:probe:pane';
const auxKind = () => js(`document.getElementById('aux-editor').dataset.kind`);
// NEO's tabs besides the manuscript, each with its data-tab and how to open
// it. Notes reads its file, so it is open once that lands. The Outline's two
// views are the library's setting (`library.outlineView`; unset means cards),
// set directly because the List/Cards switch writes library.json.
const openOutline = (view) => async () => {
  await js(`library.outlineView = ${str(view)}`);
  await clickTab('outline');
};
const NEO_TABS = [
  { name: 'Notes', tab: 'notes', open: async () => {
    await clickTab('notes', 0);
    for (let i = 0; i < 40 && (await auxKind()) !== 'notes'; i++) await tick(50);
    assert.equal(await auxKind(), 'notes', 'the notes never loaded');
    await tick(100);
  } },
  { name: 'Outline as a list', tab: 'outline', open: openOutline('list') },
  { name: 'Outline as cards', tab: 'outline', open: openOutline('cards') },
  { name: 'Darlings', tab: 'darlings', open: () => clickTab('darlings') }
];
// what the writer sees once `open` has opened a tab, coming from the tab `from`
const arrive = async (from, open) => {
  await clickTab(from, 100);
  await open();
  return sight();
};
// a view reached is a view of its own: it looks like none reached before it
const distinctViews = (...seen) => {
  const keys = new Set(seen.map((view) => str(view)));
  return (view, name) => {
    assert.ok(!keys.has(str(view)), `${name} was not reached: it looks like a view reached before`);
    keys.add(str(view));
  };
};
// the library's outline view as a test found it, put back afterwards
const keepOutlineView = async (run) => {
  const was = await js('library.outlineView');
  try { await run(); } finally {
    await js(`library.outlineView = ${str(was)}`);
    await clickTab('manuscript');
  }
};

// A pane leaves nothing behind: a tab of NEO's opened after it, or after it
// and the manuscript, looks as it did before any pane showed. This comes
// before the other pane tests because no earlier test shows a pane; one
// after them would find a pane shown already.
test("a pane leaves nothing behind on NEO's tabs", () => keepOutlineView(async () => {
  const bar = await js(`[...document.querySelectorAll('#tabs .tab')].map((tab) => tab.dataset.tab).filter((tab) => !tab.startsWith('plugin:'))`);
  assert.deepEqual(bar.sort(), ['manuscript', ...new Set(NEO_TABS.map((t) => t.tab))].sort(),
    'the tab bar and NEO_TABS differ: add a new tab of NEO to NEO_TABS, with how to open it');
  assert.equal(await js(`[...document.querySelectorAll('.plugin-pane')].every((el) => el.hidden)`), true, 'a pane has shown already');
  const reached = distinctViews();
  const before = [];
  for (const { name, open } of NEO_TABS) {
    before.push(await arrive('manuscript', open));
    reached(before.at(-1), name);
  }
  const pane = await arrive('manuscript', () => clickTab(PANE));
  reached(pane, 'the pane');
  for (const [i, { name, open }] of NEO_TABS.entries()) {
    for (const via of ['', 'manuscript']) {
      await clickTab(PANE);
      // were the click to fail, this would compare one tab opened after another
      assert.deepEqual(await sight(), pane, `the pane, before ${name}`);
      if (via) await clickTab(via, 100);
      await open();
      assert.deepEqual(await sight(), before[i], `${name} after the pane${via ? ' and the manuscript' : ''}`);
    }
  }
}));

// Whatever was open before a pane, the writer sees the pane and nothing left
// from it. That includes a snapshot shown on Darlings (SNAPSHOTS in app.js)
// with its gone words marked: it goes when another tab opens, a pane among
// them, as it does for NEO's own tabs.
test('a pane looks the same whatever was open before it', () => keepOutlineView(async () => {
  // a snapshot with one word the book has since lost, for something to mark
  const snap = await js(`takeSnapshot('k', (c) => (chapterHTML[c] || '').replace('</p>', ' gone</p>')).then((r) => r.snap.name)`);
  const origins = [
    { name: 'the manuscript', open: async () => {} },
    ...NEO_TABS,
    { name: 'Darlings with a snapshot shown', open: async () => {
      await clickTab('darlings');
      await js(`showSnapshot(${str(snap)})`);
      assert.equal(await js('snapShown && snapShown.name'), snap, 'the snapshot never showed');
      assert.equal(await js(`CSS.highlights.has('neo-snap-gone')`), true, 'no words are marked gone');
    } }
  ];
  const pane = await arrive('manuscript', () => clickTab(PANE));
  // a view an earlier test left showing would be part of the baseline, and
  // every pane below would match it
  assert.deepEqual(pane.paper, ['aux-title', 'div.plugin-pane'], 'the pane shows more than itself');
  const reached = distinctViews(pane);
  for (const { name, open } of origins) {
    reached(await arrive('manuscript', open), name);
    await clickTab(PANE);
    assert.deepEqual(await sight(), pane, `the pane after ${name}`);
  }
}));

test('pane', async () => {
  await js(`window.neo.writeAux(${str(owls.id)}, 'notes', '<p>Notes about owls.</p>')`);
  await clickTab('plugin:probe:pane');
  assert.equal(await js('currentTab'), 'plugin:probe:pane');
  assert.deepEqual(await paneView(), {
    tab: 'Probe Pane', active: true, pane: 'What the probe shows.', title: 'Probe Pane', notes: null, manuscript: false
  });
  assert.equal(await js(`window.__probe.pane.element.parentElement.id`), 'aux-paper');
  // Notes hides the pane and shows its own title and text
  await clickTab('notes', 600);
  assert.deepEqual(await paneView(), {
    tab: 'Probe Pane', active: false, pane: null, title: 'Notes', notes: 'Notes about owls.', manuscript: false
  });
  // and so does the manuscript
  await clickTab('plugin:probe:pane');
  assert.equal((await paneView()).pane, 'What the probe shows.');
  await clickTab('manuscript');
  assert.deepEqual(await paneView(), {
    tab: 'Probe Pane', active: false, pane: null, title: null, notes: null, manuscript: true
  });
  // NEO never read or wrote a file for the pane
  await js('flushAllSaves()');
  await tick(300);
  assert.deepEqual(fs.readdirSync(path.join(LIBRARY, owls.id)).filter((name) => /^plugin/i.test(name)), []);
  // an id that is not a lower-case name, no title, or an id used already
  const refused = await js(`[{ id: 'Bad', title: 'Bad' }, { id: 'a:b', title: 'Colon' }, { id: 'untitled' }, { id: 'pane', title: 'Again' }, null]
    .map((spec) => { try { window.__probe.neo.addPane(spec); return 'added'; } catch (err) { return err.name; } })`);
  assert.deepEqual(refused, ['TypeError', 'TypeError', 'TypeError', 'TypeError', 'TypeError']);
  assert.equal(await js(`document.querySelectorAll('.tab[data-tab^="plugin:probe:"]').length`), 1);
});

// what Find shows: its count, the matches it holds and the ones it paints
const findView = () => js(`({
  count: document.getElementById('search-count').textContent,
  matches: searchState.matches.length,
  painted: CSS.highlights.has('neo-search') ? CSS.highlights.get('neo-search').size : 0
})`);
// typed into the find bar; the bar searches 250 ms after the last key
const findFor = async (q) => {
  await js(`(() => {
    const input = document.getElementById('search-input');
    input.value = ${str(q)};
    input.dispatchEvent(new Event('input'));
  })()`);
  await tick(400);
};

test('Find on a pane counts nothing in the Notes behind it', async () => {
  await clickTab('notes', 600);
  await js('openSearch()');
  await findFor('owls');
  assert.deepEqual(await findView(), { count: '1 found', matches: 1, painted: 1 });
  // the open Find follows the writer to the pane, where NEO has no words
  await clickTab('plugin:probe:pane');
  assert.deepEqual(await findView(), { count: 'none', matches: 0, painted: 0 });
  // a search typed on the pane finds nothing either, and Next scrolls nowhere
  await findFor('notes');
  const scroll = await js(`document.getElementById('paper-scroll').scrollTop`);
  await js(`document.getElementById('search-next').click()`);
  assert.deepEqual(await findView(), { count: 'none', matches: 0, painted: 0 });
  assert.equal(await js(`document.getElementById('paper-scroll').scrollTop`), scroll);
  await js('closeSearch()');
  await clickTab('manuscript');
});

// a command in the Plugins menu, clicked as the writer would
async function menuCommand(title) {
  const plugins = Menu.getApplicationMenu().items.find((item) => item.label === 'Plugins');
  plugins.submenu.items.find((item) => item.label === title).click();
  await tick(200);
}
const said = () => js('window.__probe.said');
// what addCommand does with these arguments: 'bound', or the error's name and message
const bind = (id, fn = '() => {}') => js(`(() => {
  try { window.__probe.neo.addCommand(${str(id)}, ${fn}); return 'bound'; } catch (err) { return err.name + ': ' + err.message; }
})()`);

test('command', async () => {
  const before = await said();
  await menuCommand('Say Hello');
  assert.equal(await said(), before + 1);
});

test('undeclared', async () => {
  assert.match(await bind('nope'), /^TypeError: .*\bnope\b/);
  // a declared command with no function to run is refused too
  assert.match(await bind('hello', 'null'), /^TypeError: .*function/);
});

test('already bound', async () => {
  await js('window.__again = 0');
  assert.match(await bind('hello', '() => { window.__again++; }'), /^TypeError: .*\bhello\b/);
  const before = await said();
  await menuCommand('Say Hello');
  assert.equal(await said(), before + 1, 'the first handler still runs');
  assert.equal(await js('window.__again'), 0);
});

test('throwing command', async () => {
  await js(`document.getElementById('hint').textContent = ''`);
  try {
    await js(`void (window.__probe.sayFails = () => { throw new Error('a command throws on purpose'); })`);
    await menuCommand('Say Hello');
    await js(`void (window.__probe.sayFails = async () => { throw new Error('a command rejects on purpose'); })`);
    await menuCommand('Say Hello');
  } finally {
    await js('window.__probe.sayFails = null');
  }
  const log = await logWith('a command rejects on purpose');
  assert.match(log, /plugin probe: Error: a command throws on purpose\r?\n\s+at /);
  assert.match(log, /plugin probe: Error: a command rejects on purpose\r?\n\s+at /);
  assert.doesNotMatch(log, /Unhandled: .*on purpose/);
  assert.equal(await js(`document.getElementById('hint').textContent`), '', 'nothing was shown to the writer');
  // writing goes on
  await caretAtEnd(owls.chapters[0]);
  await type('Cat');
  await tick(1500);
  assert.match(chapterFile(owls.id, owls.chapters[0]), /Cat/);
});

// the probe's status slot among the counters: its text, and whether it shows
const statusSlot = () => js(`(() => {
  const el = document.querySelector('#counters .plugin-status[data-plugin="probe"]');
  return el && { text: el.textContent, shown: el.checkVisibility() };
})()`);

test('status', async () => {
  assert.deepEqual(await statusSlot(), { text: 'Indexed', shown: true });
  await js(`window.__probe.neo.status('')`);
  assert.deepEqual(await statusSlot(), { text: '', shown: false });
  // A new status changes the slot's text node in place: a new node would
  // end the writer's undo run, as NEO's own counters know (app.js setText)
  const kept = await js(`(() => {
    const el = document.querySelector('#counters .plugin-status[data-plugin="probe"]');
    window.__probe.neo.status('Indexed 1');
    const node = el.firstChild;
    window.__probe.neo.status('Indexed 2');
    return node === el.firstChild && el.childNodes.length === 1;
  })()`);
  assert.equal(kept, true, 'the same text node');
  assert.deepEqual(await statusSlot(), { text: 'Indexed 2', shown: true });
  assert.equal(await js(`document.querySelectorAll('#counters .plugin-status').length`), 1, 'one slot per plugin');
  assert.equal(await js(`(() => { try { window.__probe.neo.status(42); return 'set'; } catch (err) { return err.name; } })()`), 'TypeError');
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
  // nor is the pane it added before it threw anywhere to be seen
  assert.equal(await js(`document.querySelector('.tab[data-tab^="plugin:broken:"]')`), null);
  assert.deepEqual(await js(`[...document.querySelectorAll('.plugin-pane')].map((el) => el === window.__probe.pane.element)`), [true]);
  // nor its status
  assert.equal(await js(`document.querySelector('#counters .plugin-status[data-plugin="broken"]')`), null);
  // and its command, still in the menu from its plugin.json, runs nothing
  await menuCommand('Fix Broken');
  assert.equal(await js('window.__brokenFixed'), 0);
  assert.match(await logWith('plugin broken: the Plugins menu'), /plugin broken: the Plugins menu asked for fix, and nothing is bound to it/);
});

test('a pane whose plugin fails while it shows gives way to the manuscript', async () => {
  // missing-script is listed, but its script never loaded: its id is free
  await js(`NeoPlugins.register({ id: 'missing-script', apiVersion: 1, async activate(neo) {
    neo.addPane({ id: 'later', title: 'Fails Later' });
    await new Promise((resolve, reject) => { window.__failLater = reject; });
  } })`);
  await clickTab('plugin:missing-script:later');
  assert.equal(await js('currentTab'), 'plugin:missing-script:later');
  await js(`window.__failLater(new Error('fails while its pane shows'))`);
  await tick(300);
  assert.match(await logWith('fails while its pane shows'), /plugin missing-script: Error: fails while its pane shows/);
  assert.equal(await js('currentTab'), 'manuscript');
  assert.equal(await js(`document.querySelector('.tab[data-tab="plugin:missing-script:later"]')`), null);
  assert.equal(await js(`document.querySelector('.tab[data-tab="manuscript"]').classList.contains('active')`), true);
  assert.equal((await paneView()).manuscript, true);
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
