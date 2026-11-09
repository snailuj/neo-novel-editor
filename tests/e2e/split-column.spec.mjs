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

// The widest the column may be, from the boxes and the design's numbers: the book keeps 560px
// beside it, and with less room than that the column lies over the book up to the room less 48px.
function widest(m, windowWidth, nav) {
  const room = windowWidth - (nav ? NAV : 0);
  return room - BOOK_MIN >= COLUMN_MIN ? room - BOOK_MIN : Math.max(COLUMN_MIN, room - 48);
}

// Drags the divider by the column's own edge to x. The pointer holds it where it grabbed it, so
// the column's width afterwards is the window's width less x.
async function dragTo(page, x) {
  const edge = (await measure(page)).column.left; // once it has slid in
  await page.mouse.move(edge, 400);
  await page.mouse.down();
  await page.mouse.move(x, 400, { steps: 6 });
  await page.mouse.up();
  // away from the window's edges, where a hover zone would wake a pane over the divider
  await page.mouse.move(await page.evaluate(() => innerWidth / 2), 600);
}

const valueOf = (page) => page.evaluate(() => {
  const d = document.querySelector('#split-divider');
  return { now: +d.getAttribute('aria-valuenow'), min: +d.getAttribute('aria-valuemin'), max: +d.getAttribute('aria-valuemax') };
});

test('dragging the divider follows the pointer and stops at the limits without jumping, in any window', async () => {
  const { app, page, close } = await start();
  try {
    for (const width of [1440, 1100, 800]) {
      await setWindow(app, page, width);
      await pin(page, {});
      await openColumn(page);
      const top = widest(await measure(page), width, false);
      const label = `window ${width}`;

      await dragTo(page, width - 500);
      let m = await measure(page);
      // the drag really moved it before the limits are tried
      expect(m.column.width, `${label}: follows the pointer`).toBeCloseTo(Math.min(500, top), 0);
      await dragTo(page, 2);
      m = await measure(page);
      expect(m.column.width, `${label}: stops at the widest`).toBeCloseTo(top, 0);
      expect((await valueOf(page)).now, label).toBe((await valueOf(page)).min);
      await dragTo(page, width - 1);
      m = await measure(page);
      expect(m.column.width, `${label}: stops at the narrowest`).toBeCloseTo(COLUMN_MIN, 0);
      expect((await valueOf(page)).now, label).toBe((await valueOf(page)).max);
      // never past the window's own right edge
      expect(m.column.right, label).toBe(width);
      await closeColumn(page);
    }
  } finally { await close(); }
});

test('the divider\'s keys move it 16px, Shift 64px, Home to the widest, End to the narrowest', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await pin(page, {});
    await openColumn(page);
    await page.locator('#split-divider').focus();
    const wide = async () => (await measure(page)).column.width;
    const start0 = await wide();
    expect(start0).toBe(576); // the usual width, 40% of the window
    const press = async (key) => { await page.keyboard.press(key); return wide(); };

    expect(await press('ArrowLeft')).toBe(start0 + 16);
    expect(await press('ArrowRight')).toBe(start0);
    expect(await press('Shift+ArrowLeft')).toBe(start0 + 64);
    expect(await press('Shift+ArrowRight')).toBe(start0);
    const widestNow = widest(await measure(page), 1440, false);
    expect(await press('Home')).toBe(widestNow);
    // at a limit the key changes nothing
    expect(await press('ArrowLeft')).toBe(widestNow);
    expect((await valueOf(page)).now).toBe((await valueOf(page)).min);
    expect(await press('End')).toBe(COLUMN_MIN);
    expect(await press('ArrowRight')).toBe(COLUMN_MIN);
    expect((await valueOf(page)).now).toBe((await valueOf(page)).max);
  } finally { await close(); }
});

test('a double-click or Enter on the divider returns the column to the usual width', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await pin(page, {});
    await openColumn(page);
    for (const how of ['double-click', 'Enter']) {
      await dragTo(page, 1440 - 450);
      expect((await measure(page)).column.width, `${how}: moved off the usual width first`).toBeCloseTo(450, 0);
      if (how === 'Enter') {
        await page.locator('#split-divider').focus();
        await page.keyboard.press('Enter');
      } else {
        await page.locator('#split-divider').dblclick();
      }
      expect((await measure(page)).column.width, how).toBe(576);
      expect(await page.evaluate(() => localStorage.getItem('neo.splitWidth')), `${how}: the kept width is forgotten`).toBeNull();
    }
    // a second reset is idempotent
    await page.locator('#split-divider').dblclick();
    expect((await measure(page)).column.width).toBe(576);
  } finally { await close(); }
});

