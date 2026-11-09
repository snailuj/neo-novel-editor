import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';
import { caretInBook, columnSettled, fileOf, followLink, inManuscript, libraryProfile, pagesTab, rowOf } from '../support/library-pages.mjs';

// The stored page in the host's page column (split-view-design.md, "The page column"), and the
// Pages tab of the left pane that lists the pages to open there. Each spec names its rule.

const PAGES = {
  'wiki/Places/Coast/Harbour.html': '<p data-block="h1">The harbour faces east, below [[Gull]].</p>',
  'wiki/Places/Coast/Tide Tables.html': '<p data-block="t1">High water at noon.</p>',
  'wiki/People/Gull.html': '<p data-block="g1">Gull rows out at dawn.</p>',
  'sources/Kraken.html': '<p data-block="k1">Bones on the bar.</p>',
};

const middleOf = (page, words) => page.evaluate((words) => {
  const p = [...document.querySelectorAll('#chapters .chapter-body p')].find((el) => el.textContent.includes(words));
  const range = document.createRange();
  const at = p.textContent.indexOf(words);
  range.setStart(p.firstChild, at + 2);
  range.setEnd(p.firstChild, at + words.length - 2);
  const box = range.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}, words);

async function started() {
  const { profile, library } = await libraryProfile(PAGES);
  const fixture = await launchProfile(profile);
  await fixture.page.waitForFunction(() => !!window.hoard);
  const novel = await seedBook(fixture.page, '<p>Meet at the [[Harbour]] with [[Gull]] before the tide turns.</p>');
  return { ...fixture, library, novel };
}

// Rule: opening a page from any entry point shows it in the column and leaves the book's caret
// where it was: Follow Link and Ctrl+click keep the keyboard in the book, a Pages row keeps it
// on the row and the tree as it was, and nothing shows in the right-hand pane.
test('a page opened from Follow Link, Ctrl+click or a Pages row shows in the column, the book\'s caret where it was', async () => {
  const { page, close, novel } = await started();
  try {
    const column = page.locator('#split-column');
    await expect(page.locator('#editor-view')).not.toHaveClass(/\bsplit-open\b/);

    await caretInBook(page, '[[Harbour]]');
    const before = await page.evaluate(() => captureCaret());
    await followLink(page);
    await columnSettled(page);
    await expect(column.locator('.hoard-wiki-title')).toHaveText('Harbour');
    await expect(column.locator('.hoard-wiki-line')).toHaveText(['The harbour faces east, below [[Gull]].']);
    await expect(column.locator('.hoard-crumb')).toHaveText(['Wiki', 'Places', 'Coast']);
    await expect(column).toBeVisible();
    expect(await page.evaluate(() => [book.id, captureCaret()])).toEqual([novel, before]);
    expect(await inManuscript(page)).toBe(true);
    await expect(page.locator('#side-pane .hoard-wiki-title')).toHaveCount(0);

    const { x, y } = await middleOf(page, '[[Gull]]');
    await page.keyboard.down('Control');
    await page.mouse.click(x, y);
    await page.keyboard.up('Control');
    await expect(column.locator('.hoard-wiki-title')).toHaveText('Gull');
    expect(await inManuscript(page)).toBe(true);
    const clicked = await page.evaluate(() => captureCaret());

    // the tree unfolds to the page shown; a row opens its page, from the keyboard with the focus
    // left on the row, by the pointer with nothing focused (NEO's panes leave none after a click)
    const tree = await pagesTab(page);
    const row = rowOf(tree);
    await expect(row('Gull')).toHaveAttribute('aria-current', 'page');
    await row('Tide Tables').focus();
    await page.keyboard.press('Enter');
    await expect(column.locator('.hoard-wiki-title')).toHaveText('Tide Tables');
    await expect(row('Tide Tables')).toBeFocused();
    await expect(row('Tide Tables')).toHaveAttribute('aria-current', 'page');
    await expect(tree.locator('[aria-current]')).toHaveCount(1);
    await row('Harbour').click();
    await expect(column.locator('.hoard-wiki-title')).toHaveText('Harbour');
    expect(await page.evaluate(() => !!document.activeElement.closest('#split-column'))).toBe(false);
    expect(await page.evaluate(() => [book.id, captureCaret()])).toEqual([novel, clicked]);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Places/Coast/Harbour.html');
  } finally {
    await close();
  }
});

