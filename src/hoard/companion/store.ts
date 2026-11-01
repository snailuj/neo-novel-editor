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
// by their page id (`wiki/People/Name.html`); a key that is not one, left by the Wiki
// book's chapter ids, is ignored and logged once. A file there that does not read is
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
import { MarkFileError, type MarkStore, sidecarPath } from '../marks/store.ts';
import { parseId, titleOf, type Tree } from '../pages/identity.ts';
import { newParagraphs } from './delta.ts';
import { findingWords, reported } from './finding.ts';
import { mentionsIn, type WikiPage } from './mentions.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface CompanionOptions {
  library: () => string;
  marks: MarkStore;
  /** The page store, or anything that lists pages as it does; reads no page body. */
  pages: PageSource;
  /** The Wiki book's id while it exists; its chapters are pages already and are not read. */
  wikiBook: () => string | null;
  now?: () => Date;
  newId?: () => string;
  head?: () => Promise<string | null>;
  wrote?: (name: string) => void;
  log: (level: Level, message: string, data?: unknown) => void;
}

export interface PageSource {
  list(): Promise<{ id: string; tree: Tree; title: string }[]>;
}

export interface ReadRequest {
  bookId: string;
  chId: string;
  before: string;
  after: string;
  /** Where the caret is, when the writer is still in the chapter: a name it is in or just after is left alone. */
  caret?: { pIdx: number; off: number } | null;
}

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

const randomId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

export class Companion {
  readonly #o: CompanionOptions;
  readonly #queues = new Map<string, Promise<unknown>>();
  // each page sidecar's frontmatter, read again only when its stamp changes
  readonly #meta = new Map<string, { stamp: string; aliases: string[]; pantsing: boolean }>();
  readonly #skipped = new Set<string>();
  // quiet keys that are not page ids, logged once each
  readonly #stale = new Set<string>();
  // a chapter's marks file that did not read, by its stamp then, so it is not read (and
  // logged) again at every save until it changes
  readonly #broken = new Map<string, string>();

  constructor(options: CompanionOptions) {
    this.#o = options;
  }

  get #file(): string {
    return path.join(this.#o.library(), '.neo', 'companion.json');
  }

  /** Reads a chapter the writer has left and comments on the pages its new words name. */
  async read(req: ReadRequest): Promise<{ added: number }> {
    oneName(req.bookId, 'bookId');
    oneName(req.chId, 'chId');
    // one chapter at a time, so two reads never flag one page twice
    const name = `${req.bookId}/${req.chId}`;
    const before = this.#queues.get(name) ?? Promise.resolve();
    const next = before.then(() => this.#read(req), () => this.#read(req));
    const settled = next.catch(() => {});
    this.#queues.set(name, settled);
    settled.then(() => { if (this.#queues.get(name) === settled) this.#queues.delete(name); }, () => {});
    return next;
  }

  async #read({ bookId, chId, before, after, caret }: ReadRequest): Promise<{ added: number }> {
    const started = Date.now();
    if (bookId === this.#o.wikiBook()) return { added: 0 };
    const paragraphs = paragraphTexts(after);
    const fresh = newParagraphs(paragraphTexts(before), paragraphs);
    if (fresh.length === 0) return { added: 0 };
    const pages = await this.#pages();
    const quiet = this.#quiet().quiet;
    const found = mentionsIn(paragraphs, fresh, pages.filter((p) => !Object.hasOwn(quiet, p.id)), (title) => {
      if (this.#skipped.has(title)) return;
      this.#skipped.add(title);
      this.#o.log('warn', `companion: the page "${title}" starts or ends with a hyphen or space, so it cannot be found by name`);
    }).filter((m) => !caret || m.pIdx !== caret.pIdx || caret.off < m.off || caret.off > m.off + m.len);
    if (found.length === 0) return { added: 0 };
    const sidecar = sidecarPath(this.#o.library(), bookId, chId);
    if (this.#broken.has(sidecar) && this.#broken.get(sidecar) === stampOf(sidecar)) return { added: 0 };
    let existing: Mark[];
    try {
      existing = await this.#o.marks.chapter(bookId, chId);
      this.#broken.delete(sidecar);
    } catch (err) {
      if (!(err instanceof MarkFileError)) throw err;
      this.#broken.set(sidecar, stampOf(sidecar));
      this.#o.log('warn', 'companion: the chapter\'s marks file does not read, so no finding is added until it changes', { bookId, chId });
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
    await this.#o.marks.addAll(bookId, chId, made);
    this.#o.log('info', 'companion.read', {
      bookId, chId, paragraphs: fresh.length, mentions: found.length, added: made.length, ms: Date.now() - started,
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
    // a key left by the chapter-id scheme names no page: dropped here, so the next write drops it from the file
    const quiet: HoardCompanionV1['quiet'] = {};
    for (const [id, entry] of Object.entries(data.quiet)) {
      try {
        parseId(id);
        quiet[id] = entry;
      } catch {
        if (!this.#stale.has(id)) {
          this.#stale.add(id);
          this.#o.log('warn', `companion: the quiet key "${id}" is not a page id, so it is ignored`, { file });
        }
      }
    }
    return { version: 1, quiet };
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
    const listed = await this.#o.pages.list();
    const rank = (tree: Tree) => (tree === 'wiki' ? 0 : 1);
    const pages = [...listed]
      .sort((a, b) => rank(a.tree) - rank(b.tree) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(({ id, tree, title }) => ({ tree, page: { id, title, ...this.#frontmatter(id) } }));
    const taken = new Set<string>();
    for (const { tree, page } of pages) if (tree === 'wiki') for (const name of [page.title, ...page.aliases]) taken.add(key(name));
    return pages.filter(({ tree, page }) => tree === 'wiki' || !taken.has(key(page.title))).map(({ page }) => page);
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
