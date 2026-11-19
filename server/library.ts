// Opens the library the way the server runs it: the tree, the history that commits it, and
// the sync that shares it. The three need each other (the tree reports writes to the
// history, the history commits inside the tree's exclusive hold), so they are tied here.
import type { Identity } from './history/commit.ts';
import type { Clock } from './history/checkpoints.ts';
import { openHistory, type History } from './history.ts';
import type { Log } from './log.ts';
import { openTree, type Tree } from './tree.ts';

export interface LibraryOptions {
  repo: string; library: string; state: string; log: Log;
  author: Identity | null;
  idleSeconds: number;
  syncSeconds: number;
  /** Timers for the idle commit and the sync; a test passes a fake. */
  clock?: Clock;
}

export interface OpenLibrary {
  tree: Tree;
  history: History;
  /** Stops the timers, waits for the tree, then makes the history's last commit. */
  close(): Promise<void>;
}

export async function openLibrary(options: LibraryOptions): Promise<OpenLibrary> {
  const { log } = options;
  // The history needs the tree's exclusive and the tree needs the history's wrote; each reaches the other late.
  const late: { tree?: Tree } = {};
  const history = await openHistory({
    repo: options.repo, library: options.library, state: options.state, author: options.author,
    idleMs: options.idleSeconds * 1000, log, clock: options.clock,
    exclusive: (job) => late.tree!.exclusive(() => job()),
  });
  const tree = await openTree({
    repo: options.repo, library: options.library, state: options.state, log,
    onChange: (device) => history.wrote(device),
    stateExtra: () => ({ history: { lastCommit: history.lastCommit() } }),
  });
  late.tree = tree;
  await history.start();
  return {
    tree, history,
    async close() {
      await tree.close();
      await history.close();
    },
  };
}