// Rule: closing the column and reopening it with Ctrl+\ shows the last page: Close hands the
// keyboard back to the book, and the shortcut brings the same page and its trail back; with
// no page yet, it opens on what to do, and Show Pages opens the Pages tab.
test('closing the column and opening it again with Ctrl+\\ shows the last page', async () => {
  const { page, close } = await started();
  try {
    await caretInBook(page);
    await page.keyboard.press('Control+Backslash');
    const empty = await columnSettled(page);
    await expect(empty.locator('.hoard-wiki-empty')).toContainText('No page open. Pick one under Pages in the left pane');
    expect(await inManuscript(page)).toBe(true);
    await empty.getByRole('button', { name: 'Show Pages' }).click();
    await expect(page.locator('#nav-tabs [role="tab"]', { hasText: 'Pages' })).toHaveAttribute('aria-selected', 'true');
    await expect(rowOf(page.locator('#nav-pane .hoard-tree'))('Wiki')).toBeFocused();
    await caretInBook(page);
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('#editor-view')).not.toHaveClass(/\bsplit-open\b/);

    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/People/Gull.html'));
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/Places/Coast/Harbour.html'));
    const column = await columnSettled(page);
    await expect(column.locator('.hoard-wiki-title')).toHaveText('Harbour');
    await column.getByRole('button', { name: 'Close page column' }).click();
    await expect(page.locator('#editor-view')).not.toHaveClass(/\bsplit-open\b/);
    await expect.poll(() => inManuscript(page)).toBe(true);

    await page.keyboard.press('Control+Backslash');
    await columnSettled(page);
    await expect(column.locator('.hoard-wiki-title')).toHaveText('Harbour');
    await expect(column.locator('.hoard-wiki-line')).toHaveText(['The harbour faces east, below [[Gull]].']);
    expect(await inManuscript(page)).toBe(true);
    await column.getByRole('button', { name: 'Back to Gull' }).click();
    await expect(column.locator('.hoard-wiki-title')).toHaveText('Gull');
  } finally {
    await close();
  }
});

// Rule: renaming the open page from F2 in the column, from the page menu or from a row's menu
// in Pages renames its file, and the column's title and its Back and Forward trail follow.
test('renaming the open page from F2, the page menu or the tree updates the column title and the trail', async () => {
  const { page, close, library } = await started();
  try {
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/People/Gull.html'));
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/Places/Coast/Harbour.html'));
    const column = await columnSettled(page);
    const title = column.locator('.hoard-wiki-title');
    await expect(title).toHaveText('Harbour');

    // F2 in the column: the field opens under the page's row in Pages, with the focus in it
    await title.focus();
    await page.keyboard.press('F2');
    const tree = page.locator('#nav-pane .hoard-tree');
    const field = tree.getByLabel('New title for “Harbour”');
    await expect(field).toBeFocused();
    await field.fill('Quay');
    await field.press('Enter');
    await expect(title).toHaveText('Quay');
    expect(fileOf(library, 'wiki/Places/Coast/Quay.html')).toBe(PAGES['wiki/Places/Coast/Harbour.html']);
    await column.getByRole('button', { name: 'Back to Gull' }).click();
    await expect(title).toHaveText('Gull');
    await expect(column.getByRole('button', { name: 'Forward to Quay' })).toBeEnabled();

    // the page menu
    await column.getByRole('button', { name: 'Page actions' }).click();
    await page.locator('.pop-menu').getByRole('menuitem', { name: 'Rename page…' }).click();
    const gull = tree.getByLabel('New title for “Gull”');
    await expect(gull).toBeFocused();
    await gull.fill('Tern');
    await gull.press('Enter');
    await expect(title).toHaveText('Tern');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/People/Tern.html');

    // a row's own menu in Pages, on a page of the trail that is not shown
    const pages = await pagesTab(page);
    await rowOf(pages)('Quay').click({ button: 'right' });
    await page.locator('.pop-menu').getByRole('menuitem', { name: 'Rename page…' }).click();
    const quay = pages.getByLabel('New title for “Quay”');
    await quay.fill('Pier');
    await quay.press('Enter');
    await expect(rowOf(pages)('Pier')).toBeVisible();
    await expect(title).toHaveText('Tern');
    await column.getByRole('button', { name: 'Forward to Pier' }).click();
    await expect(title).toHaveText('Pier');
    await expect(column.getByRole('button', { name: 'Back to Tern' })).toBeEnabled();
  } finally {
    await close();
  }
});
