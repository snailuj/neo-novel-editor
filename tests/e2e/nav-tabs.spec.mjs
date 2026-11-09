import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// The left pane's tab strip (index.html #nav-tabs, app.js, and addPane's nav option in
// plugins.js, API 6). Chapters, or the view's own list, is the built-in first tab; a plugin's
// nav tabs follow it. The fixtures are in tests/fixtures/plugins/navtab-*.

const FIXTURES = 'tests/fixtures/plugins';
const THREE = '<p>One.</p>';

async function start(...groups) {
  const fixture = await launchProfile(undefined, { env: { NEO_PLUGIN_DIRS: groups.map((g) => `${FIXTURES}/${g}`).join(',') } });
  await seedBook(fixture.page, THREE);
  return fixture;
}

async function withNavTabs() {
  const fixture = await start('navtab-v6');
  await fixture.page.waitForFunction(() => window.__nav?.pages && window.__nav?.extra);
  return fixture;
}

// What the strip shows: each tab's label, whether it is selected, its tabindex, and whether the
// panel it controls is visible.
const strip = (page) => page.evaluate(() => [...document.querySelectorAll('#nav-tabs [role="tab"]')].map((tab) => {
  const panel = document.getElementById(tab.getAttribute('aria-controls'));
  return {
    label: tab.textContent.trim().replace(/\s+/g, ' '),
    selected: tab.getAttribute('aria-selected'),
    tabindex: tab.getAttribute('tabindex'),
    panel: !!panel && !panel.hidden && getComputedStyle(panel).display !== 'none',
  };
}));
const SELECT_FIRST = [
  { label: 'Chapters', selected: 'true', tabindex: '0', panel: true },
  { label: 'Pages', selected: 'false', tabindex: '-1', panel: false },
  { label: 'Extra', selected: 'false', tabindex: '-1', panel: false },
];
const selectOne = (index) => SELECT_FIRST.map((tab, i) => ({ ...tab, selected: String(i === index), tabindex: i === index ? '0' : '-1', panel: i === index }));

// Wakes the pane the way the writer does, by the pointer at the left edge.
async function hoverOpen(page) {
  await page.mouse.move(4, 400);
  await expect.poll(() => page.evaluate(() => document.querySelector('#nav-pane').classList.contains('open'))).toBe(true);
  // once it has slid in
  await expect.poll(() => page.evaluate(() => document.querySelector('#nav-pane').getBoundingClientRect().left)).toBe(0);
}
const chapterRows = (page) => page.locator('#nav-list .nav-item .n-label').allTextContents();

test('a plugin\'s nav tab sits after Chapters in a tablist, each tab controlling a panel', async () => {
  const { page, close } = await withNavTabs();
  try {
    expect(await strip(page)).toEqual(selectOne(0));
    const wiring = await page.evaluate(() => {
      const list = document.querySelector('#nav-tabs');
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      return {
        list: list.getAttribute('role'),
        orientation: list.getAttribute('aria-orientation'),
        named: !!list.getAttribute('aria-label'),
        // each panel is a tabpanel in the pane, named by its own tab
        panels: tabs.map((tab) => {
          const panel = document.getElementById(tab.getAttribute('aria-controls'));
          return panel && { role: panel.getAttribute('role'), by: panel.getAttribute('aria-labelledby') === tab.id, inPane: !!panel.closest('#nav-pane') };
        }),
        // the pin stays at the end of the head, outside the tablist
        pin: !list.contains(document.querySelector('#nav-pin')) && !!document.querySelector('#nav-head #nav-pin'),
        ids: new Set(tabs.map((tab) => tab.id)).size,
      };
    });
    expect(wiring).toEqual({
      list: 'tablist', orientation: 'horizontal', named: true,
      panels: Array(3).fill({ role: 'tabpanel', by: true, inPane: true }),
      pin: true, ids: 3,
    });
    // the handle has the shape of every other pane's
    expect(await page.evaluate(() => Object.keys(window.__nav.pages).sort())).toEqual(['element', 'show', 'wide']);
    expect(await page.evaluate(() => window.__nav.pages.element.closest('#nav-pane') !== null)).toBe(true);
    expect(await chapterRows(page)).toEqual(['Synthetic book']);
  } finally { await close(); }
});

test('a click on a tab shows its panel and Chapters shows the chapters again', async () => {
  const { page, close } = await withNavTabs();
  try {
    await hoverOpen(page);
    await page.getByRole('tab', { name: 'Pages' }).click();
    expect(await strip(page)).toEqual(selectOne(1));
    await expect(page.getByRole('tabpanel')).toHaveText('What the Pages tab shows.');
    await expect(page.locator('#nav-list')).toBeHidden();
    await expect(page.locator('#nav-add')).toBeHidden();

    await page.getByRole('tab', { name: 'Extra' }).click();
    expect(await strip(page)).toEqual(selectOne(2));
    // getByRole leaves out hidden panels: the one shown is the only one
    await expect(page.getByRole('tabpanel')).toHaveText('What the Extra tab shows.');

    // a second click on the selected tab changes nothing
    await page.getByRole('tab', { name: 'Extra' }).click();
    expect(await strip(page)).toEqual(selectOne(2));

    await page.getByRole('tab', { name: 'Chapters' }).click();
    expect(await strip(page)).toEqual(selectOne(0));
    await expect(page.locator('#nav-list')).toBeVisible();
    await expect(page.locator('#nav-add')).toBeVisible();
    expect(await chapterRows(page)).toEqual(['Synthetic book']);
  } finally { await close(); }
});

