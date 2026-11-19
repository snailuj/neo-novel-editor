// Rule: a sync cycle never leaves the library in a state a client could misread. What it
// pulls is raised through the tree like any change, its own commits reach the remote, a
// conflict is aborted before it can put markers on disk, and every outcome is reported
// once and on /v1/state.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createServer } from '../../../server/http.ts';
import { commits, git, NEW, openWithHistory, pushFrom, syncHoard } from './history-support.ts';
import { clientFor } from './support.ts';

const lib = (h: { repo: string }, rel: string) => path.join(h.repo, 'library', rel);
const remoteFiles = (h: { remote: string }) => git(h.remote, 'log', 'main', '--format=', '--name-only').split('\n').filter(Boolean).sort();
const SYNC = { syncSeconds: 300 };

test('a cycle commits what is waiting, pulls what another clone pushed so the tree raises its seq, and pushes the server\'s own commits', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  const seqAtOpen = (await l.tree.state()).seq;
  await l.tree.put('wiki/mine.html', Buffer.from('mine'), { ...NEW, device: 'tablet' });
  pushFrom(h.other, { 'library/wiki/theirs.html': 'theirs', 'library/wiki/shared.html': 'shared v2', 'outside.md': 'not the library' });
  const seqBefore = (await l.tree.state()).seq;

  const status = await l.sync.runOnce();
  assert.equal(status.state, 'ok', status.message);

  const delta = l.tree.changes(seqBefore, 500);
  assert.deepEqual(delta.changes.map((c) => c.path).sort(), ['wiki/shared.html', 'wiki/theirs.html']);
  assert.ok(delta.seq > seqBefore);
  assert.equal((await l.tree.read('wiki/theirs.html')).bytes.toString(), 'theirs');
  assert.equal((await l.tree.read('wiki/shared.html')).bytes.toString(), 'shared v2');
  assert.equal(seqAtOpen < seqBefore, true);

  assert.deepEqual(remoteFiles(h), ['README.md', 'library/wiki/mine.html', 'library/wiki/shared.html', 'library/wiki/shared.html', 'library/wiki/theirs.html', 'outside.md']);
  assert.equal(git(h.remote, 'rev-parse', 'main').trim(), git(h.repo, 'rev-parse', 'HEAD').trim(), 'the remote holds exactly the server\'s HEAD');
  assert.equal(l.history.lastCommit(), git(h.repo, 'rev-parse', 'HEAD').trim());
  const sync = commits(h.repo).find((c) => c.checkpoint === 'sync');
  assert.deepEqual(sync?.devices, ['tablet'], 'the commit made before the pull names the device that wrote');
  assert.equal(git(h.repo, 'status', '--porcelain').trim(), '');
});

test('a path another clone deleted is raised as a delete', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  const seq = (await l.tree.state()).seq;
  pushFrom(h.other, { 'library/wiki/shared.html': null });
  assert.equal((await l.sync.runOnce()).state, 'ok');
  assert.deepEqual(l.tree.changes(seq, 500).changes, [{ path: 'wiki/shared.html', version: null }]);
});

test('a conflict aborts the rebase, leaves no markers on disk, keeps the server\'s own commit, and is logged once however many cycles it repeats', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  const shared = await l.tree.read('wiki/shared.html');
  await l.tree.put('wiki/shared.html', Buffer.from('shared, server edit'), { ifMatch: shared.version, device: 'tablet' });
  pushFrom(h.other, { 'library/wiki/shared.html': 'shared, other edit' });
  const seq = (await l.tree.state()).seq;

  const first = await l.sync.runOnce();
  assert.equal(first.state, 'conflict');
  assert.match(first.message, /shared\.html/);
  assert.equal(readFileSync(lib(h, 'wiki/shared.html'), 'utf8'), 'shared, server edit');
  assert.equal(existsSync(path.join(h.repo, '.git', 'rebase-merge')), false);
  assert.equal(existsSync(path.join(h.repo, '.git', 'rebase-apply')), false);
  assert.equal(git(h.repo, 'status', '--porcelain').trim(), '');
  assert.equal((await l.tree.state()).seq, seq, 'a conflict changes nothing the clients see');
  assert.equal(git(h.repo, 'log', '-1', '--format=%s').trim(), 'Writing, before a sync with the remote');

  await l.sync.runOnce();
  await l.sync.runOnce();
  assert.equal(l.lines.filter((x) => x.level === 'error' && x.msg === 'sync.conflict').length, 1);

  const server = createServer(l.tree, { log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const state = (await clientFor(server).call('GET', '/v1/state')).json;
  assert.equal(state.history.sync.state, 'conflict');
  assert.match(state.history.sync.message, /shared\.html/);
  assert.match(state.history.sync.at, /^\d{4}-\d\d-\d\dT/);
});

test('after a conflict, the next cycle goes through once the remote has moved on', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  const shared = await l.tree.read('wiki/shared.html');
  await l.tree.put('wiki/shared.html', Buffer.from('shared, server edit'), { ifMatch: shared.version, device: 'tablet' });
  pushFrom(h.other, { 'library/wiki/shared.html': 'shared, other edit' });
  assert.equal((await l.sync.runOnce()).state, 'conflict');
  // The other writer takes the server's version, as a person resolving the clash would.
  git(h.other, 'fetch', '-q', 'origin');
  pushFrom(h.other, { 'library/wiki/shared.html': 'shared, server edit' }, 'resolved');
  assert.equal((await l.sync.runOnce()).state, 'ok');
  assert.equal(git(h.remote, 'rev-parse', 'main').trim(), git(h.repo, 'rev-parse', 'HEAD').trim());
});

