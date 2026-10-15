// Deterministic repair of wikilinks that only an alias answers, and target swaps for
// renames and merges. Ported from hoard's relink.py, planning and report only: nothing
// here writes a file (Relink-Reports-Only). The importer and the wiki's rename take
// rewriteText's new text in memory.
//
// Obsidian resolves a wikilink by basename or path and never by alias, so a vault can
// hold links that look resolved to lint and are dead in the product. The forms:
//
// - a body link to an alias becomes `[[Basename|text-as-written]]`, anchor kept, any
//   existing display kept, so the rendered text is byte-identical and every quote
//   receipt survives (quotes flattens a link to its display);
// - a `topics` entry becomes the bare `[[Basename]]`: topics carry no display;
// - a rename map (`--map OLD=NEW`) swaps the target with no pipe added, as Obsidian's
//   own rename does; a merge map (`--map-pipe`) pipes like an alias hit, so prose keeps
//   reading the old name after its node folds into a hub;
// - the rewrite is permitted in author bytes too, tagged so a log can name every line.
//
// Rule order in rewriteLink is the idempotence proof: a map entry wins over a live
// basename (after a rename the old key may belong to another page, and the hub links
// must still swap); a target that resolves by basename is never touched; an alias that
// would lead outside the librarian zone (a ghost in `_deprecated/`) or is contested is
// left for a human.
import {
  FrontmatterError, FrontmatterIntegrityError, isMapping, loadYaml, locateFrontmatter, split, terminator,
} from './frontmatter.ts';
import { type Occurrence, key, occurrences } from './links.ts';
import { getLogger } from './log.ts';
import { PageIndex } from './page-index.ts';
import { PyDate, pyLstrip, pyStrip, splitlines } from './py.ts';
import { HOARD_LAYOUT, type Layout, startsWithAny } from './scheme.ts';
import { humanSpanLines } from './spans.ts';
import { type Note, zoneOf } from './vault.ts';

const log = getLogger('librarian.relink');

const TOPIC_PREFIX = /^(\s*-\s*)/u;

function nfc(s: string): string {
  return s.normalize('NFC');
}

