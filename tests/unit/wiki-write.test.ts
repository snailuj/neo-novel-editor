// Rules for a wiki page written from the Wiki pane:
// - the page is swapped whole, and only while the file still holds what the pane read;
// - the librarian's change is committed as the librarian's, after the writer's pending
//   work is committed as theirs;
// - a change the pre-commit gate refuses leaves the page as it was, and out of history;
// - a refused change whose restore fails stays held and is reported as an error, and a newer
//   file is not written over;
// - a refused librarian change never frees a hold that existed before it;
// - the writer's own change is left for the next checkpoint, as their typing is;
// - a page the wiki does not list is not written;
// - an author wiki.edit of a held chapter frees it and wakes its librarian pair, and a stale
//   write, a refused one or a librarian's does not.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gate } from '../../src/hoard/git/gate.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { startReview } from '../../src/hoard/review/main.ts';
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

test('a refused change whose restore fails stays held and is reported as an error', async (t) => {
  const { options, layer, library, page } = await wiki(t);
  const gate = new Gate({ library: () => library, log: () => {} });
  layer.useGate(gate);
  const bad = '<p data-block="b 1">The quay is very old.</p>';
  const changed = '<p data-block="b 2">Changed meanwhile.</p>';
  const logged: { level: string; data: unknown }[] = [];
  // Another device rewrites the page after the swap, with a text the gate also refuses.
  const wrapped = { ...layer, around: (async (paths: readonly string[], fn: () => Promise<unknown>) => layer.around(paths, async () => {
    const r = await fn();
    writeFileSync(path.join(library, PAGE), changed);
    return r;
  })) as typeof layer.around, wrote: layer.wrote.bind(layer), release: layer.release.bind(layer), held: layer.held.bind(layer) };
  const log = (level: string, _message: string, data?: unknown) => { logged.push({ level, data }); };
  await assert.rejects(writePage({ ...options, layer: wrapped, log }, { chId: 'c1', before: BEFORE, after: bad, as: 'librarian' }));
  assert.deepEqual(gate.held(), [PAGE], 'the page is still held');
  assert.equal(page(), changed, 'the newer text is not written over');
  assert.ok(logged.some((l) => l.level === 'error' && (l.data as { chId?: string }).chId === 'c1'), JSON.stringify(logged));
});

test('a librarian change to a page the gate already holds is refused, and the hold stays', async (t) => {
  const { options, layer, library, page } = await wiki(t);
  const gate = new Gate({ library: () => library, log: () => {} });
  layer.useGate(gate);
  const bad = '<p data-block="b 1">The quay is very old.</p>';
  const changed = '<p data-block="b 2">Changed meanwhile.</p>';
  // the first refusal cannot be put back: another device rewrote the page after the swap
  const wrapped = { ...layer, around: (async (paths: readonly string[], fn: () => Promise<unknown>) => layer.around(paths, async () => {
    const r = await fn();
    writeFileSync(path.join(library, PAGE), changed);
    return r;
  })) as typeof layer.around, wrote: layer.wrote.bind(layer), release: layer.release.bind(layer), held: layer.held.bind(layer) };
  await assert.rejects(writePage({ ...options, layer: wrapped, log: () => {} }, { chId: 'c1', before: BEFORE, after: bad, as: 'librarian' }));
  assert.deepEqual(gate.held(), [PAGE]);
  assert.deepEqual(await writePage({ ...options, log: () => {} }, { chId: 'c1', before: changed, after: bad, as: 'librarian' }), { ok: false, reason: 'held' });
  assert.deepEqual(gate.held(), [PAGE]);
  assert.equal(page(), changed);
});

test('the writer\'s own change is written and left for the next checkpoint', async (t) => {
  const { options, page, history } = await wiki(t);
  const was = await history();
  const told: (string | undefined)[] = [];
  const layer = { around: () => { throw new Error('the writer\'s change is no librarian edit'); }, wrote: (name?: string) => { told.push(name); }, release: () => {}, held: () => [] };
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

test('the author\'s write tells its caller once, with the book and chapter, and a stale or librarian write tells no one', async (t) => {
  const { options, page } = await wiki(t);
  const told: string[][] = [];
  const saved = (bookId: string, chId: string) => { told.push([bookId, chId]); };
  assert.deepEqual(await writePage({ ...options, saved }, { chId: 'c1', before: 'not what is there', after: AFTER, as: 'author' }), { ok: false, reason: 'stale' });
  assert.deepEqual(await writePage({ ...options, saved }, { chId: 'c9', before: BEFORE, after: AFTER, as: 'author' }), { ok: false, reason: 'missing' });
  assert.deepEqual(told, [], 'a write that did not happen is not announced');
  assert.deepEqual(await writePage({ ...options, saved }, { chId: 'c1', before: BEFORE, after: AFTER, as: 'librarian' }), { ok: true });
  assert.deepEqual(told, [], 'the librarian\'s write is not the writer\'s save');
  const again = '<p data-block="b1">The quay is very old indeed.</p>';
  assert.deepEqual(await writePage({ ...options, saved }, { chId: 'c1', before: AFTER, after: again, as: 'author' }), { ok: true });
  assert.equal(page(), again);
  assert.deepEqual(told, [['book-fox-1', 'c1']]);
});

// Rule: an author wiki.edit of a held chapter frees it and wakes its librarian pair.
test('an author wiki.edit of a held chapter frees it and wakes its librarian pair', async (t) => {
  const { options, layer, library, page } = await wiki(t);
  const gate = new Gate({ library: () => library, log: () => {} });
  layer.useGate(gate);
  const bad = '<p data-block="b 1">The quay is very old.</p>';
  const changed = '<p data-block="b 2">Changed meanwhile.</p>';
  // the librarian's refused change cannot be put back, so the chapter is held
  const wrapped = { ...layer, around: (async (paths: readonly string[], fn: () => Promise<unknown>) => layer.around(paths, async () => {
    const r = await fn();
    writeFileSync(path.join(library, PAGE), changed);
    return r;
  })) as typeof layer.around, wrote: layer.wrote.bind(layer), release: layer.release.bind(layer), held: layer.held.bind(layer) };
  await assert.rejects(writePage({ ...options, layer: wrapped }, { chId: 'c1', before: BEFORE, after: bad, as: 'librarian' }));
  assert.deepEqual(gate.held(), [PAGE], 'the fixture reached its state: the chapter is held');

  const woken: string[][] = [];
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const host = { handle: (name: string, fn: (payload: unknown) => unknown) => handlers.set(name, fn), log: () => {}, paths: { library: () => library } };
  const wikiStore = { pages: () => ({ bookId: 'book-fox-1', pages: [{ chId: 'c1' }] }) };
  startReview(host as never, {} as never, {
    layer, wiki: wikiStore as never, pages: {} as never, wikiSaved: (bookId, chId) => { gate.saved(`${bookId}/chapters/${chId}.html`); woken.push([bookId, chId]); },
  });
  assert.deepEqual(await handlers.get('wiki.edit')!({ chId: 'c1', before: changed, after: AFTER, as: 'author' }), { ok: true });
  assert.equal(page(), AFTER);
  assert.deepEqual(gate.held(), [], 'the chapter is the writer\'s again');
  assert.deepEqual(woken, [['book-fox-1', 'c1']], 'the pair waiting on the chapter is woken');
});
