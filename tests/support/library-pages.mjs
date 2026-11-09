// A library of stored pages beside an open book, for the specs of the page column and the
// Pages tab of the left pane: the profile, the two places as the writer reaches them, and the
// caret in the book.
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A profile whose library holds `pages`, ids such as wiki/People/Gull.html to their HTML. */
export async function libraryProfile(pages) {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(profile, 'userData'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  for (const [id, html] of Object.entries(pages)) {
    await mkdir(path.dirname(path.join(library, id)), { recursive: true });
    await writeFile(path.join(library, id), html);
  }
  return { profile, library };
}

export const fileOf = (library, id) => readFileSync(path.join(library, ...id.split('/')), 'utf8');

export const inManuscript = (page) => page.evaluate(() => !!document.activeElement?.closest('#chapters .chapter-body'));

/** The caret put in the book, a few letters into the paragraph holding `words` (the first by default). */
export async function caretInBook(page, words = '') {
  await page.evaluate((words) => {
    const p = [...document.querySelectorAll('#chapters .chapter-body p')].find((el) => el.textContent.includes(words));
    p.closest('.chapter-body').focus();
    const range = document.createRange();
    range.setStart(p.firstChild, p.textContent.indexOf(words) + 2);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, words);
  await expect.poll(() => inManuscript(page)).toBe(true);
}

// Follow Link, as its Plugins menu item runs it.
export const followLink = (page) => page.evaluate(() => NeoPlugins.runCommand('hoard', 'follow-link'));

/** The page column, once it has slid in: a click aimed while it moves can land on the book. */
export async function columnSettled(page) {
  await expect(page.locator('#editor-view')).toHaveClass(/\bsplit-open\b/);
  await page.waitForFunction(() => document.getElementById('split-column').getAnimations().length === 0);
  return page.locator('#split-column');
}

/**
 * The left pane open on its Pages tab, once it has slid in, and the tree there. With
 * `read: false` the list the tab reads is not waited for (a test holding that read).
 */
export async function pagesTab(page, { read = true } = {}) {
  await page.evaluate((read) => {
    const shown = window.hoard.wiki.pane.tree.show();
    return read ? shown : undefined;
  }, read);
  await expect(page.locator('#nav-tabs [role="tab"]', { hasText: 'Pages' })).toHaveAttribute('aria-selected', 'true');
  await page.waitForFunction(() => {
    const pane = document.getElementById('nav-pane');
    return pane.classList.contains('open') && pane.getAnimations().length === 0 && pane.getBoundingClientRect().left >= -0.5;
  });
  return page.locator('#nav-pane .hoard-tree');
}

/** A row of the tree by the start of its name; the nth of those. */
export const rowOf = (tree) => (name, n = 0) => tree.locator('.hoard-tree-name', { has: tree.page().locator('.hoard-tree-label', { hasText: new RegExp(`^${name}`) }) }).nth(n);

/** The names the tree's rows show, in order. */
export const rowNames = (tree) => tree.locator('.hoard-tree-label').allTextContents();