test('the arrow keys, Home and End move between tabs and select them, with one tab in the tab order', async () => {
  const { page, close } = await withNavTabs();
  try {
    await hoverOpen(page);
    await page.getByRole('tab', { name: 'Chapters' }).focus();
    const focused = () => page.evaluate(() => document.activeElement.textContent.trim());
    const press = async (key) => { await page.keyboard.press(key); return strip(page); };

    expect(await press('ArrowRight')).toEqual(selectOne(1));
    expect(await focused(), 'the keyboard goes with the selection').toBe('Pages');
    expect(await press('ArrowRight')).toEqual(selectOne(2));
    expect(await press('ArrowRight'), 'past the last: round to the first').toEqual(selectOne(0));
    expect(await press('ArrowLeft'), 'before the first: round to the last').toEqual(selectOne(2));
    expect(await press('Home')).toEqual(selectOne(0));
    expect(await press('End')).toEqual(selectOne(2));
    expect(await focused()).toBe('Extra');
    // Tab from a tab leaves the strip for the pin, never to another tab
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement.id)).toBe('nav-pin');
  } finally { await close(); }
});

test('show() opens the left pane and selects the tab, and says false once there is no book', async () => {
  const { page, close } = await withNavTabs();
  try {
    expect(await page.evaluate(() => document.querySelector('#nav-pane').classList.contains('open')), 'shut to begin with').toBe(false);
    expect(await page.evaluate(() => window.__nav.extra.show())).toBe(true);
    expect(await page.evaluate(() => document.querySelector('#nav-pane').classList.contains('open'))).toBe(true);
    expect(await strip(page)).toEqual(selectOne(2));
    expect(await page.evaluate(() => window.__nav.pages.show())).toBe(true);
    expect(await strip(page)).toEqual(selectOne(1));

    await page.evaluate(() => backToShelf());
    await page.waitForFunction(() => document.querySelector('#editor-view').hidden);
    expect(await page.evaluate(() => window.__nav.pages.show()), 'no book open').toBe(false);
  } finally { await close(); }
});

test('Chapters keeps working in a script and on the Notes tab, and names that view\'s own list', async () => {
  const fixture = await launchProfile(undefined, { env: { NEO_PLUGIN_DIRS: `${FIXTURES}/navtab-v6` } });
  const { page, close } = fixture;
  try {
    await seedBook(page, '<p class="sp-action">INT. HARBOUR - DAY</p>', { format: 'screenplay' });
    await page.waitForFunction(() => window.__nav?.pages && document.querySelector('#nav-pane').classList.contains('script'));
    const own = () => page.evaluate(() => ({
      label: document.querySelector('#nav-tab-own').textContent.trim(),
      rows: [...document.querySelectorAll('#nav-list .nav-item .n-label')].map((el) => el.textContent),
      shown: getComputedStyle(document.querySelector('#nav-list')).display !== 'none' && !document.querySelector('#nav-own').hidden,
    }));
    const script = await own();
    expect(script.label, 'a script names its own list').toBe('Elements');
    expect(script.shown).toBe(true);
    expect(script.rows.length, 'and lists its elements').toBeGreaterThan(3);

    // another tab and back: the elements are all still there
    await page.evaluate(() => window.__nav.pages.show());
    expect((await strip(page)).map((tab) => tab.selected)).toEqual(['false', 'true', 'false']);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('#nav-list')).display !== 'none' && !document.querySelector('#nav-own').hidden)).toBe(false);
    await page.getByRole('tab', { name: 'Elements' }).click();
    expect(await own()).toEqual(script);

    await page.evaluate(() => backToShelf());
    await page.waitForFunction(() => document.querySelector('#editor-view').hidden);
    await seedBook(page, THREE);
    await page.evaluate(() => switchTab('notes'));
    const notes = await page.evaluate(() => ({
      label: [...document.querySelectorAll('#nav-tab-own > span')].filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.textContent.trim()),
      notes: getComputedStyle(document.querySelector('#notes-nav')).display,
      chapters: getComputedStyle(document.querySelector('#nav-list')).display,
      own: !document.querySelector('#nav-own').hidden,
    }));
    expect(notes).toEqual({ label: ['Notes'], notes: 'block', chapters: 'none', own: true });
    await page.evaluate(() => switchTab('manuscript'));
    expect(await chapterRows(page)).toEqual(['Synthetic book']);
  } finally { await close(); }
});

