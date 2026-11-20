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
  assert.deepEqual(await parseConfig([], env), { repo: h.repo, library: 'library', host: '100.64.0.5', port: 9000, state: h.state, uv: 'uv', author: null, idleSeconds: 60, syncSeconds: 300 });
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

test('the author, the idle period and the sync period come from flags or the environment, with flags winning', async (t) => {
  const h = tempHoard(t);
  const base = { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state };
  const fromEnv = await parseConfig([], { ...base, NEO_SERVER_AUTHOR: 'Server Pen <pen@example.invalid>', NEO_SERVER_IDLE_SECONDS: '90', NEO_SERVER_SYNC_SECONDS: '0' });
  assert.deepEqual([fromEnv.author, fromEnv.idleSeconds, fromEnv.syncSeconds], [{ name: 'Server Pen', email: 'pen@example.invalid' }, 90, 0]);
  const fromFlags = await parseConfig(['--author', 'Other <o@example.invalid>', '--idle-seconds', '5', '--sync-seconds', '60'], { ...base, NEO_SERVER_AUTHOR: 'Server Pen <pen@example.invalid>', NEO_SERVER_IDLE_SECONDS: '90' });
  assert.deepEqual([fromFlags.author, fromFlags.idleSeconds, fromFlags.syncSeconds], [{ name: 'Other', email: 'o@example.invalid' }, 5, 60]);
});

test('an author that is not "Name <email>", an idle period under a second and a sync period that is not a whole number are refused', async (t) => {
  const h = tempHoard(t);
  const env = { NEO_SERVER_REPO: h.repo, NEO_SERVER_STATE: h.state };
  for (const bad of ['Just A Name', '<only@example.invalid>', 'Name <>', 'Name <a b@c>']) await refuses(parseConfig(['--author', bad], env), /author/);
  for (const bad of ['0', '-1', '1.5', 'soon']) await refuses(parseConfig(['--idle-seconds', bad], env), /idle/);
  for (const bad of ['-1', '2.5', 'often']) await refuses(parseConfig(['--sync-seconds', bad], env), /sync/);
});
