// Rules for a page edited by its id (pages.edit):
// - Librarian-Writes-Only-Its-Own: a librarian edit lands only on a wiki page whose sidecar
//   makes it the librarian's; on a sources page or an author-owned wiki page it is refused
//   and the file is unchanged;
// - Librarian-Edit-Is-Paired: an allowed librarian edit is committed as the librarian's,
//   after the writer's pending work is committed as theirs;
// - Gate-Refusal-Reverts: a librarian edit the pre-commit gate refuses is put back on disk
//   and is not in history;
// - Restored-Paths-Are-Released: once a refused librarian edit is put back, the page is no
//   longer held out of the writer's commits, so the author's next edit to it is checkpointed;
// - Failed-Restore-Stays-Held: a refused librarian edit whose restore fails stays held and is
//   reported as an error;
// - Author-Save-Frees-A-Held-Page: an author save of a held page frees it, and the next
//   checkpoint commits it as the author's; a librarian edit, or an author save that
//   was refused, does not say the author saved;
// - Refused-Edit-Keeps-Earlier-Hold: a refused librarian edit never frees a hold that
//   existed before it;
// - Stale-Edit-Leaves-No-Librarian-Commit: a librarian edit refused as stale leaves no
//   librarian commit, and the text that made it stale is not committed as the librarian's;
// - Librarian-Never-Writes-An-Authors-Page: the librarian never writes, or commits, a page that
//   is the author's at the moment of the write, even if the sidecar changed after the first look;
// - Author-Edits-Both-Trees: an author edit lands in either tree;
// - Edit-Needs-Current-Page: an edit lands only while the file holds what the caller read;
// - Owners-List-Only-Librarian: review.owners names the librarian's pages among those asked.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Gate } from '../../src/hoard/git/gate.ts';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { signalPageChanges } from '../../src/hoard/pages/signals.ts';
import { PageStore } from '../../src/hoard/pages/store.ts';
import { startReview } from '../../src/hoard/review/main.ts';
import { editPage, librarianAmong, librarianInTree } from '../../src/hoard/review/edit.ts';
import { isolateGitConfig, log, tempDir, tempLibrary } from './git-support.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const BEFORE = '<p data-block="b1">The quay is old.</p>';
const AFTER = '<p data-block="b1">The quay is very old.</p>';
const OURS = 'wiki/Harbour.html';
const THEIRS = 'wiki/Ferry.html';
const SOURCE = 'sources/Log.html';

const sidecar = (frontmatter: object) => JSON.stringify({
  version: 1,
  source: { path: '/vault/Harbour.md', name: 'Harbour', sha256: 'a'.repeat(64) },
  frontmatter,
  imported: '2026-10-15T10:00:00Z',
});

async function library(t: { after(fn: () => void): void }) {
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
  for (const id of [OURS, THEIRS, SOURCE]) lib.write(id, BEFORE);
  lib.write(`.neo/pages/${OURS}.json`, sidecar({ type: 'lore', provenance: { author: 'librarian' } }));
  lib.write(`.neo/pages/${THEIRS}.json`, sidecar({ type: 'writing' }));
  lib.write(`.neo/pages/${SOURCE}.json`, sidecar({ type: 'lore', provenance: { author: 'librarian' } }));
  await layer.commitNow('import');
  const lines: string[] = [];
  const logger = (_level: string, message: string) => { lines.push(message); };
  const store = new PageStore({ library: () => lib.library, layer, log: logger });
  const o = { library: () => lib.library, store, layer, log: logger };
  const page = (id: string) => readFileSync(path.join(lib.library, id), 'utf8');
  const history = () => log(lib.git, lib.library, '%an|%(trailers:key=Neo-Checkpoint,valueonly)');
  return { ...lib, layer, o, page, history, lines };
}

test('Librarian-Writes-Only-Its-Own: a librarian edit to a sources page is refused and the file is unchanged', async (t) => {
  const { o, page, history } = await library(t);
  const was = await history();
  assert.deepEqual(await editPage(o, { page: SOURCE, before: BEFORE, after: AFTER, as: 'librarian' }), { ok: false, reason: 'owned' });
  assert.equal(page(SOURCE), BEFORE);
  assert.deepEqual(await history(), was);
});

test('Librarian-Writes-Only-Its-Own: a librarian edit to an author-owned wiki page is refused', async (t) => {
  const { o, page } = await library(t);
  assert.deepEqual(await editPage(o, { page: THEIRS, before: BEFORE, after: AFTER, as: 'librarian' }), { ok: false, reason: 'owned' });
  assert.equal(page(THEIRS), BEFORE);
});

