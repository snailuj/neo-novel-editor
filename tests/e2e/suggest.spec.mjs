import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// Suggest-And-Review. Rules: a page the librarian owns opens held, and the writer's edits
// there become suggestions, a keystroke included; the librarian applies a clean one as
// its own edit, between the writer's commit and its own, and flags one it cannot apply
// with a comment saying why; a withdrawn suggestion keeps its words; Edit Directly lets
// the writer type, and the next open is in suggest mode again. A chapter the librarian
// does not own is never held.

const LORE = 'chapter-synthetic';
const TEXT = '<p>The harbour of Vell faces west.</p><p>Its keeper rows at dawn.</p>';

async function trackedProfile() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(profile, 'userData'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  await writeFile(path.join(profile, 'userData', 'settings.json'), JSON.stringify({
    plugins: { hoard: { git: { idleSeconds: 1 } } },
  }));
  await writeFile(path.join(profile, '.gitconfig'), '[user]\n\tname = Ada Author\n\temail = ada@example.com\n');
  execFileSync('git', ['init', '-q'], { cwd: library });
  return { profile, library };
}

const git = (library, ...args) => execFileSync('git', args, {
  cwd: library, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});
const authors = (library) => { try { return git(library, 'log', '--format=%an').split('\n').filter(Boolean); } catch { return []; } };
const readMarks = (library, bookId) => {
  const file = path.join(library, '.neo', bookId, 'chapters', `${LORE}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).marks : [];
};
const chapterFile = (library, bookId) => readFileSync(path.join(library, bookId, 'chapters', `${LORE}.html`), 'utf8');

async function pageSidecar(library, bookId, frontmatter) {
  const dir = path.join(library, '.neo', bookId, 'pages');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${LORE}.json`), JSON.stringify({
    version: 1, source: { path: '/synthetic/vell.md', name: 'Vell', sha256: 'a'.repeat(64) }, frontmatter, imported: '2026-10-15T21:00:00.000Z',
  }));
}

const reopen = (page, bookId) => page.evaluate(async (id) => { await backToShelf(); await openBook(id); }, bookId);

// Selects `words` inside the paragraph that holds them, as a writer's drag would.
async function select(page, words) {
  await page.evaluate((words) => {
    const p = [...document.querySelectorAll('.chapter-body p')].find((el) => el.textContent.includes(words));
    const node = p.firstChild;
    const at = node.textContent.indexOf(words);
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + words.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, words);
}

async function ready(page) {
  await page.waitForFunction(() => !!window.hoard);
  await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');
}

test('the librarian\'s page takes suggestions, which the librarian accepts or flags', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const bookId = await seedBook(page, TEXT);
    await expect(page.locator('.chapter[data-held]')).toHaveCount(0);
    await pageSidecar(library, bookId, { type: 'lore' });
    await reopen(page, bookId);
    await expect(page.locator(`.chapter[data-id="${LORE}"][data-held]`)).toHaveCount(1);
    await expect.poll(() => authors(library).length, { timeout: 10_000 }).toBeGreaterThan(0);

    // a typed letter over a selection starts a substitution with that letter
    await select(page, 'west');
    await page.keyboard.press('e');
    const box = page.locator('#hoard-suggest-text');
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('e');
    await page.keyboard.type('ast');
    await page.keyboard.press('Enter');
    await expect.poll(() => chapterFile(library, bookId), { timeout: 10_000 }).toBe('<p>The harbour of Vell faces east.</p><p>Its keeper rows at dawn.</p>');
    await expect.poll(() => readMarks(library, bookId).map((m) => [m.kind, m.state, m.proposed])).toEqual([['substitution', 'accepted', 'east']]);
    // the chapter's last commit is the librarian's; the sidecar's verdict follows in the writer's next one
    await expect.poll(() => git(library, 'log', '-1', '--format=%an', '--', `${bookId}/chapters/${LORE}.html`).trim(), { timeout: 10_000 }).toBe('Librarian');
    const [accepted] = readMarks(library, bookId);
    expect(accepted.history.map((h) => [h.state, h.who])).toEqual([['accepted', 'librarian']]);
    await expect(page.locator('.chapter[data-held]')).toHaveCount(1);

    // Backspace over a selection starts a deletion, with an optional reason
    await select(page, 'keeper ');
    await page.keyboard.press('Backspace');
    await expect(page.locator('#hoard-suggest-text')).toHaveValue('');
    await page.locator('#hoard-suggest-note').fill('The keeper is unnamed here.');
    await page.locator('#hoard-suggest-note').press('Control+Enter');
    await expect.poll(() => readMarks(library, bookId).map((m) => [m.kind, m.state])).toEqual([['substitution', 'accepted'], ['deletion', 'accepted']]);
    await expect.poll(() => chapterFile(library, bookId), { timeout: 10_000 }).toBe('<p>The harbour of Vell faces east.</p><p>Its rows at dawn.</p>');
    expect(readMarks(library, bookId)[1].thread.map((e) => [e.who, e.body])).toEqual([['author', 'The keeper is unnamed here.']]);

    // a link to no page is flagged, and the page stays as it was
    await select(page, 'Vell');
    await page.keyboard.press('[');
    await page.locator('#hoard-suggest-text').fill('[[Vell]]');
    await page.keyboard.press('Enter');
    await expect.poll(() => readMarks(library, bookId).at(-1)?.state).toBe('flagged');
    const flagged = readMarks(library, bookId).at(-1);
    expect(flagged.thread.map((e) => e.who)).toEqual(['librarian']);
    expect(flagged.thread[0].body).toMatch(/\[\[Vell\]\] names no wiki page/);
    expect(chapterFile(library, bookId)).toContain('harbour of Vell faces');
    await expect(page.locator(`.hoard-mark[data-mark="${flagged.id}"] button[data-action="Withdraw"]`)).toHaveCount(1);

    // withdrawn: the words stay in the sidecar
    await page.locator(`.hoard-mark[data-mark="${flagged.id}"] button[data-action="Withdraw"]`).click({ force: true });
    await expect.poll(() => readMarks(library, bookId).at(-1)?.state).toBe('rejected');
    expect(readMarks(library, bookId).at(-1).proposed).toBe('[[Vell]]');

    // Edit Directly lets typing through until the book closes
    await page.locator('.chapter-body p').nth(1).click();
    await page.evaluate(() => document.querySelector('.hoard-direct').click());
    await expect(page.locator('.chapter[data-held]')).toHaveCount(0);
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Typed.');
    await expect.poll(() => chapterFile(library, bookId), { timeout: 10_000 }).toContain('dawn. Typed.');
    await reopen(page, bookId);
    await expect(page.locator(`.chapter[data-id="${LORE}"][data-held]`)).toHaveCount(1);
  } finally {
    await fixture.close();
  }
});

