// The library's books as search reads them, in the search worker. Each search first
// looks over the library: the books (folders holding a book.json), each one's chapters
// in its order, and a stamp (mtime and size) for every file, so only what changed since
// the last look is read again, whoever changed it (NEO, or a sync from another device,
// which fires no write here). A book or chapter gone is gone from the results.
//
// Nothing is written and nothing is kept on disk: the paragraphs, folded once, live in
// memory for as long as the worker does. An iCloud placeholder (a file with a size but
// no blocks, on a Mac) is never read, since a read can wait on iCloud for ever; it is
// counted, as is a book.json that does not read.
//
// Pages (the HTML files under wiki/ and sources/, listed by the page store) are kept the
// same way, one stamp each, so a search reads only the pages that changed. Pages keep
// their folded text in memory as chapters do; a library of a hundred thousand words of
// pages costs about what a book of that length does.
//
// The open book is left out: the window searches its paragraphs as they stand, which
// can be ahead of its files.
import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import path from 'node:path';
import { paragraphTexts } from '../html.ts';
import { PageStore, type PageEntry } from '../pages/store.ts';
import type { Tree } from '../pages/identity.ts';
import { fold, type Folded } from './fold.ts';
import { searchChapters, type BookHit, type ChapterText, type PageHit, type PageText } from './scan.ts';

type Stat = Awaited<ReturnType<typeof statFile>>;

export interface LibraryQuery {
  text: string;
  /** 'all': the pages and every book; 'pages': the pages of wiki/ and sources/ only. */
  scope: 'all' | 'pages';
  /** The book open in the window, left out. */
  open: string | null;
  limit: number;
  cap: number;
}

export interface BookGroup {
  bookId: string;
  bookTitle: string;
  hits: BookHit[];
  total: number;
}

/** One tree of pages: wiki/ or sources/. */
export interface PageGroup {
  tree: Tree;
  /** 'Wiki' or 'Sources'. */
  title: string;
  hits: PageHit[];
  total: number;
}

export type Group = BookGroup | PageGroup;

export interface LibraryFound {
  groups: Group[];
  total: number;
  capped: boolean;
  /** Files passed over: iCloud placeholders, and book.json files that did not read. */
  cloud: number;
  unreadable: number;
}

export interface IndexStats {
  books: number;
  pages: number;
  chapters: number;
  paragraphs: number;
  /** UTF-16 units of text held. */
  units: number;
  /** Files read by the last look over the library. */
  read: number;
  lookMs: number;
  searchMs: number;
}

interface Chapter extends ChapterText {
  stamp: string;
  folded: Folded[];
}

interface Page extends PageText {
  tree: Tree;
  stamp: string;
  folded: Folded[];
}

interface Book {
  id: string;
  title: string;
  stamp: string;
  order: string[];
  titles: Record<string, string>;
  chapters: Map<string, Chapter>;
}

const TREE_TITLES: Record<Tree, string> = { wiki: 'Wiki', sources: 'Sources' };
const ONE_NAME = /^[^/\\\0]+$/;
const oneName = (name: unknown): name is string => typeof name === 'string' && ONE_NAME.test(name) && name !== '.' && name !== '..';
const stampOf = (s: Stat) => `${s.mtimeMs}:${s.size}`;

export class LibraryIndex {
  readonly #platform: NodeJS.Platform;
  readonly #stat: (file: string) => Promise<Stat>;
  #root = '';
  #books = new Map<string, Book>();
  #pages = new Map<string, Page>();
  readonly #store: PageStore;
  #cloud = 0;
  #unreadable = 0;
  #read = 0;
  #lookMs = 0;
  #searchMs = 0;
  #looking: Promise<void> | null = null;

