// The librarian's watcher on the main side: hoard's companion, driven by the chapters the
// writer leaves instead of by polling files. The window hands over a chapter's HTML as it
// was when the writer came to it and as last saved; the paragraphs that are new are
// searched for the pages of both trees (wiki/ and sources/, listed by the page store) by
// bare name (mentions.ts), and each page the chapter has not been told about yet gets
// one librarian comment on its first mention. The chapter's own findings are the record
// of what it has been told (finding.ts), so a page is flagged once per chapter, however
// its comment was answered.
//
// Pages the writer asked the librarian to stop flagging are kept in .neo/companion.json
// by their page id (`wiki/People/Name.html`). A file there that does not read is
// reported and never taken for empty, which would flag every quiet page again (hoard's
// rule); nothing writes over it until it is mended. The librarian never touches the writer's words: it only adds marks.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HoardCompanionV1 } from '../../generated/hoard-companion-v1.js';
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { validateHoardCompanionV1, validateHoardPageV1 } from '../../generated/validators.cjs';
import { isMapping } from '../../librarian/frontmatter.ts';
import { key } from '../../librarian/links.ts';
import { oneName, writeWhole } from '../files.ts';
import { paragraphTexts } from '../html.ts';
import { anchorAt } from '../marks/anchor.ts';
import { newMark } from '../marks/model.ts';
import { MarkFileError, type MarkStore, pageSidecarPath, sidecarPath } from '../marks/store.ts';
import { parseId, titleOf, TREES, type Tree } from '../pages/identity.ts';
import { newParagraphs } from './delta.ts';
import { findingWords, reported } from './finding.ts';
import { mentionsIn, type WikiPage } from './mentions.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface CompanionOptions {
  library: () => string;
  marks: MarkStore;
  /** The page store, or anything that lists pages as it does; reads no page body. */
  pages: PageSource;
  now?: () => Date;
  /** Milliseconds, for the page listing's age; Date.now unless a test sets it. */
  clock?: () => number;
  newId?: () => string;
  head?: () => Promise<string | null>;
  wrote?: (name: string) => void;
  log: (level: Level, message: string, data?: unknown) => void;
}

export interface PageSource {
  list(): Promise<{ id: string; tree: Tree; title: string }[]>;
}

/** What the writer left: a chapter of a book, or a stored page by its id. */
export type ReadRequest = ({ bookId: string; chId: string; page?: never } | { page: string; bookId?: never; chId?: never }) & {
  before: string;
  after: string;
  /** Where the caret is, when the writer is still in the chapter: a name it is in or just after is left alone. */
  caret?: { pIdx: number; off: number } | null;
};

export class CompanionFileError extends Error {
  constructor(file: string, why: string) {
    super(`${file} cannot be read as the librarian's quiet pages (${why}); it is left as it is until it is mended`);
    this.name = 'CompanionFileError';
  }
}

const stampOf = (file: string): string => {
  try {
    const s = statSync(file);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return '';
  }
};

// A listing of the pages is trusted while the folders it came from keep the times they had,
// but never for longer than this: a folder that was empty then is not one of them, and a
// page dropped into it moves no time the companion looks at.
const LISTING_TTL_MS = 60_000;
// A folder changed this close to the scan may have changed again within one tick of a
// coarse file clock, so the scan that saw it is not trusted.
const RACY_MS = 2_000;

type Listed = { id: string; tree: Tree; title: string };

const randomId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

export class Companion {
  readonly #o: CompanionOptions;
  readonly #queues = new Map<string, Promise<unknown>>();
  // each page sidecar's frontmatter, read again only when its stamp changes
  readonly #meta = new Map<string, { stamp: string; aliases: string[]; pantsing: boolean }>();
  readonly #skipped = new Set<string>();
  // a chapter's marks file that did not read, by its stamp then, so it is not read (and
  // logged) again at every save until it changes
  readonly #broken = new Map<string, string>();
  // The last listing of the pages and the times of the folders holding them, so a chapter
  // save with no page change walks neither tree again; null until the first read.
  #listing: { pages: Listed[]; at: number; folders: Map<string, string> | null } | null = null;

  constructor(options: CompanionOptions) {
    this.#o = options;
  }

  get #file(): string {
    return path.join(this.#o.library(), '.neo', 'companion.json');
  }

