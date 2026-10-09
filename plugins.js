// Plugins, window half. main.js lists the plugin folders it found at launch
// (plugins-main.js, on window.neo.plugins); this file loads each one's script
// and stylesheet. The script calls NeoPlugins.register, and its activate(neo)
// is handed these calls (apiFor):
//   on(event, fn)             book-open, book-close, chapter-change,
//                             chapter-saved, selection and rendered
//   book(), chapter(chId)     copies of the open book and of a chapter
//   addPane({ id, title })    a tab of its own beside Notes
//   addCommand(id, run)       the handler for a command in the Plugins menu
//   status(text)              a quiet line among the counters
//   invoke(channel, payload)  a call to its own main half (plugins-main.js)
// and, for a plugin written for API 2:
//   where()                   where the writer is, as a place (see where)
//   go(place)                 the writer taken there
// None of them writes to the book: chapter writes go through persistChapter
// alone. That is no wall. A plugin's script runs in NEO's page, where
// window.neo, NEO's own way to the files (writeChapter among them), is in
// reach of any script. So NEO trusts a plugin as it trusts its own code, and
// loads plugins only from inside its app folder (plugins-main.js): from
// plugins/ there and, when NEO is not packaged, from the folders named in
// NEO_PLUGIN_DIRS, which must lie inside it too.
//
// app.js calls in from a few hooks, each behind window.NeoPlugins, so
// Pocket, which runs app.js without this file, is untouched.

'use strict';

