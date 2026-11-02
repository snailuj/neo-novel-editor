// A library with one stored page, wiki/Vell.html, shown in the wiki pane beside an open
// book, for the specs that edit and mark a page there (pane-edit, pane-editor).
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from './electron-profile.mjs';

export const VELL = 'wiki/Vell.html';
export const BOOK_HTML = '<p>See [[Vell]] today.</p>';

const git = (library, ...args) => execFileSync('git', args, {
  cwd: library, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});

/** The page's file as it is on disk. */
export const pageFile = (library, id = VELL) => readFileSync(path.join(library, ...id.split('/')), 'utf8');
/** The authors of the commits that touched the page, newest first. */
export const pageAuthors = (library, id = VELL) => {
  try { return git(library, 'log', '--format=%an', '--', id).split('\n').filter(Boolean); } catch { return []; }
};
/** The page's marks, from its sidecar .neo/marks/<tree>/<path>.json. */
export const readMarks = (library, id = VELL) => {
  const file = path.join(library, '.neo', 'marks', ...id.split('/')) + '.json';
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).marks : [];
};

// The side pane slides in, and a click aimed while it moves lands outside the window.
export async function paneSettled(page) {
  await expect(page.locator('#side-pane')).toHaveClass(/\bopen\b/);
  await page.waitForFunction(() => {
    const pane = document.getElementById('side-pane');
    return pane.getAnimations().length === 0 && pane.getBoundingClientRect().right <= innerWidth + 0.5;
  });
}

/**
 * A tracked library holding wiki/Vell.html (html), the librarian's when librarian is set,
 * launched with a book open beside the pane showing the page once its first commit is in.
 */
export async function pageBeside(html, { librarian = false, extra = {} } = {}) {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(path.join(library, 'wiki'), { recursive: true });
  await mkdir(path.join(profile, 'userData'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  await writeFile(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ plugins: { hoard: { git: { idleSeconds: 1 } } } }));
  await writeFile(path.join(profile, '.gitconfig'), '[user]\n\tname = Ada Author\n\temail = ada@example.com\n');
  await writeFile(path.join(library, ...VELL.split('/')), html);
  for (const [id, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(library, ...id.split('/'))), { recursive: true });
    await writeFile(path.join(library, ...id.split('/')), text);
  }
  if (librarian) {
    await mkdir(path.join(library, '.neo', 'pages', 'wiki'), { recursive: true });
    await writeFile(path.join(library, '.neo', 'pages', 'wiki', 'Vell.html.json'), JSON.stringify({
      version: 1, source: { path: '/synthetic/vell.md', name: 'Vell', sha256: 'a'.repeat(64) }, frontmatter: { type: 'lore' }, imported: '2026-10-16T09:00:00.000Z',
    }));
  }
  execFileSync('git', ['init', '-q'], { cwd: library });
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');
    await seedBook(page, BOOK_HTML);
    // the setup's own writes are in history before the pane changes anything
    await expect.poll(() => pageAuthors(library).length, { timeout: 10_000 }).toBeGreaterThan(0);
    await page.evaluate((id) => window.hoard.wiki.pane.open(id), VELL);
    await expect(page.locator('.hoard-wiki-page > p').first()).toBeVisible();
    await paneSettled(page);
    // whose the page is has been read, so typing is an edit or a suggestion as it should be
    await expect(page.locator('.hoard-wiki-page')).toHaveAttribute('contenteditable', 'true');
    return { fixture, page, library, profile };
  } catch (err) {
    await fixture.close();
    throw err;
  }
}

/** The caret put in the pane's page at `at` (after, start or end) of `words`, as a click there would. */
export const caretAt = (page, words, at = 'after') => page.evaluate(({ words, at }) => {
  const body = document.querySelector('.hoard-wiki-page');
  const p = [...body.querySelectorAll(':scope > p')].find((el) => el.textContent.includes(words));
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  body.focus();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const i = node.textContent.indexOf(words);
    if (i === -1) continue;
    getSelection().collapse(node, at === 'start' ? 0 : at === 'end' ? node.textContent.length : i + words.length);
    return;
  }
  throw new Error(`no words ${words} in the pane`);
}, { words, at });

/** `words` selected in the pane's page, as a writer's drag would. */
export const selectIn = (page, words) => page.evaluate((words) => {
  const body = document.querySelector('.hoard-wiki-page');
  const p = [...body.querySelectorAll(':scope > p')].find((el) => el.textContent.includes(words));
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const i = node.textContent.indexOf(words);
    if (i === -1) continue;
    body.focus();
    getSelection().setBaseAndExtent(node, i, node, i + words.length);
    return;
  }
  throw new Error(`no words ${words} in the pane`);
}, words);

/** The pane's blocks as [class, id, text, alias]. */
export const shownBlocks = (page) => page.evaluate(() => [...document.querySelectorAll('.hoard-wiki-page > p')].map((p) => [
  [...p.classList].filter((c) => c !== 'hoard-wiki-line').join(' '), p.dataset.block ?? '', p.textContent, p.dataset.alias ?? '']));

/** A page's blocks as [class, id, text, alias] from its saved bytes. */
export const blocksOf = (html) => [...html.matchAll(/<p([^>]*)>([\s\S]*?)<\/p>/g)].map((m) => [
  (m[1].match(/class="([^"]*)"/) ?? [])[1] ?? '', (m[1].match(/data-block="([^"]*)"/) ?? [])[1] ?? '',
  m[2].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&'), (m[1].match(/data-alias="([^"]*)"/) ?? [])[1] ?? '',
]);

export const paneAlert = '.hoard-pane-marks .hoard-alert';
export const PAGE = '.hoard-wiki-page';
export const LINES = '.hoard-wiki-page > p';
