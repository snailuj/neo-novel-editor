// The main half's way to the search worker (worker.ts), a utility process as NEO's
// spellchecker is. It starts on the first search, so a writer who never searches never
// pays for it, and reads the library there, off NEO's main thread. Each search goes with
// an id and its answer comes back to it; a worker that stops fails what was waiting, with
// a reason, and the next search starts a new one. The window drops answers it no longer
// wants, so nothing here cancels.
import type { IndexStats, LibraryFound, LibraryQuery } from './library.ts';

/** What the client needs of a utility process. */
export interface WorkerProcess {
  postMessage(message: { id: number; root: string; query: LibraryQuery }): void;
  on(event: 'message', fn: (message: Answer) => void): unknown;
  on(event: 'exit', fn: (code: number) => void): unknown;
  kill(): boolean;
}

export type Answer =
  | { id: number; ok: true; found: LibraryFound; stats: Partial<IndexStats> }
  | { id: number; ok: false; error: string };

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface SearchClientOptions {
  start: () => WorkerProcess;
  library: () => string;
  log: (level: Level, message: string, data?: unknown) => void;
}

export class SearchClient {
  readonly #o: SearchClientOptions;
  #worker: WorkerProcess | null = null;
  #next = 1;
  #waiting = new Map<number, { resolve: (found: LibraryFound) => void; reject: (err: Error) => void }>();
  #told = false;

  constructor(options: SearchClientOptions) {
    this.#o = options;
  }

  search(query: LibraryQuery): Promise<LibraryFound> {
    const worker = this.#worker ?? this.#start();
    const id = this.#next++;
    return new Promise<LibraryFound>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      worker.postMessage({ id, root: this.#o.library(), query });
    });
  }

  stop(): void {
    this.#worker?.kill();
    this.#worker = null;
  }

  #start(): WorkerProcess {
    const worker = this.#o.start();
    this.#worker = worker;
    worker.on('message', (answer) => {
      const waiting = this.#waiting.get(answer.id);
      if (!waiting) return;
      this.#waiting.delete(answer.id);
      if (!answer.ok) {
        waiting.reject(new Error(answer.error));
        return;
      }
      // the first search's numbers once, at info; each later one at debug
      this.#o.log(this.#told ? 'debug' : 'info', this.#told ? 'search.query' : 'search.ready', { ...answer.stats, total: answer.found.total });
      this.#told = true;
      waiting.resolve(answer.found);
    });
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#worker = null;
      const why = new Error(`Search stopped (exit code ${code}). It starts again with the next search.`);
      for (const waiting of this.#waiting.values()) waiting.reject(why);
      this.#waiting.clear();
      if (code !== 0) this.#o.log('warn', 'search.stopped', { code });
    });
    return worker;
  }
}
