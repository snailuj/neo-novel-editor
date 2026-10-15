// The two ownership markers, from hoard's spans.py, and the author lines they open on a
// librarian page.
//
// A marker is a blockquote line (up to three spaces of indent, `>`, any spaces) opening
// with `[!human]` or `[!librarian]` in any case, as Obsidian reads callout types. It is a
// prefix: a fold sign and a title may follow. Four spaces of indent is a code block.
import { splitlines } from './py.ts';

const marker = (kinds: string) => new RegExp(String.raw`^ {0,3}> *\[!(${kinds})\]`, 'i');

export const HUMAN_OPENER = marker('human');
export const LIBRARIAN_OPENER = marker('librarian');

/**
 * Body lines, from 1, inside a `> [!human]` span: author bytes filed onto a librarian
 * page. The rules that judge librarian prose leave them alone. Hoard's commit gate can
 * also prove ownership from git history; until that rule is ported, these markers are
 * the whole of it, as they were for lint's fallback.
 */
export function humanSpanLines(body: string): Set<number> {
  const lines = new Set<number>();
  let inHuman = false;
  splitlines(body).forEach((line, i) => {
    // The raw line, not a stripped one: four spaces of indent is code.
    if (HUMAN_OPENER.test(line)) inHuman = true;
    else if (LIBRARIAN_OPENER.test(line)) inHuman = false;
    else if (inHuman) lines.add(i + 1);
  });
  return lines;
}
