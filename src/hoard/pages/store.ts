// Pages as files, on the main side. The library has two folders at its root, wiki/ and
// sources/, and a page is one .html file in either (subfolders allowed); its title is
// its file name without .html. Every reader (search, the companion, review, the git
// layer) lists and reads pages here, and none opens the Wiki book.
//
// A listing walks the folders and stats each file, never opening a body, so a library of
// thousands of pages costs a walk. A write lands only while the file still holds what the
// caller read (the rule pages.edit keeps), so a change that arrived from another device
// is never written over. Every refusal is logged; every request names its page by an id
// that identity.ts has checked, so no path leaves its tree.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { opendir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateHoardRenameV1 } from '../../generated/validators.cjs';
import type { HoardRenameV1 } from '../../generated/hoard-rename-v1.js';
import { key } from '../../librarian/links.ts';
import { booksWithOwnRepo } from '../git/commit.ts';
import type { GitLayer } from '../git/layer.ts';
import { fileAbove, folderLinkProblem, folderLinkText, writeWhole } from '../files.ts';
import { checkPath, checkTitle, idOf, marksOf, PageRefused, parseId, titleOf, TREES, type PageRef, type Tree } from './identity.ts';
import { editsFor, rewriteHtml, type Retarget, type WindowEdit } from './rewrite.ts';
import { Titles } from './titles.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface PageStoreOptions {
  library: () => string;
  /** Takes writes into the library's history; absent, pages are written without it. */
  layer?: Pick<GitLayer, 'around' | 'wrote'>;
  log: (level: Level, message: string, data?: unknown) => void;
  /** Told before each step of a rename, so a test can stop it part way; the step may throw. */
  onStep?: (step: 'journal' | 'move' | 'sidecar' | 'marks' | 'rewrite', file: string) => void;
}

export interface PageEntry {
  id: string;
  tree: Tree;
  path: string;
  title: string;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
}

export interface PageFile extends Omit<PageEntry, 'size' | 'mtime'> {
  html: string;
}

export type Written = { ok: true } | { ok: false; reason: 'missing' | 'stale' };

export type Who = 'author' | 'librarian';

/** One stored page that changed on disk; see PageStore.onChange. */
export interface PageChange {
  /** The page's id after the change. */
  page: string;
  /** For a rename, the id the page had. */
  from?: string;
  kind: 'edit' | 'create' | 'rename' | 'import';
  who: Who;
  /** The page's HTML before the change; empty for a new page. */
  before: string;
  after: string;
}

/** Link edits for one chapter of the open book, for the window to make through the host's `replace`. */
export interface ChapterEdits {
  bookId: string;
  chId: string;
  edits: WindowEdit[];
}

export interface Renamed {
  /** The page's id now. */
  id: string;
  from: string;
  /** Files this call wrote with a link changed, the open book's chapters not among them. */
  rewrittenFiles: number;
  rewrittenLinks: number;
  /** Links to the page that markup splits, which could not be rewritten and were left. */
  skipped: number;
  deferred: ChapterEdits[];
}

// The note of a rename in progress; see schemas/hoard-rename-v1.json.
const JOURNAL = '.neo/pages/.rename.json';
// The last renames that finished, so a repeated request can be told it is done already.
const RECORD = '.neo/pages/renames.json';
const RECORD_LENGTH = 50;
const CHAPTER = /^(book-[^/]+)\/chapters\/([^/]+)\.html$/;
const sidecarOf = (id: string) => `.neo/pages/${id}.json`;
const readNow = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const sameFile = (a: string, b: string) => {
  const [x, y] = [statSync(a), statSync(b)];
  return x.ino === y.ino && x.dev === y.dev;
};

export class PageStore {
  protected readonly o: PageStoreOptions;
  #tail: Promise<unknown> = Promise.resolve();
  // Built on first use and kept by create and rename; list() builds it again, since pages
  // also arrive through sync. Null until then, or after a rename failed part way.
  #titles: Titles<PageEntry> | null = null;
  // counts each write, create and rename as it starts and as it ends: odd while one runs
  #changes = 0;
  // a list set its walk aside (a change ran beside it), so the index may lack a page that
  // came by sync: the next title check walks again, from inside the queue
  #stale = false;
  readonly #listeners = new Set<(change: PageChange) => void>();

