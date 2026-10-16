// A hoard Markdown page as a NEO page. NEO's chapters are paragraphs, and a place, a
// mark, blame and replace all count paragraphs, so each block of the page becomes one
// <p> whose class names what it was, as a script's lines do: wiki-h1 to wiki-h6,
// wiki-li (with its depth, its number or its tick), wiki-quote, wiki-callout,
// wiki-code (one per line, a blank one too), wiki-table (a row as written), and NEO's
// own scene-break for a rule. A plain paragraph has no class. Every line of the body
// with words on it is a block of its own, as in Obsidian, where a single line break
// shows. Emphasis becomes NEO's b, i and s (inline.ts); links stay as typed.
//
// Every block carries data-block, the id a citation points at ([[Page#^id]]): the
// block's own ^id where the page gives one, on its line or alone on the next, else a
// new one. As with NEO's data-sec-id, the first paragraph holding an id owns it, since
// Enter copies the attribute onto the new paragraph.
//
// Each block says whose it is, for blame: quotations and code are the author's, as
// hoard counts them (lint's citable text), except a quotation's `-- [[page]]`
// attribution line; the rest is the librarian's.
//
// The frontmatter is handed back apart, as read. CriticMarkup marks become marks: the
// text reads as if every mark were rejected (hoard's stripMarks), and each mark is
// placed on the words it was about. A comment straight after another mark is that
// mark's first words; after a highlight it makes the highlight a comment. Whatever
// cannot be a mark here (a lone comment, an AI mark, a mark across lines, an empty one)
// stays in the text as written and is counted, so no word is lost.
//
// Pure: no file is read and no clock read; ids come from the newId given.
import type { MarkKind, MarkWho } from '../../generated/hoard-marks-v1.js';
import { split } from '../../librarian/frontmatter.ts';
import { isFence } from '../../librarian/links.ts';
import { findMarks, type Mark as CriticMark } from '../../librarian/marks.ts';
import { PyDate } from '../../librarian/py.ts';
import { inline } from './inline.ts';

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

export type BlockKind = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'quote' | 'callout' | 'code' | 'table' | 'break';

export interface Block {
  kind: BlockKind;
  id: string;
  owner: 'author' | 'librarian';
  /** What the page shows: the paragraph's textContent. */
  text: string;
  /** The paragraph's HTML inside its <p>. */
  inner: string;
  /** data-* attributes besides data-block, in the order written. */
  data: [string, string][];
}

export interface ConvertedPage {
  blocks: Block[];
  /** Each block's text, as the window counts paragraphs. */
  paragraphs: string[];
  /** The page as NEO writes a chapter. */
  html: string;
  frontmatter: Record<string, unknown> | null;
  marks: PageMark[];
  /** Marks left in the text because they cannot be marks here. */
  keptAsText: number;
}

