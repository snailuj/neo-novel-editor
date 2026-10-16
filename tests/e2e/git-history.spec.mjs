import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// hoard keeps the library's history in git. Rule: once the writer pauses, what they wrote
// is committed under their own git identity, and blame credits each paragraph to them.
// The idle wait is a second here, through the plugin's settings, instead of a minute.

const CHAPTER = 'chapter-synthetic';

async function profileWithHistory({ track }) {
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
  // isolate() points git at this file, so the test's identity is the only one.
  await writeFile(path.join(profile, '.gitconfig'), '[user]\n\tname = Ada Author\n\temail = ada@example.com\n');
  if (track) execFileSync('git', ['init', '-q'], { cwd: library });
  return { profile, library };
}

const git = (library, ...args) => execFileSync('git', args, {
  cwd: library, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
});
const commits = (library) => {
  try {
    return git(library, 'log', '--format=%an|%(trailers:key=Neo-Checkpoint,valueonly,separator=)').split('\n').filter(Boolean);
  } catch { return []; }
};

test('a pause commits the writing under the author\'s name, and blame credits each paragraph', async () => {
  const { profile, library } = await profileWithHistory({ track: true });
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');
    const bookId = await seedBook(page, '<p>First line.</p><p>Second line.</p>');
    await expect.poll(() => commits(library).length, { timeout: 10_000 }).toBeGreaterThan(0);

    await page.locator('.chapter-body p').nth(1).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Typed.');
    const committed = () => {
      try { return git(library, 'show', `HEAD:${bookId}/chapters/${CHAPTER}.html`); } catch { return ''; }
    };
    await expect.poll(committed, { timeout: 10_000 }).toContain('Second line. Typed.');
    expect(commits(library)[0]).toBe('Ada Author|idle');

    const lines = await page.evaluate(({ bookId, chId }) => window.hoard.blame(bookId, chId), { bookId, chId: CHAPTER });
    expect(lines.map((l) => [l.html, l.who, l.author])).toEqual([
      ['<p>First line.</p>', 'author', 'Ada Author'],
      ['<p>Second line. Typed.</p>', 'author', 'Ada Author'],
    ]);
  } finally {
    await fixture.close();
  }
});

test('a library with no repository gets none until Keep Library History is chosen', async () => {
  const { profile, library } = await profileWithHistory({ track: false });
  const fixture = await launchProfile(profile);
  try {
    const { app, page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('untracked');
    await seedBook(page, '<p>Only line.</p>');
    await page.waitForTimeout(2_500);
    expect(commits(library)).toEqual([]);

    await app.evaluate(({ Menu }) => {
      const find = (items) => items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu.items) : [])]);
      const item = find(Menu.getApplicationMenu().items).find((i) => i.label === 'Keep Library History');
      if (!item) throw new Error('no Keep Library History in the menu');
      item.click();
    });
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state)), { timeout: 10_000 })
      .toBe('tracked');
    expect(commits(library)).toEqual(['Ada Author|start']);
  } finally {
    await fixture.close();
  }
});
