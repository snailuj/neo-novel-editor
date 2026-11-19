// Shares the clone with its remote on a timer: commit what is waiting, `pull --rebase`,
// `push`. The commit, pull and rescan run inside the tree's exclusive hold, so no client
// write or read meets a library that is half way through a pull. What the pull changed is
// re-hashed through the tree, which raises the seq, so clients see the remote's changes
// like any other. A rebase that conflicts is aborted before its markers can be read.
import type { Clock } from './history/checkpoints.ts';
import { systemClock } from './history/checkpoints.ts';
import { libraryNames, wholeSpec } from './history/pathspec.ts';
import { GitError } from './history/runner.ts';
import { rebaseInProgress as rebaseInProgressIn, type History } from './history.ts';
import type { Log } from './log.ts';
import type { Tree } from './tree.ts';

export type SyncState = 'ok' | 'conflict' | 'error' | 'rebase_in_progress' | 'off';
export interface SyncStatus { state: SyncState; at: string | null; message: string }

export interface SyncOptions {
  history: History;
  tree: Tree;
  /** Milliseconds between cycles; 0 turns the sync off. */
  intervalMs: number;
  log: Log;
  clock?: Clock;
  /** Each git call may take this long. Default 2 minutes: a push of a large library over a slow link. */
  gitTimeoutMs?: number;
}

export interface Sync {
  status(): SyncStatus;
  /** One cycle now. A cycle already running, or a rebase in progress, skips it. */
  runOnce(): Promise<SyncStatus>;
  /** Arms the timer. */
  start(): void;
  stop(): void;
  /** Resolves once a cycle the timer started has ended. */
  settled(): Promise<void>;
}

class Conflict extends Error {}

/** How many blocking files a sync error names; the rest are counted. */
const LISTED = 10;

