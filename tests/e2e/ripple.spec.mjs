import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile } from '../support/electron-profile.mjs';

// Step 10, Ripple-Runs-In-App, on pages as files: "a change to a page ripples to the pages
// it touches, and the rulings log records each ruling". Rules: Run Ripple starts watching
// the library; a page that comes in (a page-imported line in the change log) gets a packet
// at the next run; the judge's answer, read at the next run, shows as a card in the
// Ripple section; Apply writes the librarian's wiki page in its own file and the ruling
// goes in the log, with the next hop's job for the page it changed. Ripple This Page with
// no page open in the side pane says so.
//
// Stage 5 adds the pane's currentPage(); until it lands the command cannot be given a page,
// so the flow that asks about an open page is skipped below, with its reason.

const SIDECAR = JSON.stringify({
  version: 1, source: { path: '/v/Harbour.md', name: 'Harbour', sha256: 'a'.repeat(64) }, frontmatter: { type: 'lore' }, imported: '2026-11-01T12:00:00.000Z',
});

async function profileWithPages() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(path.join(library, 'wiki'), { recursive: true });
  await mkdir(path.join(library, 'sources'), { recursive: true });
  await mkdir(path.join(library, '.neo', 'pages', 'wiki'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, moreFeatures: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  await writeFile(path.join(library, 'wiki', 'Harbour.html'), '<p data-block="a1">The harbour wall is made of timber.</p>');
  await writeFile(path.join(library, '.neo', 'pages', 'wiki', 'Harbour.html.json'), SIDECAR);
  await writeFile(path.join(library, 'wiki', 'Lighthouse.html'), '<p data-block="b1">The keeper lives above the [[Harbour]].</p>');
  await writeFile(path.join(library, 'sources', 'Field Notes.html'), '<p data-block="c1">Notes on the harbour wall.</p>');
  return { profile, library };
}

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

async function openANovel(page) {
  await page.evaluate(async () => {
    const meta = await neo.createBook({ title: 'Novel', author: 'Test author' });
    meta.chapterOrder = ['c1'];
    meta.chapterTitles = { c1: 'The Storm' };
    await neo.writeBookMeta(meta.id, meta);
    await neo.writeChapter(meta.id, 'c1', '<p>A chapter.</p>');
    const lib = await neo.readLibrary();
    lib.shelves[0].bookIds.push(meta.id);
    await neo.writeLibrary(lib);
    await openBook(meta.id);
  });
}

test('a page that comes in ripples to the wiki page it touches, on the author\'s word, and the log keeps the ruling', async () => {
  const { profile, library } = await profileWithPages();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await openANovel(page);

    await menu(app, 'Run Ripple');
    const section = page.locator('.hoard-ripple');
    await expect(section.locator('.hoard-status')).toContainText('watching the library');

    await writeFile(path.join(library, 'wiki', 'Long Storm.html'), '<p data-block="d1">The long storm broke the [[Harbour]] wall. After the storm the harbour wall was rebuilt in stone.</p>');
    await writeFile(path.join(library, '.neo', 'changes.jsonl'), `${JSON.stringify({ version: 1, at: '2026-11-01T12:00:00.000Z', kind: 'page-imported', page: 'wiki/Long Storm.html', src: '/v/Long Storm.md' })}\n`);
    await section.getByRole('button', { name: 'Run Ripple' }).click();
    await expect(section.locator('.hoard-ripple-jobs li')).toHaveText(['Long Storm']);
    const ripple = path.join(library, '.neo', 'ripple');
    const job = (JSON.parse((await readFile(path.join(ripple, 'rulings.jsonl'), 'utf8')).trim().split('\n').filter((l) => l.includes('"type":"job"')).at(-1)).id);
    const packet = await readFile(path.join(ripple, 'packets', `${job}.md`), 'utf8');
    expect(packet).toContain('file: wiki/Harbour.html');
    expect(packet).toContain('tree: sources');
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
    expect(await readFile(path.join(library, 'wiki', 'Harbour.html'), 'utf8')).toContain('The harbour wall is rebuilt in stone.');
    const log = (await readFile(path.join(ripple, 'rulings.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const ruled = log.filter((r) => r.type === 'proposal').at(-1);
    expect([ruled.status, ruled.outcome, ruled.target]).toEqual(['applied', 'written', 'Harbour']);
    expect(log.some((r) => r.type === 'job' && r.hop === 1 && r.source.page === 'wiki/Harbour.html')).toBe(true);
  } finally {
    await fixture.close();
  }
});

test('Ripple This Page with no page open in the side pane says so and makes no job', async () => {
  const { profile, library } = await profileWithPages();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await openANovel(page);
    await menu(app, 'Ripple This Page');
    await expect(page.locator('.hoard-ripple .hoard-alert')).toContainText('No page is open in the side pane');
    await expect(page.locator('.hoard-ripple-jobs li')).toHaveCount(0);
    await expect(readFile(path.join(library, '.neo', 'ripple', 'rulings.jsonl'), 'utf8')).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

// Needs stage 5: the pane's currentPage() gives Ripple This Page the page open in it.
test.skip('Ripple This Page packets the page open in the side pane (needs stage 5\'s currentPage)', async () => {});
