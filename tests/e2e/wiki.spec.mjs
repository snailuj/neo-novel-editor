import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Step 5, Wiki-Moves-Into-Neo. Rules: Markdown pages picked in the file picker come into
// one wiki book, each page a chapter titled with its file's name, its words as written
// and its CriticMarkup comments as comments; the import is committed; the wiki opens
// from the Plugins menu or after the import, set flush left with no drop cap, which
// comes back on leaving it; [[links]] are drawn in any book and followed into the wiki;
// importing the same files again changes nothing; and nothing is imported while the
// wiki is open.

const HARBOUR = '---\ntype: lore\n---\nThe {==harbour wall==}{>>Which side?<<} faces east.\nSee [[Tide Tables]].\n';
const TIDES = '# Tide Tables\n\nHigh water at the [[Harbour|harbour]].\n- [[Nowhere]]\n';

async function trackedProfile() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  const vault = path.join(profile, 'vault');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(vault, 'lore'), { recursive: true });
  await mkdir(path.join(profile, 'userData'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  await writeFile(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ plugins: { hoard: { git: { idleSeconds: 1 } } } }));
  await writeFile(path.join(profile, '.gitconfig'), '[user]\n\tname = Ada Author\n\temail = ada@example.com\n');
  execFileSync('git', ['init', '-q'], { cwd: library });
  const files = [path.join(vault, 'lore', 'Harbour.md'), path.join(vault, 'lore', 'Tide Tables.md')];
  await writeFile(files[0], HARBOUR);
  await writeFile(files[1], TIDES);
  return { profile, library, files };
}

const git = (library, ...args) => execFileSync('git', args, {
  cwd: library, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});
const drawnText = (page, name) => page.evaluate((key) => [...(CSS.highlights.get(key) ?? [])].map((r) => r.toString()), `plugin-hoard-${name}`);

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

// The file picker answers with `files`, and every message box with its first button,
// each box written down for the test to read.
async function answer(app, files) {
  await app.evaluate(({ dialog }, files) => {
    globalThis.__boxes = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    dialog.showMessageBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      globalThis.__boxes.push({ message: o.message, detail: o.detail ?? '', buttons: o.buttons ?? [] });
      return { response: 0, checkboxChecked: false };
    };
  }, files);
}
const boxes = (app) => app.evaluate(() => globalThis.__boxes);

