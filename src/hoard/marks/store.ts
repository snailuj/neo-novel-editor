// The marks sidecars, on the main side. One file per chapter that has marks, at
// .neo/<bookId>/chapters/<chId>.json, mirroring the chapter's own path as the spec has
// it, and one per page (wiki/ or sources/) that has marks, at .neo/marks/<tree>/<path>.json
// with the page's .html kept in the name. A page is named by its id, <tree>/<path>. The window never names a path, a time or an author: it sends ids and words, and
// this file decides the rest.
//
// Each action reads the file afresh, changes it and writes it whole (temporary file,
// fsync, rename), so a mark another device added since the last read is kept, and a
// crash leaves the old file or the new one. Actions on one file wait for each other.
// A file that does not read as the schema says is reported and left alone: no action
// writes over it until someone mends it. Reading never writes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardMarksV1, Mark, MarkAnchor, MarkKind, MarkState, MarkWho } from '../../generated/hoard-marks-v1.js';
import { validateHoardMarksV1 } from '../../generated/validators.cjs';
import { folderLinkProblem, folderLinkText, oneName, writeWhole } from '../files.ts';
import { marksOf, PageRefused, parseId } from '../pages/identity.ts';
import { isSuggestion, newMark, reply, transition } from './model.ts';

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
interface PageTarget { page: string }
/** Where marks live: a chapter of a book, or a page named by its id. */
export type MarkTarget = ChapterIds | PageTarget;

const isPage = (target: MarkTarget): target is PageTarget => 'page' in target;
const labelOf = (target: MarkTarget) => (isPage(target) ? target.page : `${target.bookId}/${target.chId}`);

/**
 * A validated request from the window names its place as page, or as bookId and chId
 * (the schemas allow nothing else); this gives the store the one it was sent.
 */
export function targeted<R extends { page?: string; bookId?: string; chId?: string }>(req: R): Omit<R, 'page' | 'bookId' | 'chId'> & MarkTarget {
  const { page, bookId, chId, ...rest } = req;
  if (page !== undefined) return { ...rest, page };
  if (bookId === undefined || chId === undefined) throw new TypeError('a marks request names a page, or a book and a chapter');
  return { ...rest, bookId, chId };
}

interface Body {
  kind: MarkKind;
  anchor: Omit<MarkAnchor, 'commit'>;
  body?: string;
  proposed?: string;
}
export type AddRequest = MarkTarget & Body;
export type ReplyRequest = MarkTarget & { markId: string; body: string };
export type StateRequest = MarkTarget & { markId: string; state: MarkState };

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

const chaptersDir = (library: string, bookId: string) => path.join(library, '.neo', oneName(bookId, 'bookId'), 'chapters');

export function sidecarPath(library: string, bookId: string, chId: string): string {
  return path.join(chaptersDir(library, bookId), `${oneName(chId, 'chId')}.json`);
}

/** A page's sidecar; throws PageRefused for an id that is not a safe page id. */
export function pageSidecarPath(library: string, page: string): string {
  return path.join(library, ...marksOf(page).split('/'));
}

const fileOf = (library: string, target: MarkTarget) =>
  isPage(target) ? pageSidecarPath(library, target.page) : sidecarPath(library, target.bookId, target.chId);

