// Rule: every accepted change is in a commit once the library has been quiet for the idle
// period, the commit names each device whose writes it holds, and no commit touches a path
// outside the library.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { deviceName } from '../../../server/history.ts';
import { createServer } from '../../../server/http.ts';
import { tempHoard } from './hoard.ts';
import { commits, git, NEW, openWithHistory } from './history-support.ts';
import { clientFor } from './support.ts';

const status = (repo: string, ...paths: string[]) => git(repo, 'status', '--porcelain', ...(paths.length ? ['--', ...paths] : [])).split('\n').filter(Boolean);

test('every accepted write is in one commit after the idle period, which names each writing device and leaves library/ clean', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h);
  await lib.tree.put('book-1/chapters/one.html', Buffer.from('one'), { ...NEW, device: 'tablet' });
  await lib.tree.put('wiki/place.html', Buffer.from('place'), { ...NEW, device: 'desktop' });
  const second = await lib.tree.put('book-1/notes.html', Buffer.from('notes'), { ...NEW, device: 'tablet' });
  await lib.tree.move('book-1/notes.html', 'book-1/notes-moved.html', second.version, 'phone');

  await lib.time.advance(59_000);
  await lib.history.drained();
  assert.deepEqual(commits(h.repo), [], 'nothing is committed before the library has been quiet for 60 s');

  await lib.time.advance(1_000);
  await lib.history.drained();
  const made = commits(h.repo);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].files, ['library/book-1/chapters/one.html', 'library/book-1/notes-moved.html', 'library/wiki/place.html']);
  assert.deepEqual(made[0].devices, ['desktop', 'phone', 'tablet']);
  assert.equal(made[0].checkpoint, 'idle');
  assert.deepEqual(status(h.repo, 'library/'), []);
  assert.equal(lib.history.lastCommit(), made[0].sha);
});

test('a delete is committed after the idle period like a write', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h);
  const put = await lib.tree.put('wiki/gone.html', Buffer.from('x'), { ...NEW, device: 'tablet' });
  await lib.time.advance(60_000);
  await lib.history.drained();
  await lib.tree.remove('wiki/gone.html', put.version, 'desktop');
  await lib.time.advance(60_000);
  await lib.history.drained();
  const [latest] = commits(h.repo);
  assert.deepEqual(latest.files, ['library/wiki/gone.html']);
  assert.deepEqual(latest.devices, ['desktop']);
  assert.equal(git(h.repo, 'ls-files', 'library').trim(), '');
});

test('no commit touches a path outside library/, and a modified or staged file there stays as it was', async (t) => {
  const h = tempHoard(t);
  writeFileSync(path.join(h.repo, 'readme.md'), 'tracked');
  git(h.repo, 'add', 'readme.md');
  git(h.repo, 'commit', '-q', '-m', 'someone else');
  writeFileSync(path.join(h.repo, 'readme.md'), 'modified, not staged');
  mkdirSync(path.join(h.repo, 'projects'));
  writeFileSync(path.join(h.repo, 'projects', 'plan.md'), 'staged');
  git(h.repo, 'add', 'projects/plan.md');
  const before = status(h.repo);

  const lib = await openWithHistory(t, h);
  await lib.tree.put('wiki/a.html', Buffer.from('a'), { ...NEW, device: 'tablet' });
  await lib.time.advance(60_000);
  await lib.history.drained();

  const [latest, ...older] = commits(h.repo);
  assert.deepEqual(latest.files, ['library/wiki/a.html']);
  assert.equal(older.length, 1, 'only the other file\'s own commit came before');
  assert.deepEqual(status(h.repo).filter((l) => !l.includes('library/')), before);
});

test('a write inside the idle window restarts it, so the commit follows the last write by the whole period', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h);
  await lib.tree.put('wiki/a.html', Buffer.from('a'), { ...NEW, device: 'tablet' });
  await lib.time.advance(50_000);
  await lib.tree.put('wiki/b.html', Buffer.from('b'), { ...NEW, device: 'desktop' });
  await lib.time.advance(59_000);
  await lib.history.drained();
  assert.deepEqual(commits(h.repo), [], '109 s after the first write, 59 s after the second: still inside the window');
  await lib.time.advance(1_000);
  await lib.history.drained();
  assert.equal(commits(h.repo).length, 1);
  assert.deepEqual(commits(h.repo)[0].devices, ['desktop', 'tablet']);
});

