// The library's history, as the hoard plugin's main half runs it: the repository's
// state, the checkpoints that commit it, Keep Library History, and blame. Opening never
// walks the log, so it costs the same however long the history grows; work left
// uncommitted when NEO last stopped (a quit, a crash) is committed on opening. A
// librarian edit runs between two commits of its own (around).
import { validateHoardSettingsV1 } from '../../generated/validators.cjs';
import { blameChapter, type BlameLine } from './blame.ts';
import { Checkpoints, type Clock } from './checkpoints.ts';
import type { Gate } from './gate.ts';
import { commitAll, whoFor, type Identity, type Reason, type Who } from './commit.ts';
import { repoState, syncedFolder, type RepoState } from './repo.ts';
import { GitError, type Git, type GitLog } from './runner.ts';
import { keepHistory, type Started } from './start.ts';

export const DEFAULT_LIBRARIAN: Identity = { name: 'Librarian', email: 'librarian@neo-hoard.invalid' };

export interface GitSettings {
  gitPath: string | null;
  author: Identity | null;
  librarian: Identity;
  idleMs: number;
}

/** The plugin's settings object, checked against its schema; defaults where it fails. */
export function resolveSettings(raw: unknown, warn: (message: string) => void): GitSettings {
  let git: { path?: string; author?: Identity; librarian?: Identity; idleSeconds?: number } = {};
  if (validateHoardSettingsV1(raw)) {
    git = raw.git ?? {};
  } else {
    const why = (validateHoardSettingsV1.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    warn(`hoard settings do not fit their schema, so the git defaults apply: ${why}`);
  }
  return {
    gitPath: git.path ?? null,
    author: git.author ?? null,
    librarian: git.librarian ?? DEFAULT_LIBRARIAN,
    idleMs: (git.idleSeconds ?? 60) * 1000,
  };
}

export interface GitLayerOptions {
  git: Git;
  library: string;
  settings: GitSettings;
  /** Holds the chapter attributes line; blame names it as git's attributes file. */
  attributesFile: string;
  textconv: { command: string; env?: Record<string, string> };
  log: GitLog;
  clock?: Clock;
}

/** What around's edit returned, and the commits either side of it (null: none made). */
export interface Paired<T> {
  result: T;
  before: string | null;
  after: string | null;
}

export class GitLayer {
  readonly #o: GitLayerOptions;
  readonly #checkpoints: Checkpoints;
  #state: RepoState = { state: 'untracked' };
  #lastFailure = '';
  #leftOut = '';
  #pairs: Promise<unknown> = Promise.resolve();
  #gate: Gate | undefined;

  constructor(options: GitLayerOptions) {
    this.#o = options;
    this.#checkpoints = new Checkpoints({
      idleMs: options.settings.idleMs,
      clock: options.clock,
      commit: (reason) => this.#commit(reason),
      onError: (err, reason) => this.#failed(err, reason),
    });
  }

  /** The pre-commit gate every commit from here on runs (gate.ts). */
  useGate(gate: Gate): void {
    this.#gate = gate;
  }

  status(): RepoState {
    return this.#state;
  }

  async open(): Promise<RepoState> {
    const { git, library, log } = this.#o;
    this.#state = await repoState(git, library);
    log('info', 'git.open', { state: this.#state.state, library });
    if (this.#state.state === 'inside-another-repo') {
      log('warn', `The library is inside another repository, at ${this.#state.top}; its history stays off.`);
    } else if (this.#state.state === 'no-git') {
      log('warn', `git could not start, so the library's history is off: ${this.#state.error}`);
    } else if (this.#state.state === 'tracked') {
      const sync = syncedFolder(library);
      if (sync) log('warn', `${sync} syncs the library; two machines writing one .git folder can corrupt it.`);
      this.#checkpoints.now('recovered');
    }
    return this.#state;
  }

  /** A write from the window has landed. */
  wrote(name?: string): void {
    if (this.#state.state === 'tracked') this.#checkpoints.wrote(name);
  }

  request(reason: 'chapter-switch' | 'book-close'): void {
    if (this.#state.state === 'tracked') this.#checkpoints.request(reason);
  }

  /**
   * A commit now, once any running one is done; resolves when it has landed. An import's
   * is the librarian's, its author's part the author's (whoFor).
   */
  async commitNow(reason: 'import-author' | 'import'): Promise<void> {
    if (this.#state.state !== 'tracked') return;
    await this.#pairs; // a pair holds the checkpoints, so the commit would wait unseen
    this.#checkpoints.now(reason);
    await this.#checkpoints.drained();
  }

  /**
   * A librarian edit between two commits, so the writer's words and the librarian's
   * never share one. What is pending is committed as the author's, then apply runs,
   * then the paths it changed (relative to the library) are committed as the
   * librarian's; no checkpoint runs in between, and pairs run one at a time. A failed
   * author commit refuses the edit: apply never runs. An apply that fails still has
   * what it changed committed as the librarian's before its error goes on. In a library
   * with no history apply runs alone.
   */
  around<T>(paths: readonly string[], apply: () => Promise<T>): Promise<Paired<T>> {
    const run = this.#pairs.then(() => this.#around(paths, apply));
    this.#pairs = run.catch(() => {});
    return run;
  }

  async #around<T>(paths: readonly string[], apply: () => Promise<T>): Promise<Paired<T>> {
    if (this.#state.state !== 'tracked') return { result: await apply(), before: null, after: null };
    const { log } = this.#o;
    const start = performance.now();
    await this.#checkpoints.pause();
    try {
      const before = await this.#commitAs('author', 'librarian-before');
      let result: T;
      try {
        result = await apply();
      } catch (err) {
        await this.#commitAs('librarian', 'librarian-after', paths).catch((late: unknown) => {
          log('error', 'git.librarian: the edit failed, and so did its commit', { message: String(late) });
        });
        throw err;
      }
      const after = await this.#commitAs('librarian', 'librarian-after', paths);
      log('info', 'git.librarian', { paths, before, after, ms: Math.round(performance.now() - start) });
      return { result, before, after };
    } finally {
      this.#checkpoints.resume();
    }
  }

  async keepHistory(): Promise<Started> {
    await this.#checkpoints.drained();
    const { git, library, settings, log } = this.#o;
    const started = await keepHistory(git, library, { librarian: settings.librarian, author: settings.author });
    this.#state = await repoState(git, library);
    log('info', 'git.keep-history', { started: started.started, commit: started.committed?.commit ?? null });
    return started;
  }

  async blame(ids: { bookId: unknown; chId: unknown }): Promise<BlameLine[]> {
    if (this.#state.state !== 'tracked') return [];
    const { git, library, settings, attributesFile, textconv, log } = this.#o;
    const start = performance.now();
    const lines = await blameChapter(git, library, ids, { librarian: settings.librarian, attributesFile, textconv });
    log('debug', 'git.blame', { ...ids, lines: lines.length, ms: Math.round(performance.now() - start) });
    return lines;
  }

  /** The last commit, or null in a library with no history or no commit yet. */
  async head(): Promise<string | null> {
    if (this.#state.state !== 'tracked') return null;
    const { git, library, log } = this.#o;
    try {
      const { stdout } = await git.run(library, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
      return stdout.trim() || null;
    } catch (err) {
      if (!(err instanceof GitError && err.kind === 'exit')) log('warn', 'git.head', { message: String(err) });
      return null;
    }
  }

  /** A file as a commit holds it (rel from the library); null when it lacks it or there is no history. */
  async show(commit: string, rel: string): Promise<string | null> {
    if (this.#state.state !== 'tracked') return null;
    const { git, library } = this.#o;
    try {
      const { stdout } = await git.run(library, ['cat-file', 'blob', `${commit}:${rel}`]);
      return stdout;
    } catch (err) {
      if (err instanceof GitError && err.kind === 'exit') return null;
      throw err;
    }
  }

  /**
   * The files under a folder that commits after `from`, up to `to`, changed, each with
   * whether any of those commits was not the librarian's. Oldest first.
   */
  async changed(from: string, to: string, under: string): Promise<{ rel: string; byAuthor: boolean }[]> {
    if (this.#state.state !== 'tracked') return [];
    const { git, library, settings } = this.#o;
    const { stdout } = await git.run(library, ['-c', 'core.quotepath=off', 'log', '--reverse', '--format=@@%ae', '--name-only', `${from}..${to}`, '--', under]);
    const files = new Map<string, boolean>();
    let author = false;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('@@')) { author = line.slice(2).trim() !== settings.librarian.email; continue; }
      if (!line.trim()) continue;
      files.set(line, (files.get(line) ?? false) || author);
    }
    return [...files].map(([rel, byAuthor]) => ({ rel, byAuthor }));
  }

  /** On quit: one last commit, waiting at most timeoutMs. */
  async close(timeoutMs: number): Promise<void> {
    this.#checkpoints.stop();
    if (this.#state.state === 'tracked') this.#checkpoints.now('close');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), timeoutMs); });
    // a pair in flight holds the close commit until it ends
    const done = await Promise.race([this.#pairs.then(() => this.#checkpoints.drained()).then(() => 'done' as const), late]);
    clearTimeout(timer);
    if (done === 'late') this.#o.log('warn', 'git.close: the last commit was still running; it is made at the next start');
  }

  /** Resolves once no commit is running or queued, a librarian pair's included. */
  async drained(): Promise<void> {
    for (let pairs = this.#pairs; ; pairs = this.#pairs) {
      await pairs;
      await this.#checkpoints.drained();
      if (pairs === this.#pairs) return;
    }
  }

  stop(): void {
    this.#checkpoints.stop();
  }

  async #commit(reason: Reason): Promise<void> {
    await this.#commitAs(whoFor(reason), reason);
  }

  async #commitAs(who: Who, reason: Reason, paths?: readonly string[]): Promise<string | null> {
    const { git, library, settings, log } = this.#o;
    const start = performance.now();
    const made = await commitAll(git, library, {
      who, reason, librarian: settings.librarian, author: settings.author, paths, gate: this.#gate,
    });
    this.#lastFailure = '';
    if (!made) {
      log('debug', 'git.checkpoint', { reason, commit: null });
      return null;
    }
    const leftOut = made.leftOut.join(', ');
    if (leftOut && leftOut !== this.#leftOut) {
      log('warn', `Books with a repository of their own are kept out of the library's history: ${leftOut}`);
    }
    this.#leftOut = leftOut;
    log('info', 'git.checkpoint', {
      reason, commit: made.commit, files: made.files, ms: Math.round(performance.now() - start),
    });
    return made.commit;
  }

  // The same failure on every pause would fill the log; it is logged when it changes.
  #failed(err: unknown, reason: Reason): void {
    const key = err instanceof GitError ? `${err.kind}:${err.stderr.trim()}` : String(err);
    if (key === this.#lastFailure) return;
    this.#lastFailure = key;
    this.#o.log('error', 'git.checkpoint.failed', {
      reason,
      message: err instanceof Error ? err.message : String(err),
      stderr: err instanceof GitError ? err.stderr : undefined,
    });
  }
}
