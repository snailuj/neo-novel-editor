// Rule: the hoard tools never write into the server's clone and never make a request wait on
// a tool: projects are read through lstat and an exact name, and a librarian job answers 202 at
// once and is polled; a host without uv loses only the librarian routes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test as plainTest, type TestContext } from 'node:test';
import { openHoardTools } from '../../../server/hoard.ts';
import { fakeUv } from './fake-uv.ts';
import { tempHoard } from './hoard.ts';
import { startServer, type Client, type Reply } from './support.ts';

// Every test has a deadline, so a request that waits on a tool fails the test instead of hanging the run.
const test = (name: string, fn: (t: TestContext) => Promise<void>) => plainTest(name, { timeout: 10_000 }, fn);

const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo }).toString();
const blob = (repo: string, text: string) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: repo, input: text }).toString().trim();

test('projects: only top-level regular .md files are listed, read byte-exact by exact name, and nothing is written', async (t) => {
  const h = tempHoard(t);
  const fake = fakeUv(t);
  const projects = path.join(h.repo, 'projects');
  mkdirSync(path.join(projects, 'sub.md'), { recursive: true }); // a folder named like a page
  mkdirSync(path.join(projects, 'sub'));
  const hub = 'Sample hub\r\nline two é\n';
  writeFileSync(path.join(projects, 'sample-hub.md'), hub);
  writeFileSync(path.join(projects, 'Other.md'), 'other');
  writeFileSync(path.join(projects, 'notes.txt'), 'not a page');
  writeFileSync(path.join(projects, 'sub', 'nested.md'), 'nested');
  let linked = true;
  try { symlinkSync(path.join(projects, 'Other.md'), path.join(projects, 'link.md')); } catch { linked = false; } // Windows may refuse
  const { client } = await startServer(t, h, { hoardTools: { uv: fake.uv } });
  const objects = git(h.repo, 'count-objects', '-v');
  const status = git(h.repo, 'status', '--porcelain');

  const list = await client.call('GET', '/v1/hoard/projects');
  assert.deepEqual([list.status, list.json], [200, { projects: [{ name: 'Other' }, { name: 'sample-hub' }] }]);
  assert.ok(linked || process.platform === 'win32', 'the symlink fixture was made');

  const got = await client.call('GET', '/v1/hoard/projects/sample-hub');
  assert.equal(got.status, 200);
  assert.deepEqual(got.body, Buffer.from(hub));
  assert.equal(got.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(got.headers.etag, `"${blob(h.repo, hub)}"`);

  const wrongCase = await client.call('GET', '/v1/hoard/projects/Sample-Hub');
  assert.deepEqual([wrongCase.status, wrongCase.json.code], [404, 'not_found']);
  for (const bad of ['..%2Fx', 'a%2Fb', 'a/b', '.hidden', '%2e%2e%2fx', 'a%5Cb', 'a%00b', '']) {
    const r = await client.call('GET', `/v1/hoard/projects/${bad}`);
    assert.deepEqual([bad, r.status, r.json.code], [bad, 400, 'bad_name']);
  }
  const put = await client.call('PUT', '/v1/hoard/projects/sample-hub', { body: 'x' });
  assert.deepEqual([put.status, put.json.code], [405, 'method_not_allowed']);
  assert.equal((await client.call('POST', '/v1/hoard/projects')).status, 405);

  assert.equal(git(h.repo, 'count-objects', '-v'), objects, 'the object store is untouched');
  assert.equal(git(h.repo, 'status', '--porcelain'), status);
});

test('a missing projects folder lists nothing and logs a warning', async (t) => {
  const h = tempHoard(t);
  const { client, lines } = await startServer(t, h, { hoardTools: { uv: fakeUv(t).uv } });
  const list = await client.call('GET', '/v1/hoard/projects');
  assert.deepEqual([list.status, list.json], [200, { projects: [] }]);
  assert.ok(lines.some((l) => l.level === 'warn' && l.msg === 'hoard.projects.missing'));
});

const post = (client: Client, tool: string) => client.call('POST', `/v1/hoard/librarian/${tool}`, { body: 'ignored' });
const job = (client: Client, id: string) => client.call('GET', `/v1/hoard/librarian/jobs/${id}`);

/** Polls the job until it leaves `running`, so a job that never finishes fails the test instead of hanging it. */
async function finished(client: Client, id: string): Promise<Reply> {
  for (let i = 0; i < 500; i++) {
    const r = await job(client, id);
    if (r.json.state !== 'running') return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return assert.fail(`job ${id} never finished`);
}

test('a librarian job answers 202 while the tool still runs, is polled to done, and ran with the redirected environment', async (t) => {
  const h = tempHoard(t);
  const fake = fakeUv(t);
  const { client, lines } = await startServer(t, h, { hoardTools: { uv: fake.uv } });
  fake.steer({ exit: 0 });
  fake.hold();

  const started = await post(client, 'lint');
  assert.equal(started.status, 202);
  assert.deepEqual([started.json.tool, started.json.state, typeof started.json.id, typeof started.json.startedAt], ['lint', 'running', 'string', 'string']);
  const during = await job(client, started.json.id);
  assert.deepEqual([during.status, during.json.state, during.json.exitCode, during.json.endedAt], [200, 'running', null, null]);

  fake.release();
  const done = (await finished(client, started.json.id)).json;
  assert.deepEqual([done.state, done.exitCode, done.signal, done.truncated, done.stderr], ['done', 0, null, false, 'fake stderr\n']);
  assert.equal(typeof done.ms, 'number');
  const seen = JSON.parse(done.stdout);
  assert.deepEqual(seen.argv, ['run', '--frozen', '--project', '_meta/infra/tools', 'python', '_meta/infra/tools/librarian/cli.py', 'lint']);
  assert.equal(seen.cwd, realpathSync(h.repo));
  assert.equal(seen.env.UV_PROJECT_ENVIRONMENT, path.join(h.state, 'hoard-venv'));
  assert.equal(seen.env.PYTHONDONTWRITEBYTECODE, '1');
  assert.ok(lines.some((l) => l.msg === 'hoard.job.start' && l.tool === 'lint'));
  assert.ok(lines.some((l) => l.msg === 'hoard.job.end' && l.exitCode === 0 && typeof l.ms === 'number'));
});

test('a non-zero exit is done, with that exit code', async (t) => {
  const fake = fakeUv(t);
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv } });
  fake.steer({ exit: 3 });
  const ended = (await finished(client, (await post(client, 'verify')).json.id)).json;
  assert.deepEqual([ended.state, ended.exitCode, ended.reason], ['done', 3, undefined]);
});

