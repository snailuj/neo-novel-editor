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
