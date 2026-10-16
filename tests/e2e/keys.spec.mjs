import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Rule: a key a hoard box acts on goes no further. NEO's document listener toggles
// fullscreen on ⌘Enter (Ctrl+Enter), so ⌘Enter that sends a comment or a reply must not
// also toggle it. Esc in a pane goes back to the page, never the shelf (NEO's rule);
// in the comment composer it cancels the comment first, as the composer's label says.

async function profile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(dir, 'documents', 'NEO Library');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  return dir;
}

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

async function select(page, words) {
  await page.evaluate((words) => {
    const p = [...document.querySelectorAll('.chapter-body p')].find((el) => el.textContent.includes(words));
    const at = p.firstChild.textContent.indexOf(words);
    p.closest('.chapter-body').focus();
    const range = document.createRange();
    range.setStart(p.firstChild, at);
    range.setEnd(p.firstChild, at + words.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, words);
  await page.waitForFunction((n) => window.hoard.marks.state().here?.len === n, words.length);
}

// Every Enter and Esc that reaches the document, where NEO's own listeners are.
const listen = (page) => page.evaluate(() => {
  window.reached = [];
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') window.reached.push(`${e.ctrlKey || e.metaKey ? 'mod+' : ''}${e.key}`);
  });
});
const reached = (page) => page.evaluate(() => window.reached.splice(0));
const bookOpen = (page) => page.evaluate(() => !document.querySelector('#editor-view').hidden);
const fullScreen = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isFullScreen()));

test('⌘Enter in a comment or reply box only sends it, and Esc there or in Search goes back to the page', async () => {
  const fixture = await launchProfile(await profile());
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await seedBook(page, '<p>The tide came in at dusk.</p><p>Mara counted the boats twice.</p>');
    await listen(page);

    // Esc cancels a comment and goes back to the page; the book stays open
    await select(page, 'counted');
    await menu(app, 'Add Comment');
    const box = page.locator('.hoard-composer textarea');
    await expect(box).toBeFocused();
    await box.fill('Never mind.');
    await box.press('Escape');
    await expect(page.locator('.hoard-composer')).toBeHidden();
    await expect(page.locator('.chapter-body')).toBeFocused();
    expect(await reached(page)).toEqual([]);
    expect(await bookOpen(page)).toBe(true);

    // ⌘Enter sends a comment and fullscreen is left alone
    await select(page, 'counted');
    await menu(app, 'Add Comment');
    await box.fill('Which boats?');
    await box.press('ControlOrMeta+Enter');
    await expect(page.locator('.hoard-composer')).toBeHidden();
    expect(await reached(page)).toEqual([]);
    expect(await fullScreen(app)).toBe(false);

    // the same for a reply
    expect(await page.evaluate(() => window.hoard.marks.show())).toBe(true);
    const card = page.locator('.hoard-mark').first();
    await card.hover();
    const reply = card.locator('.hoard-reply');
    await reply.fill('The ones at the quay.');
    await reply.press('ControlOrMeta+Enter');
    await expect(card).toContainText('The ones at the quay.');
    await reply.focus();
    await reply.press('Escape');
    await expect(page.locator('.chapter-body')).toBeFocused();
    expect(await reached(page)).toEqual([]);
    expect(await fullScreen(app)).toBe(false);
    expect(await bookOpen(page)).toBe(true);

    // Esc in the Search field goes back to the page, not the shelf
    expect(await page.evaluate(() => window.hoard.search.open('tide'))).toBe(true);
    const field = page.locator('.hoard-search-field');
    await expect(field).toBeFocused();
    await field.press('Escape');
    await expect(page.locator('.chapter-body')).toBeFocused();
    expect(await reached(page)).toEqual([]);
    expect(await bookOpen(page)).toBe(true);

    // the listener hears keys that are not a box's, so the test can see a leak
    await page.keyboard.press('Escape');
    expect(await reached(page)).toEqual(['Escape']);
  } finally {
    await fixture.close();
  }
});
