import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';
import path from 'node:path';
import { access, readFile, stat, writeFile } from 'node:fs/promises';

// Rules about a chapter's file that hold for upstream Neo too: a chapter
// that did not change is not written, a save is not news to the same
// device, a change made outside is adopted, and undoing a delete brings the
// file back. The bytes themselves are checked in chapter-bytes.spec.mjs.
const F = '<p>First line.</p><p>Second line.</p><p>Third line.</p>';
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
    const theirs = '<p>First line.</p><p>Second line.</p><p>Third line, from the other device.</p>';
    await writeFile(file, theirs);
    await fixture.page.evaluate(() => refreshFromDisk());
    await expect(fixture.page.locator('.chapter-body p').nth(2)).toHaveText('Third line, from the other device.');
    const adopted = await onDisk(file);
    await flush(fixture.page);
    expect(await onDisk(file)).toEqual(adopted);
    expect(adopted.text).toBe(theirs);
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
