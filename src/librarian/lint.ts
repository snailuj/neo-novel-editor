// The metadata scheme lint, ported from hoard's lint.py: the boundary that keeps a
// library's frontmatter to one dialect, and the voice rules on the pages the librarian
// writes. Every rule judges the librarian zone only; the inbox and the as-is zone are
// left alone. Findings are hoard's strings, so the two can be diffed.
//
// Not ported: BD3's widened, informational scope over infra docs, skills and the
// rulebook (decision Widened-BD3-Stays-In-Hoard). Ownership comes from the caller, or
// from `> [!human]` markers where the caller proves none.
import { BLOCK_CITE, BLOCK_CITE_NO_SPEAKER, FOOTER_CITE, INLINE_CITE, QUOTE_ATTRIBUTION } from './citations.ts';
import { type Frontmatter, FrontmatterError, bodyOffset, isMapping, split } from './frontmatter.ts';
import { isFence, linksIn, maskCodeSpans, occurrences } from './links.ts';
import { getLogger } from './log.ts';
import { MODES, findMarks, librarianMask, malformed, mask, resolve } from './marks.ts';
import { PageIndex } from './page-index.ts';
import { byCodePoint, casefold, isPySpace, pyLstrip, pySplit, pyStr, pyStrip, splitlines } from './py.ts';
import { DEFAULT_SCHEME, HOARD_LAYOUT, type Layout, type Scheme, startsWithAny } from './scheme.ts';
import { humanSpanLines } from './spans.ts';
import { type Note, zoneOf } from './vault.ts';

export { humanSpanLines };

const log = getLogger('librarian.lint');

const INLINE_FIELD = /^\s*(?:[-*>]\s*)?[A-Za-z][A-Za-z_ -]*::\s/u;
/** The standard opening callout: a one-line title with no body, collapsed or not. */
export const LIBRARIAN_CALLOUT = '> [!librarian] An agent has contributed to this file.';
/** The older form, collapsed with any title and body, which still satisfies AT3. */
export const LEGACY_LIBRARIAN_CALLOUT = '> [!librarian]-';
// The marker in any case, as Obsidian reads callout types; the title exactly. Hoard
// spells the case-blind part `(?i:...)`, which Node 22's RegExp lacks.
const OPENING_LIBRARIAN = /^> \[![Ll][Ii][Bb][Rr][Aa][Rr][Ii][Aa][Nn]\](?:-|-? An agent has contributed to this file\.$)/u;
export const BD3_MESSAGE = 'BD3 wrapped paragraph (one paragraph = one line)';
/** A malformed mark: the grammar has no escaping, so it is literal prose nobody meant. */
export const TC1_MESSAGE = 'TC1 malformed CriticMarkup mark';
/** A nested mark: legal, read as the outer mark's content, and almost always a mistake. */
export const TC2_MESSAGE = "TC2 nested CriticMarkup mark, INFORMATIONAL (the inner mark is read as the outer one's content)";
/** A file BD3 was asked to judge whose frontmatter will not parse: a check that could not run. */
export const FM11_MESSAGE = 'FM11 frontmatter would not parse, so BD3 could not run:';
const INFORMATIONAL = ['INFORMATIONAL'];
// A list item at any indent: a bullet, or `N.` / `N)`. Python's \d is any decimal digit.
const LIST_ITEM = /^\s*(?:[-*+]|\p{Nd}+[.)])(?:\s|$)/u;
/** Structural line openers that are not prose and cannot sit inside a paragraph. */
const NON_PROSE_PREFIXES = ['>', '|', '#'];

export interface CheckOptions {
  /** CS1 needs vault-wide link resolution, so it runs only when an index is given. */
  index?: PageIndex;
  /**
   * Whole-file lines (from 1) the author owns on a librarian page. Absent, the
   * `> [!human]` markers decide.
   */
  protectedLines?: Set<number>;
  scheme?: Scheme;
  layout?: Layout;
}

