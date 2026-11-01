// The citations of a page's HTML: [[Page#^id]] links, found as the window and the rename
// find links (pages/rewrite.ts): in each paragraph's text, inline code masked, by the one
// grammar in librarian/links.ts. A paragraph of class wiki-code is fenced code, so it is
// skipped. Pure.
import { maskCodeSpans, WIKILINK } from '../../librarian/links.ts';
import { textUnits } from '../pages/rewrite.ts';

export interface Citation {
  /** The link as written. */
  link: string;
  /** The page it names, as written. */
  target: string;
  /** The block it names, without the caret. */
  id: string;
}

const PARAGRAPH = /<p(\s[^>]*)?>([\s\S]*?)<\/p>/gi;
const CODE_CLASS = /\bclass\s*=\s*(?:"[^"]*\bwiki-code\b[^"]*"|'[^']*\bwiki-code\b[^']*')/i;
const BLOCK = /\sdata-block="([^"]*)"/g;

/** Every citation in the page, in order; a link to a page or a heading is not one. */
export function citationsIn(html: string): Citation[] {
  const found: Citation[] = [];
  for (const p of html.matchAll(PARAGRAPH)) {
    if (CODE_CLASS.test(p[1] ?? '')) continue;
    const inner = p[2]!;
    if (!inner.includes('[[')) continue;
    for (const m of maskCodeSpans(textUnits(inner).text).matchAll(WIKILINK)) {
      const anchor = m.groups!['anchor'];
      if (!anchor || !/^#?\^/.test(anchor)) continue;
      found.push({ link: m[0].replace(/^!/, ''), target: m.groups!['target']!.trim(), id: anchor.replace(/^#?\^/, '').trim() });
    }
  }
  return found;
}

/** The ids the page's blocks carry. */
export function blockIds(html: string): Set<string> {
  return new Set([...html.matchAll(BLOCK)].map((m) => m[1]!));
}
