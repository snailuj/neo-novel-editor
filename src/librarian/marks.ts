// CriticMarkup marks: the one parser the lint and quote checks share. Ported from
// hoard's marks.py.
//
// The grammar is the Track Changes plugin's, frozen on 2026-09-22. Six forms, `{++ins++}`,
// `{--del--}`, `{~~old~>new~~}`, `{==hl==}`, `{>>comment<<}` and `{=+ai+=}`, each with an
// optional attribute prefix inside the opening brace: `{author="X" date="D"++text++}`.
// There is no escaping, so a malformed mark is literal prose, reported and never
// repaired. Marks do not nest: an inner mark is the outer mark's content, and the first
// closer wins. A mark may wrap lines inside a paragraph but never crosses a blank line.
//
// Content is split by ownership, not by form, because that is what every caller asks:
// authorText is what the author wrote and the mark proposes to change (a deletion, a
// substitution's old text, a highlighted span), proposedText is what the mark asks for,
// commentText is the annotation. The `author=` attribute does not decide this.
//
// Offsets are UTF-16 units throughout, consistently, so they index the JavaScript string
// the caller holds.
import { isFence, maskCodeSpans } from './links.ts';
import { getLogger } from './log.ts';
import { pyRepr, pyStrip } from './py.ts';

const log = getLogger('librarian.marks');

export type MarkKind = 'insertion' | 'deletion' | 'substitution' | 'highlight' | 'comment' | 'ai';
export type Mode = 'accept' | 'reject';
export const MODES: readonly Mode[] = ['accept', 'reject'];
type Span = [number, number];

/** One parsed mark. start and end bracket the whole mark, braces included. */
export interface Mark {
  kind: MarkKind;
  start: number;
  end: number;
  attrs: Record<string, string>;
  authorText: string;
  proposedText: string;
  commentText: string;
  /** The content itself holds a mark opener: legal, and almost always a mistake (TC2). */
  nested: boolean;
  authorSpan: Span | null;
  proposedSpan: Span | null;
  commentSpan: Span | null;
}

/** A candidate mark that does not parse, at its line from 1. */
export interface Malformed {
  lineno: number;
  opener: string;
  pos: number;
}

// The (repeated keys, prefix) pairs already warned about. One pass parses a page
// several times and the anomaly is one fact about one mark, so it is logged once per
// process. Bounded by the distinct offending prefixes in a vault.
export const WARNED = new Set<string>();

const SIGILS: Record<string, MarkKind> = {
  '++': 'insertion', '--': 'deletion', '~~': 'substitution', '==': 'highlight', '>>': 'comment', '=+': 'ai',
};
const CLOSERS: Record<MarkKind, string> = {
  insertion: '++}', deletion: '--}', substitution: '~~}', highlight: '==}', comment: '<<}', ai: '+=}',
};
const ARROW = '~>';
// From the plugin's parser: the value class forbids `"`, `{`, `}` and a newline, which
// stops an unclosed quote swallowing across a brace or a line.
const META_PAIR = String.raw`[A-Za-z][\p{L}\p{N}_-]*="[^"{}\n]*"`;
const META_PREFIX = new RegExp(String.raw`${META_PAIR}(?:[ \t]+${META_PAIR})*[ \t]*`, 'uy');
// What makes a `{` a candidate rather than prose: a sigil, or the start of an attribute.
const ATTR_START = /[A-Za-z][\p{L}\p{N}_-]*="/uy;
const OPENERS = Object.keys(SIGILS).map((s) => s.replace(/[+=>~-]/g, (c) => (c === '+' ? '\\+' : c))).join('|');
const OPENER = new RegExp(String.raw`\{(?:${META_PAIR}(?:[ \t]+${META_PAIR})*[ \t]*)?(?:${OPENERS})`, 'u');
// A paragraph break: a line end followed by a whitespace-only line, under LF or CRLF.
const PARAGRAPH_BREAK = /\r?\n[ \t]*\r?\n/g;

