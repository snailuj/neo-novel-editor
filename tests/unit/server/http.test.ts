// Rule: the HTTP layer adds no behaviour of its own to the tree. It maps a request to
// one tree call, reports every refusal as `{ code, message }` with the tree's status, and
// logs each request once, whatever its outcome.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tempHoard } from './hoard.ts';
import { startServer } from './support.ts';

const blob = (repo: string, text: string) => execFileSync('git', ['hash-object', '--no-filters', '--stdin'], { cwd: repo, input: text }).toString().trim();
const NEW = { 'If-None-Match': '*' };

test('state, create, read with ETag, update, move and delete answer as the contract says', async (t) => {
  const h = tempHoard(t);
  const { client } = await startServer(t, h);
  const state = await client.call('GET', '/v1/state');
  assert.deepEqual([state.status, state.json.seq, state.json.head, state.json.library], [200, 0, null, 'library/']);

  const created = await client.put('wiki/place.html', '<p>x</p>', NEW);
  const v1 = blob(h.repo, '<p>x</p>');
  assert.deepEqual([created.status, created.json, created.headers.etag], [200, { version: v1, seq: 1 }, `"${v1}"`]);

  const got = await client.get('wiki/place.html');
  assert.deepEqual([got.status, got.body.toString(), got.headers.etag], [200, '<p>x</p>', `"${v1}"`]);

  const updated = await client.put('wiki/place.html', '<p>y</p>', { 'If-Match': `"${v1}"` });
  const v2 = blob(h.repo, '<p>y</p>');
  assert.deepEqual(updated.json, { version: v2, seq: 2 });
  // An If-Match without quotes is read the same way.
  const moved = await client.call('POST', '/v1/moves', { body: JSON.stringify({ from: 'wiki/place.html', to: 'wiki/spot.html', ifMatch: v2 }) });
  assert.deepEqual([moved.status, moved.json], [200, { version: v2, seq: 3 }]);
  const deleted = await client.call('DELETE', '/v1/files/wiki/spot.html', { headers: { 'If-Match': v2 } });
  assert.deepEqual([deleted.status, deleted.json], [200, { seq: 4 }]);
  assert.deepEqual((await client.changes(0)).json, { seq: 4, more: false, changes: [
    { path: 'wiki/place.html', version: null }, { path: 'wiki/spot.html', version: null },
  ] });
});

test('refusals carry the tree status and a { code, message } body, with the extra fields', async (t) => {
  const h = tempHoard(t);
  const { client } = await startServer(t, h);
  const v1 = (await client.put('a.html', 'one', NEW)).json.version;
  const stale = await client.put('a.html', 'two', { 'If-Match': '"0000"' });
  assert.deepEqual([stale.status, stale.json.code, stale.json.version, typeof stale.json.message], [412, 'stale', v1, 'string']);
  assert.equal((await client.put('a.html', 'two')).status, 428);
  assert.equal((await client.put('A.html', 'two', NEW)).json.code, 'case_clash');
  const missing = await client.get('nothing.html');
  assert.deepEqual([missing.status, missing.json.code], [404, 'not_found']);
  assert.equal((await client.call('PUT', '/v1/files/a.html', { body: 'x', headers: { 'If-None-Match': '"abc"' } })).json.code, 'bad_header');
});

test('a bad path is 400 bad_path and nothing is written', async (t) => {
  const h = tempHoard(t);
  const { client } = await startServer(t, h);
  const raw = ['/v1/files/', '/v1/files/%2Fwiki/a.html', '/v1/files/wiki%5Ca.html', '/v1/files/wiki/../a.html', '/v1/files/wiki/%2e%2e/a.html',
    '/v1/files/.git/config', '/v1/files/wiki//a.html', '/v1/files/wiki/a%00.html', '/v1/files/wiki/CON.html', '/v1/files/wiki/a%3Fb.html',
    '/v1/files/wiki/cafe%CC%81.html', '/v1/files/wiki/a.html%20', '/v1/files/wiki/%E0%A4%A.html'];
  for (const p of raw) {
    const r = await client.call('PUT', p, { body: 'x', headers: NEW });
    assert.deepEqual([p, r.status, r.json.code], [p, 400, 'bad_path']);
  }
  const moved = await client.move('a.html', '../b.html', 'abc');
  assert.deepEqual([moved.status, moved.json.code], [400, 'bad_path']);
  assert.deepEqual(readdirSync(path.join(h.repo, 'library')), []);
  assert.equal(existsSync(path.join(h.repo, 'a.html')), false);
});