  constructor(o: { platform?: NodeJS.Platform; stat?: (file: string) => Promise<Stat>; log?: (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void } = {}) {
    this.#platform = o.platform ?? process.platform;
    this.#stat = o.stat ?? ((file) => statFile(file));
    // the store only lists and reads here; it takes its root from the look in progress
    this.#store = new PageStore({ library: () => this.#root, log: o.log ?? (() => {}) });
  }

  // A placeholder iCloud has taken off this Mac: a size, but no blocks on disk.
  #inCloud(s: Stat): boolean {
    return this.#platform === 'darwin' && s.isFile() && s.size > 0 && s.blocks === 0;
  }

  async search(root: string, query: LibraryQuery): Promise<LibraryFound> {
    await this.look(root);
    const start = performance.now();
    const found: LibraryFound = { groups: [], total: 0, capped: false, cloud: this.#cloud, unreadable: this.#unreadable };
    const shown = () => found.groups.reduce((n, g) => n + g.hits.length, 0);
    const room = (): { limit: number; cap: number } | null => {
      const cap = query.cap - found.total;
      if (cap <= 0) {
        found.capped = true;
        return null;
      }
      return { limit: Math.max(0, query.limit - shown()), cap };
    };
    const take = (one: { total: number; capped: boolean }, group: Group | null) => {
      if (one.total && group) found.groups.push(group);
      found.total += one.total;
      if (one.capped) found.capped = true;
    };

    for (const tree of ['wiki', 'sources'] as const) {
      const space = room();
      if (!space) break;
      const pages = [...this.#pages.values()].filter((p) => p.tree === tree).sort((a, b) => (a.page < b.page ? -1 : 1));
      const one = searchChapters(pages, query.text, { ...space, foldOf: (p, pIdx) => p.folded[pIdx]! });
      take(one, { tree, title: TREE_TITLES[tree], hits: one.hits, total: one.total });
    }
    const books = query.scope === 'all'
      ? [...this.#books.values()]
        .filter((b) => b.id !== query.open)
        .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1))
      : [];
    for (const book of books) {
      const space = room();
      if (!space) break;
      const chapters = book.order.map((chId) => book.chapters.get(chId)).filter((c): c is Chapter => !!c);
      const one = searchChapters(chapters, query.text, { ...space, foldOf: (c, pIdx) => c.folded[pIdx]! });
      take(one, { bookId: book.id, bookTitle: book.title, hits: one.hits, total: one.total });
    }
    this.#searchMs = performance.now() - start;
    return found;
  }

  /** The library looked over, reading what changed; a look already running is joined. */
  look(root: string): Promise<void> {
    this.#looking ??= this.#look(root).finally(() => { this.#looking = null; });
    return this.#looking;
  }

  stats(): IndexStats {
    let chapters = 0;
    let paragraphs = 0;
    let units = 0;
    for (const book of this.#books.values()) {
      for (const chapter of book.chapters.values()) {
        chapters++;
        paragraphs += chapter.paragraphs.length;
        for (const p of chapter.paragraphs) units += p.length;
      }
    }
    for (const page of this.#pages.values()) {
      paragraphs += page.paragraphs.length;
      for (const p of page.paragraphs) units += p.length;
    }
    return { books: this.#books.size, pages: this.#pages.size, chapters, paragraphs, units, read: this.#read, lookMs: Math.round(this.#lookMs), searchMs: Math.round(this.#searchMs) };
  }

  async #look(root: string): Promise<void> {
    const start = performance.now();
    if (root !== this.#root) {
      this.#root = root;
      this.#books = new Map();
      this.#pages = new Map();
    }
    this.#cloud = 0;
    this.#unreadable = 0;
    this.#read = 0;
    let names: string[] = [];
    try {
      names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name.startsWith('book-')).map((d) => d.name);
    } catch {
      names = [];
    }
    const seen = new Set<string>();
    await Promise.all(names.map(async (id) => {
      if (await this.#lookAtBook(root, id)) seen.add(id);
    }));
    for (const id of [...this.#books.keys()]) if (!seen.has(id)) this.#books.delete(id);
    await this.#lookAtPages();
    this.#lookMs = performance.now() - start;
  }

  // The page store lists both trees without opening a body; only a page that is new or
  // whose stamp moved is read, and one no longer listed is dropped.
  async #lookAtPages(): Promise<void> {
    const listed = new Set<string>();
    for await (const entry of this.#store.entries()) {
      listed.add(entry.id);
      await this.#lookAtPage(entry);
    }
    for (const id of [...this.#pages.keys()]) if (!listed.has(id)) this.#pages.delete(id);
  }

  async #lookAtPage(entry: PageEntry): Promise<void> {
    const stamp = `${entry.mtime}:${entry.size}`;
    const known = this.#pages.get(entry.id);
    if (known && known.stamp === stamp) return;
    let s: Stat;
    try {
      s = await this.#stat(path.join(this.#root, entry.tree, ...entry.path.split('/')));
    } catch {
      this.#pages.delete(entry.id);
      return;
    }
    if (this.#inCloud(s)) {
      this.#cloud++;
      return;
    }
    const file = await this.#store.read(entry.id).catch(() => null);
    if (!file) {
      this.#pages.delete(entry.id);
      return;
    }
    this.#read++;
    const paragraphs = paragraphTexts(file.html);
    this.#pages.set(entry.id, { page: entry.id, tree: entry.tree, title: entry.title, paragraphs, stamp, folded: paragraphs.map(fold) });
  }

  // true when the book is there to search
  async #lookAtBook(root: string, id: string): Promise<boolean> {
    const dir = path.join(root, id);
    let meta: Stat;
    try {
      meta = await this.#stat(path.join(dir, 'book.json'));
    } catch {
      return false;
    }
    if (this.#inCloud(meta)) {
      this.#cloud++;
      return this.#books.has(id);
    }
    let book = this.#books.get(id);
    if (!book || book.stamp !== stampOf(meta)) {
      try {
        const read = JSON.parse(await readFile(path.join(dir, 'book.json'), 'utf8')) as { title?: unknown; chapterOrder?: unknown; chapterTitles?: unknown };
        this.#read++;
        const order = Array.isArray(read.chapterOrder) ? read.chapterOrder.filter(oneName) : [];
        const titles = read.chapterTitles && typeof read.chapterTitles === 'object' ? read.chapterTitles as Record<string, string> : {};
        book = { id, title: typeof read.title === 'string' ? read.title : id, stamp: stampOf(meta), order, titles, chapters: book?.chapters ?? new Map() };
        this.#books.set(id, book);
      } catch {
        this.#unreadable++;
        this.#books.delete(id);
        return false;
      }
    }
    const current = book;
    const wanted = new Set(current.order);
    for (const chId of [...current.chapters.keys()]) if (!wanted.has(chId)) current.chapters.delete(chId);
    await Promise.all(current.order.map((chId, n) => this.#lookAtChapter(dir, current, chId, n)));
    return true;
  }

  async #lookAtChapter(dir: string, book: Book, chId: string, n: number): Promise<void> {
    const file = path.join(dir, 'chapters', `${chId}.html`);
    const title = typeof book.titles[chId] === 'string' ? book.titles[chId]! : '';
    const label = title || `Chapter ${n + 1}`;
    const known = book.chapters.get(chId);
    let s: Stat;
    try {
      s = await this.#stat(file);
    } catch {
      book.chapters.delete(chId);
      return;
    }
    if (this.#inCloud(s)) {
      this.#cloud++;
      return;
    }
    if (known && known.stamp === stampOf(s)) {
      known.title = title;
      known.label = label;
      return;
    }
    let html: string;
    try {
      html = await readFile(file, 'utf8');
    } catch {
      book.chapters.delete(chId);
      return;
    }
    this.#read++;
    const paragraphs = paragraphTexts(html);
    book.chapters.set(chId, { bookId: book.id, chId, title, label, paragraphs, stamp: stampOf(s), folded: paragraphs.map(fold) });
  }
}
