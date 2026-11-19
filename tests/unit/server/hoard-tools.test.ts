// Rule: the hoard tools never write into the server's clone and never make a request wait on
// a tool: projects are read through lstat and an exact name, and a librarian job answers 202 at
// once and is polled; a host without uv loses only the librarian routes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeUv } from './fake-uv.ts';
import { tempHoard } from './hoard.ts';
import { startServer } from './support.ts';

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
