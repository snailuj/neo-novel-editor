// Keep Library History: makes the library folder its own repository, tells git what to
// leave out and how to read chapters, and commits what is there. Running it again finds
// everything in place and changes nothing.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commitAll, type Committed, type Identity } from './commit.ts';
import { repoState } from './repo.ts';
import type { Git } from './runner.ts';

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

/**
 * The attribute lines: diff and merge a paragraph per line, never touch line ends, for a
 * book's chapters and for every page of either tree (at any depth). Each line is added
 * to .gitattributes on its own, so a library started before pages gets the page lines.
 */
export const ATTRIBUTE_LINES: readonly string[] = [
  'book-*/chapters/*.html diff=neochapter merge=neochapter -text',
  'wiki/**/*.html diff=neochapter merge=neochapter -text',
  'sources/**/*.html diff=neochapter merge=neochapter -text',
];

/** The lines as a file's text, without the final newline: the attributes file blame names. */
export const ATTRIBUTES = ATTRIBUTE_LINES.join('\n');

/** Adds the lines a file lacks at its end; returns whether it wrote. */
function ensureLines(file: string, wanted: readonly string[]): boolean {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const have = new Set(text.split(/\r?\n/));
  const missing = wanted.filter((line) => !have.has(line));
  if (!missing.length) return false;
  const lead = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${lead}${missing.join('\n')}\n`);
  renameSync(tmp, file);
  return true;
}

export interface StartOptions {
  librarian: Identity;
  author?: Identity | null;
}

export interface Started {
  /** True when this run made the repository. */
  started: boolean;
  committed: Committed | null;
}

export async function keepHistory(git: Git, library: string, options: StartOptions): Promise<Started> {
  const repo = await repoState(git, library);
  if (repo.state === 'inside-another-repo') {
    throw new Error(`The library is inside another repository, at ${repo.top}; its history stays off.`);
  }
  if (repo.state === 'no-git') throw new Error(`git could not start: ${repo.error}`);
  const started = repo.state === 'untracked';
  if (started) await git.run(library, ['init', '-q']);
  ensureLines(path.join(library, '.gitignore'), IGNORED);
  ensureLines(path.join(library, '.gitattributes'), ATTRIBUTE_LINES);
  const committed = await commitAll(git, library, { who: 'author', reason: 'start', ...options });
  return { started, committed };
}