test('a second request for a running tool returns that job, and another tool gets its own', async (t) => {
  const fake = fakeUv(t);
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv } });
  fake.hold();
  const first = await post(client, 'lint');
  const again = await post(client, 'lint');
  const other = await post(client, 'quotes');
  assert.deepEqual([first.status, again.status, other.status], [202, 202, 202]);
  assert.equal((await job(client, first.json.id)).json.state, 'running', 'the first job was still running when repeated');
  assert.equal(again.json.id, first.json.id);
  assert.notEqual(other.json.id, first.json.id);
  assert.equal(other.json.tool, 'quotes');
  fake.release();
  await finished(client, first.json.id);
  await finished(client, other.json.id);
  assert.notEqual((await post(client, 'lint')).json.id, first.json.id, 'a finished tool starts a new job');
});

test('an unknown tool and an unknown job are 404, and a wrong method is 405', async (t) => {
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fakeUv(t).uv } });
  const tool = await post(client, 'rm');
  assert.deepEqual([tool.status, tool.json.code], [404, 'unknown_tool']);
  const gone = await job(client, 'no-such-job');
  assert.deepEqual([gone.status, gone.json.code], [404, 'not_found']);
  assert.equal((await client.call('GET', '/v1/hoard/librarian/lint')).status, 405);
  assert.equal((await client.call('POST', '/v1/hoard/librarian/jobs/x')).status, 405);
});

test('output over the limit is cut to its first bytes and flagged', async (t) => {
  const fake = fakeUv(t);
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, outputLimit: 100 } });
  fake.steer({ stdoutBytes: 5000 });
  const big = (await finished(client, (await post(client, 'lint')).json.id)).json;
  assert.deepEqual([big.truncated, big.stdout.length, big.stderr], [true, 100, 'fake stderr\n']);
  assert.ok(big.stdout.startsWith('{"argv":["run"'), 'the first bytes are the ones kept');
});