test('a plugin below API 6 that passes nav: true is refused, as for any key its API does not know', async () => {
  const { page, close } = await start('navtab-v5');
  try {
    await page.waitForFunction(() => window.__navV5);
    await page.waitForFunction(() => window.__navV5.error !== null);
    expect(await page.evaluate(() => window.__navV5.error)).toBe('TypeError: pane pages takes id, title and side, not nav');
    expect(await strip(page)).toEqual([{ label: 'Chapters', selected: 'true', tabindex: '0', panel: true }]);
  } finally { await close(); }
});

test('a plugin that fails to activate loses its nav tab, and the writer is left on Chapters', async () => {
  const { page, close } = await start('navtab-throws');
  try {
    await page.waitForFunction(() => window.__navThrows === 'ran');
    await page.waitForTimeout(300);
    expect(await strip(page)).toEqual([{ label: 'Chapters', selected: 'true', tabindex: '0', panel: true }]);
    expect(await page.evaluate(() => document.querySelectorAll('#nav-pane [role="tabpanel"]').length)).toBe(1);
  } finally { await close(); }
});

test('a nav tab that cannot be made is refused with a TypeError, and wide() is refused on one', async () => {
  const { page, close } = await withNavTabs();
  try {
    const refused = await page.evaluate(() => {
      const results = [];
      const add = (spec) => { try { window.__nav.neo.addPane(spec); results.push('made'); } catch (err) { results.push(`${err.name}: ${err.message}`); } };
      add({ id: 'both', title: 'Both', nav: true, side: true });
      add({ id: 'wrong', title: 'Wrong', nav: 'yes' });
      add({ id: 'pages', title: 'Again', nav: true });
      try { window.__nav.pages.wide(true); results.push('widened'); } catch (err) { results.push(err.name); }
      return results;
    });
    expect(refused).toEqual([
      'TypeError: pane both is either a nav tab or a side section, not both',
      'TypeError: pane wrong\'s nav is true or false, not "yes"',
      'TypeError: pane pages is added already',
      'TypeError',
    ]);
    // nothing was made along the way
    expect((await strip(page)).map((tab) => tab.label)).toEqual(['Chapters', 'Pages', 'Extra']);
  } finally { await close(); }
});

// ---- Left-Pane-Stays-Open: the pane an unpinned reader opens by hovering stays while the
// keyboard is in it or a form is open in it, and closes once neither holds it ----

const paneOpen = (page) => page.evaluate(() => document.querySelector('#nav-pane').classList.contains('open'));
// away from both edges, where a hover zone would wake a pane
const pointerAway = (page) => page.mouse.move(700, 500);
async function openPagesTab(page) {
  await hoverOpen(page);
  await page.getByRole('tab', { name: 'Pages' }).click();
  expect(await strip(page)).toEqual(selectOne(1));
}

test('the left pane stays open, unpinned, while the keyboard is in an input in a tab, and closes when it leaves', async () => {
  const { page, close } = await withNavTabs();
  try {
    expect(await page.evaluate(() => document.querySelector('#nav-pane').dataset.pinned !== '1'), 'not pinned').toBe(true);
    await openPagesTab(page);
    await page.locator('#nav-fixture-input').click();
    expect(await page.evaluate(() => document.activeElement.id), 'the keyboard really is in the input').toBe('nav-fixture-input');
    await pointerAway(page);
    await page.waitForTimeout(300);
    expect(await paneOpen(page), 'the pointer has left, the keyboard has not').toBe(true);
    await page.keyboard.type('Harbour');
    expect(await page.inputValue('#nav-fixture-input')).toBe('Harbour');

    // the keyboard goes back to the book: nothing holds the pane any more
    await page.locator('#paper-scroll .chapter-body p').click();
    expect(await page.evaluate(() => !!document.activeElement.closest('#paper-scroll'))).toBe(true);
    await expect.poll(() => paneOpen(page)).toBe(false);
  } finally { await close(); }
});

test('the left pane stays open, unpinned, while a form is open in it even with the keyboard elsewhere', async () => {
  const { page, close } = await withNavTabs();
  try {
    await openPagesTab(page);
    await page.evaluate(() => window.__nav.openForm());
    await page.locator('#paper-scroll .chapter-body p').click();
    await pointerAway(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => !!document.activeElement.closest('#nav-pane')), 'the keyboard is out of the pane').toBe(false);
    expect(await page.evaluate(() => !!document.querySelector('#nav-fixture-form')), 'the form is open').toBe(true);
    expect(await paneOpen(page), 'so the pane holds').toBe(true);

    // with the form gone the next pointer leaving closes it
    await page.evaluate(() => window.__nav.closeForm());
    await hoverOpen(page);
    await pointerAway(page);
    await expect.poll(() => paneOpen(page)).toBe(false);
  } finally { await close(); }
});

test('an unpinned left pane the pointer leaves closes as it always did when nothing is in it', async () => {
  const { page, close } = await withNavTabs();
  try {
    await hoverOpen(page);
    await pointerAway(page);
    await expect.poll(() => paneOpen(page)).toBe(false);
  } finally { await close(); }
});