const SUGGESTIONS = new Set(['insertion', 'deletion', 'substitution']);

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (text: string) => escapeHtml(text).replace(/"/g, '&quot;');

const CLASS: Record<BlockKind, string> = {
  p: '', h1: 'wiki-h1', h2: 'wiki-h2', h3: 'wiki-h3', h4: 'wiki-h4', h5: 'wiki-h5', h6: 'wiki-h6',
  li: 'wiki-li', quote: 'wiki-quote', callout: 'wiki-callout', code: 'wiki-code', table: 'wiki-table', break: 'scene-break',
};

function blockHtml(b: Block): string {
  const cls = CLASS[b.kind] ? ` class="${CLASS[b.kind]}"` : '';
  const data = b.data.map(([k, v]) => ` data-${k}="${escapeAttr(v)}"`).join('');
  return `<p${cls}${data} data-block="${escapeAttr(b.id)}">${b.inner || '<br>'}</p>`;
}

/**
 * NEO's chapter HTML for these blocks: compact, an empty one holding a break. With an
 * owner, only that owner's blocks, as the history's first commit of an import has them;
 * a page with none is one empty paragraph.
 */
export function pageHtml(blocks: readonly Block[], owner?: Block['owner']): string {
  const kept = owner ? blocks.filter((b) => b.owner === owner) : blocks;
  return kept.length ? kept.map(blockHtml).join('') : '<p><br></p>';
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

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/d;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?/;
const CALLOUT = /^\[!([A-Za-z0-9_-]+)\][+-]?[ \t]*/;
const ITEM = /^([ \t]*)([-*+]|(\d{1,9})[.)])(?:[ \t]+|$)/;
const TASK = /^\[([ xX])\](?:[ \t]+|$)/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const OWN_ID = /[ \t]+\^([A-Za-z0-9-]+)[ \t]*$/;
const ID_LINE = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/;
const ATTRIBUTION = /^--\s*\[\[/;

const width = (indent: string) => [...indent].reduce((n, c) => n + (c === '\t' ? 4 : 1), 0);

// A block in the making: the line it came from, where its words start in that line, and
// how each unit of the line from there lands in its text.
interface Made extends Block {
  line: number;
  from: number;
  map: number[] | null;
}

function counter(): () => string {
  let n = 0;
  return () => `b${++n}`;
}

export function convertPage(source: string, newId: () => string = counter()): ConvertedPage {
  const text = source.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
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

  const blocks: Made[] = [];
  const blockOfLine = new Map<number, number>();
  const make = (line: number, kind: BlockKind, from: number, words: string, data: [string, string][] = [], owner: Block['owner'] = 'librarian', plain = false) => {
    let id = '';
    if (kind !== 'code') {
      const own = OWN_ID.exec(words);
      if (own) {
        id = own[1]!;
        words = words.slice(0, own.index);
      }
    }
    const read = plain ? { text: words, html: escapeHtml(words), map: null } : inline(words);
    blockOfLine.set(line, blocks.length);
    blocks.push({ kind, id, owner, text: read.text, inner: read.html, data, line, from, map: read.map });
  };

  let fence: string | null = null;
  let lang = '';
  let indents: number[] = [];
  lines.forEach((line, i) => {
    const last = i === lines.length - 1 && line === ''; // after the final newline
    if (fence !== null) {
      if (isFence(line) && line.trim().startsWith(fence)) {
        fence = null;
        return;
      }
      if (!last) make(i, 'code', 0, line, lang ? [['lang', lang]] : [], 'author', true);
      return;
    }
    if (isFence(line)) {
      const marker = line.trim();
      fence = marker.slice(0, /^(`{3,}|~{3,})/.exec(marker)![0].length);
      lang = marker.slice(fence.length).trim();
      return;
    }
    if (line.trim() === '') {
      if (holdsMark.has(i)) make(i, 'p', 0, '');
      return;
    }
    const prev = blocks[blocks.length - 1];
    const ownId = ID_LINE.exec(line);
    if (ownId && prev && !prev.id) {
      prev.id = ownId[1]!;
      return;
    }
    const setext = SETEXT.exec(line);
    if (setext && prev && prev.kind === 'p' && prev.line === i - 1) {
      prev.kind = setext[1]![0] === '=' ? 'h1' : 'h2';
      return;
    }
    if (RULE.test(line)) {
      indents = [];
      blockOfLine.set(i, blocks.length);
      blocks.push({ kind: 'break', id: '', owner: 'librarian', text: '***', inner: '***', data: [], line: i, from: line.length, map: null });
      return;
    }
    const atx = ATX.exec(line);
    if (atx) {
      indents = [];
      const from = atx.indices![2]?.[0] ?? line.length;
      make(i, `h${atx[1]!.length}` as BlockKind, from, atx[2] ?? '');
      return;
    }
    if (QUOTE.test(line)) {
      indents = [];
      let depth = 0;
      let from = 0;
      for (let m = QUOTE.exec(line.slice(from)); m; m = QUOTE.exec(line.slice(from))) {
        depth++;
        from += m[0].length;
      }
      const words = line.slice(from);
      const callout = CALLOUT.exec(words);
      if (callout) {
        make(i, 'callout', from + callout[0].length, words.slice(callout[0].length), [['callout', callout[1]!.toLowerCase()]], 'author');
      } else {
        make(i, 'quote', from, words, [['depth', String(depth)]], ATTRIBUTION.test(words) ? 'librarian' : 'author');
      }
      return;
    }
    const item = ITEM.exec(line);
    if (item) {
      const w = width(item[1]!);
      while (indents.length && w < indents[indents.length - 1]!) indents.pop();
      if (!indents.length || w > indents[indents.length - 1]!) indents.push(w);
      const data: [string, string][] = [['depth', String(indents.length - 1)]];
      if (item[3] !== undefined) data.push(['n', String(Number(item[3]))]);
      let from = item[0].length;
      const task = TASK.exec(line.slice(from));
      if (task) {
        data.push(['task', task[1] === ' ' ? 'open' : 'done']);
        from += task[0].length;
      }
      make(i, 'li', from, line.slice(from), data);
      return;
    }
    indents = [];
    if (line.trimStart().startsWith('|')) {
      if (TABLE_RULE.test(line) && line.includes('-')) {
        if (prev && prev.kind === 'table' && prev.line === i - 1) prev.data.push(['head', '']);
        return;
      }
      make(i, 'table', 0, line.trimEnd());
      return;
    }
    const from = line.length - line.trimStart().length;
    make(i, 'p', from, line.slice(from).trimEnd());
  });
  if (blocks.length === 0) blocks.push({ kind: 'p', id: '', owner: 'librarian', text: '', inner: '', data: [], line: 0, from: 0, map: null });

  // ids: a page's own first, then new ones that none of them is
  const used = new Set<string>();
  for (const b of blocks) {
    if (b.id && used.has(b.id)) b.id = '';
    if (b.id) used.add(b.id);
  }
  for (const b of blocks) {
    if (b.id) continue;
    let id = newId();
    while (used.has(id)) id = newId();
    used.add(id);
    b.id = id;
  }

  // Where a mark's line offset lands in its block's text. A line that made no block
  // (a fence, an ^id line) puts its mark at the end of the block before it.
  const place = (line: number, off: number) => {
    let n = blockOfLine.get(line);
    if (n === undefined) {
      let k = line;
      while (k >= 0 && !blockOfLine.has(k)) k--;
      n = k < 0 ? 0 : blockOfLine.get(k)!;
      return { pIdx: n, at: blocks[n]!.text.length };
    }
    const b = blocks[n]!;
    const local = Math.min(Math.max(off - b.from, 0), b.map ? b.map.length - 1 : b.text.length);
    return { pIdx: n, at: b.map ? b.map[local]! : Math.min(local, b.text.length) };
  };

  const marks = taken.map(({ mark, comment }, n): PageMark => {
    const line = lineOf(starts[n]!);
    const off = starts[n]! - lineStarts[line]!;
    const words = kept(mark);
    const a = place(line, off);
    const z = place(line, off + words.length);
    const kind: MarkKind = mark.kind === 'highlight' && comment ? 'comment' : mark.kind as MarkKind;
    const found: PageMark = {
      kind, pIdx: a.pIdx, off: a.at, len: z.pIdx === a.pIdx ? Math.max(0, z.at - a.at) : 0, who: whoOf(mark), at: atOf(mark),
    };
    if (SUGGESTIONS.has(mark.kind) && mark.kind !== 'deletion') found.proposed = mark.proposedText;
    if (comment) found.body = comment.commentText.trim();
    return found;
  });

  const done: Block[] = blocks.map(({ kind, id, owner, text: words, inner, data }) => ({ kind, id, owner, text: words, inner, data }));
  return {
    blocks: done,
    paragraphs: done.map((b) => b.text),
    html: pageHtml(done),
    frontmatter: fm === null ? null : plain(fm) as Record<string, unknown>,
    marks,
    keptAsText: left,
  };
}
