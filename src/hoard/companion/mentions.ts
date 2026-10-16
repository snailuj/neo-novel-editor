// The wiki pages a chapter's new paragraphs name, hoard's companion extract for NEO's
// paragraphs. One channel feeds a match, the bare name (snailuj's ruling of 22 September
// 2026): a page's title or one of its aliases, as a whole phrase, any case. A [[link]]
// the writer typed is never a mention, since they already know the page, so links are
// blanked whole before matching, and so is inline code. Pure.
//
// - A name shorter than three letters never matches; the word boundary keeps "Fox" out
//   of "foxes".
// - Hyphens and spaces fold together, so "Gull-Clan" is found as "Gull Clan", but the
//   whole name must be there. A name that starts or ends with a separator cannot be
//   folded without matching the name beside it, so it is left out.
// - The longest match wins: "Fox-Den" does not also find "Fox".
// - Accents are not folded. Case is folded by the pattern over the words as written,
//   never over a lowered copy, which would move every offset after a dotted capital I.
// - NEO turns a typed apostrophe into a curly one and keeps no-break spaces, so a
//   straight apostrophe in a name matches a curly one, and a no-break space is a space.
//
// One mention per page: its first in the chapter. Of two pages with one name the first
// is kept, and a title beats another page's alias, as links resolve (wiki/links.ts).
import { key, maskCodeSpans, WIKILINK } from '../../librarian/links.ts';

export interface WikiPage {
  /** The page's chapter id in the wiki book. */
  id: string;
  title: string;
  aliases: string[];
  /** Its frontmatter's draft_status is pantsing. */
  pantsing: boolean;
}

export interface Mention {
  page: WikiPage;
  pIdx: number;
  off: number;
  len: number;
  /** The name as the writer wrote it. */
  text: string;
}

export const MIN_NAME = 3;

// A letter, digit, mark or underscore. The whole-word test is made by hand around each
// match, not as a lookbehind in every pattern: V8 takes about a millisecond to ready a
// pattern with Unicode classes in it, a second for a wiki of five hundred pages.
const WORD = /[\p{L}\p{N}\p{M}_]/u;
const SEPARATORS = /[-\s]+/u;
const APOSTROPHES = /['‘’]/u;

const escape = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/-]/gu, '\\$&');

// İ is the one letter whose lower case is longer; matching it as I keeps every offset.
const dotless = (text: string) => text.replaceAll('İ', 'I');

/** A name as a pattern, or null when it cannot be folded. */
function pattern(name: string): string | null {
  if (/^[-\s]|[-\s]$/u.test(name)) return null;
  return name.split(SEPARATORS).filter(Boolean)
    .map((part) => [...dotless(part)].map((ch) => (APOSTROPHES.test(ch) ? "['‘’]" : escape(ch))).join(''))
    .join(String.raw`[-\s]+`);
}

/** Whether the letter just before (`dir` -1) or at (`dir` 1) offset `at` is part of a word. */
function wordAt(text: string, at: number, dir: -1 | 1): boolean {
  const ch = dir === 1 ? String.fromCodePoint(text.codePointAt(at) ?? 32) : [...text.slice(Math.max(0, at - 2), at)].pop() ?? ' ';
  return WORD.test(ch);
}

/** The text with links and inline code blanked, every offset kept. */
function prose(text: string): string {
  return dotless(maskCodeSpans(text).replace(WIKILINK, (m) => ' '.repeat(m.length)));
}

/** Each name to match, with its page: titles first, then aliases no title holds. */
function names(pages: readonly WikiPage[], skipped: (name: string) => void): { re: RegExp; page: WikiPage }[] {
  const byKey = new Map<string, { name: string; page: WikiPage }>();
  const add = (name: string, page: WikiPage) => {
    const trimmed = name.normalize('NFC').trim();
    const k = key(trimmed);
    if (k.length < MIN_NAME || byKey.has(k)) return;
    byKey.set(k, { name: trimmed, page });
  };
  for (const page of pages) add(page.title, page);
  for (const page of pages) for (const alias of page.aliases) add(alias, page);
  const out: { re: RegExp; page: WikiPage }[] = [];
  for (const { name, page } of byKey.values()) {
    const p = pattern(name);
    if (p === null) skipped(name);
    else out.push({ re: new RegExp(p, 'giu'), page });
  }
  return out;
}

// The last pages' patterns, kept while the pages stay the same: a read at every save
// would otherwise compile one pattern per page each time.
let compiled: { sig: string; names: { re: RegExp; page: WikiPage }[] } | null = null;

function namesFor(pages: readonly WikiPage[], skipped: (name: string) => void) {
  const sig = JSON.stringify(pages.map((p) => [p.id, p.title, p.aliases, p.pantsing]));
  if (compiled?.sig !== sig) compiled = { sig, names: names(pages, skipped) };
  return compiled.names;
}

/** The pages named in the paragraphs `which` of a chapter, each at its first mention. */
export function mentionsIn(
  paragraphs: readonly string[],
  which: readonly number[],
  pages: readonly WikiPage[],
  skipped: (name: string) => void = () => {},
): Mention[] {
  const patterns = namesFor(pages, skipped);
  const hits: Mention[] = [];
  for (const pIdx of which) {
    const text = paragraphs[pIdx];
    if (!text) continue;
    const masked = prose(text);
    for (const { re, page } of patterns) {
      re.lastIndex = 0;
      for (let m = re.exec(masked); m; m = re.exec(masked)) {
        const end = m.index + m[0].length;
        if (wordAt(masked, m.index, -1) || wordAt(masked, end, 1)) {
          // a match inside a word; one may still start within it
          re.lastIndex = m.index + 1;
          continue;
        }
        hits.push({ page, pIdx, off: m.index, len: m[0].length, text: text.slice(m.index, end) });
      }
    }
  }
  // longest first, then any hit inside a kept one is dropped
  const kept: Mention[] = [];
  for (const hit of [...hits].sort((a, b) => b.len - a.len)) {
    const inside = kept.some((k) => k.pIdx === hit.pIdx && k.off <= hit.off && hit.off + hit.len <= k.off + k.len);
    if (!inside) kept.push(hit);
  }
  kept.sort((a, b) => a.pIdx - b.pIdx || a.off - b.off);
  const first = new Map<string, Mention>();
  for (const hit of kept) if (!first.has(hit.page.id)) first.set(hit.page.id, hit);
  return [...first.values()];
}
