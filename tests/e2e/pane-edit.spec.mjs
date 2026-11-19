import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pagesTab, rowOf } from '../support/library-pages.mjs';
import {
  caretAt, columnSettled, LINES, PAGE, pageAuthors, pageBeside, pageFile, paneAlert, readMarks, selectIn, VELL,
} from '../support/pane-page.mjs';

// The page column edits and marks a stored page (wiki/Vell.html) beside another book. Rules:
// a change is made on a copy of the page and only its paragraph's bytes change; on the
// librarian's page, Suggest change in the pane goes to the librarian, who applies a clean
// change between the writer's commit and its own, or flags it; a flagged suggestion
// accepted anyway is the writer's edit; a change the library check refuses leaves the page
// as it was; typing on the writer's page is saved as theirs, block by block, and handed to
// the librarian to read; typing is saved before the pane moves on, and a change from
// elsewhere is never written over.

const TEXT = '<p data-block="b1">The harbour of Vell faces west.</p><p data-block="b2">Its keeper rows at dawn.</p>';

// Rule: a page's change is made on a copy of it, the paragraph's bytes alone change, the
// words there must still be what was read, and an element the change empties goes.
test('a page edit changes one paragraph\'s bytes and refuses words that are not there', async () => {
  const { fixture, page } = await pageBeside(TEXT);
  try {
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
  const { fixture, page, library } = await pageBeside(TEXT, { librarian: true });
  try {
    const suggest = page.locator('.hoard-pane-suggest');
    await expect(suggest).toBeVisible();

    await selectIn(page, 'west');
    await suggest.click({ force: true });
    await page.locator('#hoard-pane-suggest-text').fill('east');
    await page.locator('#hoard-pane-suggest-text').press('Enter');
    await expect.poll(() => readMarks(library).map((m) => [m.kind, m.state])).toEqual([['substitution', 'accepted']]);
    expect(pageFile(library)).toBe('<p data-block="b1">The harbour of Vell faces east.</p><p data-block="b2">Its keeper rows at dawn.</p>');
    expect(pageAuthors(library)[0]).toBe('Librarian');
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour of Vell faces east.');
    await expect(page.locator('.hoard-pane-marks .hoard-status')).toHaveText('The librarian accepted your suggestion.');
    // the book beside it was never touched
    await expect(page.locator('.chapter-body p').nth(0)).toHaveText('See [[Vell]] today.');

    // a link to no page is flagged, and the page stays as it was
    await selectIn(page, 'keeper');
    await suggest.click({ force: true });
    await page.locator('#hoard-pane-suggest-text').fill('[[Harbourmaster]]');
    await page.locator('#hoard-pane-suggest-text').press('Enter');
    await expect.poll(() => readMarks(library).at(-1)?.state).toBe('flagged');
    const flagged = readMarks(library).at(-1);
    expect(flagged.thread[0].body).toMatch(/\[\[Harbourmaster\]\] names no wiki page/);
    expect(pageFile(library)).toContain('Its keeper rows');

    // accepted anyway: the writer's edit, on the page and in its file
    await page.locator(`.hoard-pane-marks .hoard-mark[data-mark="${flagged.id}"] button[data-action="Accept anyway"]`).click({ force: true });
    await expect.poll(() => readMarks(library).at(-1)?.state).toBe('accepted');
    expect(pageFile(library)).toContain('Its [[Harbourmaster]] rows at dawn.');
    await expect(page.locator(LINES).nth(1)).toHaveText('Its [[Harbourmaster]] rows at dawn.');
    await expect.poll(() => pageAuthors(library)[0], { timeout: 10_000 }).toBe('Ada Author');
  } finally {
    await fixture.close();
  }
});

// Rule: a change the library check refuses leaves the page as it was, flagged with the
// check's reason.
test('a refused change leaves the page as it was', async () => {
  const bad = '<p data-block="not citable!">The harbour of Vell faces west.</p><p data-block="b2">Its keeper rows at dawn.</p>';
  const { fixture, page, library } = await pageBeside(bad, { librarian: true });
  try {
    await selectIn(page, 'west');
    await page.locator('.hoard-pane-suggest').click({ force: true });
    await page.locator('#hoard-pane-suggest-text').fill('east');
    await page.locator('#hoard-pane-suggest-text').press('Enter');
    await expect.poll(() => readMarks(library).map((m) => m.state), { timeout: 15_000 }).toEqual(['flagged']);
    expect(readMarks(library)[0].thread[0].body).toMatch(/library check refused it/);
    expect(pageFile(library)).toBe(bad);
    expect(pageAuthors(library)).not.toContain('Librarian');
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour of Vell faces west.');
  } finally {
    await fixture.close();
  }
});

// Rule: on the writer's own page, words typed in the column are saved as the writer's, only
// their paragraph's bytes change, the saved page is handed to the librarian to read, and
// the column keeps its width while the writer types (the right-hand pane never widens).
test('typing in the column on the writer\'s page is saved as theirs, and the column keeps its width', async () => {
  const { fixture, page, library } = await pageBeside(TEXT);
  try {
    await expect(page.locator('.hoard-pane-mode')).toBeHidden();
    expect(await page.evaluate(() => window.hoard.companion.pagesHanded())).toEqual([]);

    await caretAt(page, 'west');
    const width = () => page.evaluate(() => document.getElementById('split-column').getBoundingClientRect().width);
    const before = await width();
    expect(before).toBeGreaterThan(0);
    await page.keyboard.type(' and south');
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour of Vell faces west and south.');
    await expect.poll(() => pageFile(library)).toBe('<p data-block="b1">The harbour of Vell faces west and south.</p><p data-block="b2">Its keeper rows at dawn.</p>');
    await expect.poll(() => pageAuthors(library)[0], { timeout: 10_000 }).toBe('Ada Author');
    // the main half took the page read (companion.read with {page, before, after})
    await page.evaluate(() => window.hoard.companion.settled());
    expect(await page.evaluate(() => window.hoard.companion.pagesHanded())).toEqual([{ page: VELL, read: 'taken' }]);

    // a second change in another paragraph, made over the first, with the page left as
    // it is under the caret
    await page.evaluate(() => { document.querySelectorAll('.hoard-wiki-page > p')[1].dataset.kept = 'yes'; });
    await caretAt(page, 'rows');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('ams');
    await expect.poll(() => pageFile(library)).toBe('<p data-block="b1">The harbour of Vell faces west and south.</p><p data-block="b2">Its keeper roams at dawn.</p>');
    await page.waitForTimeout(500);
    await expect(page.locator(`${PAGE} > p[data-kept]`)).toHaveCount(1);

    expect(await width()).toBe(before);
    await expect(page.locator('#side-pane')).not.toHaveClass(/\bwide\b/);
  } finally {
    await fixture.close();
  }
});

// Rule: the pane edits the page in full: Enter makes a paragraph, Backspace joins two,
// Ctrl+B formats, a paste of several lines makes paragraphs, and each is saved; a
// paragraph's words selected by a triple click are typed over and the paragraph stays.
test('the pane edits a page in full: paragraphs made and joined, formatting, pasting', async () => {
  const { fixture, page, library } = await pageBeside(TEXT);
  try {
    const lines = page.locator(LINES);
    await caretAt(page, 'west.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Gulls nest there.');
    await expect(lines).toHaveCount(3);
    await expect.poll(() => pageFile(library)).toMatch(/^<p data-block="b1">The harbour of Vell faces west\.<\/p><p data-block="[0-9a-f]{6}">Gulls nest there\.<\/p><p data-block="b2">Its keeper rows at dawn\.<\/p>$/);

    // Backspace at the start of the new paragraph joins it to the one above
    await caretAt(page, 'Gulls', 'start');
    await page.keyboard.press('Backspace');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toHaveText('The harbour of Vell faces west.Gulls nest there.');
    // the joined block's id was made in the pane this session, so nothing cited it and no alias stays
    expect(await page.evaluate(() => document.querySelector('.hoard-wiki-page > p').hasAttribute('data-alias'))).toBe(false);

    // formatting
    await selectIn(page, 'keeper');
    await page.keyboard.press('Control+b');
    await expect(page.locator(`${PAGE} b`)).toHaveText('keeper');

    // a paste of two lines makes a paragraph of the second
    await caretAt(page, 'dawn.');
    await fixture.app.evaluate(({ clipboard }) => clipboard.write({ text: ' And dusk.\nThe lamp is lit.' }));
    await page.keyboard.press('Control+v');
    await expect(lines).toHaveCount(3);
    await expect(lines.nth(2)).toHaveText('The lamp is lit.');
    await expect.poll(() => pageFile(library)).toMatch(/^<p data-block="b1">The harbour of Vell faces west\.Gulls nest there\.<\/p><p data-block="b2">Its <b>keeper<\/b> rows at dawn\. And dusk\.<\/p><p data-block="[0-9a-f]{6}">The lamp is lit\.<\/p>$/);

    // a paragraph's words selected by a triple click are typed over, and the paragraph stays
    await lines.nth(0).click({ clickCount: 3 });
    await page.keyboard.type('Gone.');
    await expect(lines).toHaveCount(3);
    await expect.poll(() => pageFile(library)).toMatch(/^<p data-block="b1">Gone\.<\/p><p data-block="b2">Its <b>keeper<\/b>/);
  } finally {
    await fixture.close();
  }
});

// Rule: on the librarian's page a keystroke in the pane starts a suggestion with it and
// changes nothing; Edit directly lets typing through, saved as the writer's.
test('typing on the librarian\'s page suggests, until the writer edits it directly', async () => {
  const { fixture, page, library } = await pageBeside(TEXT, { librarian: true });
  try {
    await expect(page.locator('.hoard-pane-mode')).toBeVisible();
    await expect(page.locator('.hoard-pane-direct')).toHaveText('Edit directly');

    // NEO's typography answers a quotation mark with its own insert: it too suggests
    await selectIn(page, 'keeper');
    await page.keyboard.type('"');
    await expect(page.locator('#hoard-pane-suggest-text')).toHaveValue('"');
    await page.keyboard.press('Escape');
    await expect(page.locator('#hoard-pane-suggest-text')).toBeHidden();
    // so does a paste
    await selectIn(page, 'keeper');
    await fixture.app.evaluate(({ clipboard }) => clipboard.writeText('warden'));
    await page.keyboard.press('Control+v');
    await expect(page.locator('#hoard-pane-suggest-text')).toHaveValue('warden');
    await page.keyboard.press('Escape');
    await expect(page.locator('#hoard-pane-suggest-text')).toBeHidden();
    // and Enter makes no paragraph: it is direct editing's
    await caretAt(page, 'west');
    await page.keyboard.press('Enter');
    await expect(page.locator(LINES)).toHaveCount(2);
    await expect(page.locator(paneAlert)).toContainText('choose Edit directly');
    expect(pageFile(library)).toBe(TEXT);

    await selectIn(page, 'west');
    await page.keyboard.type('e');
    await expect(page.locator('#hoard-pane-suggest-text')).toBeVisible();
    await expect(page.locator('#hoard-pane-suggest-text')).toHaveValue('e');
    await page.keyboard.type('ast');
    await page.keyboard.press('Enter');
    await expect.poll(() => readMarks(library).map((m) => [m.kind, m.state])).toEqual([['substitution', 'accepted']]);
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour of Vell faces east.');
    expect(pageAuthors(library)[0]).toBe('Librarian');

    await page.locator('.hoard-pane-direct').click({ force: true });
    await expect(page.locator('.hoard-pane-direct')).toHaveText('Suggest instead');
    await caretAt(page, 'dawn');
    await page.keyboard.type(' and dusk');
    await expect.poll(() => pageFile(library)).toBe('<p data-block="b1">The harbour of Vell faces east.</p><p data-block="b2">Its keeper rows at dawn and dusk.</p>');
    await expect.poll(() => pageAuthors(library)[0], { timeout: 10_000 }).toBe('Ada Author');
    expect(readMarks(library)).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

// Rule: what was typed is saved before the pane leaves the page, and a change made
// elsewhere meanwhile is kept: the typing is made again on the page as it is now, or,
// where both changed the same paragraph, the page stays as the other change left it and
// the pane shows the writer what they typed.
test('typing is saved before the pane moves on, and a change from elsewhere is never written over', async () => {
  const other = '<p data-block="o1">Another page.</p>';
  const { fixture, page, library } = await pageBeside(TEXT, { extra: { 'wiki/Other.html': other } });
  try {
    const file = path.join(library, 'wiki', 'Vell.html');

    // the page shown again, with no pause after typing and the caret still in it
    await caretAt(page, 'west');
    await page.keyboard.type(' side');
    await page.evaluate((id) => window.hoard.wiki.pane.open(id), VELL);
    expect(pageFile(library)).toContain('faces west side.');
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour of Vell faces west side.');
    await caretAt(page, ' side');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
    await expect.poll(() => pageFile(library)).toBe(TEXT);

    // straight to another page, with no pause after typing
    await caretAt(page, 'west');
    await page.keyboard.type(' bay');
    await page.evaluate(() => window.hoard.wiki.pane.open('wiki/Other.html'));
    expect(pageFile(library)).toContain('faces west bay.');
    await expect(page.locator(LINES).nth(0)).toHaveText('Another page.');
    expect(pageFile(library, 'wiki/Other.html')).toBe(other);
    await page.evaluate((id) => window.hoard.wiki.pane.open(id), VELL);
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour of Vell faces west bay.');

    // another device changes the second paragraph meanwhile
    await writeFile(file, '<p data-block="b1">The harbour of Vell faces west bay.</p><p data-block="b2">Its keeper sleeps at dawn.</p>');
    await caretAt(page, 'bay');
    await page.keyboard.type(' now');
    await expect.poll(() => pageFile(library)).toBe('<p data-block="b1">The harbour of Vell faces west bay now.</p><p data-block="b2">Its keeper sleeps at dawn.</p>');
    await expect(page.locator(LINES).nth(1)).toHaveText('Its keeper sleeps at dawn.');

    // both changed the same paragraph: the other device's words stay, and the writer's show
    const theirs = '<p data-block="b1">The harbour was moved east, the keeper says.</p><p data-block="b2">Its keeper sleeps at dawn.</p>';
    await writeFile(file, theirs);
    await caretAt(page, 'now');
    await page.keyboard.type(' still');
    await expect(page.locator(paneAlert)).toContainText('The harbour of Vell faces west bay now still.');
    expect(pageFile(library)).toBe(theirs);
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour was moved east, the keeper says.');
  } finally {
    await fixture.close();
  }
});

// NEO toggles fullscreen on any Ctrl+Enter that reaches the document (app.js), so a box
// that takes Ctrl+Enter to send must keep it from going further. These count the ones
// that got there, from a listener on the document beside NEO's.
const watchCtrlEnter = (page) => page.evaluate(() => {
  window.ctrlEnterReached = 0;
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) window.ctrlEnterReached += 1; });
});
const ctrlEnterReached = (page) => page.evaluate(() => window.ctrlEnterReached);

// Rule: the page column shows a stored page's comments on its lines and under it, and a
// comment made there on selected words is kept in the page's own marks sidecar,
// .neo/marks/<tree>/<path>.json.
test('a comment made in the page column is drawn there and kept in the page\'s marks sidecar', async () => {
  const { fixture, page, library } = await pageBeside(TEXT);
  try {
    expect(readMarks(library)).toEqual([]);
    // Esc in the composer stops composing, and the book stays open
    await selectIn(page, 'west');
    await page.locator('.hoard-pane-add').click({ force: true });
    await page.locator('#hoard-pane-compose-text').press('Escape');
    await expect(page.locator('#hoard-pane-compose-text')).toBeHidden();
    await expect(page.locator('#editor-view')).toBeVisible();

    await columnSettled(page);
    await selectIn(page, 'west');
    await watchCtrlEnter(page);
    await page.locator('.hoard-pane-add').click({ force: true });
    await page.locator('#hoard-pane-compose-text').fill('Why west?');
    await page.locator('#hoard-pane-compose-text').press('Control+Enter');
    await expect.poll(() => readMarks(library).map((m) => [m.kind, m.anchor.exact, m.thread[0]?.body])).toEqual([['comment', 'west', 'Why west?']]);
    await expect.poll(() => page.evaluate(() => [...(CSS.highlights.get('hoard-pane-comment') ?? [])].map((r) => r.toString()))).toEqual(['west']);
    // the manuscript beside it was never touched
    await expect(page.locator('.chapter-body p').nth(0)).toHaveText('See [[Vell]] today.');

    const [made] = readMarks(library);
    const cardIn = page.locator(`.hoard-pane-marks .hoard-mark[data-mark="${made.id}"]`);
    await cardIn.locator('textarea').fill('Because of the sunset.');
    await cardIn.locator('textarea').press('Control+Enter');
    await expect.poll(() => readMarks(library)[0].thread.map((e) => e.body)).toEqual(['Why west?', 'Because of the sunset.']);
    expect(await ctrlEnterReached(page)).toBe(0);
    await columnSettled(page);
    await page.locator(`.hoard-pane-marks .hoard-mark[data-mark="${made.id}"] button[data-action="Resolve"]`).click({ force: true });
    await expect.poll(() => readMarks(library)[0].state).toBe('resolved');
    await expect.poll(() => page.evaluate(() => CSS.highlights.has('hoard-pane-comment'))).toBe(false);

    // shown again, the page reads its comments from the sidecar
    await page.evaluate(() => window.hoard.wiki.pane.reload());
    await expect(page.locator(`.hoard-pane-marks .hoard-mark[data-mark="${made.id}"]`)).toContainText('resolved');
  } finally {
    await fixture.close();
  }
});

// Rule: what was typed in the page shown is saved before the Pages tree renames or moves
// that page, so it lands in the page under its new id and nothing typed is lost.
test('typing not yet saved goes with the page shown when the tree renames or moves it', async () => {
  const { fixture, page, library } = await pageBeside(TEXT);
  try {
    const tree = await pagesTab(page);
    const row = rowOf(tree);
    await expect(row('Vell')).toBeVisible();
    // a row's menu, the Pages tab shown again first: the pane closes once the pointer leaves it
    const menu = async (name, item) => {
      await pagesTab(page);
      await row(name).click({ button: 'right' });
      await page.locator('.pop-menu').getByRole('menuitem', { name: item }).click();
    };

    // rename, straight after typing
    await caretAt(page, 'west');
    await page.keyboard.type(' bay');
    expect(await page.evaluate(() => window.hoard.paneMarks.state().editing.pending)).toBe(true);
    await menu('Vell', 'Rename page…');
    const field = tree.getByLabel('New title for “Vell”');
    await field.fill('Port');
    await field.press('Enter');
    await expect(tree.locator('.hoard-tree-status')).toHaveText(/^Renamed “Vell” to “Port”\./);
    expect(pageFile(library, 'wiki/Port.html')).toBe('<p data-block="b1">The harbour of Vell faces west bay.</p><p data-block="b2">Its keeper rows at dawn.</p>');
    await expect(page.locator(LINES).nth(0)).toHaveText('The harbour of Vell faces west bay.');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Port.html');
    await expect(page.locator(paneAlert)).toHaveText('');

    // move, and type in the page while the move is under way
    await menu('Port', 'Move page…');
    const folder = tree.getByLabel(/^Folder in wiki to move/);
    await folder.fill('Places');
    await folder.press('Enter');
    await caretAt(page, 'keeper');
    await page.keyboard.type(' old');
    // saved at once, as a blur would, while the move may still be under way
    await page.evaluate(() => { window.hoard.paneMarks.flush(); });
    await expect(tree.locator('.hoard-tree-status')).toHaveText(/^Moved “Port”/);
    await expect.poll(() => pageFile(library, 'wiki/Places/Port.html')).toBe('<p data-block="b1">The harbour of Vell faces west bay.</p><p data-block="b2">Its keeper old rows at dawn.</p>');
    expect(await page.evaluate(() => window.hoard.wiki.pane.currentPage())).toBe('wiki/Places/Port.html');
    await expect(page.locator(paneAlert)).toHaveText('');

    // typing after the move is saved under the new id
    await caretAt(page, 'dawn');
    await page.keyboard.type(' and dusk');
    await expect.poll(() => pageFile(library, 'wiki/Places/Port.html')).toBe('<p data-block="b1">The harbour of Vell faces west bay.</p><p data-block="b2">Its keeper old rows at dawn and dusk.</p>');
  } finally {
    await fixture.close();
  }
});