function stickyMatch(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** str.find(sub, start, end): the whole of sub must lie before end. */
function findBefore(text: string, sub: string, start: number, end: number): number {
  const at = text.indexOf(sub, start);
  return at >= 0 && at + sub.length <= end ? at : -1;
}

/**
 * The text with every code region blanked, length and newlines kept. Track Changes skips
 * fenced and inline code, and a Tandem Comments block is a fence too, so its JSON goes
 * with it while footnotes after it stay readable.
 */
function codeMask(text: string): string {
  let inFence = false;
  return text.split('\n').map((line) => {
    if (isFence(line)) {
      inFence = !inFence;
      return ' '.repeat(line.length);
    }
    return inFence ? ' '.repeat(line.length) : maskCodeSpans(line);
  }).join('\n');
}

/** First index in sorted `values` greater than `x` (bisect_right). */
function bisectRight(values: number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < values[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function lineCounter(text: string): (pos: number) => number {
  const newlines: number[] = [];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) newlines.push(i);
  // newlines before pos, plus one
  return (pos) => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };
}

/**
 * One left-to-right pass yielding marks and malformed candidates in document order. At
 * each `{` the prefix is matched, then the sigil, then the closer is searched for no
 * further than the next paragraph break. A parsed mark resumes the scan at its end, so an
 * inner mark is never revisited. O(n * L) at worst, L the longest paragraph, and O(n) on
 * text whose braces are ordinary prose.
 */
function* scan(text: string): Generator<Mark | Malformed> {
  const masked = codeMask(text);
  // Breaks come from the raw text: the mask blanks a line of inline code to spaces,
  // which would read as a phantom blank line and cut a mark wrapping over it.
  const breaks = [...text.matchAll(PARAGRAPH_BREAK)].map((m) => m.index);
  const lineOf = lineCounter(masked);
  const end = masked.length;
  let pos = 0;
  for (;;) {
    const i = masked.indexOf('{', pos);
    if (i < 0) return;
    const prefix = stickyMatch(META_PREFIX, masked, i + 1);
    const j = prefix ? i + 1 + prefix[0].length : i + 1;
    const sigil = masked.slice(j, j + 2);
    const kind = Object.hasOwn(SIGILS, sigil) ? SIGILS[sigil]! : undefined;
    if (kind === undefined) {
      const attr = stickyMatch(ATTR_START, masked, i + 1);
      // A prefix that does not close its quote before the sigil: literal text to the plugin.
      if (attr) yield { lineno: lineOf(i), opener: `{${attr[0].slice(0, -1)}`, pos: i };
      pos = i + 1;
      continue;
    }
    const b = bisectRight(breaks, i);
    const limit = b < breaks.length ? Math.min(breaks[b]!, end) : end;
    const body = j + 2;
    let arrow = -1;
    if (kind === 'substitution') {
      arrow = findBefore(masked, ARROW, body, limit);
      if (arrow < 0) {
        yield { lineno: lineOf(i), opener: `{${sigil}`, pos: i };
        pos = i + 1;
        continue;
      }
    }
    const close = findBefore(masked, CLOSERS[kind], arrow >= 0 ? arrow + 2 : body, limit);
    if (close < 0) {
      yield { lineno: lineOf(i), opener: `{${sigil}`, pos: i };
      pos = i + 1;
      continue;
    }
    const stop = close + 3;
    yield build(text, kind, i, stop, prefix ? attributes(text.slice(i + 1, j)) : {}, body, arrow, close);
    pos = stop;
  }
}

/**
 * The prefix as a mapping, keys lower-cased. A key given more than once (after lowering,
 * empty values counted) is ambiguous and is dropped, so it reads as absent: the fail-
 * closed reading, since an unattributed mark is protected. An empty value is dropped too.
 */
function attributes(raw: string): Record<string, string> {
  const pairs = [...raw.matchAll(new RegExp(META_PAIR, 'gu'))].map((m) => {
    const at = m[0].indexOf('=');
    return [m[0].slice(0, at), m[0].slice(at + 1)] as const;
  });
  const counts = new Map<string, number>();
  for (const [k] of pairs) counts.set(k.toLowerCase(), (counts.get(k.toLowerCase()) ?? 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 1).map(([k]) => k).sort();
  const memo = JSON.stringify([repeated, raw]);
  if (repeated.length && !WARNED.has(memo)) {
    WARNED.add(memo);
    log.warning(`marks: attribute ${repeated.join(', ')} given more than once in ${pyRepr(raw)}; read as absent`);
  }
  const found: Record<string, string> = {};
  for (const [k, v] of pairs) {
    const name = k.toLowerCase();
    const value = pyStrip(v, '"');
    if (value && counts.get(name) === 1) found[name] = value;
  }
  return found;
}

function build(text: string, kind: MarkKind, start: number, stop: number, attrs: Record<string, string>,
  body: number, arrow: number, close: number): Mark {
  let author: Span | null = null;
  let proposed: Span | null = null;
  let comment: Span | null = null;
  if (kind === 'substitution') {
    author = [body, arrow];
    proposed = [arrow + 2, close];
  } else if (kind === 'deletion' || kind === 'highlight') {
    // A highlight points at prose that already stands, so its content is the author's.
    author = [body, close];
  } else if (kind === 'insertion' || kind === 'ai') {
    proposed = [body, close];
  } else {
    comment = [body, close];
  }
  const slice = (span: Span | null) => (span ? text.slice(span[0], span[1]) : '');
  return {
    kind, start, end: stop, attrs,
    authorText: slice(author), proposedText: slice(proposed), commentText: slice(comment),
    nested: OPENER.test(text.slice(body, close)),
    authorSpan: author, proposedSpan: proposed, commentSpan: comment,
  };
}

function isMark(item: Mark | Malformed): item is Mark {
  return 'kind' in item;
}

/** Every well-formed mark in the text, in document order. */
export function findMarks(text: string): Mark[] {
  return [...scan(text)].filter(isMark);
}

/** Every candidate mark that does not parse, in document order. */
export function malformed(text: string): Malformed[] {
  return [...scan(text)].filter((item): item is Malformed => !isMark(item));
}

/** The mark covering pos, or null. Marks do not overlap, so at most one. */
export function markAt(text: string, pos: number): Mark | null {
  return findMarks(text).find((m) => m.start <= pos && pos < m.end) ?? null;
}

/**
 * The one content span a mode keeps, or null. Accept keeps what the mark proposes and
 * highlighted prose; reject keeps the author's standing bytes. A comment leaves nothing
 * either way, as the plugin's finalize strips every comment.
 */
function kept(mark: Mark, mode: Mode): Span | null {
  if (mark.kind === 'highlight') return mark.authorSpan;
  if (mark.kind === 'comment') return null;
  return mode === 'accept' ? mark.proposedSpan : mark.authorSpan;
}

function checkMode(mode: string): void {
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new RangeError(`mode must be one of ('accept', 'reject'), not ${pyRepr(mode)}`);
  }
}

/**
 * The text as it would read with every mark accepted or rejected: the whole mark,
 * prefix included, replaced by what the mode keeps. Use it where the prose's shape
 * matters; use mask where a line number must survive.
 */
export function resolve(text: string, mode: Mode): string {
  checkMode(mode);
  let out = '';
  let at = 0;
  for (const mark of findMarks(text)) {
    out += text.slice(at, mark.start);
    const span = kept(mark, mode);
    if (span) out += text.slice(span[0], span[1]);
    at = mark.end;
  }
  return out + text.slice(at);
}

/** The author's prose as it stood before any mark was written. */
export function stripMarks(text: string): string {
  return resolve(text, 'reject');
}

/** The text with every mark blanked but the kept spans; newlines stay, so lines hold. */
function blanked(text: string, keep: Span[], marks: Mark[]): string {
  const chars = text.split('');
  for (const mark of marks) {
    for (let p = mark.start; p < mark.end; p++) if (chars[p] !== '\n') chars[p] = ' ';
  }
  for (const [lo, hi] of keep) for (let p = lo; p < hi; p++) chars[p] = text[p]!;
  return chars.join('');
}

/** resolve without moving a byte: what a mode drops becomes spaces, newlines stay. */
export function mask(text: string, mode: Mode): string {
  checkMode(mode);
  const found = findMarks(text);
  return blanked(text, found.map((m) => kept(m, mode)).filter((s): s is Span => s !== null), found);
}

/**
 * The librarian's own prose, length kept: what marks propose and what they comment,
 * author bytes and chrome blanked. Ownership follows the form, not `author=`.
 */
export function librarianMask(text: string): string {
  const found = findMarks(text);
  const keep = found.flatMap((m) => [m.proposedSpan, m.commentSpan]).filter((s): s is Span => s !== null);
  return blanked(text, keep, found);
}

/**
 * Every content word kept and only the chrome blanked: braces, the prefix, the sigils and
 * a substitution's `~>`. A quote scanner needs it: `author="Claude"` would otherwise read
 * as a quotation and leave its quote marks unpaired for the rest of the page.
 */
export function maskChrome(text: string): string {
  const found = findMarks(text);
  const keep = found.flatMap((m) => [m.authorSpan, m.proposedSpan, m.commentSpan])
    .filter((s): s is Span => s !== null);
  return blanked(text, keep, found);
}
