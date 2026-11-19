// Server configuration from flags, then environment, then defaults. It refuses what would
// expose the library (a wildcard bind) or damage it (no git work tree, state inside it).
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ApiError } from './errors.ts';
import type { Identity } from './history/commit.ts';
import { isWorkTree, topLevel } from './git.ts';
import { checkPath } from './paths.ts';
import { assertOutsideRepo } from './state.ts';

export interface Config {
  repo: string; library: string; host: string; port: number; state: string;
  /** The commit author; null takes the clone's git config. */
  author: Identity | null;
  /** Seconds without a write before the library is committed. */
  idleSeconds: number;
  /** Seconds between pulls and pushes; 0 turns the sync off. */
  syncSeconds: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const AUTHOR = /^(.*\S)\s*<([^<>\s]+@[^<>\s]+)>$/;

function wholeSeconds(name: string, text: string, min: number): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < min || !Number.isSafeInteger(n)) throw new ConfigError(`${name} must be a whole number of seconds, ${min} or more, not ${JSON.stringify(text)}`);
  return n;
}

const WILDCARD = /^\[?(::|::0|0(:0){7}|0(\.0){0,3})\]?$|^$/;

export async function parseConfig(argv: readonly string[], env: Record<string, string | undefined>): Promise<Config> {
  let flags;
  try {
    flags = parseArgs({
      args: [...argv],
      options: {
        repo: { type: 'string' }, library: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, state: { type: 'string' },
        author: { type: 'string' }, 'idle-seconds': { type: 'string' }, 'sync-seconds': { type: 'string' },
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

  const authorText = flags.author ?? env.NEO_SERVER_AUTHOR;
  const match = authorText === undefined ? null : AUTHOR.exec(authorText.trim());
  if (authorText !== undefined && !match) throw new ConfigError(`author must read "Name <email>", not ${JSON.stringify(authorText)}`);
  const author = match ? { name: match[1].trim(), email: match[2] } : null;
  const idleSeconds = wholeSeconds('idle seconds (--idle-seconds)', flags['idle-seconds'] ?? env.NEO_SERVER_IDLE_SECONDS ?? '60', 1);
  const syncSeconds = wholeSeconds('sync seconds (--sync-seconds)', flags['sync-seconds'] ?? env.NEO_SERVER_SYNC_SECONDS ?? '300', 0);

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
  return { repo, library, host, port, state, author, idleSeconds, syncSeconds };
}
