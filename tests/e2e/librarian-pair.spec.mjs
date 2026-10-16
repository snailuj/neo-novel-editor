import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchProfile, seedBook } from '../support/electron-profile.mjs';

// A librarian edit sits between two commits. Rule: the writer's words, even a save still
// on its way when the edit is asked for, are committed as theirs first; the edit alone
// is committed as the librarian's; the chapter is let go after, and pauses commit again.

const CHAPTER = 'chapter-synthetic';

async function trackedProfile() {
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
  await writeFile(path.join(profile, '.gitconfig'), '[user]\n\tname = Ada Author\n\temail = ada@example.com\n');
  execFileSync('git', ['init', '-q'], { cwd: library });
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

test('a librarian edit commits the writer\'s words as theirs first, then its own as the librarian\'s', async () => {
  const { profile, library } = await trackedProfile();
  const fixture = await launchProfile(profile);
  try {
    const { page } = fixture;
    await page.waitForFunction(() => !!window.hoard);
    await expect.poll(() => page.evaluate(() => window.hoard.gitStatus().then((s) => s.state))).toBe('tracked');
    const bookId = await seedBook(page, '<p>First line.</p><p>Second line.</p>');
    await expect.poll(() => commits(library).length, { timeout: 10_000 }).toBeGreaterThan(0);

    // typed just before the edit, so its save is still on its way when the edit is asked for
    await page.locator('.chapter-body p').nth(0).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Typed.');
    const done = await page.evaluate((chId) => window.hoard.librarian.replace(
      { chId, pIdx: 1, off: 0, len: 6 }, 'Second', 'Latter',
    ), CHAPTER);
    expect(done.ok, JSON.stringify(done)).toBe(true);
    expect(done.result).toEqual({ ok: true });

    const file = `${bookId}/chapters/${CHAPTER}.html`;
    expect(git(library, 'show', `${done.before}:${file}`)).toBe('<p>First line. Typed.</p><p>Second line.</p>');
    expect(git(library, 'show', `${done.after}:${file}`)).toBe('<p>First line. Typed.</p><p>Latter line.</p>');
    expect(commits(library).slice(0, 2)).toEqual(['Librarian|librarian-after', 'Ada Author|librarian-before']);
    expect(git(library, 'show', '--name-only', '--format=', done.after).trim()).toBe(file);
    await expect(page.locator('.chapter[data-held]')).toHaveCount(0);

    const lines = await page.evaluate(({ bookId, chId }) => window.hoard.blame(bookId, chId), { bookId, chId: CHAPTER });
    expect(lines.map((l) => [l.html, l.who])).toEqual([
      ['<p>First line. Typed.</p>', 'author'],
      ['<p>Latter line.</p>', 'librarian'],
    ]);

    await page.locator('.chapter-body p').nth(0).click();
    await page.keyboard.press('End');
    await page.keyboard.insertText(' Again.');
    await expect.poll(() => commits(library)[0], { timeout: 10_000 }).toBe('Ada Author|idle');
  } finally {
    await fixture.close();
  }
});
