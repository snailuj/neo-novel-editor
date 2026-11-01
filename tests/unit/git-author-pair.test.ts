// Rule: an edit the author asks for (a page rename) sits between two commits, as a
// librarian edit does, but both are the author's: what was pending is committed first,
// on its own, so the edit's commit holds only the edit's paths.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { isolateGitConfig, log, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('an author pair commits the pending work first, then only the edit\'s paths, both as the author', async (t) => {
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
  t.after(async () => { layer.stop(); await layer.drained(); });
  await layer.open();
  await layer.keepHistory();

  lib.write('book-fox-1/chapters/c1.html', '<p>pending words</p>');
  const paired = await layer.around(['wiki/B.html'], async () => {
    lib.write('wiki/B.html', '<p>the edit</p>');
    lib.write('wiki/Other.html', '<p>not part of the edit</p>');
    return 'done';
  }, 'author');
  assert.equal(paired.result, 'done');
  assert.ok(paired.before, 'the pending work was committed first');
  assert.ok(paired.after, 'the edit was committed');

  const history = await log(lib.git, lib.library, '%an|%(trailers:key=Neo-Checkpoint,valueonly)');
  assert.deepEqual(history.slice(0, 2).map((l) => l.replace(/\s+$/, '')), ['Ada|page-rename', 'Ada|page-before']);
  const { stdout } = await lib.git.run(lib.library, ['show', '--name-only', '--format=', paired.after!]);
  assert.deepEqual(stdout.split('\n').filter(Boolean), ['wiki/B.html'], 'the edit\'s commit holds only its paths');
});