  /** Reads a chapter or a stored page the writer has left and comments on the pages its new words name. */
  async read(req: ReadRequest): Promise<{ added: number }> {
    let name: string;
    if (req.page !== undefined) {
      parseId(req.page);
      name = req.page;
    } else {
      oneName(req.bookId, 'bookId');
      oneName(req.chId, 'chId');
      name = `${req.bookId}/${req.chId}`;
    }
    // one chapter or page at a time, so two reads never flag one page twice
    const before = this.#queues.get(name) ?? Promise.resolve();
    const next = before.then(() => this.#read(req), () => this.#read(req));
    const settled = next.catch(() => {});
    this.#queues.set(name, settled);
    settled.then(() => { if (this.#queues.get(name) === settled) this.#queues.delete(name); }, () => {});
    return next;
  }

  async #read(req: ReadRequest): Promise<{ added: number }> {
    const { before, after, caret } = req;
    const started = Date.now();
    const [subject, sidecar] = req.page !== undefined
      ? [{ page: req.page }, pageSidecarPath(this.#o.library(), req.page)]
      : [{ bookId: req.bookId, chId: req.chId }, sidecarPath(this.#o.library(), req.bookId, req.chId)];
    const paragraphs = paragraphTexts(after);
    const fresh = newParagraphs(paragraphTexts(before), paragraphs);
    if (fresh.length === 0) return { added: 0 };
    const pages = await this.#pages();
    const quiet = this.#quiet().quiet;
    const found = mentionsIn(paragraphs, fresh, pages.filter((p) => !Object.hasOwn(quiet, p.id) && p.id !== req.page), (title) => {
      if (this.#skipped.has(title)) return;
      this.#skipped.add(title);
      this.#o.log('warn', `companion: the page "${title}" starts or ends with a hyphen or space, so it cannot be found by name`);
    }).filter((m) => !caret || m.pIdx !== caret.pIdx || caret.off < m.off || caret.off > m.off + m.len);
    if (found.length === 0) return { added: 0 };
    if (this.#broken.has(sidecar) && this.#broken.get(sidecar) === stampOf(sidecar)) return { added: 0 };
    let existing: Mark[];
    try {
      existing = req.page !== undefined ? await this.#o.marks.list(req.page) : await this.#o.marks.chapter(req.bookId, req.chId);
      this.#broken.delete(sidecar);
    } catch (err) {
      if (!(err instanceof MarkFileError)) throw err;
      this.#broken.set(sidecar, stampOf(sidecar));
      this.#o.log('warn', 'companion: the marks file does not read, so no finding is added until it changes', subject);
      return { added: 0 };
    }
    const told = reported(existing, pages);
    const commit = this.#o.head ? await this.#o.head() : null;
    const at = (this.#o.now?.() ?? new Date()).toISOString();
    const made: Mark[] = found.filter((m) => !told.has(m.page.id)).map((m) => newMark({
      id: (this.#o.newId ?? randomId)(),
      kind: 'comment',
      anchor: anchorAt(paragraphs, m, commit),
      body: findingWords(m),
      who: 'librarian',
      at,
    }));
    if (req.page !== undefined) await this.#o.marks.addAll(req.page, made);
    else await this.#o.marks.addAll(req.bookId, req.chId, made);
    this.#o.log('info', 'companion.read', {
      ...subject, paragraphs: fresh.length, mentions: found.length, added: made.length, ms: Date.now() - started,
    });
    return { added: made.length };
  }

  /** Stop Flagging This Page, or Flag This Page Again; answers the quiet pages' ids. */
  quiet(page: string, quiet: boolean): { quiet: string[] } {
    if (typeof page !== 'string' || page === '') throw new TypeError(`page must be a page id: ${JSON.stringify(page)}`);
    const data = this.#quiet();
    if (quiet) {
      const title = this.#titleOf(page);
      data.quiet[page] = { title, at: (this.#o.now?.() ?? new Date()).toISOString() };
    } else {
      delete data.quiet[page];
    }
    if (!validateHoardCompanionV1(data)) throw new TypeError(`companion: refusing to write ${JSON.stringify(validateHoardCompanionV1.errors)}`);
    writeWhole(this.#file, `${JSON.stringify(data, null, 2)}\n`);
    this.#o.wrote?.('.neo');
    this.#o.log('info', 'companion.quiet', { page, quiet });
    return { quiet: Object.keys(data.quiet) };
  }

  /** The quiet pages' ids. */
  state(): { quiet: string[] } {
    return { quiet: Object.keys(this.#quiet().quiet) };
  }

  // The title of a page that exists, or a RangeError. One stat, no listing.
  #titleOf(id: string): string {
    let ref;
    try {
      ref = parseId(id);
    } catch {
      throw new RangeError(`${JSON.stringify(id)} is not a page id`);
    }
    try {
      if (statSync(path.join(this.#o.library(), ref.tree, ...ref.path.split('/'))).isFile()) return titleOf(ref.path);
    } catch { /* absent: refused below */ }
    throw new RangeError(`no page ${id}`);
  }

  #quiet(): HoardCompanionV1 {
    const file = this.#file;
    if (!existsSync(file)) return { version: 1, quiet: {} };
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw this.#unreadable(file, err instanceof Error ? err.message : String(err));
    }
    if (!validateHoardCompanionV1(data)) {
      throw this.#unreadable(file, (validateHoardCompanionV1.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; '));
    }
    return data;
  }

  #unreadable(file: string, why: string): CompanionFileError {
    const err = new CompanionFileError(file, why);
    this.#o.log('error', `companion: ${err.message}`, { file });
    return err;
  }

  // The pages of both trees, wiki first, with the aliases and draft status their sidecars give
  // them. A wiki page wins a name over a source (as a link does): a source whose title is a
  // wiki page's title or alias is left out, and mentions.ts keeps the first holder of any
  // other name, which is the wiki's. This is done before the quiet pages are dropped, so
  // quieting a wiki page does not hand its name to the source.
  async #pages(): Promise<WikiPage[]> {
    const listed = await this.#listed();
    const rank = (tree: Tree) => (tree === 'wiki' ? 0 : 1);
    const pages = [...listed]
      .sort((a, b) => rank(a.tree) - rank(b.tree) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id, tree, title }) => ({ tree, page: { id, title, ...this.#frontmatter(id) } }));
    const taken = new Set<string>();
    for (const { tree, page } of pages) if (tree === 'wiki') for (const name of [page.title, ...page.aliases]) taken.add(key(name));
    return pages.filter(({ tree, page }) => tree === 'wiki' || !taken.has(key(page.title))).map(({ page }) => page);
  }

  // Pages are added, renamed and removed only in folders, so a folder whose time has not
  // moved holds the same pages. Every folder on the way to a listed page is checked, the
  // two trees' roots even when absent. Page bodies and sidecars are not in this: only a
  // page's id and title are used.
  async #listed(): Promise<Listed[]> {
    const now = this.#o.clock ?? Date.now;
    const kept = this.#listing;
    if (kept && kept.folders && now() - kept.at < LISTING_TTL_MS && this.#sameFolders(kept.folders)) return kept.pages;
    const at = now();
    const pages = await this.#o.pages.list();
    const folders = this.#folders(pages);
    const recent = [...folders.values()].some((stamp) => Number(stamp) > Date.now() - RACY_MS);
    this.#listing = { pages, at, folders: recent ? null : folders };
    return pages;
  }

  #folders(pages: Listed[]): Map<string, string> {
    const names = new Set<string>(TREES);
    for (const { id } of pages) {
      for (let slash = id.indexOf('/', id.indexOf('/') + 1); slash >= 0; slash = id.indexOf('/', slash + 1)) names.add(id.slice(0, slash));
    }
    return new Map([...names].map((name) => [name, this.#folderStamp(name)]));
  }

  #folderStamp(name: string): string {
    try {
      return String(statSync(path.join(this.#o.library(), ...name.split('/'))).mtimeMs);
    } catch {
      return 'absent';
    }
  }

  #sameFolders(folders: Map<string, string>): boolean {
    for (const [name, stamp] of folders) if (this.#folderStamp(name) !== stamp) return false;
    return true;
  }

  #frontmatter(id: string): { aliases: string[]; pantsing: boolean } {
    const file = path.join(this.#o.library(), '.neo', 'pages', ...`${id}.json`.split('/'));
    let stamp = '';
    try {
      const s = statSync(file);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      return { aliases: [], pantsing: false };
    }
    const known = this.#meta.get(file);
    if (known && known.stamp === stamp) return known;
    let meta = { stamp, aliases: [] as string[], pantsing: false };
    try {
      const page = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (validateHoardPageV1(page) && isMapping(page.frontmatter)) {
        const fm = page.frontmatter as Record<string, unknown>;
        meta = { stamp, aliases: strings(fm['aliases']), pantsing: fm['draft_status'] === 'pantsing' };
      }
    } catch (err) {
      this.#o.log('warn', 'companion: a page sidecar does not read, so its page has no aliases', { file, why: String(err) });
    }
    this.#meta.set(file, meta);
    return meta;
  }
}
