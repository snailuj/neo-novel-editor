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
// A page's source that changed since it came in updates the page in place only while
// NEO has not changed the page (its chapter file still hashes as the import left it),
// and every mark on it stays. When NEO has changed it too, the new source comes in as
// the next page, as NEO does with a chapter changed on two devices, and later imports
// follow that newest page. Words written in NEO are never written over.
//
// A pick is a file, or an import list's entry (import-list.ts): a page with a name of
// its own, or sections of a page joined into one (a split). A page an old vault gave
// hoard, by hoard's own manifest, comes in with hoard's pages instead, so it is not
// imported twice. A page's images and PDFs are copied into the wiki book.
//
// The same store makes and fills another book, by title (Morning Pages, say), when an
// import list sends pages there: such a book is named in .neo/books/<slug>.json instead,
// and is on no shelf either. A list's line range (`L12-L40`) cuts those lines of the
// whole file, counted from 1, and is refused when the file no longer has the hash the
// list was made against.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardChangeV1 } from '../../generated/hoard-change-v1.js';
import type { Mark } from '../../generated/hoard-marks-v1.js';
import type { HoardPageV1 } from '../../generated/hoard-page-v1.js';
import type { HoardWikiV1 } from '../../generated/hoard-wiki-v1.js';
import { validateHoardChangeV1, validateHoardPageV1, validateHoardWikiV1 } from '../../generated/validators.cjs';
import { split } from '../../librarian/frontmatter.ts';
import { key } from '../../librarian/links.ts';
import { appendRecord, parseManifest, serialiseRecord } from '../../librarian/manifest.ts';
import { oneName, writeJson, writeWhole } from '../files.ts';
import { anchorAt, anchorPoint } from '../marks/anchor.ts';
import { newMark } from '../marks/model.ts';
import type { MarkStore } from '../marks/store.ts';
import { ownerOf } from '../review/owner.ts';
import { AttachmentFinder, attachmentsIn, copyAttachment } from './attachments.ts';
import { convertPage, pageHtml, type Block, type ConvertedPage } from './convert.ts';
import { HoardIndex, hoardRoot, vaultRoot } from './hoard-manifest.ts';
import { lineRange } from './import-list.ts';
import { inline } from './inline.ts';
import { section } from './sections.ts';

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
  /** The book this store fills, by title; the wiki when not given. */
  book?: string;
}

/**
 * A file to import, or an import list's entry: a name of its own, or one section of it
 * (a heading, or a line range with the start of the hash the file had then).
 */
export interface Pick { path: string; name?: string | null; section?: string | null; sha?: string | null }

interface Picked { path: string; name: string; sections: string[]; sha: string | null }
/** An attachment a page names, and the file found for it. */
export interface Found { target: string; file: string }
interface Converted { sha256: string; page: ConvertedPage; attachments: Found[]; missing: string[] }
export type Verdict =
  | Picked & Converted & { kind: 'new' }
  | Picked & Converted & { kind: 'update' | 'beside'; chId: string }
  | Picked & { kind: 'same' | 'clash' | 'through-hoard' | 'hoard-older' }
  | Picked & { kind: 'unreadable'; why: string };

export interface Sorted { verdicts: Verdict[]; picks?: Pick[] }

export interface Applied {
  bookId: string | null;
  imported: { chId: string; name: string }[];
  updated: { chId: string; name: string }[];
  marks: number;
  keptAsText: number;
  /** Attachments copied into the wiki book. */
  attachments: number;
  /** Attachments a page names that its vault does not hold. */
  missing: string[];
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
const pickKey = (p: { path: string; sections: string[] }) => [samePath(p.path), ...p.sections].join('\n');
const byName = (a: Picked, b: Picked) => {
  const [ka, kb] = [key(a.name), key(b.name)];
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
};

/** A book title as a folder name's part: `Morning Pages` is `morning-pages`. */
export function bookSlug(title: string): string {
  const slug = title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return slug || 'book';
}

/**
 * The name of a book's file in .neo/books: its slug and the start of its title's hash,
 * so two titles that slug alike (`Notes!` and `Notes?`, or two in a script the slug
 * drops) never share a book.
 */
export function bookFileName(title: string): string {
  return `${bookSlug(title)}-${createHash('sha256').update(key(title)).digest('hex').slice(0, 8)}`;
}

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

  /** The book's title: Wiki, or the one an import list sends pages to. */
  get title(): string {
    return this.#o.book ?? 'Wiki';
  }

