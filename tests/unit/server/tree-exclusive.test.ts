// Rules: while an exclusive job runs, no write lands and no file read returns, so the job
// sees the library as it is; a path changed on disk from outside the tree is raised as an
// ordinary change by rescan; and onChange fires for an accepted change and for nothing else.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openTree } from '../../../server/tree.ts';
import { captureLog, openTestTree, refused, tempHoard } from './hoard.ts';

const NEW = { ifNoneMatch: '*' } as const;
const blob = (repo: string, text: string) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: repo, input: text }).toString().trim();
const lib = (h: { repo: string }, rel: string) => path.join(h.repo, 'library', rel);
const later = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

test('a write and a read that arrive while an exclusive job runs wait until it ends', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const first = await tree.put('a.html', Buffer.from('a1'), NEW);
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });

  const job = tree.exclusive(async () => { order.push('job starts'); await gate; order.push('job ends'); });
  const write = tree.put('a.html', Buffer.from('a2'), { ifMatch: first.version }).then(() => order.push('late write'));
  const read = tree.read('a.html').then((r) => { order.push(`read ${r.bytes}`); });
  await later();
  assert.deepEqual(order, ['job starts']);
  release();
  await Promise.all([job, write, read]);
  assert.deepEqual(order, ['job starts', 'job ends', 'late write', 'read a2']);
  await tree.close();
});

test('a read of an untouched file also waits for the exclusive job', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  await tree.put('a.html', Buffer.from('a'), NEW);
  let release!: () => void;
  const job = tree.exclusive(() => new Promise<void>((resolve) => { release = resolve; }));
  let read = false;
  const reading = tree.read('a.html').then(() => { read = true; });
  await later();
  assert.equal(read, false);
  release();
  await Promise.all([job, reading]);
  assert.equal(read, true);
});

test('a failing exclusive job releases the tree and passes its error on', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  await assert.rejects(tree.exclusive(async () => { throw new Error('pull failed'); }), /pull failed/);
  await tree.put('a.html', Buffer.from('a'), NEW);
  assert.equal((await tree.read('a.html')).bytes.toString(), 'a');
});

test('rescan raises one seq for each path whose bytes changed on disk or that vanished, and none for a path that did not change', async (t) => {
  const h = tempHoard(t);
  const { tree, lines } = await openTestTree(h);
  await tree.put('keep.html', Buffer.from('keep'), NEW);
  await tree.put('edit.html', Buffer.from('before'), NEW);
  await tree.put('drop.html', Buffer.from('drop'), NEW);
  const seq = (await tree.state()).seq;

  writeFileSync(lib(h, 'edit.html'), 'after');
  rmSync(lib(h, 'drop.html'));
  mkdirSync(path.join(lib(h, 'deep/er')), { recursive: true });
  writeFileSync(lib(h, 'deep/er/new.html'), 'new');

  const changed = await tree.exclusive((held) => held.rescan(['keep.html', 'edit.html', 'drop.html', 'deep/er/new.html', 'never-existed.html']));
  assert.equal(changed, 3);
  assert.equal((await tree.state()).seq, seq + 3);
  const delta = tree.changes(seq, 500);
  assert.deepEqual(delta.changes.map((c) => c.path).sort(), ['deep/er/new.html', 'drop.html', 'edit.html']);
  assert.deepEqual(Object.fromEntries(delta.changes.map((c) => [c.path, c.version])), {
    'deep/er/new.html': blob(h.repo, 'new'), 'drop.html': null, 'edit.html': blob(h.repo, 'after'),
  });
  assert.equal(lines.filter((l) => l.msg === 'rescan.changed' || l.msg === 'rescan.vanished').length, 3);
  assert.equal(await tree.rescan(['keep.html', 'edit.html']), 0, 'a second look at the same paths changes nothing');
  assert.equal((await tree.state()).seq, seq + 3);
});

test('rescan skips a path the contract refuses, and persists what it raised so a restart agrees', async (t) => {
  const h = tempHoard(t);
  const first = await openTestTree(h);
  writeFileSync(lib(h, 'pulled.html'), 'from the remote');
  assert.equal(await first.tree.rescan(['pulled.html', '../escape.html', 'a/../b.html']), 1);
  assert.equal(first.lines.filter((l) => l.msg === 'rescan.skip_bad_path').length, 2);
  const seq = (await first.tree.state()).seq;
  await first.tree.close();
  const again = await openTestTree(h);
  assert.equal((await again.tree.state()).seq, seq);
  assert.equal(again.lines.some((l) => l.msg === 'reconcile.changed'), false, 'nothing is left for reconcile to find');
});

test('onChange hears the device of every accepted put, delete and move, and nothing for a refused or repeated write', async (t) => {
  const h = tempHoard(t);
  const heard: (string | undefined)[] = [];
  const tree = await openTree({ repo: h.repo, library: h.library, state: h.state, log: captureLog().log, onChange: (d) => heard.push(d) });
  const a = await tree.put('a.html', Buffer.from('a'), { ...NEW, device: 'tablet' });
  await tree.put('a.html', Buffer.from('a'), { ...NEW, device: 'desktop' });
  await refused(tree.put('a.html', Buffer.from('b'), { ifMatch: 'deadbeef', device: 'phone' }), 'stale', 412);
  const moved = await tree.move('a.html', 'b.html', a.version, 'desktop');
  await tree.remove('b.html', moved.version, 'phone');
  await tree.put('c.html', Buffer.from('c'), NEW);
  assert.deepEqual(heard, ['tablet', 'desktop', 'phone', undefined]);
  await tree.close();
});

test('onChange hears the server for the changes reconcile found at open, and not when there were none', async (t) => {
  const h = tempHoard(t);
  const first = await openTree({ repo: h.repo, library: h.library, state: h.state, log: captureLog().log });
  await first.close();
  writeFileSync(lib(h, 'offline.html'), 'written while down');
  const heard: (string | undefined)[] = [];
  const second = await openTree({ repo: h.repo, library: h.library, state: h.state, log: captureLog().log, onChange: (d) => heard.push(d) });
  assert.deepEqual(heard, ['server']);
  await second.close();
  const quiet: (string | undefined)[] = [];
  const third = await openTree({ repo: h.repo, library: h.library, state: h.state, log: captureLog().log, onChange: (d) => quiet.push(d) });
  assert.deepEqual(quiet, []);
  await third.close();
});

test('the state reply carries what stateExtra gives, without losing its own fields', async (t) => {
  const h = tempHoard(t);
  const tree = await openTree({ repo: h.repo, library: h.library, state: h.state, log: captureLog().log, stateExtra: () => ({ history: { lastCommit: null } }) });
  const state = await tree.state();
  assert.deepEqual(state.history, { lastCommit: null });
  assert.equal(state.library, 'library/');
  assert.equal(state.seq, 0);
  await tree.close();
});
