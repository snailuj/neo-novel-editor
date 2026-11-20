// Rules: while an exclusive job runs, no write lands and no file read returns, so the job
// sees the library as it is; a path changed on disk from outside the tree is raised as an
// ordinary change by rescan; and onChange fires for an accepted change and for nothing else.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { openTree, type Disk } from '../../../server/tree.ts';
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

/** The disk of a case-insensitive file system: a name in any case finds the entry, and a folder lists names as stored. */
function foldingDisk(): Disk {
  const resolve = (file: string): string => {
    const parts = path.resolve(file).split(path.sep);
    let at = parts[0] + path.sep;
    for (const part of parts.slice(1)) {
      if (!part) continue;
      let names: string[] = [];
      try { names = readdirSync(at); } catch { /* left as written, so the real call fails */ }
      at = path.join(at, names.find((n) => n === part) ?? names.find((n) => n.toLowerCase() === part.toLowerCase()) ?? part);
    }
    return at;
  };
  return { stat: (file) => stat(resolve(file)), readdir: (dir) => readdir(resolve(dir)) };
}

test('on a disk that folds case, rescan of a case-only rename made outside the tree leaves only the new name live', async (t) => {
  const h = tempHoard(t);
  const tree = await openTree({ repo: h.repo, library: 'library', state: h.state, log: captureLog().log, disk: foldingDisk() });
  await tree.put('wiki/Place.html', Buffer.from('place'), NEW);
  await tree.put('Notes/one.html', Buffer.from('one'), NEW);
  const seq = (await tree.state()).seq;
  renameSync(lib(h, 'wiki/Place.html'), lib(h, 'wiki/place.html'));
  renameSync(lib(h, 'Notes'), lib(h, 'notes'));
  assert.deepEqual(readdirSync(lib(h, 'wiki')), ['place.html'], 'the baseline: only the new name is on disk');

  assert.equal(await tree.rescan(['wiki/Place.html', 'wiki/place.html', 'Notes/one.html', 'notes/one.html']), 4);
  assert.deepEqual(Object.fromEntries(tree.changes(seq, 500).changes.map((c) => [c.path, c.version])), {
    'wiki/Place.html': null, 'wiki/place.html': blob(h.repo, 'place'), 'Notes/one.html': null, 'notes/one.html': blob(h.repo, 'one'),
  });
  await assert.rejects(tree.read('wiki/Place.html'), /no such file/);
  assert.equal((await tree.read('wiki/place.html')).bytes.toString(), 'place');
  // With the old name gone, a new file under it is a create, not a case clash.
  await tree.put('wiki/PLACE2.html', Buffer.from('2'), NEW);
  await tree.close();
});

test('rescan of an ordinary rename made outside the tree raises the old path as gone and the new one with the same version', async (t) => {
  const h = tempHoard(t);
  const { tree } = await openTestTree(h);
  const put = await tree.put('wiki/old.html', Buffer.from('same'), NEW);
  const seq = (await tree.state()).seq;
  mkdirSync(lib(h, 'moved'));
  renameSync(lib(h, 'wiki/old.html'), lib(h, 'moved/new.html'));
  assert.equal(await tree.rescan(['wiki/old.html', 'moved/new.html']), 2);
  assert.deepEqual(tree.changes(seq, 500).changes, [{ path: 'wiki/old.html', version: null }, { path: 'moved/new.html', version: put.version }]);
  await tree.close();
});

test('rescan fails when a folder cannot be listed, and leaves a file that is there live', async (t) => {
  const h = tempHoard(t);
  const denied: Disk = {
    stat: (file) => stat(file),
    readdir: async (dir) => {
      if (path.basename(dir) === 'wiki') throw Object.assign(new Error(`EACCES: permission denied, scandir '${dir}'`), { code: 'EACCES' });
      return readdir(dir);
    },
  };
  const tree = await openTree({ repo: h.repo, library: 'library', state: h.state, log: captureLog().log, disk: denied });
  const put = await tree.put('wiki/kept.html', Buffer.from('kept'), NEW);
  const seq = (await tree.state()).seq;
  await assert.rejects(tree.rescan(['wiki/kept.html']), /EACCES/);
  assert.deepEqual(tree.changes(seq, 500).changes, [], 'no tombstone was raised');
  assert.equal((await tree.read('wiki/kept.html')).version, put.version);
  await tree.close();
});
