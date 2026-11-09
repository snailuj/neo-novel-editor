'use strict';

// The page column: a region beside the manuscript, full height, that a plugin fills (plugins.js,
// API 6). This file holds the width rules, which are plain functions that also run in Node
// (scripts/split-column.test.js), and the region's behaviour in the window (the divider, the
// width kept per machine, docking), which starts below the rules when a window has the region.
//
// Every pixel here is a pixel on screen, Interface size and page zoom already applied, except the
// width kept in localStorage, which is in pixels at Interface size 1 so it means the same after
// the size changes.

(() => {
  const COLUMN_MIN = 400; // about 42 characters of the page's text at Interface size 1
  const COLUMN_USUAL_SHARE = 0.4; // of the window
  const COLUMN_USUAL_MAX = 640;
  const BOOK_MIN = 560; // at page zoom 1
  const OVERLAY_MARGIN = 48; // of the room the overlaid column leaves bare
  const STEP = 16;
  const STEP_LARGE = 64;

  const finite = (n, fallback) => (Number.isFinite(n) ? n : fallback);

  // room is the window less what is docked beside the page. Beside the book the column may take
  // all but the book's minimum; with no such room it lies over the book (overlay), up to the
  // room less a margin.
  function limits({ room, uiZoom = 1, pageZoom = 1 }) {
    const min = COLUMN_MIN * uiZoom;
    const beside = room - BOOK_MIN * pageZoom;
    if (beside >= min) return { min, max: beside, overlay: false };
    return { min, max: Math.max(min, room - OVERLAY_MARGIN * uiZoom), overlay: true };
  }

  // Not a number: the narrowest, which is always allowed.
  function clamp(width, lim) {
    return Math.min(lim.max, Math.max(lim.min, finite(width, lim.min)));
  }

  function defaultWidth({ viewWidth, uiZoom = 1 }) {
    return Math.min(COLUMN_USUAL_MAX * uiZoom, Math.max(COLUMN_MIN * uiZoom, COLUMN_USUAL_SHARE * viewWidth));
  }

  // The divider's value: how much of the room the book keeps, 0 to 100.
  function bookShare(room, width) {
    if (!(room > 0)) return 0;
    return Math.min(100, Math.max(0, Math.round(100 * (room - width) / room)));
  }

  // What a key does to the width, or null for a key the divider has no use for (Enter is the
  // region's own: it forgets the kept width). Left moves the divider left, so the column grows.
  function keyWidth({ key, shiftKey, width, limits: lim, uiZoom = 1 }) {
    const step = (shiftKey ? STEP_LARGE : STEP) * uiZoom;
    switch (key) {
      case 'ArrowLeft': return clamp(width + step, lim);
      case 'ArrowRight': return clamp(width - step, lim);
      case 'Home': return lim.max;
      case 'End': return lim.min;
      default: return null;
    }
  }

  const rules = { limits, clamp, defaultWidth, bookShare, keyWidth };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = rules;
    return;
  }

  // ---- the region in the window ----
  // #split-column in index.html holds the divider and #split-body, the content root a plugin
  // fills. Closed, styles.css slides it out of sight and out of the tab order. It docks it: while it is open and beside the book, --dock-right on
  // #editor-view carries its width (plus a pinned right pane's) to the rule that centres the
  // page. Pocket has no such region, so there nothing starts.
  const region = document.getElementById('split-column');
  const view = document.getElementById('editor-view');
  if (!region || !view) {
    window.NeoSplit = Object.freeze(rules);
    return;
  }
  const body = document.getElementById('split-body');
  const divider = document.getElementById('split-divider');
  const STORE = 'neo.splitWidth'; // per machine, in px at Interface size 1

  const listeners = { open: new Set(), close: new Set(), resize: new Set() };
  const emit = (name, detail) => {
    for (const fn of [...listeners[name]]) {
      try { fn(detail); } catch (err) { console.error(`NeoSplit ${name} listener failed`, err); }
    }
  };
  let hooks = { focusBook() {}, keepPlace: (change) => change() };
  let available = false; // a plugin has put something in the column
  let open = false;
  let kept = null; // the writer's width, px at Interface size 1; null: the usual one
  let width = 0; // as laid out now, px on screen
  let lastFocus = null; // where the keyboard was in the column when it left

  try {
    const raw = localStorage.getItem(STORE);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n) && n > 0) kept = n;
  } catch { /* storage can be off: the width is just not remembered */ }
  const remember = () => {
    try {
      if (kept === null) localStorage.removeItem(STORE);
      else localStorage.setItem(STORE, String(Math.round(kept)));
    } catch { /* as above */ }
  };

  // A length from the stylesheet in px as it lays out, read through a probe so the zoom and the
  // pane widths are said once, in styles.css.
  const probes = new Map();
  function px(variable) {
    let probe = probes.get(variable);
    if (!probe) {
      probe = document.createElement('div');
      probe.setAttribute('aria-hidden', 'true');
      probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;height:0;width:var(${variable})`;
      view.appendChild(probe);
      probes.set(variable, probe);
    }
    return probe.getBoundingClientRect().width;
  }
  const zoomOf = (variable) => {
    const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable));
    return n > 0 ? n : 1;
  };

  function measure() {
    const uiZoom = zoomOf('--ui-zoom');
    const pageZoom = zoomOf('--page-zoom');
    const viewWidth = view.clientWidth;
    const side = px('--side-dock');
    const room = viewWidth - px('--dock-left') - side;
    const lim = limits({ room, uiZoom, pageZoom });
    const usual = defaultWidth({ viewWidth, uiZoom });
    return { uiZoom, viewWidth, side, room, lim, usual };
  }

  // Sets the width, the classes and the divider's values from the window as it is now.
  function layout() {
    if (view.hidden || !view.clientWidth) return;
    const m = measure();
    const next = clamp(kept === null ? m.usual : kept * m.uiZoom, m.lim);
    // a column that is opening is not resizing: the plugin tells its own width at opening
    const changed = view.classList.contains('split-open') && open && Math.abs(next - width) > 0.01;
    width = next;
    view.style.setProperty('--split-px', `${width}px`);
    view.classList.toggle('split-open', open);
    view.classList.toggle('split-overlay', open && m.lim.overlay);
    const now = bookShare(m.room, width);
    divider.setAttribute('aria-valuemin', String(bookShare(m.room, m.lim.max)));
    divider.setAttribute('aria-valuemax', String(bookShare(m.room, m.lim.min)));
    divider.setAttribute('aria-valuenow', String(now));
    const say = window.NeoI18n ? NeoI18n.t : (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k]);
    divider.setAttribute('aria-valuetext', say('Book {book} percent, page {page} percent', { book: String(now), page: String(100 - now) }));
    if (changed) emit('resize', { width });
  }
  let queued = 0;
  const relayout = () => { if (!queued) queued = requestAnimationFrame(() => { queued = 0; layout(); }); };
  new ResizeObserver(relayout).observe(view);
  new MutationObserver(relayout).observe(view, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(relayout).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  function setWidth(next) {
    const m = measure();
    kept = clamp(next, m.lim) / m.uiZoom;
    hooks.keepPlace(layout);
  }

  // ---- the divider ----
  let drag = null;
  divider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !open) return;
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    // the pointer holds the divider where it grabbed it, not at its centre
    drag = { pointer: e.pointerId, grab: e.clientX - region.getBoundingClientRect().left };
    view.classList.add('split-dragging');
  });
  divider.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const edge = e.clientX - drag.grab;
    setWidth(measure().viewWidth - measure().side - edge);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    drag = null;
    view.classList.remove('split-dragging');
    remember();
  };
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);

  function reset() {
    kept = null;
    remember();
    hooks.keepPlace(layout);
  }
  divider.addEventListener('dblclick', reset);
  divider.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      reset();
      return;
    }
    const m = measure();
    const next = keyWidth({ key: e.key, shiftKey: e.shiftKey, width, limits: m.lim, uiZoom: m.uiZoom });
    if (next === null) return;
    e.preventDefault();
    if (next === width) return; // at a limit the divider stays put
    setWidth(next);
    remember();
  });

  // ---- open, close, focus ----
  region.addEventListener('focusout', (e) => {
    if (e.target !== divider && !region.contains(e.relatedTarget)) lastFocus = e.target;
  });
  function openColumn() {
    if (open) return;
    open = true;
    hooks.keepPlace(layout);
    emit('open');
  }
  function closeColumn() {
    if (!open) return;
    const had = region.contains(document.activeElement);
    open = false;
    hooks.keepPlace(layout);
    // the keyboard goes back to the book, never to nowhere
    if (had) hooks.focusBook();
    emit('close');
  }

  window.NeoSplit = Object.freeze({
    ...rules,
    // the pieces app.js and plugins.js work with
    region, element: body, divider,
    attach(given) { hooks = { ...hooks, ...given }; },
    // a plugin has put something in the column: only then does the shortcut do anything
    setAvailable(on) {
      available = !!on;
      if (!available) closeColumn();
    },
    isAvailable: () => available,
    isOpen: () => open,
    open: openColumn,
    close: closeColumn,
    toggle() {
      if (!available) return false;
      if (open) closeColumn();
      else openColumn();
      return true;
    },
    contains: (node) => !!node && region.contains(node),
    // where F6 lands: where the keyboard was in the column, else the column itself
    focus() {
      if (!open) return false;
      const spot = lastFocus && lastFocus.isConnected && body.contains(lastFocus) ? lastFocus : body;
      spot.focus({ preventScroll: true });
      return true;
    },
    on(name, fn) {
      if (!listeners[name]) throw new TypeError(`no column event is called ${name}`);
      listeners[name].add(fn);
      return () => listeners[name].delete(fn);
    },
  });
})();
