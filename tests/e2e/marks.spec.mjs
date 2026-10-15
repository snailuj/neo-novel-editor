import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// The milestone Comment-Survives-Reopen. Rules: a comment on a passage is kept in the
// library's .neo/ folder, drawn on the words it quotes, and committed with the chapter
// under the writer's name; it stays on those words through edits around it and a
// restart; a comment whose words are gone is listed as such, never dropped, and comes
// back with them; the Comments section names who wrote the caret's paragraph.

const CHAPTER = 'chapter-synthetic';
const TEXT = '<p>The tide came in at dusk.</p><p>Mara counted the boats twice.</p>';

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
const atHead = (library, file) => { try { return git(library, 'show', `HEAD:${file}`); } catch { return ''; } };
const sidecar = (library, bookId) => path.join(library, '.neo', bookId, 'chapters', `${CHAPTER}.json`);
const readMarks = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).marks : []);
const drawnText = (page, name) => page.evaluate((key) => [...(CSS.highlights.get(key) ?? [])].map((r) => r.toString()), `plugin-hoard-${name}`);

async function ready(page) {
  await page.waitForFunction(() => !!window.hoard);
  await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');
}

// Selects `words` inside the paragraph that holds them, as a writer's drag would.
async function select(page, words) {
  await page.evaluate((words) => {
    const p = [...document.querySelectorAll('.chapter-body p')].find((el) => el.textContent.includes(words));
    const node = p.firstChild;
    const at = node.textContent.indexOf(words);
    p.closest('.chapter-body').focus();
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + words.length);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }, words);
  await page.waitForFunction((n) => window.hoard.marks.state().here?.len === n, words.length);
}

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

test('a comment survives edits around it, a commit and a restart, and takes a reply after', async () => {
  const { profile, library } = await trackedProfile();
  let fixture = await launchProfile(profile);
  let bookId;
  try {
    await ready(fixture.page);
    bookId = await seedBook(fixture.page, TEXT);
    const { app, page } = fixture;
    await select(page, 'counted');
    await menu(app, 'Add Comment');
    const box = page.locator('.hoard-composer textarea');
    await expect(box).toBeFocused();
    await expect(page.locator('.hoard-composer .s-ch')).toHaveText('On “counted”');
    await expect(page.getByLabel(/Your comment/)).toBeFocused();
    await box.fill('Which boats?');
    await box.press('Control+Enter');

    await expect.poll(() => readMarks(sidecar(library, bookId)).length).toBe(1);
    const [made] = readMarks(sidecar(library, bookId));
    expect(made.anchor.exact).toBe('counted');
    expect(made.thread.map((e) => [e.who, e.body])).toEqual([['author', 'Which boats?']]);
    await expect.poll(() => drawnText(page, 'comment')).toEqual(['counted']);
    await expect(page.locator('.hoard-composer')).toBeHidden();

    // a new first paragraph, and words added in the comment's own paragraph
    await page.locator('.chapter-body p').first().click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('Before all.');
    await page.keyboard.press('Enter');
    await page.locator('.chapter-body p').nth(2).click();
    await page.keyboard.press('Home');
    await page.keyboard.insertText('So ');
    await expect.poll(() => drawnText(page, 'comment')).toEqual(['counted']);

    // the pause commits the chapter and the sidecar together, under the writer's name
    await expect.poll(() => atHead(library, `${bookId}/chapters/${CHAPTER}.html`), { timeout: 15_000 }).toContain('So Mara counted');
    expect(JSON.parse(atHead(library, `.neo/${bookId}/chapters/${CHAPTER}.json`)).marks[0].id).toBe(made.id);
    expect(git(library, 'log', '-1', '--format=%an', '--', `.neo/${bookId}`).trim()).toBe('Ada Author');

    await fixture.close({ remove: false });
    fixture = await launchProfile(profile);
    await ready(fixture.page);
    await fixture.page.evaluate((id) => openBook(id), bookId);
    const again = fixture.page;
    await expect.poll(() => drawnText(again, 'comment')).toEqual(['counted']);
    await select(again, 'counted');
    expect(await again.evaluate(() => window.hoard.marks.state().active)).toBe(made.id);
    expect(await again.evaluate(() => window.hoard.marks.show())).toBe(true);
    const card = again.locator(`.hoard-mark[data-mark="${made.id}"]`);
    await expect(card).toContainText('Which boats?');
    await expect(card).toHaveClass(/active/);
    // the section names who wrote the caret's paragraph, from the history
    await expect(again.locator('.hoard-blame')).toContainText('Ada Author');

    await card.hover();
    await card.locator('.hoard-reply').fill('The ones at the quay.');
    await card.locator('.hoard-reply').press('Control+Enter');
    await expect.poll(() => readMarks(sidecar(library, bookId))[0]?.thread.map((e) => e.body))
      .toEqual(['Which boats?', 'The ones at the quay.']);
    await expect(card).toContainText('The ones at the quay.');
  } finally {
    await fixture.close();
  }
});

