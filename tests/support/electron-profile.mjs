import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('../..', import.meta.url));
// node_modules' Electron: requiring the package returns the path of its binary.
const electronPath = createRequire(import.meta.url)('electron');

// A first-run-complete library with one shelf. outlineView 'list' and hintShown
// keep the Outline cards and the first-run hint out of the way of the tests.
async function seedLibrary(profile) {
  const library = path.join(profile, 'documents', 'NEO Library');
  await mkdir(library, { recursive: true });
  await writeFile(path.join(library, 'library.json'), JSON.stringify({
    firstRunDone: true,
    authorName: 'Test author',
    penNames: [],
    pageTheme: 'night',
    outlineView: 'list',
    hintShown: true,
    shelves: [{ id: 'shelf-1', name: 'Synthetic shelf', bookIds: [] }],
  }));
}

export async function launchProfile(existingProfile, options = {}) {
  const profile = existingProfile ?? await mkdtemp(path.join(tmpdir(), 'neo-test-'));
  let app;
  try {
    if (!existingProfile) await seedLibrary(profile);
    const startedAt = performance.now();
    const env = { ...process.env, NEO_TEST_PROFILE: profile, NEO_TEST_VISIBLE: options.visible === true ? '1' : '0' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: electronPath,
      args: ['tests/support/electron-main.cjs'],
      cwd: appRoot,
      env,
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => !!window.neo && typeof openBook === 'function');
    console.log(JSON.stringify({ testProfile: profile, startupMs: performance.now() - startedAt }));
    return { app, page, profile, async close({ remove = true } = {}) {
      await app.close();
      if (remove) await rm(profile, { recursive: true, force: true });
    } };
  } catch (error) {
    try {
      await app?.close();
      if (!existingProfile) await rm(profile, { recursive: true, force: true });
    } catch (cleanupError) {
      console.warn(JSON.stringify({ event: 'test.profile-cleanup-refused', profile, message: cleanupError.message }));
    }
    throw error;
  }
}

// `extra` goes into book.json, for example { format: 'screenplay' } for a script
export async function seedBook(page, html = '<p>Synthetic Māia &amp; A😀é.</p>', extra = {}) {
  return page.evaluate(async ({ content, extra }) => {
    const meta = await neo.createBook({ title: 'Synthetic book', author: 'Test author' });
    Object.assign(meta, extra);
    meta.chapterOrder = ['chapter-synthetic'];
    await neo.writeBookMeta(meta.id, meta);
    await neo.writeChapter(meta.id, 'chapter-synthetic', content);
    const lib = await neo.readLibrary();
    lib.firstRunDone = true;
    lib.shelves[0].bookIds.push(meta.id);
    await neo.writeLibrary(lib);
    await openBook(meta.id);
    return meta.id;
  }, { content: html, extra });
}
