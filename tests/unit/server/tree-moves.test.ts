// Rule: a delete or move is applied once against the version the caller saw; repeating
// an applied one is a success that changes nothing, and a move is one change in the
// seq, never two.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openTestTree, refused, tempHoard } from './hoard.ts';

const NEW = { ifNoneMatch: '*' } as const;

test('delete removes the file and empty folders, tombstones the path, and a retry is a success', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const v = (await tree.put('book-1/chapters/one.html', Buffer.from('1'), NEW)).version;
  await tree.put('book-1/book.json', Buffer.from('{}'), NEW);
  assert.deepEqual(await tree.remove('book-1/chapters/one.html', v), { seq: 3 });
  assert.equal(existsSync(path.join(h.repo, 'library/book-1/chapters')), false);
  assert.equal(existsSync(path.join(h.repo, 'library/book-1/book.json')), true);
  assert.deepEqual(await tree.remove('book-1/chapters/one.html', v), { seq: 3 });
  assert.deepEqual(await tree.remove('book-1/chapters/one.html', undefined), { seq: 3 });
  assert.deepEqual(tree.changes(2, 10).changes, [{ path: 'book-1/chapters/one.html', version: null }]);
  await refused(tree.read('book-1/chapters/one.html'), 'not_found', 404);
  const last = await tree.remove('book-1/book.json', (await tree.read('book-1/book.json')).version);
  assert.equal(last.seq, 4);
  assert.deepEqual(readdirSync(path.join(h.repo, 'library')), []);
  await tree.close();
});

test('delete of an unknown path is 404, without a base 428, with a stale base 412', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  await refused(tree.remove('nothing.html', 'abc'), 'not_found', 404);
  const v1 = (await tree.put('a.html', Buffer.from('1'), NEW)).version;
  const v2 = (await tree.put('a.html', Buffer.from('2'), { ifMatch: v1 })).version;
  await refused(tree.remove('a.html', undefined), 'precondition_required', 428);
  assert.equal((await refused(tree.remove('a.html', v1), 'stale', 412)).extra.version, v2);
  assert.equal(readFileSync(path.join(h.repo, 'library/a.html'), 'utf8'), '2');
  await tree.close();
});

test('a deleted path can be created again', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const v = (await tree.put('a.html', Buffer.from('1'), NEW)).version;
  await tree.remove('a.html', v);
  assert.deepEqual(await tree.put('a.html', Buffer.from('1'), NEW), { version: v, seq: 3 });
  await tree.close();
});

test('move is one seq for both paths, keeps the version, and a retry answers the same', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const v = (await tree.put('wiki/a.html', Buffer.from('a'), NEW)).version;
  assert.deepEqual(await tree.move('wiki/a.html', 'wiki/deep/b.html', v), { version: v, seq: 2 });
  assert.equal(existsSync(path.join(h.repo, 'library/wiki/a.html')), false);
  assert.equal((await tree.read('wiki/deep/b.html')).bytes.toString(), 'a');
  assert.deepEqual(tree.changes(1, 10).changes, [
    { path: 'wiki/a.html', version: null }, { path: 'wiki/deep/b.html', version: v },
  ]);
  assert.deepEqual(await tree.move('wiki/a.html', 'wiki/deep/b.html', v), { version: v, seq: 2 });
  // A page limit of one still returns both halves of the move.
  assert.deepEqual(tree.changes(1, 1), { seq: 2, more: false, changes: tree.changes(1, 10).changes });
  await tree.close();
});

test('move refuses an unknown source, a stale base, a missing base, a live target and a same-path move', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const va = (await tree.put('a.html', Buffer.from('a'), NEW)).version;
  const vb = (await tree.put('b.html', Buffer.from('b'), NEW)).version;
  await refused(tree.move('nope.html', 'c.html', va), 'not_found', 404);
  assert.equal((await refused(tree.move('a.html', 'c.html', vb), 'stale', 412)).extra.version, va);
  await refused(tree.move('a.html', 'c.html', undefined), 'precondition_required', 428);
  await refused(tree.move('a.html', 'b.html', va), 'exists', 409);
  await refused(tree.move('a.html', 'a.html', va), 'bad_move', 400);
  await refused(tree.move('a.html', '../c.html', va), 'bad_path', 400);
  assert.equal((await tree.state()).seq, 2);
  await tree.close();
});

test('a move onto a path that folds to another live path is a case clash; a case-only rename works', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const va = (await tree.put('wiki/a.html', Buffer.from('a'), NEW)).version;
  await tree.put('wiki/B.html', Buffer.from('b'), NEW);
  await refused(tree.move('wiki/a.html', 'wiki/b.html', va), 'case_clash', 409);
  assert.deepEqual(await tree.move('wiki/a.html', 'wiki/A.html', va), { version: va, seq: 3 });
  assert.deepEqual(readdirSync(path.join(h.repo, 'library/wiki')).sort(), ['A.html', 'B.html']);
  assert.deepEqual(tree.changes(2, 10).changes.map((c) => c.path), ['wiki/A.html', 'wiki/a.html']);
  await tree.close();
});

test('a move is checked against its own source for folder-case and file-versus-folder clashes, never a 500', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const va = (await tree.put('wiki/a.html', Buffer.from('a'), NEW)).version;
  await refused(tree.move('wiki/a.html', 'Wiki/a.html', va), 'case_clash', 409);
  await refused(tree.move('wiki/a.html', 'Wiki/b.html', va), 'case_clash', 409);
  await refused(tree.move('wiki/a.html', 'wiki/a.html/b.html', va), 'path_conflict', 409);
  assert.equal(tree.currentSeq(), 1);
  assert.deepEqual(await tree.move('wiki/a.html', 'wiki/A.html', va), { version: va, seq: 2 });
  assert.deepEqual(await tree.move('wiki/A.html', 'wiki/sub/b.html', va), { version: va, seq: 3 });
  assert.equal((await tree.read('wiki/sub/b.html')).bytes.toString(), 'a');
  await tree.close();
});