  constructor(options: PageStoreOptions) {
    this.o = options;
  }

  protected file(ref: PageRef): string {
    return path.join(this.o.library(), ref.tree, ...ref.path.split('/'));
  }

  /**
   * The page's file, refused when its real path leaves its tree. checkPath keeps `..` out
   * of a path, but a symlinked folder or file inside a tree can still lead out of it. For
   * a file not there yet, the nearest folder that is decides; a dangling link is refused.
   */
  protected inside(ref: PageRef): string {
    const file = this.file(ref);
    const problem = folderLinkProblem(this.o.library(), ref.tree, file);
    if (problem) throw new PageRefused('unsafe', `${idOf(ref)} is not a page path: ${folderLinkText(problem, ref.tree)}`);
    const blocker = fileAbove(path.join(this.o.library(), ref.tree), ref.path);
    if (blocker) throw new PageRefused('unsafe', `${idOf(ref)} is not a page path: ${blocker} is a file, not a folder`);
    return file;
  }

  /** Runs one request, logging it if it is refused. */
  protected async op<T>(name: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof PageRefused) this.o.log('warn', 'pages.refused', { op: name, code: err.code, reason: err.message });
      throw err;
    }
  }

  /** Every page, one at a time, in no set order. Reads no body. */
  async *entries(): AsyncGenerator<PageEntry> {
    for (const tree of TREES) {
      const problem = folderLinkProblem(this.o.library(), tree, path.join(this.o.library(), tree));
      if (problem === 'root') this.o.log('warn', `pages: ${folderLinkText(problem, tree)}, so its pages are left out`);
      else yield* this.#walk(tree, '');
    }
  }

  async *#walk(tree: Tree, rel: string): AsyncGenerator<PageEntry> {
    const dir = path.join(this.o.library(), tree, ...(rel ? rel.split('/') : []));
    let handle;
    try {
      handle = await opendir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.o.log('warn', `pages: ${dir} does not list, so its pages are left out`, String(err));
      return;
    }
    try {
      for await (const d of handle) {
        if (d.name.startsWith('.')) continue;
        const at = rel ? `${rel}/${d.name}` : d.name;
        if (d.isSymbolicLink()) {
          this.o.log('debug', `pages: ${path.join(dir, d.name)} is a link, so it is not followed`);
        } else if (d.isDirectory()) {
          yield* this.#walk(tree, at);
        } else if (d.isFile() && d.name.endsWith('.html')) {
          try {
            const s = await stat(path.join(dir, d.name));
            yield { id: `${tree}/${at}`, tree, path: at, title: titleOf(at), size: s.size, mtime: s.mtimeMs };
          } catch (err) {
            this.o.log('warn', `pages: ${path.join(dir, d.name)} does not stat, so it is left out`, String(err));
          }
        }
      }
    } catch (err) {
      this.o.log('warn', `pages: ${dir} stopped listing part way`, String(err));
    }
  }

  async #scan(): Promise<PageEntry[]> {
    const pages: PageEntry[] = [];
    for await (const page of this.entries()) pages.push(page);
    return pages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async #index(): Promise<Titles<PageEntry>> {
    this.#titles ??= new Titles(await this.#scan());
    return this.#titles;
  }

  // The index a title is checked against; called only in the queue, so no change runs beside its walk.
  #checked(): Promise<Titles<PageEntry>> {
    if (this.#stale) {
      this.#stale = false;
      this.#titles = null;
    }
    return this.#index();
  }

  async list(): Promise<PageEntry[]> {
    const start = performance.now();
    const at = this.#changes;
    const pages = await this.#scan();
    const titles = new Titles(pages);
    // a walk that a change ran beside may miss it, so the index the change kept stays
    if (at % 2 === 0 && at === this.#changes) this.#titles = titles;
    else this.#stale = true;
    for (const group of titles.duplicates) this.o.log('warn', 'pages: these pages share one title, so a link reaches only the first', group.map((p) => p.id));
    this.o.log('info', 'pages.list', { pages: pages.length, ms: Math.round(performance.now() - start) });
    return pages;
  }

  /** The page a link target names, wiki first; undefined if none. */
  async resolve(target: string): Promise<PageEntry | undefined> {
    return (await this.#index()).resolve(target);
  }

  read(id: string): Promise<PageFile | null> {
    return this.op('read', async () => {
      const ref = parseId(id);
      const html = await readFile(this.inside(ref), 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
        throw err;
      });
      return html === null ? null : { id, tree: ref.tree, path: ref.path, title: titleOf(ref.path), html };
    });
  }

  /**
   * Tells `fn` of each write, create and rename that changed a page's bytes, once, from
   * inside the queue after the file holds the new text. A listener that throws is logged
   * and the save goes on. Returns the way to stop listening.
   */
  onChange(fn: (change: PageChange) => void): () => void {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  /**
   * Tells the listeners of a change made outside the store, such as an import's page
   * files, once the queue has run what came before it.
   */
  announce(change: PageChange): Promise<void> {
    return this.#serial(async () => { this.#emit(change); });
  }

  #emit(change: PageChange): void {
    this.o.log('info', 'pages.change', { page: change.page, from: change.from, kind: change.kind, who: change.who, listeners: this.#listeners.size });
    for (const fn of [...this.#listeners]) {
      try {
        fn(change);
      } catch (err) {
        this.o.log('error', 'pages.change.listener-failed', { page: change.page, kind: change.kind, why: String(err) });
      }
    }
  }

  write(id: string, before: string, after: string, who: Who = 'author'): Promise<Written> {
    return this.#serial(() => this.op('write', async () => {
      const ref = parseId(id);
      const file = this.inside(ref);
      const now = await readFile(file, 'utf8').catch(() => null);
      const refuse = (reason: 'missing' | 'stale'): Written => {
        this.o.log('warn', 'pages.write.refused', { id, reason });
        return { ok: false, reason };
      };
      if (now === null) return refuse('missing');
      if (now !== before) return refuse('stale');
      // a page nobody changed is not rewritten: synced libraries would see it move
      if (after !== now) {
        writeWhole(file, after);
        this.o.layer?.wrote(ref.tree);
      }
      this.o.log('info', 'pages.write', { id, bytes: Buffer.byteLength(after), changed: after !== now });
      if (after !== now) this.#emit({ page: id, kind: 'edit', who, before: now, after });
      return { ok: true };
    }));
  }

  create(tree: Tree, pagePath: string, html: string, who: Who = 'author'): Promise<PageEntry> {
    return this.#serial(() => this.op('create', async () => {
      const ref = parseId(`${tree}/${checkPath(pagePath)}`);
      const title = checkTitle(ref.path);
      this.inside(ref);
      const index = await this.#checked();
      const clash = index.taken(ref.tree, title);
      if (clash || existsSync(this.file(ref))) {
        throw new PageRefused('taken', `${JSON.stringify(title)} is already a page in ${ref.tree}${clash ? ` (${clash.id})` : ''}`);
      }
      writeWhole(this.file(ref), html);
      this.o.layer?.wrote(ref.tree);
      const s = await stat(this.file(ref));
      const made: PageEntry = { id: idOf(ref), tree: ref.tree, path: ref.path, title, size: s.size, mtime: s.mtimeMs };
      index.add(made);
      this.o.log('info', 'pages.create', { id: made.id, bytes: s.size });
      this.#emit({ page: made.id, kind: 'create', who, before: '', after: html });
      return made;
    }));
  }

  // Writes, creates and renames run one at a time: each reads the library the last one
  // left, so a write cannot land between a rename's read of a file and its rewrite.
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(async () => {
      this.#changes++;
      try {
        return await run();
      } finally {
        this.#changes++;
      }
    });
    this.#tail = next.catch(() => {});
    return next;
  }

  /**
   * Renames or moves a page inside its tree, and rewrites every link that resolves to it
   * ([[Old]], [[Old|alias]], [[Old#^id]], [[Old#Heading]], and the embed ![[Old]]) to the
   * new title, in pages of both trees and in the chapters of every NEO book. Which links
   * resolve to it is decided as titles.ts decides, so a wiki page shadowing a source of
   * the same title takes its links and the source's rename touches none. A new title held
   * in the other tree is refused, since taking it would move that page's links.
   *
   * The chapters of `openBookId` are not written, since the window saves its own copy of
   * them; their edits come back in `deferred`. Everything else is one commit credited to
   * the author. The plan is written to .neo/pages/.rename.json first, so a rename that
   * stops part way is finished by calling it again, or by recover() when NEO starts.
   */
  rename(id: string, newPath: string, openBookId: string | null, who: Who = 'author'): Promise<Renamed> {
    return this.#serial(() => this.op('rename', async () => this.#forgetOnFailure(async () => {
      const start = performance.now();
      const from = parseId(id);
      const to = parseId(`${from.tree}/${checkPath(newPath)}`);
      this.inside(from);
      this.inside(to);
      const pending = await this.#journal();
      if (pending) {
        const finished = await this.#finish(pending, openBookId, start, who);
        if (pending.from === id && pending.to === idOf(to)) return finished;
      }
      // a repeat of a rename that finished, say a request sent again: the page is already there
      if (id !== idOf(to) && !existsSync(this.file(from)) && existsSync(this.file(to)) && this.#lastRenameOf(id) === idOf(to)) {
        this.o.log('info', 'pages.rename.done-already', { from: id, to: idOf(to) });
        return { id: idOf(to), from: id, rewrittenFiles: 0, rewrittenLinks: 0, skipped: 0, deferred: [] };
      }
      if (id === idOf(to)) {
        if (!existsSync(this.file(from))) throw new PageRefused('missing', `${id} is not a page`);
        return { id, from: id, rewrittenFiles: 0, rewrittenLinks: 0, skipped: 0, deferred: [] };
      }
      return this.#finish(await this.#plan(from, to), openBookId, start, who);
    })));
  }

  // A rename that fails part way leaves the trees in a state the index cannot follow.
  async #forgetOnFailure<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof PageRefused)) this.#titles = null;
      throw err;
    }
  }

  /** Finishes a rename NEO stopped in the middle of; null when none is waiting. */
  recover(openBookId: string | null): Promise<Renamed | null> {
    return this.#serial(async () => {
      const pending = await this.#journal();
      if (!pending) return null;
      this.o.log('warn', 'pages.rename: finishing a rename that was left part way', { from: pending.from, to: pending.to });
      return this.#forgetOnFailure(() => this.#finish(pending, openBookId, performance.now()));
    });
  }

  async #journal(): Promise<HoardRenameV1 | null> {
    const file = path.join(this.o.library(), JOURNAL);
    const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') this.o.log('error', `pages: ${file} does not read, so no rename is finished`, String(err));
      return null;
    });
    if (text === null) return null;
    try {
      const data: unknown = JSON.parse(text);
      if (validateHoardRenameV1(data)) {
        const unsafe = this.#unsafeIn(data);
        if (!unsafe) return data;
        this.o.log('warn', `pages: ${file} is not a safe rename note, so it is ignored`, { path: unsafe });
        return null;
      }
      this.o.log('error', `pages: ${file} is not a rename note, so no rename is finished`, validateHoardRenameV1.errors);
    } catch (err) {
      this.o.log('error', `pages: ${file} does not parse, so no rename is finished`, String(err));
    }
    return null;
  }

  // The note is a file anyone can write, so each path in it must be one a rename could have
  // planned: from and to pages of one tree, and each file a page or a chapter. Gives the
  // first path that is not, or null.
  #unsafeIn(plan: HoardRenameV1): string | null {
    const page = (id: string): PageRef | null => {
      try {
        const ref = parseId(id);
        this.inside(ref);
        return ref;
      } catch {
        return null;
      }
    };
    const [from, to] = [page(plan.from), page(plan.to)];
    if (!from) return plan.from;
    if (!to || to.tree !== from.tree) return plan.to;
    const chapter = (rel: string) => CHAPTER.test(rel) && !rel.split('/').includes('..');
    return plan.files.find((rel) => !chapter(rel) && !page(rel)) ?? null;
  }

  // Checks the request and finds the files that hold a link to rewrite. Writes nothing.
  async #plan(from: PageRef, to: PageRef): Promise<HoardRenameV1> {
    const [id, newId] = [idOf(from), idOf(to)];
    let index = await this.#checked();
    // a page that arrived through sync since the last list
    if (!index.has(id) && existsSync(this.file(from))) {
      this.#titles = null;
      index = await this.#index();
    }
    if (!index.has(id)) throw new PageRefused('missing', `${id} is not a page`);
    // a page deleted, say by sync, since the titles were walked
    if (!existsSync(this.file(from))) {
      this.#titles = null;
      throw new PageRefused('missing', `${id} is no longer on disk`);
    }
    const oldTitle = titleOf(from.path);
    const newTitle = checkTitle(to.path);
    const clash = index.taken(to.tree, newTitle, id);
    if (clash) throw new PageRefused('taken', `${JSON.stringify(newTitle)} is already a page in ${to.tree} (${clash.id})`);
    // a file that arrived by sync since the titles were walked; a case-only rename on a
    // case-folding disk finds its own file there, which is no clash
    if (existsSync(this.file(to)) && !sameFile(this.file(from), this.file(to))) {
      throw new PageRefused('taken', `${newId} is already a file on disk`);
    }
    // what a deleted page left under its id would stop the move half way, every time it is retried
    for (const [folder, mine, theirs] of [['.neo/pages', sidecarOf(id), sidecarOf(newId)], ['.neo/marks', marksOf(id), marksOf(newId)]] as const) {
      const [here, there] = [path.join(this.o.library(), ...mine.split('/')), path.join(this.o.library(), ...theirs.split('/'))];
      // #moveFile refuses these too, right before it moves; this is the early refusal, before a note is written
      for (const file of [here, there]) this.#contained(folder, file);
      if (existsSync(there) && !(existsSync(here) && sameFile(here, there))) throw new PageRefused('taken', `${theirs} is left over from an earlier page of that name`);
    }
    const plan: HoardRenameV1 = { version: 1, from: id, to: newId, files: [], at: new Date().toISOString() };
    if (newTitle === oldTitle) return plan;

    // A wiki page takes the links of a source of its title, so a new title the other tree
    // holds would re-point that page's links without anyone asking.
    if (key(newTitle) !== key(oldTitle)) {
      const held = index.taken(to.tree === 'wiki' ? 'sources' : 'wiki', newTitle);
      if (held) throw new PageRefused('other-tree', `${JSON.stringify(newTitle)} is already a page in the other tree (${held.id}), and taking it would move that page's links`);
    }
    // Links reach the page only if it is the one their title resolves to.
    if (index.resolve(oldTitle)?.id !== id) {
      this.o.log('info', 'pages.rename: another page holds this title, so no link is rewritten', { id, holder: index.resolve(oldTitle)?.id });
      return plan;
    }
    const retarget = this.#retarget(oldTitle, newTitle);
    const files: string[] = [];
    for await (const rel of this.#linkFiles()) {
      const html = await readFile(path.join(this.o.library(), rel), 'utf8').catch(() => null);
      if (html === null || !html.includes('[[')) continue;
      const out = rewriteHtml(html, retarget);
      if (out.rewritten) files.push(rel === id ? newId : rel);
      if (out.skipped) this.o.log('warn', `pages.rename: ${out.skipped} link(s) in ${rel} are split by markup, so they are left`, { id });
    }
    plan.files = files.sort();
    return plan;
  }

  #retarget(oldTitle: string, newTitle: string): Retarget {
    const wanted = key(oldTitle);
    return (target) => (key(target) === wanted ? newTitle : null);
  }

  /** Every page file and every chapter file that can hold a link, as paths relative to the library. */
  async *#linkFiles(): AsyncGenerator<string> {
    for await (const page of this.entries()) yield page.id;
    const library = this.o.library();
    const books = await readdir(library, { withFileTypes: true }).catch(() => []);
    for (const book of books.filter((d) => d.isDirectory() && d.name.startsWith('book-')).map((d) => d.name).sort()) {
      let chapters;
      try {
        chapters = await opendir(path.join(library, book, 'chapters'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.o.log('warn', `pages: ${book}/chapters does not list, so its links are not looked at`, String(err));
        continue;
      }
      for await (const d of chapters) if (d.isFile() && d.name.endsWith('.html')) yield `${book}/chapters/${d.name}`;
    }
  }

  // Refuses a file whose path goes through a link that leaves `folder` (a path in the library).
  #contained(folder: string, file: string): void {
    const problem = folderLinkProblem(this.o.library(), folder, file);
    if (problem) throw new PageRefused('unsafe', `${path.relative(this.o.library(), file)} is not a path under ${folder}: ${folderLinkText(problem, folder)}`);
  }

  // The move follows links, so each end is checked against the folder the file belongs to right
  // before it, whether the rename is new or a note left by a stopped one is finished: a link
  // changed since the plan was made must not carry the file out of the library. A refusal leaves
  // the note in place and escalates, so the rename is finished once the link is put right.
  #moveFile(from: string, to: string, folder: string): boolean {
    try {
      this.#contained(folder, from);
      this.#contained(folder, to);
    } catch (err) {
      if (err instanceof PageRefused) this.o.log('error', 'pages.rename: a move goes through a link that leaves its folder, so nothing is moved and the note is kept', { from, to, folder, reason: err.message });
      throw err;
    }
    const [src, dst] = [existsSync(from), existsSync(to)];
    if (!src && dst) return false; // an earlier run moved it
    if (!src) throw new Error(`pages: ${from} is not there to move`);
    if (dst && !sameFile(from, to)) throw new Error(`pages: ${to} is already there, so ${from} is not moved onto it`);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    return true;
  }

  // Carries out a plan, however much of it an earlier run did, and commits it as the author's.
  async #finish(plan: HoardRenameV1, openBookId: string | null, start: number, who: Who = 'author'): Promise<Renamed> {
    const library = this.o.library();
    const own = booksWithOwnRepo(library);
    const there = (rel: string) => existsSync(path.join(library, ...rel.split('/')));
    // The paths the commit names. git refuses a path it has never heard of that is not on
    // disk, so a source already moved by an earlier run, or a sidecar that never was, is left out.
    const named = new Set<string>([plan.to]);
    if (plan.from !== plan.to) {
      if (there(plan.from)) named.add(plan.from);
      if (there(sidecarOf(plan.from))) named.add(sidecarOf(plan.from));
      if (there(sidecarOf(plan.from)) || there(sidecarOf(plan.to))) named.add(sidecarOf(plan.to));
      if (there(marksOf(plan.from))) named.add(marksOf(plan.from));
      if (there(marksOf(plan.from)) || there(marksOf(plan.to))) named.add(marksOf(plan.to));
    }
    for (const rel of plan.files) if (rel === plan.to || there(rel)) named.add(rel);
    // a note left by a stopped run is committed with the writer's pending work first; its removal belongs to this commit
    if (there(JOURNAL)) named.add(JOURNAL);
    if (plan.from !== plan.to) named.add(RECORD);
    const inOwnRepo = (rel: string) => own.some((b) => rel.startsWith(`${b}/`));
    // a move refused part way leaves the page where the index does not have it
    const run = () => this.#execute(plan, openBookId).catch((err: unknown) => { this.#titles = null; throw err; });
    const abs = (rel: string) => path.join(library, ...rel.split('/'));
    const was = readNow(abs(plan.from));
    const result = this.o.layer ? (await this.o.layer.around([...named].filter((rel) => !inOwnRepo(rel)), run, 'author')).result : await run();
    this.#track(plan.from, plan.to);
    // a repeat of a rename an earlier run moved has no old text left to give
    if (plan.from !== plan.to) {
      const now = readNow(abs(plan.to)) ?? '';
      this.#emit({ page: plan.to, from: plan.from, kind: 'rename', who, before: was ?? now, after: now });
    }
    const ms = Math.round(performance.now() - start);
    this.o.log('info', 'pages.rename', {
      from: plan.from, to: plan.to, files: result.rewrittenFiles, links: result.rewrittenLinks, deferred: result.deferred.length, skipped: result.skipped, ms,
    });
    return result;
  }

  /** The renames recorded as finished, oldest first; empty when the record is missing or unreadable. */
  #finished(): { from: string; to: string }[] {
    const file = path.join(this.o.library(), RECORD);
    const text = readNow(file);
    if (text === null) return [];
    try {
      const data: unknown = JSON.parse(text);
      if (Array.isArray(data) && data.every((r) => typeof r?.from === 'string' && typeof r?.to === 'string')) return data as { from: string; to: string }[];
    } catch {
      // logged below
    }
    this.o.log('warn', `pages: ${file} is not a record of renames, so it is started again`);
    return [];
  }

  /** Where the last finished rename of `id` took it, if one is recorded. */
  #lastRenameOf(id: string): string | undefined {
    return this.#finished().findLast((r) => r.from === id)?.to;
  }

  // Moves a renamed page in the index, if one is built.
  #track(from: string, to: string): void {
    if (!this.#titles) return;
    const ref = parseId(to);
    this.#titles.remove(from);
    try {
      const s = statSync(this.file(ref));
      this.#titles.add({ id: to, tree: ref.tree, path: ref.path, title: titleOf(ref.path), size: s.size, mtime: s.mtimeMs });
    } catch (err) {
      this.o.log('warn', `pages: ${to} does not stat after its rename, so the titles are walked again`, String(err));
      this.#titles = null;
    }
  }

  async #execute(plan: HoardRenameV1, openBookId: string | null): Promise<Renamed> {
    const library = this.o.library();
    const abs = (rel: string) => path.join(library, ...rel.split('/'));
    const step = this.o.onStep;
    const result: Renamed = { id: plan.to, from: plan.from, rewrittenFiles: 0, rewrittenLinks: 0, skipped: 0, deferred: [] };
    step?.('journal', JOURNAL);
    writeWhole(abs(JOURNAL), `${JSON.stringify(plan, null, 2)}\n`);
    step?.('move', plan.from);
    if (plan.from !== plan.to && this.#moveFile(abs(plan.from), abs(plan.to), parseId(plan.from).tree)) this.o.log('debug', 'pages.rename: moved', { from: plan.from, to: plan.to });
    const [sideFrom, sideTo] = [abs(sidecarOf(plan.from)), abs(sidecarOf(plan.to))];
    // a page made here, not imported, has no sidecar; one already moved by an earlier run is not there to move
    if (plan.from !== plan.to && existsSync(sideFrom)) {
      step?.('sidecar', sideFrom);
      this.#moveFile(sideFrom, sideTo, '.neo/pages');
    }
    // the page's marks follow it; the same rule as its sidecar, so a run that stopped after either is finished by the next
    const [marksFrom, marksTo] = [abs(marksOf(plan.from)), abs(marksOf(plan.to))];
    if (plan.from !== plan.to && existsSync(marksFrom)) {
      step?.('marks', marksFrom);
      this.#moveFile(marksFrom, marksTo, '.neo/marks');
    }
    const retarget = this.#retarget(titleOf(parseId(plan.from).path), titleOf(parseId(plan.to).path));
    for (const rel of plan.files) {
      const html = await readFile(abs(rel), 'utf8').catch(() => null);
      if (html === null) {
        this.o.log('warn', `pages.rename: ${rel} is gone, so its links are not rewritten`);
        continue;
      }
      const chapter = CHAPTER.exec(rel);
      if (chapter && chapter[1] === openBookId) {
        const edits = editsFor(html, retarget);
        if (edits.length) result.deferred.push({ bookId: chapter[1], chId: chapter[2]!, edits });
        continue;
      }
      const out = rewriteHtml(html, retarget);
      result.skipped += out.skipped;
      if (out.html === html) continue;
      step?.('rewrite', rel);
      // another device, or an editor outside NEO, may have written the file since it was read
      if (readNow(abs(rel)) !== html) {
        this.o.log('warn', 'pages.rename.changed', { file: rel, reason: 'the file changed after the rename read it, so its links are left' });
        continue;
      }
      writeWhole(abs(rel), out.html);
      result.rewrittenFiles++;
      result.rewrittenLinks += out.rewritten;
    }
    if (plan.from !== plan.to) {
      const record = [...this.#finished().filter((r) => r.from !== plan.from), { from: plan.from, to: plan.to }].slice(-RECORD_LENGTH);
      writeWhole(abs(RECORD), `${JSON.stringify(record, null, 2)}\n`);
    }
    rmSync(abs(JOURNAL), { force: true });
    for (const tree of new Set([parseId(plan.from).tree, parseId(plan.to).tree])) this.o.layer?.wrote(tree);
    return result;
  }
}
