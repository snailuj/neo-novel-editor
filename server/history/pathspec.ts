// A library that is a folder of a larger repository (the server's hoard clone keeps it at
// `library/`), or the whole repository (the plugin). Every git command that stages,
// commits or lists names these paths, never `.`, so nothing outside the library is swept
// in, and every name git reports is mapped back to a library-relative one.
import type { GitLog } from './runner.ts';

/**
 * Left out of the history: NEO's temp and backup copies, Finder and iCloud litter, the
 * book snapshots (a second history of whole chapters), the daily backups, emailed
 * exports, the error log, and the catalog NEO regenerates.
 */
export const IGNORED = [
  '*.tmp',
  '*.bak',
  '.DS_Store',
  '*.icloud',
  'book-*/snapshots/',
  'Backups/',
  'Exports/',
  'neo-errors.log',
  '_catalog.txt',
];

export interface LibraryRepo {
  /** The top of the work tree. */
  top: string;
  /** '' when the library is the repository; else the library's path below top, with a trailing slash. */
  prefix: string;
  /** The absolute library folder. */
  library: string;
  /** Extra gitignore-style patterns kept out of commits, beside IGNORED; used only when prefix is not empty. */
  ignore?: readonly string[];
}

/** What the plugin passes: a library folder that is its own repository. */
export type RepoLike = LibraryRepo | string;

export function toRepo(repo: RepoLike): LibraryRepo {
  return typeof repo === 'string' ? { top: repo, prefix: '', library: repo } : repo;
}

/** The whole library as a pathspec. */
export const wholeSpec = (repo: LibraryRepo): string => `:(top,literal)${repo.prefix}`;

/** One library-relative path as a pathspec. */
export const literalSpec = (repo: LibraryRepo, rel: string): string => `:(top,literal)${repo.prefix}${rel}`;

export const excludeSpec = (repo: LibraryRepo, rel: string): string => `:(top,exclude,literal)${repo.prefix}${rel}`;

/** A path as a commit holds it, for `commit:path`. */
export const blobPath = (repo: LibraryRepo, rel: string): string => `${repo.prefix}${rel}`;

/** Glob metacharacters in a folder name must not act as wildcards. */
const escapeGlob = (s: string): string => s.replace(/[\\*?[\]]/g, (c) => `\\${c}`);

/**
 * The ignore patterns as exclude pathspecs, for a library that cannot have a .gitignore of
 * its own. A pattern with no slash but a trailing one matches at any depth, as in
 * .gitignore; one with a slash inside is anchored to the library.
 */
export function ignoreSpecs(repo: LibraryRepo, patterns: readonly string[]): string[] {
  if (repo.prefix === '') return [];
  return [...patterns, ...(repo.ignore ?? [])].map((pattern) => {
    const dir = pattern.endsWith('/');
    const body = dir ? pattern.slice(0, -1) : pattern;
    const anchored = body.includes('/');
    return `:(top,exclude,glob)${escapeGlob(repo.prefix)}${anchored ? '' : '**/'}${body}${dir ? '/**' : ''}`;
  });
}

/**
 * Names git returned (relative to the top of the work tree) as library-relative names.
 * A name outside the library is dropped and logged: it should be unreachable, since every
 * command carries the library's pathspec, and passing it on would give the gate and the
 * callers a path they could not read.
 */
export function libraryNames(repo: LibraryRepo, names: readonly string[], log?: GitLog): string[] {
  if (repo.prefix === '') return [...names];
  const inside: string[] = [];
  const outside: string[] = [];
  for (const name of names) (name.startsWith(repo.prefix) ? inside : outside).push(name);
  if (outside.length) log?.('warn', 'git.outside_library: names outside the library were dropped', { prefix: repo.prefix, names: outside });
  return inside.map((name) => name.slice(repo.prefix.length));
}
