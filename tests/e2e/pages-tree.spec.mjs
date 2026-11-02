import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Stage 5, the Pages tree in the wiki pane. Rules: a stored page (wiki/ or sources/) shows
// in the pane read-only, beside the open book, and its links reach pages by title, wiki
// first; a link in the manuscript opens its page there; Back and Forward walk the trail;
// from the tree the writer opens, makes, renames and moves pages, by pointer or by
// keyboard alone; and the focus stays in the manuscript unless the writer acts in the pane.

const PAGES = {
  'wiki/People/Ada Vell.html': '<p data-block="a1">Ada keeps the [[Harbour]] light.</p><p data-block="a2">She rows at dawn to [[Vell]].</p>',
  'wiki/Harbour.html': '<p data-block="h1">The wiki harbour faces east.</p>',
  'sources/Harbour.html': '<p data-block="s1">The source harbour.</p>',
  'sources/Notes/Tides.html': '<p data-block="t1">High water at noon, says [[Ada Vell]], not [[Lost]].</p>',
};

async function libraryProfile() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(profile, 'userData'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  for (const [id, html] of Object.entries(PAGES)) {
    await mkdir(path.dirname(path.join(library, id)), { recursive: true });
    await writeFile(path.join(library, id), html);
  }
  return { profile, library };
}

const fileOf = (library, id) => readFileSync(path.join(library, ...id.split('/')), 'utf8');

// The side pane slides in, and a click aimed while it moves lands outside the window.
async function paneSettled(page) {
  await expect(page.locator('#side-pane')).toHaveClass(/\bopen\b/);
  await page.waitForFunction(() => {
    const pane = document.getElementById('side-pane');
    return pane.getAnimations().length === 0 && pane.getBoundingClientRect().right <= innerWidth + 0.5;
  });
}

const inManuscript = (page) => page.evaluate(() => !!document.activeElement?.closest('#chapters .chapter-body'));

async function caretInBook(page) {
  await page.evaluate(() => {
    const p = document.querySelector('#chapters .chapter-body p');
    p.closest('.chapter-body').focus();
    const range = document.createRange();
    range.setStart(p.firstChild, 2);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await expect.poll(() => inManuscript(page)).toBe(true);
}

// The words of the manuscript drawn with one of hoard's highlights.
const drawnText = (page, name) => page.evaluate((key) => [...(CSS.highlights.get(key) ?? [])].map((r) => r.toString()), `plugin-hoard-${name}`);

// Follow Link, as its Plugins menu item runs it.
const followLink = (page) => page.evaluate(() => NeoPlugins.runCommand('hoard', 'follow-link'));

// Where the words are in the manuscript: the caret put inside them, or their middle on screen.
const caretAt = (page, words) => page.evaluate((words) => {
  const p = [...document.querySelectorAll('#chapters .chapter-body p')].find((el) => el.textContent.includes(words));
  p.closest('.chapter-body').focus();
  const range = document.createRange();
  range.setStart(p.firstChild, p.textContent.indexOf(words) + 2);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}, words);
const middleOf = (page, words) => page.evaluate((words) => {
  const p = [...document.querySelectorAll('#chapters .chapter-body p')].find((el) => el.textContent.includes(words));
  const range = document.createRange();
  const at = p.textContent.indexOf(words);
  range.setStart(p.firstChild, at + 2);
  range.setEnd(p.firstChild, at + words.length - 2);
  const box = range.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}, words);

// Rule: a [[link]] in the manuscript is drawn as one when a stored page has its title, and
// as missing when none does; followed with Follow Link or Ctrl+click, it opens that page (a
// wiki page before a source, case aside) in the pane, and the writer's caret and book stay
// as they were; a link no page has is said so, and the pane stays where it was.
test('a link in the manuscript opens its stored page in the pane, the caret staying put', async () => {
  const { profile } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    const novel = await seedBook(page, '<p>Meet at the [[Harbour]] with [[ada vell]], not by [[Nowhere]].</p>');
    const pane = page.locator('.hoard-wiki-pane');
    await expect.poll(() => drawnText(page, 'wiki-link')).toEqual(['[[Harbour]]', '[[ada vell]]']);
    expect(await drawnText(page, 'wiki-missing')).toEqual(['[[Nowhere]]']);

    await caretAt(page, '[[Harbour]]');
    const before = await page.evaluate(() => captureCaret());
    await followLink(page);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The wiki harbour faces east.']);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Harbour.html');
    expect(await page.evaluate(() => [book.id, captureCaret()])).toEqual([novel, before]);
    expect(await inManuscript(page)).toBe(true);

    const { x, y } = await middleOf(page, '[[ada vell]]');
    await page.keyboard.down('Control');
    await page.mouse.click(x, y);
    await page.keyboard.up('Control');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/People/Ada Vell.html');
    expect(await page.evaluate(() => book.id)).toBe(novel);

    await caretAt(page, '[[Nowhere]]');
    await followLink(page);
    await expect(page.locator('.plugin-status', { hasText: 'Nowhere' })).toHaveText('No page is called “Nowhere”.');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
  } finally {
    await fixture.close();
  }
});

