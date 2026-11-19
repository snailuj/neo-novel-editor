import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Pinned panes that float when the page column needs the room (split-view-design.md, "When there
// is not room for everything", steps 3 and 4; split-column.js). The pins are pressed in the
// order the spec names, as a writer's clicks are. Each spec names one rule.

const TIP = 'Kept open where there is room. Floating now: the page column needs the room.';
const LONG = Array.from({ length: 60 }, (_, i) => `<p>Line ${i}. The tide came in at dusk.</p>`).join('');

async function setWindow(app, page, width) {
  await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 800), width);
  await page.waitForFunction((w) => innerWidth === w, width);
}

async function start() {
  const fixture = await launchProfile(undefined, { env: { NEO_PLUGIN_DIRS: 'tests/fixtures/plugins/v6' } });
  await seedBook(fixture.page, LONG);
  await fixture.page.waitForFunction(() => window.__column?.handle);
  return fixture;
}

// Pins in the given order, as clicks on the pins do
const pins = (page, order) => page.evaluate((order) => { for (const [side, on] of order) pinPane(side, on); }, order);
const openColumn = (page) => page.evaluate(() => NeoSplit.open());
const closeColumn = (page) => page.evaluate(() => NeoSplit.close());

// What the writer sees, once the slides have finished: for each pane whether it is docked (the
// page makes room for it), open, and what its pin shows; and the column and the page.
async function look(page) {
  const read = () => page.evaluate(() => {
    const view = document.querySelector('#editor-view');
    // a custom property is read back unresolved: a probe of that width is measured instead
    const length = (name) => {
      const probe = document.createElement('div');
      probe.style.cssText = `position:absolute;visibility:hidden;height:0;width:var(${name})`;
      view.appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return width;
    };
    const box = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; };
    const pane = (name) => {
      const pin = document.querySelector(`#${name}-pin`);
      const pinStyle = getComputedStyle(pin);
      return {
        dock: length(name === 'nav' ? '--dock-left' : '--side-dock'),
        open: document.querySelector(`#${name}-pane`).classList.contains('open'),
        pinned: pin.getAttribute('aria-pressed') === 'true',
        ring: pinStyle.borderTopStyle,
        tip: pin.title,
        box: box(`#${name}-pane`),
      };
    };
    return {
      nav: pane('nav'), side: pane('side'), column: box('#split-column'), paper: box('#paper-scroll'),
      split: view.classList.contains('split-open'), overlay: view.classList.contains('split-overlay'), width: innerWidth,
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
const floats = (pane) => !pane.dock && pane.pinned;
const docks = (pane) => pane.dock > 0 && pane.pinned && pane.open;

test('both panes pinned with no room beside the column: the one pinned earlier floats, the one pinned last docks', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440); // 248 + 560 + 400 + 250 = 1458
    await pins(page, [['nav', true], ['side', true]]);
    let m = await look(page);
    expect(docks(m.nav) && docks(m.side), 'with the column shut both dock').toBe(true);

    await openColumn(page);
    m = await look(page);
    expect(m.split, 'the column really is open, beside the book').toBe(true);
    expect(m.overlay).toBe(false);
    expect(m.nav.pinned && m.side.pinned, 'both are still pinned').toBe(true);
    expect(floats(m.nav), 'nav, pinned first, floats').toBe(true);
    expect(m.nav.open, 'and is shut, as an unpinned pane is').toBe(false);
    expect(m.nav.box.right, 'and is out of the window').toBeLessThanOrEqual(0);
    expect(docks(m.side), 'side, pinned last, docks').toBe(true);
    expect(m.nav.ring, 'the floating pin has a dashed ring').toBe('dashed');
    expect(m.side.ring, 'the docked pin has none').toBe('none');
    expect(m.nav.tip).toBe(TIP);
    expect(m.side.tip).not.toBe(TIP);
    // the room left of the column is the book's, and the book is not narrower than its minimum
    expect(m.column.left).toBeGreaterThanOrEqual(560 - 1);
    expect(m.column.right).toBe(m.side.box.left);
    expect(Math.abs((m.paper.left + m.paper.right) / 2 - m.column.left / 2), 'the book is centred in the room the floating pane leaves').toBeLessThanOrEqual(1);
  } finally { await close(); }
});

test('the pane pinned last is the one that docks, whichever pane it is', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await openColumn(page);
    await pins(page, [['side', true], ['nav', true]]);
    let m = await look(page);
    expect(floats(m.side), 'side, pinned first, floats').toBe(true);
    expect(docks(m.nav), 'nav, pinned last, docks').toBe(true);
    expect(m.side.ring).toBe('dashed');
    expect(m.nav.ring).toBe('none');

    // pinning the one that floats again (off and on) makes it the one pinned last
    await pins(page, [['side', false], ['side', true]]);
    m = await look(page);
    expect(docks(m.side), 'side, pinned last now, docks').toBe(true);
    expect(floats(m.nav), 'and nav floats').toBe(true);
  } finally { await close(); }
});

