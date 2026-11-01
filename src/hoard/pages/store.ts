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
import { existsSync } from 'node:fs';
import { opendir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitLayer } from '../git/layer.ts';
import { writeWhole } from '../files.ts';
import { checkPath, idOf, PageRefused, parseId, titleOf, TREES, type PageRef, type Tree } from './identity.ts';
import { titleIndex } from './titles.ts';

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface PageStoreOptions {
  library: () => string;
  /** Takes writes into the library's history; absent, pages are written without it. */
  layer?: Pick<GitLayer, 'around' | 'wrote'>;
  log: (level: Level, message: string, data?: unknown) => void;
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

// A title becomes the target of a [[link]], which the grammar ends at ] | # or ^.
const UNLINKABLE = /[[\]|#^\p{Cc}]/u;

export class PageStore {
  protected readonly o: PageStoreOptions;

  constructor(options: PageStoreOptions) {
    this.o = options;
  }

  protected file(ref: PageRef): string {
    return path.join(this.o.library(), ref.tree, ...ref.path.split('/'));
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
        if (d.isDirectory()) {
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

  async list(): Promise<PageEntry[]> {
    const start = performance.now();
    const pages = await this.#scan();
    const { duplicates } = titleIndex(pages);
    for (const group of duplicates) this.o.log('warn', 'pages: these pages share one title, so a link reaches only the first', group.map((p) => p.id));
    this.o.log('info', 'pages.list', { pages: pages.length, ms: Math.round(performance.now() - start) });
    return pages;
  }

  /** The page a link target names, wiki first; undefined if none. */
  async resolve(target: string): Promise<PageEntry | undefined> {
    return titleIndex(await this.#scan()).resolve(target);
  }

  read(id: string): Promise<PageFile | null> {
    return this.op('read', async () => {
      const ref = parseId(id);
      const html = await readFile(this.file(ref), 'utf8').catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
        throw err;
      });
      return html === null ? null : { id, tree: ref.tree, path: ref.path, title: titleOf(ref.path), html };
    });
  }

  write(id: string, before: string, after: string): Promise<Written> {
    return this.op('write', async () => {
      const ref = parseId(id);
      const file = this.file(ref);
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
    });
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
    return this.op('create', async () => {
      const ref = parseId(`${tree}/${checkPath(pagePath)}`);
      const title = this.checkTitle(ref.path);
      const clash = titleIndex(await this.#scan()).taken(ref.tree, title);
      if (clash || existsSync(this.file(ref))) {
        throw new PageRefused('taken', `${JSON.stringify(title)} is already a page in ${ref.tree}${clash ? ` (${clash.id})` : ''}`);
      }
      writeWhole(this.file(ref), html);
      this.o.layer?.wrote(ref.tree);
      const s = await stat(this.file(ref));
      this.o.log('info', 'pages.create', { id: idOf(ref), bytes: s.size });
      return { id: idOf(ref), tree: ref.tree, path: ref.path, title, size: s.size, mtime: s.mtimeMs };
    });
  }
}