function randomId(prefix: 'm' | 'e'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class MarkStore {
  readonly #o: MarkStoreOptions;
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: MarkStoreOptions) {
    this.#o = options;
  }

  /** Every chapter's marks in a book. A page is read with list(). */
  async listBook(bookId: string): Promise<Listed> {
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

  /** One page's marks, after any write to it queued before; throws MarkFileError for a file that does not read. */
  async list(page: string): Promise<Mark[]> {
    const file = pageSidecarPath(this.#o.library(), page);
    return this.#queued(file, async () => this.#read(file).marks);
  }

  /** One chapter's marks, after any write to it queued before; throws MarkFileError for a file that does not read. */
  async chapter(bookId: string, chId: string): Promise<Mark[]> {
    const file = sidecarPath(this.#o.library(), bookId, chId);
    return this.#queued(file, async () => this.#read(file).marks);
  }

  async add(req: AddRequest, who: MarkWho): Promise<{ id: string; marks: Mark[] }> {
    const file = fileOf(this.#o.library(), req);
    return this.#queued(file, async () => {
      const data = this.#read(file);
      const commit = this.#o.head ? await this.#o.head() : null;
      const id = this.#id('m');
      const mark = newMark({
        id, kind: req.kind, anchor: { ...req.anchor, commit }, body: req.body, proposed: req.proposed, who, at: this.#now(),
      });
      const marks = [...data.marks, mark];
      if (isPage(req)) this.#pageStillThere(req.page);
      this.#write(file, marks, { action: 'add', id, kind: req.kind });
      return { id, marks };
    });
  }

  /** Marks made elsewhere (an import), added after the chapter's or the page's own. */
  async addAll(page: string, made: Mark[]): Promise<void>;
  async addAll(bookId: string, chId: string, made: Mark[]): Promise<void>;
  async addAll(first: string, second: string | Mark[], third?: Mark[]): Promise<void> {
    const [target, made] = typeof second === 'string' ? [{ bookId: first, chId: second }, third ?? []] : [{ page: first }, second];
    const file = fileOf(this.#o.library(), target);
    await this.#queued(file, async () => {
      if (made.length === 0) return;
      const data = this.#read(file);
      this.#write(file, [...data.marks, ...made], { action: 'add-all', marks: made.length });
    });
  }

  async reply(req: ReplyRequest, who: MarkWho): Promise<{ marks: Mark[] }> {
    return this.#change(req, (mark) => reply(mark, { id: this.#id('e'), who, at: this.#now(), body: req.body }), 'reply');
  }

  async setState(req: StateRequest, who: MarkWho): Promise<{ marks: Mark[] }> {
    return this.#change(req, (mark) => transition(mark, req.state, who, this.#now()), `state:${req.state}`);
  }

  /**
   * A reviewer's verdict on a suggestion: the change of state and, when there is one, the
   * reviewer's reason as a comment in its thread, in one write.
   */
  async review(req: StateRequest, who: MarkWho, note?: string): Promise<{ marks: Mark[] }> {
    return this.#change(req, (mark) => {
      if (!isSuggestion(mark.kind)) throw new RangeError(`${req.markId} is a ${mark.kind}, not a suggestion`);
      const at = this.#now();
      const moved = transition(mark, req.state, who, at);
      return note === undefined ? moved : reply(moved, { id: this.#id('e'), who, at, body: note });
    }, `review:${req.state}`);
  }

  async #change(req: MarkTarget & { markId: string }, change: (mark: Mark) => Mark, action: string): Promise<{ marks: Mark[] }> {
    const file = fileOf(this.#o.library(), req);
    return this.#queued(file, async () => {
      const data = this.#read(file);
      const i = data.marks.findIndex((m) => m.id === req.markId);
      if (i === -1) throw new RangeError(`no mark ${req.markId} in ${labelOf(req)}`);
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

  // Page marks live under .neo/marks, and a link in that folder could lead a read or a write
  // out of the library. Like a page file (PageStore.inside), the real path of the nearest part
  // that exists must stay inside it. A chapter's sidecar is not under it and is not looked at.
  #contained(file: string): void {
    const problem = folderLinkProblem(this.#o.library(), '.neo/marks', file);
    if (!problem) return;
    this.#o.log('warn', 'marks.refused', { file, reason: problem });
    throw new PageRefused('unsafe', `${file} is not a marks path: ${folderLinkText(problem, '.neo/marks')}`);
  }

  // add() waits for head() between reading the marks and writing them. A rename that moves
  // the page and its marks file in that wait would have this write recreate the old file, so
  // the mark would stay under an id that is no longer a page. A rename moves the page file
  // first and nothing awaits between this check and the write, so a page that is still here
  // when the write starts is one whose marks file has not been moved either.
  #pageStillThere(page: string): void {
    const ref = parseId(page);
    if (existsSync(path.join(this.#o.library(), ref.tree, ...ref.path.split('/')))) return;
    this.#o.log('warn', 'marks.refused', { page, reason: 'the page is gone, say renamed, so a mark added to it would be left under its old id' });
    throw new PageRefused('missing', `${page} is not a page, so no mark is added to it`);
  }

  #read(file: string): HoardMarksV1 {
    this.#contained(file);
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
    this.#contained(file);
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