test('Librarian-Edit-Is-Paired: a librarian edit to its own wiki page lands as a librarian commit', async (t) => {
  const { o, page, history, write, git, library: lib } = await library(t);
  write('sources/Typed.html', '<p>Typed meanwhile.</p>');
  assert.deepEqual(await editPage(o, { page: OURS, before: BEFORE, after: AFTER, as: 'librarian' }), { ok: true });
  assert.equal(page(OURS), AFTER);
  assert.deepEqual((await history()).slice(0, 2), ['Librarian|librarian-after', 'Ada|librarian-before']);
  const { stdout } = await git.run(lib, ['show', '--name-only', '--format=', 'HEAD']);
  assert.deepEqual(stdout.split('\n').filter(Boolean), [OURS], 'the librarian\'s commit holds the page alone');
});

test('Gate-Refusal-Reverts: a librarian edit the gate refuses is put back on disk and is not in history', async (t) => {
  const { o, layer, library: lib, page, history } = await library(t);
  layer.useGate(new Gate({ library: () => lib, log: () => {} }));
  const was = await history();
  const written = await editPage(o, { page: OURS, before: BEFORE, after: '<p data-block="b 1">The quay is very old.</p>', as: 'librarian' });
  assert.ok(!written.ok && written.reason === 'refused' && written.findings.some((f) => f.path === OURS), JSON.stringify(written));
  assert.equal(page(OURS), BEFORE);
  assert.deepEqual(await history(), was);
});

test('Restored-Paths-Are-Released: after a refused librarian edit is put back, the author\'s next edit to the page is checkpointed', async (t) => {
  const { o, layer, library: lib, page, history } = await library(t);
  const gate = new Gate({ library: () => lib, log: () => {} });
  layer.useGate(gate);
  const written = await editPage(o, { page: OURS, before: BEFORE, after: '<p data-block="b 1">The quay is very old.</p>', as: 'librarian' });
  assert.ok(!written.ok && written.reason === 'refused');
  assert.equal(page(OURS), BEFORE);
  assert.deepEqual(gate.held(), [], 'the restored page is not held');
  assert.deepEqual(await editPage(o, { page: OURS, before: BEFORE, after: AFTER, as: 'author' }), { ok: true });
  const was = await history();
  await layer.commitNow('import-author');
  assert.equal(await layer.show('HEAD', OURS), AFTER, 'the writer\'s checkpoint took the author\'s edit');
  assert.equal((await history()).length, was.length + 1);
});

test('Failed-Restore-Stays-Held: a refused librarian edit whose restore fails stays held and is reported as an error', async (t) => {
  const { o, layer, library: lib, page } = await library(t);
  const gate = new Gate({ library: () => lib, log: () => {} });
  layer.useGate(gate);
  const logged: { level: string; message: string; data: unknown }[] = [];
  // The file is changed by someone else between the swap and the gate's refusal (still a text the gate refuses).
  const store = {
    write: async (id: string, was: string, now: string) => {
      const written = await o.store.write(id, was, now);
      if (written.ok && now === AFTER_BAD) writeFileSync(path.join(lib, id), CHANGED);
      return written;
    },
  };
  const CHANGED = '<p data-block="b 2">Changed meanwhile.</p>';
  const AFTER_BAD = '<p data-block="b 1">The quay is very old.</p>';
  const log = (level: string, message: string, data?: unknown) => { logged.push({ level, message, data }); };
  await assert.rejects(editPage({ ...o, store, log } as typeof o, { page: OURS, before: BEFORE, after: AFTER_BAD, as: 'librarian' }));
  assert.deepEqual(gate.held(), [OURS], 'the page is still held');
  assert.equal(page(OURS), CHANGED, 'the writer\'s newer text is left alone');
  assert.ok(logged.some((l) => l.level === 'error' && (l.data as { page?: string; reason?: string }).page === OURS && (l.data as { reason?: string }).reason === 'stale'), JSON.stringify(logged));
  assert.ok(!logged.some((l) => /as it was/.test(l.message)), 'no line says the page is as it was');
});

// A librarian edit the gate refuses whose restore fails, leaving the writer's newer text held.
async function heldPage(t: Parameters<typeof library>[0], saved: string[] = []) {
  const lib = await library(t);
  const gate = new Gate({ library: () => lib.library, log: () => {} });
  lib.layer.useGate(gate);
  const AFTER_BAD = '<p data-block="b 1">The quay is very old.</p>';
  const CHANGED = '<p data-block="b 2">Changed meanwhile.</p>';
  const store = {
    write: async (id: string, was: string, now: string, who?: 'author' | 'librarian') => {
      const written = await lib.o.store.write(id, was, now, who);
      if (written.ok && now === AFTER_BAD) writeFileSync(path.join(lib.library, id), CHANGED);
      return written;
    },
  };
  signalPageChanges(lib.o.store, { saved: (id) => { saved.push(id); gate.saved(id); } }, { landed: () => {} }, () => {});
  await assert.rejects(editPage({ ...lib.o, store } as unknown as typeof lib.o, { page: OURS, before: BEFORE, after: AFTER_BAD, as: 'librarian' }));
  assert.deepEqual(gate.held(), [OURS]);
  assert.deepEqual(saved, [], 'a failed restore is not an author save');
  return { ...lib, gate, CHANGED };
}

