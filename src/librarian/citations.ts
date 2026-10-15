// The citation forms of a librarian page, from hoard's lint.py, shared by lint (CS1) and
// quotes (QV1 to QV3). Group 1 of each is the cited link's target.
//
// The link sitting right against the marker is the whole signal: ordinary parenthetical
// prose beside a wikilink must never read as a citation, because a false finding costs
// more than a missed odd form.
import { LINK_SRC } from './links.ts';

/** `([[page]] -- Speaker, locator)`; group 2 is what follows the dash. */
export const INLINE_CITE = new RegExp(String.raw`\(\s*${LINK_SRC}\s*--\s*([^)]*)\)`, 'gu');
/**
 * `-- [[page]] (Speaker, locator)`. `--` is the vault's ordinary prose dash, so the
 * block form counts only where it is set off at a line start; lint checks that.
 */
export const BLOCK_CITE = new RegExp(String.raw`(?<![-\p{L}\p{N}_])--\s*${LINK_SRC}\s*\(([^)]*)\)`, 'gu');
// Python's `$` also matches before a final newline.
export const BLOCK_CITE_NO_SPEAKER = new RegExp(String.raw`^--\s*${LINK_SRC}\s*(?=\n?$)`, 'u');
/** `- [[page]] (Speaker) -- description`, a footer bullet that cites first. */
export const FOOTER_CITE = new RegExp(String.raw`^[-*]\s+${LINK_SRC}\s*\(([^)]*)\)\s*--`, 'gu');
/** A blockquote's closing attribution line: librarian text inside author bytes. */
export const QUOTE_ATTRIBUTION = /^--\s*\[\[/u;

/** pattern.search(text, pos): the first match at or after pos, or null. */
export function searchFrom(pattern: RegExp, text: string, pos: number): RegExpExecArray | null {
  const global = pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  global.lastIndex = pos;
  return global.exec(text);
}

/** pattern.finditer(text): every match. */
export function findAll(pattern: RegExp, text: string): RegExpExecArray[] {
  const global = pattern.global ? new RegExp(pattern.source, pattern.flags) : new RegExp(pattern.source, `${pattern.flags}g`);
  return [...text.matchAll(global)];
}
