import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile } from '../support/electron-profile.mjs';

// The old vault import. Rules: an import list brings pages from anywhere on the disk into
// the library's page files, sources/ unless a `to: wiki` line sends them to wiki/, under
// the names it gives and with the sections it cuts out of a page; a source keeps its
// vault folder; a page hoard already holds stays out, and the writer is told why; a
// page's image is copied into its tree; a changed source updates a page nobody has
// changed; and each import is committed. A list's `book:` line sends the pages after it
// into a NEO book of that title (Morning Pages), opened from the result or from Open
// Imported Book…; a line range takes those lines of a page.

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
    'hoard/lore/Harbour.md',
    'old vault/20_Atoms/Harbour.md',
    'old vault/20_Atoms/Quay.md -> Quay-(place)',
    'to: wiki',
    'hoard/projects/tide-(project).md#Overview -> Eras/tide-(era)',
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
// with Close (or the `close` button named) where it has one and `close` is set; each box
// written down for the test.
async function answer(app, files, close = false) {
  await app.evaluate(({ dialog }, { files, close }) => {
    globalThis.__boxes = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    dialog.showMessageBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      globalThis.__boxes.push({ message: o.message, detail: o.detail ?? '', buttons: o.buttons ?? [] });
      const at = close ? (o.buttons ?? []).indexOf(close === true ? 'Close' : close) : -1;
      return { response: at < 0 ? 0 : at, checkboxChecked: false };
    };
  }, { files, close });
}
const boxes = (app) => app.evaluate(() => globalThis.__boxes);
const git = (library, ...args) => execFileSync('git', args, {
  cwd: library, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});

test('an import list brings pages from an old vault and from hoard into sources and the wiki', async () => {
  const { profile, library, old, list } = await profileWithVaults();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');

    await answer(app, [list], true);
    await menu(app, 'Import List…');
    await expect.poll(() => boxes(app).then((b) => b.length)).toBe(2);
    const [asked, done] = await boxes(app);
    expect(asked.message).toBe('Import 3 pages into sources and the wiki?');
    expect(asked.detail).toContain('Into sources:\n\nComing in: Harbour, Quay-(place).');
    expect(asked.detail).toContain('1 image or PDF the pages show is copied into sources.');
    expect(asked.detail).toContain('Already in hoard, so they come in with hoard\'s pages: Harbour.');
    expect(asked.detail).toContain('Into the wiki:\n\nComing in: tide-(era).');
    expect(done.message).toBe('3 pages are in sources and the wiki.');
    expect(done.detail).toContain('1 image or PDF was copied into sources.');
    expect(done.buttons).toEqual(['Close']);

    const html = (rel) => readFileSync(path.join(library, ...rel.split('/')), 'utf8');
    expect(html('sources/Harbour.html')).toContain('The harbour.');
    expect(html('sources/20_Atoms/Quay-(place).html')).toContain('The quay:');
    expect(html('wiki/Eras/tide-(era).html')).toContain('The era of tides.');
    expect(html('wiki/Eras/tide-(era).html')).not.toContain('a task');
    expect(existsSync(path.join(library, '.neo', 'pages', 'wiki', 'Eras', 'tide-(era).html.json'))).toBe(true);
    expect(readFileSync(path.join(library, 'sources', 'attachments', 'Quay Map.png'))).toEqual(Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    const manifest = readFileSync(path.join(library, '.neo', 'manifest.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(manifest.map((r) => [r.dest, r.method])).toEqual([
      ['sources/Harbour.html', 'converted'], ['sources/attachments/Quay Map.png', 'verbatim'], ['sources/20_Atoms/Quay-(place).html', 'converted'],
      ['wiki/Eras/tide-(era).html', 'split'],
    ]);
    const changes = readFileSync(path.join(library, '.neo', 'changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(changes.filter((c) => c.kind === 'page-imported').map((c) => c.page)).toEqual(['sources/Harbour.html', 'sources/20_Atoms/Quay-(place).html', 'wiki/Eras/tide-(era).html']);
    await expect.poll(() => git(library, 'status', '--porcelain')).toBe('');
    expect(git(library, 'log', '--format=%s')).toContain('Pages imported to the wiki');

    // a changed source updates its page, which nobody has changed
    await writeFile(path.join(old, '20_Atoms', 'Quay.md'), 'The quay, rebuilt: ![[Quay Map.png]]\n');
    await answer(app, [list], true);
    await menu(app, 'Import List…');
    await expect.poll(() => boxes(app).then((b) => b.length)).toBe(2);
    const [again, updated] = await boxes(app);
    expect(again.detail).toContain('Updated from a newer source, since NEO has not changed the page: Quay-(place).');
    expect(updated.detail).toContain('1 page was updated from a newer source.');
    expect(html('sources/20_Atoms/Quay-(place).html')).toContain('The quay, rebuilt:');
    expect(existsSync(path.join(library, 'sources', 'attachments', 'Quay Map (2).png'))).toBe(false);
  } finally {
    await fixture.close();
  }
});

test('a book line sends the pages after it into a NEO book of their own', async () => {
  const { profile, old } = await profileWithVaults();
  await mkdir(path.join(old, 'Daily'), { recursive: true });
  await writeFile(path.join(old, 'Daily', '2026-01-23.md'), '## Morning Pages\nWoke early.\n- [ ] a task\nThe sea again.\n## Habits\n- [x] walk\n');
  const list = path.join(profile, 'pages.txt');
  await writeFile(list, [
    'old vault/20_Atoms/Quay.md -> Quay-(place)',
    'book: Morning Pages',
    'old vault/Daily/2026-01-23.md#L1-L2 -> 2026-01-23',
    'old vault/Daily/2026-01-23.md#L4-L4 -> 2026-01-23',
  ].join('\n'));
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await answer(app, [list], 'Open Morning Pages');
    await menu(app, 'Import List…');
    await expect.poll(() => boxes(app).then((b) => b.length)).toBe(2);
    const [asked, done] = await boxes(app);
    expect(asked.message).toBe('Import 2 pages into sources and Morning Pages?');
    expect(asked.detail).toContain('Into Morning Pages:\n\nComing in: 2026-01-23.');
    expect(done.message).toBe('2 pages are in sources and Morning Pages.');
    expect(done.buttons).toEqual(['Open Morning Pages', 'Close']);

    await expect.poll(() => page.evaluate(() => book && book.title)).toBe('Morning Pages');
    const pages = await page.evaluate(() => ({ titles: book.chapterOrder.map((id) => book.chapterTitles[id]), first: book.chapterOrder[0] }));
    expect(pages.titles).toEqual(['2026-01-23']);
    expect(await page.evaluate((id) => [...document.querySelectorAll(`.chapter[data-id="${id}"] .chapter-body p`)].map((p) => p.textContent), pages.first))
      .toEqual(['Morning Pages', 'Woke early.', 'The sea again.']);

    // it is on no shelf, so the plugin opens it again
    await page.evaluate(() => backToShelf());
    await expect.poll(() => page.evaluate(() => book && book.title)).toBe(null);
    await menu(app, 'Open Imported Book…');
    await expect.poll(() => page.evaluate(() => book && book.title)).toBe('Morning Pages');
  } finally {
    await fixture.close();
  }
});
