// Receipt verification: every quoted string must appear in the page it cites. Ported
// from hoard's quotes.py.
//
// A heading merged away left librarian pages quoting it as a receipt, and nothing
// noticed, because the links all still resolved: verifying link targets is verifying the
// wrong thing. This checks the other half, the bytes between the quote marks. Receipts
// into librarian prose rot by construction, and receipts into author files rot whenever
// he edits, so this is a standing check, not a one-off audit.
//
// Three findings, deliberately separate:
//   QV1  the quoted text is not in the cited page at all: a dead receipt
//   QV2  it is there but cased differently. Informational: adapting a leading capital to
//        the sentence is standard quotation practice, so QV2 is printed but never fails
//   QV3  the page's frontmatter would not parse, so its receipts were not checked. A
//        skipped page must not read as a clean one, so this fails like QV1.
//
// The same ruling makes a bracketed insertion (`[Wren's] first mission`, `tie[d]`) an
// edit point rather than bytes: the text either side must appear in order, as with an
// elision.
import { BLOCK_CITE, BLOCK_CITE_NO_SPEAKER, FOOTER_CITE, INLINE_CITE, searchFrom } from './citations.ts';
import { FrontmatterError, bodyOffset, split } from './frontmatter.ts';
import { WIKILINK, isFence } from './links.ts';
import { getLogger } from './log.ts';
import { MODES, findMarks, maskChrome, resolve, stripMarks } from './marks.ts';
import { PageIndex } from './page-index.ts';
import { byCodePoint, casefold, pyLen, pyLstrip, pyRstrip, pySlice, pyStrip, splitlines } from './py.ts';
import { HOARD_LAYOUT, type Layout, startsWithAny } from './scheme.ts';
import { HUMAN_OPENER, LIBRARIAN_OPENER, humanSpanLines } from './spans.ts';
import type { Note } from './vault.ts';

const log = getLogger('librarian.quotes');

// Python's `\s`: it counts \x1c to \x1f and not \ufeff, the reverse of JavaScript's.
const S = String.raw`[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;

const ELISION = new RegExp(`${S}*(?:\\.\\.\\.|…)${S}*`, 'u');
// A single-bracketed span inside a QUOTATION is an editorial insertion, rewritten to an
// elision before matching. Applied to the needle only: in a source page `[text]` is just
// text. Wikilinks and `[text](url)` are excluded.
const EDIT = /(?<!\[)\[[^[\]]*\](?!\]|\()/gu;
export const INFORMATIONAL = ['QV2'];
// A markdown backslash escape is typography, like the emphasis beside it: a source writes
// `2009\.` only to stop `2009.` opening an ordered list. Unescaped FIRST, so `\*` is a
// bare `*` by the time the emphasis rule reaches it, and after the blockquote strip, so
// an escaped `>` is never read as a marker. ASCII punctuation only.
const ESCAPE = /\\([!-/:-@[-`{-~])/gu;
// Python's `^` under re.M follows `\n` only; JavaScript's also follows \r, \u2028 and
// \u2029, so the line start is spelled out.
const BLOCKQUOTE_MARK = /(?<![^\n])[ \t]*>+[ \t]?/gu;
// Pair EVERY pair of quote marks: a short span like "Gc" that is skipped rather than
// matched leaves its marks unconsumed, and the scanner then pairs the closer of one quote
// with the opener of the next. Length is judged after pairing, not during it.
const QUOTE_SPAN = /"([^"]*)"/gu;
export const MIN_QUOTE = 3;
const BULLET = new RegExp(`^${S}*[-*]${S}`, 'u');

/**
 * One quoted string and the page(s) whose bytes should contain it. Usually one. A footer
 * bullet that opens with its own citation and closes with another leaves a quote between
 * them genuinely ambiguous, and a checker that guesses turns a real ambiguity into a
 * false finding, so both candidates are carried and the claim stands if EITHER page has
 * the words.
 */
export interface Claim {
  lineno: number;
  text: string;
  targets: string[];
}

/** What a wikilink renders as: its alias, else its heading, else its name. */
function displayText(...args: unknown[]): string {
  const groups = args.at(-1) as Record<string, string | undefined>;
  if (groups['display']) return pyLstrip(groups['display'], '\\|');
  const anchor = groups['anchor'];
  return anchor ? anchor.slice(1) : groups['target']!;
}

/**
 * What two strings share when only typography differs: curly quotes, the vault's `--`
 * against a source's em dash, emphasis the librarian added, soft-wrap whitespace and the
 * spacing around a dash. Blockquote markers go here because BOTH sides need them gone:
 * a haystack that keeps them turns every quotation spanning a line break of a blockquote
 * into a false QV1.
 */
