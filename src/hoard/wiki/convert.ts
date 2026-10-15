// A hoard Markdown page as wiki paragraphs. The words arrive as written: each non-blank
// line of the body is one paragraph holding the line's text, Markdown and all, because
// a place, a mark, blame and replace all count paragraphs, and a later Markdown export
// puts the page back line for line. Inside a code fence every line is kept, a blank one
// as an empty paragraph.
//
// The frontmatter is handed back apart, as read. CriticMarkup marks become marks: the
// text reads as if every mark were rejected (hoard's stripMarks), and each mark is
// placed on the words it was about. A comment straight after another mark is that
// mark's first words; after a highlight it makes the highlight a comment. Whatever
// cannot be a mark here (a lone comment, an AI mark, a mark across lines, an empty one)
// stays in the text as written and is counted, so no word is lost.
//
// Pure: no file is read, no clock read, no id made.
import type { MarkKind, MarkWho } from '../../generated/hoard-marks-v1.js';
import { split } from '../../librarian/frontmatter.ts';
import { isFence } from '../../librarian/links.ts';
import { findMarks, type Mark as CriticMark } from '../../librarian/marks.ts';
import { PyDate } from '../../librarian/py.ts';

/** A mark found in the page, placed in its paragraphs; len 0 for an insertion. */
export interface PageMark {
  kind: MarkKind;
  pIdx: number;
  off: number;
  len: number;
  proposed?: string;
  body?: string;
  who: MarkWho;
  /** The mark's own date as an ISO time, or null when it gave none that reads. */
  at: string | null;
}

export interface ConvertedPage {
  paragraphs: string[];
  /** The paragraphs as NEO writes a chapter. */
  html: string;
  frontmatter: Record<string, unknown> | null;
  marks: PageMark[];
  /** Marks left in the text because they cannot be marks here. */
  keptAsText: number;
}

const SUGGESTIONS = new Set(['insertion', 'deletion', 'substitution']);

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** NEO's chapter HTML for these paragraphs: compact, an empty one holding a break. */
export function paragraphsHtml(paragraphs: readonly string[]): string {
  return paragraphs.map((p) => (p === '' ? '<p><br></p>' : `<p>${escapeHtml(p)}</p>`)).join('');
}

// Frontmatter as plain JSON: a YAML date stays the text it was written as.
function plain(value: unknown): unknown {
  if (value instanceof PyDate) return value.text;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

function whoOf(mark: CriticMark): MarkWho {
  return (mark.attrs['author'] ?? '').toLowerCase() === 'librarian' ? 'librarian' : 'author';
}

function atOf(mark: CriticMark): string | null {
  const date = mark.attrs['date'];
  if (!date) return null;
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// The words a rejected mark leaves on the page.
function kept(mark: CriticMark): string {
  return mark.kind === 'insertion' ? '' : mark.authorText;
}

// A mark that can stand on its own here: on one line, with words to stand on (or, for
// an insertion, words to put in).
function usable(mark: CriticMark, text: string): boolean {
  if (text.slice(mark.start, mark.end).includes('\n')) return false;
  if (mark.kind === 'insertion') return mark.proposedText !== '';
  if (mark.kind === 'substitution') return mark.authorText !== '' && mark.proposedText !== '';
  return (mark.kind === 'deletion' || mark.kind === 'highlight') && mark.authorText !== '';
}

interface Taken {
  mark: CriticMark;
  /** The comment that follows it, if any, taken with it. */
  comment: CriticMark | null;
}

// Which marks become marks: each usable one, with the comment straight after it.
function take(marks: CriticMark[], text: string): { taken: Taken[]; left: number } {
  const taken: Taken[] = [];
  let left = 0;
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const next = marks[i + 1];
    const comment = next && next.kind === 'comment' && next.start === mark.end ? next : null;
    const ok = mark.kind !== 'comment' && usable(mark, text)
      && (!comment || (comment.commentText.trim() !== '' && !text.slice(comment.start, comment.end).includes('\n')));
    if (ok) taken.push({ mark, comment });
    else left += comment ? 2 : 1;
    if (comment) i++;
  }
  return { taken, left };
}

export function convertPage(source: string): ConvertedPage {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const { fm, body } = split(text);
  const { taken, left } = take(findMarks(body), body);

  // The body with each taken mark rejected, and where each one's words now start.
  let out = '';
  let at = 0;
  const starts: number[] = [];
  for (const { mark, comment } of taken) {
    out += body.slice(at, mark.start);
    starts.push(out.length);
    out += kept(mark);
    at = (comment ?? mark).end;
  }
  out += body.slice(at);

  const lines = out.split('\n');
  const lineStarts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    lineStarts.push(pos);
    pos += line.length + 1;
  }
  const lineOf = (offset: number) => {
    let i = lineStarts.length - 1;
    while (i > 0 && lineStarts[i]! > offset) i--;
    return i;
  };
  const holdsMark = new Set(starts.map(lineOf));

  const paragraphs: string[] = [];
  const pIdxOf = new Map<number, number>();
  let inFence = false;
  lines.forEach((line, i) => {
    const fence = isFence(line);
    const last = i === lines.length - 1 && line === ''; // after the final newline
    if (holdsMark.has(i) || (!last && (fence || inFence || line.trim() !== ''))) {
      pIdxOf.set(i, paragraphs.length);
      paragraphs.push(line);
    }
    if (fence) inFence = !inFence;
  });
  if (paragraphs.length === 0) paragraphs.push('');

  const marks = taken.map(({ mark, comment }, n): PageMark => {
    const line = lineOf(starts[n]!);
    const words = kept(mark);
    const kind: MarkKind = mark.kind === 'highlight' && comment ? 'comment' : mark.kind as MarkKind;
    const found: PageMark = {
      kind, pIdx: pIdxOf.get(line)!, off: starts[n]! - lineStarts[line]!, len: words.length, who: whoOf(mark), at: atOf(mark),
    };
    if (SUGGESTIONS.has(mark.kind) && mark.kind !== 'deletion') found.proposed = mark.proposedText;
    if (comment) found.body = comment.commentText.trim();
    return found;
  });

  return {
    paragraphs,
    html: paragraphsHtml(paragraphs),
    frontmatter: fm === null ? null : plain(fm) as Record<string, unknown>,
    marks,
    keptAsText: left,
  };
}