test('a job past its timeout is killed and failed with reason timeout', async (t) => {
  const fake = fakeUv(t);
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, timeoutMs: 300 } });
  fake.hold();
  const id = (await post(client, 'lint')).json.id;
  const ended = (await finished(client, id)).json;
  assert.deepEqual([ended.state, ended.reason], ['failed', 'timeout']);
  assert.equal(typeof ended.endedAt, 'string');
});

test('only the latest keepJobs finished jobs are remembered', async (t) => {
  const fake = fakeUv(t);
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, keepJobs: 1 } });
  const first = (await post(client, 'lint')).json.id;
  assert.equal((await finished(client, first)).json.state, 'done');
  const second = (await post(client, 'lint')).json.id;
  assert.equal((await finished(client, second)).json.state, 'done');
  assert.notEqual(first, second);
  assert.equal((await job(client, first)).status, 404);
  assert.equal((await job(client, second)).status, 200);
});

test('without uv only the librarian routes are 503; state, files and projects keep working', async (t) => {
  const h = tempHoard(t);
  mkdirSync(path.join(h.repo, 'projects'));
  writeFileSync(path.join(h.repo, 'projects', 'sample-hub.md'), 'hub');
  const { client, lines } = await startServer(t, h, { hoardTools: { uv: { command: path.join(h.root, 'definitely', 'not-uv') } } });
  assert.ok(lines.some((l) => l.msg === 'hoard.uv.probe' && l.available === false), 'the probe result was logged');

  const refused = await post(client, 'lint');
  assert.deepEqual([refused.status, refused.json.code], [503, 'tool_unavailable']);
  assert.match(refused.json.message, /uv was not found on the host/);

  assert.equal((await client.call('GET', '/v1/state')).status, 200);
  assert.equal((await client.put('a.html', 'x', { 'If-None-Match': '*' })).status, 200);
  assert.equal((await client.get('a.html')).body.toString(), 'x');
  assert.deepEqual((await client.call('GET', '/v1/hoard/projects')).json, { projects: [{ name: 'sample-hub' }] });
});

test('a request while uv is missing probes again, so installing uv needs no restart', async (t) => {
  const fake = fakeUv(t, { installed: false });
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv } });
  const down = await post(client, 'lint');
  assert.deepEqual([down.status, down.json.code], [503, 'tool_unavailable'], 'uv was still missing');
  fake.install();
  const up = await post(client, 'lint');
  assert.equal(up.status, 202);
  assert.equal((await finished(client, up.json.id)).json.state, 'done');
});

test('without configured tools the hoard routes are 503', async (t) => {
  const { client } = await startServer(t, tempHoard(t));
  const r = await client.call('GET', '/v1/hoard/projects');
  assert.deepEqual([r.status, r.json.code, r.json.message], [503, 'tool_unavailable', 'hoard tools are not configured']);
  assert.equal((await client.call('GET', '/v1/state')).status, 200);
});

test('close kills a running job and waits for it', async (t) => {
  const fake = fakeUv(t);
  const { client, tools } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv } });
  fake.hold();
  const id = (await post(client, 'lint')).json.id;
  assert.equal((await job(client, id)).json.state, 'running');
  await tools?.close();
  const after = (await job(client, id)).json;
  assert.deepEqual([after.state, after.exitCode], ['failed', null]);
});

test('a finished job is evicted by when it ended, not when it started', async (t) => {
  const fake = fakeUv(t);
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, keepJobs: 1 } });
  fake.hold();
  const lint = (await post(client, 'lint')).json.id;
  await fake.waitHeld(1);
  fake.unhold();
  const verify = (await post(client, 'verify')).json.id;
  assert.equal((await finished(client, verify)).json.state, 'done');
  assert.equal((await job(client, lint)).json.state, 'running', 'lint was still running when verify ended');
  fake.release();
  assert.equal((await finished(client, lint)).json.state, 'done', 'the job that ended last is kept');
  assert.equal((await job(client, lint)).status, 200);
  assert.equal((await job(client, verify)).status, 404, 'the job that ended first is the one forgotten');
});

test('a uv path under a regular file is unavailable, not a startup failure', async (t) => {
  const h = tempHoard(t);
  const file = path.join(h.root, 'plain-file');
  writeFileSync(file, 'x');
  // spawn throws ENOTDIR synchronously for this path instead of emitting an error event.
  const { client, lines } = await startServer(t, h, { hoardTools: { uv: { command: path.join(file, 'uv') } } });
  assert.ok(lines.some((l) => l.msg === 'hoard.uv.probe' && l.available === false && /could not be started/.test(String(l.reason))));
  const r = await post(client, 'lint');
  assert.deepEqual([r.status, r.json.code], [503, 'tool_unavailable']);
});