// Rule: a stored page shows read-only beside the book, marked where it is asked to be, with
// its links reaching pages by title only (wiki first); typing there changes nothing; Back
// and Forward walk the trail; and none of it takes the focus from the manuscript.
test('a stored page shows read-only in the pane, and the trail walks it', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    await caretInBook(page);
    const pane = page.locator('.hoard-wiki-pane');

    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/People/Ada Vell.html', { pIdx: 1, off: 4, len: 4 }));
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['Ada keeps the [[Harbour]] light.', 'She rows at dawn to [[Vell]].']);
    expect(await page.evaluate(() => [...(CSS.highlights.get('hoard-wiki-found') ?? [])].map((r) => r.toString()))).toEqual(['rows']);
    expect(await inManuscript(page)).toBe(true);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/People/Ada Vell.html');
    await expect(pane.locator('.hoard-wiki-status')).toHaveText(/^Read-only/);
    await expect(pane.locator('.hoard-wiki-missing')).toHaveText('[[Vell]]');

    // typing on the page changes neither the page nor its file
    await pane.locator('.hoard-wiki-line').nth(1).click({ position: { x: 4, y: 4 } });
    await page.keyboard.type('zz');
    await page.keyboard.press('Enter');
    await expect(pane.locator('.hoard-wiki-line').nth(1)).toHaveText('She rows at dawn to [[Vell]].');
    expect(fileOf(library, 'wiki/People/Ada Vell.html')).toBe(PAGES['wiki/People/Ada Vell.html']);

    // a link reaches the wiki page over the source of the same title
    await pane.getByRole('button', { name: '[[Harbour]]' }).click();
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The wiki harbour faces east.']);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Harbour.html');

    // Back and Forward, from the keyboard
    await pane.locator('.hoard-wiki-title').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/People/Ada Vell.html');
    await page.keyboard.press('Alt+ArrowRight');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Harbour.html');

    // a stored page no longer there says so
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Gone.html'));
    await expect(pane.locator('.hoard-wiki-status')).toHaveText(/no longer there/);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe(null);
  } finally {
    await fixture.close();
  }
});

const rowNames = (tree) => tree.locator('.hoard-tree-name').allTextContents();

