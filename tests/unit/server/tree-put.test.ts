// Rule: a write is accepted only against the version the writer saw, so no accepted
// write ever replaces bytes the writer did not know about, and repeating an accepted
// write changes nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { openTree, type Tree, type TreeOptions } from '../../../server/tree.ts';
import { captureLog, openTestTree, refused, tempHoard } from './hoard.ts';

const blob = (repo: string, text: string) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: repo, input: text }).toString().trim();

const NEW = { ifNoneMatch: '*' } as const;

test('create with If-None-Match returns the blob id of the bytes, and the file is on disk', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const r = await tree.put('book-1/chapters/one.html', Buffer.from('<p>One</p>'), NEW);
  assert.equal(r.version, blob(h.repo, '<p>One</p>'));
  assert.equal(r.seq, 1);
  assert.equal(readFileSync(path.join(h.repo, 'library/book-1/chapters/one.html'), 'utf8'), '<p>One</p>');
  const read = await tree.read('book-1/chapters/one.html');
  assert.equal(read.version, r.version);
  assert.equal(read.bytes.toString(), '<p>One</p>');
  assert.deepEqual(readdirSync(path.join(h.repo, 'library/book-1/chapters')), ['one.html']);
  const state = await tree.state();
  assert.deepEqual({ ...state, serverTime: undefined, epoch: undefined }, { seq: 1, head: null, library: 'library/', serverTime: undefined, epoch: undefined });
  assert.ok(Math.abs(Date.parse(state.serverTime) - Date.now()) < 60_000);
  await tree.close();
});

test('a stale base is refused with the current version and leaves the file alone', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const v1 = (await tree.put('wiki/place.html', Buffer.from('v1'), NEW)).version;
  const v2 = (await tree.put('wiki/place.html', Buffer.from('v2'), { ifMatch: v1 })).version;
  const e = await refused(tree.put('wiki/place.html', Buffer.from('v3'), { ifMatch: v1 }), 'stale', 412);
  assert.equal(e.extra.version, v2);
  assert.equal(readFileSync(path.join(h.repo, 'library/wiki/place.html'), 'utf8'), 'v2');
  assert.equal((await tree.state()).seq, 2);
  await tree.close();
});

test('If-None-Match on an existing path is stale, a write with no precondition is 428, If-Match on a missing path is stale', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const v1 = (await tree.put('a.html', Buffer.from('a'), NEW)).version;
  assert.equal((await refused(tree.put('a.html', Buffer.from('b'), NEW), 'stale', 412)).extra.version, v1);
  await refused(tree.put('a.html', Buffer.from('b'), {}), 'precondition_required', 428);
  await refused(tree.put('b.html', Buffer.from('b'), {}), 'precondition_required', 428);
  assert.equal((await refused(tree.put('b.html', Buffer.from('b'), { ifMatch: v1 }), 'stale', 412)).extra.version, null);
  assert.equal(existsSync(path.join(h.repo, 'library/b.html')), false);
  await tree.close();
});

test('a retried write with the same bytes returns the current version and seq whatever its preconditions', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const v1 = (await tree.put('a.html', Buffer.from('one'), NEW)).version;
  const v2 = await tree.put('a.html', Buffer.from('two'), { ifMatch: v1 });
  for (const pre of [{ ifMatch: v1 }, NEW, {}]) {
    assert.deepEqual(await tree.put('a.html', Buffer.from('two'), pre), v2);
  }
  assert.equal((await tree.state()).seq, 2);
  await tree.close();
});

test('a path that folds to a live path is a case clash, and a file cannot sit where a folder is', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  await tree.put('wiki/Place.html', Buffer.from('p'), NEW);
  await refused(tree.put('wiki/place.html', Buffer.from('q'), NEW), 'case_clash', 409);
  await refused(tree.put('Wiki/other.html', Buffer.from('q'), NEW), 'case_clash', 409);
  await refused(tree.put('wiki', Buffer.from('q'), NEW), 'path_conflict', 409);
  await refused(tree.put('wiki/Place.html/inner.html', Buffer.from('q'), NEW), 'path_conflict', 409);
  assert.equal((await tree.state()).seq, 1);
  await tree.close();
});

test('changes lists each path once with its latest version, in seq order, and pages never skip a seq', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const a1 = await tree.put('a.html', Buffer.from('a1'), NEW);
  await tree.put('b.html', Buffer.from('b'), NEW);
  const a2 = await tree.put('a.html', Buffer.from('a2'), { ifMatch: a1.version });
  const all = await tree.changes(0, 500);
  const { epoch } = all;
  assert.deepEqual(all, { epoch, seq: 3, more: false, changes: [{ path: 'b.html', version: blob(h.repo, 'b') }, { path: 'a.html', version: a2.version }] });
  const page = await tree.changes(0, 1);
  assert.deepEqual([page.seq, page.more, page.changes.map((c) => c.path)], [2, true, ['b.html']]);
  assert.deepEqual(await tree.changes(2, 1), { epoch, seq: 3, more: false, changes: [{ path: 'a.html', version: a2.version }] });
  assert.deepEqual(await tree.changes(99, 5), { epoch, seq: 3, more: false, changes: [] });
  await tree.close();
});

test('concurrent creates of clashing paths accept exactly one', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const results = await Promise.allSettled(['x/A.html', 'x/a.html', 'x/A.html'].map((p, i) => tree.put(p, Buffer.from(`n${i}`), NEW)));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await tree.state()).seq, 1);
  await tree.close();
});

test('a read that overlaps a write returns bytes and the version of the same write', async (t) => {
  const h = tempHoard(t);
  let tree: Tree | undefined;
  let interfere = false;
  const readFile: NonNullable<TreeOptions['readFile']> = async (file) => {
    if (interfere) {
      interfere = false;
      // The write lands after the read chose its version and before the bytes are read.
      const current = (await tree!.read('a.html')).version;
      await tree!.put('a.html', Buffer.from('new'), { ifMatch: current });
    }
    return fsReadFile(file);
  };
  tree = await openTree({ repo: h.repo, library: 'library', state: h.state, log: captureLog().log, readFile });
  await tree.put('a.html', Buffer.from('old'), NEW);
  interfere = true;
  const got = await tree.read('a.html');
  assert.equal(got.version, blob(h.repo, got.bytes.toString()));
  assert.equal(got.bytes.toString(), 'new');
  await tree.close();
});
