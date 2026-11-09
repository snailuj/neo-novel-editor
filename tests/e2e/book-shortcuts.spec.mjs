import { test, expect } from '@playwright/test';
import { launchProfile } from '../support/electron-profile.mjs';

// Book-only keys and actions. Rule for all of them: a key or action that acts on the book does
// nothing to the book while the caret is in the page column (split-view.md, Book-Shortcuts). Each
// spec first fires the key with the caret in the book, so the key is known to do its work, and
// then with the caret in a contenteditable the v6 fixture plugin puts in the column.

const FIXTURES = 'tests/fixtures/plugins';

async function start() {
  const fixture = await launchProfile(undefined, { env: { NEO_PLUGIN_DIRS: `${FIXTURES}/v6` } });
  const { page } = fixture;
  await page.evaluate(async () => {
    const meta = await neo.createBook({ title: 'Synthetic book', author: 'Test author' });
    meta.chapterOrder = ['chapter-a', 'chapter-b', 'chapter-c'];
    await neo.writeBookMeta(meta.id, meta);
    for (const id of meta.chapterOrder) await neo.writeChapter(meta.id, id, `<p>Text of ${id}. A second sentence.</p>`);
    const lib = await neo.readLibrary();
    lib.firstRunDone = true;
    lib.shelves[0].bookIds.push(meta.id);
    await neo.writeLibrary(lib);
    await openBook(meta.id);
  });
  await page.waitForFunction(() => window.__column?.handle && document.querySelectorAll('.chapter-body').length === 3);
  await page.evaluate(() => { window.__column.handle.open(); });
  await page.waitForFunction(() => NeoSplit.isOpen());
  return fixture;
}

const where = (page) => page.evaluate(() => (document.activeElement.closest('#split-column') ? 'column' : document.activeElement.closest('#paper-scroll') ? 'book' : document.activeElement.tagName));
const inBook = async (page, chapter = 'chapter-a') => {
  await page.locator(`.chapter[data-id="${chapter}"] .chapter-body p`).click();
  await page.evaluate((id) => { currentChapterId = id; }, chapter);
  expect(await where(page), 'the caret really is in the book').toBe('book');
};
const inColumn = async (page) => {
  await page.locator('#fixture-edit').click();
  expect(await where(page), 'the caret really is in the column').toBe('column');
};
const chapterNow = (page) => page.evaluate(() => currentChapterId);

const JUMPS = [
  { name: 'Ctrl+Alt+ArrowDown', key: 'Control+Alt+ArrowDown', step: 1 },
  { name: 'Ctrl+PageDown', key: 'Control+PageDown', step: 1 },
  { name: 'Ctrl+Alt+ArrowUp', key: 'Control+Alt+ArrowUp', step: -1 },
  { name: 'Ctrl+PageUp', key: 'Control+PageUp', step: -1 },
];

test('chapter jump moves the book from the book and does nothing from the column', async () => {
  const { page, close } = await start();
  try {
    for (const jump of JUMPS) {
      const from = jump.step > 0 ? 'chapter-a' : 'chapter-c';
      const to = 'chapter-b';
      await inBook(page, from);
      await page.keyboard.press(jump.key);
      await expect.poll(() => chapterNow(page), `${jump.name} from the book`).toBe(to);

      await inBook(page, from);
      await inColumn(page);
      await page.waitForTimeout(300);
      // where the book stands once the caret is in the column; the key must not change it
      const before = await chapterNow(page);
      expect(before, 'not at the end the key would run into, which would pass for nothing').not.toBe(jump.step > 0 ? 'chapter-c' : 'chapter-a');
      await page.keyboard.press(jump.key);
      await page.waitForTimeout(300);
      expect(await chapterNow(page), `${jump.name} from the column`).toBe(before);
      expect(await where(page), `${jump.name}: the caret stays in the column`).toBe('column');
    }
  } finally { await close(); }
});

