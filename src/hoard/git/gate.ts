// The pre-commit gate: the checks every commit runs over the files it stages. The wiki's
// pages are HTML chapters with their frontmatter in sidecars, so of hoard's lint only the
// frontmatter rules still have their input; the rest read Markdown lines, callouts and
// wikilinks, and wait for the HTML citation format. Chapter prose is never judged: the
// gate reads a chapter only for the ids its citations name.
//
// What a finding does is the commit's business (commit.ts): a writer's commit logs it
// and goes ahead, a librarian edit is refused.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  validateHoardChangeV1, validateHoardMarksV1, validateHoardPageV1, validateHoardWikiV1,
} from '../../generated/validators.cjs';
import { checkNote } from '../../librarian/lint.ts';
import { ManifestError, parseManifest } from '../../librarian/manifest.ts';
import { HOARD_LAYOUT, type Layout, type Scheme, schemeFrom } from '../../librarian/scheme.ts';

export type GateRule = 'Sidecar-Fits-Its-Schema' | 'Frontmatter-Fits-The-Scheme' | 'Block-Ids-Citable';

export interface Finding {
  /** The file, relative to the library, with forward slashes. */
  path: string;
  rule: GateRule;
  message: string;
}

export interface StagedFile {
  path: string;
  text: string;
}

export interface CheckContext {
  /** The library's .neo/scheme.json, or null when it has none; read only if a page is staged. */
  schemeText(): string | null;
}

export const SCHEME_FILE = '.neo/scheme.json';

type Validator = { (data: unknown): boolean; errors?: { instancePath: string; message?: string }[] | null };

const SIDECARS: { match: RegExp; validate: Validator }[] = [
  { match: /^\.neo\/wiki\.json$/, validate: validateHoardWikiV1 },
  { match: /^\.neo\/book-[^/]+\/pages\/[^/]+\.json$/, validate: validateHoardPageV1 },
  { match: /^\.neo\/book-[^/]+\/chapters\/[^/]+\.json$/, validate: validateHoardMarksV1 },
];
const PAGE = /^\.neo\/book-[^/]+\/pages\/[^/]+\.json$/;
const CHAPTER = /^book-[^/]+\/chapters\/[^/]+\.html$/;
const BLOCK_ID = /\sdata-block="([^"]*)"/g;
// What a citation's [[Page#^id]] can name, as wiki/convert.ts reads a page's own ^id.
const CITABLE = /^[A-Za-z0-9-]+$/;
// FN1 and AT2 judge a page's path and a generator on an author body; neither applies to
// a sidecar whose page path is made up here.
const FRONTMATTER_RULE = /^(?:FM|PR)\d+ /;
// Every page in the wiki zone, none librarian-authored, no capture or mark folders: so
// checkNote runs its frontmatter rules and none of its body rules.
const PAGE_PATH = 'wiki/page.md';
const WIKI_LAYOUT: Layout = Object.freeze({
  ...HOARD_LAYOUT,
  librarianDirs: ['wiki/'],
  asIsDirs: [],
  skipDirs: [],
  authorBodyDirs: [],
  librarianAuthoredDirs: [],
  captureDirs: [],
  markDirs: [],
}) as Layout;

