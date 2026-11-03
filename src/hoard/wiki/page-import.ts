// Import into one of the library's two trees of page files, sources/ or wiki/ (pages/):
// each picked Markdown page becomes one HTML page file, named for its title. A source
// page lands in the folder its file had in its vault (`Daily/Ebb.md` is
// sources/Daily/Ebb.html), a wiki page at the top of wiki/, unless the import list
// names a folder. The picks are sorted as picks.ts sorts them, against the pages this
// tree already holds; titles are one to a tree.
//
// Each page's provenance is its sidecar, .neo/pages/<tree>/<path>.json (hoard-page-v1),
// which a rename moves with it (pages/store.ts). The sidecar records the hash the page
// file had when the import wrote it, so a page nobody has changed since is updated in
// place from a newer source, wherever it has been moved to; a changed one gets the new
// source as a page beside it. A provisional sidecar is written before its page, and the
// final one once the page, its attachments and the logs are all written, so an import
// that stops part way leaves a sidecar that no source matches, or one with no page,
// which the next import writes over: importing the same files again finishes the page,
// never takes it as done.
//
// With history kept, an import is two commits: the author's first, with each page that
// is theirs and the author's blocks of the librarian's pages, then the librarian's, with
// the rest.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardChangeV1 } from '../../generated/hoard-change-v1.js';
import type { Mark } from '../../generated/hoard-marks-v1.js';
import type { HoardPageV1 } from '../../generated/hoard-page-v1.js';
import { validateHoardChangeV1, validateHoardPageV1 } from '../../generated/validators.cjs';
import { key } from '../../librarian/links.ts';
import { appendRecord, parseManifest, serialiseRecord } from '../../librarian/manifest.ts';
import { writeWhole } from '../files.ts';
import { anchorAt, anchorPoint } from '../marks/anchor.ts';
import { newMark } from '../marks/model.ts';
import { checkPath, idOf, parseId, titleOf, TREES, type Tree } from '../pages/identity.ts';
import type { PageChange } from '../pages/store.ts';
import { ownerFromFrontmatter } from '../review/owner.ts';
import { copyAttachment } from './attachments.ts';
import { pageHtml, type ConvertedPage } from './convert.ts';
import { HoardIndex, hoardRoot, vaultRoot } from './hoard-manifest.ts';
import { pickKey, sha256, sortPicks, type KnownPage, type Pick, type Picked, type SortedOf, type VerdictOf } from './picks.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

/** The marks of page files, by page id; the marks store's page half (stage 3) serves it. */
export interface PageMarks {
  list(page: string): Promise<Mark[]>;
  addAll(page: string, marks: Mark[]): Promise<void>;
}

export interface PageImportOptions {
  library: () => string;
  tree: Tree;
  /** Where a page's marks go; without it, a page's marks are counted and left out. */
  marks?: PageMarks;
  now?: () => Date;
  newId?: (prefix: string) => string;
  /** The library's last commit, or null; marks made by an import carry it. */
  head?: () => Promise<string | null>;
  /** Told after the writes, so the library's history takes them. */
  wrote?: (name: string) => void;
  /**
   * Told of each page the import wrote, once, with the page as it was and as the import
   * leaves it. `who` is the librarian only for a wiki page its sidecar makes the librarian's.
   */
  imported?: (change: PageChange) => void | Promise<void>;
  /** Commits the library as it stands, as the author's or the librarian's; resolves once it has landed. */
  commit?: (part: 'author' | 'librarian') => Promise<void>;
  log: (level: Level, message: string, data?: unknown) => void;
}

/** The page an update or a page beside follows, by its id. */
export type PageVerdict = VerdictOf<{ pageId: string }>;
export type PageSorted = SortedOf<{ pageId: string }>;