test('Author-Save-Frees-A-Held-Page: an author save of a held page frees it, and the next checkpoint commits it as the author\'s', async (t) => {
  const saved: string[] = [];
  const { o, layer, gate, page, CHANGED } = await heldPage(t, saved);
  assert.deepEqual(await editPage(o, { page: OURS, before: CHANGED, after: AFTER, as: 'author' }), { ok: true });
  assert.deepEqual(saved, [OURS]);
  assert.deepEqual(gate.held(), []);
  await layer.commitNow('import-author');
  assert.equal(await layer.show('HEAD', OURS), AFTER);
  assert.equal(page(OURS), AFTER);
});

test('Author-Save-Frees-A-Held-Page: a librarian edit and a refused author save do not say the author saved', async (t) => {
  const { o } = await library(t);
  const saved: string[] = [];
  signalPageChanges(o.store as never, { saved: (id) => { saved.push(id); } }, { landed: () => {} }, () => {});
  assert.deepEqual(await editPage(o, { page: OURS, before: BEFORE, after: AFTER, as: 'librarian' }), { ok: true });
  assert.deepEqual(await editPage(o, { page: OURS, before: BEFORE, after: AFTER, as: 'author' }), { ok: false, reason: 'stale' });
  assert.deepEqual(await editPage(o, { page: 'wiki/Gone.html', before: BEFORE, after: AFTER, as: 'author' }), { ok: false, reason: 'missing' });
  assert.deepEqual(saved, []);
});

test('Refused-Edit-Keeps-Earlier-Hold: a librarian edit to a page the gate already holds is refused, and the hold stays', async (t) => {
  const { o, gate, page, CHANGED, history } = await heldPage(t);
  const was = await history();
  const lines: string[] = [];
  const logged = { ...o, log: (_level: string, message: string) => { lines.push(message); } };
  // an edit the gate would refuse again: putting it back must not hand the writer's held text to their commits
  const written = await editPage(logged, { page: OURS, before: CHANGED, after: '<p data-block="b 3">Again.</p>', as: 'librarian' });
  assert.deepEqual(written, { ok: false, reason: 'held' });
  assert.deepEqual(gate.held(), [OURS]);
  assert.equal(page(OURS), CHANGED);
  assert.deepEqual(await history(), was, 'no commit was made');
  assert.ok(lines.some((l) => /still holds the page/.test(l)), JSON.stringify(lines));
});

test('Stale-Edit-Leaves-No-Librarian-Commit: a librarian edit refused as stale makes no librarian commit', async (t) => {
  const { o, page, history, library: lib } = await library(t);
  const newer = '<p data-block="b1">The quay is old, said the other device.</p>';
  // the page changes between the author's commit and the swap
  const store = { write: async (id: string, was: string, now: string) => { writeFileSync(path.join(lib, id), newer); return o.store.write(id, was, now); } };
  const librarian = async () => (await history()).filter((l) => l.startsWith('Librarian|'));
  const was = await librarian();
  assert.deepEqual(await editPage({ ...o, store } as unknown as typeof o, { page: OURS, before: BEFORE, after: AFTER, as: 'librarian' }), { ok: false, reason: 'stale' });
  assert.equal(page(OURS), newer);
  assert.deepEqual(await librarian(), was);
});

test('Librarian-Never-Writes-An-Authors-Page: a sidecar that turns author after the first look leaves the page unwritten and uncommitted', async (t) => {
  const { o, layer, page, history, write, library: lib } = await library(t);
  const gate = new Gate({ library: () => lib, log: () => {} });
  layer.useGate(gate);
  // The writer claims the page after editPage first looked and before the swap runs.
  const around: typeof layer.around = (paths, apply, as, wrote) => layer.around(paths, async () => {
    write(`.neo/pages/${OURS}.json`, sidecar({ type: 'writing' }));
    return apply();
  }, as, wrote);
  const racing = { ...o, layer: { around, release: layer.release.bind(layer), held: layer.held.bind(layer) } };
  const librarian = async () => (await history()).filter((l) => l.startsWith('Librarian|'));
  const was = await librarian();
  assert.deepEqual(await editPage(racing, { page: OURS, before: BEFORE, after: AFTER, as: 'librarian' }), { ok: false, reason: 'owned' });
  assert.equal(page(OURS), BEFORE);
  assert.deepEqual(await librarian(), was, 'no librarian commit');
  assert.deepEqual(gate.held(), [], 'nothing is left held');
});

