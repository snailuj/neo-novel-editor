import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile } from '../support/electron-profile.mjs';

// Step 5, Wiki-Moves-Into-Neo, as page files. Rules: Markdown pages picked in the file
// picker come into wiki/, each page a file named for its source, its words as written and
// its CriticMarkup comments as comments; the import is committed as the librarian's; and
// importing the same files again changes nothing.

const HARBOUR = '---\ntype: lore\n---\nThe {==harbour wall==}{>>Which side?<<} faces east.\nSee [[Tide Tables]].\n';
const TIDES = '# Tide Tables\n\nHigh water at the [[Harbour|harbour]].\n- [[Nowhere]]\n';

async function trackedProfile() {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  const library = path.join(profile, 'documents', 'NEO Library');
  const vault = path.join(profile, 'vault');
  await mkdir(library, { recursive: true });
  await mkdir(path.join(vault, 'lore'), { recursive: true });
  await mkdir(path.join(profile, 'userData'), { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true, authorName: 'Test author', penNames: [], pageTheme: 'night', outlineView: 'list',
    hintShown: true, shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
  await writeFile(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ plugins: { hoard: { git: { idleSeconds: 1 } } } }));
  await writeFile(path.join(profile, '.gitconfig'), '[user]\n\tname = Ada Author\n\temail = ada@example.com\n');
  execFileSync('git', ['init', '-q'], { cwd: library });
  const files = [path.join(vault, 'lore', 'Harbour.md'), path.join(vault, 'lore', 'Tide Tables.md')];
  await writeFile(files[0], HARBOUR);
  await writeFile(files[1], TIDES);
  return { profile, library, files };
}

const git = (library, ...args) => execFileSync('git', args, {
  cwd: library, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['ignore', 'pipe', 'ignore'],
});

async function menu(app, label) {
  await app.evaluate(({ Menu }, label) => {
    const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
    const item = find(Menu.getApplicationMenu().items).find((i) => i.label === label);
    if (!item) throw new Error(`no ${label} in the menu`);
    item.click();
  }, label);
}

// The file picker answers with `files`, and every message box with its first button,
// each box written down for the test to read.
async function answer(app, files) {
  await app.evaluate(({ dialog }, files) => {
    globalThis.__boxes = [];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files });
    dialog.showMessageBox = async (...args) => {
      const o = args.length > 1 ? args[1] : args[0];
      globalThis.__boxes.push({ message: o.message, detail: o.detail ?? '', buttons: o.buttons ?? [] });
      return { response: 0, checkboxChecked: false };
    };
  }, files);
}
const boxes = (app) => app.evaluate(() => globalThis.__boxes);

test('picked pages come into the wiki as page files, with their comments, and the same files again change nothing', async () => {
  const { profile, library, files } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');

    await answer(app, files);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => boxes(app).then((b) => b.length)).toBe(2);
    const told = await boxes(app);
    expect(told.map((b) => b.message)).toEqual(['Import 2 pages into the wiki?', '2 pages are in the wiki.']);
    expect(told[0].detail).toContain('Coming in: Harbour, Tide Tables.');
    expect(told[1].detail).toContain('1 mark came with them.');
    expect(told[1].buttons).toEqual(['Close']);

    // each page is NEO's HTML under wiki/: each block a paragraph with its class and its own id
    const html = (name) => readFileSync(path.join(library, 'wiki', `${name}.html`), 'utf8');
    const blocks = [...html('Tide Tables').matchAll(/<p(?: class="([^"]*)")?([^>]*)>(.*?)<\/p>/g)].map((m) => [m[1] ?? '', m[3], /data-block="[^"]+"/.test(m[2])]);
    expect(blocks).toEqual([['wiki-h1', 'Tide Tables', true], ['', 'High water at the [[Harbour|harbour]].', true], ['wiki-li', '[[Nowhere]]', true]]);
    expect(await page.evaluate(() => book)).toBe(null);

    // the comment came in on its words, and the import is the librarian's commit
    const sidecar = JSON.parse(readFileSync(path.join(library, '.neo', 'marks', 'wiki', 'Harbour.html.json'), 'utf8'));
    expect(sidecar.marks.map((m) => [m.kind, m.anchor.exact, m.thread[0].body])).toEqual([['comment', 'harbour wall', 'Which side?']]);
    await expect.poll(() => git(library, 'status', '--porcelain')).toBe('');
    expect(git(library, 'log', '--format=%s|%an')).toContain('Pages imported to the wiki|Librarian');

    // the same files again change nothing
    await answer(app, files);
    await menu(app, 'Import to Wiki…');
    await expect.poll(() => boxes(app).then((b) => b.map((x) => x.message))).toEqual(['Every page picked is already in the wiki, or cannot come in.']);
    expect(git(library, 'status', '--porcelain')).toBe('');
  } finally {
    await fixture.close();
  }
});
