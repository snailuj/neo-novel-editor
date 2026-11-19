import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Rule: the manuscript's centre sits midway between the inner edges of the docked panes, in every
// pin state. The inner edges are read from the panes' own boxes, not from the widths the
// stylesheet assumes, so the rule holds whatever size a pane or Interface size gives them.
// --dock-left and --dock-right on #editor-view carry those edges to the one rule that centres
// the page; the split view's column will set --dock-right the same way.

const WIDTHS = [1440, 1100];
const ZOOMS = [1, 1.25];

const CASES = [
  { name: 'none pinned', nav: false, side: false },
  { name: 'nav pinned', nav: true, side: false },
  { name: 'side pinned', nav: false, side: true },
  { name: 'both pinned', nav: true, side: true },
  { name: 'side wide', nav: false, side: true, wide: true },
  { name: 'side wide with nav', nav: true, side: true, wide: true },
  // The Darlings tab keeps the right pane open whether or not it is pinned.
  { name: 'darlings tab', nav: false, side: false, darlings: true },
  { name: 'darlings tab with nav', nav: true, side: false, darlings: true },
  // The Outline board fills the room between the panes instead of centring a page.
  { name: 'board, none pinned', nav: false, side: false, board: true },
  { name: 'board, both pinned', nav: true, side: true, board: true },
  // What the split view will do: dock a column on the right by setting the variable.
  { name: 'column docked right (576px)', nav: false, side: false, column: 576 },
  { name: 'column docked right with nav', nav: true, side: false, column: 576 },
];

async function setUp(app, page, { width, zoom, nav, side, wide, darlings, board, column }) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
  await page.waitForFunction((w) => innerWidth === w, width);
  await page.evaluate(({ zoom, nav, side, wide, darlings, board, column }) => {
    document.documentElement.style.setProperty('--ui-zoom', String(zoom));
    pinPane('nav', nav);
    pinPane('side', side);
    const view = document.querySelector('#editor-view');
    document.querySelector('#nav-pane').classList.toggle('open', nav);
    document.querySelector('#side-pane').classList.toggle('open', side || !!darlings);
    document.querySelector('#side-pane').classList.toggle('wide', !!wide);
    view.classList.toggle('darlings-tab', !!darlings);
    view.classList.toggle('board-on', !!board);
    if (column) view.style.setProperty('--dock-right', column + 'px');
    else view.style.removeProperty('--dock-right');
  }, { zoom, nav, side, wide, darlings, board, column });
}

// The boxes once the panes' 0.18s slide has finished.
async function measure(page) {
  const read = () => page.evaluate(() => {
    const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    return { nav: box('#nav-pane'), side: box('#side-pane'), paper: box('#paper-scroll'), width: innerWidth };
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

test('the manuscript centres between the docked panes in every pin state', async () => {
  const { app, page, close } = await launchProfile();
  try {
    await seedBook(page, '<p>The tide came in at dusk.</p>');
    for (const width of WIDTHS) {
      for (const zoom of ZOOMS) {
        for (const c of CASES) {
          const label = `${c.name} at ${width}px, zoom ${zoom}`;
          await setUp(app, page, { width, zoom, ...c });
          const classes = await page.evaluate(() => [...document.querySelector('#editor-view').classList]);
          const m = await measure(page);

          // each case really reached its state before anything is compared
          expect(classes.includes('nav-pinned'), label).toBe(c.nav);
          expect(classes.includes('side-pinned'), label).toBe(c.side);
          expect(classes.includes('darlings-tab'), label).toBe(!!c.darlings);
          expect(classes.includes('board-on'), label).toBe(!!c.board);
          expect(m.width, label).toBe(width);
          if (c.nav) expect(m.nav.right, `${label}: nav pane visible`).toBeGreaterThan(200 * zoom);
          if (c.side || c.darlings) expect(m.side.left, `${label}: side pane visible`).toBeLessThan(width - 200 * zoom);
          if (c.wide) expect(m.side.width, `${label}: side pane wide`).toBeGreaterThan(400 * zoom);
          // the baseline is clean: a hidden pane leaves the page its whole side
          if (!c.nav) expect(m.nav.right, `${label}: nav pane hidden`).toBeLessThanOrEqual(0);
          if (!c.side && !c.darlings) expect(m.side.left, `${label}: side pane hidden`).toBeGreaterThanOrEqual(width);

          const inner = {
            left: c.nav ? m.nav.right : 0,
            right: c.column ? width - c.column : (c.side || c.darlings) ? m.side.left : width,
          };
          if (c.board) {
            expect(Math.abs(m.paper.left - inner.left), `${label}: board left ${m.paper.left}`).toBeLessThanOrEqual(1);
            expect(Math.abs(m.paper.right - inner.right), `${label}: board right ${m.paper.right}`).toBeLessThanOrEqual(1);
          } else {
            const centre = (m.paper.left + m.paper.right) / 2;
            expect(Math.abs(centre - (inner.left + inner.right) / 2), `${label}: centre ${centre}, wanted ${(inner.left + inner.right) / 2}`).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  } finally { await close(); }
});
