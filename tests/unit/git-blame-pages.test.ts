// Rule: blame of a page reports who wrote each block of wiki/<path> and sources/<path>,
// as it does for a chapter: through the layer, with the library's own attributes file and
// no driver in any config, and for a page id that stays inside its tree.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blamePage, textconvCommand } from '../../src/hoard/git/blame.ts';
import { commitAll } from '../../src/hoard/git/commit.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { ATTRIBUTES } from '../../src/hoard/git/start.ts';
import { isolateGitConfig, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const librarian = { name: 'Librarian', email: 'librarian@neo-hoard.invalid' };
const PAGES = ['wiki/People/Harbour.html', 'sources/Notes/Log.html'];

async function history(t: { after(fn: () => void): void }) {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  const attributesFile = path.join(tempDir(t), 'attributes');
  writeFileSync(attributesFile, `${ATTRIBUTES}\n`);
  await lib.git.run(lib.library, ['init', '-q']);
  for (const page of PAGES) lib.write(page, '<p data-block="a">One.</p><p data-block="b">Two.</p>');
  await commitAll(lib.git, lib.library, { who: 'author', reason: 'idle', librarian });
  for (const page of PAGES) lib.write(page, '<p data-block="a">One.</p><p data-block="b">Two, as the librarian has it.</p>');
  await commitAll(lib.git, lib.library, { who: 'librarian', reason: 'librarian-after', librarian });
  const textconv = textconvCommand(process.execPath, path.join(root, 'tools', 'git', 'neo-textconv.js'));
  return { ...lib, attributesFile, options: { librarian, attributesFile, textconv } };
}

test('blame of a page reports who wrote each block of a page in either tree', async (t) => {
  const { git, library, options } = await history(t);
  for (const page of PAGES) {
    const lines = await blamePage(git, library, page, options);
    assert.deepEqual(lines.map((l) => [l.html, l.who, l.author]), [
      ['<p data-block="a">One.</p>', 'author', 'Ada Author'],
      ['<p data-block="b">Two, as the librarian has it.</p>', 'librarian', 'Librarian'],
    ], page);
  }
});

test('blame of a page through the layer is the same, and a block written since the last commit is uncommitted', async (t) => {
  const { git, library, options, write, attributesFile } = await history(t);
  const layer = new GitLayer({
    git, library, attributesFile, textconv: options.textconv, settings: resolveSettings({}, () => {}), log: () => {},
  });
  t.after(async () => {
    layer.stop();
    await layer.drained();
  });
  await layer.open();
  write(PAGES[0]!, '<p data-block="a">One.</p><p data-block="b">Two, as the librarian has it.</p><p data-block="c">Three.</p>');
  const lines = await layer.blame({ page: PAGES[0]! });
  assert.deepEqual(lines.map((l) => l.who), ['author', 'librarian', 'uncommitted']);
  assert.ok((await layer.blame({ bookId: 'book-fox-1', chId: 'c1' })).length > 0, 'a chapter still blames by its ids');
});

test('blame of a page id that leaves its tree, or names no tree, is refused before git runs', async (t) => {
  const { git, library, options } = await history(t);
  for (const page of ['wiki/../library.json', 'sources/.hidden/a.html', 'notes/a.html', 'wiki/a.md', '/etc/passwd', 'wiki/', '', 7]) {
    await assert.rejects(blamePage(git, library, page, options), /page|tree/, JSON.stringify(page));
  }
});
