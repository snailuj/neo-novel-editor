import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile } from '../support/electron-profile.mjs';

// Step 7, Librarian-Watches-Edits: "the librarian flags a forgotten reference in a
// chapter". Rules: a wiki page named in new writing gets one librarian comment on the
// name once the writer has left the chapter, never while they are still in it; its link
// shows the page in the Wiki section; the same page named again in that chapter gets no
// second comment; a typed [[link]] is not a forgotten reference; and Stop Flagging This
// Page resolves the comment and quiets the page in every chapter.

async function profileWithVault() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(profile, 'vault'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  const kraken = path.join(profile, 'vault', 'Kraken.md');
  await writeFile(kraken, '---\naliases: [the Deep One]\n---\nIt lives below the harbour.\n');
  const harbour = path.join(profile, 'vault', 'Harbour.md');
  await writeFile(harbour, 'The old wall faces east.\n');
  return { profile, library, files: [kraken, harbour] };
}

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

async function answer(app, files) {
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    dialog.showMessageBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      return { response: o.buttons && o.buttons[0].startsWith('Import') ? 0 : 1, checkboxChecked: false };
    };
  }, files);
}

// A book of two chapters, opened.
async function twoChapters(page) {
  return page.evaluate(async () => {
    const meta = await neo.createBook({ title: 'Novel', author: 'Test author' });
    meta.chapterOrder = ['c1', 'c2'];
    await neo.writeBookMeta(meta.id, meta);
    await neo.writeChapter(meta.id, 'c1', '<p>The tide went out.</p>');
    await neo.writeChapter(meta.id, 'c2', '<p>Morning came.</p>');
    const lib = await neo.readLibrary();
    lib.shelves[0].bookIds.push(meta.id);
    await neo.writeLibrary(lib);
    await openBook(meta.id);
    return meta.id;
  });
}

test('a page named in new writing is flagged once the writer leaves the chapter, once, and not after Stop Flagging', async () => {
  const { profile, library, files } = await profileWithVault();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await answer(app, files);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => page.evaluate(() => window.hoard.wiki.pages()?.pages.length ?? 0)).toBe(2);
    const bookId = await twoChapters(page);
    const chapter = (chId) => readFile(path.join(library, bookId, 'chapters', `${chId}.html`), 'utf8');
    const librarians = (chId) => page.evaluate((chId) => (window.hoard.marks.state().marks[chId] ?? [])
      .filter((m) => m.created.who === 'librarian').map((m) => [m.anchor.exact, m.state, m.thread[0].body]), chId);
    // types at the end of a chapter's paragraph and waits for the save to land
    const write = async (n, words) => {
      await page.locator('.chapter-body p').nth(n).click();
      await page.keyboard.press('End');
      await page.keyboard.insertText(words);
      await expect.poll(() => chapter(n === 0 ? 'c1' : 'c2'), { timeout: 10_000 }).toContain(words.trim());
    };
    const settled = () => page.evaluate(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await window.hoard.companion.settled();
    });

    // nothing while the writer is still in the chapter
    await write(0, ' Then the kraken rose.');
    await settled();
    expect(await librarians('c1')).toEqual([]);

    // leaving it: one comment, on the name, linking the page
    await page.locator('.chapter-body p').nth(1).click();
    await expect.poll(() => librarians('c1')).toEqual([
      ['kraken', 'open', '[[kraken]]: matched as a bare name in your prose (a guess, not a link you typed).'],
    ]);
    const sidecar = JSON.parse(await readFile(path.join(library, '.neo', bookId, 'chapters', 'c1.json'), 'utf8'));
    expect(sidecar.marks.map((m) => m.created.who)).toEqual(['librarian']);

    // its link shows the page beside the book, and the writer stays where they were
    await page.locator('.chapter-body p').nth(0).click();
    await page.evaluate(() => window.hoard.marks.show());
    const card = page.locator('.hoard-mark');
    await expect(card.locator('.hoard-who')).toContainText('Librarian');
    await card.locator('.hoard-body .hoard-wiki-link').click();
    await expect(page.locator('.hoard-wiki-pane .hoard-wiki-title')).toHaveText('Kraken');
    expect(await page.evaluate(() => book.id)).toBe(bookId);

    // the same page again in that chapter, and a typed link in the other: nothing new
    await write(0, ' The Deep One sank.');
    await write(1, ' Rain over [[Harbour]].');
    await page.locator('.chapter-body p').nth(0).click();
    await settled();
    expect((await librarians('c1')).length).toBe(1);
    expect(await librarians('c2')).toEqual([]);

    // Stop Flagging This Page, on the comment picked in the Comments section
    await page.evaluate(() => window.hoard.marks.show());
    await card.locator('.hoard-quote').click();
    await menu(app, 'Stop Flagging This Page');
    await expect.poll(() => librarians('c1').then((l) => l.map(([, state]) => state))).toEqual(['resolved']);
    const quiet = JSON.parse(await readFile(path.join(library, '.neo', 'companion.json'), 'utf8'));
    expect(Object.values(quiet.quiet).map((q) => q.title)).toEqual(['Kraken']);
    await write(1, ' The kraken, again.');
    await page.locator('.chapter-body p').nth(0).click();
    await settled();
    expect(await librarians('c2')).toEqual([]);
  } finally {
    await fixture.close();
  }
});
