// Frontmatter, read side: the one place the librarian parses YAML. Ported from hoard's
// frontmatter.py. Bodies are never touched: split hands back the body byte for byte.
// The write primitive (set_key) stays in hoard, because Neo keeps a page's metadata as
// structured data once it is imported and never writes YAML.
import { parse } from 'yaml';
import type { DocumentOptions, ParseOptions, SchemaOptions } from 'yaml';
import { PyDate, splitlines } from './py.ts';

export type Frontmatter = Record<string, unknown>;

/** The block would not parse, or parsed as something other than a mapping. */
export class FrontmatterError extends Error {
  override name = 'FrontmatterError';
}

const DELIM = '---\n';
const CLOSE = '\n---\n';

// PyYAML's safe_load: YAML 1.1 (`yes` is true), the last of two equal keys wins, and a
// timestamp is a date or datetime, kept here as its text so it never shifts a time zone.
const TIMESTAMP = 'tag:yaml.org,2002:timestamp';
type Tags = Exclude<NonNullable<SchemaOptions['customTags']>, unknown[]>;
const timestampsAsText: Tags = (tags) => tags.map((tag) => (
  typeof tag === 'object' && tag.tag === TIMESTAMP ? { ...tag, resolve: (text: string) => new PyDate(text) } : tag
)) as ReturnType<Tags>;
const OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = {
  version: '1.1',
  uniqueKeys: false,
  customTags: timestampsAsText,
};

/** yaml.safe_load: throws FrontmatterError where PyYAML raises YAMLError. */
export function loadYaml(text: string): unknown {
  try {
    return parse(text, OPTIONS);
  } catch (err) {
    throw new FrontmatterError(`malformed frontmatter: ${(err as Error).message}`);
  }
}

/**
 * The frontmatter mapping (null when there is none) and the body. LF only, as hoard's
 * split is: its readers saw text through universal newlines. An unterminated block is
 * no frontmatter, and the whole text is body.
 */
export function split(text: string): { fm: Frontmatter | null; body: string } {
  if (!text.startsWith(DELIM)) return { fm: null, body: text };
  const end = text.indexOf(CLOSE, DELIM.length - 1);
  if (end === -1) return { fm: null, body: text };
  const raw = text.slice(DELIM.length, end + 1);
  const body = text.slice(end + CLOSE.length);
  const fm = loadYaml(raw);
  if (fm !== null && fm !== undefined && !isMapping(fm)) throw new FrontmatterError('frontmatter is not a mapping');
  return { fm: (fm as Frontmatter | null | undefined) ?? null, body };
}

export function isMapping(value: unknown): value is Frontmatter {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof PyDate);
}

/**
 * Lines the frontmatter block occupies: body line N is FILE line N + offset. Zero
 * whenever split returns the whole text as body, so the two never disagree.
 */
export function bodyOffset(text: string): number {
  if (!text.startsWith(DELIM)) return 0;
  const end = text.indexOf(CLOSE, DELIM.length - 1);
  if (end === -1) return 0;
  return text.slice(0, end + CLOSE.length).split('\n').length - 1;
}

// A column-0 top-level key line, `key:` or `key: value`. A flush block-list item
// (`- item`) also starts at column 0 and is not one.
const TOP_KEY = /^[A-Za-z_][\p{L}\p{N}_-]*:/u;
/** A block-list line, indented or flush: `- item` or `  - item`. */
export const LIST_ITEM = /^\s*-(?:\s|$)/u;

export function terminator(line: string): string {
  if (line.endsWith('\r\n')) return '\r\n';
  if (line.endsWith('\n')) return '\n';
  return '';
}

/**
 * Index of the closing `---` line in lines split with their terminators, or null. CRLF
 * safe: it compares each line without its terminator.
 */
export function locateFrontmatter(lines: string[]): number | null {
  const bare = (line: string) => line.replace(/[\r\n]+$/, '');
  if (!lines.length || bare(lines[0]!) !== '---') return null;
  for (let i = 1; i < lines.length; i++) if (bare(lines[i]!) === '---') return i;
  return null;
}

/** [start, end) of `key`'s line and its continuation lines in the block's lines, or null. */
export function keyRange(fmLines: string[], key: string): [number, number] | null {
  const prefix = `${key}:`;
  const start = fmLines.findIndex((line) => line.startsWith(prefix));
  if (start === -1) return null;
  let end = start + 1;
  while (end < fmLines.length && !TOP_KEY.test(fmLines[end]!)) end++;
  return [start, end];
}

/** The text's lines with terminators, as Python's splitlines(keepends=True). */
export function linesWithEnds(text: string): string[] {
  return splitlines(text, true);
}