export async function openSync(options: SyncOptions): Promise<Sync> {
  const { history, tree, log } = options;
  const clock = options.clock ?? systemClock;
  const { git, repo } = history;
  const timeoutMs = options.gitTimeoutMs ?? 120_000;
  const identityEnv: Record<string, string> = history.author
    ? { GIT_COMMITTER_NAME: history.author.name, GIT_COMMITTER_EMAIL: history.author.email }
    : {};
  const run = (args: string[]) => git.run(repo.top, args, { timeoutMs, env: identityEnv });

  let current: SyncStatus = { state: 'ok', at: null, message: 'no cycle has run yet' };
  let lastKey = '';
  const set = (state: SyncState, message: string): SyncStatus => {
    current = { state, at: new Date().toISOString(), message };
    return current;
  };
  /** The same outcome on every cycle would fill the log; it is logged when it changes. */
  const once = (key: string, write: () => void) => {
    if (key === lastKey) return;
    lastKey = key;
    write();
  };

  let origin = true;
  try {
    await git.run(repo.top, ['remote', 'get-url', 'origin']);
  } catch (err) {
    if (!(err instanceof GitError && err.kind === 'exit')) throw err;
    origin = false;
  }
  if (options.intervalMs === 0 || !origin) {
    const why = options.intervalMs === 0 ? 'the sync period is 0' : 'the clone has no origin';
    log('warn', `sync.off: ${why}, so nothing is pulled or pushed`);
    set('off', why);
    return { status: () => current, runOnce: async () => current, start() {}, stop() {}, settled: async () => {} };
  }

  const rebaseInProgress = () => rebaseInProgressIn(git, repo.top);

  /** Library paths between two commits, relative to the library; `before` null lists everything `after` holds. */
  async function changedPaths(before: string | null, after: string): Promise<string[]> {
    const spec = wholeSpec(repo);
    const { stdout } = before === null
      ? await run(['diff-tree', '--root', '-r', '--no-renames', '--no-commit-id', '--name-only', '-z', after, '--', spec])
      : await run(['diff', '--no-renames', '--name-only', '-z', before, after, '--', spec]);
    return libraryNames(repo, stdout.split('\0').filter(Boolean), (level, message, data) => log(level, message, data as Record<string, unknown>));
  }

  /**
   * Tracked files with changes the history does not commit (outside the library, or
   * matching IGNORED): `pull --rebase` refuses while any exist. They are the person's to
   * commit or revert, so they are named and never touched.
   */
  async function blockers(): Promise<string[]> {
    const { stdout } = await run(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames']);
    return stdout.split('\0').filter(Boolean).map((entry) => entry.slice(3)).sort();
  }

  async function cycle(): Promise<void> {
    const start = performance.now();
    const branch = (await run(['symbolic-ref', '--short', 'HEAD']).catch(() => ({ stdout: '' }))).stdout.trim();
    if (!branch) throw new Error('HEAD is not on a branch, so there is nothing to pull into or push from');
    // The pull and rescan hold the tree; the push only sends commits already made, so the
    // clients write and read while it is on the wire.
    const { committed, before, head, changed } = await tree.exclusive(async (held) => {
      const committed = await history.commit('sync');
      const before = history.lastCommit();
      // After the commit above, whatever is still changed is a file the server leaves alone.
      const stuck = await blockers();
      if (stuck.length) {
        const named = stuck.slice(0, LISTED).join(', ') + (stuck.length > LISTED ? ` and ${stuck.length - LISTED} more` : '');
        throw new Error(`files the server does not commit have uncommitted changes, so it cannot pull until they are committed or reverted by hand: ${named}`);
      }
      let pulled = true;
      try {
        await run(['pull', '--rebase', 'origin', branch]);
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        if (await rebaseInProgress()) {
          // Aborting puts the library back as it was before the pull, so no client reads conflict markers.
          const files = (await run(['diff', '--name-only', '--diff-filter=U']).catch(() => ({ stdout: '' }))).stdout.split('\n').filter(Boolean);
          await run(['rebase', '--abort']);
          throw new Conflict(`the remote and the server both changed ${files.length ? files.join(', ') : 'the same lines'}; the server's version stays until the remote's is merged by hand`);
        }
        // A remote with no such branch yet has nothing to pull; the push below creates it.
        if (!/couldn't find remote ref/i.test(err.stderr)) throw err;
        pulled = false;
      }
      const head = (await run(['rev-parse', '--verify', '-q', 'HEAD'])).stdout.trim();
      let changed = 0;
      if (pulled && head !== before) {
        changed = await held.rescan(await changedPaths(before, head));
        history.setLastCommit(head);
      }
      return { committed, before, head, changed };
    });
    await run(['push', 'origin', `HEAD:${branch}`]);
    log('info', 'sync.cycle', { branch, committed, before, head, pulledChanges: changed, ms: Math.round(performance.now() - start) });
  }

  let running = false;
  async function runOnce(): Promise<SyncStatus> {
    if (running) {
      log('warn', 'sync.skipped: the previous cycle is still running');
      return current;
    }
    running = true;
    try {
      if (await rebaseInProgress()) {
        once('rebase', () => log('warn', 'sync.skipped: a rebase is in progress in the clone, so no cycle runs until it is finished or aborted'));
        return set('rebase_in_progress', 'a rebase is in progress in the clone');
      }
      await cycle();
      if (lastKey !== '' && lastKey !== 'ok') log('info', 'sync.recovered: the cycle ran clean', { after: lastKey.split(':')[0] });
      lastKey = 'ok';
      return set('ok', 'in sync with the remote');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Conflict) {
        once(`conflict:${message}`, () => log('error', 'sync.conflict', { message }));
        return set('conflict', message);
      }
      once(`error:${message}`, () => log('error', 'sync.failed', { message }));
      return set('error', message);
    } finally {
      running = false;
    }
  }

  let timer: unknown = null;
  let inFlight: Promise<unknown> = Promise.resolve();
  const arm = () => {
    timer = clock.setTimeout(() => {
      timer = null;
      inFlight = runOnce().then(() => { if (stopped === false) arm(); });
    }, options.intervalMs);
  };
  let stopped = true;

  return {
    status: () => current,
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      arm();
    },
    stop() {
      stopped = true;
      clock.clearTimeout(timer);
      timer = null;
    },
    settled: async () => { await inFlight; },
  };
}