// Rule: the tree is worked by keyboard alone: the Pages button unfolds it, Tab reaches the
// rows, arrows walk and open folders, Enter opens a page in the pane with the focus left on
// its row, F2 opens Rename and Esc puts the focus back; a click opens a page too; and
// nothing the tree does on its own (reading the list, the pane showing a page) takes the
// focus from the manuscript.
test('the tree opens pages by keyboard alone and by pointer, and leaves the focus where the writer is', async () => {
  const { profile } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    await caretInBook(page);
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    const fold = tree.getByRole('button', { name: 'Pages' });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await expect(tree.locator('.hoard-tree-list')).toBeHidden();

    // reading the list and showing a page from code leave the caret in the book
    await page.evaluate(() => window.hoard.wiki.pane.tree.refresh());
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');
    expect(await inManuscript(page)).toBe(true);

    await fold.focus();
    await page.keyboard.press('Enter');
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    expect(await rowNames(tree)).toEqual(['wiki', 'People', 'Harbour', 'sources', 'Notes', 'Harbour']);
    await expect(tree.getByRole('button', { name: 'New page' })).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const row = (name, n = 0) => tree.locator('.hoard-tree-name', { hasText: new RegExp(`^${name}`) }).nth(n);
    await expect(row('wiki')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row('People')).toBeFocused();
    await expect(row('People')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');
    await expect(row('People')).toHaveAttribute('aria-expanded', 'true');
    expect(await rowNames(tree)).toEqual(['wiki', 'People', 'Ada Vell', 'Harbour', 'sources', 'Notes', 'Harbour']);
    await page.keyboard.press('ArrowRight');
    await expect(row('Ada Vell')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
    await expect(row('Ada Vell')).toBeFocused();
    await expect(row('Ada Vell')).toHaveAttribute('aria-current', 'page');

    // Rename opens on F2 and Esc gives the focus back to the row
    await page.keyboard.press('F2');
    const field = tree.getByLabel('New title for “Ada Vell”');
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('Ada Vell');
    await page.keyboard.press('Escape');
    await expect(field).toHaveCount(0);
    await expect(row('Ada Vell')).toBeFocused();

    // the row's own actions follow it in the Tab order
    await page.keyboard.press('Tab');
    await expect(tree.getByRole('button', { name: 'Rename Ada Vell' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('ArrowLeft');
    await expect(row('People')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(row('People')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('End');
    await expect(row('Harbour', 1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(row('wiki')).toBeFocused();
    // Alt+Left still walks the trail from the tree
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');

    // a click opens the source page of the same title as a wiki page
    await row('Harbour', 1).click();
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The source harbour.']);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('sources/Harbour.html');
    await expect(row('Harbour', 1)).toHaveAttribute('aria-current', 'page');
    await expect(tree.locator('[aria-current]')).toHaveCount(1);
  } finally {
    await fixture.close();
  }
});

// Rule: from the tree a writer makes a page in the folder they are in, renames a page so
// that every [[link]] to it follows (the open book's chapter too, and the pane's trail),
// and moves a page to another folder of its tree; what the store would refuse is said next
// to the field, in words, and what was typed stays.
test('new page, rename and move from the tree, with refusals next to the field', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>Meet at the [[Harbour]] at noon.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    const row = (name, n = 0) => tree.locator('.hoard-tree-name', { hasText: new RegExp(`^${name}`) }).nth(n);
    // the error a field names first among the texts that describe it
    const errorOf = async (field) => page.locator(`#${(await field.getAttribute('aria-describedby')).split(' ')[0]}`);
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await tree.getByRole('button', { name: 'Pages' }).click();
    await row('Harbour').click();
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The wiki harbour faces east.']);
    await expect(pane.locator('.hoard-wiki-where')).toHaveText('wiki');
    // a page linking to it is shown while it is renamed
    await row('People').click();
    await row('Ada Vell').click();
    await expect(pane.locator('.hoard-wiki-where')).toHaveText('wiki / People');

    // rename: a title the other tree holds is refused next to the field, and the value stays
    await row('Harbour').hover();
    await tree.getByRole('button', { name: 'Rename Harbour' }).first().click();
    const field = tree.getByLabel('New title for “Harbour”');
    await field.fill('Tides');
    await field.press('Enter');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    const error = await errorOf(field);
    await expect(error).toHaveText(/^There is already a page called “Tides” in sources\/Notes\./);
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(field).toHaveValue('Tides');
    await expect(field).toBeFocused();
    await field.fill('Quay');
    await expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await field.press('Enter');
    await expect(row('Quay')).toBeFocused();
    await expect(tree.locator('.hoard-tree-status')).toHaveText(/^Renamed “Harbour” to “Quay”\./);
    expect(fileOf(library, 'wiki/Quay.html')).toBe(PAGES['wiki/Harbour.html']);
    expect(fileOf(library, 'wiki/People/Ada Vell.html')).toContain('[[Quay]]');
    await expect.poll(() => page.evaluate(() => document.querySelector('#chapters .chapter-body p').textContent)).toBe('Meet at the [[Quay]] at noon.');
    await expect.poll(() => drawnText(page, 'wiki-link')).toEqual(['[[Quay]]']);
    // the page shown is read again, its link reaching the page by its new title, and the
    // trail follows the rename
    await expect(pane.getByRole('button', { name: '[[Quay]]' })).toBeVisible();
    await pane.getByRole('button', { name: '‹ Back' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Quay');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Quay.html');

    // move: into a folder typed, made for it, inside the same tree
    await row('Ada Vell').hover();
    await tree.getByRole('button', { name: 'Move Ada Vell' }).click();
    const folder = tree.getByLabel('Folder in wiki to move “Ada Vell” to');
    await expect(folder).toHaveValue('People');
    await folder.fill('../Out');
    await folder.press('Enter');
    await expect(folder).toHaveAttribute('aria-invalid', 'true');
    await expect(await errorOf(folder)).toHaveText(/^A folder name can't/);
    await folder.fill('Places/Coast');
    await folder.press('Enter');
    await expect(row('Ada Vell')).toBeFocused();
    expect(fileOf(library, 'wiki/Places/Coast/Ada Vell.html')).toContain('Ada keeps');
    // People held only that page, and a folder with no pages is not listed
    expect(await page.evaluate(() => [...document.querySelectorAll('.hoard-tree-name')].map((b) => b.textContent))).toEqual(
      ['wiki', 'Places', 'Coast', 'Ada Vell', 'Quay', 'sources', 'Notes', 'Harbour'],
    );

    // new page: in the folder of the row the writer is on; a title taken is refused
    await tree.getByRole('button', { name: 'New page' }).click();
    const title = tree.getByLabel('Title of the new page in wiki/Places/Coast');
    await expect(title).toBeFocused();
    await title.fill('quay');
    await title.press('Enter');
    await expect(await errorOf(title)).toHaveText('There is already a page called “Quay” in wiki. Pick another title.');
    await expect(title).toHaveValue('quay');
    await title.fill('Pier');
    await tree.getByRole('button', { name: 'Make page' }).click();
    await expect(row('Pier')).toBeFocused();
    expect(fileOf(library, 'wiki/Places/Coast/Pier.html')).toMatch(/^<p data-block="[0-9a-f]{6}"><br><\/p>$/);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Pier');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Places/Coast/Pier.html');
  } finally {
    await fixture.close();
  }
});

// Rule: when the library changed on disk after the tree read it, the store's refusal is
// said in plain words from the list read again: a file now holding the title is "taken",
// next to the field with the value kept; a page removed is "missing", and its row and its
// field go, with the focus on the folder that held it.
test('a rename the library changed under is refused in words, from the list read again', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    const row = (name, n = 0) => tree.locator('.hoard-tree-name', { hasText: new RegExp(`^${name}`) }).nth(n);
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await tree.getByRole('button', { name: 'Pages' }).click();
    await row('People').click();
    await expect(row('Ada Vell')).toBeVisible();

    // taken: a file came in under the new title after the list was read
    await writeFile(path.join(library, 'wiki', 'Quay.html'), '<p data-block="q1">A quay.</p>');
    await row('Harbour').hover();
    await tree.getByRole('button', { name: 'Rename Harbour' }).first().click();
    const field = tree.getByLabel('New title for “Harbour”');
    await field.fill('Quay');
    await field.press('Enter');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#hoard-tree-error')).toHaveText('There is already a page called “Quay” in wiki. Pick another title.');
    await expect(field).toHaveValue('Quay');
    await expect(field).toBeFocused();
    expect(existsSync(path.join(library, 'wiki', 'Harbour.html'))).toBe(true);
    await expect(row('Quay')).toBeVisible();
    await field.press('Escape');

    // missing: the page was removed after the list was read
    await rm(path.join(library, 'wiki', 'People', 'Ada Vell.html'));
    await row('Ada Vell').hover();
    await tree.getByRole('button', { name: 'Rename Ada Vell' }).click();
    const gone = tree.getByLabel('New title for “Ada Vell”');
    await gone.fill('Ada Brook');
    await gone.press('Enter');
    await expect(tree.locator('.hoard-tree-alert')).toHaveText('“Ada Vell” is no longer there, so nothing was changed. It may have been moved or removed outside NEO. Look for it in the list, which now shows the pages as they are.');
    await expect(gone).toHaveCount(0);
    await expect(row('Ada Vell')).toHaveCount(0);
    // People held only that page, so its folder went too and the focus is on wiki
    await expect(row('People')).toHaveCount(0);
    await expect(row('wiki')).toBeFocused();
    expect(existsSync(path.join(library, 'wiki', 'People', 'Ada Brook.html'))).toBe(false);
  } finally {
    await fixture.close();
  }
});

// Rule: a stored page's links reach pages as the library is now: the list is read again
// for each stored page drawn, and a link finds its page when it is followed, so a page
// made, moved or removed outside the tree since is reached, or said to be gone.
test('a stored page\'s links follow the library as it is when drawn and when followed', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await expect(pane.locator('.hoard-wiki-missing')).toHaveText('[[Lost]]');

    // a page made outside the tree is reached once the page is drawn again
    await writeFile(path.join(library, 'wiki', 'Lost.html'), '<p data-block="l1">Found again.</p>');
    await page.evaluate(() => window.hoard.wiki.pane.reload());
    await expect(pane.getByRole('button', { name: '[[Lost]]' })).toBeVisible();

    // a page moved outside the tree after the page was drawn is found when its link is followed
    await mkdir(path.join(library, 'wiki', 'Archive'), { recursive: true });
    await rename(path.join(library, 'wiki', 'People', 'Ada Vell.html'), path.join(library, 'wiki', 'Archive', 'Ada Vell.html'));
    await pane.getByRole('button', { name: '[[Ada Vell]]' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Archive/Ada Vell.html');

    // one removed since is said to be gone, and the pane stays where it was
    await pane.getByRole('button', { name: '‹ Back' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');
    await rm(path.join(library, 'wiki', 'Archive', 'Ada Vell.html'));
    await pane.getByRole('button', { name: '[[Ada Vell]]' }).click();
    await expect(pane.locator('.hoard-wiki-status')).toHaveText('No page is called “Ada Vell” now. It may have been renamed or removed outside NEO.');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');
  } finally {
    await fixture.close();
  }
});

// Holds the replies to the window's calls on the named channels in the main process, each
// until let through in turn, by wrapping the plugin invoke handler (Electron keeps handlers
// in ipcMain's own map). The answer is worked out when asked for, so a reply held is as old
// as its call.
async function hold(app, channels) {
  await app.evaluate(({ ipcMain }, channels) => {
    const handlers = ipcMain._invokeHandlers;
    const real = (globalThis.__real ??= handlers.get('plugin:invoke'));
    globalThis.__holding = channels;
    globalThis.__waiting = [];
    globalThis.__answered = 0;
    handlers.set('plugin:invoke', async (e, id, channel, payload) => {
      const out = real(e, id, channel, payload);
      if (!globalThis.__holding.includes(channel)) return out;
      const held = { channel, ready: false };
      globalThis.__waiting.push(held);
      const gate = new Promise((resolve) => { held.resolve = resolve; });
      await out.catch(() => {});
      held.ready = true;
      const fail = await gate;
      globalThis.__answered++;
      if (fail) throw new Error('the disk could not be read');
      return out;
    });
  }, channels);
}

// Done once n replies on a channel are worked out and held.
async function heldOn(app, channel, n = 1) {
  await expect.poll(() => app.evaluate((_, channel) => globalThis.__waiting.filter((w) => w.channel === channel && w.ready).length, channel)).toBeGreaterThanOrEqual(n);
}

// The oldest (or newest) reply held on a channel let through, once one is worked out; with
// fail, an error in its place.
async function letThrough(app, channel, newest = false, fail = false) {
  await heldOn(app, channel);
  const before = await app.evaluate((_, [channel, newest, fail]) => {
    const at = globalThis.__waiting.map((w) => w.channel)[newest ? 'lastIndexOf' : 'indexOf'](channel);
    globalThis.__waiting.splice(at, 1)[0].resolve(fail);
    return globalThis.__answered;
  }, [channel, newest, fail]);
  await expect.poll(() => app.evaluate(() => globalThis.__answered)).toBeGreaterThan(before);
}

// Every reply held let through, and none held from now on.
async function letAllThrough(app) {
  await app.evaluate(() => {
    globalThis.__holding = [];
    for (const w of globalThis.__waiting.splice(0)) w.resolve(false);
  });
}

// Rule: a link followed from a stored page leads nowhere if the writer moved on (Back,
// another link) while the list was read: the newer navigation stands and the trail gains
// no stop.
test('a link followed while the writer moves on does not take the pane back', async () => {
  const { profile } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/Harbour.html'));
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');

    await hold(app, ['pages.list']);
    await pane.getByRole('button', { name: '[[Ada Vell]]' }).click();
    await pane.getByRole('button', { name: '‹ Back' }).click();
    await letAllThrough(app);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    await page.waitForTimeout(300);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Harbour.html');
    await pane.getByRole('button', { name: 'Forward ›' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');
  } finally {
    await fixture.close();
  }
});

// Rule: of two links followed while the list is read for them, the one clicked last is the
// page shown, whichever reply comes first, and the trail gains only its stop.
test('the link clicked last is the page shown', async () => {
  const { profile, library } = await libraryProfile();
  await writeFile(path.join(library, 'wiki', 'Hub.html'), '<p data-block="u1">See [[Harbour]] and [[Tides]].</p>');
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/Hub.html'));
    await paneSettled(page);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Hub');

    await hold(app, ['pages.list']);
    await pane.getByRole('button', { name: '[[Harbour]]' }).click();
    await pane.getByRole('button', { name: '[[Tides]]' }).click();
    await letThrough(app, 'pages.list');
    await letThrough(app, 'pages.list');
    await letAllThrough(app);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('sources/Notes/Tides.html');
    await pane.getByRole('button', { name: '‹ Back' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Hub');
  } finally {
    await fixture.close();
  }
});

// Rule: a page made from the tree opens in the pane only if the writer has not gone to
// another page while it was made; the page they went to stays.
test('a page made while the writer reads another leaves the pane where they went', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await tree.getByRole('button', { name: 'Pages' }).click();
    await tree.getByRole('button', { name: 'New page' }).click();
    const field = tree.getByLabel('Title of the new page in wiki');
    await field.fill('Bea Lund');
    await hold(app, ['pages.create']);
    await field.press('Enter');
    await tree.locator('.hoard-tree-name[data-key="wiki/Harbour.html"]').click();
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The wiki harbour faces east.']);
    await letAllThrough(app);
    await expect(tree.locator('.hoard-tree-status')).toHaveText('Made the page “Bea Lund” in wiki.');
    expect(existsSync(path.join(library, 'wiki', 'Bea Lund.html'))).toBe(true);
    await page.waitForTimeout(300);
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The wiki harbour faces east.']);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Harbour.html');
  } finally {
    await fixture.close();
  }
});

// Rule: a stored page's links are drawn against the list read for that showing, so a list
// read earlier that answers later (the tree's, say) never decides them.
test('a list read earlier that answers later does not decide a page\'s links', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await expect(pane.locator('.hoard-wiki-missing')).toHaveText('[[Lost]]');

    await hold(app, ['pages.list', 'pages.read']);
    await tree.getByRole('button', { name: 'Pages' }).click();
    await heldOn(app, 'pages.list');
    await writeFile(path.join(library, 'wiki', 'Lost.html'), '<p data-block="l1">Found again.</p>');
    await page.evaluate(() => { window.hoard.wiki.pane.reload(); });
    await heldOn(app, 'pages.list', 2);
    await letThrough(app, 'pages.list', true);
    await heldOn(app, 'pages.read');
    await letThrough(app, 'pages.list');
    await expect(tree.locator('.hoard-tree-name[data-key="wiki/Harbour.html"]')).toBeVisible();
    await letAllThrough(app);
    await expect(pane.getByRole('button', { name: '[[Lost]]' })).toBeVisible();
  } finally {
    await fixture.close();
  }
});

// Rule: every key typed in the row editor lands in its field: the field keeps the focus
// while it is typed in, for a rename and for a new page alike.
test('typing in the field keeps the focus there, key after key', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await tree.getByRole('button', { name: 'Pages' }).click();
    await tree.locator('.hoard-tree-name[data-key="wiki/Harbour.html"]').focus();
    await page.keyboard.press('F2');
    const rename = tree.getByLabel('New title for “Harbour”');
    await expect(rename).toBeFocused();
    await page.keyboard.type('Quay');
    await expect(rename).toHaveValue('Quay');
    await expect(rename).toBeFocused();
    await page.keyboard.press('Escape');

    await tree.getByRole('button', { name: 'New page' }).click();
    const made = tree.getByLabel('Title of the new page in wiki');
    await expect(made).toBeFocused();
    await page.keyboard.type('Bea Lund');
    await expect(made).toHaveValue('Bea Lund');
    await page.keyboard.press('Enter');
    await expect(tree.locator('.hoard-tree-status')).toHaveText('Made the page “Bea Lund” in wiki.');
    expect(existsSync(path.join(library, 'wiki', 'Bea Lund.html'))).toBe(true);
  } finally {
    await fixture.close();
  }
});

// Rule: a new page's field never hangs on a folder that is gone: when the list read again
// lacks its folder, the field moves to the nearest folder still there, keeps the title
// typed, says so, and still makes the page.
test('a new page whose folder is removed outside NEO moves up, title kept', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await tree.getByRole('button', { name: 'Pages' }).click();
    await tree.locator('.hoard-tree-name[data-key="wiki/People"]').click();
    await tree.getByRole('button', { name: 'New page' }).click();
    await tree.getByLabel('Title of the new page in wiki/People').fill('Bea Lund');

    // the list read again while the writer is in the field (a book opened, say)
    await rm(path.join(library, 'wiki', 'People'), { recursive: true });
    await page.evaluate(() => window.hoard.wiki.pane.tree.refresh());
    const field = tree.getByLabel('Title of the new page in wiki', { exact: true });
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('Bea Lund');
    await expect(field).toBeFocused();
    await expect(tree.locator('.hoard-tree-status')).toHaveText('The folder wiki/People is no longer there. It may have been moved or removed outside NEO. The new page will go in wiki.');
    await expect(tree.locator('.hoard-tree-editor')).toHaveCount(1);
    await field.press('Enter');
    await expect(tree.locator('.hoard-tree-status')).toHaveText('Made the page “Bea Lund” in wiki.');
    expect(existsSync(path.join(library, 'wiki', 'Bea Lund.html'))).toBe(true);
  } finally {
    await fixture.close();
  }
});

