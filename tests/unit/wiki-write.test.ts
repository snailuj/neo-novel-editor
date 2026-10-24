// Rules for a wiki page written from the Wiki pane:
// - the page is swapped whole, and only while the file still holds what the pane read;
// - the librarian's change is committed as the librarian's, after the writer's pending
//   work is committed as theirs;
// - a change the pre-commit gate refuses leaves the page as it was, and out of history;
// - the writer's own change is left for the next checkpoint, as their typing is;
// - a page the wiki does not list is not written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gate } from '../../src/hoard/git/gate.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { writePage, type PageWriterOptions } from '../../src/hoard/wiki/write.ts';
import { isolateGitConfig, log, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const PAGE = 'book-fox-1/chapters/c1.html';
const BEFORE = '<p data-block="b1">The quay is old.</p>';
const AFTER = '<p data-block="b1">The quay is very old.</p>';

async function wiki(t: { after(fn: () => void): void }) {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const layer = new GitLayer({
    git: lib.git,
    library: lib.library,
    settings: resolveSettings({}, () => {}),
    attributesFile: path.join(tempDir(t), 'attributes'),
    textconv: { command: `"${process.execPath}" "${path.join(root, 'tools', 'git', 'neo-textconv.js')}"` },
    log: () => {},
  });
  t.after(() => layer.stop());
  await layer.open();
  await layer.drained();
  lib.write(PAGE, BEFORE);
  await layer.commitNow('import');
  const options: PageWriterOptions = {
    library: () => lib.library,
    listed: (chId) => (chId === 'c1' ? { bookId: 'book-fox-1' } : null),
    layer,
    log: () => {},
  };
  const page = () => readFileSync(path.join(lib.library, PAGE), 'utf8');
  const history = () => log(lib.git, lib.library, '%an|%(trailers:key=Neo-Checkpoint,valueonly)');
  return { ...lib, layer, options, page, history };
}

test('the librarian\'s change is committed as the librarian\'s, after the writer\'s pending work', async (t) => {
  const { options, write, page, history, git, library } = await wiki(t);
  write('book-fox-1/chapters/c2.html', '<p>Typed meanwhile.</p>');
  assert.deepEqual(await writePage(options, { chId: 'c1', before: BEFORE, after: AFTER, as: 'librarian' }), { ok: true });
  assert.equal(page(), AFTER);
  assert.deepEqual((await history()).slice(0, 2), ['Librarian|librarian-after', 'Ada|librarian-before']);
  const { stdout } = await git.run(library, ['show', '--name-only', '--format=', 'HEAD']);
  assert.deepEqual(stdout.split('\n').filter(Boolean), [PAGE], 'the librarian\'s commit holds the page alone');
});

test('a page that changed since the pane read it is not written', async (t) => {
  const { options, write, page } = await wiki(t);
  write(PAGE, '<p data-block="b1">The quay is old, said the other device.</p>');
  for (const as of ['librarian', 'author'] as const) {
    assert.deepEqual(await writePage(options, { chId: 'c1', before: BEFORE, after: AFTER, as }), { ok: false, reason: 'stale' });
    assert.equal(page(), '<p data-block="b1">The quay is old, said the other device.</p>');
  }
});

test('a change the library check refuses leaves the page as it was, and out of history', async (t) => {
  const { options, layer, library, page, history } = await wiki(t);
  layer.useGate(new Gate({ library: () => library, log: () => {} }));
  const was = await history();
  const bad = '<p data-block="b 1">The quay is very old.</p>';
  const written = await writePage(options, { chId: 'c1', before: BEFORE, after: bad, as: 'librarian' });
  assert.equal(written.ok, false);
  assert.ok(!written.ok && written.reason === 'refused' && written.findings.some((f) => f.path === PAGE), JSON.stringify(written));
  assert.equal(page(), BEFORE);
  assert.deepEqual(await history(), was, 'nothing of it is in history');
});

test('the writer\'s own change is written and left for the next checkpoint', async (t) => {
  const { options, page, history } = await wiki(t);
  const was = await history();
  const told: (string | undefined)[] = [];
  const layer = { around: () => { throw new Error('the writer\'s change is no librarian edit'); }, wrote: (name?: string) => { told.push(name); } };
  assert.deepEqual(await writePage({ ...options, layer }, { chId: 'c1', before: BEFORE, after: AFTER, as: 'author' }), { ok: true });
  assert.equal(page(), AFTER);
  assert.deepEqual(told, ['book-fox-1']);
  assert.deepEqual(await history(), was, 'no commit yet');
});

test('a page the wiki does not list is not written', async (t) => {
  const { options } = await wiki(t);
  assert.deepEqual(await writePage(options, { chId: 'c9', before: BEFORE, after: AFTER, as: 'author' }), { ok: false, reason: 'missing' });
  await assert.rejects(writePage(options, { chId: '../c1', before: BEFORE, after: AFTER, as: 'author' }), TypeError);
});
