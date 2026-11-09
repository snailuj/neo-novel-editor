'use strict';

// The page column's width rules (split-column.js), without a window: where the column may be,
// what it starts at, and what the divider's keys do. The pixels are the ones the window sees,
// Interface size and page zoom already applied. The divider and the column on screen are looked
// at in tests/e2e/split-column.spec.mjs.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const S = require('../split-column.js');

const rooms = [300, 700, 959, 960, 1000, 1192, 1440, 2560];
const zooms = [0.8, 1, 1.25, 1.5];
const widths = [-50, 0, 1, 399, 400, 576, 640, 641, 1000, 1e9, Infinity, -Infinity, NaN];

test('the column stays within its limits whatever the width asked for, the room and the zooms', () => {
  let checked = 0;
  for (const room of rooms) for (const uiZoom of zooms) for (const pageZoom of zooms) {
    const lim = S.limits({ room, uiZoom, pageZoom });
    assert.ok(lim.min <= lim.max, `limits ${JSON.stringify(lim)} for room ${room}`);
    for (const asked of widths) {
      const got = S.clamp(asked, lim);
      assert.ok(got >= lim.min && got <= lim.max, `${asked} in room ${room}, zooms ${uiZoom}/${pageZoom}: ${got} outside ${lim.min}-${lim.max}`);
      checked++;
    }
  }
  assert.equal(checked, rooms.length * zooms.length * zooms.length * widths.length);
});

test('beside the book, the book keeps 560px at page zoom 1 and the column keeps 400px at Interface size 1', () => {
  const lim = S.limits({ room: 1440, uiZoom: 1, pageZoom: 1 });
  assert.deepEqual(lim, { min: 400, max: 880, overlay: false });
  const scaled = S.limits({ room: 1800, uiZoom: 1.25, pageZoom: 1.5 });
  assert.equal(scaled.min, 500);
  assert.equal(1800 - scaled.max, 840);
  assert.equal(scaled.overlay, false);
});

test('with less than 960px of room the column lies over the book, up to the room less 48px', () => {
  assert.equal(S.limits({ room: 960, uiZoom: 1, pageZoom: 1 }).overlay, false);
  const lim = S.limits({ room: 959, uiZoom: 1, pageZoom: 1 });
  assert.equal(lim.overlay, true);
  assert.equal(lim.min, 400);
  assert.equal(lim.max, 959 - 48);
  // a window too narrow even for that keeps the minimum
  assert.equal(S.limits({ room: 420, uiZoom: 1, pageZoom: 1 }).max, 400);
});

test('the usual width is 40% of the window, between 400 and 640px', () => {
  const at = (viewWidth, uiZoom = 1) => S.defaultWidth({ viewWidth, uiZoom });
  assert.equal(at(1440), 576);
  assert.equal(at(1024), 409.6);
  assert.equal(at(700), 400);
  assert.equal(at(2560), 640);
  // the limits scale with Interface size; the 40% is of the window as it is
  assert.equal(at(1000, 1.25), 500);
  assert.equal(at(2560, 1.25), 800);
});

test('the divider reports the book\'s share of the room, so a wider column reads lower', () => {
  assert.equal(S.bookShare(1000, 400), 60);
  assert.equal(S.bookShare(1000, 500), 50);
  assert.equal(S.bookShare(1000, 1000), 0);
  assert.equal(S.bookShare(0, 400), 0);
});

test('the divider\'s keys: arrows 16px, Shift 64px, Home widest, End narrowest, none past a limit', () => {
  const lim = { min: 400, max: 880, overlay: false };
  const next = (key, width, shiftKey = false) => S.keyWidth({ key, shiftKey, width, limits: lim, uiZoom: 1, usual: 576 });
  assert.equal(next('ArrowLeft', 576), 592);
  assert.equal(next('ArrowRight', 576), 560);
  assert.equal(next('ArrowLeft', 576, true), 640);
  assert.equal(next('ArrowRight', 576, true), 512);
  assert.equal(next('Home', 576), 880);
  assert.equal(next('End', 576), 400);
  assert.equal(next('Enter', 700), 576);
  assert.equal(next('ArrowLeft', 880), 880);
  assert.equal(next('ArrowRight', 400), 400);
  assert.equal(next('ArrowLeft', 870), 880);
  assert.equal(next('a', 576), null);
  assert.equal(S.keyWidth({ key: 'ArrowLeft', shiftKey: false, width: 600, limits: lim, uiZoom: 1.25, usual: 576 }), 620);
});
