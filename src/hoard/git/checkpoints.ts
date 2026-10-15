// When the library is committed. A save restarts the idle timer, so commits follow the
// writer's pauses rather than NEO's 800 ms saves. A chapter switch or a book closing asks
// for a checkpoint, which waits until no save has landed for a second, because the
// window's last save may still be on its way, but no longer than five. Commits run one
// at a time; a trigger that arrives during one runs once after it. A pause (the
// librarian's commit pair) starts no commit until it ends, then runs the last trigger.
import type { Reason } from './commit.ts';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CheckpointOptions {
  idleMs: number;
  /** A requested checkpoint runs once no save has landed for this long. Default 1 s. */
  settleMs?: number;
  /** and at most this long after it was asked for. Default 5 s. */
  settleMaxMs?: number;
  clock?: Clock;
  commit(reason: Reason): Promise<unknown>;
  onError?(err: unknown, reason: Reason): void;
}

export class Checkpoints {
  readonly #options: Required<Omit<CheckpointOptions, 'onError'>> & Pick<CheckpointOptions, 'onError'>;
  #idle: unknown = null;
  #settle: unknown = null;
  #requested: { reason: Reason; deadline: number } | null = null;
  #running: Promise<void> | null = null;
  #queued: Reason | null = null;
  #paused = false;

  constructor(options: CheckpointOptions) {
    this.#options = {
      ...options,
      settleMs: options.settleMs ?? 1_000,
      settleMaxMs: options.settleMaxMs ?? 5_000,
      clock: options.clock ?? systemClock,
    };
  }

  /** A write from the window has landed. */
  wrote(_name?: string): void {
    const { clock, idleMs } = this.#options;
    if (this.#requested) {
      this.#armSettle();
      return;
    }
    clock.clearTimeout(this.#idle);
    this.#idle = clock.setTimeout(() => {
      this.#idle = null;
      this.now('idle');
    }, idleMs);
  }

  /** A checkpoint once the last save has landed. */
  request(reason: Reason): void {
    const { clock, settleMaxMs } = this.#options;
    clock.clearTimeout(this.#idle);
    this.#idle = null;
    if (!this.#requested) this.#requested = { reason, deadline: clock.now() + settleMaxMs };
    else this.#requested.reason = reason;
    this.#armSettle();
  }

  /** A checkpoint now, or straight after the one running. */
  now(reason: Reason): void {
    if (this.#running || this.#paused) {
      this.#queued = reason;
      return;
    }
    this.#running = this.#run(reason);
  }

  /** Resolves once no commit is running or queued. */
  async drained(): Promise<void> {
    while (this.#running) await this.#running;
  }

  /** Starts no commit until resume; resolves once the commit in flight is done. */
  async pause(): Promise<void> {
    this.#paused = true;
    await this.drained();
  }

  /** Ends a pause, running the last trigger that fired during it. */
  resume(): void {
    this.#paused = false;
    const queued = this.#queued;
    this.#queued = null;
    if (queued && !this.#running) this.now(queued);
    else this.#queued = queued;
  }

  /** Drops every timer; what is running finishes. */
  stop(): void {
    const { clock } = this.#options;
    clock.clearTimeout(this.#idle);
    clock.clearTimeout(this.#settle);
    this.#idle = this.#settle = this.#requested = null;
  }

  #armSettle(): void {
    const { clock, settleMs } = this.#options;
    const requested = this.#requested;
    if (!requested) return;
    clock.clearTimeout(this.#settle);
    const wait = Math.max(0, Math.min(settleMs, requested.deadline - clock.now()));
    this.#settle = clock.setTimeout(() => {
      this.#settle = null;
      this.#requested = null;
      this.now(requested.reason);
    }, wait);
  }

  async #run(reason: Reason): Promise<void> {
    try {
      await this.#options.commit(reason);
    } catch (err) {
      this.#options.onError?.(err, reason);
    }
    const queued = this.#paused ? null : this.#queued;
    if (queued) this.#queued = null;
    this.#running = queued ? this.#run(queued) : null;
  }
}
