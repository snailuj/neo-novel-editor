import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Rules: Plugins > Search Library… opens a Search section beside the book with the focus
// in its field; a phrase is found in the library's wiki and sources pages, in the open
// book (as it stands on the page) and in other books, in groups, the Wiki pages first
// and then the Sources pages; a page result shows that page in the page column with its
// words marked, the book's caret left where it was; a result in the open book selects its words; one in another book opens
// it at the words; the pages scope keeps a search to the two page folders; and nothing
// found says where it looked.

async function profileWithPages() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(path.join(library, 'wiki'), { recursive: true });
  await mkdir(path.join(library, 'sources', 'Logs'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  await writeFile(path.join(library, 'wiki', 'Harbour.html'), '<p>The old harbour wall faces east.</p>');
  await writeFile(path.join(library, 'sources', 'Logs', 'Dock.html'), '<p>Nothing.</p><p>A harbour log.</p>');
  return profile;
}

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

const groups = (pane) => pane.locator('.hoard-search-book').allTextContents();

test('a phrase is found in the pages, the open book and other books, and each result goes where it says', async () => {
  const profile = await profileWithPages();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    const other = await seedBook(page, '<p>A gull on the harbour rail.</p><p>Second line.</p>', { title: 'Other book' });
    // the other book remembers the caret elsewhere, which it goes back to as it opens
    await page.evaluate(async () => {
      const p = document.querySelectorAll('.chapter-body p')[1];
      p.closest('.chapter-body').focus();
      const range = document.createRange();
      range.setStart(p.firstChild, 3);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await backToShelf();
    });
    const novel = await seedBook(page, '<p>Meet me at noon.</p>', { title: 'Novel' });
    // words on the page the file may not hold yet: the open book is searched as it stands
    await page.evaluate(() => {
      const p = document.querySelector('.chapter-body p');
      p.textContent = 'Meet me at the harbour at noon.';
    });

    await menu(app, 'Search Library…');
    const pane = page.locator('.hoard-search');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.hoard-search-field')).toBeFocused();
    await page.keyboard.type('Harbour');
    await expect.poll(() => groups(pane)).toEqual(['Wiki · 2', 'Sources · 1', 'Novel (open) · 1', 'Other book · 1']);
    await expect(pane.locator('.hoard-status')).toHaveText('5 matches in 4 groups.');
    await expect(pane.locator('.hoard-search-hit').first()).toContainText('Harbour (title)');

    // a page result shows that page in the page column with its words marked; the writer stays put
    const caret = await page.evaluate(() => captureCaret());
    await pane.locator('.hoard-search-group').nth(1).locator('.hoard-search-hit').click();
    await expect(page.locator('#split-column .hoard-wiki-title')).toHaveText('Dock');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('sources/Logs/Dock.html');
    await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get('hoard-wiki-found') ?? [])].map((r) => r.toString()))).toEqual(['harbour']);
    expect(await page.evaluate(() => [book.id, captureCaret()])).toEqual([novel, caret]);

    // a result in the open book selects its words
    await pane.locator('.hoard-search-group').nth(2).locator('.hoard-search-hit').click();
    expect(await page.evaluate(() => [book.id, getSelection().toString()])).toEqual([novel, 'harbour']);

    // one in another book opens it at the words
    await pane.locator('.hoard-search-group').nth(3).locator('.hoard-search-hit').click();
    await expect.poll(() => page.evaluate(() => book && book.id)).toBe(other);
    await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe('harbour');

    // the pages scope keeps a search to the two page folders; nothing found says where it looked
    await menu(app, 'Search Library…');
    await pane.locator('.hoard-search-scope').selectOption('pages');
    await expect.poll(() => groups(pane)).toEqual(['Wiki · 2', 'Sources · 1']);
    await pane.locator('.hoard-search-field').fill('kraken');
    await expect(pane.locator('.hoard-status')).toHaveText('Nothing in the wiki and sources has “kraken”.');
    await expect(pane.locator('.hoard-search-hit')).toHaveCount(0);

    // Enter goes to the first result
    await pane.locator('.hoard-search-scope').selectOption('book');
    await pane.locator('.hoard-search-field').fill('gull');
    await pane.locator('.hoard-search-field').press('Enter');
    await expect.poll(() => page.evaluate(() => getSelection().toString())).toBe('gull');
  } finally {
    await fixture.close();
  }
});
