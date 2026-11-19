// Rule: after any change that adds, removes or renames a directory entry, the folder
// that holds the entry is fsynced, and a failed folder fsync is a warning, never an
// aborted operation.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { makeSyncDir } from '../../../server/durable.ts';
import { openTree } from '../../../server/tree.ts';
import { captureLog, tempHoard, type Hoard } from './hoard.ts';

const NEW = { ifNoneMatch: '*' } as const;

async function recorded(h: Hoard) {
  const calls: string[] = [];
  const tree = await openTree({ repo: h.repo, library: 'library', state: h.state, log: captureLog().log, syncDir: async (d) => { calls.push(path.relative(path.join(h.repo, 'library'), d) || '.'); } });
  return { tree, calls, mark: () => calls.splice(0) };
}

test('a create syncs each folder it made in its parent, and the folder of the file', async (t) => {
  const h = tempHoard(t);
  const { tree, calls } = await recorded(h);
  await tree.put('a/b/c.html', Buffer.from('c'), NEW);
  for (const dir of ['.', 'a', 'a/b']) assert.ok(calls.includes(dir.replaceAll('/', path.sep)), `${dir} in ${calls}`);
  await tree.close();
});

test('a move syncs both parents, the parent of a folder it made, and the folder a prune emptied into', async (t) => {
  const h = tempHoard(t);
  const { tree, calls, mark } = await recorded(h);
  const v = (await tree.put('a/x.html', Buffer.from('x'), NEW)).version;
  mark();
  await tree.move('a/x.html', 'b/y.html', v);
  for (const dir of ['.', 'a', 'b']) assert.ok(calls.includes(dir), `${dir} in ${calls}`);
  await tree.close();
});

test('a delete syncs the folder of the file and the folder left after pruning', async (t) => {
  const h = tempHoard(t);
  const { tree, calls, mark } = await recorded(h);
  await tree.put('book-1/book.json', Buffer.from('{}'), NEW);
  const v = (await tree.put('book-1/chapters/one.html', Buffer.from('1'), NEW)).version;
  mark();
  await tree.remove('book-1/chapters/one.html', v);
  // The state folder is synced too; only the library folders are under test here.
  assert.deepEqual(calls.filter((d) => !d.startsWith('..')), [path.join('book-1', 'chapters'), 'book-1']);
  await tree.close();
});

test('a folder fsync that fails is logged as a warning and does not throw', async (t) => {
  const h = tempHoard(t);
  const { log, lines } = captureLog();
  await makeSyncDir(log)(path.join(h.root, 'no-such-folder'));
  assert.deepEqual(lines.map((l) => [l.level, l.msg]), [['warn', 'syncdir.failed']]);
  await makeSyncDir(log)(h.root);
  assert.equal(lines.length, 1);
});