function basename(relpath: string): string {
  const name = relpath.slice(relpath.lastIndexOf('/') + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

/** Where a mapped name goes, and whether the written name stays as display. */
export interface Target {
  name: string;
  pipe: boolean;
}

/** OLD name as written (NFC) to its target, in the order the map was given. */
export type LinkMap = Map<string, Target>;

export type Owner = 'librarian' | 'author-body' | 'human-span';

export interface Rewrite {
  relpath: string;
  lineno: number;
  where: Occurrence['where'];
  owner: Owner;
  old: string;
  new: string;
}

/**
 * Whole-file line numbers, from 1, that hold the author's bytes on a librarian page.
 * Hoard read them from git-pinned ownership; the default here reads `> [!human]` spans.
 */
export type ProtectedLines = (relpath: string, text: string) => Set<number>;

/**
 * The link text `o` should become, or null where it stays as it is.
 *
 * `inTable`: the line is a markdown table row, where a bare `|` splits the cell, so the
 * pipe is written in Obsidian's escaped form `\|` and the rendered text still stays
 * byte-identical.
 */
export function rewriteLink(o: Occurrence, index: PageIndex, mapping: LinkMap, mapOnly = false,
  inTable = false, layout: Layout = HOARD_LAYOUT): string | null {
  const pipe = inTable ? '\\|' : '|';
  const target = mapping.get(nfc(o.target));
  if (target) {
    let display = o.display;
    if (target.pipe && o.where === 'body' && !display) {
      // The same rendered text the alias branch pins: an anchored link read as its
      // heading, not as its written target.
      display = pipe + rendered(o);
    }
    return `${o.embed}[[${target.name}${o.anchor}${display}]]`;
  }
  if (mapOnly || index.resolve(o.target) !== null) return null;
  const page = index.resolveAlias(o.target);
  if (page === null || zoneOf(page.relpath, layout) !== 'librarian') return null;
  let display = o.display;
  if (o.where === 'body' && !display) display = pipe + rendered(o);
  return `${o.embed}[[${basename(page.relpath)}${o.anchor}${display}]]`;
}

/**
 * What the bare link rendered as before the rewrite, by the rule quotes reads receipts
 * with: the heading of an anchored link, else the target as written. Pinning the pipe
 * to this is what keeps every quote receipt byte-stable through the repair.
 */
function rendered(o: Occurrence): string {
  if (o.anchor.startsWith('#')) return o.anchor.slice(1);
  return o.target + o.anchor;
}

function requote(value: string, quote: string): string {
  if (quote === "'") return `'${value.replaceAll("'", "''")}'`;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** `text` with each span replaced, rebuilt from slices, never a search and replace. */
function splice(text: string, edits: [[number, number], string][]): string {
  let out = '';
  let at = 0;
  for (const [[start, end], next] of [...edits].sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1])) {
    out += text.slice(at, start) + next;
    at = end;
  }
  return out + text.slice(at);
}

export interface RewriteOptions {
  layout?: Layout;
  /** Whole-file lines the author owns; `> [!human]` spans when not given. */
  protectedLines?: ProtectedLines;
}

/**
 * One note with its alias-only links repaired and its mapped links swapped, pure over
 * text: the new text, every rewrite made, and notes for what was left alone and why.
 * This is the call the importer makes on each page before writing it.
 *
 * Lines are rebuilt from the spans links.occurrences reports, so nothing outside a link
 * changes and every terminator survives, CRLF included. A `topics` scalar is requoted
 * in its own style; an item that is not a quoted block-list scalar (flow style) is
 * reported and left alone. `owners` keeps only rewrites whose owner it names (null for
 * all); `mapOnly` touches mapped targets only.
 *
 * Throws FrontmatterIntegrityError when a requoted `topics` scalar would not parse back
 * as the value meant, or the rewritten frontmatter differs from the old by more than the
 * intended `topics` strings: the splice is broken, and nothing should be written.
 */
export function rewriteText(relpath: string, text: string, index: PageIndex, mapping: LinkMap,
  owners: ReadonlySet<Owner> | null = null, mapOnly = false,
  { layout = HOARD_LAYOUT, protectedLines }: RewriteOptions = {},
): { text: string; rewrites: Rewrite[]; notes: string[] } {
  const lines = splitlines(text, true);
  const close = locateFrontmatter(lines);
  const bodyStart = close !== null ? close + 1 : 0;
  const body = lines.slice(bodyStart).join('');
  const human = protectedLines
    ? protectedLines(relpath, text)
    : new Set([...humanSpanLines(body)].map((n) => n + bodyStart));
  const authorBody = startsWithAny(relpath, layout.authorBodyDirs);
  const rewrites: Rewrite[] = [];
  const notes: string[] = [];
  const byLine = new Map<number, Occurrence[]>();
  for (const o of occurrences(text)) {
    const found = byLine.get(o.lineno);
    if (found) found.push(o);
    else byLine.set(o.lineno, [o]);
  }

  const ownerOf = (o: Occurrence): Owner => {
    if (o.where === 'topics') return 'librarian';
    if (authorBody) return 'author-body';
    return human.has(o.lineno) ? 'human-span' : 'librarian';
  };

  for (const [lineno, occs] of byLine) {
    const i = lineno - 1;
    const raw = lines[i]!;
    const term = terminator(raw);
    const content = term ? raw.slice(0, raw.length - term.length) : raw;
    const wanted: [Occurrence, string][] = [];
    const inTable = occs[0]!.where === 'body' && pyLstrip(content).startsWith('|');
    for (const o of occs) {
      const next = rewriteLink(o, index, mapping, mapOnly, inTable, layout);
      if (next === null) {
        for (const oldName of mapping.keys()) {
          if (key(o.target) === key(oldName) && nfc(o.target) !== oldName) {
            notes.push(`map: [[${o.target}]] matches '${oldName}' by case only -- not swapped (${relpath}:${lineno})`);
          }
        }
        continue;
      }
      if (owners !== null && !owners.has(ownerOf(o))) continue;
      wanted.push([o, next]);
    }
    if (!wanted.length) continue;
    if (occs[0]!.where === 'body') {
      for (const [o, next] of wanted) {
        const old = content.slice(o.span[0], o.span[1]);
        rewrites.push({ relpath, lineno, where: 'body', owner: ownerOf(o), old, new: next });
      }
      lines[i] = splice(content, wanted.map(([o, next]) => [o.span, next])) + term;
      continue;
    }
    // topics: one quoted scalar per line; several occurrences share it
    const o0 = wanted[0]![0];
    if (!o0.quote) {
      for (const [o] of wanted) {
        notes.push(`${relpath}:${lineno}: not rewritten: \`topics\` item [[${o.target}]] is not a quoted `
          + 'block-list scalar -- edit it by hand');
      }
      continue;
    }
    const newValue = splice(o0.value, wanted.map(([o, next]) => [o.span, next]));
    const prefix = TOPIC_PREFIX.exec(content)![1]!;
    const oldScalar = content.slice(prefix.length);
    const newScalar = requote(newValue, o0.quote);
    if (loadYaml(newScalar) !== newValue) {
      throw new FrontmatterIntegrityError(`relink: requoted topics item does not parse back (${relpath}:${lineno})`);
    }
    rewrites.push({ relpath, lineno, where: 'topics', owner: 'librarian', old: oldScalar, new: newScalar });
    lines[i] = prefix + newScalar + term;
  }

  const newText = lines.join('');
  if (close !== null && rewrites.some((r) => r.where === 'topics')) checkTopics(text, newText, rewrites, relpath);
  return { text: newText, rewrites, notes };
}

/** Python's `==` over what safe_load returns: mappings by key set, a date by its value. */
function pyEqual(a: unknown, b: unknown): boolean {
  if (a instanceof PyDate || b instanceof PyDate) {
    return a instanceof PyDate && b instanceof PyDate && String(a) === String(b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => pyEqual(v, b[i]));
  }
  if (isMapping(a) || isMapping(b)) {
    if (!isMapping(a) || !isMapping(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && pyEqual(a[k], b[k]));
  }
  return a === b || (a == null && b == null);
}

/** `list(value or [])`: empty for a falsy value, a mapping's keys, a string's characters. */
function pyList(value: unknown): unknown[] {
  if (!value || (Array.isArray(value) && !value.length)) return [];
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'string') return [...value];
  if (isMapping(value)) return Object.keys(value);
  throw new TypeError(`'${typeof value}' object is not iterable`);
}

/**
 * Postcondition, modelled on hoard's set_key: the new block parses, `topics` differs
 * from the old list by exactly the intended strings, and nothing outside the rewritten
 * lines moved.
 */
function checkTopics(oldText: string, newText: string, rewrites: Rewrite[], relpath: string): void {
  let oldFm;
  let newFm;
  try {
    oldFm = split(oldText.replaceAll('\r\n', '\n')).fm;
    newFm = split(newText.replaceAll('\r\n', '\n')).fm;
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    throw new FrontmatterIntegrityError(
      `relink: frontmatter of ${relpath} does not re-parse after topics rewrite: ${err.message}`, { cause: err });
  }
  const expected = rewrites.filter((r) => r.where === 'topics').map((r) => loadYaml(r.new));
  const oldTopics = pyList((oldFm ?? {})['topics']);
  const newTopics = pyList((newFm ?? {})['topics']);
  const changed = oldTopics.flatMap((o, i) => (
    i < newTopics.length && !pyEqual(o, newTopics[i]) ? [newTopics[i]] : []));
  if (oldTopics.length !== newTopics.length || !pyEqual(changed, expected)) {
    throw new FrontmatterIntegrityError(
      `relink: \`topics\` of ${relpath} does not carry exactly the intended rewrites after splice`);
  }
  const rest = (fm: Record<string, unknown> | null) => Object.fromEntries(
    Object.entries(fm ?? {}).filter(([k]) => k !== 'topics'));
  if (!pyEqual(rest(oldFm), rest(newFm))) {
    throw new FrontmatterIntegrityError(`relink: a key other than \`topics\` changed on ${relpath}`);
  }
}

// --- maps -------------------------------------------------------------------

/** Python's str.partition: the text before the first `sep`, whether it was found, the rest. */
function partition(text: string, sep: string): [string, boolean, string] {
  const at = text.indexOf(sep);
  return at === -1 ? [text, false, ''] : [text.slice(0, at), true, text.slice(at + sep.length)];
}

/**
 * `OLD=NEW` pairs (swap) and (pipe), plus the text of a map file of `OLD -> NEW` lines
 * (swap; blank and `#` lines ignored), which the caller reads. Keys are NFC; a duplicate
 * OLD with a different NEW is an error, because one run must be unambiguous. Throws
 * RangeError where hoard raises ValueError.
 */
export function parseMap(swaps: readonly string[] | null, pipes: readonly string[] | null,
  fileText: string | null = null): LinkMap {
  const mapping: LinkMap = new Map();

  const put = (rawOld: string, rawNew: string, pipe: boolean) => {
    const old = nfc(pyStrip(rawOld));
    const name = nfc(pyStrip(rawNew));
    if (!old || !name) throw new RangeError(`map: empty name in '${old}=${name}'`);
    const held = mapping.get(old);
    if (held && (held.name !== name || held.pipe !== pipe)) {
      throw new RangeError(`map: '${old}' is mapped twice, to '${held.name}' and '${name}'`);
    }
    if (!held) mapping.set(old, { name, pipe });
  };

  for (const [pairs, pipe] of [[swaps ?? [], false], [pipes ?? [], true]] as const) {
    for (const pair of pairs) {
      const [old, found, name] = partition(pair, '=');
      if (!found) throw new RangeError(`map: expected OLD=NEW, got '${pair}'`);
      put(old, name, pipe);
    }
  }
  if (fileText !== null) {
    for (const line of splitlines(fileText)) {
      if (!pyStrip(line) || pyLstrip(line).startsWith('#')) continue;
      const [old, found, name] = partition(line, '->');
      if (!found) throw new RangeError(`map file: expected 'OLD -> NEW', got '${line}'`);
      put(old, name, false);
    }
  }
  return mapping;
}

/**
 * Errors and notes on a map. An OLD that is still a live basename means the rename has
 * not happened; a NEW that resolves, or does not, is worth a line either way, since a
 * map is where a wrong assumption would hide.
 */
export function validateMap(mapping: LinkMap, index: PageIndex): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  for (const [old, target] of mapping) {
    const page = index.resolve(old);
    if (page !== null && key(basename(page.relpath)) === key(old)) {
      errors.push(`map: '${old}' is still a live basename (${page.relpath}) -- git mv first`);
    }
    if (old === target.name) errors.push(`map: '${old}' maps to itself`);
    const dest = index.resolve(target.name);
    if (dest !== null) notes.push(`map: [[${target.name}]] resolves to ${dest.relpath}`);
    else notes.push(`map: [[${target.name}]] has no page; the link will be unresolved by design`);
  }
  return { errors, notes };
}

