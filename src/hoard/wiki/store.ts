// The wiki on the main side: one NEO book whose chapters are the wiki's pages, made by
// the first import and named in .neo/wiki.json. It is on no shelf, because only the
// window writes library.json; Plugins > Edit Wiki as a Book opens it, and the wiki pane
// (wiki/pane.ts) reads single pages beside another book.
//
// An import first sorts the picked files (sort), which reads but never writes, so the
// writer can be told what would happen. Applying it sorts the files again, in case they
// changed meanwhile, and writes in an order a crash cannot hurt: the chapter files and
// their sidecars, then book.json, then the manifest and the change log. Until book.json
// names a chapter NEO never sees it; once it does, the page sidecar says where it came
// from, so the next import knows it. Nothing is written into the wiki's book.json while
// the wiki is open, because the window writes its own copy of it whole.
//
// With history kept, an import is two commits, so blame credits each paragraph to whoever
// owns it: first the author's, holding what they wrote meanwhile, the whole of each page
// that is theirs (review/owner.ts, the rule suggest mode follows) and only the quotations
// and code of the librarian's pages (convert.ts), then the librarian's, with the rest.
//
// A page's source that changed since it came in is never written over: the page may
// hold words written in NEO since. It is listed instead.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardChangeV1 } from '../../generated/hoard-change-v1.js';
import type { Mark } from '../../generated/hoard-marks-v1.js';
import type { HoardPageV1 } from '../../generated/hoard-page-v1.js';
import type { HoardWikiV1 } from '../../generated/hoard-wiki-v1.js';
import { validateHoardChangeV1, validateHoardPageV1, validateHoardWikiV1 } from '../../generated/validators.cjs';
import { key } from '../../librarian/links.ts';
import { appendRecord, parseManifest, serialiseRecord, type ManifestRecordV1 } from '../../librarian/manifest.ts';
import { oneName, writeJson, writeWhole } from '../files.ts';
import { anchorAt, anchorPoint } from '../marks/anchor.ts';
import { newMark } from '../marks/model.ts';
import type { MarkStore } from '../marks/store.ts';
import { ownerOf } from '../review/owner.ts';
import { convertPage, pageHtml, type ConvertedPage } from './convert.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface WikiStoreOptions {
  library: () => string;
  marks: MarkStore;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** The library's last commit, or null; marks made by an import carry it. */
  head?: () => Promise<string | null>;
  /** Told after the writes, so the library's history takes them. */
  wrote?: (name: string) => void;
  /** Commits the library as it stands, as the author's or the librarian's; resolves once it has landed. */
  commit?: (part: 'author' | 'librarian') => Promise<void>;
  log: (level: Level, message: string, data?: unknown) => void;
}

interface Picked { path: string; name: string }
export type Verdict =
  | Picked & { kind: 'new'; sha256: string; page: ConvertedPage }
  | Picked & { kind: 'same' | 'changed' | 'clash' }
  | Picked & { kind: 'unreadable'; why: string };

export interface Sorted { verdicts: Verdict[] }

export interface Applied {
  bookId: string | null;
  imported: { chId: string; name: string }[];
  marks: number;
  keptAsText: number;
}

export interface WikiPages {
  bookId: string;
  pages: { chId: string; title: string }[];
}

interface Book {
  id: string;
  chapterOrder: string[];
  chapterTitles?: Record<string, string>;
  chapterKinds?: Record<string, string>;
  [field: string]: unknown;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const nameOf = (file: string) => path.basename(file).replace(/\.md$/i, '');
// Paths compare as the file system does: without case on Windows.
const samePath = (file: string) => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));
const byName = (a: Picked, b: Picked) => {
  const [ka, kb] = [key(a.name), key(b.name)];
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
};

function randomChapterId(): string {
  return `ch-${Date.now().toString(36)}-${randomBytes(3).toString('hex').slice(0, 4)}`;
}

export class WikiStore {
  readonly #o: WikiStoreOptions;
  #running = false;

