// Links on the page: hoard's [[wikilink]] grammar (librarian/links.ts) read in each
// paragraph's text, inline code masked and embeds left out, and resolved to a wiki page
// by its title as Obsidian resolves a link: case, a folder path and .md set aside, never
// through an alias. Pure.
import { key, maskCodeSpans, WIKILINK } from '../../librarian/links.ts';

export interface FoundLink {
  pIdx: number;
  off: number;
  len: number;
  target: string;
}

export function linksIn(paragraphs: readonly string[]): FoundLink[] {
  const found: FoundLink[] = [];
  paragraphs.forEach((text, pIdx) => {
    for (const m of maskCodeSpans(text).matchAll(WIKILINK)) {
      if (m.groups!['embed']) continue;
      found.push({ pIdx, off: m.index, len: m[0].length, target: m.groups!['target']!.trim() });
    }
  });
  return found;
}

/** The target of the link around offset `off` of a paragraph's text, or null. */
export function linkAt(text: string, off: number): string | null {
  const link = linksIn([text]).find((l) => l.off <= off && off <= l.off + l.len);
  return link ? link.target : null;
}

/** Each page's chapter id by its link key; the first of two pages with one key wins. */
export function pageIndex(pages: readonly { chId: string; title: string }[]): { get(target: string): string | undefined } {
  const byKey = new Map<string, string>();
  for (const { chId, title } of pages) if (title && !byKey.has(key(title))) byKey.set(key(title), chId);
  return { get: (target) => byKey.get(key(target)) };
}
