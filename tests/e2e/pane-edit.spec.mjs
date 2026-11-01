import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// The Wiki pane changes wiki pages beside another book. Rules: a change is made on a copy
// of the page and only its paragraph's bytes change; on the librarian's page, Suggest
// change in the pane goes to the librarian, who applies a clean change between the
// writer's commit and its own, or flags it; a flagged suggestion accepted anyway is the
// writer's edit; a change the library check refuses leaves the page as it was; the pane
// writes nothing while the wiki book is the open book.

const LORE = 'chapter-synthetic';
const TEXT = '<p data-block="b1">The harbour of Vell faces west.</p><p data-block="b2">Its keeper rows at dawn.</p>';

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
const pageAuthors = (library, bookId) => {
  try { return git(library, 'log', '--format=%an', '--', `${bookId}/chapters/${LORE}.html`).split('\n').filter(Boolean); } catch { return []; }
};
const readMarks = (library, bookId) => {
  const file = path.join(library, '.neo', bookId, 'chapters', `${LORE}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).marks : [];
};
const pageFile = (library, bookId) => readFileSync(path.join(library, bookId, 'chapters', `${LORE}.html`), 'utf8');

async function ready(page) {
  await page.waitForFunction(() => !!window.hoard);
  await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');
}

// The side pane slides in, and a click aimed while it moves lands outside the window.
async function paneSettled(page) {
  await expect(page.locator('#side-pane')).toHaveClass(/\bopen\b/);
  await page.waitForFunction(() => {
    const pane = document.getElementById('side-pane');
    return pane.getAnimations().length === 0 && pane.getBoundingClientRect().right <= innerWidth + 0.5;
  });
}

// A wiki book holding one page (html), the librarian's when frontmatter says so, and
// another book open beside it with the pane showing the page.
async function wikiBeside(page, library, html, frontmatter) {
  const wikiId = await page.evaluate(async ({ chId, html }) => {
    const meta = await neo.createBook({ title: 'Wiki', author: 'Test author' });
    meta.chapterOrder = [chId];
    meta.chapterTitles = { [chId]: 'Vell' };
    await neo.writeBookMeta(meta.id, meta);
    await neo.writeChapter(meta.id, chId, html);
    return meta.id;
  }, { chId: LORE, html });
  await mkdir(path.join(library, '.neo', wikiId, 'pages'), { recursive: true });
  await writeFile(path.join(library, '.neo', 'wiki.json'), JSON.stringify({ version: 1, bookId: wikiId }));
  await writeFile(path.join(library, '.neo', wikiId, 'pages', `${LORE}.json`), JSON.stringify({
    version: 1, source: { path: '/synthetic/vell.md', name: 'Vell', sha256: 'a'.repeat(64) }, frontmatter, imported: '2026-10-16T09:00:00.000Z',
  }));
  const bookId = await seedBook(page, '<p>See [[Vell]] today.</p>');
  // the setup's own writes are in history before the pane changes anything
  await expect.poll(() => pageAuthors(library, wikiId).length, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.evaluate((chId) => window.hoard.wiki.pane.open(chId), LORE);
  await expect(page.locator('.hoard-wiki-page p').nth(0)).toHaveText('The harbour of Vell faces west.');
  await paneSettled(page);
  return { wikiId, bookId };
}

// Selects `words` in the pane's page, as a writer's drag would.
async function selectInPane(page, words) {
  await page.evaluate((words) => {
    const p = [...document.querySelectorAll('.hoard-wiki-page p')].find((el) => el.textContent.includes(words));
    const node = p.firstChild;
    const at = node.textContent.indexOf(words);
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + words.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, words);
}

// Rule: a page's change is made on a copy of it, the paragraph's bytes alone change, the
// words there must still be what was read, and an element the change empties goes.
test('a page edit changes one paragraph\'s bytes and refuses words that are not there', async () => {
  const { profile } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const edit = (html, at, expected, text) => page.evaluate((a) => window.hoard.paneMarks.editPage(...a), [html, at, expected, text]);
    // the other paragraph keeps bytes the serialiser would write otherwise
    expect(await edit('<p class="wiki-h1" data-block="b1">Fish &amp; chips</p><p>Tom&#39;s</p>', { pIdx: 0, off: 7, len: 5 }, 'chips', 'peas'))
      .toBe('<p class="wiki-h1" data-block="b1">Fish &amp; peas</p><p>Tom&#39;s</p>');
    expect(await edit('<p>An <b>old</b> quay.</p>', { pIdx: 0, off: 3, len: 8 }, 'old quay', '')).toBe('<p>An .</p>');
    expect(await edit('<p>An <b>old</b> quay.</p>', { pIdx: 0, off: 3, len: 3 }, 'old', '')).toBe('<p>An  quay.</p>');
    expect(await edit('<p>An <b>old</b> quay.</p>', { pIdx: 0, off: 3, len: 0 }, '', 'ancient ')).toBe('<p>An ancient <b>old</b> quay.</p>');
    expect(await edit('<p>One.</p><p><br></p>', { pIdx: 1, off: 0, len: 0 }, '', 'Two.')).toBe('<p>One.</p><p>Two.</p>');
    expect(await edit('<p>One.</p><p>Two.</p>', { pIdx: 1, off: 0, len: 4 }, 'Two.', '')).toBe('<p>One.</p><p><br></p>');
    expect(await edit('<p>One.</p>', { pIdx: 0, off: 0, len: 3 }, 'Two', 'Six')).toBeNull();
    expect(await edit('<p>One.</p>', { pIdx: 1, off: 0, len: 0 }, '', 'Six')).toBeNull();
  } finally {
    await fixture.close();
  }
});

// Rule: on the librarian's page, a change suggested in the pane is the librarian's to
// apply, between the writer's commit and its own, or to flag; the writer may accept a
// flagged one anyway, as their own edit.
test('the pane\'s suggestions on the librarian\'s page are reviewed and applied there', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const { wikiId } = await wikiBeside(page, library, TEXT, { type: 'lore' });
    const suggest = page.locator('.hoard-pane-suggest');
    await expect(suggest).toBeVisible();

    await selectInPane(page, 'west');
    await suggest.click({ force: true });
    await page.locator('#hoard-pane-suggest-text').fill('east');
    await page.locator('#hoard-pane-suggest-text').press('Enter');
    await expect.poll(() => readMarks(library, wikiId).map((m) => [m.kind, m.state])).toEqual([['substitution', 'accepted']]);
    expect(pageFile(library, wikiId)).toBe('<p data-block="b1">The harbour of Vell faces east.</p><p data-block="b2">Its keeper rows at dawn.</p>');
    expect(pageAuthors(library, wikiId)[0]).toBe('Librarian');
    await expect(page.locator('.hoard-wiki-page p').nth(0)).toHaveText('The harbour of Vell faces east.');
    await expect(page.locator('.hoard-pane-marks .hoard-status')).toHaveText('The librarian accepted your suggestion.');
    // the book beside it was never touched
    await expect(page.locator('.chapter-body p').nth(0)).toHaveText('See [[Vell]] today.');

    // a link to no page is flagged, and the page stays as it was
    await selectInPane(page, 'keeper');
    await suggest.click({ force: true });
    await page.locator('#hoard-pane-suggest-text').fill('[[Harbourmaster]]');
    await page.locator('#hoard-pane-suggest-text').press('Enter');
    await expect.poll(() => readMarks(library, wikiId).at(-1)?.state).toBe('flagged');
    const flagged = readMarks(library, wikiId).at(-1);
    expect(flagged.thread[0].body).toMatch(/\[\[Harbourmaster\]\] names no wiki page/);
    expect(pageFile(library, wikiId)).toContain('Its keeper rows');

    // accepted anyway: the writer's edit, on the page and in its file
    await page.locator(`.hoard-pane-marks .hoard-mark[data-mark="${flagged.id}"] button[data-action="Accept anyway"]`).click({ force: true });
    await expect.poll(() => readMarks(library, wikiId).at(-1)?.state).toBe('accepted');
    expect(pageFile(library, wikiId)).toContain('Its [[Harbourmaster]] rows at dawn.');
    await expect(page.locator('.hoard-wiki-page p').nth(1)).toHaveText('Its [[Harbourmaster]] rows at dawn.');
    await expect.poll(() => pageAuthors(library, wikiId)[0], { timeout: 10_000 }).toBe('Ada Author');
  } finally {
    await fixture.close();
  }
});

// Rule: a change the library check refuses leaves the page as it was, flagged with the
// check's reason, and the pane writes nothing while the wiki is the open book.
test('a refused change leaves the page as it was, and an open wiki is not written from the pane', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const bad = '<p data-block="not citable!">The harbour of Vell faces west.</p><p data-block="b2">Its keeper rows at dawn.</p>';
    const { wikiId } = await wikiBeside(page, library, bad, { type: 'lore' });

    await selectInPane(page, 'west');
    await page.locator('.hoard-pane-suggest').click({ force: true });
    await page.locator('#hoard-pane-suggest-text').fill('east');
    await page.locator('#hoard-pane-suggest-text').press('Enter');
    await expect.poll(() => readMarks(library, wikiId).map((m) => m.state), { timeout: 15_000 }).toEqual(['flagged']);
    expect(readMarks(library, wikiId)[0].thread[0].body).toMatch(/library check refused it/);
    expect(pageFile(library, wikiId)).toBe(bad);
    expect(pageAuthors(library, wikiId)).not.toContain('Librarian');

    // the wiki open as the book: the pane sends the writer there
    await page.evaluate((id) => openBook(id), wikiId);
    await page.evaluate((chId) => window.hoard.wiki.pane.open(chId), LORE);
    await paneSettled(page);
    await selectInPane(page, 'keeper');
    await page.locator('.hoard-pane-suggest').click({ force: true });
    await expect(page.locator('.hoard-pane-marks .hoard-alert')).toContainText('the wiki is open as a book');
    await expect(page.locator('#hoard-pane-suggest-text')).toBeHidden();
  } finally {
    await fixture.close();
  }
});

// ---- editing in the pane ------------------------------------------------------------

const PAGE = '.hoard-wiki-page';
const paneAlert = '.hoard-pane-marks .hoard-alert';

// The caret put in the pane's page just after `words`, as a click there would.
async function caretAfter(page, words) {
  await page.evaluate((words) => {
    const body = document.querySelector('.hoard-wiki-page');
    const p = [...body.querySelectorAll(':scope > p')].find((el) => el.textContent.includes(words));
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.indexOf(words);
      if (at === -1) continue;
      body.focus();
      getSelection().collapse(node, at + words.length);
      return;
    }
  }, words);
}

// Rule: on the writer's own page, words typed in the pane are saved as the writer's, only
// their paragraph's bytes change, and the pane is wider while the writer types in it.
test('typing in the pane on the writer\'s page is saved as theirs, and the pane widens meanwhile', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const { wikiId } = await wikiBeside(page, library, TEXT, {});
    await expect(page.locator(PAGE)).toHaveAttribute('contenteditable', 'true');
    await expect(page.locator('.hoard-pane-mode')).toBeHidden();

    await caretAfter(page, 'west');
    await expect(page.locator('#side-pane')).not.toHaveClass(/\bwide\b/);
    await page.keyboard.type(' and south');
    await expect(page.locator('#side-pane')).toHaveClass(/\bwide\b/);
    await expect(page.locator(`${PAGE} p`).nth(0)).toHaveText('The harbour of Vell faces west and south.');
    await expect.poll(() => pageFile(library, wikiId)).toBe('<p data-block="b1">The harbour of Vell faces west and south.</p><p data-block="b2">Its keeper rows at dawn.</p>');
    await expect.poll(() => pageAuthors(library, wikiId)[0], { timeout: 10_000 }).toBe('Ada Author');

    // a second change in another paragraph, made over the first, with the page left as
    // it is under the caret
    await page.evaluate(() => { document.querySelectorAll('.hoard-wiki-page > p')[1].dataset.kept = 'yes'; });
    await caretAfter(page, 'rows');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('ams');
    await expect.poll(() => pageFile(library, wikiId)).toBe('<p data-block="b1">The harbour of Vell faces west and south.</p><p data-block="b2">Its keeper roams at dawn.</p>');
    await page.waitForTimeout(500);
    await expect(page.locator(`${PAGE} > p[data-kept]`)).toHaveCount(1);

    // the writer goes back to the book: the pane is narrow again
    await page.locator('.chapter-body p').first().click();
    await expect(page.locator('#side-pane')).not.toHaveClass(/\bwide\b/);
  } finally {
    await fixture.close();
  }
});

// Rule: the pane changes words within a paragraph only; Enter, joining two paragraphs,
// pasting several lines and formatting are left to the wiki book, and the pane says so.
// One line pasted comes in as plain words.
test('the pane keeps to words within a paragraph and sends the rest to the wiki book', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const { wikiId } = await wikiBeside(page, library, TEXT, {});
    const lines = page.locator(`${PAGE} > p`);

    await caretAfter(page, 'west');
    await page.keyboard.press('Enter');
    await expect(page.locator(paneAlert)).toContainText('Edit in Wiki Book');
    await expect(lines).toHaveCount(2);

    // Backspace at the start of the second paragraph would join the two
    await page.evaluate(() => {
      const p = document.querySelectorAll('.hoard-wiki-page > p')[1];
      getSelection().collapse(p.firstChild, 0);
    });
    await page.keyboard.press('Backspace');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toHaveText('The harbour of Vell faces west.');
    await expect(lines.nth(1)).toHaveText('Its keeper rows at dawn.');

    // formatting
    await page.evaluate(() => {
      const node = document.querySelectorAll('.hoard-wiki-page > p')[1].firstChild;
      getSelection().setBaseAndExtent(node, 4, node, 10);
    });
    await page.keyboard.press('Control+b');
    await expect(page.locator(`${PAGE} b`)).toHaveCount(0);

    // a paste of two lines is refused; one line comes in plain, as typed
    const paste = async (text, html) => {
      await fixture.app.evaluate(({ clipboard }, { text, html }) => clipboard.write(html ? { text, html } : { text }), { text, html });
      await page.keyboard.press('Control+v');
    };
    await caretAfter(page, 'dawn');
    await page.evaluate(() => { document.querySelector('.hoard-pane-marks .hoard-alert').textContent = ''; });
    await paste('one\ntwo', null);
    await expect(page.locator(paneAlert)).toContainText('Edit in Wiki Book');
    await expect(lines.nth(1)).toHaveText('Its keeper rows at dawn.');
    await paste(' and dusk', '<b> and dusk</b>');
    await expect(lines.nth(1)).toHaveText('Its keeper rows at dawn and dusk.');
    await expect(page.locator(`${PAGE} b`)).toHaveCount(0);
    await expect.poll(() => pageFile(library, wikiId)).toBe('<p data-block="b1">The harbour of Vell faces west.</p><p data-block="b2">Its keeper rows at dawn and dusk.</p>');

    // a paragraph's words selected by a triple click are typed over, and the paragraph stays
    await lines.nth(0).click({ clickCount: 3 });
    await page.keyboard.type('Gone.');
    await expect(lines).toHaveCount(2);
    await expect.poll(() => pageFile(library, wikiId)).toBe('<p data-block="b1">Gone.</p><p data-block="b2">Its keeper rows at dawn and dusk.</p>');
  } finally {
    await fixture.close();
  }
});

// Rule: on the librarian's page a keystroke in the pane starts a suggestion with it and
// changes nothing; Edit directly lets typing through, saved as the writer's.
test('typing on the librarian\'s page suggests, until the writer edits it directly', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const { wikiId } = await wikiBeside(page, library, TEXT, { type: 'lore' });
    await expect(page.locator('.hoard-pane-mode')).toBeVisible();
    await expect(page.locator('.hoard-pane-direct')).toHaveText('Edit directly');

    // NEO's typography answers a quotation mark with its own insert: it too suggests
    await selectInPane(page, 'keeper');
    await page.keyboard.type('"');
    await expect(page.locator('#hoard-pane-suggest-text')).toHaveValue('"');
    await page.keyboard.press('Escape');
    await expect(page.locator('#hoard-pane-suggest-text')).toBeHidden();
    // so does a paste
    await selectInPane(page, 'keeper');
    await fixture.app.evaluate(({ clipboard }) => clipboard.writeText('warden'));
    await page.keyboard.press('Control+v');
    await expect(page.locator('#hoard-pane-suggest-text')).toHaveValue('warden');
    await page.keyboard.press('Escape');
    await expect(page.locator('#hoard-pane-suggest-text')).toBeHidden();
    expect(pageFile(library, wikiId)).toBe(TEXT);

    await selectInPane(page, 'west');
    await page.keyboard.type('e');
    await expect(page.locator('#hoard-pane-suggest-text')).toBeVisible();
    await expect(page.locator('#hoard-pane-suggest-text')).toHaveValue('e');
    await page.keyboard.type('ast');
    await page.keyboard.press('Enter');
    await expect.poll(() => readMarks(library, wikiId).map((m) => [m.kind, m.state])).toEqual([['substitution', 'accepted']]);
    await expect(page.locator(`${PAGE} p`).nth(0)).toHaveText('The harbour of Vell faces east.');
    expect(pageAuthors(library, wikiId)[0]).toBe('Librarian');

    await page.locator('.hoard-pane-direct').click({ force: true });
    await expect(page.locator('.hoard-pane-direct')).toHaveText('Suggest instead');
    await caretAfter(page, 'dawn');
    await page.keyboard.type(' and dusk');
    await expect.poll(() => pageFile(library, wikiId)).toBe('<p data-block="b1">The harbour of Vell faces east.</p><p data-block="b2">Its keeper rows at dawn and dusk.</p>');
    await expect.poll(() => pageAuthors(library, wikiId)[0], { timeout: 10_000 }).toBe('Ada Author');
    expect(readMarks(library, wikiId)).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

// Rule: what was typed is saved before the pane leaves the page, and a change made on
// another device meanwhile is kept: the typing is made again on the page as it is now,
// or, where both changed the same words, the page stays as the other device left it and
// the pane shows the writer what they typed.
test('typing is saved before the pane moves on, and a change from another device is never written over', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await ready(page);
    const { wikiId } = await wikiBeside(page, library, TEXT, {});
    const file = path.join(library, wikiId, 'chapters', `${LORE}.html`);

    // the page shown again, with no pause after typing and the caret still in it
    await caretAfter(page, 'west');
    await page.keyboard.type(' side');
    await page.evaluate((chId) => window.hoard.wiki.pane.open(chId), LORE);
    expect(pageFile(library, wikiId)).toContain('faces west side.');
    await expect(page.locator(`${PAGE} p`).nth(0)).toHaveText('The harbour of Vell faces west side.');
    await caretAfter(page, ' side');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect.poll(() => pageFile(library, wikiId)).toBe(TEXT);

    // straight to the wiki book, with no pause after typing
    await caretAfter(page, 'west');
    await page.keyboard.type(' bay');
    await page.locator('.hoard-wiki-edit').click();
    await expect(page.locator('.chapter-body p').first()).toHaveText('The harbour of Vell faces west bay.');
    expect(pageFile(library, wikiId)).toContain('faces west bay.');
    // the wiki open as the book: the pane does not take typing
    await page.evaluate((chId) => window.hoard.wiki.pane.open(chId), LORE);
    await expect(page.locator(PAGE)).toHaveAttribute('contenteditable', 'false');

    // back beside another book; another device changes the second paragraph meanwhile
    await seedBook(page, '<p>Elsewhere.</p>');
    await page.evaluate((chId) => window.hoard.wiki.pane.open(chId), LORE);
    await paneSettled(page);
    await expect(page.locator(PAGE)).toHaveAttribute('contenteditable', 'true');
    await writeFile(file, '<p data-block="b1">The harbour of Vell faces west bay.</p><p data-block="b2">Its keeper sleeps at dawn.</p>');
    await caretAfter(page, 'bay');
    await page.keyboard.type(' now');
    await expect.poll(() => pageFile(library, wikiId)).toBe('<p data-block="b1">The harbour of Vell faces west bay now.</p><p data-block="b2">Its keeper sleeps at dawn.</p>');
    await expect(page.locator(`${PAGE} p`).nth(1)).toHaveText('Its keeper sleeps at dawn.');

    // both changed the same paragraph: the other device's words stay, and the writer's show
    const theirs = '<p data-block="b1">The harbour was moved east, the keeper says.</p><p data-block="b2">Its keeper sleeps at dawn.</p>';
    await writeFile(file, theirs);
    await caretAfter(page, 'now');
    await page.keyboard.type(' still');
    await expect(page.locator(paneAlert)).toContainText('The harbour of Vell faces west bay now still.');
    expect(pageFile(library, wikiId)).toBe(theirs);
    await expect(page.locator(`${PAGE} p`).nth(0)).toHaveText('The harbour was moved east, the keeper says.');
  } finally {
    await fixture.close();
  }
});
