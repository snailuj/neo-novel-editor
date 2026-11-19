// Rule: after any restart the index describes exactly the files on disk. Seq and versions
// survive a clean restart unchanged, and whatever differs from the disk (an edit while the
// server was down, a lost state folder) is raised once as an ordinary change.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openTree } from '../../../server/tree.ts';
import { captureLog, openTestTree, tempHoard } from './hoard.ts';

const NEW = { ifNoneMatch: '*' } as const;
const blob = (repo: string, text: string) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: repo, input: text }).toString().trim();
const lib = (h: { repo: string }, rel: string) => path.join(h.repo, 'library', rel);

function write(h: { repo: string }, rel: string, text: string): void {
  mkdirSync(path.dirname(lib(h, rel)), { recursive: true });
  writeFileSync(lib(h, rel), text);
}

async function seeded(t: Parameters<typeof tempHoard>[0]) {
  const h = tempHoard(t);
  const first = await openTestTree(h);
  const a = await first.tree.put('book-1/chapters/one.html', Buffer.from('one'), NEW);
  await first.tree.put('wiki/place.html', Buffer.from('place'), NEW);
  await first.tree.remove('wiki/place.html', blob(h.repo, 'place'));
  await first.tree.move('book-1/chapters/one.html', 'book-1/chapters/two.html', a.version);
  await first.tree.close();
  return { h, before: first.tree };
}

test('a clean restart keeps seq and index and raises nothing', async (t) => {
  const { h, before } = await seeded(t);
  const { tree, lines } = await openTestTree(h);
  assert.equal((await tree.state()).seq, 4);
  assert.deepEqual(tree.changes(0, 500), before.changes(0, 500));
  assert.equal(lines.some((l) => l.msg === 'reconcile.changed' || l.msg === 'reconcile.vanished'), false);
  assert.equal(lines.some((l) => l.level === 'warn'), false);
  await tree.close();
});

test('a lost state folder is rebuilt from the disk: every file is listed with its blob id, and the loss is logged', async (t) => {
  const { h } = await seeded(t);
  write(h, 'wiki/other.html', 'other');
  rmSync(h.state, { recursive: true });
  const { tree, lines } = await openTestTree(h);
  assert.deepEqual(tree.changes(0, 500), {
    seq: 2, more: false,
    changes: [
      { path: 'book-1/chapters/two.html', version: blob(h.repo, 'one') },
      { path: 'wiki/other.html', version: blob(h.repo, 'other') },
    ],
  });
  assert.ok(lines.some((l) => l.level === 'warn' && l.msg === 'state.fresh'));
  await tree.close();
  assert.equal((await openTestTree(h)).tree.currentSeq(), 2, 'the rebuilt index was saved');
});

test('files edited, added or removed on disk while the server was down each get a new seq on restart', async (t) => {
  const { h } = await seeded(t);
  write(h, 'book-1/chapters/two.html', 'edited');
  write(h, 'wiki/new.html', 'new');
  const { tree } = await openTestTree(h);
  assert.equal(tree.currentSeq(), 6);
  assert.deepEqual(tree.changes(4, 10).changes, [
    { path: 'book-1/chapters/two.html', version: blob(h.repo, 'edited') },
    { path: 'wiki/new.html', version: blob(h.repo, 'new') },
  ]);
  await tree.close();
  rmSync(lib(h, 'wiki/new.html'));
  const again = await openTestTree(h);
  assert.deepEqual(again.tree.changes(6, 10).changes, [{ path: 'wiki/new.html', version: null }]);
  assert.equal(again.tree.currentSeq(), 7);
  await again.tree.close();
});

test('an unreadable state.json is moved aside, not deleted, and the index is rebuilt', async (t) => {
  const { h } = await seeded(t);
  writeFileSync(path.join(h.state, 'state.json'), '{"format":1,"seq":');
  const { tree, lines } = await openTestTree(h);
  assert.equal(tree.currentSeq(), 1);
  const aside = readdirSync(h.state).filter((f) => f.startsWith('state.json.corrupt-'));
  assert.equal(aside.length, 1);
  assert.ok(lines.some((l) => l.level === 'warn' && l.msg === 'state.corrupt'));
  await tree.close();
});

test('the library folder is created when missing, and temp files and unacceptable names are skipped with a warning', async (t) => {
  const h = tempHoard(t);
  assert.equal(existsSync(lib(h, '')), false);
  const first = await openTestTree(h);
  assert.ok(first.lines.some((l) => l.msg === 'library.created'));
  await first.tree.close();
  write(h, 'wiki/.git/config', 'x');
  write(h, 'wiki/.neo-tmp-abc', 'half written');
  write(h, 'wiki/bad:name.html', 'x');
  write(h, 'wiki/ok.html', 'ok');
  const { tree, lines } = await openTestTree(h);
  assert.deepEqual(tree.changes(0, 10).changes.map((c) => c.path), ['wiki/ok.html']);
  assert.deepEqual(lines.filter((l) => l.level === 'warn').map((l) => l.msg).sort(), ['reconcile.skip_bad_path', 'reconcile.skip_bad_path', 'reconcile.skip_temp']);
  await tree.close();
});

test('a state folder inside the repo is refused', async (t) => {
  const h = tempHoard(t);
  await assert.rejects(openTree({ repo: h.repo, library: 'library', state: path.join(h.repo, '.state'), log: captureLog().log }), /inside the repo/);
});

test('a move that crashed between the rename and the state save replays correctly on a case-folding client', async (t) => {
  const h = tempHoard(t);
  const first = await openTestTree(h);
  await first.tree.put('wiki/a.html', Buffer.from('a'), NEW);
  await first.tree.close();
  // The crash window: the disk holds the renamed file, state.json still describes the old name.
  renameSync(lib(h, 'wiki/a.html'), lib(h, 'wiki/A.html'));
  const { tree } = await openTestTree(h);
  const client = new Map<string, string | null>([['wiki/a.html', blob(h.repo, 'a')]]);
  for (const c of tree.changes(1, 10).changes) {
    if (c.version === null) client.delete(c.path.toLowerCase()); else client.set(c.path.toLowerCase(), c.version);
  }
  assert.deepEqual([...client], [['wiki/a.html', blob(h.repo, 'a')]]);
  assert.deepEqual(tree.changes(1, 10).changes.map((c) => c.version === null), [true, false]);
  await tree.close();
});
