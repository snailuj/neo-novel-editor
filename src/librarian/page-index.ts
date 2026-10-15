// Wikilink resolution the way Obsidian does it, from hoard's lint.py: by basename or
// path, case-folded, and never by alias. Aliases are indexed apart, so lint can report a
// link only an alias would answer (LK1) and relink can repair it.
import { FrontmatterError, isMapping, split } from './frontmatter.ts';
import type { Frontmatter } from './frontmatter.ts';
import { key } from './links.ts';
import { getLogger } from './log.ts';
import { pyStrip } from './py.ts';
import { type Layout, type Scheme, startsWithAny } from './scheme.ts';
import type { Note } from './vault.ts';

const log = getLogger('librarian.lint');

function stem(relpath: string): string {
  const name = relpath.slice(relpath.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/** A resolvable link target: where it lives and who speaks in it. */
export class Page {
  readonly relpath: string;
  readonly fm: Frontmatter;
  constructor(relpath: string, fm: Frontmatter = {}) {
    this.relpath = relpath;
    this.fm = fm;
  }

  /** The basename without `.md`, as a finding names the page. */
  get name(): string {
    return stem(this.relpath);
  }

  /**
   * CS1 expects a speaker in four zones only: the author's sources and writing and the
   * librarian's pages. A link into a daily note, the inbox or infra is left alone.
   */
  judged(layout: Layout): boolean {
    return startsWithAny(this.relpath, [...layout.authorBodyDirs, ...layout.librarianAuthoredDirs]);
  }

  /**
   * Every voice `provenance.author` records, the dominant one first. A YAML list or a
   * comma-separated string, entries trimmed: a list of alternatives, so the joined
   * string is never itself a speaker.
   */
  get voices(): string[] {
    const prov = this.fm['provenance'];
    const author = isMapping(prov) ? prov['author'] : undefined;
    const values = Array.isArray(author) ? author : [author];
    return values.filter((v): v is string => typeof v === 'string')
      .flatMap((v) => v.split(',').map((part) => pyStrip(part)))
      .filter(Boolean);
  }

  /**
   * Speakers a citation of this page may name. What the file records wins in every
   * zone; the zone's default fills a silence. Empty for a source with no
   * `provenance.author`, which is the source's own defect.
   */
  speakers(layout: Layout, scheme: Scheme): string[] {
    const recorded = this.voices;
    if (recorded.length) return recorded;
    if (this.relpath.startsWith(layout.writingDir)) return [scheme.authorSpeaker];
    if (startsWithAny(this.relpath, layout.librarianAuthoredDirs)) return [scheme.librarianSpeaker];
    return [];
  }
}

/**
 * Two names that fold to one key. `page` carries `name`; `other` won the key. Kinds:
 * `basename` (two notes, one basename), `alias-basename` (an alias on `page` that is
 * another note's basename, so it can never reach `page`), `alias-alias` (two notes
 * claim one alias).
 */
export interface Collision {
  kind: 'basename' | 'alias-basename' | 'alias-alias';
  name: string;
  page: string;
  other: string;
}

/**
 * Basenames win a contested key, as in Obsidian; the first note wins a basename or
 * alias contest, and every contest is recorded for LK2.
 */
export class PageIndex {
  readonly #pages = new Map<string, Page>();
  readonly #aliases = new Map<string, [string, Page]>();
  readonly #contested = new Set<string>();
  readonly #collisions: Collision[] = [];

  add(relpath: string, text: string): void {
    let fm: Frontmatter | null = null;
    try {
      fm = split(text).fm;
    } catch (err) {
      if (!(err instanceof FrontmatterError)) throw err;
      // FM2 reports it; link resolution carries on, and the skip is logged.
      log.warning(`link index skipped frontmatter of ${relpath}: ${err.message}`);
    }
    const page = new Page(relpath, fm ?? {});
    const own = key(relpath);
    const holder = this.#pages.get(own);
    if (holder && holder.relpath !== relpath) {
      log.info(`link key '${own}' is ambiguous: ${holder.relpath} vs ${relpath}`);
      this.#collisions.push({ kind: 'basename', name: stem(relpath), page: relpath, other: holder.relpath });
    } else {
      const alias = this.#aliases.get(own);
      if (alias && alias[1].relpath !== relpath) {
        this.#collisions.push({ kind: 'alias-basename', name: alias[0], page: alias[1].relpath, other: relpath });
        this.#aliases.delete(own);
      }
      this.#pages.set(own, page);
    }
    const aliases = page.fm['aliases'] || [];
    for (const alias of Array.isArray(aliases) ? aliases : [aliases]) {
      if (typeof alias !== 'string') continue;
      const k = key(alias);
      if (k === own) continue; // an alias spelling its own basename changes nothing
      const basename = this.#pages.get(k);
      if (basename) {
        this.#collisions.push({ kind: 'alias-basename', name: alias, page: relpath, other: basename.relpath });
        continue;
      }
      const claimed = this.#aliases.get(k);
      if (claimed && claimed[1].relpath !== relpath) {
        this.#collisions.push({ kind: 'alias-alias', name: alias, page: relpath, other: claimed[1].relpath });
        this.#contested.add(k);
        continue;
      }
      this.#aliases.set(k, [alias, page]);
    }
  }

  /** A non-Markdown file is a link key under its full name, extension included. */
  addAttachment(relpath: string): void {
    const k = key(relpath);
    const holder = this.#pages.get(k);
    if (holder && holder.relpath !== relpath) {
      this.#collisions.push({
        kind: 'basename', name: relpath.slice(relpath.lastIndexOf('/') + 1), page: relpath, other: holder.relpath,
      });
      return;
    }
    this.#pages.set(k, new Page(relpath, {}));
  }

  /** The page a link lands on in Obsidian, by basename or path, or null. */
  resolve(target: string): Page | null {
    return this.#pages.get(key(target)) ?? null;
  }

  /** The page an alias names, or null where the key is a basename or contested. */
  resolveAlias(target: string): Page | null {
    const k = key(target);
    if (this.#pages.has(k) || this.#contested.has(k)) return null;
    return this.#aliases.get(k)?.[1] ?? null;
  }

  /** Basename, then alias: the tolerant read for judging a citation. */
  resolveAny(target: string): Page | null {
    return this.resolve(target) ?? this.resolveAlias(target);
  }

  /** Every basename key and the page it names. */
  entries(): IterableIterator<[string, Page]> {
    return this.#pages.entries();
  }

  /** [key, alias as written, page] for every alias that resolves. */
  *aliasEntries(): Generator<[string, string, Page]> {
    for (const [k, [alias, page]] of this.#aliases) yield [k, alias, page];
  }

  collisions(): Collision[] {
    return [...this.#collisions];
  }

  static fromNotes(notes: Iterable<Note>, attachments: Iterable<string> = []): PageIndex {
    const index = new PageIndex();
    for (const [relpath, text] of notes) index.add(relpath, text);
    for (const relpath of attachments) index.addAttachment(relpath);
    return index;
  }
}
