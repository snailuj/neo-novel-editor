// Plugins, window half. main.js lists the plugin folders it found at launch
// (plugins-main.js, on window.neo.plugins); this file loads each one's script
// and stylesheet and gives the script a read-only view of NEO: the open
// book, its chapters, and events as the writer works. app.js calls in from
// a few hooks, each behind window.NeoPlugins, so Pocket, which runs app.js
// without this file, is untouched. A plugin never writes: chapter writes go
// through persistChapter alone.

'use strict';

(() => {
  const API_VERSIONS = Object.freeze([1]);
  const EVENTS = ['book-open', 'book-close', 'chapter-change', 'chapter-saved', 'selection', 'rendered'];

  // One entry per plugin that registered: { id, listeners, told, disposed },
  // where listeners maps an event name to a Set of functions and told is
  // the last opening the plugin heard (see tellOpen). Everything a plugin
  // adds to NEO hangs off its entry, so disposal can take it all away.
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

  // Calls each listener with the detail. One that throws, or whose promise
  // rejects, is logged and the rest still run. The detail is frozen, as
  // every listener is handed the same object.
  function dispatch(listeners, detail) {
    if (!listeners.length) return;
    if (detail.place) Object.freeze(detail.place);
    Object.freeze(detail);
    for (const { entry, fn } of listeners) {
      if (entry.disposed) continue;
      try {
        const r = fn(detail);
        if (r && typeof r.then === 'function') r.then(null, (err) => logFailure(entry, fn, err));
      } catch (err) {
        logFailure(entry, fn, err);
      }
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

  // Where the writer is, in the shape captureCaret gives (chId, pIdx, off,
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
  // each paragraph, indexed as a place's pIdx counts them
  function readChapter(chId) {
    const book = openedBook();
    const html = book && book.chapterOrder.includes(chId) ? get.chapterHTML(chId) : undefined;
    if (typeof html !== 'string') return null;
    const inert = document.createElement('template'); // parsed, never run or loaded
    inert.innerHTML = html;
    return { id: chId, html, paragraphs: [...inert.content.querySelectorAll('p')].map((p) => p.textContent) };
  }

  // what activate(neo) receives: API 1
  function apiFor(entry) {
    return Object.freeze({
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
      chapter: readChapter
    });
  }

  function dropStyle(id) {
    const link = styles.get(id);
    if (link) link.remove();
    styles.delete(id);
  }

  function dispose(entry) {
    entry.disposed = true;
    entry.listeners.clear();
    dropStyle(entry.id);
  }

  // A plugin that fails to activate loses whatever it added, and the error
  // goes to the log, never in front of the writer
  function fail(entry, err) {
    dispose(entry);
    log(entry.id, err);
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
    const entry = { id, listeners: new Map(), told: 0, disposed: false };
    registry.set(id, entry);
    let result;
    try {
      result = plugin.activate(apiFor(entry));
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

  window.NeoPlugins = Object.freeze({ apiVersions: API_VERSIONS, register, emit, attach });
})();