// --- plan ---------------------------------------------------------------------

export type Scope = 'all' | 'librarian' | 'author';

export const SCOPES: Readonly<Record<Scope, ReadonlySet<Owner> | null>> = Object.freeze({
  all: null,
  librarian: new Set<Owner>(['librarian']),
  author: new Set<Owner>(['author-body', 'human-span']),
});

export interface Report {
  rewrites: Rewrite[];
  notes: string[];
  /** relpath to its rewritten text, for every note with a rewrite. */
  texts: Record<string, string>;
}

function inScope(relpath: string, layout: Layout): boolean {
  if (relpath === layout.indexPage) return true;
  return zoneOf(relpath, layout) === 'librarian' && !startsWithAny(relpath, layout.captureDirs);
}

export interface PlanOptions extends RewriteOptions {
  /** Non-Markdown files, which are link keys too. */
  attachments?: Iterable<string>;
}

/**
 * Every rewrite pending over a vault's notes, and the text each changed note would
 * have; nothing is written. `mapOnly` restricts the run to mapped targets, so a rename
 * or merge is applied and logged on its own and the alias half waits its turn. Throws
 * RangeError for a map that fails validation, or mapOnly with no map.
 */
export function plan(notes: readonly Note[], mapping: LinkMap, scope: Scope, mapOnly = false,
  { attachments = [], layout = HOARD_LAYOUT, protectedLines }: PlanOptions = {}): Report {
  if (mapOnly && !mapping.size) throw new RangeError('relink: --map-only needs at least one --map entry');
  if (!Object.hasOwn(SCOPES, scope)) throw new RangeError(`relink: unknown scope '${scope}'`);
  const owners = SCOPES[scope];
  const index = PageIndex.fromNotes(notes, attachments);
  const { errors, notes: mapNotes } = validateMap(mapping, index);
  if (errors.length) throw new RangeError(errors.join('; '));
  const report: Report = { rewrites: [], notes: [...mapNotes], texts: {} };
  for (const [relpath, text] of notes) {
    if (!inScope(relpath, layout)) continue;
    const result = rewriteText(relpath, text, index, mapping, owners, mapOnly, { layout, protectedLines });
    report.notes.push(...result.notes);
    if (result.rewrites.length) {
      report.rewrites.push(...result.rewrites);
      report.texts[relpath] = result.text;
    }
  }
  const files = Object.keys(report.texts).length;
  log.info(`relink: ${report.rewrites.length} rewrite(s) pending in ${files} file(s), scope ${scope}`);
  return report;
}

/** One line per rewrite, then the notes, then a count by owner, the librarian's first. */
export function reportLines(rewrites: readonly Rewrite[], notes: readonly string[], verb: string): string[] {
  const lines = rewrites.map((r) => `${r.relpath}:${r.lineno}: ${r.old} -> ${r.new}  [${r.owner}]`);
  lines.push(...notes);
  const counts = new Map<string, number>();
  for (const r of rewrites) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  const files = new Set(rewrites.map((r) => r.relpath)).size;
  if (rewrites.length) {
    // A stable sort on one flag: the librarian's count first, the others as they came.
    const byOwner = [...counts].sort((a, b) => Number(a[0] !== 'librarian') - Number(b[0] !== 'librarian'))
      .map(([owner, n]) => `${n} ${owner}`).join(', ');
    lines.push(`${rewrites.length} rewrite(s) ${verb} in ${files} file(s): ${byOwner}`);
  }
  return lines;
}