// Rule: the Wiki pane shows a page's comments on its lines and under it, and a comment
// made there on selected words is the same mark the wiki book shows, in the same sidecar.
test('a comment made in the Wiki pane is drawn there and is the wiki book\'s own', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const wikiId = await page.evaluate(async ({ chId, html }) => {
      const meta = await neo.createBook({ title: 'Wiki', author: 'Test author' });
      meta.chapterOrder = [chId];
      meta.chapterTitles = { [chId]: 'Vell' };
      await neo.writeBookMeta(meta.id, meta);
      await neo.writeChapter(meta.id, chId, html);
      return meta.id;
    }, { chId: LORE, html: TEXT });
    await mkdir(path.join(library, '.neo'), { recursive: true });
    await writeFile(path.join(library, '.neo', 'wiki.json'), JSON.stringify({ version: 1, bookId: wikiId }));
    await seedBook(page, '<p>See [[Vell]] today.</p>');
    await page.evaluate((chId) => window.hoard.wiki.pane.open(chId), LORE);
    const line = page.locator('.hoard-wiki-page p').nth(0);
    await expect(line).toHaveText('The harbour of Vell faces west.');

    await page.evaluate(() => {
      const p = document.querySelector('.hoard-wiki-page p');
      const node = p.firstChild;
      const at = node.textContent.indexOf('west');
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 4);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await page.locator('.hoard-pane-add').click({ force: true });
    await page.locator('#hoard-pane-compose-text').fill('Why west?');
    await page.locator('#hoard-pane-compose-text').press('Control+Enter');
    await expect.poll(() => readMarks(library, wikiId).map((m) => [m.kind, m.anchor.exact, m.thread[0]?.body])).toEqual([['comment', 'west', 'Why west?']]);
    await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get('hoard-pane-comment') ?? [])].map((r) => r.toString()))).toEqual(['west']);
    // the manuscript beside it was never touched
    await expect(page.locator('.chapter-body p').nth(0)).toHaveText('See [[Vell]] today.');

    const [made] = readMarks(library, wikiId);
    const cardIn = page.locator(`.hoard-pane-marks .hoard-mark[data-mark="${made.id}"]`);
    await cardIn.locator('textarea').fill('Because of the sunset.');
    await cardIn.locator('textarea').press('Control+Enter');
    await expect.poll(() => readMarks(library, wikiId)[0].thread.map((e) => e.body)).toEqual(['Why west?', 'Because of the sunset.']);
    await page.locator(`.hoard-pane-marks .hoard-mark[data-mark="${made.id}"] button[data-action="Resolve"]`).click({ force: true });
    await expect.poll(() => readMarks(library, wikiId)[0].state).toBe('resolved');
    await expect.poll(() => page.evaluate(() => CSS.highlights.has('hoard-pane-comment'))).toBe(false);

    // the wiki book lists the same comment
    await page.evaluate(() => window.hoard.wiki.openWiki());
    await expect.poll(() => page.evaluate((chId) => (window.hoard.marks.state().marks[chId] ?? []).map((m) => m.state), LORE)).toEqual(['resolved']);
  } finally {
    await fixture.close();
  }
});

// Rule: when the library check refuses the librarian's commit, its change does not stay
// on the page unrecorded: the words go back, and the suggestion is flagged with the
// check's reason, its proposed words kept.
test('a change the library check refuses is put back and flagged', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const bad = '<p data-block="not citable!">The harbour of Vell faces west.</p><p>Its keeper rows at dawn.</p>';
    const bookId = await seedBook(page, bad);
    await pageSidecar(library, bookId, { type: 'lore' });
    await reopen(page, bookId);
    await expect(page.locator(`.chapter[data-id="${LORE}"][data-held]`)).toHaveCount(1);
    await expect.poll(() => authors(library).length, { timeout: 10_000 }).toBeGreaterThan(0);

    await select(page, 'west');
    await page.keyboard.type('east');
    await page.keyboard.press('Enter');
    await expect.poll(() => readMarks(library, bookId).map((m) => m.state), { timeout: 15_000 }).toEqual(['flagged']);
    const [mark] = readMarks(library, bookId);
    expect(mark.proposed).toBe('east');
    expect(mark.thread.map((e) => e.who)).toEqual(['librarian']);
    expect(mark.thread[0].body).toMatch(/library check refused it/);
    await expect(page.locator('.chapter-body p').nth(0)).toHaveText('The harbour of Vell faces west.');
    await expect.poll(() => chapterFile(library, bookId), { timeout: 10_000 }).toBe(bad);
    expect(authors(library)).not.toContain('Librarian');
  } finally {
    await fixture.close();
  }
});
