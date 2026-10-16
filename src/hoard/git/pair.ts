// The librarian's commit pair as the window asks for it. The window holds the chapter
// and applies the edit; the commits are made here, around it (GitLayer.around). begin
// waits until the chapter on disk is what the window holds, so the writer's last typing
// is in the author's commit, then makes that commit. end waits until the disk holds the
// edited text, then commits the chapter as the librarian's. NEO saves a chapter 800 ms
// after it changes, so both waits are short; the disk, not the window's word, says when
// a save has landed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { oneName } from '../files.ts';
import type { GitLayer, Paired } from './layer.ts';
import type { GitLog } from './runner.ts';

export interface PairOptions {
  layer: Pick<GitLayer, 'around' | 'status'>;
  library(): string;
  log: GitLog;
  /** How long a wait for a save to land lasts. Default 5 s. */
  settleMs?: number;
  /** How long a pair waits for the window's end before ending itself. Default 60 s. */
  abandonMs?: number;
}

export type Begun = { pair: string | null } | { refused: 'unsaved' };

export interface Ended {
  before: string | null;
  after: string | null;
}

interface Open {
  rel: string;
  finish(html: string | null): void;
  done: Promise<Paired<void>>;
  timer: ReturnType<typeof setTimeout>;
}

export class LibrarianPairs {
  readonly #o: Required<Omit<PairOptions, 'layer' | 'library' | 'log'>> & Pick<PairOptions, 'layer' | 'library' | 'log'>;
  readonly #open = new Map<string, Open>();
  readonly #waiting = new Map<string, Set<() => void>>();
  #next = 1;

  constructor(options: PairOptions) {
    this.#o = { settleMs: 5_000, abandonMs: 60_000, ...options };
  }

  /** A chapter write has landed. */
  landed(bookId: string, chId: string): void {
    const waiters = this.#waiting.get(`${bookId}/chapters/${chId}.html`);
    if (waiters) for (const wake of [...waiters]) wake();
  }

  /** Commits the writer's work as the author's once the chapter on disk is html. */
  async begin(ask: { bookId: string; chId: string; html: string }): Promise<Begun> {
    const rel = `${oneName(ask.bookId, 'bookId')}/chapters/${oneName(ask.chId, 'chId')}.html`;
    const { layer, log } = this.#o;
    if (layer.status().state !== 'tracked') return { pair: null };
    if (!(await this.#settled(rel, ask.html))) {
      log('warn', 'git.librarian: the chapter on disk is not what the window holds, so the edit waits', { rel });
      return { refused: 'unsaved' };
    }
    let finish!: (html: string | null) => void;
    const edited = new Promise<string | null>((resolve) => { finish = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const done = layer.around([rel], async () => {
      entered();
      const html = await edited;
      if (html !== null && !(await this.#settled(rel, html))) {
        log('warn', 'git.librarian: the edit had not reached the disk; the next checkpoint commits it as the author\'s', { rel });
      }
    });
    // A failed author commit rejects done before the edit is let in.
    await Promise.race([inside, done]);
    const pair = `p${this.#next++}`;
    const timer = setTimeout(() => {
      log('warn', 'git.librarian: the window never ended the edit; what the disk holds is committed as the librarian\'s', { rel });
      this.#close(pair, null).catch((err: unknown) => log('error', 'git.librarian: the abandoned edit was not committed', String(err)));
    }, this.#o.abandonMs);
    timer.unref?.(); // NEO quitting is not held for it; the next start commits what is left
    this.#open.set(pair, { rel, finish, done, timer });
    return { pair };
  }

  /** Commits the edit as the librarian's once the chapter on disk is html (null: as it is). */
  async end(ask: { pair: string | null; html: string | null }): Promise<Ended> {
    if (ask.pair === null) return { before: null, after: null };
    if (!this.#open.has(ask.pair)) throw new Error(`git.librarian: no edit ${ask.pair} is open`);
    return this.#close(ask.pair, ask.html);
  }

  async #close(pair: string, html: string | null): Promise<Ended> {
    const open = this.#open.get(pair);
    if (!open) throw new Error(`git.librarian: no edit ${pair} is open`);
    this.#open.delete(pair);
    clearTimeout(open.timer);
    open.finish(html);
    const { before, after } = await open.done;
    return { before, after };
  }

  // Whether the file comes to hold html within settleMs. Each landed write of it wakes a
  // fresh look, and the waiter is set before the look so no write slips between.
  async #settled(rel: string, html: string): Promise<boolean> {
    const { settleMs } = this.#o;
    const file = path.join(this.#o.library(), rel);
    let late = false;
    let wake = () => {};
    const wakeAll = () => wake();
    const deadline = setTimeout(() => { late = true; wakeAll(); }, settleMs);
    try {
      for (;;) {
        const woke = new Promise<void>((resolve) => { wake = resolve; });
        this.#watch(rel, wakeAll);
        const disk = await readFile(file, 'utf8').catch(() => null);
        if (disk === html) return true;
        if (late) return false;
        await woke;
      }
    } finally {
      clearTimeout(deadline);
      this.#unwatch(rel, wakeAll);
    }
  }

  #watch(rel: string, fn: () => void): void {
    let set = this.#waiting.get(rel);
    if (!set) this.#waiting.set(rel, (set = new Set()));
    set.add(fn);
  }

  #unwatch(rel: string, fn: () => void): void {
    const set = this.#waiting.get(rel);
    if (!set) return;
    set.delete(fn);
    if (!set.size) this.#waiting.delete(rel);
  }
}
