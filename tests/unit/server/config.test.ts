// Rule: the server starts only with a configuration that cannot expose or corrupt the
// library: a tailnet-style bind address (never a wildcard), a real git work tree, and a
// state folder outside it.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, parseConfig } from '../../../server/config.ts';
import { tempHoard } from './hoard.ts';

const refuses = (p: Promise<unknown>, pattern: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ConfigError && pattern.test(e.message));

test('flags, environment and defaults combine, with flags winning over the environment', async (t) => {
  const h = tempHoard(t);
  const env = { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state, NEO_SERVER_PORT: '9000', NEO_SERVER_HOST: '100.64.0.5' };
  assert.deepEqual(await parseConfig([], env), { repo: h.repo, library: 'library', host: '100.64.0.5', port: 9000, state: h.state, uv: 'uv' });
  const flags = await parseConfig(['--port', '9100', '--library', 'shelf/', '--host', '127.0.0.2', '--repo', h.repo, '--state', h.state], { NEO_SERVER_PORT: '1' });
  assert.deepEqual([flags.port, flags.library, flags.host], [9100, 'shelf', '127.0.0.2']);
  const defaults = await parseConfig([], { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state });
  assert.deepEqual([defaults.host, defaults.port, defaults.library], ['127.0.0.1', 8417, 'library']);
});

test('uv is a command name or path from --uv, then NEO_SERVER_UV, then plain uv', async (t) => {
  const h = tempHoard(t);
  const base = { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state };
  assert.equal((await parseConfig([], base)).uv, 'uv');
  assert.equal((await parseConfig([], { ...base, NEO_SERVER_UV: '/opt/uv/bin/uv' })).uv, '/opt/uv/bin/uv');
  assert.equal((await parseConfig(['--uv', 'uv-custom'], { ...base, NEO_SERVER_UV: '/opt/uv/bin/uv' })).uv, 'uv-custom');
});

test('a wildcard host is refused with a pointer to the tailnet address', async (t) => {
  const h = tempHoard(t);
  for (const host of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0', '0', '0.0', '']) {
    await refuses(parseConfig(['--host', host], { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state }), /tailnet/);
  }
});

test('a state folder inside the repo is refused, and so is a missing one', async (t) => {
  const h = tempHoard(t);
  await refuses(parseConfig([], { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: path.join(h.repo, 'library', 'state') }), /inside the repo/);
  await refuses(parseConfig([], { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.repo }), /inside the repo/);
  await refuses(parseConfig([], { NEO_SERVER_REPO: h.repo }), /state/i);
});

test('a missing repo, a folder that is not a git work tree, a bad port and a bad library name are refused', async (t) => {
  const h = tempHoard(t);
  const plain = path.join(h.root, 'plain');
  mkdirSync(plain);
  await refuses(parseConfig([], { NEO_SERVER_STATE: h.state }), /repo/i);
  await refuses(parseConfig([], { NEO_SERVER_REPO: path.join(h.root, 'absent'), NEO_SERVER_STATE: h.state }), /does not exist/);
  await refuses(parseConfig([], { NEO_SERVER_REPO: plain, NEO_SERVER_STATE: h.state }), /not a git work tree/);
  await refuses(parseConfig(['--port', '70000'], { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state }), /port/);
  await refuses(parseConfig(['--library', '../out'], { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state }), /library/);
  await refuses(parseConfig(['--nonsense'], { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state }), /nonsense/);
});

test('the state folder is compared with the top of the work tree, not with the --repo subfolder', async (t) => {
  const h = tempHoard(t);
  const sub = path.join(h.repo, 'sub');
  mkdirSync(sub);
  await refuses(parseConfig(['--repo', sub], { NEO_SERVER_STATE: path.join(h.repo, 'state') }), /inside the repo/);
  assert.equal((await parseConfig(['--repo', sub], { NEO_SERVER_STATE: h.state })).repo, sub);
});
