import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// The page column the host offers a plugin (split-column.js, #split-column in index.html). These
// specs open it through window.NeoSplit, as plugins.js does for a plugin's open(); what a plugin
// is handed is in the specs further down. Each spec names one rule.

const NAV = 248;
const SIDE = 250;
const COLUMN_MIN = 400;
const BOOK_MIN = 560;

async function setWindow(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
  await page.waitForFunction((w) => innerWidth === w, width);
}

async function pin(page, { nav = false, side = false, zoom = 1 } = {}) {
  await page.evaluate(({ nav, side, zoom }) => {
    document.documentElement.style.setProperty('--ui-zoom', String(zoom));
    pinPane('nav', nav);
    pinPane('side', side);
    document.querySelector('#nav-pane').classList.toggle('open', nav);
    document.querySelector('#side-pane').classList.toggle('open', side);
  }, { nav, side, zoom });
}

const openColumn = (page) => page.evaluate(() => { NeoSplit.open(); });
const closeColumn = (page) => page.evaluate(() => { NeoSplit.close(); });

// The boxes once the 0.18s slides have finished.
async function measure(page) {
  const read = () => page.evaluate(() => {
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
    };
    const view = document.querySelector('#editor-view');
    return {
      nav: box('#nav-pane'), side: box('#side-pane'), paper: box('#paper-scroll'),
      column: box('#split-column'), divider: box('#split-divider'),
      open: view.classList.contains('split-open'), overlay: view.classList.contains('split-overlay'),
      shown: !!document.querySelector('#split-column') && getComputedStyle(document.querySelector('#split-column')).visibility !== 'hidden',
      width: innerWidth,
    };
  });
  let before = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(50);
    const now = await read();
    if (JSON.stringify(now) === JSON.stringify(before)) return now;
    before = now;
  }
  throw new Error('the layout never settled');
}

const LONG = Array.from({ length: 120 }, (_, i) => `<p>Line ${i}. The tide came in at dusk and went out again before the lamps were lit.</p>`).join('');

async function start() {
  const fixture = await launchProfile();
  await seedBook(fixture.page, LONG);
  return fixture;
}

// What the room left of the column is, from the boxes: the nav pane's edge if pinned, the column's.
const roomOf = (m, nav) => ({ left: nav ? m.nav.right : 0, right: m.column.left });

const DOCKED = [
  { name: 'nothing pinned', width: 1440, nav: false, side: false },
  { name: 'nav pinned', width: 1440, nav: true, side: false },
  { name: 'side pinned', width: 1600, nav: false, side: true },
  { name: 'both pinned', width: 1800, nav: true, side: true },
];

test('an open column docks at the right and the manuscript centres in the room left of it', async () => {
  const { app, page, close } = await start();
  try {
    for (const c of DOCKED) {
      await setWindow(app, page, c.width);
      await pin(page, c);
      await openColumn(page);
      const m = await measure(page);
      const label = c.name;
      // each case really reached its state before anything is compared
      expect(m.open, label).toBe(true);
      expect(m.shown, label).toBe(true);
      expect(m.overlay, label).toBe(false);
      expect(m.width, label).toBe(c.width);
      if (c.nav) expect(m.nav.right, `${label}: nav pane visible`).toBeGreaterThan(NAV - 5);
      if (c.side) expect(m.side.left, `${label}: side pane visible`).toBeLessThan(c.width - SIDE + 5);

      // the column is the full editor height above the bottom bar, at the right (left of a pinned side pane)
      expect(m.column.top, label).toBe(0);
      expect(m.column.bottom, label).toBe(800 - 40);
      expect(m.column.right, label).toBe(c.side ? m.side.left : c.width);
      expect(m.column.width, label).toBeGreaterThanOrEqual(COLUMN_MIN);

      const room = roomOf(m, c.nav);
      expect(room.right - room.left, `${label}: the book keeps its minimum`).toBeGreaterThanOrEqual(BOOK_MIN - 1);
      const centre = (m.paper.left + m.paper.right) / 2;
      expect(Math.abs(centre - (room.left + room.right) / 2), `${label}: centre ${centre}`).toBeLessThanOrEqual(1);
      expect(m.paper.left, `${label}: the page clears the nav pane`).toBeGreaterThanOrEqual(room.left - 1);
      expect(m.paper.right, `${label}: the page clears the column`).toBeLessThanOrEqual(room.right + 1);
    }
  } finally { await close(); }
});

test('a closed column leaves the manuscript where the pinned panes put it', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1600);
    await pin(page, { nav: true, side: true });
    const before = await measure(page);
    await openColumn(page);
    const open = await measure(page);
    // the baseline is clean: the column moved the page, so closing has something to undo
    expect(open.open).toBe(true);
    expect(Math.abs(open.paper.left - before.paper.left)).toBeGreaterThan(20);
    await closeColumn(page);
    const closed = await measure(page);
    expect(closed.open).toBe(false);
    expect(closed.shown).toBe(false);
    expect(closed.paper).toEqual(before.paper);
    const dock = await page.evaluate(() => document.querySelector('#editor-view').style.getPropertyValue('--dock-right'));
    expect(dock).toBe('');
  } finally { await close(); }
});