test('a rebase left in progress skips the cycle with a warning, and the next cycle runs once it is gone', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  await l.tree.put('wiki/mine.html', Buffer.from('mine'), { ...NEW, device: 'tablet' });
  const marker = path.join(h.repo, '.git', 'rebase-merge');
  mkdirSync(marker);
  const skipped = await l.sync.runOnce();
  assert.equal(skipped.state, 'rebase_in_progress');
  assert.ok(l.lines.some((x) => x.level === 'warn' && x.msg.startsWith('sync.skipped') && /rebase/.test(x.msg)));
  assert.equal(git(h.remote, 'log', 'main', '--format=%s').trim(), 'seed', 'nothing was committed or pushed');
  assert.equal(commits(h.repo).some((c) => c.checkpoint === 'sync'), false);

  const { rmSync } = await import('node:fs');
  rmSync(marker, { recursive: true });
  assert.equal((await l.sync.runOnce()).state, 'ok');
  assert.ok(remoteFiles(h).includes('library/wiki/mine.html'));
});

test('a rejected push is logged and reported, and the next cycle retries it', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  const hook = path.join(h.remote, 'hooks', 'pre-receive');
  const flag = path.join(h.root, 'reject');
  writeFileSync(flag, '');
  writeFileSync(hook, `#!/bin/sh\nif [ -e "${flag.replace(/\\/g, '/')}" ]; then echo "refused by the test" >&2; exit 1; fi\n`);
  chmodSync(hook, 0o755);
  await l.tree.put('wiki/mine.html', Buffer.from('mine'), { ...NEW, device: 'tablet' });

  const rejected = await l.sync.runOnce();
  assert.equal(rejected.state, 'error');
  assert.match(rejected.message, /refused by the test|rejected|declined/);
  assert.equal(l.lines.filter((x) => x.level === 'error' && x.msg === 'sync.failed').length, 1);
  await l.sync.runOnce();
  assert.equal(l.lines.filter((x) => x.level === 'error' && x.msg === 'sync.failed').length, 1, 'the same failure is logged once');

  const { rmSync } = await import('node:fs');
  rmSync(flag);
  assert.equal((await l.sync.runOnce()).state, 'ok');
  assert.ok(remoteFiles(h).includes('library/wiki/mine.html'));
});

test('a cycle asked for while another runs is skipped with a warning, and does not run twice', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  await l.tree.put('wiki/mine.html', Buffer.from('mine'), { ...NEW, device: 'tablet' });
  const first = l.sync.runOnce();
  const second = l.sync.runOnce();
  await Promise.all([first, second]);
  assert.ok(l.lines.some((x) => x.level === 'warn' && x.msg.startsWith('sync.skipped') && /still running/.test(x.msg)));
  assert.equal(l.lines.filter((x) => x.msg === 'sync.cycle').length, 1);
});

test('the timer runs a cycle every sync period and not before', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  await l.tree.put('wiki/mine.html', Buffer.from('mine'), { ...NEW, device: 'tablet' });
  await l.time.advance(299_000);
  assert.equal(l.lines.some((x) => x.msg === 'sync.cycle'), false);
  await l.time.advance(1_000);
  await l.sync.settled();
  assert.equal(l.lines.filter((x) => x.msg === 'sync.cycle').length, 1);
  assert.ok(remoteFiles(h).includes('library/wiki/mine.html'));
  await l.time.advance(300_000);
  await l.sync.settled();
  assert.equal(l.lines.filter((x) => x.msg === 'sync.cycle').length, 2);
});

test('a clone with no origin has the sync off, says so once, and reports off', async (t) => {
  const { tempHoard } = await import('./hoard.ts');
  const h = tempHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  assert.equal(l.sync.status().state, 'off');
  assert.equal((await l.sync.runOnce()).state, 'off');
  assert.equal(l.lines.filter((x) => x.msg.startsWith('sync.off')).length, 1);
  assert.equal(l.time.pending(), 0, 'no timer is armed');
});

test('a sync period of 0 turns the sync off even with an origin', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, { syncSeconds: 0 });
  assert.equal(l.sync.status().state, 'off');
  assert.equal(git(h.remote, 'log', 'main', '--format=%s').trim(), 'seed');
});

test('the push runs after the tree is released, so clients read and write while it is on the wire', async (t) => {
  const h = syncHoard(t);
  const l = await openWithHistory(t, h, SYNC);
  const entered = path.join(h.root, 'push-entered');
  const release = path.join(h.root, 'push-release');
  const hook = path.join(h.remote, 'hooks', 'pre-receive');
  const slash = (p: string) => p.replace(/\\/g, '/');
  writeFileSync(hook, `#!/bin/sh\ntouch "${slash(entered)}"\nwhile [ ! -e "${slash(release)}" ]; do sleep 0.05; done\n`);
  chmodSync(hook, 0o755);
  await l.tree.put('wiki/mine.html', Buffer.from('mine'), { ...NEW, device: 'tablet' });

  const cycle = l.sync.runOnce();
  try {
    for (let i = 0; i < 400 && !existsSync(entered); i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.ok(existsSync(entered), 'the push reached the remote');
    const within = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('held while the push ran')), 3_000))]);
    assert.equal((await within(l.tree.read('wiki/mine.html'))).bytes.toString(), 'mine');
    await within(l.tree.put('wiki/during.html', Buffer.from('during'), { ...NEW, device: 'tablet' }));
  } finally {
    // Released whatever the outcome, or the held cycle would keep the test from ending.
    writeFileSync(release, '');
  }
  assert.equal((await cycle).state, 'ok');
  assert.ok(remoteFiles(h).includes('library/wiki/mine.html'));
});
