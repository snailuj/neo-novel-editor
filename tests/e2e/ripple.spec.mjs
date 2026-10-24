import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile } from '../support/electron-profile.mjs';

// Step 10, Ripple-Runs-In-App: "a lore change ripples to the pages it touches, and the
// rulings log records each ruling". Rules: Run Ripple starts watching; Ripple This
// Chapter writes a packet for the chapter at the caret; the judge's answer, read at the
// next run, shows as a card in the Ripple section; Apply writes the librarian's page and
// the ruling goes in the log, with the next hop's job for the page it changed.

async function profileWithVault() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(profile, 'vault'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, moreFeatures: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  const harbour = path.join(profile, 'vault', 'Harbour.md');
  await writeFile(harbour, '---\ntype: lore\n---\nThe harbour wall is made of timber.\n');
  const keeper = path.join(profile, 'vault', 'Lighthouse.md');
  await writeFile(keeper, 'The keeper lives above the [[Harbour]].\n');
  return { profile, library, files: [harbour, keeper] };
}

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

async function answer(app, files) {
  await app.evaluate(({ dialog }, files) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    dialog.showMessageBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      return { response: o.buttons && o.buttons[0].startsWith('Import') ? 0 : 1, checkboxChecked: false };
    };
  }, files);
}

test('a chapter ripples to the wiki page it touches, on the author\'s word, and the log keeps the ruling', async () => {
  const { profile, library, files } = await profileWithVault();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await answer(app, files);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => page.evaluate(() => window.hoard.wiki.pages()?.pages.length ?? 0)).toBe(2);
    const bookId = await page.evaluate(async () => {
      const meta = await neo.createBook({ title: 'Novel', author: 'Test author' });
      meta.chapterOrder = ['c1'];
      meta.chapterTitles = { c1: 'The Storm' };
      await neo.writeBookMeta(meta.id, meta);
      await neo.writeChapter(meta.id, 'c1', '<p>After the storm the harbour wall was rebuilt in stone.</p>');
      const lib = await neo.readLibrary();
      lib.shelves[0].bookIds.push(meta.id);
      await neo.writeLibrary(lib);
      await openBook(meta.id);
      return meta.id;
    });

    await menu(app, 'Run Ripple');
    const section = page.locator('.hoard-ripple');
    await expect(section.locator('.hoard-status')).toContainText('watching the wiki');

    await page.locator('.chapter-body p').first().click();
    await menu(app, 'Ripple This Chapter');
    await expect(section.locator('.hoard-status')).toContainText('packets folder');
    await expect(section.locator('.hoard-ripple-jobs li')).toHaveText(['The Storm']);
    const ripple = path.join(library, '.neo', 'ripple');
    const job = (JSON.parse((await readFile(path.join(ripple, 'rulings.jsonl'), 'utf8')).trim().split('\n').at(-1)).id);
    const packet = await readFile(path.join(ripple, 'packets', `${job}.md`), 'utf8');
    expect(packet).toContain('Harbour');
    const brief = await readFile(path.join(ripple, 'brief.md'), 'utf8');
    const echo = 'When you are unsure, say nothing about the page: the writer would rather miss a ripple than undo a wrong one.';
    expect(brief).toContain(echo);
    expect(packet).not.toContain(echo);
    await writeFile(path.join(ripple, 'inbox', `${job}.jsonl`), [
      { kind: 'preflight', brief_sha256: createHash('sha256').update(brief).digest('hex'), echo },
      { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'The storm brought the wall down.', quote: 'the harbour wall was rebuilt in stone' },
    ].map((l) => JSON.stringify(l)).join('\n'));

    await section.getByRole('button', { name: 'Run Ripple' }).click();
    const card = section.locator('.hoard-ripple-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('del')).toHaveText('made of timber');
    await expect(card.locator('ins')).toHaveText('rebuilt in stone');
    await card.hover();
    await card.getByRole('button', { name: 'Apply' }).click();
    await expect(section.locator('.hoard-status')).toContainText('Harbour is changed');
    await expect(card).toHaveCount(0);
    const wiki = await page.evaluate(() => window.hoard.wiki.pages());
    const harbour = wiki.pages.find((p) => p.title === 'Harbour');
    expect(await readFile(path.join(library, wiki.bookId, 'chapters', `${harbour.chId}.html`), 'utf8')).toContain('The harbour wall is rebuilt in stone.');
    const log = (await readFile(path.join(ripple, 'rulings.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const ruled = log.filter((r) => r.type === 'proposal').at(-1);
    expect([ruled.status, ruled.outcome, ruled.target]).toEqual(['applied', 'written', 'Harbour']);
    expect(log.some((r) => r.type === 'job' && r.hop === 1 && r.source.title === 'Harbour')).toBe(true);
    expect(bookId).not.toBe(wiki.bookId);
  } finally {
    await fixture.close();
  }
});
