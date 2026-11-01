// Pages as files, on the main side. The library has two folders at its root, wiki/ and
// sources/, and a page is one .html file in either (subfolders allowed); its title is
// its file name without .html. This store sits BESIDE wiki/store.ts, which still serves
// the Wiki book: nothing reads from here yet but the channels in pages/main.ts.
//
// A listing walks the folders and stats each file, never opening a body, so a library of
// thousands of pages costs a walk. A write lands only while the file still holds what the
// caller read (the rule wiki/write.ts keeps), so a change that arrived from another device
// is never written over. Every refusal is logged; every request names its page by an id
// that identity.ts has checked, so no path leaves its tree.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { opendir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateHoardRenameV1 } from '../../generated/validators.cjs';
import type { HoardRenameV1 } from '../../generated/hoard-rename-v1.js';
import { key } from '../../librarian/links.ts';
import { booksWithOwnRepo } from '../git/commit.ts';
import type { GitLayer } from '../git/layer.ts';
import { writeWhole } from '../files.ts';
import { checkPath, idOf, PageRefused, parseId, titleOf, TREES, type PageRef, type Tree } from './identity.ts';
import { editsFor, rewriteHtml, type Retarget, type WindowEdit } from './rewrite.ts';
import { Titles } from './titles.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface PageStoreOptions {
  library: () => string;
  /** Takes writes into the library's history; absent, pages are written without it. */
  layer?: Pick<GitLayer, 'around' | 'wrote'>;
  log: (level: Level, message: string, data?: unknown) => void;
  /** Told before each step of a rename, so a test can stop it part way; the step may throw. */
  onStep?: (step: 'journal' | 'move' | 'sidecar' | 'rewrite', file: string) => void;
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