// The caret inside the paragraph holding `words`, `into` units after where they start.
async function caretIn(page, words, into = 2) {
  await page.evaluate(({ words, into }) => {
    const p = [...document.querySelectorAll('.chapter-body p')].find((el) => el.textContent.includes(words));
    const node = p.firstChild;
    p.closest('.chapter-body').focus();
    const range = document.createRange();
    range.setStart(node, node.textContent.indexOf(words) + into);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, { words, into });
  await page.waitForTimeout(100);
}

test('picked pages come into the wiki, open in NEO, and their links are followed', async () => {
  const { profile, library, files } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');
    const novel = await seedBook(page, '<p>Meet me at the [[Harbour]] at noon.</p>');
    const dropcapBefore = await page.evaluate(() => document.body.classList.contains('no-dropcap'));

    await answer(app, files);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => page.evaluate(() => book && book.title)).toBe('Wiki');
    const told = await boxes(app);
    expect(told.map((b) => b.message)).toEqual(['Import 2 pages into the wiki?', '2 pages are in the wiki.']);
    expect(told[0].detail).toContain('Coming in: Harbour, Tide Tables.');
    expect(told[1].buttons).toEqual(['Open Wiki Book', 'Close']);

    const wiki = await page.evaluate(() => ({ id: book.id, order: book.chapterOrder, titles: book.chapterTitles, kinds: book.chapterKinds }));
    const [harbour, tides] = wiki.order;
    expect([wiki.titles[harbour], wiki.titles[tides]]).toEqual(['Harbour', 'Tide Tables']);
    expect(wiki.kinds[harbour]).toBe('unnumbered');
    // the page is NEO's HTML: each block a paragraph with its class and its own id
    expect(await page.evaluate((id) => [...document.querySelectorAll(`.chapter[data-id="${id}"] .chapter-body p`)]
      .map((p) => [p.className, p.textContent, /^[0-9a-f]{6}$/.test(p.dataset.block ?? '')]), tides))
      .toEqual([['wiki-h1', 'Tide Tables', true], ['', 'High water at the [[Harbour|harbour]].', true], ['wiki-li', '[[Nowhere]]', true]]);
    expect(await page.evaluate(() => [document.body.hasAttribute('data-hoard-wiki'), document.body.classList.contains('no-dropcap')])).toEqual([true, true]);

    // the comment came in on its words, and the import is the librarian's commit
    await expect.poll(() => drawnText(page, 'comment')).toEqual(['harbour wall']);
    expect(git(library, 'log', '--format=%s|%an')).toContain('Pages imported to the wiki|Librarian');
    const sidecar = JSON.parse(readFileSync(path.join(library, '.neo', wiki.id, 'chapters', `${harbour}.json`), 'utf8'));
    expect(sidecar.marks.map((m) => [m.kind, m.thread[0].body])).toEqual([['comment', 'Which side?']]);

    // links: one to a page, one to none
    await expect.poll(() => drawnText(page, 'wiki-link')).toEqual(['[[Tide Tables]]', '[[Harbour|harbour]]']);
    expect(await drawnText(page, 'wiki-missing')).toEqual(['[[Nowhere]]']);
    await caretIn(page, '[[Harbour|harbour]]');
    await menu(app, 'Follow Link');
    await expect.poll(() => page.evaluate(() => window.hoard && captureCaret()?.chId)).toBe(harbour);

    // nothing is imported while the wiki is open
    const owl = path.join(path.dirname(files[0]), 'Owl.md');
    await writeFile(owl, 'A new page.\n');
    await answer(app, [owl]);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => boxes(app).then((b) => b.map((x) => x.message))).toEqual(['The wiki is open, so nothing was imported.']);

    // leaving the wiki puts the drop cap back as it was; the wiki remembers the caret on
    // another page than the one followed to below
    await caretIn(page, '[[Nowhere]]');
    await page.evaluate(() => backToShelf());
    expect(await page.evaluate(() => [document.body.hasAttribute('data-hoard-wiki'), document.body.classList.contains('no-dropcap')])).toEqual([false, dropcapBefore]);

    // the same files again change nothing
    await answer(app, files);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => boxes(app).then((b) => b.map((x) => x.message))).toEqual(['Every page picked is already in the wiki, or cannot come in.']);
    expect(JSON.parse(readFileSync(path.join(library, wiki.id, 'book.json'), 'utf8')).chapterOrder).toEqual(wiki.order);
    expect(git(library, 'status', '--porcelain', '--', '.neo')).toBe('');

    // a link in a manuscript is drawn and its page shown in the wiki pane beside the
    // book, the caret staying where the writer was
    await page.evaluate((id) => openBook(id), novel);
    await expect.poll(() => drawnText(page, 'wiki-link')).toEqual(['[[Harbour]]']);
    await caretIn(page, '[[Harbour]]');
    const before = await page.evaluate(() => captureCaret());
    await menu(app, 'Follow Link');
    const pane = page.locator('.hoard-wiki-pane');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    await expect(pane).toBeVisible();
    await expect(pane.locator('.hoard-wiki-line')).toHaveText(['The harbour wall faces east.', 'See [[Tide Tables]].']);
    expect(await page.evaluate(() => [book.id, captureCaret()])).toEqual([novel, before]);

    // links in the pane move it along, and Back and Forward walk the trail
    await pane.getByRole('button', { name: '[[Tide Tables]]' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tide Tables');
    await expect(pane.locator('.hoard-wiki-missing')).toHaveText('[[Nowhere]]');
    await pane.getByRole('button', { name: '‹ Back' }).click();
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    // from the keyboard: Forward is disabled at the end of the trail, and the focus
    // goes to the page's title rather than out of the pane
    await pane.getByRole('button', { name: 'Forward ›' }).focus();
    await page.keyboard.press('Enter');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Tide Tables');
    await expect(pane.locator('.hoard-wiki-title')).toBeFocused();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(pane.locator('.hoard-wiki-title')).toHaveText('Harbour');
    expect(await page.evaluate(() => book.id)).toBe(novel);

    // Edit in Wiki Book opens the wiki book at that page
    await pane.getByRole('button', { name: 'Edit in Wiki Book' }).click();
    await expect.poll(() => page.evaluate(() => book && book.id)).toBe(wiki.id);
    await expect.poll(() => page.evaluate(() => captureCaret()?.chId)).toBe(harbour);
  } finally {
    await fixture.close();
  }
});