test('a comment whose words are deleted is listed as not found, and comes back with an undo', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await ready(page);
    const bookId = await seedBook(page, TEXT);
    await select(page, 'boats');
    await menu(app, 'Add Comment');
    await page.locator('.hoard-composer textarea').fill('Count them.');
    await page.locator('.hoard-composer textarea').press('Control+Enter');
    await expect.poll(() => drawnText(page, 'comment')).toEqual(['boats']);
    const [{ id }] = readMarks(sidecar(library, bookId));

    await select(page, 'boats');
    await page.keyboard.press('Backspace');
    await expect.poll(() => page.evaluate(() => window.hoard.marks.state().stale)).toEqual({ [CHAPTER]: [id] });
    await expect.poll(() => drawnText(page, 'comment')).toEqual([]);
    const card = page.locator(`.hoard-mark[data-mark="${id}"]`);
    await expect(card).toContainText('Not found:');
    await expect(card).toContainText('Count them.');
    expect(readMarks(sidecar(library, bookId)).map((m) => m.id)).toEqual([id]);

    await page.keyboard.press('Control+z');
    await expect.poll(() => drawnText(page, 'comment')).toEqual(['boats']);
    await expect(card).not.toContainText('Not found:');
  } finally {
    await fixture.close();
  }
});

// Repeated gestures: a second Add Comment keeps the open comment and its words; adding,
// resolving and replying twice before the first answer lands does each once.
test('each action runs once however often it is asked for before it lands', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await ready(page);
    const bookId = await seedBook(page, TEXT);
    await select(page, 'tide');
    await menu(app, 'Add Comment');
    const box = page.getByLabel(/Your comment/);
    await box.fill('High water.');
    await select(page, 'dusk');
    await menu(app, 'Add Comment');
    await expect(box).toBeFocused();
    await expect(box).toHaveValue('High water.');
    await expect(page.locator('.hoard-composer .s-ch')).toHaveText('On “tide”');

    // the button, then the keys, before the first add has its answer
    await page.evaluate(() => {
      const add = [...document.querySelectorAll('.hoard-composer button')].find((b) => b.textContent === 'Add comment');
      const text = document.querySelector('.hoard-composer textarea');
      const keys = () => text.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      add.click();
      keys();
      keys();
    });
    await expect.poll(() => readMarks(sidecar(library, bookId)).length).toBe(1);
    await page.waitForTimeout(500);
    expect(readMarks(sidecar(library, bookId)).length).toBe(1);
    const [{ id }] = readMarks(sidecar(library, bookId));

    const card = page.locator(`.hoard-mark[data-mark="${id}"]`);
    await card.locator('.hoard-reply').fill('Twice?');
    await card.evaluate((node) => {
      const [reply, resolve] = node.querySelectorAll('.s-actions button');
      reply.click();
      reply.click();
      resolve.click();
    });
    await expect.poll(() => readMarks(sidecar(library, bookId))[0].thread.length).toBe(2);
    await card.evaluate((node) => {
      const resolve = node.querySelectorAll('.s-actions button')[1];
      resolve.click();
      resolve.click();
    });
    await expect.poll(() => readMarks(sidecar(library, bookId))[0].state).toBe('resolved');
    await page.waitForTimeout(500);
    expect(readMarks(sidecar(library, bookId))[0].history.map((h) => h.state)).toEqual(['resolved']);
    await expect(card.locator('.s-actions button').nth(1)).toHaveText('Reopen');
    await expect(page.getByRole('status')).toContainText('Comment resolved');
  } finally {
    await fixture.close();
  }
});
