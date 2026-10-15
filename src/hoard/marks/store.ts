// The marks sidecars, on the main side. One file per chapter that has marks, at
// .neo/<bookId>/chapters/<chId>.json, mirroring the chapter's own path as the spec has
// it. The window never names a path, a time or an author: it sends ids and words, and
// this file decides the rest.
//
// Each action reads the file afresh, changes it and writes it whole (temporary file,
// fsync, rename), so a mark another device added since the last read is kept, and a
// crash leaves the old file or the new one. Actions on one file wait for each other.
// A file that does not read as the schema says is reported and left alone: no action
// writes over it until someone mends it. Reading never writes.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { HoardMarksV1, Mark, MarkAnchor, MarkKind, MarkState, MarkWho } from '../../generated/hoard-marks-v1.js';
import { validateHoardMarksV1 } from '../../generated/validators.cjs';
import { newMark, reply, transition } from './model.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface MarkStoreOptions {
  library: () => string;
  now?: () => Date;
  newId?: (prefix: 'm' | 'e') => string;
  /** The library's last commit, or null. */
  head?: () => Promise<string | null>;
  /** Told after every write, so the library's history takes the sidecar. */
  wrote?: (name: string) => void;
  log: (level: Level, message: string, data?: unknown) => void;
}

interface ChapterIds { bookId: string; chId: string }

export interface AddRequest extends ChapterIds {
  kind: MarkKind;
  anchor: Omit<MarkAnchor, 'commit'>;
  body?: string;
  proposed?: string;
}
export interface ReplyRequest extends ChapterIds { markId: string; body: string }
export interface StateRequest extends ChapterIds { markId: string; state: MarkState }

export interface Listed {
  chapters: Record<string, Mark[]>;
  /** Chapters whose sidecar is there but does not read; the log says why. */
  unreadable: string[];
}

export class MarkFileError extends Error {
  readonly file: string;
  constructor(file: string, why: string) {
    super(`${file} cannot be read as marks (${why}); it is left as it is until it is mended`);
    this.name = 'MarkFileError';
    this.file = file;
  }
}

// One name inside the library, as main.js's libName() allows.
function oneName(name: unknown, what: string): string {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new TypeError(`${what} must be one name inside the library: ${JSON.stringify(name)}`);
  }
  return name;
}

const chaptersDir = (library: string, bookId: string) => path.join(library, '.neo', oneName(bookId, 'bookId'), 'chapters');

export function sidecarPath(library: string, bookId: string, chId: string): string {
  return path.join(chaptersDir(library, bookId), `${oneName(chId, 'chId')}.json`);
}

function randomId(prefix: 'm' | 'e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeWhole(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export class MarkStore {
  readonly #o: MarkStoreOptions;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: MarkStoreOptions) {
    this.#o = options;
  }

  async list(bookId: string): Promise<Listed> {
    const dir = chaptersDir(this.#o.library(), bookId);
    const out: Listed = { chapters: {}, unreadable: [] };
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      const chId = name.slice(0, -'.json'.length);
      try {
        out.chapters[chId] = this.#read(path.join(dir, name)).marks;
      } catch (err) {
        if (!(err instanceof MarkFileError)) throw err;
        out.unreadable.push(chId);
      }
    }
    return out;
  }

  async add(req: AddRequest, who: MarkWho): Promise<{ id: string; marks: Mark[] }> {
    const file = sidecarPath(this.#o.library(), req.bookId, req.chId);
    return this.#queued(file, async () => {
      const data = this.#read(file);
      const commit = this.#o.head ? await this.#o.head() : null;
      const id = this.#id('m');
      const mark = newMark({
        id, kind: req.kind, anchor: { ...req.anchor, commit }, body: req.body, proposed: req.proposed, who, at: this.#now(),
      });
      const marks = [...data.marks, mark];
      this.#write(file, marks, { action: 'add', id, kind: req.kind });
      return { id, marks };
    });
  }

  async reply(req: ReplyRequest, who: MarkWho): Promise<{ marks: Mark[] }> {
    return this.#change(req, (mark) => reply(mark, { id: this.#id('e'), who, at: this.#now(), body: req.body }), 'reply');
  }

  async setState(req: StateRequest, who: MarkWho): Promise<{ marks: Mark[] }> {
    return this.#change(req, (mark) => transition(mark, req.state, who, this.#now()), `state:${req.state}`);
  }

  async #change(req: ChapterIds & { markId: string }, change: (mark: Mark) => Mark, action: string): Promise<{ marks: Mark[] }> {
    const file = sidecarPath(this.#o.library(), req.bookId, req.chId);
    return this.#queued(file, async () => {
      const data = this.#read(file);
      const i = data.marks.findIndex((m) => m.id === req.markId);
      if (i === -1) throw new RangeError(`no mark ${req.markId} in ${req.bookId}/${req.chId}`);
      const marks = data.marks.slice();
      marks[i] = change(marks[i]);
      this.#write(file, marks, { action, id: req.markId });
      return { marks };
    });
  }

  #queued<T>(file: string, run: () => Promise<T>): Promise<T> {
    const before = this.#queues.get(file) ?? Promise.resolve();
    const next = before.then(run, run);
    const settled = next.catch(() => {});
    this.#queues.set(file, settled);
    settled.then(() => { if (this.#queues.get(file) === settled) this.#queues.delete(file); }, () => {});
    return next;
  }

  #read(file: string): HoardMarksV1 {
    if (!existsSync(file)) return { version: 1, marks: [] };
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw this.#unreadable(file, err instanceof Error ? err.message : String(err));
    }
    if (!validateHoardMarksV1(data)) {
      const why = (validateHoardMarksV1.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
      throw this.#unreadable(file, why);
    }
    return data;
  }

  #unreadable(file: string, why: string): MarkFileError {
    const err = new MarkFileError(file, why);
    this.#o.log('error', `marks: ${err.message}`, { file });
    return err;
  }

  #write(file: string, marks: Mark[], trace: Record<string, unknown>): void {
    const data: HoardMarksV1 = { version: 1, marks };
    if (!validateHoardMarksV1(data)) throw new TypeError(`marks: refusing to write ${file}: ${JSON.stringify(validateHoardMarksV1.errors)}`);
    writeWhole(file, `${JSON.stringify(data, null, 2)}\n`);
    this.#o.log('debug', 'marks.write', { file, marks: marks.length, ...trace });
    this.#o.wrote?.('.neo');
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  #id(prefix: 'm' | 'e'): string {
    return (this.#o.newId ?? randomId)(prefix);
  }
}