export interface PageApplied {
  tree: Tree;
  imported: { page: string; name: string }[];
  updated: { page: string; name: string }[];
  marks: number;
  /** Marks the pages brought that had nowhere to go (no page marks store yet). */
  marksLeft: number;
  keptAsText: number;
  attachments: number;
  missing: string[];
}

// A title becomes the target of a [[link]], which the grammar ends at ] | # or ^ (pages/store.ts).
/** The source hash of a provisional sidecar: no file's SHA-256 is this. */
const UNFINISHED = '0'.repeat(64);
const UNLINKABLE = /[[\]|#^\p{Cc}]/u;

// The folders a source page keeps: its file's, from its vault's root; none for a file
// outside a vault or in a folder no page path can hold.
function originFolder(file: string): string | null {
  const root = vaultRoot(file);
  if (!root) return null;
  const rel = path.relative(root, path.dirname(path.resolve(file)));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  return parts.some((p) => p === '' || p.startsWith('.') || /[\\\0]/.test(p)) ? null : parts.join('/');
}

export class PageImport {
  readonly #o: PageImportOptions;
  #running = false;

  constructor(options: PageImportOptions) {
    this.#o = options;
  }

  get tree(): Tree {
    return this.#o.tree;
  }

  get #library(): string {
    return this.#o.library();
  }

  #abs(rel: string): string {
    return path.join(this.#library, ...rel.split('/'));
  }

  #sidecarOf(id: string): string {
    return `.neo/pages/${id}.json`;
  }

  // Every .json under a folder of .neo/pages, as paths below it.
  #walk(dir: string, rel = ''): string[] {
    let entries;
    try {
      entries = readdirSync(path.join(dir, ...(rel ? rel.split('/') : [])), { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((e) => {
      if (e.name.startsWith('.')) return [];
      const at = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) return this.#walk(dir, at);
      return e.isFile() ? [at] : [];
    });
  }

  // What the tree holds: the newest page for each source, every title and source name
  // (by link key), and each page's sidecar; and hoard's roots, from the sources of the
  // pages of both trees.
  #known(): { bySource: Map<string, KnownPage<string> & { imported: string }>; names: Set<string>; hoards: Set<string>; sidecars: Map<string, HoardPageV1> } {
    const bySource = new Map<string, KnownPage<string> & { imported: string }>();
    const names = new Set<string>();
    const hoards = new Set<string>();
    const sidecars = new Map<string, HoardPageV1>();
    for (const rel of this.#walk(this.#abs(this.#o.tree))) if (rel.endsWith('.html')) names.add(key(titleOf(rel)));
    const rootOf = new Map<string, string | null>();
    for (const tree of TREES) {
      for (const rel of this.#walk(this.#abs(`.neo/pages/${tree}`))) {
        if (!rel.endsWith('.html.json')) continue;
        const id = `${tree}/${rel.slice(0, -'.json'.length)}`;
        if (!existsSync(this.#abs(id))) continue; // a sidecar a crash left before its page
        const file = this.#abs(this.#sidecarOf(id));
        try {
          const page = JSON.parse(readFileSync(file, 'utf8')) as unknown;
          if (!validateHoardPageV1(page)) {
            this.#o.log('warn', `pages.import: the page sidecar ${file} is not one`, validateHoardPageV1.errors);
            continue;
          }
          const dir = path.dirname(page.source.path);
          if (!rootOf.has(dir)) rootOf.set(dir, hoardRoot(page.source.path));
          const root = rootOf.get(dir);
          if (root) hoards.add(root);
          if (tree !== this.#o.tree) continue;
          sidecars.set(id, page);
          const k = pickKey({ path: page.source.path, sections: page.source.sections ?? [] });
          const was = bySource.get(k);
          if (!was || was.imported <= page.imported) bySource.set(k, { at: id, title: titleOf(id), sha256: page.source.sha256, imported: page.imported });
          names.add(key(page.source.name));
        } catch (err) {
          this.#o.log('warn', `pages.import: the page sidecar ${file} does not read`, String(err));
        }
      }
    }
    return { bySource, names, hoards, sidecars };
  }

  // Why a name cannot be a page's title in this tree, or null when it can.
  #refuseName(name: string): string | null {
    if (name.trim() === '' || name !== name.trim() || UNLINKABLE.test(name) || name.startsWith('.') || /[\\/]/.test(name)) {
      return `"${name}" cannot be a page title: it is empty, starts with a dot, has spaces at an end, or holds a slash or one of [ ] | # ^. Name it with -> in an import list`;
    }
    return null;
  }

  // The page id a new page takes: the folder the list named, else (for a source) its
  // vault folder, else the tree's top.
  #placeOf(p: Picked): string {
    const folder = p.folder ?? (this.#o.tree === 'sources' ? originFolder(p.path) : null);
    return idOf({ tree: this.#o.tree, path: checkPath(folder ? `${folder}/${p.name}.html` : `${p.name}.html`) });
  }

  /** What importing these files or list entries would do. Reads; never writes. */
  sort(picks: readonly (string | Pick)[]): PageSorted {
    const { bySource, names, hoards, sidecars } = this.#known();
    // a list that takes hoard's pages along with an old vault's says where hoard is
    for (const pick of picks) {
      const root = hoardRoot(typeof pick === 'string' ? pick : pick.path);
      if (root) hoards.add(root);
    }
    const verdicts = sortPicks(picks, {
      bySource,
      names,
      hoard: hoards.size ? HoardIndex.read(hoards, this.#o.log) : null,
      untouched: (id: string) => {
        const was = sidecars.get(id)?.written;
        return was !== undefined && existsSync(this.#abs(id)) && sha256(readFileSync(this.#abs(id))) === was;
      },
      where: (pageId: string) => ({ pageId }),
      refuseName: (name) => this.#refuseName(name),
      day: this.#now().slice(0, 10),
      blockId: () => this.#id('b'),
    });
    return { verdicts, picks: [...picks].map((x) => (typeof x === 'string' ? { path: x } : x)) };
  }

  /** Imports the new and updated pages of a sort, sorting them again first. Refuses while another import runs. */
  async apply(sorted: PageSorted): Promise<PageApplied> {
    if (this.#running) throw new Error('An import is already running.');
    this.#running = true;
    try {
      return await this.#apply(sorted);
    } finally {
      this.#running = false;
    }
  }

  async #apply(sorted: PageSorted): Promise<PageApplied> {
    type Act = Extract<PageVerdict, { kind: 'new' | 'update' | 'beside' }>;
    const acts = (v: PageVerdict): v is Act => v.kind === 'new' || v.kind === 'update' || v.kind === 'beside';
    const wanted = new Set(sorted.verdicts.filter(acts).map(pickKey));
    const fresh = this.sort(sorted.picks ?? sorted.verdicts.filter(acts).map((v) => ({ path: v.path })));
    const pages = fresh.verdicts.filter(acts).filter((v) => wanted.has(pickKey(v)));
    const tree = this.#o.tree;
    const applied: PageApplied = { tree, imported: [], updated: [], marks: 0, marksLeft: 0, keptAsText: 0, attachments: 0, missing: [] };
    if (pages.length === 0) return applied;
    const manifestFile = this.#abs('.neo/manifest.jsonl');
    const changesFile = this.#abs('.neo/changes.jsonl');
    let records = existsSync(manifestFile) ? parseManifest(readFileSync(manifestFile, 'utf8')) : [];
    const changesBefore = existsSync(changesFile) ? readFileSync(changesFile, 'utf8') : '';
    const base = this.#o.head ? await this.#o.head() : null;
    const at = this.#now();

    // An update keeps its page's place; a page beside another goes in its folder.
    const ids = pages.map((p) => {
      if (p.kind === 'update') return p.pageId;
      if (p.kind === 'new') return this.#placeOf(p);
      const dir = parseId(p.pageId).path.split('/').slice(0, -1).join('/');
      return idOf({ tree, path: checkPath(dir ? `${dir}/${p.name}.html` : `${p.name}.html`) });
    });
    // what each page holds now, so an update is announced as a change from it
    const was = ids.map((id) => {
      try {
        return readFileSync(this.#abs(id), 'utf8');
      } catch {
        return '';
      }
    });
    const sidecars = pages.map((page): HoardPageV1 => {
      const sidecar: HoardPageV1 = {
        version: 1,
        source: { path: page.path, name: page.name, sha256: page.sha256, ...(page.sections.length ? { sections: page.sections as [string, ...string[]] } : {}) },
        frontmatter: page.page.frontmatter,
        written: sha256(page.page.html),
        imported: at,
      };
      if (!validateHoardPageV1(sidecar)) throw new TypeError(`pages.import: refusing to write a page sidecar: ${JSON.stringify(validateHoardPageV1.errors)}`);
      return sidecar;
    });
    // An update of a page whose first import stopped before its change was logged is
    // still that page's import: its sidecar is provisional and no change names it.
    const logged = new Set(changesBefore.split('\n').flatMap((l) => {
      try { return [(JSON.parse(l) as { page?: unknown }).page]; } catch { return []; }
    }));
    const firstImport = pages.map((p, n) => {
      if (p.kind !== 'update') return true;
      try {
        const was = JSON.parse(readFileSync(this.#abs(this.#sidecarOf(ids[n]!)), 'utf8')) as { source?: { sha256?: unknown } };
        return was.source?.sha256 === UNFINISHED && !logged.has(ids[n]);
      } catch {
        return false;
      }
    });
    // With history kept, a page first holds only the author's blocks (or all of it, when the
    // author owns it), committed before the librarian's are added.
    const first = pages.map((page) => (this.#o.commit && ownerFromFrontmatter(page.page.frontmatter) !== 'author' ? pageHtml(page.page.blocks, 'author') : page.page.html));
    // Each sidecar is provisional until its page holds its final text: its source hash
    // matches no file, and `written` is the page as it is now, so an import that stops part
    // way is taken up again as an update rather than seen as already done.
    pages.forEach((_, n) => {
      const file = this.#abs(ids[n]!);
      const now = this.#o.commit ? sha256(first[n]!) : existsSync(file) ? sha256(readFileSync(file)) : sha256(first[n]!);
      const provisional: HoardPageV1 = { ...sidecars[n]!, source: { ...sidecars[n]!.source, sha256: UNFINISHED }, written: now };
      writeWhole(this.#abs(this.#sidecarOf(ids[n]!)), `${JSON.stringify(provisional, null, 2)}\n`);
    });
    if (this.#o.commit) {
      pages.forEach((_, n) => writeWhole(this.#abs(ids[n]!), first[n]!));
      this.#o.wrote?.(tree);
      this.#o.wrote?.('.neo');
      await this.#o.commit('author');
    }
    const changes: HoardChangeV1[] = [];
    const missing = new Set<string>();
    for (const [n, page] of pages.entries()) {
      const id = ids[n]!;
      writeWhole(this.#abs(id), page.page.html);
      await this.#announce(id, was[n]!, page.page.html, ownerFromFrontmatter(page.page.frontmatter));
      // still provisional, now naming the page as it stands, until the logs are written too
      writeWhole(this.#abs(this.#sidecarOf(id)), `${JSON.stringify({ ...sidecars[n]!, source: { ...sidecars[n]!.source, sha256: UNFINISHED } }, null, 2)}\n`);
      const made = this.#marks(page.page, base, at);
      if (this.#o.marks) {
        // An update keeps every mark there and adds only the source's marks it lacks.
        const had = page.kind === 'update' ? await this.#o.marks.list(id) : [];
        const sameMark = (a: Mark, b: Mark) => a.kind === b.kind && a.anchor.exact === b.anchor.exact
          && a.proposed === b.proposed && a.thread[0]?.body === b.thread[0]?.body;
        const marks = made.filter((m) => !had.some((h) => sameMark(h, m)));
        await this.#o.marks.addAll(id, marks);
        applied.marks += marks.length;
      } else if (made.length) {
        applied.marksLeft += made.length;
        this.#o.log('warn', 'pages.import: no page marks store yet, so these marks are left out', { page: id, marks: made.length });
      }
      applied.keptAsText += page.page.keptAsText;
      for (const found of page.attachments) {
        const copy = copyAttachment(this.#library, tree, found.file);
        records = appendRecord(records, {
          src: found.file, dest: copy.dest, method: 'verbatim', src_sha256: copy.sha256, file_sha256: copy.sha256, ingested_at: at,
        }).records;
        if (!copy.copied) continue;
        applied.attachments++;
        changes.push({ version: 1, at, kind: 'attachment-imported', page: id, dest: copy.dest, src: found.file });
      }
      for (const target of page.missing) missing.add(target);
      // A record of this source and page with another file hash (a retry wrote the page anew) is not a duplicate.
      const record = { src: page.path, dest: id, method: page.sections.length ? 'split' as const : 'converted' as const, src_sha256: page.sha256, file_sha256: sidecars[n]!.written!, ingested_at: at };
      const recorded = records.some((r) => r.src === record.src && r.dest === record.dest && r.src_sha256 === record.src_sha256 && r.file_sha256 === record.file_sha256);
      if (!recorded) records = appendRecord(records, record, { dedupe: false }).records;
      const fresh = firstImport[n];
      changes.push({ version: 1, at, kind: fresh ? 'page-imported' : 'page-updated', page: id, dest: id, src: page.path });
      (fresh ? applied.imported : applied.updated).push({ page: id, name: page.name });
    }

    writeWhole(manifestFile, records.map(serialiseRecord).join(''));
    for (const c of changes) if (!validateHoardChangeV1(c)) throw new TypeError(`pages.import: refusing to log a change: ${JSON.stringify(validateHoardChangeV1.errors)}`);
    const separator = changesBefore && !changesBefore.endsWith('\n') ? '\n' : '';
    writeWhole(changesFile, changesBefore + separator + changes.map((c) => `${JSON.stringify(c)}\n`).join(''));
    // Only now is each page done: its sidecar names its source.
    pages.forEach((_, n) => writeWhole(this.#abs(this.#sidecarOf(ids[n]!)), `${JSON.stringify(sidecars[n], null, 2)}\n`));

    applied.missing = [...missing];
    this.#o.log('info', 'pages.import', {
      tree, pages: applied.imported.length, updated: applied.updated.length, marks: applied.marks, marksLeft: applied.marksLeft,
      keptAsText: applied.keptAsText, attachments: applied.attachments, missing: applied.missing.length,
    });
    this.#o.wrote?.(tree);
    this.#o.wrote?.('.neo');
    await this.#o.commit?.('librarian');
    return applied;
  }

  // A callback that fails is logged: the page is written, and the import goes on.
  async #announce(id: string, before: string, after: string, owner: 'author' | 'librarian'): Promise<void> {
    if (!this.#o.imported || before === after) return;
    const who = this.#o.tree === 'wiki' && owner === 'librarian' ? 'librarian' : 'author';
    try {
      await this.#o.imported({ page: id, kind: 'import', who, before, after });
      this.#o.log('debug', 'pages.import.announced', { page: id, who });
    } catch (err) {
      this.#o.log('error', 'pages.import: announcing the page failed, so the page is written without it', { page: id, why: String(err) });
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
    // a block's id is short, as Obsidian's are, since a citation carries it
    if (prefix === 'b') return randomBytes(4).toString('hex').slice(0, 6);
    return `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex').slice(0, 6)}`;
  }
}
