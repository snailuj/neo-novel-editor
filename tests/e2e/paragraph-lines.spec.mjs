import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';
import path from 'node:path';
import { access, readFile, stat, writeFile } from 'node:fs/promises';

// F: a chapter file kept one paragraph per line
const F_LINES = ['<p>First line.</p>', '<p>Second line.</p>', '<p>Third line.</p>'];
const F = F_LINES.join('\n') + '\n';
const CHAPTER = 'chapter-synthetic';

const chapterFile = (fixture, bookId, chId = CHAPTER) =>
  path.join(fixture.profile, 'documents', 'NEO Library', bookId, 'chapters', chId + '.html');

async function onDisk(file) {
  return { text: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs };
}

// flushAllSaves, then every chapter write it started, to the end. The pause
// first means a rewrite of the same bytes would still carry a later mtime.
const flush = (page) => page.evaluate(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  flushAllSaves();
  await Promise.all(Object.values(chapterChain));
});

async function typeAtEndOf(page, index, text) {
  await page.locator('.chapter-body p').nth(index).click();
  await page.keyboard.press('End');
  if (text) await page.keyboard.insertText(text);
}

const everyParagraphStartsALine = (text) => expect(text).not.toMatch(/[^\n]<p[\s>]/);

test('untouched book writes nothing', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    const before = await onDisk(file);
    await flush(fixture.page);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(before);
    expect(before.text).toBe(F);
  } finally { await fixture.close(); }
});

test('an edit rewrites one line', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 1, ' Typed.');
    await flush(fixture.page);
    const { text } = await onDisk(chapterFile(fixture, bookId));
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(F_LINES[0]);
    expect(lines[1]).toContain('Typed.');
    expect(lines[2]).toBe(F_LINES[2]);
    everyParagraphStartsALine(text);
    expect(text.endsWith('\n')).toBe(true);
  } finally { await fixture.close(); }
});

test('Enter makes its own line', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 1, '');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('New line.');
    await flush(fixture.page);
    const { text } = await onDisk(chapterFile(fixture, bookId));
    expect(text.split('\n')).toEqual([F_LINES[0], F_LINES[1], '<p>New line.</p>', F_LINES[2], '']);
  } finally { await fixture.close(); }
});

test('reopen round trip', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    await typeAtEndOf(fixture.page, 1, ' Typed.');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('New line.');
    await flush(fixture.page);
    const saved = await onDisk(file);
    everyParagraphStartsALine(saved.text);
    await fixture.page.evaluate(async (id) => { await backToShelf(); await openBook(id); }, bookId);
    await flush(fixture.page);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(saved);
    expect(await fixture.page.evaluate(() => captureBody(document.querySelector('.chapter-body')))).toBe(saved.text);
  } finally { await fixture.close(); }
});

test('own save is not news', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 1, ' Typed.');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('New line.');
    await flush(fixture.page);
    const read = () => fixture.page.evaluate(() => ({ order: [...book.chapterOrder], darlings: JSON.stringify(darlings) }));
    const before = await read();
    await fixture.page.evaluate(() => refreshFromDisk());
    expect(await read()).toEqual(before);
    expect(await fixture.page.locator('#hint').textContent()).not.toContain('Updated from your other device');
  } finally { await fixture.close(); }
});

test('outside edit is adopted', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    const theirs = [F_LINES[0], F_LINES[1], '<p>Third line, from the other device.</p>', ''].join('\n');
    await writeFile(file, theirs);
    await fixture.page.evaluate(() => refreshFromDisk());
    await expect(fixture.page.locator('.chapter-body p').nth(2)).toHaveText('Third line, from the other device.');
    const adopted = await onDisk(file);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(adopted);
    expect(adopted.text).toBe(theirs);
  } finally { await fixture.close(); }
});

test('no rewrite loop', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    // a compact chapter, as keepOtherDeviceVersion leaves it in chapterHTML
    const twinId = await fixture.page.evaluate(async (chId) => {
      await keepOtherDeviceVersion(book.id, chId, '<p>Other one.</p><p>Other two.</p>');
      return book.chapterOrder[book.chapterOrder.indexOf(chId) + 1];
    }, CHAPTER);
    const file = chapterFile(fixture, bookId, twinId);
    const written = await onDisk(file);
    expect(written.text).toBe('<p>Other one.</p>\n<p>Other two.</p>\n');
    await flush(fixture.page);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(written);
  } finally { await fixture.close(); }
});

// deleteChapterQuiet leaves savedHTML as it was, so a save that skipped text
// equal to savedHTML would leave the undone chapter without a file
test('undo of a quiet chapter delete writes the file back', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, F);
    const file = chapterFile(fixture, bookId);
    await fixture.page.evaluate(async (chId) => {
      createChapterAt(book.chapterOrder.length); // the book keeps a chapter
      await Promise.all(Object.values(chapterChain));
      snapshotStructure('chapter delete');
      await deleteChapterQuiet(chId);
    }, CHAPTER);
    await expect(access(file)).rejects.toThrow();
    await fixture.page.evaluate(() => structuralUndo());
    await flush(fixture.page);
    expect(await fixture.page.evaluate(() => book.chapterOrder)).toContain(CHAPTER);
    expect((await onDisk(file)).text).toBe(F);
  } finally { await fixture.close(); }
});

// Enter twice makes a section break and a third splits the chapter. The
// split's undo saves the chapter, which lines the page's copy, while the
// break's undo still holds the copy as typed: the two differ only in line
// breaks, so the second undo must not take the chapter for one changed since.
test('undoing a break and a split sends nothing to Darlings', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, F);
    await typeAtEndOf(fixture.page, 2, '');
    for (let i = 0; i < 3; i++) await fixture.page.keyboard.press('Enter');
    expect(await fixture.page.evaluate(() => [book.chapterOrder.length, undoStack.length])).toEqual([2, 2]);
    for (const left of [1, 0]) {
      await fixture.page.keyboard.press('Control+z');
      await expect.poll(() => fixture.page.evaluate(() => undoStack.length)).toBe(left);
    }
    await fixture.page.evaluate(() => Promise.all(Object.values(chapterChain)));
    expect(await fixture.page.evaluate(() => ({ order: book.chapterOrder, darlings }))).toEqual({ order: [CHAPTER], darlings: [] });
  } finally { await fixture.close(); }
});