  // The file that names the book: wiki.json for the wiki, else one in .neo/books.
  #wikiFile(): string {
    if (this.#o.book === undefined) return path.join(this.#library, '.neo', 'wiki.json');
    return path.join(this.#library, '.neo', 'books', `${bookFileName(this.#o.book)}.json`);
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

  // Each page already in the wiki: the newest page for each source (path and sections),
  // every title and source name (by link key), and hoard's roots, found from its pages.
  #known(): { bySource: Map<string, { chId: string; title: string; sha256: string; imported: string }>; names: Set<string>; hoards: Set<string> } {
    const bySource = new Map<string, { chId: string; title: string; sha256: string; imported: string }>();
    const names = new Set<string>();
    const hoards = new Set<string>();
    const wiki = this.pages();
    if (!wiki) return { bySource, names, hoards };
    const rootOf = new Map<string, string | null>();
    for (const { chId, title } of wiki.pages) {
      names.add(key(title));
      const file = this.#pageFile(wiki.bookId, chId);
      if (!existsSync(file)) continue;
      try {
        const page = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (!validateHoardPageV1(page)) continue;
        const k = pickKey({ path: page.source.path, sections: page.source.sections ?? [] });
        const was = bySource.get(k);
        if (!was || was.imported <= page.imported) bySource.set(k, { chId, title, sha256: page.source.sha256, imported: page.imported });
        names.add(key(page.source.name));
        const dir = path.dirname(page.source.path);
        if (!rootOf.has(dir)) rootOf.set(dir, hoardRoot(page.source.path));
        const root = rootOf.get(dir);
        if (root) hoards.add(root);
      } catch (err) {
        this.#o.log('warn', `wiki: the page sidecar ${file} does not read`, String(err));
      }
    }
    return { bySource, names, hoards };
  }

  // The hash each chapter file had when an import last wrote it, from the manifest.
  #written(): Map<string, string> {
    const file = path.join(this.#library, '.neo', 'manifest.jsonl');
    const written = new Map<string, string>();
    if (!existsSync(file)) return written;
    try {
      for (const r of parseManifest(readFileSync(file, 'utf8'))) if (typeof r.file_sha256 === 'string') written.set(r.dest, r.file_sha256);
    } catch (err) {
      // Then no page counts as untouched, and a changed source comes in beside its page.
      this.#o.log('warn', 'wiki: the manifest does not read, so no page counts as untouched', String(err));
    }
    return written;
  }

  // True while NEO has not changed the page since an import wrote it.
  #untouched(bookId: string, chId: string, written: Map<string, string>): boolean {
    const was = written.get(`${bookId}/chapters/${chId}.html`);
    const file = path.join(this.#library, bookId, 'chapters', `${chId}.html`);
    return was !== undefined && existsSync(file) && sha256(readFileSync(file)) === was;
  }

  // Each file once, or each list entry's sections joined into the page it names.
  #picked(picks: readonly (string | Pick)[]): Picked[] {
    const picked: Picked[] = [];
    const whole = new Set<string>();
    const parts = new Map<string, Picked>();
    for (const raw of picks) {
      const pick: Pick = typeof raw === 'string' ? { path: raw } : raw;
      const name = pick.name || nameOf(pick.path);
      if (pick.section) {
        const k = `${samePath(pick.path)}\n${key(name)}`;
        const into = parts.get(k);
        if (into) {
          if (!into.sections.includes(pick.section)) into.sections.push(pick.section);
          into.sha ??= pick.sha ?? null;
          continue;
        }
        const p = { path: pick.path, name, sections: [pick.section], sha: pick.sha ?? null };
        parts.set(k, p);
        picked.push(p);
        continue;
      }
      if (whole.has(samePath(pick.path))) continue;
      whole.add(samePath(pick.path));
      picked.push({ path: pick.path, name, sections: [], sha: null });
    }
    return picked.sort(byName);
  }

