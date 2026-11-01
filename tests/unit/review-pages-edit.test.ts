// Rules for a page edited by its id (pages.edit):
// - Librarian-Writes-Only-Its-Own: a librarian edit lands only on a wiki page whose sidecar
//   makes it the librarian's; on a sources page or an author-owned wiki page it is refused
//   and the file is unchanged;
// - Librarian-Edit-Is-Paired: an allowed librarian edit is committed as the librarian's,
//   after the writer's pending work is committed as theirs;
// - Gate-Refusal-Reverts: a librarian edit the pre-commit gate refuses is put back on disk
//   and is not in history;
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
  startReview(host as never, {} as never, { layer: o.layer, wiki: { pages: () => null } as never, pages: o.store as never });
  const call = async (name: string, payload: unknown) => handlers.get(name)!(payload);
  assert.deepEqual(await call('pages.edit', { page: SOURCE, before: BEFORE, after: AFTER, as: 'author' }), { ok: true });
  assert.equal(page(SOURCE), AFTER);
  assert.deepEqual(await call('pages.edit', { page: SOURCE, before: AFTER, after: BEFORE, as: 'librarian' }), { ok: false, reason: 'owned' });
  await assert.rejects(call('pages.edit', { page: 'notes/x.html', before: '', after: '', as: 'author' }), /pages\.edit/);
  assert.deepEqual(await call('review.owners', { pages: [OURS, THEIRS, SOURCE] }), { librarian: [OURS] });
  assert.deepEqual(await call('review.owners', { tree: 'wiki' }), { librarian: [OURS] });
  assert.deepEqual(await call('review.owners', { bookId: 'book-none-1' }), { librarian: [] });
  await assert.rejects(call('review.owners', { tree: 'wiki', pages: [] }), /review\.owners/);
  await assert.rejects(call('review.owners', {}), /review\.owners/);
  assert.deepEqual(await call('wiki.edit', { chId: 'c9', before: '', after: '', as: 'author' }), { ok: false, reason: 'missing' });
});
