// Rules: opening the history costs the same whatever its length (it never walks the
// log), and work left uncommitted when NEO last stopped is committed when it opens.
// A library that is not its own repository gets no commits from saves.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import type { Git } from '../../src/hoard/git/runner.ts';
import { isolateGitConfig, log, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));

function counting(git: Git) {
  const calls: string[] = [];
  return {
    calls,
    git: {
      run(cwd: string, args: readonly string[], o?: object) {
        calls.push(args.join(' '));
        return git.run(cwd, args, o);
      },
    },
  };
}

// n commits written through fast-import, so a long history costs one process.
function longHistory(library: string, n: number) {
  let stream = '';
  for (let i = 1; i <= n; i++) {
    const body = `<p>Draft ${i}.</p>`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter Ada <ada@example.com> ${1_700_000_000 + i} +0000\n`;
    stream += `data 5\nsave\n${i > 1 ? `from :${i - 1}\n` : ''}`;
    stream += `M 100644 inline book-fox-1/chapters/c1.html\ndata ${Buffer.byteLength(body)}\n${body}\n`;
  }
  const run = spawnSync('git', ['fast-import', '--quiet'], { cwd: library, input: stream });
  assert.equal(run.status, 0, String(run.stderr));
  spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: library });
  spawnSync('git', ['reset', '-q', '--hard'], { cwd: library });
}

function layerFor(t: { after(fn: () => void): void }, git: Git, library: string) {
  const lines: { level: string; message: string; data?: unknown }[] = [];
  const layer = new GitLayer({
    git,
    library,
    settings: resolveSettings({}, () => {}),
    attributesFile: path.join(tempDir(t), 'attributes'),
    textconv: { command: `"${process.execPath}" "${path.join(root, 'tools', 'git', 'neo-textconv.js')}"` },
    log: (level, message, data) => lines.push({ level, message, data }),
  });
  t.after(() => layer.stop());
  return { layer, lines };
}

test('opening runs the same git commands for 10 commits as for 2,000', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const runs: string[][] = [];
  for (const n of [10, 2000]) {
    const lib = tempLibrary(t);
    await lib.git.run(lib.library, ['init', '-q']);
    longHistory(lib.library, n);
    await lib.git.run(lib.library, ['add', '-A']);
    await lib.git.run(lib.library, ['commit', '-q', '-m', 'the rest']);
    assert.equal((await log(lib.git, lib.library, '%H')).length, n + 1, 'the history is as long as asked');
    const { git, calls } = counting(lib.git);
    const { layer } = layerFor(t, git, lib.library);
    await layer.open();
    await layer.drained();
    runs.push(calls);
  }
  assert.deepEqual(runs[0], runs[1]);
  assert.ok(runs[0].length <= 3, runs[0].join('\n'));
});

test('work left uncommitted is committed on opening, as recovered', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const { layer } = layerFor(t, lib.git, lib.library);
  assert.equal((await layer.open()).state, 'tracked');
  await layer.drained();
  assert.deepEqual(await log(lib.git, lib.library, '%(trailers:key=Neo-Checkpoint,valueonly)'), ['recovered']);
});

test('an untracked library gets no commits from saves until Keep Library History', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  const { layer } = layerFor(t, lib.git, lib.library);
  assert.equal((await layer.open()).state, 'untracked');
  layer.wrote();
  layer.request('book-close');
  await layer.close(1000);
  assert.equal((await lib.git.run(lib.library, ['status'], {}).catch(() => null)), null, 'still no repository');
  const started = await layer.keepHistory();
  assert.equal(started.started, true);
  assert.equal(layer.status().state, 'tracked');
  lib.write('book-fox-1/chapters/c1.html', '<p>One.</p><p>Two.</p><p>Three.</p>');
  await layer.close(1000);
  assert.deepEqual(await log(lib.git, lib.library, '%(trailers:key=Neo-Checkpoint,valueonly)'), ['close', 'start']);
});

test('a failing commit is logged once, not on every pause', async (t) => {
  isolateGitConfig(t, null);
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const { layer, lines } = layerFor(t, lib.git, lib.library);
  await layer.open();
  await layer.drained();
  await layer.close(1000);
  const failures = lines.filter((l) => l.message === 'git.checkpoint.failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].level, 'error');
});

test('settings that do not fit the schema fall back to the defaults, with a warning', () => {
  const warnings: string[] = [];
  const s = resolveSettings({ git: { idleSeconds: 'soon', librarian: { name: 'L' } } }, (m) => warnings.push(m));
  assert.equal(s.idleMs, 60_000);
  assert.deepEqual(s.librarian, { name: 'Librarian', email: 'librarian@neo-hoard.invalid' });
  assert.equal(warnings.length, 1);
  const ok = resolveSettings({ git: { idleSeconds: 5, path: '/opt/git', author: { name: 'P', email: 'p@x' } } }, () => {});
  assert.equal(ok.idleMs, 5_000);
  assert.equal(ok.gitPath, '/opt/git');
  assert.deepEqual(ok.author, { name: 'P', email: 'p@x' });
});

// Rule: a mark records the commit its quote was read at when the library has one, and
// null otherwise; asking never fails the caller.
test('head names the last commit of a tracked library, and is null with no history', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const untracked = tempLibrary(t);
  const before = layerFor(t, untracked.git, untracked.library).layer;
  await before.open();
  assert.equal(await before.head(), null);
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const { layer } = layerFor(t, lib.git, lib.library);
  await layer.open();
  await layer.drained();
  const [sha] = await log(lib.git, lib.library, '%H');
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(await layer.head(), sha);
});

// Rule: an import is committed at once, as its own checkpoint, once it has landed; a
// library without history makes no commit for it.
test('an import is committed at once as its own checkpoint, and an untracked library makes none', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const { layer } = layerFor(t, lib.git, lib.library);
  await layer.open();
  await layer.drained();
  lib.write('book-wiki-1/chapters/c1.html', '<p>Imported.</p>');
  await layer.commitNow('import');
  assert.deepEqual(await log(lib.git, lib.library, '%s|%(trailers:key=Neo-Checkpoint,valueonly)'), [
    'Pages imported to the wiki|import', 'Writing found uncommitted at start|recovered',
  ]);
  const bare = tempLibrary(t);
  const other = layerFor(t, bare.git, bare.library).layer;
  await other.open();
  await other.commitNow('import');
  assert.equal(await other.head(), null);
});