test('with less than 960px left even for one pane, the pane pinned last floats too, and the column stays beside the book', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1100);
    await openColumn(page);
    await pins(page, [['nav', true]]);
    let m = await look(page);
    expect(m.split).toBe(true);
    expect(m.overlay, 'beside the book, with 1100px to share').toBe(false);
    expect(m.nav.pinned).toBe(true);
    expect(floats(m.nav), 'a lone pinned pane floats when 1100 - 248 is under 960').toBe(true);
    expect(m.nav.ring).toBe('dashed');

    await pins(page, [['side', true]]);
    m = await look(page);
    expect(floats(m.nav) && floats(m.side), 'both float').toBe(true);
    expect(m.nav.ring).toBe('dashed');
    expect(m.side.ring).toBe('dashed');
    expect(m.overlay).toBe(false);
    expect(m.column.right, 'the column is at the window\'s edge').toBe(1100);
    expect(m.column.left).toBeGreaterThanOrEqual(560 - 1);
  } finally { await close(); }
});

test('below 960px the panes float and the column lies over the book', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 900);
    await pins(page, [['nav', true], ['side', true]]);
    await openColumn(page);
    const m = await look(page);
    expect(m.split).toBe(true);
    expect(m.overlay).toBe(true);
    expect(floats(m.nav) && floats(m.side)).toBe(true);
    expect(Math.abs((m.paper.left + m.paper.right) / 2 - 450), 'the book keeps the window\'s centre').toBeLessThanOrEqual(1);
  } finally { await close(); }
});

test('a floating pane docks again as the window widens, and when the column closes, its ring gone', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await openColumn(page);
    await pins(page, [['nav', true], ['side', true]]);
    let m = await look(page);
    expect(floats(m.nav), 'floating to begin with').toBe(true);

    await setWindow(app, page, 1600);
    m = await look(page);
    expect(docks(m.nav) && docks(m.side), 'room again: both dock').toBe(true);
    expect(m.nav.ring).toBe('none');
    expect(m.nav.tip).not.toBe(TIP);

    await setWindow(app, page, 1440);
    expect(floats((await look(page)).nav), 'floating again').toBe(true);
    await closeColumn(page);
    m = await look(page);
    expect(m.split).toBe(false);
    expect(docks(m.nav) && docks(m.side), 'the column shut: both dock').toBe(true);
    expect(m.nav.ring).toBe('none');
  } finally { await close(); }
});

test('a floating pane opens on hover as an unpinned pane does, and shuts when the pointer leaves', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await openColumn(page);
    await pins(page, [['nav', true], ['side', true]]);
    expect(floats((await look(page)).nav)).toBe(true);
    await page.mouse.move(4, 400);
    await expect.poll(async () => (await look(page)).nav.box.left).toBe(0);
    let m = await look(page);
    expect(m.nav.open).toBe(true);
    expect(m.nav.dock, 'it floats over the book and moves nothing').toBe(0);
    await page.mouse.move(700, 500);
    await expect.poll(async () => (await look(page)).nav.open).toBe(false);
    m = await look(page);
    expect(m.nav.pinned, 'its pin is kept').toBe(true);
  } finally { await close(); }
});

test('a click on a floating pane\'s pin unpins it, never nothing', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1440);
    await openColumn(page);
    await pins(page, [['nav', true], ['side', true]]);
    expect(floats((await look(page)).nav), 'it really floats first').toBe(true);
    await page.mouse.move(4, 400);
    await expect.poll(async () => (await look(page)).nav.box.left).toBe(0);
    await page.locator('#nav-pin').click();
    const m = await look(page);
    expect(m.nav.pinned, 'unpinned').toBe(false);
    expect(m.nav.ring).toBe('none');
    expect(m.nav.tip).not.toBe(TIP);
    expect(docks(m.side), 'the other pane is as it was').toBe(true);
  } finally { await close(); }
});

test('with the room for everything beside the column no pane floats', async () => {
  const { app, page, close } = await start();
  try {
    await setWindow(app, page, 1800);
    await openColumn(page);
    await pins(page, [['nav', true], ['side', true]]);
    const m = await look(page);
    expect(m.split).toBe(true);
    expect(docks(m.nav) && docks(m.side)).toBe(true);
    expect(m.nav.ring).toBe('none');
    expect(m.side.ring).toBe('none');
  } finally { await close(); }
});
