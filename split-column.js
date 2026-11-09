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

  // What a key does to the width, or null for a key the divider has no use for. Left moves the
  // divider left, so the column grows.
  function keyWidth({ key, shiftKey, width, limits: lim, uiZoom = 1, usual }) {
    const step = (shiftKey ? STEP_LARGE : STEP) * uiZoom;
    switch (key) {
      case 'ArrowLeft': return clamp(width + step, lim);
      case 'ArrowRight': return clamp(width - step, lim);
      case 'Home': return lim.max;
      case 'End': return lim.min;
      case 'Enter': return clamp(usual, lim);
      default: return null;
    }
  }

  const rules = { limits, clamp, defaultWidth, bookShare, keyWidth };
  if (typeof module !== 'undefined' && module.exports) module.exports = rules;
  else window.NeoSplit = rules;
})();