test('Read Aloud starts from the book and does not start from the column', async () => {
  const { page, close } = await start();
  try {
    const key = 'Control+Shift+K'; // Linux; the other systems use U
    // no voice in the test machine: the host would wait four seconds for one, and the voice's own
    // answer is not what is under test
    await page.evaluate(() => {
      library.moreFeatures = true; // Read Aloud is one of the extra features
      window.readVoicesReady = async () => true;
      speechSynthesis.speak = () => {};
    });
    await inBook(page);
    await page.keyboard.press(key);
    await expect.poll(() => page.evaluate(() => !!reading), 'Read Aloud starts from the book').toBe(true);
    await page.evaluate(() => stopReadAloud(false));
    expect(await page.evaluate(() => !!reading)).toBe(false);

    await inColumn(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => !!reading), 'not from the column').toBe(false);
  } finally { await close(); }
});

test('typing in the column leaves the book\'s structural redo, and its redo key, alone', async () => {
  const { page, close } = await start();
  try {
    const makeRedo = () => page.evaluate(async () => {
      snapshotStructure('test');
      await structuralUndo();
      return redoStack.length;
    });
    const redoLength = () => page.evaluate(() => redoStack.length);
    // the baseline: there is a redo to protect, and typing in the book clears it
    expect(await makeRedo()).toBe(1);
    await inBook(page);
    await page.keyboard.type('x');
    expect(await redoLength(), 'typing in the book ends the redo').toBe(0);

    expect(await makeRedo()).toBe(1);
    await inColumn(page);
    await page.keyboard.type('y');
    expect(await page.locator('#fixture-edit').textContent(), 'the typing really landed in the column').toContain('y');
    expect(await redoLength(), 'typing in the column does not').toBe(1);

    // the redo key does not redo the book from the column
    await page.evaluate(() => { window.__redoCalls = 0; const real = window.structuralRedo; window.structuralRedo = (...a) => { window.__redoCalls++; return real(...a); }; });
    await page.keyboard.press('Control+Shift+Z');
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => window.__redoCalls), 'Ctrl+Shift+Z in the column').toBe(0);
    expect(await redoLength()).toBe(1);

    // and it still works from the book
    await inBook(page);
    await page.keyboard.press('Control+Shift+Z');
    await expect.poll(() => page.evaluate(() => window.__redoCalls), 'Ctrl+Shift+Z in the book').toBe(1);
    expect(await redoLength()).toBe(0);
  } finally { await close(); }
});

test('Find seeds its box from a selection in the book and not from one in the column', async () => {
  const { app, page, close } = await start();
  try {
    const find = () => app.evaluate(({ Menu }) => {
      const walk = (items) => items.flatMap((item) => [item, ...(item.submenu ? walk(item.submenu.items) : [])]);
      walk(Menu.getApplicationMenu().items).find((i) => i.accelerator === 'CmdOrCtrl+F').click();
      return true;
    });
    const select = (selector) => page.evaluate((sel) => {
      const el = document.querySelector(sel);
      el.closest('[contenteditable="true"]').focus();
      const r = document.createRange();
      r.selectNodeContents(el.firstChild);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      document.querySelector('#search-input').value = '';
    }, selector);
    const box = () => page.evaluate(() => ({ shown: !document.querySelector('#searchbar').hidden, value: document.querySelector('#search-input').value }));

    await select('.chapter[data-id="chapter-a"] .chapter-body p');
    await find();
    await expect.poll(() => box(), 'Find opens with the book\'s selection').toEqual({ shown: true, value: 'Text of chapter-a. A second sentence.' });
    await page.evaluate(() => closeSearch());

    await select('#fixture-edit');
    expect(await where(page)).toBe('column');
    await find();
    await expect.poll(() => page.evaluate(() => !document.querySelector('#searchbar').hidden), 'Find still opens').toBe(true);
    expect((await box()).value, 'but is not seeded from the column').toBe('');
  } finally { await close(); }
});
