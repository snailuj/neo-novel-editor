// Rule: a librarian pair on a page commits author then librarian for that page file, in
// either tree, as it does for a chapter: the writer's words first and the edit alone
// after; the gate judges the edit; and a page id that leaves its tree is refused.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gate } from '../../src/hoard/git/gate.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { LibrarianPairs } from '../../src/hoard/git/pair.ts';
import { isolateGitConfig, log, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function pagePairs(t: { after(fn: () => void): void }, settleMs = 2_000) {
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
  t.after(async () => {
    layer.stop();
    await layer.drained();
  });
  await layer.open();
  await layer.drained();
  const pairs = new LibrarianPairs({ layer, library: () => lib.library, log: () => {}, settleMs });
  // NEO's save: the file, then the host's after-write
  const save = (page: string, html: string, ms: number) => new Promise<void>((resolve) => setTimeout(() => {
    lib.write(page, html);
    pairs.landed({ page });
    resolve();
  }, ms));
  return { ...lib, layer, pairs, save };
}

const history = (lib: Awaited<ReturnType<typeof pagePairs>>) => log(lib.git, lib.library, '%an|%(trailers:key=Neo-Checkpoint,valueonly)');
const filesOf = async (lib: Awaited<ReturnType<typeof pagePairs>>, rev: string) =>
  (await lib.git.run(lib.library, ['show', '--name-only', '--format=', rev])).stdout.split('\n').filter(Boolean).sort();

for (const page of ['wiki/People/Harbour.html', 'sources/Notes/Log.html']) {
  test(`a librarian pair on a page commits author then librarian for that page file: ${page}`, async (t) => {
    // a time limit far longer than any commit, so only a landed write can end a wait in time
    const lib = await pagePairs(t, 30_000);
    const typed = '<p data-block="a">One.</p><p data-block="b">Two, typed.</p>';
    const asked = performance.now();
    const [begun] = await Promise.all([lib.pairs.begin({ page, html: typed }), lib.save(page, typed, 100)]);
    assert.ok('pair' in begun && begun.pair, JSON.stringify(begun));
    assert.ok(performance.now() - asked < 15_000, 'the landed write ends the wait, not the time limit');
    const edited = '<p data-block="a">One.</p><p data-block="b">Two, amended.</p>';
    const [ended] = await Promise.all([lib.pairs.end({ pair: begun.pair, html: edited }), lib.save(page, edited, 100)]);
    assert.ok('after' in ended && ended.before && ended.after, JSON.stringify(ended));
    assert.deepEqual((await history(lib)).slice(0, 2), ['Librarian|librarian-after', 'Ada|librarian-before']);
    assert.deepEqual(await filesOf(lib, ended.before), [page]);
    assert.deepEqual(await filesOf(lib, ended.after), [page]);
    assert.equal((await lib.git.run(lib.library, ['show', `${ended.before}:${page}`])).stdout, typed);
    assert.equal((await lib.git.run(lib.library, ['show', `${ended.after}:${page}`])).stdout, edited);
  });
}

test('a page edit the gate refuses is named by its page file and left out of history', async (t) => {
  const lib = await pagePairs(t);
  lib.layer.useGate(new Gate({ library: () => lib.library, log: () => {} }));
  const page = 'sources/Notes/Log.html';
  const typed = '<p data-block="b1">One.</p>';
  const [begun] = await Promise.all([lib.pairs.begin({ page, html: typed }), lib.save(page, typed, 50)]);
  assert.ok('pair' in begun && begun.pair);
  const edited = '<p data-block="b 1">One, amended.</p>';
  const [ended] = await Promise.all([lib.pairs.end({ pair: begun.pair, html: edited }), lib.save(page, edited, 50)]);
  assert.ok('refused' in ended, JSON.stringify(ended));
  assert.deepEqual(ended.refused.map((f) => `${f.path}|${f.rule}`), [`${page}|Block-Ids-Citable`]);
});

test('a page id that leaves its tree is refused', async (t) => {
  const lib = await pagePairs(t);
  for (const page of ['wiki/../library.json', 'sources/.hidden/a.html', 'notes/a.html', 'wiki/a.md', '/etc/passwd']) {
    await assert.rejects(lib.pairs.begin({ page, html: '' }), /page|tree/, page);
  }
});