(() => {
  const API_VERSIONS = Object.freeze([1, 2]);
  const EVENTS = ['book-open', 'book-close', 'chapter-change', 'chapter-saved', 'selection', 'rendered'];

  // One entry per plugin that registered: { id, listeners, panes, commands,
  // status, told, disposed }. listeners maps an event name to a Set of
  // functions, panes a pane id to its tab and element, commands a command
  // id to its handler; status is its slot among the counters, and told the
  // last opening it heard (see tellOpen). Everything a plugin adds to NEO
  // hangs off its entry, so disposal can take it all away.
  const registry = new Map();
  // each listed plugin's stylesheet <link>, by id, put in before its script
  // runs; it leaves again if the plugin is refused, fails or never loads
  const styles = new Map();
  let get = null; // app.js's getters, from attach()
  // The book the plugins last heard open, until they hear it close. A shelf
  // export borrows app.js's `book` without opening it, and an openBook can
  // finish while the export still runs: only the book announced is read.
  let openId = null;
  let openings = 0; // book-opens sent so far
  function openedBook() {
    const book = get && get.book();
    return book && book.id === openId ? book : null;
  }
  // true when app.js holds this book but the plugins never heard it open,
  // which happens only while a shelf export borrows it
  function borrowed(bookId) {
    const book = get && get.book();
    return !!book && book.id === bookId && bookId !== openId;
  }

  // the plugins main.js found, each with an id; Pocket and a failed
  // discovery have none
  function listed() {
    const list = window.neo && window.neo.plugins;
    return Array.isArray(list) ? list.filter((m) => m && typeof m.id === 'string' && m.id) : [];
  }

  // A plugin can throw anything, and a Symbol or an object with no prototype
  // has no text form. Logging must not throw: it runs inside NEO's saves and
  // book opening.
  function text(what) {
    try {
      return String((what && what.stack) || what);
    } catch {
      return `(a value of type ${typeof what} with no text form)`;
    }
  }

  // The log is written through IPC. If that throws or rejects, the line
  // goes to the console: a failed log must not reach the save or the book
  // opening that a plugin's failure was logged from.
  function log(id, what) {
    const line = `plugin ${text(id)}: ${text(what)}`;
    try {
      Promise.resolve(window.neo.logError(line)).catch((err) => console.error(line, err));
    } catch (err) {
      console.error(line, err);
    }
  }

  // The listeners a plugin added for an event, as { entry, fn }, in the order
  // the plugins registered
  function listenersOf(event, entries = registry.values()) {
    const out = [];
    for (const entry of entries) {
      for (const fn of entry.listeners.get(event) || []) out.push({ entry, fn });
    }
    return out;
  }

  // A listener that fails every time it is called would add a line to
  // neo-errors.log, a file in the synced library, every frame the caret
  // moves. Its first failure is logged, then one a minute at most, with a
  // count of those left out.
  const QUIET_MS = 60000;
  const failures = new WeakMap(); // listener -> { at, untold }
  function logFailure(entry, fn, err) {
    const now = performance.now();
    const last = failures.get(fn);
    if (last && now - last.at < QUIET_MS) {
      last.untold++;
      return;
    }
    failures.set(fn, { at: now, untold: 0 });
    const more = last && last.untold ? `${last.untold} more failures of this listener since its last line; the latest: ` : '';
    log(entry.id, more + text(err));
  }

  // Calls a plugin's function. What it throws, or what its promise rejects
  // with, goes to failed and never reaches NEO.
  function call(fn, arg, failed) {
    try {
      const r = fn(arg);
      if (r && typeof r.then === 'function') r.then(null, failed);
    } catch (err) {
      failed(err);
    }
  }

  // Calls each listener with the detail. One that throws, or whose promise
  // rejects, is logged and the rest still run. The detail is frozen, as
  // every listener is handed the same object.
  function dispatch(listeners, detail) {
    if (!listeners.length) return;
    if (detail.place) Object.freeze(detail.place);
    Object.freeze(detail);
    for (const { entry, fn } of listeners) {
      if (!entry.disposed) call(fn, detail, (err) => logFailure(entry, fn, err));
    }
  }

  const heard = (event) => listenersOf(event).length > 0;

  // Typing changes a chapter, and moves the selection, many times a frame.
  // Both reach the plugins once a frame: a change once per chapter, the
  // selection as it stands when the frame comes.
  const changes = new Map(); // 'bookId/chId' -> detail
  let selectionMoved = false;
  let frame = 0;
  function nextFrame() {
    if (!frame) frame = requestAnimationFrame(onFrame);
  }
  function onFrame() {
    frame = 0;
    sendChanges();
    if (selectionMoved) {
      selectionMoved = false;
      dispatch(listenersOf('selection'), { place: where() });
    }
  }
  function sendChanges() {
    const due = [...changes.values()];
    changes.clear();
    for (const detail of due) dispatch(listenersOf('chapter-change'), detail);
  }

  // book-open for some plugins' listeners. Each plugin is told of an
  // opening once: one that activates late is caught up only if it has not
  // heard this opening already.
  function tellOpen(entries, detail) {
    const listeners = listenersOf('book-open', entries);
    for (const { entry } of listeners) entry.told = openings;
    dispatch(listeners, detail);
  }

  // app.js's hooks. Anything but a change goes out at once, after the
  // changes still waiting for the frame, so a change is heard before its
  // save and before its book closes. Nothing done to a book a shelf export
  // borrowed goes out (a paperback's dedication draws and saves it); a save
  // that lands after its open book has closed still does.
  function emit(event, detail) {
    if (event !== 'book-open' && borrowed(detail.bookId)) return;
    if (event === 'chapter-change') {
      if (!heard(event)) return;
      changes.set(detail.bookId + '/' + detail.chId, detail);
      nextFrame();
      return;
    }
    sendChanges();
    if (event === 'book-open') {
      openId = detail.bookId;
      openings++;
      tellOpen(registry.values(), detail);
      return;
    }
    dispatch(listenersOf(event), detail);
    // its listeners could still read the closing book
    if (event === 'book-close') openId = null;
  }

  // A place is { chId, pIdx, off, len, scroll? }, counted as captureCaret
  // (app.js) counts: pIdx indexes the chapter's paragraphs on the page, off
  // and len are UTF-16 units of their text across any inline elements, and
  // a place lies inside one paragraph. scroll, when given, is the page's
  // scrollTop.
  const PLACE_KEYS = ['chId', 'pIdx', 'off', 'len', 'scroll'];
  const whole = (n) => Number.isInteger(n) && n >= 0;
  function validPlace(place) {
    if (!place || typeof place !== 'object' || Array.isArray(place)) return false;
    if (Object.keys(place).some((key) => !PLACE_KEYS.includes(key))) return false;
    if (typeof place.chId !== 'string' || !place.chId) return false;
    if (!whole(place.pIdx) || !whole(place.off) || !whole(place.len)) return false;
    return place.scroll === undefined || (typeof place.scroll === 'number' && Number.isFinite(place.scroll) && place.scroll >= 0);
  }

  // a value as a message can show it, whatever it is
  function shown(value) {
    try {
      return JSON.stringify(value) || text(value);
    } catch {
      return text(value);
    }
  }

  // a chapter of the open book as the page shows it, or null when it is
  // not drawn
  function bodyOf(chId) {
    for (const chapter of document.querySelectorAll('#chapters .chapter')) {
      if (chapter.dataset.id === chId) return chapter.querySelector('.chapter-body');
    }
    return null;
  }

  // true when `off` falls between the two halves of a surrogate pair, the
  // two UTF-16 units of one character such as an emoji
  function splitsPair(text, off) {
    const before = text.charCodeAt(off - 1);
    const after = text.charCodeAt(off);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  }

  // The node and offset `off` UTF-16 units into a paragraph's text, found
  // as restoreCaret (app.js) finds a caret: in the first text node the
  // offset falls inside or at the end of. null past the paragraph's end,
  // and inside a character: a boundary there would cut it in two.
  function pointIn(p, off) {
    if (splitsPair(p.textContent, off)) return null;
    const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let pos = 0;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (off <= pos + n.data.length) return [n, off - pos];
      pos += n.data.length;
    }
    return off === 0 ? [p, 0] : null; // a paragraph with no text
  }

  // The one way from a place to the page, for every call that takes a
  // place: the Range it covers in the open book's chapter on the page, or
  // null when the chapter is not there, nor the paragraph, or the place
  // runs past the paragraph's end.
  function rangeOfPlace(place) {
    const book = openedBook();
    const body = book && book.chapterOrder.includes(place.chId) ? bodyOf(place.chId) : null;
    const p = body && body.querySelectorAll('p')[place.pIdx];
    const start = p && pointIn(p, place.off);
    const end = start && pointIn(p, place.off + place.len);
    if (!end) return null;
    const range = document.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    return range;
  }

  // The writer taken to a place: the manuscript, the place selected, and
  // the scroll given, else the place a third of the way down the page, as
  // resumePosition (app.js) puts the caret when a book opens. False, with
  // nothing moved, when the place is not in the open book or the plugin
  // asking has been disposed; false, with nothing selected, when the place
  // is gone once the manuscript is up.
  function go(place, entry) {
    if (!validPlace(place)) throw new TypeError(`go takes a place, { chId, pIdx, off, len, scroll? } with whole numbers, not ${shown(place)}`);
    if (entry.disposed || !rangeOfPlace(place)) return false;
    // switchTab puts down an open Outline card, and saving its note can
    // rewrite a ghost line or add lines: the place is found again after it
    if (get.currentTab() !== 'manuscript') get.switchTab('manuscript');
    const range = rangeOfPlace(place);
    if (!range) return false;
    // the caret at the place's start, with the focus and the chapter NEO
    // counts as current: at the scroll given, else a third of the way down
    if (place.scroll === undefined) get.resumePosition({ chapterId: place.chId, pIdx: place.pIdx, off: place.off });
    else get.restoreCaret({ chId: place.chId, pIdx: place.pIdx, off: place.off, scroll: place.scroll });
    // then the whole place selected over it, which scrolls nothing
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  // Where the writer is, as a place: captureCaret's (chId, pIdx, off,
  // scroll) plus len, the length selected when the selection starts and
  // ends in one paragraph, else 0. null off the manuscript.
  function where() {
    if (!openedBook() || get.currentTab() !== 'manuscript') return null;
    const caret = get.captureCaret();
    if (!caret) return null;
    const range = getSelection().getRangeAt(0);
    const para = (node) => {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      return el && el.closest ? el.closest('p') : null;
    };
    const p = para(range.startContainer);
    const len = p && p === para(range.endContainer) ? range.toString().length : 0;
    return { chId: caret.chId, pIdx: caret.pIdx, off: caret.off, len, scroll: caret.scroll };
  }

  // the open book, a copy; null on the shelf and while a shelf export
  // borrows the book
  function readBook() {
    const book = openedBook();
    return book ? structuredClone(book) : null;
  }

  // a chapter of the open book: its HTML as NEO holds it, and the text of
  // each paragraph, indexed as a place's pIdx counts them. A chapter on the
  // page gives the page's paragraphs, which a place counts against: drawing
  // a chapter heals its text (stray no-break spaces, old placeholder marks),
  // and NEO holds the old HTML until the writer types there.
  function readChapter(chId) {
    const book = openedBook();
    const html = book && book.chapterOrder.includes(chId) ? get.chapterHTML(chId) : undefined;
    if (typeof html !== 'string') return null;
    let root = bodyOf(chId);
    if (!root) {
      const inert = document.createElement('template'); // parsed, never run or loaded
      inert.innerHTML = html;
      root = inert.content;
    }
    return { id: chId, html, paragraphs: [...root.querySelectorAll('p')].map((p) => p.textContent) };
  }

  // A pane is a plugin's own tab beside Notes, Outline and Darlings, named
  // plugin:<plugin>:<pane>, with an element on the same paper as theirs for
  // the plugin to fill. switchTab asks showTab first, so NEO never reads or
  // writes a file for a pane.
  const PANE_ID = /^[a-z][a-z0-9-]{0,31}$/;
  function addPane(entry, spec) {
    const { id, title } = spec || {};
    if (typeof id !== 'string' || !PANE_ID.test(id)) throw new TypeError(`a pane's id is a lower-case name such as "notes-index", not ${text(id)}`);
    if (typeof title !== 'string' || !title.trim()) throw new TypeError(`pane ${id} needs a title`);
    if (entry.panes.has(id)) throw new TypeError(`pane ${id} is added already`);
    const element = document.createElement('div');
    if (entry.disposed) return Object.freeze({ element });
    const name = `plugin:${entry.id}:${id}`;
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.tabIndex = 0;
    tab.dataset.tab = name;
    tab.textContent = title;
    tab.addEventListener('click', () => get.switchTab(name));
    // Enter or Space opens it, as they open NEO's own tabs
    tab.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      tab.click();
    });
    element.className = 'plugin-pane';
    element.hidden = true;
    document.getElementById('tabs').appendChild(tab);
    document.getElementById('aux-paper').appendChild(element);
    entry.panes.set(id, { name, title, tab, element });
    return Object.freeze({ element });
  }

  // switchTab's hook, on every switch away from the manuscript: every pane
  // is hidden but the one named, which is shown under its title. False when
  // the tab is not a pane, for switchTab to go on with its own.
  function showTab(name) {
    let shown = null;
    for (const entry of registry.values()) {
      for (const pane of entry.panes.values()) {
        pane.element.hidden = pane.name !== name;
        if (pane.name === name) shown = pane;
      }
    }
    if (!shown) return false;
    document.getElementById('aux-title').textContent = shown.title;
    return true;
  }

  // Commands: the Plugins menu (plugins-main.js) lists those each plugin.json
  // declares, and the plugin binds one handler to each
  function addCommand(entry, commandId, run) {
    const manifest = listed().find((m) => m.id === entry.id);
    const commands = manifest && Array.isArray(manifest.commands) ? manifest.commands : [];
    if (!commands.some((c) => c && c.id === commandId)) {
      throw new TypeError(`the plugin.json of ${entry.id} declares no command ${text(commandId)}`);
    }
    if (typeof run !== 'function') throw new TypeError(`addCommand('${commandId}') needs a function`);
    if (entry.disposed) return;
    if (entry.commands.has(commandId)) throw new TypeError(`command ${commandId} is bound already`);
    entry.commands.set(commandId, run);
  }

  // onMenu's hook: a click in the Plugins menu. A handler that throws or
  // rejects is logged, every time, since the writer asked for each run.
  function runCommand(pluginId, commandId) {
    const entry = registry.get(pluginId);
    const run = entry && entry.commands.get(commandId);
    if (!run) {
      log(pluginId, `the Plugins menu asked for ${text(commandId)}, and nothing is bound to it`);
      return;
    }
    call(run, undefined, (err) => log(pluginId, err));
  }

  // A plugin's status: one quiet line among the counters, in a slot of its
  // own, made the first time it has something to say. '' hides it.
  function setStatus(entry, value) {
    if (typeof value !== 'string') throw new TypeError(`status takes a string, not ${text(value)}`);
    if (entry.disposed) return;
    let slot = entry.status;
    if (!slot) {
      if (!value) return;
      slot = entry.status = document.createElement('div');
      slot.className = 'plugin-status';
      slot.dataset.plugin = entry.id;
      document.getElementById('counters').appendChild(slot);
    }
    // the text node's own text changes, as app.js's setText does for the
    // counters: a new node would end the writer's undo run
    const node = slot.firstChild;
    if (node && node.nodeType === Node.TEXT_NODE && !node.nextSibling) {
      if (node.data !== value) node.data = value;
    } else {
      slot.textContent = value;
    }
    slot.hidden = !value;
  }

  // what activate(neo) receives: API 1, and where and go from API 2 on
  function apiFor(entry, apiVersion) {
    const api = {
      // a call to this plugin's own main half (plugins-main.js), answered
      // by the handler it took for the channel. The id filled in here keeps
      // a plugin from reaching another's half by mistake. It is no wall:
      // every plugin's script runs in this page and can call
      // window.neo.pluginInvoke with any id.
      async invoke(channel, payload) {
        if (entry.disposed) throw new Error(`plugin ${entry.id} is not active, so it cannot invoke ${channel}`);
        return window.neo.pluginInvoke(entry.id, channel, payload);
      },
      on(event, fn) {
        if (!EVENTS.includes(event)) throw new TypeError(`no plugin event is called ${event}`);
        if (typeof fn !== 'function') throw new TypeError(`on('${event}') needs a function`);
        if (entry.disposed) return () => {};
        if (!entry.listeners.has(event)) entry.listeners.set(event, new Set());
        entry.listeners.get(event).add(fn);
        return () => {
          const set = entry.listeners.get(event);
          if (set) set.delete(fn);
        };
      },
      book: readBook,
      chapter: readChapter,
      addPane: (spec) => addPane(entry, spec),
      addCommand: (commandId, run) => addCommand(entry, commandId, run),
      status: (value) => setStatus(entry, value)
    };
    if (apiVersion >= 2) {
      api.where = where;
      // a plugin that failed to activate moves the writer nowhere
      api.go = (place) => go(place, entry);
    }
    return Object.freeze(api);
  }

  function dropStyle(id) {
    const link = styles.get(id);
    if (link) link.remove();
    styles.delete(id);
  }

  function dispose(entry) {
    entry.disposed = true;
    entry.listeners.clear();
    entry.commands.clear();
    for (const pane of entry.panes.values()) {
      pane.tab.remove();
      pane.element.remove();
      // the writer was looking at it: back to the page. Should that fail,
      // it is logged and the rest of the plugin's things still go.
      if (openedBook() && get.currentTab() === pane.name) {
        try {
          get.switchTab('manuscript');
        } catch (err) {
          log(entry.id, `its pane could not give way to the manuscript: ${text(err)}`);
        }
      }
    }
    entry.panes.clear();
    if (entry.status) entry.status.remove();
    entry.status = null;
    dropStyle(entry.id);
  }

  // A plugin that fails to activate loses whatever it added, and the error
  // goes to the log, never in front of the writer. The error is logged
  // first, so nothing that goes wrong while its things are taken away can
  // lose it.
  function fail(entry, err) {
    log(entry.id, err);
    dispose(entry);
  }

  function register(plugin) {
    const id = plugin && plugin.id;
    const manifest = listed().find((m) => m.id === id);
    // a refused plugin's stylesheet goes too, unless the plugin is already
    // working and this was a stray second register
    const refuse = (why) => {
      if (!registry.has(id)) dropStyle(id);
      log(id, `${why}, so it is not activated`);
    };
    if (!manifest) return refuse('not among the plugins NEO found at launch');
    if (plugin.apiVersion !== manifest.apiVersion || !API_VERSIONS.includes(plugin.apiVersion)) {
      return refuse(`apiVersion ${plugin.apiVersion}, where its plugin.json says ${manifest.apiVersion} and this NEO knows ${API_VERSIONS.join(', ')}`);
    }
    if (typeof plugin.activate !== 'function') return refuse('no activate function');
    if (registry.has(id)) return refuse('registered already');
    const entry = { id, listeners: new Map(), panes: new Map(), commands: new Map(), status: null, told: 0, disposed: false };
    registry.set(id, entry);
    let result;
    try {
      result = plugin.activate(apiFor(entry, plugin.apiVersion));
    } catch (err) {
      fail(entry, err);
      return;
    }
    // A plugin whose script came after the book opened still hears of it,
    // once activate has settled: an async one may subscribe after an await
    const catchUp = () => {
      const book = openedBook();
      if (book && entry.told !== openings) tellOpen([entry], { bookId: book.id });
    };
    if (result && typeof result.then === 'function') result.then(catchUp, (err) => fail(entry, err));
    else catchUp();
  }

  // Runs once, at the end of app.js: from here on the host can read NEO, so
  // the plugins' stylesheets and scripts go in, the scripts run in the
  // order they were listed. One that will not load is logged and skipped.
  function attach(getters) {
    if (get) return;
    get = getters;
    document.addEventListener('selectionchange', () => {
      if (!heard('selection')) return;
      selectionMoved = true;
      nextFrame();
    });
    for (const m of listed()) {
      if (m.styleUrl) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = m.styleUrl;
        link.onerror = () => log(m.id, `could not load ${m.styleUrl}`);
        document.head.appendChild(link);
        styles.set(m.id, link);
      }
      const script = document.createElement('script');
      script.src = m.rendererUrl;
      script.async = false;
      // a plugin whose script will not load never registers
      script.onerror = () => {
        dropStyle(m.id);
        log(m.id, `could not load ${m.rendererUrl}`);
      };
      document.body.appendChild(script);
    }
  }

  // validPlace, for a plugin to check a place before it hands it over
  window.NeoPlugins = Object.freeze({ apiVersions: API_VERSIONS, register, emit, attach, showTab, runCommand, validPlace });
})();