  // The Markdown a pick brings in: the page, or its sections or line ranges joined,
  // without the frontmatter of the page they were cut from.
  #converted(p: Picked, bytes: Buffer, finders: Map<string, AttachmentFinder>): Converted | { why: string } {
    let text = bytes.toString('utf8');
    if (p.sha && !sha256(bytes).startsWith(p.sha)) return { why: 'it changed after the list was made, so its lines may have moved' };
    if (p.sections.length) {
      const whole = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
      // a file's last newline ends its last line and starts none
      const lines = whole.replace(/\n$/, '').split('\n');
      let body: string;
      try {
        ({ body } = split(whole));
      } catch (err) {
        return { why: err instanceof Error ? err.message : String(err) };
      }
      const cut: string[] = [];
      for (const heading of p.sections) {
        const range = lineRange(heading);
        if (range) {
          if (range.end > lines.length) return { why: `it has only ${lines.length} lines, not ${range.end}` };
          cut.push(lines.slice(range.start - 1, range.end).join('\n').replace(/\s+$/, ''));
          continue;
        }
        const part = section(body, heading);
        if (part === null) return { why: `it has no heading \u201c${heading}\u201d` };
        cut.push(part);
      }
      text = `${cut.join('\n\n')}\n`;
    }
    let page: ConvertedPage;
    try {
      page = convertPage(text, () => this.#id('b'));
    } catch (err) {
      return { why: err instanceof Error ? err.message : String(err) };
    }
    const root = vaultRoot(p.path) ?? path.dirname(path.resolve(p.path));
    let finder = finders.get(root);
    if (!finder) finders.set(root, finder = new AttachmentFinder(root));
    const attachments: Found[] = [];
    const missing: string[] = [];
    for (const target of attachmentsIn(text)) {
      const file = finder.find(target, p.path);
      if (file) attachments.push({ target, file });
      else missing.push(target);
    }
    return { sha256: sha256(bytes), page, attachments, missing };
  }