  constructor(options: WikiStoreOptions) {
    this.#o = options;
  }

  get #library(): string {
    return this.#o.library();
  }

  #wikiFile(): string {
    return path.join(this.#library, '.neo', 'wiki.json');
  }

  #bookFile(bookId: string): string {
    return path.join(this.#library, oneName(bookId, 'bookId'), 'book.json');
  }

  #pageFile(bookId: string, chId: string): string {
    return path.join(this.#library, '.neo', oneName(bookId, 'bookId'), 'pages', `${oneName(chId, 'chId')}.json`);
  }

  /** The wiki book's id, or null before the first import or once its folder is gone. */
  wikiId(): string | null {
    const file = this.#wikiFile();
    if (!existsSync(file)) return null;
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      this.#o.log('error', `wiki: ${file} does not read, so no wiki is known: ${String(err)}`);
      return null;
    }
    if (!validateHoardWikiV1(data)) {
      this.#o.log('error', `wiki: ${file} is not a wiki file`, validateHoardWikiV1.errors);
      return null;
    }
    return existsSync(this.#bookFile(data.bookId)) ? data.bookId : null;
  }

  #readBook(bookId: string): Book {
    return JSON.parse(readFileSync(this.#bookFile(bookId), 'utf8')) as Book;
  }

  /** The wiki's pages in order, with the titles book.json gives them. */
  pages(): WikiPages | null {
    const bookId = this.wikiId();
    if (!bookId) return null;
    const book = this.#readBook(bookId);
    const titles = book.chapterTitles ?? {};
    return { bookId, pages: book.chapterOrder.map((chId) => ({ chId, title: titles[chId] ?? '' })) };
  }

  /** One page as its chapter file holds it, for the wiki pane; null for a page the wiki does not list. */
  page(chId: string): { bookId: string; chId: string; title: string; html: string } | null {
    oneName(chId, 'chId');
    const wiki = this.pages();
    const listed = wiki?.pages.find((p) => p.chId === chId);
    if (!wiki || !listed) return null;
    const html = readFileSync(path.join(this.#library, wiki.bookId, 'chapters', `${chId}.html`), 'utf8');
    return { bookId: wiki.bookId, chId, title: listed.title, html };
  }

  // Each page already in the wiki: its source (by path) and its title (by link key).
  #known(): { bySource: Map<string, string>; names: Set<string> } {
    const bySource = new Map<string, string>();
    const names = new Set<string>();
    const wiki = this.pages();
    if (!wiki) return { bySource, names };
    for (const { chId, title } of wiki.pages) {
      names.add(key(title));
      const file = this.#pageFile(wiki.bookId, chId);
      if (!existsSync(file)) continue;
      try {
        const page = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (validateHoardPageV1(page)) {
          bySource.set(samePath(page.source.path), page.source.sha256);
          names.add(key(page.source.name));
        }
      } catch (err) {
        this.#o.log('warn', `wiki: the page sidecar ${file} does not read`, String(err));
      }
    }
    return { bySource, names };
  }

  /** What importing these files would do. Reads; never writes. */
  sort(files: readonly string[]): Sorted {
    const { bySource, names } = this.#known();
    const seen = new Set<string>();
    const picked: Picked[] = [];
    for (const file of files) {
      if (seen.has(samePath(file))) continue;
      seen.add(samePath(file));
      picked.push({ path: file, name: nameOf(file) });
    }
    picked.sort(byName);
    const verdicts = picked.map((p): Verdict => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(p.path);
      } catch (err) {
        return { ...p, kind: 'unreadable', why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'the file is not there' : String(err) };
      }
      const sha = sha256(bytes);
      const was = bySource.get(samePath(p.path));
      if (was !== undefined) return { ...p, kind: was === sha ? 'same' : 'changed' };
      if (names.has(key(p.name))) return { ...p, kind: 'clash' };
      let page: ConvertedPage;
      try {
        page = convertPage(bytes.toString('utf8'), () => this.#id('b'));
      } catch (err) {
        return { ...p, kind: 'unreadable', why: err instanceof Error ? err.message : String(err) };
      }
      names.add(key(p.name));
      return { ...p, kind: 'new', sha256: sha, page };
    });
    return { verdicts };
  }

  /**
   * Imports the new pages of a sort, sorting them again first. Refuses while the wiki is
   * the book open in the window, and while another import runs.
   */
  async apply(sorted: Sorted, openBookId: string | null): Promise<Applied> {
    if (this.#running) throw new Error('An import is already running.');
    this.#running = true;
    try {
      return await this.#apply(sorted, openBookId);
    } finally {
      this.#running = false;
    }
  }

  async #apply(sorted: Sorted, openBookId: string | null): Promise<Applied> {
    const fresh = this.sort(sorted.verdicts.filter((v) => v.kind === 'new').map((v) => v.path));
    const pages = fresh.verdicts.filter((v): v is Extract<Verdict, { kind: 'new' }> => v.kind === 'new');
    let bookId = this.wikiId();
    const applied: Applied = { bookId, imported: [], marks: 0, keptAsText: 0 };
    if (pages.length === 0) return applied;
    if (bookId !== null && bookId === openBookId) {
      throw new Error('The wiki is open, so nothing was imported. Go back to the shelf and import again.');
    }
    const neo = path.join(this.#library, '.neo');
    const manifestFile = path.join(neo, 'manifest.jsonl');
    const changesFile = path.join(neo, 'changes.jsonl');
    let records = existsSync(manifestFile) ? parseManifest(readFileSync(manifestFile, 'utf8')) : [];
    const changesBefore = existsSync(changesFile) ? readFileSync(changesFile, 'utf8') : '';
    const base = this.#o.head ? await this.#o.head() : null;

    bookId ??= this.#makeWiki();
    applied.bookId = bookId;
    const at = this.#now();
    const chIds = pages.map(() => this.#id('ch'));
    const chapterFile = (chId: string) => path.join(this.#library, bookId!, 'chapters', `${oneName(chId, 'chId')}.html`);
    if (this.#o.commit) {
      pages.forEach((page, n) => {
        const theirs = ownerOf(page.page.frontmatter) === 'author';
        writeWhole(chapterFile(chIds[n]!), theirs ? page.page.html : pageHtml(page.page.blocks, 'author'));
      });
      await this.#o.commit('author');
    }
    const made: { chId: string; name: string; dest: string; src: string; srcSha: string; fileSha: string }[] = [];
    for (const [n, page] of pages.entries()) {
      const chId = chIds[n]!;
      const dest = `${bookId}/chapters/${chId}.html`;
      writeWhole(chapterFile(chId), page.page.html);
      const sidecar: HoardPageV1 = {
        version: 1, source: { path: page.path, name: page.name, sha256: page.sha256 }, frontmatter: page.page.frontmatter, imported: at,
      };
      if (!validateHoardPageV1(sidecar)) throw new TypeError(`wiki: refusing to write a page sidecar: ${JSON.stringify(validateHoardPageV1.errors)}`);
      writeWhole(this.#pageFile(bookId, chId), `${JSON.stringify(sidecar, null, 2)}\n`);
      const marks = this.#marks(page.page, base, at);
      await this.#o.marks.addAll(bookId, chId, marks);
      applied.marks += marks.length;
      applied.keptAsText += page.page.keptAsText;
      made.push({ chId, name: page.name, dest, src: page.path, srcSha: page.sha256, fileSha: sha256(page.page.html) });
    }

    const book = this.#readBook(bookId);
    book.chapterOrder = [...book.chapterOrder, ...made.map((m) => m.chId)];
    book.chapterTitles = { ...book.chapterTitles, ...Object.fromEntries(made.map((m) => [m.chId, m.name])) };
    book.chapterKinds = { ...book.chapterKinds, ...Object.fromEntries(made.map((m) => [m.chId, 'unnumbered'])) };
    book['modified'] = at;
    writeJson(this.#bookFile(bookId), book);

    for (const m of made) {
      const record: ManifestRecordV1 = {
        src: m.src, dest: m.dest, method: 'converted', src_sha256: m.srcSha, file_sha256: m.fileSha, ingested_at: at,
      };
      records = appendRecord(records, record).records;
    }
    writeWhole(manifestFile, records.map(serialiseRecord).join(''));
    const changes = made.map((m): HoardChangeV1 => ({ version: 1, at, kind: 'page-imported', bookId: bookId!, chId: m.chId, dest: m.dest, src: m.src }));
    for (const c of changes) if (!validateHoardChangeV1(c)) throw new TypeError(`wiki: refusing to log a change: ${JSON.stringify(validateHoardChangeV1.errors)}`);
    const separator = changesBefore && !changesBefore.endsWith('\n') ? '\n' : '';
    writeWhole(changesFile, changesBefore + separator + changes.map((c) => `${JSON.stringify(c)}\n`).join(''));

    applied.imported = made.map(({ chId, name }) => ({ chId, name }));
    this.#o.log('info', 'wiki.import', { bookId, pages: made.length, marks: applied.marks, keptAsText: applied.keptAsText });
    this.#o.wrote?.(bookId);
    this.#o.wrote?.('.neo');
    await this.#o.commit?.('librarian');
    return applied;
  }

  // The wiki book, made as NEO's own book:create makes a book, and named in wiki.json.
  #makeWiki(): string {
    const now = this.#o.now?.() ?? new Date();
    const bookId = `book-wiki-${now.getTime().toString(36)}-${randomBytes(4).toString('hex').slice(0, 5)}`;
    const dir = path.join(this.#library, bookId);
    const at = now.toISOString();
    writeJson(path.join(dir, 'book.json'), {
      id: bookId, title: 'Wiki', subtitle: '', series: '', author: this.#authorName(), wordGoal: 0,
      created: at, modified: at, chapterOrder: [], tabNames: { notes: 'Notes', outline: 'Outline' },
    });
    writeWhole(path.join(dir, 'notes.html'), '');
    writeWhole(path.join(dir, 'outline.html'), '');
    writeJson(path.join(dir, 'darlings.json'), []);
    writeJson(path.join(dir, 'stickies.json'), []);
    const wiki: HoardWikiV1 = { version: 1, bookId };
    writeWhole(this.#wikiFile(), `${JSON.stringify(wiki, null, 2)}\n`);
    this.#o.log('info', 'wiki.made', { bookId });
    return bookId;
  }

  // The writer's name as the library knows it; NEO's own default when it gives none.
  #authorName(): string {
    try {
      const library = JSON.parse(readFileSync(path.join(this.#library, 'library.json'), 'utf8')) as {
        authors?: { id?: string; name?: string }[]; currentAuthorId?: string; authorName?: string;
      };
      const current = library.authors?.find((a) => a.id === library.currentAuthorId) ?? library.authors?.[0];
      return current?.name || library.authorName || 'Anonymous';
    } catch {
      return 'Anonymous';
    }
  }

  #marks(page: ConvertedPage, commit: string | null, at: string): Mark[] {
    return page.marks.map((m) => newMark({
      id: this.#id('m'),
      kind: m.kind,
      anchor: m.kind === 'insertion'
        ? anchorPoint(page.paragraphs, { pIdx: m.pIdx, off: m.off }, commit)
        : anchorAt(page.paragraphs, { pIdx: m.pIdx, off: m.off, len: m.len }, commit),
      body: m.body,
      proposed: m.proposed,
      who: m.who,
      at: m.at ?? at,
    }));
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  #id(prefix: string): string {
    if (this.#o.newId) return this.#o.newId(prefix);
    if (prefix === 'ch') return randomChapterId();
    // a block's id is short, as Obsidian's are, since a citation carries it
    if (prefix === 'b') return randomBytes(4).toString('hex').slice(0, 6);
    return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex').slice(0, 6)}`;
  }
}