const why = (v: Validator) => (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`).join('; ');

function parsed(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function checkSidecar(file: StagedFile, validate: Validator): string | null {
  const read = parsed(file.text);
  if ('error' in read) return `will not parse: ${read.error}`;
  return validate(read.value) ? null : `does not fit its schema: ${why(validate)}`;
}

function checkChanges(text: string): string | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    const bad = checkSidecar({ path: '', text: lines[i]! }, validateHoardChangeV1);
    if (bad) return `line ${i + 1} ${bad}`;
  }
  return null;
}

function checkManifest(text: string): string | null {
  try {
    parseManifest(text);
    return null;
  } catch (err) {
    if (!(err instanceof ManifestError)) throw err;
    return err.message;
  }
}

// A repeated id is not judged: the first paragraph holding it owns it, as Enter copies
// the attribute onto the new paragraph (wiki/convert.ts).
function uncitableIds(file: StagedFile): Finding[] {
  return [...file.text.matchAll(BLOCK_ID)].map((m) => m[1]!).filter((id) => !CITABLE.test(id))
    .map((id) => ({ path: file.path, rule: 'Block-Ids-Citable' as const, message: `block id '${id}' cannot be cited (letters, digits and hyphens only)` }));
}

// JSON is YAML, so the frontmatter goes back into a note as a flow mapping that reads
// back exactly: every string stays a string.
function frontmatterFindings(file: StagedFile, frontmatter: unknown, scheme: Scheme): Finding[] {
  const text = frontmatter === null ? '' : `---\n${JSON.stringify(frontmatter)}\n---\n`;
  const prefix = `${PAGE_PATH}: `;
  return checkNote(PAGE_PATH, text, { scheme, layout: WIKI_LAYOUT })
    .map((f) => (f.startsWith(prefix) ? f.slice(prefix.length) : f))
    .filter((f) => FRONTMATTER_RULE.test(f))
    .map((message) => ({ path: file.path, rule: 'Frontmatter-Fits-The-Scheme' as const, message }));
}

/** Findings for the staged files, in the order given; none for a file the gate has no rule for. */
export function checkFiles(files: readonly StagedFile[], context: CheckContext): Finding[] {
  const findings: Finding[] = [];
  const sidecar = (path: string, message: string | null) => {
    if (message) findings.push({ path, rule: 'Sidecar-Fits-Its-Schema', message });
  };
  // A library that names no scheme has made no promise about its frontmatter, so none is
  // judged: the neutral scheme would flag every imported page's own vocabulary.
  let scheme: Scheme | null | undefined;
  const schemeOnce = (): Scheme | null => {
    if (scheme !== undefined) return scheme;
    scheme = null;
    const text = context.schemeText();
    if (text === null) return scheme;
    try {
      scheme = schemeFrom(JSON.parse(text), SCHEME_FILE);
    } catch (err) {
      sidecar(SCHEME_FILE, `will not load, so no frontmatter is judged: ${(err as Error).message}`);
    }
    return scheme;
  };

  for (const file of files) {
    if (CHAPTER.test(file.path)) {
      findings.push(...uncitableIds(file));
    } else if (file.path === '.neo/changes.jsonl') {
      sidecar(file.path, checkChanges(file.text));
    } else if (file.path === '.neo/manifest.jsonl') {
      sidecar(file.path, checkManifest(file.text));
    } else if (file.path === SCHEME_FILE) {
      const read = parsed(file.text);
      if ('error' in read) sidecar(file.path, `will not parse: ${read.error}`);
      else {
        try {
          schemeFrom(read.value, SCHEME_FILE);
        } catch (err) {
          sidecar(file.path, (err as Error).message);
        }
      }
    } else {
      const kind = SIDECARS.find((s) => s.match.test(file.path));
      if (!kind) continue;
      const bad = checkSidecar(file, kind.validate);
      sidecar(file.path, bad);
      if (!bad && PAGE.test(file.path)) {
        const judged = schemeOnce();
        const page = JSON.parse(file.text) as { frontmatter: unknown };
        if (judged) findings.push(...frontmatterFindings(file, page.frontmatter, judged));
      }
    }
  }
  return findings;
}

const SHOWN = 20;

/** The findings box's words: held files first, then one line per finding, cut at SHOWN lines. */
export function describeFindings(findings: readonly Finding[], held: readonly string[]): { message: string; detail: string } {
  if (!findings.length && !held.length) {
    return {
      message: 'No file committed since NEO started has a finding.',
      detail: 'NEO checks the wiki\'s pages and hoard\'s files each time it commits.',
    };
  }
  const counts = [
    findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : '',
    held.length ? `${held.length} librarian edit${held.length === 1 ? '' : 's'} held out of history until ${held.length === 1 ? 'it is' : 'they are'} fixed` : '',
  ].filter(Boolean);
  const lines = [
    ...(held.length ? ['Held out of history:', ...held, ...(findings.length ? [''] : [])] : []),
    ...findings.map((f) => `${f.path}: ${f.message}`),
  ];
  const cut = lines.length > SHOWN ? [...lines.slice(0, SHOWN), `and ${lines.length - SHOWN} more, in neo-errors.log.`] : lines;
  return { message: `${counts.join(', and ')}.`, detail: cut.join('\n') };
}

/** A librarian edit the gate refused: nothing was committed, and these are why. */
export class GateRefused extends Error {
  override name = 'GateRefused';
  readonly findings: Finding[];

  constructor(findings: Finding[]) {
    super(`the gate refused the librarian's edit: ${findings.map((f) => `${f.path}: ${f.message}`).join('; ')}`);
    this.findings = findings;
  }
}