  /** What importing these files or list entries would do. Reads; never writes. */
  sort(picks: readonly (string | Pick)[]): Sorted {
    const { bySource, names, hoards } = this.#known();
    const hoard = hoards.size ? HoardIndex.read(hoards, this.#o.log) : null;
    const written = this.#written();
    const bookId = this.wikiId();
    const finders = new Map<string, AttachmentFinder>();
    const day = this.#now().slice(0, 10);
    const verdicts = this.#picked(picks).map((p): Verdict => {
      let bytes: Buffer;
      try {
        bytes = readFileSync(p.path);
      } catch (err) {
        return { ...p, kind: 'unreadable', why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'the file is not there' : String(err) };
      }
      const known = bySource.get(pickKey(p));
      if (known && known.sha256 === sha256(bytes)) return { ...p, name: known.title, kind: 'same' };
      if (!known && !p.sections.length) {
        const held = hoard?.verdict(p.path, sha256(bytes));
        if (held) return { ...p, kind: held };
      }
      if (!known && names.has(key(p.name))) return { ...p, kind: 'clash' };
      const made = this.#converted(p, bytes, finders);
      if ('why' in made) return { ...p, kind: 'unreadable', why: made.why };
      if (!known) {
        names.add(key(p.name));
        return { ...p, ...made, kind: 'new' };
      }
      if (bookId && this.#untouched(bookId, known.chId, written)) return { ...p, ...made, name: known.title, kind: 'update', chId: known.chId };
      let name = `${p.name} (source changed ${day})`;
      for (let n = 2; names.has(key(name)); n++) name = `${p.name} (source changed ${day}, ${n})`;
      names.add(key(name));
      return { ...p, ...made, name, kind: 'beside', chId: known.chId };
    });
    return { verdicts, picks: [...picks].map((x) => (typeof x === 'string' ? { path: x } : x)) };
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
    type Act = Extract<Verdict, { kind: 'new' | 'update' | 'beside' }>;
    const acts = (v: Verdict): v is Act => v.kind === 'new' || v.kind === 'update' || v.kind === 'beside';
    const wanted = new Set(sorted.verdicts.filter(acts).map(pickKey));
    const fresh = this.sort(sorted.picks ?? sorted.verdicts.filter(acts).map((v) => ({ path: v.path })));
    const pages = fresh.verdicts.filter(acts).filter((v) => wanted.has(pickKey(v)));
    let bookId = this.wikiId();
    const applied: Applied = { bookId, imported: [], updated: [], marks: 0, keptAsText: 0, attachments: 0, missing: [] };
    if (pages.length === 0) return applied;
    if (bookId !== null && bookId === openBookId) {
      throw new Error(`${this.title === 'Wiki' ? 'The wiki' : this.title} is open, so nothing was imported. Go back to the shelf and import again.`);
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
    const chIds = pages.map((p) => (p.kind === 'update' ? p.chId : this.#id('ch')));
    const chapterFile = (chId: string) => path.join(this.#library, bookId!, 'chapters', `${oneName(chId, 'chId')}.html`);
    if (this.#o.commit) {
      pages.forEach((page, n) => {
        const theirs = ownerOf(page.page.frontmatter) === 'author';
        writeWhole(chapterFile(chIds[n]!), theirs ? page.page.html : pageHtml(page.page.blocks, 'author'));
      });
      await this.#o.commit('author');
    }
    const existing = pages.some((p) => p.kind === 'update') ? (await this.#o.marks.list(bookId)).chapters : {};
    const changes: HoardChangeV1[] = [];
    const missing = new Set<string>();
    const made: { chId: string; name: string; after: string | null }[] = [];
    for (const [n, page] of pages.entries()) {
      const chId = chIds[n]!;
      const dest = `${bookId}/chapters/${chId}.html`;
      writeWhole(chapterFile(chId), page.page.html);
      const sidecar: HoardPageV1 = {
        version: 1,
        source: { path: page.path, name: page.name, sha256: page.sha256, ...(page.sections.length ? { sections: page.sections as [string, ...string[]] } : {}) },
        frontmatter: page.page.frontmatter,
        imported: at,
      };
      if (!validateHoardPageV1(sidecar)) throw new TypeError(`wiki: refusing to write a page sidecar: ${JSON.stringify(validateHoardPageV1.errors)}`);
      writeWhole(this.#pageFile(bookId, chId), `${JSON.stringify(sidecar, null, 2)}\n`);
      // An update keeps every mark there and adds only the source's marks it lacks.
      const had = existing[chId] ?? [];
      const sameMark = (a: Mark, b: Mark) => a.kind === b.kind && a.anchor.exact === b.anchor.exact
        && a.proposed === b.proposed && a.thread[0]?.body === b.thread[0]?.body;
      const marks = this.#marks(page.page, base, at).filter((m) => !had.some((h) => sameMark(h, m)));
      await this.#o.marks.addAll(bookId, chId, marks);
      applied.marks += marks.length;
      applied.keptAsText += page.page.keptAsText;
      for (const found of page.attachments) {
        const copy = copyAttachment(this.#library, bookId, found.file);
        records = appendRecord(records, {
          src: found.file, dest: copy.dest, method: 'verbatim', src_sha256: copy.sha256, file_sha256: copy.sha256, ingested_at: at,
        }).records;
        if (!copy.copied) continue;
        applied.attachments++;
        changes.push({ version: 1, at, kind: 'attachment-imported', bookId, chId, dest: copy.dest, src: found.file });
      }
      for (const target of page.missing) missing.add(target);
      records = appendRecord(records, {
        src: page.path, dest, method: page.sections.length ? 'split' : 'converted', src_sha256: page.sha256, file_sha256: sha256(page.page.html), ingested_at: at,
      }).records;
      changes.push({ version: 1, at, kind: page.kind === 'update' ? 'page-updated' : 'page-imported', bookId, chId, dest, src: page.path });
      if (page.kind === 'update') applied.updated.push({ chId, name: page.name });
      else made.push({ chId, name: page.name, after: page.kind === 'beside' ? page.chId : null });
    }

    if (made.length) {
      const book = this.#readBook(bookId);
      const order = [...book.chapterOrder];
      for (const m of made) {
        // A page that came in beside another goes after it, and after any beside it already.
        let i = m.after === null ? -1 : order.indexOf(m.after);
        if (i < 0) {
          order.push(m.chId);
          continue;
        }
        while (i + 1 < order.length && made.some((x) => x.chId === order[i + 1] && x.after === m.after)) i++;
        order.splice(i + 1, 0, m.chId);
      }
      book.chapterOrder = order;
      book.chapterTitles = { ...book.chapterTitles, ...Object.fromEntries(made.map((m) => [m.chId, m.name])) };
      book.chapterKinds = { ...book.chapterKinds, ...Object.fromEntries(made.map((m) => [m.chId, 'unnumbered'])) };
      book['modified'] = at;
      writeJson(this.#bookFile(bookId), book);
    }

    writeWhole(manifestFile, records.map(serialiseRecord).join(''));
    for (const c of changes) if (!validateHoardChangeV1(c)) throw new TypeError(`wiki: refusing to log a change: ${JSON.stringify(validateHoardChangeV1.errors)}`);
    const separator = changesBefore && !changesBefore.endsWith('\n') ? '\n' : '';
    writeWhole(changesFile, changesBefore + separator + changes.map((c) => `${JSON.stringify(c)}\n`).join(''));

    applied.imported = made.map(({ chId, name }) => ({ chId, name }));
    applied.missing = [...missing];
    this.#o.log('info', 'wiki.import', {
      bookId, pages: made.length, updated: applied.updated.length, marks: applied.marks, keptAsText: applied.keptAsText,
      attachments: applied.attachments, missing: applied.missing.length,
    });
    this.#o.wrote?.(bookId);
    this.#o.wrote?.('.neo');
    await this.#o.commit?.('librarian');
    return applied;
  }

  /**
   * A page the librarian makes, as ripple's mint does: each paragraph a plain block, the
   * page after the wiki's last, and a page sidecar whose source names what made it
   * (`origin`, such as a ripple proposal). Writes the chapter and the sidecar, then
   * book.json, so a crash between leaves a file NEO never lists. Refuses while the wiki is
   * the open book, before the first import, and for a title a page or alias holds.
   * Returns the new chapter and every file it wrote, relative to the library.
   */
  mint(page: { title: string; paragraphs: readonly string[]; frontmatter: Record<string, unknown>; origin: string }, openBookId: string | null): { bookId: string; chId: string; files: string[] } {
    const bookId = this.wikiId();
    if (!bookId) throw new Error('There is no wiki yet: import pages first.');
    if (bookId === openBookId) throw new Error('The wiki is open. Go back to the shelf or to another book first.');
    const title = page.title.trim();
    if (!title) throw new RangeError('a new page needs a title');
    if (this.#known().names.has(key(title))) throw new RangeError(`a page called ${title} is already in the wiki`);
    const blocks: Block[] = page.paragraphs.map((p) => p.trim()).filter(Boolean).map((p) => {
      const { text, html } = inline(p);
      return { kind: 'p', id: this.#id('b'), owner: 'librarian', text, inner: html, data: [] };
    });
    const html = pageHtml(blocks);
    const chId = this.#id('ch');
    const at = this.#now();
    const chapterRel = `${bookId}/chapters/${oneName(chId, 'chId')}.html`;
    const sidecarRel = `.neo/${bookId}/pages/${chId}.json`;
    writeWhole(path.join(this.#library, chapterRel), html);
    const sidecar: HoardPageV1 = {
      version: 1, source: { path: page.origin, name: title, sha256: sha256(html) }, frontmatter: page.frontmatter, imported: at,
    };
    if (!validateHoardPageV1(sidecar)) throw new TypeError(`wiki: refusing to write a page sidecar: ${JSON.stringify(validateHoardPageV1.errors)}`);
    writeWhole(this.#pageFile(bookId, chId), `${JSON.stringify(sidecar, null, 2)}\n`);
    const book = this.#readBook(bookId);
    book.chapterOrder = [...book.chapterOrder, chId];
    book.chapterTitles = { ...book.chapterTitles, [chId]: title };
    book.chapterKinds = { ...book.chapterKinds, [chId]: 'unnumbered' };
    book['modified'] = at;
    writeJson(this.#bookFile(bookId), book);
    this.#o.log('info', 'wiki.mint', { bookId, chId, origin: page.origin });
    this.#o.wrote?.(bookId);
    this.#o.wrote?.('.neo');
    return { bookId, chId, files: [chapterRel, sidecarRel, `${bookId}/book.json`] };
  }

  // The book, made as NEO's own book:create makes a book, and named in wiki.json (or its
  // file in .neo/books).
  #makeWiki(): string {
    const now = this.#o.now?.() ?? new Date();
    const bookId = `book-${bookSlug(this.title)}-${now.getTime().toString(36)}-${randomBytes(4).toString('hex').slice(0, 5)}`;
    const dir = path.join(this.#library, bookId);
    const at = now.toISOString();
    writeJson(path.join(dir, 'book.json'), {
      id: bookId, title: this.title, subtitle: '', series: '', author: this.#authorName(), wordGoal: 0,
      created: at, modified: at, chapterOrder: [], tabNames: { notes: 'Notes', outline: 'Outline' },
    });
    writeWhole(path.join(dir, 'notes.html'), '');
    writeWhole(path.join(dir, 'outline.html'), '');
    writeJson(path.join(dir, 'darlings.json'), []);
    writeJson(path.join(dir, 'stickies.json'), []);
    const wiki: HoardWikiV1 = { version: 1, bookId };
    writeWhole(this.#wikiFile(), `${JSON.stringify(wiki, null, 2)}\n`);
    this.#o.log('info', 'wiki.made', { bookId, title: this.title });
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