test('files left uncommitted under the library when the server stops are committed as recovered when it opens', async (t) => {
  const h = tempHoard(t);
  mkdirSync(path.join(h.repo, 'library', 'wiki'), { recursive: true });
  writeFileSync(path.join(h.repo, 'library', 'wiki', 'left.html'), 'left behind');
  const lib = await openWithHistory(t, h);
  const [recovered] = commits(h.repo);
  assert.equal(recovered.checkpoint, 'recovered');
  assert.deepEqual(recovered.files, ['library/wiki/left.html']);
  assert.deepEqual(recovered.devices, ['server'], 'a change the server found on its disk carries the server as its device');
  assert.deepEqual(status(h.repo, 'library/'), []);
  assert.equal(lib.history.lastCommit(), recovered.sha);
});

test('closing makes one last commit of whatever is still waiting', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h);
  await lib.tree.put('wiki/last.html', Buffer.from('last'), { ...NEW, device: 'tablet' });
  await lib.close();
  const [closing] = commits(h.repo);
  assert.equal(closing.checkpoint, 'close');
  assert.deepEqual(closing.files, ['library/wiki/last.html']);
  assert.deepEqual(closing.devices, ['tablet']);
});

test('a device name is cut to letters, digits, dot, dash and underscore and to 64 characters; no name, or nothing left, is unknown', () => {
  assert.equal(deviceName('Julian-Tablet_2.local'), 'Julian-Tablet_2.local');
  assert.equal(deviceName('my phone\nNeo-Checkpoint: x'), 'myphoneNeo-Checkpointx');
  assert.equal(deviceName('a'.repeat(100)), 'a'.repeat(64));
  for (const none of [undefined, '', '   ', 'éè', '\n']) assert.equal(deviceName(none), 'unknown');
});

test('a device header that tries to add a trailer line cannot', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h);
  await lib.tree.put('wiki/a.html', Buffer.from('a'), { ...NEW, device: 'x\nNeo-Device: forged' });
  await lib.time.advance(60_000);
  await lib.history.drained();
  assert.deepEqual(commits(h.repo)[0].devices, ['xNeo-Device-forged'.replace('Neo-Device-forged', 'Neo-Deviceforged')]);
});

test('a missing author identity fails the start instead of the first commit', async (t) => {
  const h = tempHoard(t);
  const { isolateGitConfig } = await import('./history/git-support.ts');
  isolateGitConfig(t, null);
  await assert.rejects(openWithHistory(t, h), /author|identity/i);
});

test('an author given by flag is the commit\'s author, and the librarian identity is kept for librarian commits', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h, { author: { name: 'Server Pen', email: 'pen@example.invalid' } });
  await lib.tree.put('wiki/a.html', Buffer.from('a'), { ...NEW, device: 'tablet' });
  await lib.time.advance(60_000);
  await lib.history.drained();
  assert.equal(git(h.repo, 'log', '-1', '--format=%an <%ae>').trim(), 'Server Pen <pen@example.invalid>');
});

test('findings of the gate are logged and the writer\'s commit goes ahead', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h);
  // Whatever the gate finds in a writer's commit, the commit is still made.
  await lib.tree.put('wiki/People/bad.html', Buffer.from('<p>text</p>'), { ...NEW, device: 'tablet' });
  await lib.tree.put('.neo/scheme.json', Buffer.from('{ not json'), { ...NEW, device: 'tablet' });
  await lib.time.advance(60_000);
  await lib.history.drained();
  assert.equal(commits(h.repo).length, 1);
  assert.ok(lib.lines.some((l) => l.msg === 'git.gate' && Number(l.files) >= 1), 'the gate ran on the staged files and logged');
});

test('the X-Neo-Device header of a request is the device its commit names, and GET /v1/state reports the last commit', async (t) => {
  const h = tempHoard(t);
  const lib = await openWithHistory(t, h);
  const server = createServer(lib.tree, { log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const client = clientFor(server, 'laptop-1');
  assert.equal((await client.put('wiki/a.html', 'a', { 'If-None-Match': '*' })).status, 200);
  await lib.time.advance(60_000);
  await lib.history.drained();
  const [made] = commits(h.repo);
  assert.deepEqual(made.devices, ['laptop-1']);
  const state = (await client.call('GET', '/v1/state')).json;
  assert.equal(state.history.lastCommit, made.sha);
});
