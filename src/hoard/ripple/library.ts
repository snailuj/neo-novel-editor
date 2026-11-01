// The pages ripple reads, on the main side: every page of both trees from the page store,
// each with its title, aliases, owner and words. A page under sources/ is the author's
// always; a wiki page is whoever its sidecar says, the author's when that does not read.
// Reading never writes.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardPageV1 } from '../../generated/hoard-page-v1.js';
import { validateHoardPageV1 } from '../../generated/validators.cjs';
import { key } from '../../librarian/links.ts';
import { paragraphTexts } from '../html.ts';
import type { PageStore } from '../pages/store.ts';
import type { Tree } from '../pages/identity.ts';
import type { OwnerOf, Owner } from './ports.ts';
import { corpusOf, type Corpus } from './shortlist.ts';

export interface RipplePage {
  /** `<tree>/<path>`; also the page's file, relative to the library. */
  id: string;
  tree: Tree;
  title: string;
  aliases: string[];
  owner: Owner;
  /** The page's paragraphs, a blank line between. */
  text: string;
}

export interface PageLibrary {
  /** Sorted by id. */
  pages: RipplePage[];
}

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

/** A page's sidecar path, relative to the library. */
export const sidecarRel = (id: string) => `.neo/pages/${id}.json`;

/** A page's sidecar, or null when it has none or it does not read (logged). */
export function readSidecar(root: string, id: string, log: Log): HoardPageV1 | null {
  const file = path.join(root, ...sidecarRel(id).split('/'));
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (validateHoardPageV1(data)) return data;
    log('warn', 'ripple: a page sidecar is not a page sidecar, so it is ignored', { file, why: validateHoardPageV1.errors });
  } catch (err) {
    log('warn', 'ripple: a page sidecar does not read, so it is ignored', { file, why: String(err) });
  }
  return null;
}

/** A page's text as ripple reads it: its paragraphs, a blank line between. */
export function pageText(html: string): string {
  return paragraphTexts(html).filter((p) => p.trim()).join('\n\n');
}

export async function readLibrary(o: { root: string; store: Pick<PageStore, 'list' | 'read'>; ownerOf: OwnerOf; log: Log }): Promise<PageLibrary> {
  const pages: RipplePage[] = [];
  for (const entry of await o.store.list()) {
    const file = await o.store.read(entry.id);
    if (!file) continue; // gone since the listing
    let owner: Owner = 'author';
    if (entry.tree === 'wiki') {
      try {
        owner = await o.ownerOf(o.root, entry.id);
      } catch (err) {
        o.log('warn', 'ripple: a page\'s owner does not read, so the page is the author\'s', { page: entry.id, why: String(err) });
      }
    }
    const fm = readSidecar(o.root, entry.id, o.log)?.frontmatter;
    const aliases = fm && typeof fm === 'object' ? strings((fm as Record<string, unknown>)['aliases']) : [];
    pages.push({ id: entry.id, tree: entry.tree, title: entry.title, aliases, owner, text: pageText(file.html) });
  }
  return { pages };
}

/**
 * A page by id, title or alias, as a [[link]] finds it: the wiki's pages first, then the
 * sources', so a wiki page wins a title a source holds.
 */
export function findPage(library: PageLibrary, name: string): RipplePage | null {
  const exact = library.pages.find((p) => p.id === name);
  if (exact) return exact;
  const k = key(name.replace(/^\[\[|\]\]$/g, '').split(/[|#]/)[0] ?? '');
  const wikiFirst = [...library.pages.filter((p) => p.tree === 'wiki'), ...library.pages.filter((p) => p.tree === 'sources')];
  return wikiFirst.find((p) => key(p.title) === k) ?? wikiFirst.find((p) => p.aliases.some((a) => key(a) === k)) ?? null;
}

/** A page's id as a corpus path; the shortlist reads .md names. */
export const corpusPath = (id: string) => id.replace(/\.html$/, '.md');

/** Both trees as a shortlist corpus (wiki first, so a link finds the wiki's page), and each corpus path's page. */
export function pagesCorpus(library: PageLibrary, log?: Log): { corpus: Corpus; byPath: Map<string, RipplePage> } {
  const byPath = new Map<string, RipplePage>();
  const docs = [];
  const wikiFirst = [...library.pages.filter((p) => p.tree === 'wiki'), ...library.pages.filter((p) => p.tree === 'sources')];
  for (const page of wikiFirst) {
    const relpath = corpusPath(page.id);
    byPath.set(relpath, page);
    docs.push({ relpath, aliases: page.aliases, body: page.text });
  }
  const corpus = corpusOf(docs);
  // the shortlist leaves out a page in a folder that starts with _ or .
  for (const [relpath, page] of byPath) {
    if (corpus.byRel.has(relpath)) continue;
    byPath.delete(relpath);
    log?.('warn', 'ripple: a page sits in a folder whose name starts with _ or ., so it is left out of the shortlist', { page: page.id });
  }
  return { corpus, byPath };
}