test('percent-encoded names are decoded once', async (t) => {
  const h = tempHoard(t);
  const { client } = await startServer(t, h);
  assert.equal((await client.put('wiki/Café au lait.html', 'x', NEW)).status, 200);
  assert.deepEqual((await client.changes(0)).json.changes.map((c: { path: string }) => c.path), ['wiki/Café au lait.html']);
  assert.equal((await client.call('PUT', '/v1/files/a%2520b.html', { body: 'x', headers: NEW })).status, 200);
  assert.ok((await client.changes(0)).json.changes.some((c: { path: string }) => c.path === 'a%20b.html'));
});

test('a body over the limit is 413 and is not stored', async (t) => {
  const h = tempHoard(t);
  const { client } = await startServer(t, h, { bodyLimit: 64 });
  assert.equal((await client.put('small.html', 'x'.repeat(64), NEW)).status, 200);
  const big = await client.put('big.html', 'x'.repeat(5000), NEW);
  assert.deepEqual([big.status, big.json.code], [413, 'too_large']);
  const move = await client.call('POST', '/v1/moves', { body: JSON.stringify({ from: 'a', to: 'b', ifMatch: 'x'.repeat(100) }) });
  assert.equal(move.status, 413);
  assert.deepEqual((await client.changes(0)).json.changes.map((c: { path: string }) => c.path), ['small.html']);
});

test('bad JSON, unknown routes, wrong methods and bad query values are told apart', async (t) => {
  const h = tempHoard(t);
  const { client } = await startServer(t, h);
  const json = (body: string) => client.call('POST', '/v1/moves', { body });
  assert.deepEqual([(await json('{nope')).status, (await json('{nope')).json.code], [400, 'bad_json']);
  assert.equal((await json('{"from":"a"}')).json.code, 'bad_json');
  assert.equal((await client.call('GET', '/v1/nowhere')).json.code, 'not_found');
  assert.equal((await client.call('GET', '/elsewhere')).status, 404);
  for (const [method, p] of [['POST', '/v1/state'], ['PUT', '/v1/changes'], ['GET', '/v1/moves'], ['PATCH', '/v1/files/a.html']]) {
    const r = await client.call(method, p);
    assert.deepEqual([p, r.status, r.json.code], [p, 405, 'method_not_allowed']);
  }
  for (const q of ['since=-1', 'since=x', 'since=1.5', 'limit=0', 'limit=5001', 'limit=x']) {
    const r = await client.call('GET', `/v1/changes?${q}`);
    assert.deepEqual([q, r.status, r.json.code], [q, 400, 'bad_query']);
  }
  assert.equal((await client.call('GET', '/v1/changes?limit=5000')).status, 200);
});

test('every request writes one log line with method, path, device, seq before and after, status and duration', async (t) => {
  const h = tempHoard(t);
  const { client, lines } = await startServer(t, h);
  await client.put('a.html', 'one', NEW);
  await client.get('a.html');
  await client.get('missing.html');
  const requests = lines.filter((l) => l.msg === 'request');
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((l) => [l.method, l.path, l.device, l.seqBefore, l.seqAfter, l.status]), [
    ['PUT', '/v1/files/a.html', 'test-device', 0, 1, 200],
    ['GET', '/v1/files/a.html', 'test-device', 1, 1, 200],
    ['GET', '/v1/files/missing.html', 'test-device', 1, 1, 404],
  ]);
  assert.ok(requests.every((l) => typeof l.ms === 'number' && l.ms >= 0));
  await client.call('GET', '/v1/state', { headers: { 'X-Neo-Device': '' } });
  assert.equal(lines.filter((l) => l.msg === 'request').at(-1)?.device, null);
});