test('a run that cannot be spawned fails its job and does not block the tool', async (t) => {
  const h = tempHoard(t);
  const lines: string[] = [];
  // A NUL in the state path makes spawn throw ERR_INVALID_ARG_VALUE synchronously, after the probe passed.
  const tools = await openHoardTools({ repo: h.repo, state: path.join(h.root, 'bad\0state'), log: (_l, msg) => { lines.push(msg); }, uv: fakeUv(t).uv });
  t.after(() => tools.close());
  const body = async () => Buffer.alloc(0);
  const first = (await tools.handle('POST', '/librarian/lint', body)).json as { id: string; state: string };
  const failed = (await tools.handle('GET', `/librarian/jobs/${first.id}`, body)).json as { state: string; reason: string };
  assert.deepEqual([failed.state, /^spawn failed/.test(failed.reason)], ['failed', true]);
  const second = (await tools.handle('POST', '/librarian/lint', body)).json as { id: string };
  assert.notEqual(second.id, first.id, 'the failed job no longer blocks the tool');
});

test('a uv that never answers --version is unavailable after the probe timeout, at start and on a request', async (t) => {
  const fake = fakeUv(t);
  fake.steer({ hangVersion: true });
  const { client, lines } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, probeTimeoutMs: 300 } });
  assert.ok(lines.some((l) => l.msg === 'hoard.uv.probe' && /did not answer/.test(String(l.reason))), 'startup finished with the probe timed out');
  const r = await post(client, 'lint');
  assert.deepEqual([r.status, r.json.code], [503, 'tool_unavailable']);
  assert.match(r.json.message, /did not answer/);
});

test('a timeout gets past a tool that ignores SIGTERM', async (t) => {
  const fake = fakeUv(t);
  fake.steer({ ignoreTerm: true });
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, graceMs: 200, timeoutMs: 500 } });
  fake.hold();
  const id = (await post(client, 'lint')).json.id;
  await fake.waitHeld(1);
  const late = (await finished(client, id)).json;
  assert.deepEqual([late.state, late.reason], ['failed', 'timeout']);
});

test('close gets past a tool that ignores SIGTERM', async (t) => {
  const fake = fakeUv(t);
  fake.steer({ ignoreTerm: true });
  const { client, tools } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, graceMs: 200 } });
  fake.hold();
  const ids = [(await post(client, 'lint')).json.id, (await post(client, 'verify')).json.id];
  await fake.waitHeld(2);
  await tools?.close();
  for (const id of ids) assert.equal((await job(client, id)).json.state, 'failed');
});

test('a grandchild holding stdout does not keep a finished job running', async (t) => {
  const fake = fakeUv(t);
  fake.steer({ grandchildMs: 3000 });
  const { client } = await startServer(t, tempHoard(t), { hoardTools: { uv: fake.uv, graceMs: 200 } });
  const ended = (await finished(client, (await post(client, 'lint')).json.id)).json;
  assert.deepEqual([ended.state, ended.exitCode], ['done', 0]);
  assert.ok(ended.ms < 2000, `the job ended ${ended.ms} ms after it started, well before the grandchild exited`);
  assert.match(ended.stdout, /"argv"/, 'what was read before the grace ran out is kept');
});

test('a projects folder that is itself a link lists nothing, reads 404 and logs a warning', async (t) => {
  const h = tempHoard(t);
  const outside = path.join(h.root, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'sample-hub.md'), 'hub');
  try { symlinkSync(outside, path.join(h.repo, 'projects'), 'junction'); } catch { t.skip('this host refuses to make links'); return; }
  const { client, lines } = await startServer(t, h, { hoardTools: { uv: fakeUv(t).uv } });
  const list = await client.call('GET', '/v1/hoard/projects');
  assert.deepEqual([list.status, list.json], [200, { projects: [] }]);
  const got = await client.call('GET', '/v1/hoard/projects/sample-hub');
  assert.deepEqual([got.status, got.json.code], [404, 'not_found']);
  assert.ok(lines.some((l) => l.level === 'warn' && l.msg === 'hoard.projects.linked'));
});