test('the column keeps its width as the window changes until the book reaches its minimum, then gives way', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await pin(page, {});
    await openColumn(page);
    await dragTo(page, 1440 - 600);
    expect((await measure(page)).column.width).toBeCloseTo(600, 0);

    await setWindow(app, page, 1800);
    let m = await measure(page);
    expect(m.column.width, 'a wider window gives the book the change').toBeCloseTo(600, 0);
    expect(m.paper.right - m.paper.left, 'and the book is not narrower').toBeGreaterThan(560);

    await setWindow(app, page, 1100);
    m = await measure(page);
    expect(m.overlay).toBe(false);
    expect(m.column.width, 'a narrow window takes it from the column, down to the book minimum').toBeCloseTo(1100 - BOOK_MIN, 0);
    expect(m.column.left, 'the book keeps its room').toBeGreaterThanOrEqual(BOOK_MIN - 1);

    await setWindow(app, page, 1440);
    expect((await measure(page)).column.width, 'the width the writer chose comes back').toBeCloseTo(600, 0);
  } finally { await close(); }
});

test('with less than 960px of room the column lies over the book, which keeps the window\'s centre', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 800);
    await pin(page, {});
    await openColumn(page);
    const m = await measure(page);
    expect(m.open).toBe(true);
    expect(m.overlay).toBe(true);
    expect(m.column.width).toBeGreaterThanOrEqual(COLUMN_MIN);
    expect(m.column.width).toBeLessThanOrEqual(800 - 48);
    expect(Math.abs((m.paper.left + m.paper.right) / 2 - 400), 'the book stays centred in the whole window').toBeLessThanOrEqual(1);
    expect(m.column.left, 'the column covers the right of the book').toBeLessThan(m.paper.right);
    // beside the book again once the window has the room
    await setWindow(app, page, 1100);
    expect((await measure(page)).overlay).toBe(false);
  } finally { await close(); }
});

test('the divider is a focusable vertical separator with a name, a value and a 44px grab area', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await pin(page, {});
    await openColumn(page);
    const m = await measure(page);
    const d = page.locator('#split-divider');
    await expect(d).toHaveAttribute('role', 'separator');
    await expect(d).toHaveAttribute('aria-orientation', 'vertical');
    await expect(d).toHaveAttribute('tabindex', '0');
    expect(await d.getAttribute('aria-label')).toMatch(/resize/i);
    const v = await valueOf(page);
    expect(v.min).toBeLessThan(v.now);
    expect(v.now).toBeLessThan(v.max);
    expect(await d.getAttribute('aria-valuetext')).toBe(`Book ${v.now} percent, page ${100 - v.now} percent`);
    expect(m.divider.width).toBeGreaterThanOrEqual(44);
    // 12px of the grab area lie over the book's margin and the rest over the column
    expect(m.divider.left).toBeCloseTo(m.column.left - 12, 0);
    await d.focus();
    expect(await page.evaluate(() => document.activeElement.id)).toBe('split-divider');
    // the grip is drawn at all times, not only on hover
    const grip = await page.evaluate(() => {
      const g = document.querySelector('.split-grip');
      const r = g.getBoundingClientRect();
      return { w: r.width, h: r.height, shown: getComputedStyle(g).visibility !== 'hidden' };
    });
    expect(grip).toEqual({ w: 5, h: 36, shown: true });
  } finally { await close(); }
});

test('the wheel over the column never scrolls the manuscript', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1800); // wide enough for a margin beside the page that is not a hover zone
    await pin(page, {});
    await openColumn(page);
    const m = await measure(page);
    const top = () => page.evaluate(() => document.querySelector('#paper-scroll').scrollTop);
    expect(await page.evaluate(() => { const s = document.querySelector('#paper-scroll'); return s.scrollHeight > s.clientHeight + 200; })).toBe(true);
    // the baseline: over the book's margin the wheel does scroll it
    expect(m.paper.left).toBeGreaterThan(120);
    await page.mouse.move(m.paper.left / 2, 300);
    await page.mouse.wheel(0, 300);
    await expect.poll(top).toBeGreaterThan(100);
    const scrolled = await top();
    await page.mouse.move((m.column.left + m.column.right) / 2, 300);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(250);
    expect(await top()).toBe(scrolled);
  } finally { await close(); }
});

test('the width survives a restart on the same machine', async () => {
  const first = await start();
  const { profile } = first;
  let bookId;
  try {
    await setWindow(first.app, first.page, 1440);
    await pin(first.page, {});
    await openColumn(first.page);
    await dragTo(first.page, 1440 - 470);
    expect((await measure(first.page)).column.width, 'the drag moved it off the usual 576').toBeCloseTo(470, 0);
    bookId = await first.page.evaluate(() => book.id);
  } finally { await first.close({ remove: false }); }

  const second = await launchProfile(profile);
  try {
    await setWindow(second.app, second.page, 1440);
    await second.page.evaluate((id) => openBook(id), bookId);
    await openColumn(second.page);
    expect((await measure(second.page)).column.width).toBeCloseTo(470, 0);
  } finally { await second.close(); }
});