// Rule: after a change, the tree puts the focus on the page's row only if the writer is
// still in the pane once the list is back; a writer gone back to the book stays there.
test('a writer back in the book while the list is read again keeps the focus there', async () => {
  const { profile } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    const tree = pane.locator('.hoard-tree');
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await tree.getByRole('button', { name: 'Pages' }).click();
    await tree.locator('.hoard-tree-name[data-key="wiki/Harbour.html"]').focus();
    await page.keyboard.press('F2');
    await page.keyboard.type('Quay');
    await hold(app, ['pages.list']);
    await page.keyboard.press('Enter');
    await heldOn(app, 'pages.list');
    await caretInBook(page);
    await letAllThrough(app);
    await expect(tree.locator('.hoard-tree-status')).toHaveText(/^Renamed “Harbour” to “Quay”\./);
    await page.waitForTimeout(300);
    expect(await inManuscript(page)).toBe(true);
  } finally {
    await fixture.close();
  }
});

// Rule: a page shown after a slow read takes the focus to its title only if the writer is
// still in the pane; a writer gone back to the book stays there.
test('a page read slowly does not take the writer out of the book', async () => {
  const { profile } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/Harbour.html'));
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');

    await pane.getByRole('button', { name: '‹ Back' }).focus();
    await hold(app, ['pages.list']);
    await page.keyboard.press('Enter');
    await heldOn(app, 'pages.list');
    await caretInBook(page);
    await letAllThrough(app);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    await page.waitForTimeout(300);
    expect(await inManuscript(page)).toBe(true);

    // still in the pane, the writer is taken to the title of the page shown
    await pane.getByRole('button', { name: 'Forward ›' }).focus();
    await page.keyboard.press('Enter');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');
    await expect(pane.locator('.hoard-wiki-title')).toBeFocused();
  } finally {
    await fixture.close();
  }
});

