// Splits a Markdown page that has become a scratchpad into blocks, so each can be
// labelled on its own. A heading is too coarse: ideas sit inside a journal's paragraphs
// and under a task item. So a block is one top-level Markdown block (a paragraph, a
// top-level list item with everything nested under it, a fence, a quote, a table, a
// comment, the frontmatter). Headings and separators are context, never blocks.
import { createHash } from 'node:crypto';

export type BlockKind = 'frontmatter' | 'paragraph' | 'list-item' | 'fence' | 'quote' | 'table' | 'comment';

export interface Block {
  /** First 10 hex of the text's SHA-256; a repeat in the page gets `-2`, `-3`. */
  id: string;
  kind: BlockKind;
  /** 1-based line numbers, inclusive. */
  start: number;
  end: number;
  /** The headings above the block, outermost first. */
  heading: string[];
  /** The block's lines exactly as on the page, joined with \n. */
  text: string;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const SEPARATOR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const QUOTE = /^ {0,3}>/;
const TABLE = /^ {0,3}\|/;
const YAML_LINE = /^(?:[\w.-]+\s*:|\s|-\s|-$|#)/;

const blank = (line: string) => line.trim() === '';
const indented = (line: string) => /^(?: {2,}|\t)/.test(line);

function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') return i;
    if (!blank(line) && !YAML_LINE.test(line)) return -1;
  }
  return -1;
}

export function splitBlocks(page: string): Block[] {
  const lines = page.split(/\r\n|\r|\n/);
  const out: Omit<Block, 'id'>[] = [];
  const headings: { level: number; text: string }[] = [];
  const push = (kind: BlockKind, from: number, to: number) => {
    out.push({ kind, start: from + 1, end: to + 1, heading: headings.map((h) => h.text), text: lines.slice(from, to + 1).join('\n') });
  };

  let i = 0;
  const fm = frontmatterEnd(lines);
  if (fm > 0) {
    push('frontmatter', 0, fm);
    i = fm + 1;
  }

  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line) || SEPARATOR.test(line)) {
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1]!.length;
      while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop();
      headings.push({ level, text: h[2]! });
      i++;
      continue;
    }
    const start = i;
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(mark[0]!.repeat(mark.length))) i++;
      push('fence', start, Math.min(i, lines.length - 1));
      i++;
      continue;
    }
    if (line.trimStart().startsWith('%%')) {
      // Runs to the line holding the closing %% (the same line when it closes there).
      let end = i;
      const closesHere = line.trimStart().slice(2).includes('%%');
      if (!closesHere) {
        end++;
        while (end < lines.length && !lines[end]!.includes('%%')) end++;
      }
      end = Math.min(end, lines.length - 1);
      push('comment', start, end);
      i = end + 1;
      continue;
    }
    if (QUOTE.test(line) || TABLE.test(line)) {
      const re = QUOTE.test(line) ? QUOTE : TABLE;
      while (i + 1 < lines.length && re.test(lines[i + 1]!)) i++;
      push(re === QUOTE ? 'quote' : 'table', start, i);
      i++;
      continue;
    }
    if (LIST.test(line)) {
      // The item owns indented lines, lazy continuation lines, and blank lines that are
      // followed by more indented lines. A new top-level marker or an unindented line
      // after a blank ends it.
      let end = i;
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        if (blank(next)) {
          let k = j;
          while (k < lines.length && blank(lines[k]!)) k++;
          if (k < lines.length && indented(lines[k]!)) {
            j = k;
            continue;
          }
          break;
        }
        if (indented(next)) {
          end = j++;
          continue;
        }
        if (LIST.test(next) || HEADING.test(next) || SEPARATOR.test(next) || FENCE.test(next) || QUOTE.test(next)) break;
        end = j++;
      }
      push('list-item', start, end);
      i = end + 1;
      continue;
    }
    let end = i;
    while (end + 1 < lines.length) {
      const next = lines[end + 1]!;
      if (blank(next) || HEADING.test(next) || SEPARATOR.test(next) || FENCE.test(next) || LIST.test(next)
        || QUOTE.test(next) || TABLE.test(next) || next.trimStart().startsWith('%%')) break;
      end++;
    }
    push('paragraph', start, end);
    i = end + 1;
  }

  const seen = new Map<string, number>();
  return out.map((b) => {
    const base = blockHash(b.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { id: n === 1 ? base : `${base}-${n}`, ...b };
  });
}

/** The id's hash: trailing spaces on a line don't change it. */
export function blockHash(text: string): string {
  const norm = text.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  return createHash('sha256').update(norm).digest('hex').slice(0, 10);
}