test('Author-Edits-Both-Trees: an author edit to a sources page lands', async (t) => {
  const { o, page } = await library(t);
  assert.deepEqual(await editPage(o, { page: SOURCE, before: BEFORE, after: AFTER, as: 'author' }), { ok: true });
  assert.equal(page(SOURCE), AFTER);
  assert.deepEqual(await editPage(o, { page: THEIRS, before: BEFORE, after: AFTER, as: 'author' }), { ok: true });
  assert.equal(page(THEIRS), AFTER);
});

test('Edit-Needs-Current-Page: a stale before is refused for either voice, and a page that is not there is missing', async (t) => {
  const { o, page, write } = await library(t);
  const newer = '<p data-block="b1">The quay is old, said the other device.</p>';
  write(OURS, newer);
  for (const as of ['librarian', 'author'] as const) {
    assert.deepEqual(await editPage(o, { page: OURS, before: BEFORE, after: AFTER, as }), { ok: false, reason: 'stale' });
    assert.equal(page(OURS), newer);
  }
  assert.deepEqual(await editPage(o, { page: 'wiki/Gone.html', before: BEFORE, after: AFTER, as: 'author' }), { ok: false, reason: 'missing' });
});

test('Owners-List-Only-Librarian: review.owners lists only the librarian\'s pages among those asked', async (t) => {
  const { library: lib } = await library(t);
  assert.deepEqual(await librarianAmong(lib, [OURS, THEIRS, SOURCE, 'wiki/NoSidecar.html'], () => {}), [OURS]);
  assert.deepEqual(await librarianAmong(lib, [THEIRS, SOURCE], () => {}), []);
  assert.deepEqual(await librarianInTree(lib, 'wiki', () => {}), [OURS]);
  assert.deepEqual(await librarianInTree(lib, 'sources', () => {}), [], 'a sources page is never the librarian\'s');
});

test('Owners-List-Only-Librarian: a tree listing skips a sidecar whose page is gone and any that does not read', async (t) => {
  const { library: lib, write } = await library(t);
  mkdirSync(path.join(lib, '.neo', 'pages', 'wiki', 'People'), { recursive: true });
  write('.neo/pages/wiki/People/Gone.html.json', sidecar({ type: 'lore' }));
  write('.neo/pages/wiki/Broken.html.json', '{ not json');
  write('wiki/Broken.html', BEFORE);
  writeFileSync(path.join(lib, '.neo', 'pages', 'renames.json'), '[]');
  assert.deepEqual(await librarianInTree(lib, 'wiki', () => {}), [OURS]);
});

test('the channels: pages.edit and review.owners take a page form, and wiki.edit and the book form still work', async (t) => {
  const { o, library: lib, page } = await library(t);
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const host = { handle: (name: string, fn: (payload: unknown) => unknown) => handlers.set(name, fn), log: () => {}, paths: { library: () => lib } };
  const saved: string[] = [];
  signalPageChanges(o.store, { saved: (id) => { saved.push(id); } }, { landed: () => {} }, () => {});
  startReview(host as never, {} as never, { layer: o.layer, wiki: { pages: () => null } as never, pages: o.store as never });
  const call = async (name: string, payload: unknown) => handlers.get(name)!(payload);
  assert.deepEqual(await call('pages.edit', { page: SOURCE, before: BEFORE, after: AFTER, as: 'author' }), { ok: true });
  assert.equal(page(SOURCE), AFTER);
  assert.deepEqual(saved, [SOURCE]);
  assert.deepEqual(await call('pages.edit', { page: SOURCE, before: AFTER, after: BEFORE, as: 'librarian' }), { ok: false, reason: 'owned' });
  assert.deepEqual(saved, [SOURCE]);
  await assert.rejects(call('pages.edit', { page: 'notes/x.html', before: '', after: '', as: 'author' }), /pages\.edit/);
  assert.deepEqual(await call('review.owners', { pages: [OURS, THEIRS, SOURCE] }), { librarian: [OURS] });
  assert.deepEqual(await call('review.owners', { tree: 'wiki' }), { librarian: [OURS] });
  assert.deepEqual(await call('review.owners', { bookId: 'book-none-1' }), { librarian: [] });
  await assert.rejects(call('review.owners', { tree: 'wiki', pages: [] }), /review\.owners/);
  await assert.rejects(call('review.owners', {}), /review\.owners/);
  assert.deepEqual(await call('wiki.edit', { chId: 'c9', before: '', after: '', as: 'author' }), { ok: false, reason: 'missing' });
});