// Rule: a link the writer has gone on from says nothing: if the list read for it fails
// after they went back, the page they went to shows no error about it.
test('a link left behind that fails to read says nothing on the page gone to', async () => {
  const { profile } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>A line of the book.</p>');
    const pane = page.locator('.hoard-wiki-pane');
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/Harbour.html'));
    await page.evaluate(() => window.hoard.wiki.pane.open('sources/Notes/Tides.html'));
    await paneSettled(page);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');

    await hold(app, ['pages.list']);
    await pane.getByRole('button', { name: '[[Ada Vell]]' }).click();
    await pane.getByRole('button', { name: '‹ Back' }).click();
    await heldOn(app, 'pages.list', 2);
    await letThrough(app, 'pages.list', true);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    const shownSays = await pane.locator('.hoard-wiki-status').textContent();
    await letThrough(app, 'pages.list', false, true);
    await page.waitForTimeout(300);
    await expect(pane.locator('.hoard-wiki-status')).toHaveText(shownSays);
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');

    // the link the writer is still waiting on says so
    await letAllThrough(app);
    await pane.getByRole('button', { name: 'Forward ›' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tides');
    await hold(app, ['pages.list']);
    await pane.getByRole('button', { name: '[[Ada Vell]]' }).click();
    await letThrough(app, 'pages.list', false, true);
    await expect(pane.locator('.hoard-wiki-status')).toHaveText(/^The link could not be followed: .*the disk could not be read\. Try again\.$/);
  } finally {
    await fixture.close();
  }
});
