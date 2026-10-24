// The wiki's pages as ripple reads them, on the main side: each page's title, aliases,
// owner and paragraphs, from the wiki book, its page sidecars and its chapter files.
// Reading never writes.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { validateHoardPageV1 } from '../../generated/validators.cjs';
import { key } from '../../librarian/links.ts';
import { oneName } from '../files.ts';
import { paragraphTexts } from '../html.ts';
import { ownerOf, type Owner } from '../review/owner.ts';
import type { WikiPages } from '../wiki/store.ts';
import { corpusOf, type Corpus } from './shortlist.ts';

export interface WikiPage {
  chId: string;
  title: string;
  aliases: string[];
  owner: Owner;
  /** The page's file, relative to the library. */
  rel: string;
}

export interface Wiki {
  bookId: string;
  pages: WikiPage[];
}

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string' && v.trim() !== '');

export const chapterRel = (bookId: string, chId: string) => `${oneName(bookId, 'bookId')}/chapters/${oneName(chId, 'chId')}.html`;

/** The wiki's pages with what their sidecars say; a sidecar that does not read makes the page the writer's. */
export function readWiki(library: string, wiki: WikiPages, log: Log): Wiki {
  const pages = wiki.pages.map(({ chId, title }): WikiPage => {
    const page: WikiPage = { chId, title, aliases: [], owner: 'author', rel: chapterRel(wiki.bookId, chId) };
    const file = path.join(library, '.neo', wiki.bookId, 'pages', `${oneName(chId, 'chId')}.json`);
    if (!existsSync(file)) return page;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      if (validateHoardPageV1(data)) {
        const fm = data.frontmatter && typeof data.frontmatter === 'object' ? data.frontmatter as Record<string, unknown> : {};
        page.aliases = strings(fm['aliases']);
        page.owner = ownerOf(data.frontmatter);
      }
    } catch (err) {
      log('warn', 'ripple: a page sidecar does not read, so its page is the writer\'s', { file, why: String(err) });
    }
    return page;
  });
  return { bookId: wiki.bookId, pages };
}

/** A page by title or alias, as a [[link]] finds it. */
export function findPage(wiki: Wiki, name: string): WikiPage | null {
  const k = key(name.replace(/^\[\[|\]\]$/g, '').split(/[|#]/)[0] ?? '');
  return wiki.pages.find((p) => key(p.title) === k) ?? wiki.pages.find((p) => p.aliases.some((a) => key(a) === k)) ?? null;
}

/** A page's text as ripple reads it: its paragraphs, a blank line between. */
export function pageText(html: string): string {
  return paragraphTexts(html).filter((p) => p.trim()).join('\n\n');
}

/** A page's name as a corpus path: its title, with a slash no folder. */
export const corpusPath = (title: string) => `${title.replace(/[/\\]/g, '∕')}.md`;

/** The wiki as a shortlist corpus, and each corpus path's page. */
export function wikiCorpus(library: string, wiki: Wiki): { corpus: Corpus; byPath: Map<string, WikiPage> } {
  const byPath = new Map<string, WikiPage>();
  const docs = [];
  for (const page of wiki.pages) {
    const file = path.join(library, page.rel);
    if (!existsSync(file)) continue;
    const relpath = corpusPath(page.title || page.chId);
    byPath.set(relpath, page);
    docs.push({ relpath, aliases: page.aliases, body: pageText(readFileSync(file, 'utf8')) });
  }
  return { corpus: corpusOf(docs), byPath };
}
