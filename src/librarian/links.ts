// One wikilink grammar for every tool that reads or rewrites links. Ported from hoard's
// links.py.
//
// Obsidian resolves `[[X]]` by basename or path, case-insensitively, and never through a
// frontmatter alias. So a tool that repairs a link to an alias rewrites the target and
// keeps the display half byte for byte, and the pattern here captures every half.
import { FrontmatterError, LIST_ITEM, isMapping, keyRange, loadYaml, locateFrontmatter } from './frontmatter.ts';
import { getLogger } from './log.ts';
import { pyStrip, splitlines } from './py.ts';

const log = getLogger('librarian.links');

// `target` stops at `|`, `#`, `^` or `]`; `anchor` keeps its marker (`#Heading`,
// `^block`); `display` keeps its pipe, escaped or not. No group crosses a line, so a
// stray `[[` never swallows the line below. `\|` is Obsidian's escape for a display pipe
// in a table cell: it opens the display, and a backslash is part of a target only when
// no pipe follows it.
const TARGET = String.raw`(?:[^\]|#^\n\\]|\\(?!\|))+?`;
const ANCHOR = String.raw`[#^](?:[^\]|\n\\]|\\(?!\|))*`;
const DISPLAY = String.raw`\\?\|[^\]\n]*`;
export const WIKILINK = new RegExp(
  String.raw`(?<embed>!?)\[\[\s*(?<target>${TARGET})\s*(?<anchor>${ANCHOR})?(?<display>${DISPLAY})?\]\]`, 'gu');
/** The same grammar with one numbered group, the target, for composing into a larger pattern. */
export const LINK_SRC = String.raw`\[\[\s*(${TARGET})\s*(?:${ANCHOR})?(?:${DISPLAY})?\]\]`;
export const LINK = new RegExp(LINK_SRC, 'gu');
const TOPIC_ITEM = /^(\s*-\s*)(.*)$/u;

/**
 * The resolution key of a link target or page name: NFC, path and `.md` stripped, lower
 * case. Diacritics are never folded. U+0130 is replaced first, because lowering it is
 * the one case mapping that lengthens a string, and a two-character key could never
 * match the one character a writer types.
 */
export function key(name: string): string {
  const flat = pyStrip(name.normalize('NFC').replaceAll('İ', 'i'));
  const trimmed = pyStrip(flat, '/');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return (base.endsWith('.md') ? base.slice(0, -3) : base).toLowerCase();
}

// A fence opens and closes on a line of three or more backticks or tildes, indented or
// not. Readers toggle one boolean on such a line and do not track the two markers apart.
const FENCE = /^[ \t]*(?:`{3,}|~{3,})/;

export function isFence(line: string): boolean {
  return FENCE.test(line);
}

/** Inline code blanked, length kept (in UTF-16 units), so offsets stay meaningful. */
export function maskCodeSpans(line: string): string {
  let out = '';
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '`') {
      inCode = !inCode;
      out += ' ';
    } else {
      out += inCode ? ' ' : ch;
    }
  }
  return out;
}

/**
 * One wikilink as written, with enough position to rewrite it in place. `lineno` is the
 * file line, from 1. `span` indexes the raw body line for a body link, or `value` for a
 * topics entry. `quote` is the YAML quote around a topics scalar, empty where the entry
 * is not a quoted block-list scalar and so cannot be spliced.
 */
export interface Occurrence {
  lineno: number;
  where: 'body' | 'topics';
  embed: string;
  target: string;
  anchor: string;
  display: string;
  span: [number, number];
  quote: string;
  value: string;
}

export function linkText(o: Occurrence): string {
  return `${o.embed}[[${o.target}${o.anchor}${o.display}]]`;
}

function matches(text: string, lineno: number, where: Occurrence['where'], quote = '', value = ''): Occurrence[] {
  return [...text.matchAll(WIKILINK)].map((m) => ({
    lineno,
    where,
    embed: m.groups!['embed']!,
    target: m.groups!['target']!,
    anchor: m.groups!['anchor'] ?? '',
    display: m.groups!['display'] ?? '',
    span: [m.index, m.index + m[0].length] as [number, number],
    quote,
    value,
  }));
}

/** yaml.safe_load of one line, or undefined after logging why it would not load. */
function loadLine(text: string, what: string): { value: unknown } | undefined {
  try {
    return { value: loadYaml(text) };
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    log.warning(`${what} did not parse: ${err.message}`);
    return undefined;
  }
}

/**
 * Links in the `topics` block. Quoted block-list items can be rewritten; a flow list or
 * a bare scalar on the key line is reported with quote '' so a reader sees it and a
 * rewriter refuses it.
 */
function topicOccurrences(fmLines: string[]): Occurrence[] {
  const range = keyRange(fmLines, 'topics');
  if (range === null) return [];
  const [start, end] = range;
  const found: Occurrence[] = [];
  const head = fmLines[start]!.replace(/[\r\n]+$/, '');
  const afterColon = head.slice(head.indexOf(':') + 1);
  if (pyStrip(afterColon)) {
    // The flow-style key is reported unwritable through quote ''; a parse failure is logged.
    const parsed = loadLine(head, `topics flow key of line ${start + 2}`);
    const items = parsed && isMapping(parsed.value) ? parsed.value['topics'] : undefined;
    for (const item of Array.isArray(items) ? items : [items]) {
      if (typeof item === 'string') found.push(...matches(item, start + 2, 'topics', '', item));
    }
  }
  for (let i = start + 1; i < end; i++) {
    const line = fmLines[i]!.replace(/[\r\n]+$/, '');
    const m = TOPIC_ITEM.exec(line);
    if (!m || !LIST_ITEM.test(line)) continue;
    const rest = m[2]!;
    // The item is skipped, since no link can be spliced from it, and the skip is logged.
    const loaded = loadLine(rest, `topics item on frontmatter line ${i + 2}`);
    if (!loaded || typeof loaded.value !== 'string') continue; // `- [[x]]` is a nested flow list
    const quote = rest[0] === "'" || rest[0] === '"' ? rest[0] : '';
    found.push(...matches(loaded.value, i + 2, 'topics', quote, loaded.value));
  }
  return found;
}

/**
 * Every wikilink in a note, frontmatter `topics` first, then the body. Fenced blocks and
 * inline code are documentation, not graph edges. Blockquotes count: the author's quoted
 * bytes carry real links. `provenance.legacy_frontmatter` sits outside the `topics` key
 * range by construction and is never reached.
 */
export function occurrences(text: string): Occurrence[] {
  const lines = splitlines(text, true);
  const close = locateFrontmatter(lines);
  const found: Occurrence[] = [];
  let bodyStart = 0;
  if (close !== null) {
    found.push(...topicOccurrences(lines.slice(1, close)));
    bodyStart = close + 1;
  }
  let inFence = false;
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]!.replace(/[\r\n]+$/, '');
    if (isFence(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Matched on the masked line; masking keeps length, so every span indexes the raw one.
    found.push(...matches(maskCodeSpans(line), i + 1, 'body'));
  }
  return found;
}

/** Every wikilink target in a note, as written, display and anchor dropped. */
export function linksIn(text: string): string[] {
  return occurrences(text).map((o) => o.target);
}