export interface VaultOptions {
  attachments?: Iterable<string>;
  scheme?: Scheme;
  layout?: Layout;
  /** Ownership a caller can prove, for librarian-authored pages and the index. */
  protectedLines?: (relpath: string, text: string) => Set<number> | undefined;
  /** The operation log CS2 searches; empty when the library keeps none. */
  logText?: string;
}

// Python truthiness of a value PyYAML loaded.
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

const has = (fm: Frontmatter, k: string) => Object.hasOwn(fm, k);
const get = (fm: Frontmatter, k: string) => (has(fm, k) ? fm[k] : undefined);
const stemOf = (relpath: string) => {
  const name = relpath.slice(relpath.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
};

interface Entry {
  lineno: number;
  /** Code spans blanked for matching; the same length, so offsets carry over. */
  masked: string;
  /** As written, for reporting. */
  raw: string;
}

/**
 * Runs of citable text, by body line. Fences and blockquotes are the author's bytes and
 * drop out, except a blockquote's `-- [[page]] (Speaker)` attribution, which is the
 * librarian's citation of the quote above it. A run keeps a citation wrapped across a
 * soft line break whole.
 */
function citableBlocks(body: string): Entry[][] {
  const lines = splitlines(body);
  const blocks: Entry[][] = [];
  let current: Entry[] = [];
  let inFence = false;
  const entry = (lineno: number, text: string): Entry => ({ lineno, masked: maskCodeSpans(text), raw: text });
  const flush = () => {
    if (current.length) blocks.push(current);
    current = [];
  };
  let i = 0;
  while (i < lines.length) {
    let stripped = pyStrip(lines[i]!);
    if (isFence(lines[i]!)) {
      inFence = !inFence;
      stripped = '';
    }
    if (inFence || !stripped) {
      flush();
      i += 1;
      continue;
    }
    if (stripped.startsWith('>')) {
      flush();
      const inner = pyStrip(pyLstrip(stripped, '>'));
      if (QUOTE_ATTRIBUTION.test(inner)) {
        const run: Entry[] = [];
        while (i < lines.length && pyStrip(lines[i]!).startsWith('>')) {
          run.push(entry(i + 1, pyStrip(pyLstrip(pyStrip(lines[i]!), '>'))));
          i += 1;
        }
        blocks.push(run);
        continue;
      }
      i += 1;
      continue;
    }
    current.push(entry(i + 1, stripped));
    i += 1;
  }
  flush();
  return blocks;
}

const withIndices = (pattern: RegExp) => new RegExp(pattern.source, 'gud');
const CITE_PATTERNS = [INLINE_CITE, BLOCK_CITE, FOOTER_CITE].map((p) => ({ block: p === BLOCK_CITE, re: withIndices(p) }));

/** A citation: its body line, the link's target, and the speaker it names (null if none). */
export type Citation = [lineno: number, target: string, speaker: string | null];

/** Every citation on a page body, reported at the line it opens on. */
export function citations(body: string): Citation[] {
  const found: Citation[] = [];
  for (const block of citableBlocks(body)) {
    block.forEach(({ lineno, masked }, offset) => {
      const tail = block.slice(offset);
      const window = tail.map((e) => e.masked).join(' ');
      const source = tail.map((e) => e.raw).join(' ');
      const lineStarts = new Set<number>();
      let at = 0;
      for (const e of tail) {
        lineStarts.add(at);
        at += e.masked.length + 1;
      }
      const hits: [number, string, string | null][] = [];
      for (const { block: isBlock, re } of CITE_PATTERNS) {
        for (const m of window.matchAll(re)) {
          // A match belongs to the line it starts on, so a wrapped citation counts once.
          if (m.index >= masked.length) continue;
          // A prose dash mid-line, not an attribution.
          if (isBlock && !(lineStarts.has(m.index) || lineStarts.has(window.indexOf('[[', m.index)))) continue;
          // The speaker is read off the unmasked text: a finding that garbles the
          // speaker it complains about cannot be acted on. The locator is optional.
          const [start, end] = m.indices![2]!;
          const said = pyStrip(source.slice(start, end).split(',')[0]!);
          hits.push([m.index, m[1]!, said || null]);
        }
      }
      const bare = BLOCK_CITE_NO_SPEAKER.exec(window);
      if (bare && !hits.length) hits.push([0, bare[1]!, null]);
      hits.sort((a, b) => a[0] - b[0] || byCodePoint(a[1], b[1]) || byCodePoint(a[2] ?? '', b[2] ?? ''));
      for (const [, target, speaker] of hits) found.push([lineno, target, speaker]);
    });
  }
  return found;
}

function checkCitations(relpath: string, body: string, index: PageIndex, at: (n: number) => string,
  scheme: Scheme, layout: Layout): string[] {
  const findings: string[] = [];
  const reported = new Set<string>();
  for (const [lineno, target, speaker] of citations(body)) {
    const page = index.resolveAny(target);
    // A dangling link is a separate concern, with its own command.
    if (!page || !page.judged(layout)) continue;
    const expected = page.speakers(layout, scheme);
    if (!expected.length) {
      if (!reported.has(page.relpath)) {
        reported.add(page.relpath);
        findings.push(`${page.relpath}: CS1 provenance.author required (cited as a speaker by ${relpath})`);
      }
      continue;
    }
    if (speaker !== null && expected.includes(speaker)) continue;
    // The unattributed speaker is recorded once, at discovery; a citation may only
    // repeat what is recorded, so it is not exempt here.
    const wanted = [...new Set(expected)].map((e) => `'${e}'`).join(' or ');
    const named = speaker === null ? 'no speaker' : `speaker '${speaker}'`;
    findings.push(`${at(lineno)}: CS1 citation of [[${target}]] names ${named} (expected ${wanted})`);
  }
  return findings;
}

/** Whether the librarian callout comes before any prose; a leading H1 is allowed. */
function opensWithCallout(body: string): boolean {
  for (const line of splitlines(body)) {
    const stripped = pyStrip(line);
    if (!stripped || stripped.startsWith('# ')) continue;
    return OPENING_LIBRARIAN.test(stripped);
  }
  return false;
}

/**
 * Whether a multi-line run is still wrapped once its pending marks resolve. A mark may
 * wrap inside a paragraph, so the run is resolved both ways and stands only if both
 * readings are still multi-line. Marks cannot cross a blank line, so a paragraph
 * resolves as a closed unit.
 */
function wrapSurvives(run: string[]): boolean {
  const text = run.join('\n');
  if (!findMarks(text).length) return true;
  return MODES.every((mode) => splitlines(resolve(text, mode)).filter((ln) => pyStrip(ln)).length > 1);
}

/**
 * Body lines (from 1) opening a multi-line paragraph of librarian prose. One paragraph
 * is one line, because Obsidian renders every newline as a line break; line length
 * never enters the test. Structure ends a run: fences, blockquotes, tables, headings,
 * HTML comment blocks and a block citation's sign-off. A list item opens a run its
 * continuations join, indented or lazy. Author bytes are exempt, and a line ending in
 * two spaces is a deliberate break that closes its paragraph.
 */
export function wrappedParagraphLines(body: string, protectedLines?: Set<number>): number[] {
  const human = protectedLines ?? humanSpanLines(body);
  const lines = splitlines(body);
  const hits: number[] = [];
  let runStart = 0;
  let runLen = 0;
  let inFence = false;
  let inList = false;
  let inComment = false;
  const close = () => {
    if (runLen > 1 && wrapSurvives(lines.slice(runStart - 1, runStart - 1 + runLen))) hits.push(runStart);
    runLen = 0;
  };
  lines.forEach((line, i) => {
    const lineno = i + 1;
    const stripped = pyStrip(line);
    // Author bytes are read for exemption, never for structure: a fence opened inside
    // the author's span must not toggle the state that judges the prose after it.
    if (human.has(lineno)) return close();
    if (isFence(line)) {
      inFence = !inFence;
      return close();
    }
    // An HTML comment block is machine scaffolding: a generator's spec in one must stay
    // one key per line.
    if (inComment) {
      if (stripped.includes('-->')) inComment = false;
      return close();
    }
    if (stripped.startsWith('<!--')) {
      inComment = !stripped.includes('-->');
      return close();
    }
    if (inFence || !stripped) return close();
    // A quote line and its `-- [[page]] (Speaker)` sign-off are a shape, not a wrap: CS1
    // reads the citation at a line start.
    if (QUOTE_ATTRIBUTION.test(stripped)) return close();
    if (LIST_ITEM.test(line)) {
      // A bullet and the bullet below it are two paragraphs.
      close();
      inList = true;
    } else {
      // A blank line does not end a list; only a flush line does.
      if (!(inList && line.length > 0 && isPySpace(line[0]!))) inList = false;
      // Structure indented under an item is still structure.
      if (startsWithAny(stripped, NON_PROSE_PREFIXES)) return close();
    }
    if (runLen === 0) runStart = lineno;
    runLen += 1;
    if (line.endsWith('  ')) close();
    return undefined;
  });
  close();
  return hits;
}

/**
 * Body lines (from 1) carrying an em dash in librarian prose. Blockquotes, fences, code
 * spans and double-quoted strings are quoted material and exempt; quote state carries
 * across lines, so a wrapped quotation never reads as prose from its second line on.
 */
export function emDashLines(body: string): number[] {
  const hits: number[] = [];
  let inFence = false;
  let inCode = false;
  let inQuote = false;
  splitlines(body).forEach((line, i) => {
    if (isFence(line)) {
      inFence = !inFence;
      return;
    }
    // A blockquote line is quoted whole and cannot close a pending inline quotation.
    if (inFence || pyLstrip(line).startsWith('>')) return;
    for (const ch of line) {
      if (ch === '`') inCode = !inCode;
      else if (ch === '"') inQuote = !inQuote;
      else if (ch === '—' && !(inCode || inQuote)) {
        hits.push(i + 1);
        break;
      }
    }
  });
  return hits;
}

/** Body line to `path:FILE line`, in one place, so every `:N:` a reader sees is a file line. */
function reporter(relpath: string, text: string): (lineno: number) => string {
  const offset = bodyOffset(text);
  return (lineno) => `${relpath}:${lineno + offset}`;
}

/** Whether the findings fail the check: informational ones are printed, never failing. */
export function fails(findings: readonly string[]): boolean {
  return findings.some((f) => !INFORMATIONAL.some((code) => f.includes(code)));
}

function checkMarks(relpath: string, body: string, at: (n: number) => string, layout: Layout): string[] {
  if (!startsWithAny(relpath, layout.markDirs)) return [];
  const findings = malformed(body).map((bad) => `${at(bad.lineno)}: ${TC1_MESSAGE} ${bad.opener}`);
  for (const m of findMarks(body)) {
    if (m.nested) findings.push(`${at(body.slice(0, m.start).split('\n').length)}: ${TC2_MESSAGE}`);
  }
  return findings;
}

function checkWrapping(body: string, at: (n: number) => string, protectedLines?: Set<number>): string[] {
  return wrappedParagraphLines(body, protectedLines).map((lineno) => `${at(lineno)}: ${BD3_MESSAGE}`);
}

// Whole-file protected lines to body lines.
function bodyLines(protectedLines: Set<number> | undefined, offset: number): Set<number> | undefined {
  if (protectedLines === undefined) return undefined;
  return new Set([...protectedLines].filter((n) => n > offset).map((n) => n - offset));
}

/** BD3 on the vault index, and nothing else: it carries no frontmatter contract. */
function checkIndex(relpath: string, text: string, protectedLines?: Set<number>): string[] {
  let body: string;
  try {
    body = split(text).body;
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    // FM11: no FM rule judges the index, so a silent skip would read as clean.
    log.warning(`BD3 cannot read ${relpath}: ${err.message}`);
    return [`${relpath}: ${FM11_MESSAGE} ${err.message}`];
  }
  return checkWrapping(body, reporter(relpath, text), bodyLines(protectedLines, bodyOffset(text)));
}

/** Findings for one note. */
export function checkNote(relpath: string, text: string, options: CheckOptions = {}): string[] {
  const { index, protectedLines, scheme = DEFAULT_SCHEME, layout = HOARD_LAYOUT } = options;
  if (zoneOf(relpath, layout) !== 'librarian') {
    return relpath === layout.indexPage ? checkIndex(relpath, text, protectedLines) : [];
  }
  // Capture space with no structure; the librarian empties it.
  if (startsWithAny(relpath, layout.captureDirs)) return [];
  const findings: string[] = [];
  if (relpath.includes('∏')) findings.push(`${relpath}: FN1 ∏ path-encoding in filename`);
  const at = reporter(relpath, text);

  let parsed: ReturnType<typeof split>;
  try {
    parsed = split(text);
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    // The finding carries the report; the log line is the no-swallow rule.
    log.warning(`frontmatter of ${relpath} failed to parse: ${err.message}`);
    return [...findings, `${relpath}: FM2 ${err.message}`];
  }
  const { fm, body } = parsed;
  if (fm === null) return [...findings, `${relpath}: FM1 missing frontmatter`];
  for (const k of Object.keys(fm).filter((k) => !scheme.vocabulary.includes(k)).sort(byCodePoint)) {
    findings.push(`${relpath}: FM3 unknown key '${k}'`);
  }
  const type = get(fm, 'type');
  if (!has(fm, 'type')) findings.push(`${relpath}: FM6 'type' missing`);
  else if (!scheme.types.includes(type as string)) findings.push(`${relpath}: FM4 invalid type '${pyStr(type)}'`);
  if (has(fm, 'draft_status') && !scheme.draftStatuses.includes(fm['draft_status'] as string)) {
    findings.push(`${relpath}: FM5 invalid draft_status '${pyStr(fm['draft_status'])}'`);
  }
  const roles = truthy(get(fm, 'role')) ? get(fm, 'role') : [];
  for (const r of Array.isArray(roles) ? roles : [roles]) {
    if (!scheme.roles.includes(r as string)) findings.push(`${relpath}: FM7 invalid role '${pyStr(r)}'`);
  }
  if (has(fm, 'stage')) {
    if (type !== 'project') findings.push(`${relpath}: FM8 'stage' is for project pages only`);
    else if (!scheme.stages.includes(fm['stage'] as string)) findings.push(`${relpath}: FM9 invalid stage '${pyStr(fm['stage'])}'`);
  }
  // A page about something inside the world belongs to an era; a page about what the
  // work is about is a `subject` and need not.
  if (type === 'lore' && !truthy(get(fm, 'setting'))) {
    findings.push(`${relpath}: FM10 'setting' required on lore (or the page is a 'subject')`);
  }
  if ((type === 'source' || type === 'writing') && !has(fm, 'provenance')) findings.push(`${relpath}: PR1 provenance required`);
  const prov = get(fm, 'provenance');
  if (isMapping(prov)) {
    if (has(prov, 'method') && !scheme.methods.includes(prov['method'] as string)) {
      findings.push(`${relpath}: PR2 invalid provenance.method '${pyStr(prov['method'])}'`);
    }
    for (const k of Object.keys(prov).filter((k) => !scheme.provenanceKeys.includes(k)).sort(byCodePoint)) {
      findings.push(`${relpath}: PR3 unknown provenance subkey '${k}'`);
    }
  }
  findings.push(...checkMarks(relpath, body, at, layout));
  const generator = isMapping(prov) && truthy(get(prov, 'generator'));
  if (startsWithAny(relpath, layout.librarianAuthoredDirs)) {
    // Librarian-authored pages only: author bodies are verbatim.
    const human = bodyLines(protectedLines, bodyOffset(text)) ?? humanSpanLines(body);
    splitlines(body).forEach((line, i) => {
      if (INLINE_FIELD.test(line) && !human.has(i + 1)) findings.push(`${at(i + 1)}: BD1 inline Dataview field`);
    });
    if (!generator) findings.push(`${relpath}: AT1 provenance.generator required (librarian-authored page)`);
    if (!opensWithCallout(body)) {
      findings.push(`${relpath}: AT3 body must open with a '${LIBRARIAN_CALLOUT}' callout, `
        + `or the older collapsed '${LEGACY_LIBRARIAN_CALLOUT}' one`);
    }
    // A pending mark splits a line into both kinds: the librarian's proposal and comment
    // stay, the author's bytes are blanked, lengths kept. Ownership follows the mark's
    // form, never its author attribute.
    for (const lineno of emDashLines(librarianMask(body))) {
      if (!human.has(lineno)) findings.push(`${at(lineno)}: BD2 em dash in librarian prose (use '--')`);
    }
    findings.push(...checkWrapping(body, at, human));
    // Citations are judged as the page will read once its marks are accepted: one inside
    // a comment is an annotation about a citation, not one.
    if (index) findings.push(...checkCitations(relpath, mask(body, 'accept'), index, at, scheme, layout));
  } else if (generator) {
    findings.push(`${relpath}: AT2 provenance.generator on an author body (generator marks agent-authored content only)`);
  }
  return findings;
}

/**
 * A note read as it will stand once its marks are accepted, every byte at its own
 * offset: a link inside a deletion is going, one inside an insertion counts. The body
 * alone is masked, because YAML flow mappings use braces too.
 */
export function asAccepted(relpath: string, text: string): string {
  if (!text.includes('{')) return text;
  let body: string;
  try {
    body = split(text).body;
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    // FM2 reports the block, and the raw text is still right to scan for links.
    log.warning(`mark mask used raw text for ${relpath}: ${err.message}`);
    return text;
  }
  return text.slice(0, text.length - body.length) + mask(body, 'accept');
}

/**
 * LK1: a link only a frontmatter alias would answer is broken in Obsidian. Author bytes
 * are not exempt, because relink may rewrite a target there with the display kept, so
 * the finding is tagged; frontmatter `topics` is librarian metadata in every zone.
 */
export function checkAliasLinks(relpath: string, text: string, index: PageIndex,
  options: { protectedLines?: Set<number>; layout?: Layout } = {}): string[] {
  const { protectedLines, layout = HOARD_LAYOUT } = options;
  if (relpath !== layout.indexPage
    && (zoneOf(relpath, layout) !== 'librarian' || startsWithAny(relpath, layout.captureDirs))) return [];
  const authorBody = startsWithAny(relpath, layout.authorBodyDirs);
  const offset = bodyOffset(text);
  let body: string;
  try {
    body = split(text).body;
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    // FM2 reports the defect; the fallback is logged.
    log.warning(`alias-only link check used raw text for ${relpath}: ${err.message}`);
    body = text;
  }
  const human = protectedLines ?? new Set([...humanSpanLines(body)].map((n) => n + offset));
  const findings: string[] = [];
  for (const o of occurrences(asAccepted(relpath, text))) {
    if (index.resolve(o.target)) continue;
    const page = index.resolveAlias(o.target);
    if (!page) continue;
    const tag = o.where === 'body' && (authorBody || human.has(o.lineno)) ? ' (author bytes)' : '';
    findings.push(`${relpath}:${o.lineno}: LK1 alias-only link [[${o.target}]] -> ${stemOf(page.relpath)}${tag}`);
  }
  return findings;
}

/**
 * LK2: basenames are unique, case-blind, and an alias never shadows a page. Only pairs
 * touching the librarian zone are reported: two infra READMEs colliding is nobody's link.
 */
export function checkCollisions(index: PageIndex, layout: Layout = HOARD_LAYOUT): string[] {
  const findings: string[] = [];
  for (const c of index.collisions()) {
    if (zoneOf(c.page, layout) !== 'librarian' && zoneOf(c.other, layout) !== 'librarian') continue;
    if (c.kind === 'basename') {
      findings.push(`${c.page}: LK2 basename '${c.name}' collides with ${c.other} `
        + `(case-insensitive; Obsidian resolves [[${c.name}]] to one of them)`);
    } else if (c.kind === 'alias-basename') {
      findings.push(`${c.page}: LK2 alias '${c.name}' collides with the basename of ${c.other} `
        + `([[${c.name}]] can never reach this page)`);
    } else {
      findings.push(`${c.page}: LK2 alias '${c.name}' is also an alias of ${c.other}`);
    }
  }
  return findings.sort(byCodePoint);
}

/** DP1: nothing in the librarian zone links to a frozen ghost. */
export function checkGhostLinks(relpath: string, text: string, index: PageIndex, layout: Layout = HOARD_LAYOUT): string[] {
  if (zoneOf(relpath, layout) !== 'librarian') return [];
  const findings: string[] = [];
  for (const target of new Set(linksIn(asAccepted(relpath, text)))) {
    const page = index.resolve(target);
    if (page && page.relpath.startsWith(layout.deprecatedDir)) {
      findings.push(`${relpath}: DP1 link into ${layout.deprecatedDir} -- [[${target}]] resolves to the ghost ${page.relpath}`);
    }
  }
  return findings;
}

/**
 * CS2: recording the unattributed speaker requires a line in the operation log that says
 * which rungs were checked, or a later reader may assume nobody checked. The page's
 * basename is matched case-blind, since log lines name files loosely, against a log
 * read once for the whole vault.
 */
export function checkSpeakerLadder(notes: readonly Note[], logText: string,
  scheme: Scheme = DEFAULT_SCHEME, layout: Layout = HOARD_LAYOUT): string[] {
  const stems = new Set(splitlines(logText).flatMap(pySplit).map((w) => casefold(pyStrip(w, '[]*`,;:."\'()'))));
  const flagged: string[] = [];
  for (const [relpath, text] of notes) {
    let fm: Frontmatter | null;
    try {
      fm = split(text).fm;
    } catch (err) {
      if (!(err instanceof FrontmatterError)) throw err;
      // FM2 reports the block; the skip is logged.
      log.warning(`speaker ladder skipped ${relpath}: ${err.message}`);
      continue;
    }
    const prov = fm ? get(fm, 'provenance') : undefined;
    const author = isMapping(prov) ? get(prov, 'author') : undefined;
    const values = Array.isArray(author) ? author : [author];
    const unattributed = values.some((v) => typeof v === 'string'
      && v.split(',').map((p) => pyStrip(p)).includes(scheme.unattributed));
    if (!unattributed) continue;
    const stem = casefold(stemOf(relpath));
    if (![...stems].some((word) => word.includes(stem))) {
      flagged.push(`${relpath}: CS2 provenance.author ${scheme.unattributed} with no ${layout.logPath} line recording the ladder check`);
    }
  }
  return flagged;
}

/**
 * Every rule over a vault's notes, in the order given (the walk's sorted order). Two
 * passes: citations resolve against the whole vault, so the index is complete before
 * the first page is judged.
 */
export function checkVault(notes: readonly Note[], options: VaultOptions = {}): string[] {
  const { attachments = [], scheme = DEFAULT_SCHEME, layout = HOARD_LAYOUT, protectedLines, logText = '' } = options;
  const index = PageIndex.fromNotes(notes, attachments);
  log.info(`lint: indexed ${notes.length} notes for link resolution`);
  const findings: string[] = [];
  for (const [relpath, text] of notes) {
    const owned = protectedLines
      && (startsWithAny(relpath, layout.librarianAuthoredDirs) || relpath === layout.indexPage)
      ? protectedLines(relpath, text) : undefined;
    findings.push(...checkNote(relpath, text, { index, protectedLines: owned, scheme, layout }));
    findings.push(...checkGhostLinks(relpath, text, index, layout));
    findings.push(...checkAliasLinks(relpath, text, index, { protectedLines: owned, layout }));
  }
  findings.push(...checkCollisions(index, layout));
  findings.push(...checkSpeakerLadder(notes, logText, scheme, layout));
  log.info(`lint: ${findings.length} note findings`);
  return findings;
}