export function normalise(text: string): string {
  text = text.replace(BLOCKQUOTE_MARK, '');
  text = text.replace(ESCAPE, '$1');
  for (const [a, b] of [['’', "'"], ['‘', "'"], ['“', '"'], ['”', '"'], ['—', '-'], ['–', '-']] as const) {
    text = text.replaceAll(a, b);
  }
  text = text.replace(WIKILINK, displayText);
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1'); // [text](url)
  text = text.replace(/\[([^\]]+)\]/gu, '$1'); // [text]
  text = text.replace(/[*`]/gu, '');
  text = text.replace(new RegExp(`${S}+/${S}+`, 'gu'), ' '); // verse line breaks, rendered as ` / `
  text = text.replace(/-+/gu, '-');
  text = text.replace(new RegExp(`${S}*-${S}*`, 'gu'), '-');
  return pyStrip(text.replace(new RegExp(`${S}+`, 'gu'), ' '));
}

/**
 * Substring, but an elision means the fragments may be far apart. Order is enforced:
 * without it a quotation could be assembled from pieces the source never joined, the
 * very defect a receipt is meant to rule out.
 */
export function contains(haystack: string, needle: string): boolean {
  let at = 0;
  for (const fragment of needle.split(ELISION)) {
    const piece = pyStrip(fragment);
    if (!piece) continue;
    const found = haystack.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  return true;
}

export interface ClaimOptions {
  /** Body lines, from 1, that are the author's: they carry no librarian receipt. */
  protectedLines?: Set<number> | null;
}

type Unit = [lineno: number, text: string, isBlockquote: boolean];

/**
 * (line, text, is_blockquote) for each citable unit of a librarian page: a blockquote, a
 * list item or a paragraph, what one citation can own. Fenced code is documentation and
 * `> [!human]` spans are the author's bytes; neither carries a librarian receipt.
 */
function units(body: string, protectedLines: Set<number> | null): Unit[] {
  const out: Unit[] = [];
  let buffer: string[] = [];
  let start = 0;
  let inFence = false;
  let inHuman = false;
  const opensQuote = () => buffer.length > 0 && buffer[0]!.startsWith('>');
  const flush = (quoted = false) => {
    if (buffer.length) {
      out.push([start, buffer.join(' '), quoted]);
      buffer = [];
    }
  };
  splitlines(body).forEach((line, index) => {
    const i = index + 1;
    const stripped = pyStrip(line);
    if (isFence(line)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    // The raw line, not `stripped`: the marker allows up to three spaces of indent, and
    // four is a code block.
    if (HUMAN_OPENER.test(line)) {
      flush();
      inHuman = true;
      return;
    }
    if (LIBRARIAN_OPENER.test(line)) {
      flush();
      inHuman = false;
      return;
    }
    if (inHuman || protectedLines?.has(i) || !stripped || stripped.startsWith('#')) {
      flush(opensQuote());
      return;
    }
    if (stripped.startsWith('>') || BULLET.test(line)) {
      const wasQuote = opensQuote();
      if (buffer.length && (wasQuote !== stripped.startsWith('>') || BULLET.test(line))) flush(wasQuote);
    }
    if (!buffer.length) start = i;
    buffer.push(stripped);
  });
  flush(opensQuote());
  return out.filter(([, text]) => text);
}

/** The first citation at or after `pos`: [start, end, target, owns-forward]. */
function citationAt(text: string, pos: number): [number, number, string, boolean] | null {
  let best: [number, number, string, boolean] | null = null;
  for (const [pattern, forward] of [[INLINE_CITE, false], [BLOCK_CITE, false], [FOOTER_CITE, true]] as const) {
    const m = searchFrom(pattern, text, pos);
    if (m && (best === null || m.index < best[0])) best = [m.index, m.index + m[0].length, m[1]!, forward];
  }
  return best;
}

/**
 * Every quoted string on a librarian page, paired with the page it cites. A quote is
 * owned by the citation that FOLLOWS it, the vault's shape, where several quotes lead
 * into one receipt. The footer form inverts it (`- [[page]] (Speaker) -- description
 * "quote"`), so a citation that opens its unit owns what comes after instead.
 */
export function claims(body: string, { protectedLines = null }: ClaimOptions = {}): Claim[] {
  const found: Claim[] = [];
  const all = units(body, protectedLines);
  all.forEach(([lineno, raw, isQuote], i) => {
    const text = raw.replaceAll('“', '"').replaceAll('”', '"');
    if (isQuote) {
      let [bodyText, target] = splitAttribution(text);
      if (target === null && i + 1 < all.length) {
        // The other position the vault uses: the attribution on its own line after the
        // blockquote rather than inside it.
        const next = all[i + 1]![1];
        const [, following] = splitAttribution(`> ${next}`);
        target = next.startsWith('--') ? following : null;
      }
      if (target && pyStrip(bodyText)) found.push({ lineno, text: bodyText, targets: [target] });
      return;
    }
    let pending: string[] = [];
    let forwardTarget: string | null = null;
    let pos = 0;
    while (pos < text.length) {
      const quote = searchFrom(QUOTE_SPAN, text, pos);
      const cite = citationAt(text, pos);
      // A quote INSIDE the citation's parentheses is the locator ("My Summary"), not a
      // quotation of the source, so the comparison is against where the citation STARTS.
      // Comparing against its end read locators as quotes and then lost the citation
      // that owned the real ones.
      if (quote && (!cite || quote.index < cite[0])) {
        if (pyLen(pyStrip(quote[1]!)) >= MIN_QUOTE) pending.push(quote[1]!);
        pos = quote.index + quote[0].length;
        continue;
      }
      if (!cite) break;
      const [, end, target, forward] = cite;
      const owners = forwardTarget ? [target, forwardTarget] : [target];
      for (const q of pending) found.push({ lineno, text: q, targets: owners });
      pending = [];
      // A citation of its own clears the footer's forward claim: what comes after it is
      // nearer to IT. Trailing quotes with nothing after them stay unowned rather than
      // being pushed back onto the footer, which on a long bullet means quoting the
      // bullet's own earlier material.
      forwardTarget = forward ? target : null;
      pos = end;
    }
    // A footer bullet opens with its citation, so it owns what is left over, and only
    // that: a quote a LATER citation claims belongs to that later one.
    if (forwardTarget) for (const q of pending) found.push({ lineno, text: q, targets: [forwardTarget] });
  });
  return found;
}

/** A blockquote's text and the page its `-- [[page]] (Speaker)` line names. */
function splitAttribution(text: string): [string, string | null] {
  // Every `>` goes, not only the line openers: hoard splits on the character.
  const inner = text.split('>').filter((part) => pyStrip(part)).map((part) => pyStrip(pyLstrip(part, '>'))).join(' ');
  const m = searchFrom(BLOCK_CITE, inner, 0) ?? BLOCK_CITE_NO_SPEAKER.exec(inner);
  if (!m) return [inner, null];
  return [pyRstrip(inner.slice(0, m.index), ' -'), m[1]!];
}

/**
 * The author's bytes on a chimera page: text between a `> [!human]` marker and the next
 * `> [!librarian]` one, or the given protected body lines. A self-receipt vouches for
 * these lines only: the full page always contains its own claiming line, so checking
 * against it would be vacuously green.
 *
 * Pending marks resolve to the REJECTED reading: a deletion inside a human span is still
 * the author's standing prose, and an insertion is a proposal he has not taken, so a
 * receipt quoting an insertion is dead until the mark is accepted.
 */
export function humanSpans(body: string, { protectedLines = null }: ClaimOptions = {}): string {
  if (protectedLines !== null) {
    return stripMarks(splitlines(body).filter((_, i) => protectedLines.has(i + 1)).join('\n'));
  }
  const out: string[] = [];
  let inHuman = false;
  for (const line of splitlines(body)) {
    // The raw line, as in units: four spaces of indent is code.
    if (HUMAN_OPENER.test(line)) inHuman = true;
    else if (LIBRARIAN_OPENER.test(line)) inHuman = false;
    else if (inHuman) out.push(line);
  }
  return stripMarks(out.join('\n'));
}

/**
 * Normalised readings of a cited page: one where it carries no pending mark, two where it
 * does. A receipt must survive whichever way a pending mark goes, so both readings are
 * offered and the claim stands if EITHER holds. The second is built only when a mark is
 * actually there.
 */
function haystacks(text: string, own: boolean, protectedLines: Set<number> | null): string[] {
  const source = own ? humanSpans(text, { protectedLines }) : text;
  if (own || !findMarks(source).length) return [normalise(source)];
  return [...new Set(MODES.map((mode) => normalise(resolve(source, mode))))].sort(byCodePoint);
}

/**
 * Whole-file lines, from 1, that are the author's: the `> [!human]` spans of the body.
 * Hoard's check_vault called protection.lines with no fallback, which proved ownership
 * from git history pinned to HEAD and raised protection.Unavailable for a page it could
 * not prove, ending the whole run. There is no git here, so the markers are the whole of
 * it and nothing raises. The ownership rules port can pass its own reading instead.
 */
export function markerProtectedLines(_relpath: string, text: string): Set<number> {
  const offset = bodyOffset(text);
  return new Set([...humanSpanLines(split(text).body)].map((n) => n + offset));
}

export interface CheckOptions {
  layout?: Layout;
  protectedLines?: (relpath: string, text: string) => Set<number>;
}

/** Every dead or mis-cased receipt on the librarian-authored pages, and every page skipped. */
export function checkVault(notes: readonly Note[],
  { layout = HOARD_LAYOUT, protectedLines = markerProtectedLines }: CheckOptions = {}): string[] {
  const index = PageIndex.fromNotes(notes);
  const texts = new Map(notes);
  const findings: string[] = [];
  let checked = 0;
  // (relpath, own) -> that page's readings. normalise over a whole source is the run's
  // dominant cost, and every claim citing a page would rebuild the same one.
  const cache = new Map<string, string[]>();
  for (const [relpath, text] of notes) {
    if (!startsWithAny(relpath, layout.librarianAuthoredDirs)) continue;
    let body: string;
    try {
      body = split(text).body;
    } catch (err) {
      if (!(err instanceof FrontmatterError)) throw err;
      // QV3: the skip drops this page's receipts from the run, so the check says so
      // rather than let a page nothing read pass as a clean one.
      log.error(`receipt check skipped ${relpath}: ${err.message}`);
      findings.push(`${relpath}: QV3 frontmatter would not parse, so the receipts on this page were not checked: ${err.message}`);
      continue;
    }
    const offset = bodyOffset(text);
    const ownedBody = new Set([...protectedLines(relpath, text)].filter((n) => n > offset).map((n) => n - offset));
    // A mark's `author="Claude"` prefix would otherwise read as a quoted string and
    // leave its quote marks unpaired. The mask blanks the chrome only, keeping every
    // content word and every offset, so the claim lines stay the body's own.
    for (const claim of claims(maskChrome(body), { protectedLines: ownedBody })) {
      // unresolved links are `librarian dangling`'s business
      const pages = claim.targets.map((t) => index.resolveAny(t)).filter((p) => p !== null);
      if (!pages.length) continue;
      checked += 1;
      const needle = normalise(claim.text.replace(EDIT, ' ... '));
      // A self-target is checked against the page's own human spans, any other against
      // its whole text. One list of readings PER cited page: a claim with two candidate
      // targets already has two haystacks without any mark being involved.
      const perPage = pages.map((p) => {
        const own = p.relpath === relpath;
        const k = `${p.relpath}\0${own}`;
        if (!cache.has(k)) cache.set(k, haystacks(own ? body : texts.get(p.relpath)!, own, own ? ownedBody : null));
        return cache.get(k)!;
      });
      if (perPage.some((readings) => readings.some((h) => contains(h, needle)))) {
        for (const readings of perPage) {
          const hits = readings.map((h) => contains(h, needle));
          if (readings.length > 1 && hits.some(Boolean) && !hits.every(Boolean)) {
            // The receipt holds under one reading of a pending mark and not the other,
            // so it dies the day that mark resolves: not a finding yet, but the only
            // place the fact surfaces before it becomes one.
            log.info(`receipt at ${relpath}:${claim.lineno + offset} holds under only one reading of a pending mark`);
          }
        }
        continue;
      }
      const where = `${relpath}:${claim.lineno + offset}`;
      // len() and slicing count code points, as Python's do.
      const excerpt = pyLen(claim.text) <= 70 ? claim.text : `${pySlice(claim.text, 0, 67)}...`;
      const named = pages.map((p) => `[[${p.relpath.slice(p.relpath.lastIndexOf('/') + 1).slice(0, -3)}]]`).join(' or ');
      if (perPage.flat().some((h) => contains(casefold(h), casefold(needle)))) {
        findings.push(`${where}: QV2 quotation of ${named} differs in case: "${excerpt}"`);
      } else {
        // Name the readings only where a PAGE offered two.
        const tried = perPage.some((r) => r.length > 1) ? ' (accepted or rejected)' : '';
        findings.push(`${where}: QV1 quotation not found in ${named}${tried}: "${excerpt}"`);
      }
    }
  }
  log.info(`quotes: ${checked} claim(s) checked, ${findings.length} finding(s)`);
  return findings;
}

/** Whether the findings should fail the check: QV2 is informational. */
export function fails(findings: readonly string[]): boolean {
  return findings.some((f) => !INFORMATIONAL.some((code) => f.includes(` ${code} `)));
}