// A title becomes the target of a [[link]], which the grammar ends at ] | # or ^.
const UNLINKABLE = /[[\]|#^\p{Cc}]/u;

export class PageStore {
  protected readonly o: PageStoreOptions;
  #tail: Promise<unknown> = Promise.resolve();
  // Built on first use and kept by create and rename; list() builds it again, since pages
  // also arrive through sync. Null until then, or after a rename failed part way.
  #titles: Titles<PageEntry> | null = null;

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
    let root: string;
    try {
      root = realpathSync(path.join(this.o.library(), ref.tree));
    } catch {
      return file; // no tree yet, so nothing in it can lead out
    }
    const refuse = (why: string) => new PageRefused('unsafe', `${idOf(ref)} is not a page path: ${why}`);
    for (let probe = file; ; probe = path.dirname(probe)) {
      let real: string;
      try {
        real = realpathSync(probe);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
        if (lstatSync(probe, { throwIfNoEntry: false })) throw refuse('it goes through a link that leads nowhere');
        continue;
      }
      if (real !== root && !real.startsWith(root + path.sep)) throw refuse('a link in it leads out of its tree');
      return file;
    }
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
    for (const tree of TREES) yield* this.#walk(tree, '');
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

  async list(): Promise<PageEntry[]> {
    const start = performance.now();
    const pages = await this.#scan();
    this.#titles = new Titles(pages);
    for (const group of this.#titles.duplicates) this.o.log('warn', 'pages: these pages share one title, so a link reaches only the first', group.map((p) => p.id));
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

  write(id: string, before: string, after: string): Promise<Written> {
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
      return { ok: true };
    }));
  }

  /** Refuses a title no link could name; the title is the file name without .html. */
  protected checkTitle(p: string): string {
    const title = titleOf(p);
    if (title.trim() === '' || title !== title.trim() || UNLINKABLE.test(title)) {
      throw new PageRefused('title', `${JSON.stringify(title)} cannot be a page title: it is empty, has spaces at an end, or holds one of [ ] | # ^`);
    }
    return title;
  }

  create(tree: Tree, pagePath: string, html: string): Promise<PageEntry> {
    return this.#serial(() => this.op('create', async () => {
      const ref = parseId(`${tree}/${checkPath(pagePath)}`);
      const title = this.checkTitle(ref.path);
      this.inside(ref);
      const index = await this.#index();
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
      return made;
    }));
  }

  // Writes, creates and renames run one at a time: each reads the library the last one
  // left, so a write cannot land between a rename's read of a file and its rewrite.
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run);
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
  rename(id: string, newPath: string, openBookId: string | null): Promise<Renamed> {
    return this.#serial(() => this.op('rename', async () => this.#forgetOnFailure(async () => {
      const start = performance.now();
      const from = parseId(id);
      const to = parseId(`${from.tree}/${checkPath(newPath)}`);
      this.inside(from);
      this.inside(to);
      const pending = await this.#journal();
      if (pending) {
        const finished = await this.#finish(pending, openBookId, start);
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
      return this.#finish(await this.#plan(from, to), openBookId, start);
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
      if (validateHoardRenameV1(data)) return data;
      this.o.log('error', `pages: ${file} is not a rename note, so no rename is finished`, validateHoardRenameV1.errors);
    } catch (err) {
      this.o.log('error', `pages: ${file} does not parse, so no rename is finished`, String(err));
    }
    return null;
  }

  // Checks the request and finds the files that hold a link to rewrite. Writes nothing.
  async #plan(from: PageRef, to: PageRef): Promise<HoardRenameV1> {
    const [id, newId] = [idOf(from), idOf(to)];
    let index = await this.#index();
    // a page that arrived through sync since the last list
    if (!index.has(id) && existsSync(this.file(from))) {
      this.#titles = null;
      index = await this.#index();
    }
    if (!index.has(id)) throw new PageRefused('missing', `${id} is not a page`);
    const oldTitle = titleOf(from.path);
    const newTitle = this.checkTitle(to.path);
    const clash = index.taken(to.tree, newTitle, id);
    if (clash) throw new PageRefused('taken', `${JSON.stringify(newTitle)} is already a page in ${to.tree} (${clash.id})`);
    // a file that arrived by sync since the titles were walked; a case-only rename on a
    // case-folding disk finds its own file there, which is no clash
    if (existsSync(this.file(to)) && !sameFile(this.file(from), this.file(to))) {
      throw new PageRefused('taken', `${newId} is already a file on disk`);
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

  #moveFile(from: string, to: string): boolean {
    const [src, dst] = [existsSync(from), existsSync(to)];
    if (!src && dst) return false; // an earlier run moved it
    if (!src) throw new Error(`pages: ${from} is not there to move`);
    if (dst && !sameFile(from, to)) throw new Error(`pages: ${to} is already there, so ${from} is not moved onto it`);
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    return true;
  }

  // Carries out a plan, however much of it an earlier run did, and commits it as the author's.
  async #finish(plan: HoardRenameV1, openBookId: string | null, start: number): Promise<Renamed> {
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
    }
    for (const rel of plan.files) if (rel === plan.to || there(rel)) named.add(rel);
    // a note left by a stopped run is committed with the writer's pending work first; its removal belongs to this commit
    if (there(JOURNAL)) named.add(JOURNAL);
    if (plan.from !== plan.to) named.add(RECORD);
    const inOwnRepo = (rel: string) => own.some((b) => rel.startsWith(`${b}/`));
    const run = () => this.#execute(plan, openBookId);
    const result = this.o.layer ? (await this.o.layer.around([...named].filter((rel) => !inOwnRepo(rel)), run, 'author')).result : await run();
    this.#track(plan.from, plan.to);
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
    if (plan.from !== plan.to && this.#moveFile(abs(plan.from), abs(plan.to))) this.o.log('debug', 'pages.rename: moved', { from: plan.from, to: plan.to });
    const [sideFrom, sideTo] = [abs(sidecarOf(plan.from)), abs(sidecarOf(plan.to))];
    // a page made here, not imported, has no sidecar; one already moved by an earlier run is not there to move
    if (plan.from !== plan.to && existsSync(sideFrom)) {
      step?.('sidecar', sideFrom);
      this.#moveFile(sideFrom, sideTo);
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