type Level = 'error' | 'warn' | 'info' | 'debug';

export interface GateOptions {
  library: () => string;
  log: (level: Level, message: string, data?: unknown) => void;
}

/**
 * The gate as the commits use it. It reads the staged files from the library, keeps the
 * findings of each file it judged until a commit of that file passes, and holds a
 * refused edit's files out of the writer's commits. Held files are kept in memory only:
 * after a restart, the recovered commit takes them.
 */
export class Gate {
  readonly #o: GateOptions;
  readonly #findings = new Map<string, Finding[]>();
  readonly #held = new Set<string>();

  constructor(options: GateOptions) {
    this.#o = options;
  }

  /** Files a refused librarian edit left, which the writer's commits leave out. */
  held(): string[] {
    return [...this.#held].sort();
  }

  /** Every finding still standing, by file. */
  findings(): Finding[] {
    return [...this.#findings.keys()].sort().flatMap((p) => this.#findings.get(p)!);
  }

  /** The writer saved this file: it is theirs again, and their next commit takes it. */
  saved(rel: string): void {
    if (this.#held.delete(rel)) this.#o.log('info', 'git.gate: the writer saved a held file, so their next commit takes it', { path: rel });
  }

  /**
   * Judges the staged files (deleted ones are skipped). A librarian edit with a finding
   * throws GateRefused and holds its files; any other commit logs what is new and goes on.
   */
  judge(staged: readonly string[], blocking: boolean): void {
    const library = this.#o.library();
    const start = performance.now();
    const files: StagedFile[] = [];
    for (const rel of staged) {
      const text = readOrNull(path.join(library, rel));
      if (text !== null) files.push({ path: rel, text });
    }
    const found = checkFiles(files, { schemeText: () => readOrNull(path.join(library, SCHEME_FILE)) });
    this.#o.log('debug', 'git.gate', { files: files.length, findings: found.length, blocking, ms: Math.round(performance.now() - start) });
    if (blocking && found.length) {
      for (const rel of staged) this.#held.add(rel);
      this.#o.log('warn', 'git.gate: a librarian edit was refused; its words stay on disk, out of history until fixed', { findings: found });
      throw new GateRefused(found);
    }
    for (const rel of staged) this.#held.delete(rel);
    const byFile = Map.groupBy(found, (f) => f.path);
    for (const rel of staged) {
      const now = byFile.get(rel) ?? [];
      const was = new Set((this.#findings.get(rel) ?? []).map((f) => `${f.rule}|${f.message}`));
      const fresh = now.filter((f) => !was.has(`${f.rule}|${f.message}`));
      if (fresh.length) this.#o.log('warn', `git.gate: ${rel} was committed with ${fresh.length === 1 ? 'a finding' : `${fresh.length} findings`}`, { findings: fresh });
      if (now.length) this.#findings.set(rel, now);
      else this.#findings.delete(rel);
    }
  }
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
