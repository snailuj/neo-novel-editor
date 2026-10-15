import { test, expect } from '@playwright/test';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

test('isolated profile, literal Unicode, editing, and save/reopen', async () => {
  let fixture = await launchProfile();
  const { profile } = fixture;
  try {
    const observed = await fixture.app.evaluate(({ app }) => ({ documents: app.getPath('documents'), userData: app.getPath('userData'), versions: process.versions }));
    expect(observed.documents).toBe(path.join(profile, 'documents'));
    expect(observed.userData).toBe(path.join(profile, 'userData'));
    expect(await fixture.page.evaluate(() => neo.libraryPath())).toBe(path.join(profile, 'documents', 'NEO Library'));
    console.log(JSON.stringify({ runtime: observed.versions }));
    const bookId = await seedBook(fixture.page);
    const body = fixture.page.locator('.chapter-body').first();
    await expect(body).toContainText('Synthetic Māia & A😀é.');
    await body.click();
    await fixture.page.keyboard.press('Control+End');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.insertText('Second paragraph.');
    await expect(body).toContainText('Second paragraph.');
    await fixture.page.evaluate(async () => { flushAllSaves(); await Promise.all(book.chapterOrder.map(id => persistChapter(id))); });
    const saved = await fixture.page.evaluate((id) => neo.readChapter(id, 'chapter-synthetic'), bookId);
    expect(saved).toContain('Second paragraph.');
    await fixture.close({ remove: false });
    fixture = await launchProfile(profile);
    await fixture.page.evaluate((id) => openBook(id), bookId);
    await expect(fixture.page.locator('.chapter-body').first()).toContainText('Second paragraph.');
    await expect(fixture.page.locator('.chapter-body').first()).toContainText('Synthetic Māia & A😀é.');
  } finally { await fixture.close(); }
});

test('outline editing, Darlings remove/restore, selection, and chapter creation', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page, '<p>One paragraph.</p><p class="scene-break">***</p><p>Second scene.</p>');
    const result = await fixture.page.evaluate(async (id) => {
      const paragraph = document.querySelector('.chapter-body p');
      const range = document.createRange();
      range.setStart(paragraph.firstChild, 4); range.setEnd(paragraph.firstChild, 13);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const selected = getSelection().toString();
      await moveSelectionToDarlings(selected, selected);
      const removed = paragraph.textContent;
      const savedDarling = (await neo.readJSON(id, 'darlings', []))[0];
      await restoreDarling(savedDarling.id);
      const restored = paragraph.textContent;
      newChapter();
      await saveMeta();
      return { selected, removed, restored, order: (await neo.readBookMeta(id)).chapterOrder };
    }, bookId);
    expect(result.selected).toBe('paragraph');
    expect(result.removed).toBe('One .');
    expect(result.restored).toBe('One paragraph.');
    expect(result.order).toHaveLength(2);
    await fixture.page.locator('.tab[data-tab="notes"]').click();
    // the tab opens the current chapter's notes; these are the book's
    // the nav pane can be shut at this width, so click through the DOM
    await fixture.page.locator('.notes-book').evaluate((el) => el.click());
    await fixture.page.locator('#aux-editor').fill('Note Māia');
    await fixture.page.evaluate(() => flushAux());
    await expect.poll(() => fixture.page.evaluate((id) => neo.readAux(id, 'notes'), bookId)).toContain('Note Māia');
    await fixture.page.locator('.tab[data-tab="manuscript"]').click();
    await fixture.page.locator('.tab[data-tab="outline"]').click();
    await fixture.page.locator('.ol-line.ol-chapter[data-ch-id="chapter-synthetic"] .ol-text').fill('Outline Māia');
    await fixture.page.locator('.tab[data-tab="manuscript"]').click();
    await fixture.page.evaluate(() => saveMeta());
    expect((await fixture.page.evaluate((id) => neo.readBookMeta(id), bookId)).chapterNotes['chapter-synthetic']).toBe('Outline Māia');
    await fixture.page.locator('.tab[data-tab="manuscript"]').click();
    await fixture.page.evaluate(() => openSearch());
    await fixture.page.locator('#search-input').fill('paragraph');
    await expect(fixture.page.locator('#search-count')).not.toHaveText('');
  } finally { await fixture.close(); }
});

test('placeholder editing, goals, scene break and punctuation gestures', async () => {
  const fixture = await launchProfile();
  try {
    const bookId = await seedBook(fixture.page);
    await fixture.page.evaluate(() => { focusChapter('chapter-synthetic'); insertPlaceholder(); });
    const sticky = fixture.page.locator('.sticky textarea').first();
    await sticky.fill('Research this passage');
    await fixture.page.keyboard.press('Enter');
    await fixture.page.evaluate(() => flushStickiesSave());
    await expect.poll(() => fixture.page.evaluate((id) => neo.readJSON(id, 'stickies', []), bookId)).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'Research this passage' })]));
    await fixture.page.locator('#goal-counter').click();
    await fixture.page.locator('#st-book').fill('80000');
    await fixture.page.locator('.m-ok').click();
    await fixture.page.evaluate(() => saveMeta());
    expect((await fixture.page.evaluate((id) => neo.readBookMeta(id), bookId)).wordGoal).toBe(80000);
    await fixture.page.evaluate(() => focusChapter('chapter-synthetic'));
    await fixture.page.keyboard.press('Enter');
    await fixture.page.keyboard.press('Enter');
    await expect(fixture.page.locator('.chapter-body .scene-break')).toHaveCount(1);
    await fixture.page.keyboard.insertText('"quoted" -- literal');
    await fixture.page.evaluate(async () => { flushAllSaves(); await persistChapter('chapter-synthetic'); });
    const saved = await fixture.page.evaluate((id) => neo.readChapter(id, 'chapter-synthetic'), bookId);
    expect(await fixture.page.locator('.chapter-body p').last().textContent()).toBe('"quoted" -- literal');
    expect(saved).toContain('scene-break');
    const spelling = await fixture.page.evaluate(() => neo.spellCheckWords(['synthetic', 'zzzxqxq']));
    expect(spelling.zzzxqxq).toBe(false);
    expect(spelling.synthetic).toBe(true);
  } finally { await fixture.close(); }
});

test('publication builders retain synthetic Unicode and scene content', async () => {
  const fixture = await launchProfile();
  try {
    await seedBook(fixture.page, '<p>Māia A😀é &amp; B.</p><p class="scene-break">***</p><p>Second scene.</p>');
    const exports = await fixture.page.evaluate(async () => {
      const data = bookExportData();
      const epub = await buildEpubEntries(data);
      const docx = buildDocxEntries(data);
      const pdfPath = await neo.exportSave({ format: 'pdf', defaultName: 'synthetic', content: buildHtml(data) });
      return { text: buildTxt(data), markdown: buildMd(data), html: buildHtml(data), docx: JSON.stringify(docx), epub: JSON.stringify(epub), pdfPath };
    });
    for (const format of ['text', 'markdown', 'html', 'docx', 'epub']) {
      expect(exports[format]).toContain('Māia');
      expect(exports[format]).toContain('Second scene.');
    }
    expect(exports.pdfPath).toBe(path.join(fixture.profile, 'exports', 'synthetic.pdf'));
    expect((await readFile(exports.pdfPath)).subarray(0, 5).toString()).toBe('%PDF-');
  } finally { await fixture.close(); }
});
