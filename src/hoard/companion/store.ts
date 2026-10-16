// The librarian's watcher on the main side: hoard's companion, driven by the chapters the
// writer leaves instead of by polling files. The window hands over a chapter's HTML as it
// was when the writer came to it and as last saved; the paragraphs that are new are
// searched for the wiki's pages by bare name (mentions.ts), and each page the chapter has
// not been told about yet gets one librarian comment on its first mention. The chapter's
// own findings are the record of what it has been told (finding.ts), so a page is
// flagged once per chapter, however its comment was answered.
//
// Pages the writer asked the librarian to stop flagging are kept in .neo/companion.json
// by their chapter id. A file there that does not read is reported and never taken for
// empty, which would flag every quiet page again (hoard's rule); nothing writes over it
// until it is mended. The librarian never touches the writer's words: it only adds marks.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { HoardCompanionV1 } from '../../generated/hoard-companion-v1.js';
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { validateHoardCompanionV1, validateHoardPageV1 } from '../../generated/validators.cjs';
import { isMapping } from '../../librarian/frontmatter.ts';
import { oneName, writeWhole } from '../files.ts';
import { paragraphTexts } from '../html.ts';
import { anchorAt } from '../marks/anchor.ts';
import { newMark } from '../marks/model.ts';
import type { MarkStore } from '../marks/store.ts';
import type { WikiPages } from '../wiki/store.ts';
import { newParagraphs } from './delta.ts';
import { findingWords, reported } from './finding.ts';
import { mentionsIn, type WikiPage } from './mentions.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface CompanionOptions {
  library: () => string;
  marks: MarkStore;
  wiki: () => WikiPages | null;
  now?: () => Date;
  newId?: () => string;
  head?: () => Promise<string | null>;
  wrote?: (name: string) => void;
  log: (level: Level, message: string, data?: unknown) => void;
}

export interface ReadRequest { bookId: string; chId: string; before: string; after: string }

export class CompanionFileError extends Error {
  constructor(file: string, why: string) {
    super(`${file} cannot be read as the librarian's quiet pages (${why}); it is left as it is until it is mended`);
    this.name = 'CompanionFileError';
  }
}

const randomId = () => `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const strings = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

export class Companion {
  readonly #o: CompanionOptions;
  readonly #queues = new Map<string, Promise<unknown>>();
  // each page sidecar's frontmatter, read again only when its stamp changes
  readonly #meta = new Map<string, { stamp: string; aliases: string[]; pantsing: boolean }>();
  readonly #skipped = new Set<string>();

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

  async #read({ bookId, chId, before, after }: ReadRequest): Promise<{ added: number }> {
    const started = Date.now();
    const wiki = this.#o.wiki();
    if (!wiki || bookId === wiki.bookId) return { added: 0 };
    const paragraphs = paragraphTexts(after);
    const fresh = newParagraphs(paragraphTexts(before), paragraphs);
    if (fresh.length === 0) return { added: 0 };
    const pages = this.#pages(wiki);
    const quiet = this.#quiet().quiet;
    const found = mentionsIn(paragraphs, fresh, pages.filter((p) => !(p.id in quiet)), (title) => {
      if (this.#skipped.has(title)) return;
      this.#skipped.add(title);
      this.#o.log('warn', `companion: the page "${title}" starts or ends with a hyphen or space, so it cannot be found by name`);
    });
    if (found.length === 0) return { added: 0 };
    const listed = await this.#o.marks.list(bookId);
    if (listed.unreadable.includes(chId)) {
      this.#o.log('warn', 'companion: the chapter\'s marks file does not read, so no finding is added', { bookId, chId });
      return { added: 0 };
    }
    const told = reported(listed.chapters[chId] ?? [], pages);
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
    oneName(page, 'page');
    const data = this.#quiet();
    if (quiet) {
      const title = this.#o.wiki()?.pages.find((p) => p.chId === page)?.title;
      if (title === undefined) throw new RangeError(`no wiki page ${page}`);
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

  // The wiki's pages, with the aliases and draft status their frontmatter gives them.
  #pages(wiki: WikiPages): WikiPage[] {
    return wiki.pages.map(({ chId, title }) => ({ id: chId, title, ...this.#frontmatter(wiki.bookId, chId) }));
  }

  #frontmatter(bookId: string, chId: string): { aliases: string[]; pantsing: boolean } {
    const file = path.join(this.#o.library(), '.neo', bookId, 'pages', `${chId}.json`);
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
