// Rule: a librarian edit sits between two commits. What the writer wrote before it is
// committed as the author's, the edit alone as the librarian's, and no checkpoint runs
// in between; the checkpoints run again however the edit ends, and pairs never overlap.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Clock } from '../../src/hoard/git/checkpoints.ts';
import { Gate } from '../../src/hoard/git/gate.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { LibrarianPairs } from '../../src/hoard/git/pair.ts';
import type { Git } from '../../src/hoard/git/runner.ts';
import { isolateGitConfig, log, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const C1 = 'book-fox-1/chapters/c1.html';

// Timers that run only when fire() is called, so a test decides when a checkpoint is due.
function manualClock() {
  const timers = new Map<number, () => void>();
  let next = 1;
  const clock: Clock = {
    now: () => 0,
    setTimeout(fn) {
      timers.set(next, fn);
      return next++;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
  };
  const fire = () => {
    const due = [...timers.values()];
    timers.clear();
    for (const fn of due) fn();
  };
  return { clock, fire };
}

export function pairLayer(t: { after(fn: () => void): void }, git: Git, library: string, clock?: Clock) {
  const lines: { level: string; message: string; data?: unknown }[] = [];
  const layer = new GitLayer({
    git,
    library,
    settings: resolveSettings({}, () => {}),
    attributesFile: path.join(tempDir(t), 'attributes'),
    textconv: { command: `"${process.execPath}" "${path.join(root, 'tools', 'git', 'neo-textconv.js')}"` },
    log: (level, message, data) => lines.push({ level, message, data }),
    clock,
  });
  t.after(() => layer.stop());
  return { layer, lines };
}

const history = (git: Git, library: string) => log(git, library, '%an|%(trailers:key=Neo-Checkpoint,valueonly)');
const filesOf = async (git: Git, library: string, rev: string) => {
  const { stdout } = await git.run(library, ['show', '--name-only', '--format=', rev]);
  return stdout.split('\n').filter(Boolean).sort();
};

async function tracked(t: { after(fn: () => void): void }, clock?: Clock) {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const { layer, lines } = pairLayer(t, lib.git, lib.library, clock);
  await layer.open();
  await layer.drained();
  return { ...lib, layer, lines };
}

test('the writer\'s words go in the author\'s commit, the edit alone in the librarian\'s', async (t) => {
  const { library, git, write, layer } = await tracked(t);
  write(C1, '<p>One.</p><p>Two, typed.</p>');
  const paired = await layer.around([C1], async () => {
    write(C1, '<p>One.</p><p>Two, amended.</p>');
    write('book-fox-1/chapters/c2.html', '<p>Typed in another chapter meanwhile.</p>');
    return 'applied';
  });
  assert.equal(paired.result, 'applied');
  assert.deepEqual((await history(git, library)).slice(0, 2), ['Librarian|librarian-after', 'Ada|librarian-before']);
  const [after, before] = await log(git, library, '%H');
  assert.equal(paired.after, after);
  assert.equal(paired.before, before);
  assert.deepEqual(await filesOf(git, library, after), [C1]);
  const { stdout: was } = await git.run(library, ['show', `${before}:${C1}`]);
  assert.equal(was, '<p>One.</p><p>Two, typed.</p>');
  const { stdout: left } = await git.run(library, ['status', '--porcelain']);
  assert.deepEqual(left.split('\n').filter(Boolean), ['?? book-fox-1/chapters/c2.html'], 'the other chapter waits for the author');
});

test('no checkpoint commits inside the pair, and the one that fired runs after it', async (t) => {
  const time = manualClock();
  const { library, git, write, layer } = await tracked(t, time.clock);
  let fired = 0;
  await layer.around([C1], async () => {
    write(C1, '<p>One.</p><p>Two, amended.</p>');
    layer.wrote('c1');
    time.fire();
    layer.request('chapter-switch');
    time.fire();
    fired = (await history(git, library)).length;
  });
  assert.equal(fired, 1, 'only the recovered commit existed while the edit ran');
  write('book-fox-1/chapters/c2.html', '<p>Later.</p>');
  await layer.drained();
  assert.deepEqual(await history(git, library), ['Ada|chapter-switch', 'Librarian|librarian-after', 'Ada|recovered']);
});

test('an edit that fails still has what it changed committed as the librarian\'s, and the checkpoints resume', async (t) => {
  const { library, git, write, layer } = await tracked(t);
  await assert.rejects(layer.around([C1], async () => {
    write(C1, '<p>Half done.</p>');
    throw new Error('the edit broke');
  }), /the edit broke/);
  assert.deepEqual((await history(git, library))[0], 'Librarian|librarian-after');
  write(C1, '<p>The writer again.</p>');
  await layer.commitNow('import-author');
  assert.deepEqual((await history(git, library))[0], 'Ada|import-author');
});

test('when the author\'s commit fails the edit never runs', async (t) => {
  isolateGitConfig(t, null);
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const { layer } = pairLayer(t, lib.git, lib.library);
  await layer.open();
  await layer.drained();
  let ran = false;
  await assert.rejects(layer.around([C1], async () => { ran = true; }));
  assert.equal(ran, false);
  assert.deepEqual(await history(lib.git, lib.library).catch(() => []), []);
});

test('pairs run one after the other', async (t) => {
  const { library, git, write, layer } = await tracked(t);
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = layer.around([C1], async () => {
    order.push('first in');
    write(C1, '<p>First.</p>');
    await gate;
    order.push('first out');
  });
  const second = layer.around(['book-fox-1/chapters/c2.html'], async () => {
    order.push('second in');
    write('book-fox-1/chapters/c2.html', '<p>Second.</p>');
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first in', 'first out', 'second in']);
  assert.deepEqual((await history(git, library)).slice(0, 2), ['Librarian|librarian-after', 'Librarian|librarian-after']);
});

test('in a library with no history the edit runs alone, with no commits', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  const { layer } = pairLayer(t, lib.git, lib.library);
  await layer.open();
  const paired = await layer.around([C1], async () => 7);
  assert.deepEqual(paired, { result: 7, before: null, after: null });
  assert.equal(await layer.head(), null);
});

// Rule: the pair's commits wait on the disk. The author's commit holds the writer's
// last typing even when its save lands after the edit was asked for, and the
// librarian's holds the edit even when its save lands after the window says it is done.
async function pairsFor(t: { after(fn: () => void): void }, options: { settleMs?: number; abandonMs?: number } = {}) {
  const lib = await tracked(t);
  const pairs = new LibrarianPairs({
    layer: lib.layer, library: () => lib.library, log: () => {}, settleMs: 2_000, ...options,
  });
  // NEO's save: the file, then the host's after-write
  const save = (html: string, ms: number) => new Promise<void>((resolve) => setTimeout(() => {
    lib.write(C1, html);
    pairs.landed('book-fox-1', 'c1');
    resolve();
  }, ms));
  return { ...lib, pairs, save };
}

const ask = (html: string) => ({ bookId: 'book-fox-1', chId: 'c1', html });

test('a save landing after the edit is asked for still goes in the author\'s commit', async (t) => {
  const { library, git, pairs, save } = await pairsFor(t);
  const typed = '<p>One.</p><p>Two, typed.</p>';
  const asked = performance.now();
  const [begun] = await Promise.all([pairs.begin(ask(typed)), save(typed, 150)]);
  assert.ok('pair' in begun && begun.pair);
  assert.ok(performance.now() - asked < 1_500, 'the landed write ends the wait, not the time limit');
  const edited = '<p>One.</p><p>Two, amended.</p>';
  const [ended] = await Promise.all([pairs.end({ pair: begun.pair, html: edited }), save(edited, 150)]);
  assert.deepEqual((await history(git, library)).slice(0, 2), ['Librarian|librarian-after', 'Ada|librarian-before']);
  assert.ok('after' in ended);
  const { stdout: before } = await git.run(library, ['show', `${ended.before}:${C1}`]);
  const { stdout: after } = await git.run(library, ['show', `${ended.after}:${C1}`]);
  assert.equal(before, typed);
  assert.equal(after, edited);
});

test('a chapter whose save never lands refuses the edit, and makes no commit', async (t) => {
  const { library, git, layer, pairs, write } = await pairsFor(t, { settleMs: 200 });
  assert.deepEqual(await pairs.begin(ask('<p>Never saved.</p>')), { refused: 'unsaved' });
  assert.deepEqual(await history(git, library), ['Ada|recovered']);
  write(C1, '<p>The writer again.</p>');
  await layer.commitNow('import-author');
  assert.equal((await history(git, library))[0], 'Ada|import-author', 'the checkpoints were never held');
});

test('an edit the window never ends is committed as the librarian\'s after a while', async (t) => {
  const { library, git, layer, pairs, write } = await pairsFor(t, { abandonMs: 200 });
  const begun = await pairs.begin(ask('<p>One.</p><p>Two.</p>'));
  assert.ok('pair' in begun && begun.pair);
  write(C1, '<p>Edited, then the window went away.</p>');
  await new Promise((resolve) => setTimeout(resolve, 400));
  await layer.drained();
  assert.equal((await history(git, library))[0], 'Librarian|librarian-after');
  await assert.rejects(pairs.end({ pair: begun.pair, html: null }), /no edit/);
});

test('with no history there is no pair, and ending it commits nothing', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  const { layer } = pairLayer(t, lib.git, lib.library);
  await layer.open();
  const pairs = new LibrarianPairs({ layer, library: () => lib.library, log: () => {} });
  assert.deepEqual(await pairs.begin(ask('<p>One.</p><p>Two.</p>')), { pair: null });
  assert.deepEqual(await pairs.end({ pair: null, html: '<p>x</p>' }), { before: null, after: null });
});

test('a name that leaves the library is refused', async (t) => {
  const { pairs } = await pairsFor(t);
  await assert.rejects(pairs.begin({ bookId: '..', chId: 'c1', html: '' }), TypeError);
  await assert.rejects(pairs.begin({ bookId: 'book-fox-1', chId: 'a/b', html: '' }), TypeError);
});

// Rule: a librarian edit the gate refuses ends with its findings, and nothing of it is
// committed: not as the librarian's, and not as the writer's at the next checkpoint.
test('an edit the gate refuses ends with its findings and leaves the edit out of history', async (t) => {
  const { library, git, layer, pairs, save, write } = await pairsFor(t);
  layer.useGate(new Gate({ library: () => library, log: () => {} }));
  const typed = '<p data-block="b1">One.</p>';
  const [begun] = await Promise.all([pairs.begin(ask(typed)), save(typed, 50)]);
  assert.ok('pair' in begun && begun.pair);
  const edited = '<p data-block="b 1">One, amended.</p>';
  const [ended] = await Promise.all([pairs.end({ pair: begun.pair, html: edited }), save(edited, 50)]);
  assert.ok('refused' in ended, JSON.stringify(ended));
  assert.deepEqual(ended.refused.map((f) => `${f.path}|${f.rule}`), [`${C1}|Block-Ids-Citable`]);
  assert.deepEqual((await history(git, library)).slice(0, 2), ['Ada|librarian-before', 'Ada|recovered']);
  write('book-fox-1/chapters/c2.html', '<p>Elsewhere.</p>');
  await layer.commitNow('import-author');
  assert.deepEqual(await filesOf(git, library, 'HEAD'), ['book-fox-1/chapters/c2.html'], 'the checkpoints run, without the edit');
});
