// The server's history: every accepted change reaches a commit once the library has been
// quiet for the idle period. The tree reports each write with its device; this module
// restarts the idle timer, and the commit that follows names every device whose writes it
// holds in a `Neo-Device` trailer. Commits run inside the tree's exclusive hold, so no
// write lands between staging and committing and the trailers are exact.
import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { Checkpoints, type Clock } from './history/checkpoints.ts';
import { commitAll, type Identity, type Reason } from './history/commit.ts';
import { Gate } from './history/gate.ts';
import { DEFAULT_LIBRARIAN } from './history/layer.ts';
import type { LibraryRepo } from './history/pathspec.ts';
import { createGit, GitError, type Git } from './history/runner.ts';
import { createRepoGit, topLevel } from './git.ts';
import type { Log } from './log.ts';
import { checkPath, TEMP_PREFIX } from './paths.ts';

export interface HistoryOptions {
  /** The hoard clone, as the tree was given it. */
  repo: string;
  /** The library's folder name in the clone. */
  library: string;
  /** The state folder; an empty hooks folder is made inside it. */
  state: string;
  /** The commit author; null takes the clone's git config, and a missing identity fails the start. */
  author: Identity | null;
  idleMs: number;
  log: Log;
  /** The tree's exclusive: runs a job with every write and read held. */
  exclusive<T>(job: () => Promise<T>): Promise<T>;
  clock?: Clock;
  /** How long close waits for its last commit. Default 30 s. */
  closeTimeoutMs?: number;
}

export interface History {
  readonly repo: LibraryRepo;
  readonly git: Git;
  readonly author: Identity | null;
  /** The tree accepted a change from `device`: restarts the idle timer. */
  wrote(device: string | undefined): void;
  /** One commit of the library now, or null when nothing changed. Call it only inside `exclusive`. */
  commit(reason: Reason): Promise<string | null>;
  /** Commits whatever the library holds uncommitted, as `recovered`. Call once the tree is open. */
  start(): Promise<void>;
  /** The newest commit the server knows of: its own, or HEAD after a pull. */
  lastCommit(): string | null;
  setLastCommit(sha: string | null): void;
  /** Resolves once no commit is running or queued. */
  drained(): Promise<void>;
  /** Stops the timer and makes one last commit, waiting at most closeTimeoutMs. */
  close(): Promise<void>;
}

/** A device name as a trailer value: letters, digits, dot, dash and underscore, 64 at most; else `unknown`. */
export function deviceName(raw: unknown): string {
  const cleaned = typeof raw === 'string' ? raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) : '';
  return cleaned === '' ? 'unknown' : cleaned;
}

/** The library as a folder of the clone, with the tree's temp files kept out of every commit. */
async function locate(repo: string, library: string): Promise<LibraryRepo> {
  const top = path.resolve(await topLevel(repo));
  const libraryDir = path.join(await realpath(repo), ...checkPath(library.replace(/\/+$/, '')).split('/'));
  const rel = path.relative(top, libraryDir).split(path.sep).join('/');
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) throw new Error(`the library ${libraryDir} is not inside the work tree ${top}`);
  return { top, prefix: rel === '' ? '' : `${rel}/`, library: libraryDir, ignore: [`${TEMP_PREFIX}*`] };
}

/** The author git would commit as, or an error that names the way to give one. */
async function configuredAuthor(git: Git, cwd: string): Promise<Identity> {
  const read = async (key: string) => {
    try {
      return (await git.run(cwd, ['config', '--get', key])).stdout.trim();
    } catch (err) {
      if (err instanceof GitError && err.kind === 'exit') return '';
      throw err;
    }
  };
  const [name, email] = [await read('user.name'), await read('user.email')];
  if (!name || !email) throw new Error('no commit author: set user.name and user.email in the hoard clone\'s git config, or give --author "Name <email>" (NEO_SERVER_AUTHOR)');
  return { name, email };
}

export async function openHistory(options: HistoryOptions): Promise<History> {
  const { log } = options;
  const hooks = path.join(options.state, 'no-hooks');
  await mkdir(hooks, { recursive: true });
  const asData = (data: unknown): Record<string, unknown> | undefined => (data !== null && typeof data === 'object' ? data as Record<string, unknown> : data === undefined ? undefined : { data });
  const gitLog = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => log(level, message, asData(data));
  const git = createGit({ hooksPath: hooks, log: gitLog });
  const repo = await locate(options.repo, options.library);
  // A missing identity must stop the server here, not at the first commit an hour later.
  const identity = options.author ?? await configuredAuthor(git, repo.top);
  const gate = new Gate({ library: () => repo.library, log: gitLog });
  const heads = createRepoGit(repo.top);
  let last = await heads.head();
  /** Devices whose writes are not yet in a commit. */
  let pending = new Set<string>();
  let lastFailure = '';

  async function commit(reason: Reason): Promise<string | null> {
    const start = performance.now();
    const devices = pending;
    pending = new Set();
    try {
      const names = devices.size ? [...devices].sort() : ['server'];
      const made = await commitAll(git, repo, {
        who: 'author', reason, librarian: DEFAULT_LIBRARIAN, author: options.author, gate, log: gitLog,
        trailers: names.map((d) => `Neo-Device: ${d}`),
      });
      lastFailure = '';
      if (!made) {
        log('debug', 'history.commit', { reason, commit: null });
        return null;
      }
      last = made.commit;
      if (made.leftOut.length) log('warn', 'history.left_out: books with a repository of their own are kept out of the history', { books: made.leftOut });
      log('info', 'history.commit', { reason, commit: made.commit, files: made.files, devices: names, ms: Math.round(performance.now() - start) });
      return made.commit;
    } catch (err) {
      // The writes are still uncommitted: the next commit must name their devices.
      for (const d of devices) pending.add(d);
      throw err;
    }
  }

  const checkpoints = new Checkpoints({
    idleMs: options.idleMs,
    clock: options.clock,
    commit: (reason) => options.exclusive(() => commit(reason)),
    // The same failure on every pause would fill the log; it is logged when it changes.
    onError: (err, reason) => {
      const key = err instanceof GitError ? `${err.kind}:${err.stderr.trim()}` : String(err);
      if (key === lastFailure) return;
      lastFailure = key;
      log('error', 'history.commit.failed', { reason, message: err instanceof Error ? err.message : String(err) });
    },
  });
  log('info', 'history.open', { top: repo.top, prefix: repo.prefix, author: identity.email, idleMs: options.idleMs, head: last });

  return {
    repo, git, author: options.author,
    wrote(device) {
      pending.add(deviceName(device));
      checkpoints.wrote();
    },
    commit,
    async start() {
      // Unrecoverable here: a library that cannot be committed at start would silently stay so.
      await options.exclusive(() => commit('recovered'));
    },
    lastCommit: () => last,
    setLastCommit(sha) { last = sha; },
    drained: () => checkpoints.drained(),
    async close() {
      checkpoints.stop();
      checkpoints.now('close');
      const timeoutMs = options.closeTimeoutMs ?? 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), timeoutMs); });
      const done = await Promise.race([checkpoints.drained().then(() => 'done' as const), late]);
      clearTimeout(timer);
      if (done === 'late') log('warn', 'history.close: the last commit was still running; it is made at the next start', { timeoutMs });
    },
  };
}
