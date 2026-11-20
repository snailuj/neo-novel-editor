// Server configuration from flags, then environment, then defaults. It refuses what would
// expose the library (a wildcard bind) or damage it (no git work tree, state inside it).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError } from './errors.ts';
import { isWorkTree, topLevel } from './git.ts';
import { checkPath } from './paths.ts';
import { assertOutsideRepo } from './state.ts';

export interface Config { repo: string; library: string; host: string; port: number; state: string; uv: string }

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const WILDCARD = /^\[?(::|::0|0(:0){7}|0(\.0){0,3})\]?$|^$/;

export async function parseConfig(argv: readonly string[], env: Record<string, string | undefined>): Promise<Config> {
  let flags;
  try {
    flags = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' }, library: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, state: { type: 'string' }, uv: { type: 'string' },
      },
      strict: true,
    }).values;
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const repoArg = flags.repo ?? env.NEO_SERVER_REPO;
  const stateArg = flags.state ?? env.NEO_SERVER_STATE;
  if (!repoArg) throw new ConfigError('give the hoard clone with --repo or NEO_SERVER_REPO');
  if (!stateArg) throw new ConfigError('give the state folder with --state or NEO_SERVER_STATE');

  const host = flags.host ?? env.NEO_SERVER_HOST ?? '127.0.0.1';
  if (WILDCARD.test(host.trim())) throw new ConfigError(`refusing to bind ${JSON.stringify(host)}, which listens on every interface; give the tailnet address instead`);

  const portText = flags.port ?? env.NEO_SERVER_PORT ?? '8417';
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port > 65535) throw new ConfigError(`port must be an integer from 0 to 65535, not ${JSON.stringify(portText)}`);

  let library: string;
  try {
    library = checkPath((flags.library ?? env.NEO_SERVER_LIBRARY ?? 'library').replace(/\/+$/, ''));
  } catch (e) {
    throw new ConfigError(`library name: ${e instanceof ApiError ? e.message : String(e)}`);
  }

  const repo = path.resolve(repoArg);
  const state = path.resolve(stateArg);
  if (!(await stat(repo).then((s) => s.isDirectory(), () => false))) throw new ConfigError(`repo ${repo} does not exist`);
  if (!(await isWorkTree(repo))) throw new ConfigError(`repo ${repo} is not a git work tree`);
  try {
    await assertOutsideRepo(state, await topLevel(repo));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  return { repo, library, host, port, state, uv: flags.uv ?? env.NEO_SERVER_UV ?? 'uv' };
}
