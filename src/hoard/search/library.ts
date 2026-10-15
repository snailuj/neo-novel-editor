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
// The open book is left out: the window searches its paragraphs as they stand, which
// can be ahead of its files.
import { readdir, readFile, stat as statFile } from 'node:fs/promises';
import path from 'node:path';
import { paragraphTexts } from '../html.ts';
import { fold, type Folded } from './fold.ts';
import { searchChapters, type ChapterText, type Hit } from './scan.ts';

type Stat = Awaited<ReturnType<typeof statFile>>;

export interface LibraryQuery {
  text: string;
  /** 'all': every book; 'wiki': the wiki only. */
  scope: 'all' | 'wiki';
  /** The book open in the window, left out. */
  open: string | null;
  limit: number;
  cap: number;
}

export interface Group {
  bookId: string;
  bookTitle: string;
  wiki: boolean;
  hits: Hit[];
  total: number;
}

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

interface Book {
  id: string;
  title: string;
  stamp: string;
  order: string[];
  titles: Record<string, string>;
  chapters: Map<string, Chapter>;
}

const ONE_NAME = /^[^/\\\0]+$/;
const oneName = (name: unknown): name is string => typeof name === 'string' && ONE_NAME.test(name) && name !== '.' && name !== '..';
const stampOf = (s: Stat) => `${s.mtimeMs}:${s.size}`;

export class LibraryIndex {
  readonly #platform: NodeJS.Platform;
  readonly #stat: (file: string) => Promise<Stat>;
  #root = '';
  #books = new Map<string, Book>();
  #wikiId: string | null = null;
  #cloud = 0;
  #unreadable = 0;
  #read = 0;
  #lookMs = 0;
  #searchMs = 0;
  #looking: Promise<void> | null = null;

  constructor(o: { platform?: NodeJS.Platform; stat?: (file: string) => Promise<Stat> } = {}) {
    this.#platform = o.platform ?? process.platform;
    this.#stat = o.stat ?? ((file) => statFile(file));
  }

  // A placeholder iCloud has taken off this Mac: a size, but no blocks on disk.
  #inCloud(s: Stat): boolean {
    return this.#platform === 'darwin' && s.isFile() && s.size > 0 && s.blocks === 0;
  }

  async search(root: string, query: LibraryQuery): Promise<LibraryFound> {
    await this.look(root);
    const start = performance.now();
    const books = [...this.#books.values()]
      .filter((b) => b.id !== query.open && (query.scope === 'all' || b.id === this.#wikiId))
      .sort((a, b) => Number(b.id === this.#wikiId) - Number(a.id === this.#wikiId) || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
    const found: LibraryFound = { groups: [], total: 0, capped: false, cloud: this.#cloud, unreadable: this.#unreadable };
    for (const book of books) {
      const limit = Math.max(0, query.limit - found.groups.reduce((n, g) => n + g.hits.length, 0));
      const cap = query.cap - found.total;
      if (cap <= 0) {
        found.capped = true;
        break;
      }
      const chapters = book.order.map((chId) => book.chapters.get(chId)).filter((c): c is Chapter => !!c);
      const one = searchChapters(chapters, query.text, { limit, cap, foldOf: (c, pIdx) => (c as Chapter).folded[pIdx]! });
      if (one.total) found.groups.push({ bookId: book.id, bookTitle: book.title, wiki: book.id === this.#wikiId, hits: one.hits, total: one.total });
      found.total += one.total;
      if (one.capped) found.capped = true;
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
    return { books: this.#books.size, chapters, paragraphs, units, read: this.#read, lookMs: Math.round(this.#lookMs), searchMs: Math.round(this.#searchMs) };
  }

  async #look(root: string): Promise<void> {
    const start = performance.now();
    if (root !== this.#root) {
      this.#root = root;
      this.#books = new Map();
    }
    this.#cloud = 0;
    this.#unreadable = 0;
    this.#read = 0;
    this.#wikiId = await this.#readWikiId(root);
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
    this.#lookMs = performance.now() - start;
  }

  async #readWikiId(root: string): Promise<string | null> {
    try {
      const wiki = JSON.parse(await readFile(path.join(root, '.neo', 'wiki.json'), 'utf8')) as { bookId?: unknown };
      return oneName(wiki.bookId) ? wiki.bookId : null;
    } catch {
      return null;
    }
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
