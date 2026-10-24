// What the checks judge against, as data. A Scheme is the metadata vocabulary and the
// speakers a citation may name; a Layout is which folders hold whose words. Hoard kept
// both as constants in lint.py and vault.py. Here they are arguments, so a library
// brings its own and none of one writer's names or roles sit in this repository.

export interface Scheme {
  /** Every frontmatter key a page may carry (FM3). */
  vocabulary: string[];
  /** Values of `type` (FM4). */
  types: string[];
  /** Values of `draft_status` (FM5). */
  draftStatuses: string[];
  /** Values of `role` (FM7). */
  roles: string[];
  /** Values of `stage`, on project pages only (FM8, FM9). */
  stages: string[];
  /** Values of `provenance.method` (PR2). */
  methods: string[];
  /** Keys a `provenance` mapping may hold (PR3). */
  provenanceKeys: string[];
  /** The speaker a citation of the author's own writing names (CS1). */
  authorSpeaker: string;
  /** The speaker a citation of a librarian-authored page names (CS1). */
  librarianSpeaker: string;
  /** The speaker recorded when no rung of the ladder found one (CS1, CS2). */
  unattributed: string;
}

/** A neutral scheme for a library that brings none. */
export const DEFAULT_SCHEME: Scheme = Object.freeze({
  vocabulary: ['type', 'project', 'setting', 'draft_status', 'pipeline', 'provenance', 'created', 'modified',
    'aliases', 'topics', 'tags', 'role', 'format', 'stage', 'wg-word-goal', 'wg-daily-word-goal'],
  types: ['source', 'writing', 'lore', 'subject', 'project', 'meta'],
  draftStatuses: ['pantsing', 'downdraft', 'updraft', 'revising', 'revised', 'submitted', 'published', 'evergreen'],
  roles: [],
  stages: ['baby', 'child', 'adult', 'elder', 'evergreen'],
  methods: ['verbatim', 'converted', 'snapshot', 'split'],
  provenanceKeys: ['origin', 'ingested', 'method', 'author', 'published', 'url', 'converter', 'generator',
    'legacy_frontmatter'],
  authorSpeaker: 'author',
  librarianSpeaker: 'librarian',
  unattributed: 'Unattributed',
}) as Scheme;

/**
 * A scheme read from JSON naming any of DEFAULT_SCHEME's keys, each the same shape; the
 * keys it leaves out keep their neutral values. `name` says where it came from in errors.
 */
export function schemeFrom(raw: unknown, name: string): Scheme {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${name}: a scheme is a JSON object`);
  const scheme: Record<string, unknown> = { ...DEFAULT_SCHEME };
  for (const [k, value] of Object.entries(raw)) {
    const fallback = (DEFAULT_SCHEME as unknown as Record<string, unknown>)[k];
    if (fallback === undefined) throw new Error(`${name}: unknown scheme key '${k}'`);
    const ok = Array.isArray(fallback)
      ? Array.isArray(value) && value.every((v) => typeof v === 'string')
      : typeof value === 'string';
    if (!ok) throw new Error(`${name}: scheme key '${k}' must be ${Array.isArray(fallback) ? 'a list of strings' : 'a string'}`);
    scheme[k] = value;
  }
  return scheme as unknown as Scheme;
}

export interface Layout {
  /** Folders the librarian keeps: every rule judges these (vault.LIBRARIAN_DIRS). */
  librarianDirs: string[];
  /** Folders kept as they are and judged by nothing (vault.AS_IS_DIRS). */
  asIsDirs: string[];
  /** Folders no reader walks: derived output and test fixtures (vault.SKIP_DIRS). */
  skipDirs: string[];
  /** Folders whose bodies are the author's own bytes (writing/, sources/). */
  authorBodyDirs: string[];
  /** The author's manuscript folder: a citation of it names authorSpeaker. */
  writingDir: string;
  /** Folders whose pages the librarian wrote (lint.LIBRARIAN_AUTHORED_DIRS). */
  librarianAuthoredDirs: string[];
  /** Capture space no rule judges (inbox/). */
  captureDirs: string[];
  /** Folders a pending mark may sit in (lint.TC_DIRS). */
  markDirs: string[];
  /** Frozen ghosts nothing may link to (DP1). */
  deprecatedDir: string;
  /** The root index page, carved into BD3 by name (lint.INDEX_PAGE). */
  indexPage: string;
  /** Where the command line reads the provenance manifest. */
  manifestPath: string;
  /** Where the command line reads the operation log CS2 searches. */
  logPath: string;
}

/** Hoard's vault, as vault.py and lint.py laid it out at dac7cb3. */
export const HOARD_LAYOUT: Layout = Object.freeze({
  librarianDirs: ['inbox/', 'sources/', 'writing/', 'lore/', 'projects/'],
  asIsDirs: ['Daily/', '_tasks/', '_dashboards/', '_rituals/'],
  skipDirs: ['_meta/infra/derived/', '_meta/infra/tools/tests/fixtures/'],
  authorBodyDirs: ['writing/', 'sources/'],
  writingDir: 'writing/',
  librarianAuthoredDirs: ['lore/', 'projects/'],
  captureDirs: ['inbox/'],
  markDirs: ['writing/', 'sources/', 'lore/', 'projects/'],
  deprecatedDir: '_deprecated/',
  indexPage: 'INDEX.md',
  manifestPath: '_meta/MANIFEST.jsonl',
  logPath: '_meta/LOG.md',
}) as Layout;

export function startsWithAny(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => text.startsWith(p));
}
