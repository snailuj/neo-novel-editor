// One commit of everything that changed in the library, under the identity of whoever
// applied it. The author's identity comes from git config (or the plugin settings);
// user.useConfigOnly stops git guessing one from the machine's name when there is
// none. The librarian's is set through the environment, which outranks any config.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Git } from './runner.ts';

export interface Identity {
  name: string;
  email: string;
}

export type Who = 'author' | 'librarian';

export type Reason =
  | 'start'
  | 'idle'
  | 'chapter-switch'
  | 'book-close'
  | 'close'
  | 'recovered'
  | 'librarian-before'
  | 'librarian-after'
  | 'import';

const SUBJECTS: Record<Reason, string> = {
  start: 'Library history starts',
  idle: 'Writing, after a pause',
  'chapter-switch': 'Writing, on moving to another chapter',
  'book-close': 'Writing, on closing the book',
  close: 'Writing, on quitting NEO',
  recovered: 'Writing found uncommitted at start',
  'librarian-before': 'Writing, before a librarian edit',
  'librarian-after': 'Librarian edit',
  import: 'Pages imported to the wiki',
};

export interface CommitOptions {
  who: Who;
  reason: Reason;
  librarian: Identity;
  /** The author's identity from the plugin settings; git config's when absent. */
  author?: Identity | null;
  /** Only these paths, relative to the library; everything else waits for the next commit. */
  paths?: readonly string[];
}

export interface Committed {
  commit: string;
  files: number;
  /** Books holding a repository of their own, kept out of this commit. */
  leftOut: string[];
}

/**
 * Book folders with their own .git (upstream's per-book version history makes them).
 * Staged from the library they would become embedded repositories, and their words
 * would leave the library's history, so they are kept out.
 */
export function booksWithOwnRepo(library: string): string[] {
  return readdirSync(library, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('book-') && existsSync(path.join(library, d.name, '.git')))
    .map((d) => d.name)
    .sort();
}

function identityEnv(who: Who, options: CommitOptions): Record<string, string> {
  const id = who === 'librarian' ? options.librarian : options.author;
  if (!id) return {};
  return {
    GIT_AUTHOR_NAME: id.name,
    GIT_AUTHOR_EMAIL: id.email,
    GIT_COMMITTER_NAME: id.name,
    GIT_COMMITTER_EMAIL: id.email,
  };
}

/** Stages and commits every change, or those of options.paths; null when nothing changed. */
export async function commitAll(git: Git, library: string, options: CommitOptions): Promise<Committed | null> {
  const leftOut = booksWithOwnRepo(library);
  const only = options.paths ? options.paths.map((p) => `:(literal)${p}`) : null;
  const pathspec = ['--', ...(only ?? ['.']), ...leftOut.map((b) => `:(exclude)${b}`)];
  await git.run(library, ['add', '-A', ...pathspec]);
  const { stdout: staged } = await git.run(library, ['diff', '--cached', '--name-only', '-z', ...(only ? ['--', ...only] : [])]);
  const files = staged.split('\0').filter(Boolean).length;
  if (!files) return null;
  await git.run(library, [
    '-c', 'user.useConfigOnly=true',
    'commit', '-q', '--no-verify',
    '-m', SUBJECTS[options.reason],
    '-m', `Neo-Checkpoint: ${options.reason}`,
    ...(only ? ['--', ...only] : []),
  ], { env: identityEnv(options.who, options) });
  const { stdout: head } = await git.run(library, ['rev-parse', 'HEAD']);
  return { commit: head.trim(), files, leftOut };
}
