import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Stage 5, the Pages tree in the wiki pane. Rules: a stored page (wiki/ or sources/) shows
// in the pane read-only, beside the open book, and its links reach pages by title, wiki
// first, then the Wiki book; Back and Forward walk Wiki book chapters and stored pages
// alike; from the tree the writer opens, makes, renames and moves pages, by pointer or by
// keyboard alone; and the focus stays in the manuscript unless the writer acts in the pane.

const CHAPTER = 'chapter-synthetic';
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

// A Wiki book of one chapter, "Vell".
async function openBeside(page) {
  await page.waitForFunction(() => !!window.hoard);
  const wikiId = await page.evaluate(async (chId) => {
    const meta = await neo.createBook({ title: 'Wiki', author: 'Test author' });
    meta.chapterOrder = [chId];
    meta.chapterTitles = { [chId]: 'Vell' };
    await neo.writeBookMeta(meta.id, meta);
    await neo.writeChapter(meta.id, chId, '<p data-block="v1">The town of Vell.</p>');
    return meta.id;
  }, CHAPTER);
  return { wikiId };
}

async function wikiJson(library, wikiId) {
  await mkdir(path.join(library, '.neo'), { recursive: true });
  await writeFile(path.join(library, '.neo', 'wiki.json'), JSON.stringify({ version: 1, bookId: wikiId }));
}

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

// Rule: a stored page shows read-only beside the book, marked where it is asked to be, with
// its links reaching pages by title (wiki first, then the Wiki book); the pane's edit and
// marks code see no chapter, so nothing can save into it; Back and Forward walk both kinds;
// and none of it takes the focus from the manuscript.
test('a stored page shows read-only in the pane, and the trail walks it and a chapter', async () => {
  const { profile, library } = await libraryProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    const { wikiId } = await openBeside(page);
    await wikiJson(library, wikiId);
    await seedBook(page, '<p>See [[Vell]] today.</p>');
    await page.evaluate(() => window.hoard.wiki.reindex());
    await caretInBook(page);
    const pane = page.locator('.hoard-wiki-pane');

    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/People/Ada Vell.html', { pIdx: 1, off: 4, len: 4 }));
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['Ada keeps the [[Harbour]] light.', 'She rows at dawn to [[Vell]].']);
    expect(await page.evaluate(() => [...(CSS.highlights.get('hoard-wiki-found') ?? [])].map((r) => r.toString()))).toEqual(['rows']);
    expect(await inManuscript(page)).toBe(true);
    expect(await page.evaluate(() => [window.hoard.wiki.pane.currentPage(), window.hoard.wiki.pane.shown(), window.hoard.paneMarks.state().page]))
      .toEqual(['wiki/People/Ada Vell.html', null, null]);
    await expect(pane.locator('.hoard-wiki-page')).toHaveAttribute('contenteditable', 'false');
    await expect(page.locator('.hoard-pane-marks')).toBeHidden();
    await expect(pane.getByRole('button', { name: 'Edit in Wiki Book' })).toBeDisabled();
    await expect(pane.locator('.hoard-wiki-status')).toHaveText(/^Read-only/);

    // typing on the page changes neither the page nor its file
    await pane.locator('.hoard-wiki-line').nth(1).click({ position: { x: 4, y: 4 } });
    await page.keyboard.type('zz');
    await page.keyboard.press('Enter');
    await expect(pane.locator('.hoard-wiki-line').nth(1)).toHaveText('She rows at dawn to [[Vell]].');
    expect(fileOf(library, 'wiki/People/Ada Vell.html')).toBe(PAGES['wiki/People/Ada Vell.html']);

    // a link reaches the wiki page over the source of the same title; one to the Wiki book's page still works
    await pane.getByRole('button', { name: '[[Harbour]]' }).click();
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The wiki harbour faces east.']);
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Harbour.html');
    await pane.getByRole('button', { name: '‹ Back' }).click();
    await pane.getByRole('button', { name: '[[Vell]]' }).click();
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The town of Vell.']);
    expect(await page.evaluate(() => [window.hoard.wiki.pane.currentPage(), window.hoard.wiki.pane.shown()?.chId])).toEqual([null, CHAPTER]);
    await expect(pane.locator('.hoard-wiki-page')).toHaveAttribute('contenteditable', 'true');

    // Back and Forward across the chapter and the stored page
    await pane.locator('.hoard-wiki-title').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Ada Vell');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/People/Ada Vell.html');
    await pane.getByRole('button', { name: 'Forward ›' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Vell');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe(null);

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
    // the pane's trail and the page shown follow the rename
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Quay');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Quay.html');

    // move: into a folder typed, made for it, inside the same tree
    await row('People').click();
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
