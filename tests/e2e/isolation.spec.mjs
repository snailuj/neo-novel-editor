import { test, expect } from '@playwright/test';
import { launchProfile } from '../support/electron-profile.mjs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Paths Electron can name that the app or Electron itself writes under. The harness sets
// each of them inside the profile, so a test never resolves one to the developer's own.
const PATH_NAMES = [
  'home', 'appData', 'userData', 'sessionData', 'temp', 'desktop', 'documents', 'downloads',
  'music', 'pictures', 'videos', 'logs', 'crashDumps',
];

test('a test run is cut off from the developer\'s system', async () => {
  // A developer's shell can name plugin folders; their plugins must not load in a test.
  const named = process.env.NEO_PLUGIN_DIRS;
  process.env.NEO_PLUGIN_DIRS = 'scripts/fixtures/plugins';
  let fixture;
  try {
    fixture = await launchProfile();
  } finally {
    if (named === undefined) delete process.env.NEO_PLUGIN_DIRS;
    else process.env.NEO_PLUGIN_DIRS = named;
  }
  try {
    const seen = await fixture.app.evaluate(({ app, shell, dialog }, names) => {
      // The harness marks each stub; a call Electron implements has no mark.
      const unstubbed = (owner) => Object.entries(owner)
        .filter(([, fn]) => typeof fn === 'function' && fn.neoTestStub !== true)
        .map(([name]) => name);
      return {
        pluginDirs: process.env.NEO_PLUGIN_DIRS ?? null,
        neoVariables: Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('NEO_')).sort(),
        paths: Object.fromEntries(names.map((name) => [name, app.getPath(name)])),
        unstubbedShell: unstubbed(shell),
        unstubbedDialog: unstubbed(dialog),
      };
    }, PATH_NAMES);

    expect.soft(seen.pluginDirs).toBeNull();
    expect.soft(seen.neoVariables).toEqual(['NEO_TEST_PROFILE', 'NEO_TEST_VISIBLE']);
    expect.soft(seen.unstubbedShell).toEqual([]);
    expect.soft(seen.unstubbedDialog).toEqual([]);
    const outside = Object.entries(seen.paths).filter(([, target]) => {
      const relative = path.relative(fixture.profile, target);
      return relative.startsWith('..') || path.isAbsolute(relative);
    });
    expect.soft(outside).toEqual([]);
  } finally { await fixture.close(); }
});

// A chosen library folder that is gone (an unplugged drive) makes main.js ask a synchronous
// dialog at launch. In a test that must be refused, not shown, and the app must carry on.
test('a missing library folder opens no dialog', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  let fixture;
  try {
    await mkdir(path.join(profile, 'userData'), { recursive: true });
    const unplugged = path.join(profile, 'unplugged', 'NEO Library');
    await writeFile(path.join(profile, 'userData', 'settings.json'), JSON.stringify({ libraryDir: unplugged }));
    fixture = await launchProfile(profile);
    const library = path.join(profile, 'documents', 'NEO Library');
    expect(await fixture.page.evaluate(() => neo.libraryPath())).toBe(library);
    expect(await readFile(path.join(library, 'neo-errors.log'), 'utf8'))
      .toContain('dialog.showMessageBoxSync is disabled in tests');
  } finally {
    if (fixture) await fixture.close();
    else await rm(profile, { recursive: true, force: true });
  }
});

// book:delete sends a book folder to the system trash. In a test that is the profile's own.
test('trashing moves a folder into the profile and refuses one outside it', async () => {
  const fixture = await launchProfile();
  const outside = await mkdtemp(path.join(tmpdir(), 'neo-outside-'));
  try {
    const book = path.join(fixture.profile, 'documents', 'NEO Library', 'book-synthetic');
    await mkdir(book, { recursive: true });
    await writeFile(path.join(book, 'book.json'), '{}');

    const refusal = await fixture.app.evaluate(async ({ shell }, { book, outside }) => {
      await shell.trashItem(book);
      return shell.trashItem(outside).then(() => null, (error) => error.code);
    }, { book, outside });

    expect(refusal).toBe('TEST_WRITE_OUTSIDE_PROFILE');
    await expect(stat(book)).rejects.toThrow();
    const trashed = await readdir(path.join(fixture.profile, 'trash'));
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/book-synthetic$/);
    expect((await stat(outside)).isDirectory()).toBe(true);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await fixture.close();
  }
});
