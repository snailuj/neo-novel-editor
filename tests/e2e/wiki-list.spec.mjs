import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile } from '../support/electron-profile.mjs';

// Step 9, the old vault import. Rules: an import list brings pages from anywhere on the
// disk into the wiki, under the names it gives and with the sections it cuts out of a
// page; a page hoard already holds stays out, and the writer is told why; a page's
// image is copied into the wiki book; a changed source updates a page NEO has not
// changed; and each import is committed.

const sha = (text) => createHash('sha256').update(text).digest('hex');
const HUB = '---\ntype: project\n---\n# Tide\n## Overview\nThe era of tides.\n## Tasks\n- [ ] a task\n';

async function profileWithVaults() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  const hoard = path.join(profile, 'hoard');
  const old = path.join(profile, 'old vault');
  for (const dir of [library, path.join(profile, 'userData'), path.join(hoard, '_meta'), path.join(hoard, 'lore'), path.join(hoard, 'projects'),
    path.join(old, '.obsidian'), path.join(old, '20_Atoms'), path.join(old, '_attachments')]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  await writeFile(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ plugins: { hoard: { git: { idleSeconds: 1 } } } }));
  await writeFile(path.join(profile, '.gitconfig'), '[user]\n\tname = Ada Author\n\temail = ada@example.com\n');
  execFileSync('git', ['init', '-q'], { cwd: library });

  await writeFile(path.join(hoard, '_meta', 'MANIFEST.jsonl'),
    `${JSON.stringify({ src: '20_Atoms/Harbour.md', dest: 'lore/Harbour.md', method: 'verbatim', src_sha256: sha('The harbour.\n') })}\n`);
  await writeFile(path.join(hoard, 'lore', 'Harbour.md'), 'The harbour.\n');
  await writeFile(path.join(hoard, 'projects', 'tide-(project).md'), HUB);
  await writeFile(path.join(old, '20_Atoms', 'Harbour.md'), 'The harbour.\n');
  await writeFile(path.join(old, '20_Atoms', 'Quay.md'), 'The quay: ![[Quay Map.png]]\n');
  await writeFile(path.join(old, '_attachments', 'Quay Map.png'), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const list = path.join(profile, 'move.txt');
  await writeFile(list, [
    '# synthetic import list',
    'old vault/20_Atoms/Harbour.md',
    'old vault/20_Atoms/Quay.md -> Quay-(place)',
    'hoard/projects/tide-(project).md#Overview -> tide-(era)',
  ].join('\n'));
  return { profile, library, hoard, old, list };
}

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

// The file picker answers with `files`; every message box with its first button, or
// with Close where it has one and `close` is set; each box written down for the test.
async function answer(app, files, close = false) {
  await app.evaluate(({ dialog }, { files, close }) => {
    globalThis.__boxes = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    dialog.showMessageBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      globalThis.__boxes.push({ message: o.message, detail: o.detail ?? '', buttons: o.buttons ?? [] });
      const at = close ? (o.buttons ?? []).indexOf('Close') : -1;
      return { response: at < 0 ? 0 : at, checkboxChecked: false };
    };
  }, { files, close });
}
const boxes = (app) => app.evaluate(() => globalThis.__boxes);
const git = (library, ...args) => execFileSync('git', args, {
  cwd: library, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});

test('an import list brings pages from an old vault and from hoard into the wiki', async () => {
  const { profile, library, hoard, old, list } = await profileWithVaults();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');

    // hoard's page first, so the wiki knows hoard; Close leaves NEO on the shelf
    await answer(app, [path.join(hoard, 'lore', 'Harbour.md')], true);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => boxes(app).then((b) => b.map((x) => x.message))).toEqual(['Import 1 page into the wiki?', '1 page is in the wiki.']);

    await answer(app, [list]);
    await menu(app, 'Import List to Wiki…');
    await expect.poll(() => boxes(app).then((b) => b.length)).toBe(2);
    const [asked, done] = await boxes(app);
    expect(asked.message).toBe('Import 2 pages into the wiki?');
    expect(asked.detail).toContain('Coming in: Quay-(place), tide-(era).');
    expect(asked.detail).toContain('1 image or PDF the pages show is copied into the wiki.');
    expect(asked.detail).toContain('Already in hoard, so they come in with hoard\'s pages: Harbour.');
    expect(done.message).toBe('2 pages are in the wiki.');
    expect(done.detail).toContain('1 image or PDF was copied into the wiki.');

    await expect.poll(() => page.evaluate(() => book && book.title)).toBe('Wiki');
    const wiki = await page.evaluate(() => ({ id: book.id, titles: book.chapterOrder.map((id) => book.chapterTitles[id]), order: book.chapterOrder }));
    expect(wiki.titles).toEqual(['Harbour', 'Quay-(place)', 'tide-(era)']);
    expect(await page.evaluate((id) => [...document.querySelectorAll(`.chapter[data-id="${id}"] .chapter-body p`)].map((p) => p.textContent), wiki.order[2]))
      .toEqual(['Overview', 'The era of tides.']);
    expect(readFileSync(path.join(library, wiki.id, 'attachments', 'Quay Map.png'))).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    const manifest = readFileSync(path.join(library, '.neo', 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(manifest.map((r) => r.method)).toEqual(['converted', 'verbatim', 'converted', 'split']);
    await expect.poll(() => git(library, 'status', '--porcelain')).toBe('');
    expect(git(library, 'log', '--format=%s')).toContain('Pages imported to the wiki');

    // a changed source updates its page, which NEO has not changed
    await page.evaluate(() => backToShelf());
    await writeFile(path.join(old, '20_Atoms', 'Quay.md'), 'The quay, rebuilt: ![[Quay Map.png]]\n');
    await answer(app, [list], true);
    await menu(app, 'Import List to Wiki…');
    await expect.poll(() => boxes(app).then((b) => b.length)).toBe(2);
    const [again, updated] = await boxes(app);
    expect(again.detail).toContain('Updated from a newer source, since NEO has not changed the page: Quay-(place).');
    expect(updated.detail).toContain('1 page was updated from a newer source.');
    const quay = readFileSync(path.join(library, wiki.id, 'chapters', `${wiki.order[1]}.html`), 'utf8');
    expect(quay).toContain('The quay, rebuilt:');
    expect(existsSync(path.join(library, wiki.id, 'attachments', 'Quay Map (2).png'))).toBe(false);
  } finally {
    await fixture.close();
  }
});
