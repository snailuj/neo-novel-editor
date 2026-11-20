// One commit of everything that changed in the library, under the identity of whoever
// applied it. The author's identity comes from git config (or the plugin settings);
// user.useConfigOnly stops git guessing one from the machine's name when there is
// none. The librarian's is set through the environment, which outranks any config.
// Between staging and committing, the gate (gate.ts) judges what was staged: a librarian
// edit with a finding is refused, and any other commit goes ahead with its findings logged.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Gate } from './gate.ts';
import { excludeSpec, IGNORED, ignoreSpecs, libraryNames, literalSpec, toRepo, wholeSpec, type RepoLike } from './pathspec.ts';
import type { Git, GitLog } from './runner.ts';

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
  | 'sync'
  | 'librarian-before'
  | 'librarian-after'
  | 'import-author'
  | 'import'
  | 'page-before'
  | 'page-rename';

const SUBJECTS: Record<Reason, string> = {
  start: 'Library history starts',
  idle: 'Writing, after a pause',
  'chapter-switch': 'Writing, on moving to another chapter',
  'book-close': 'Writing, on closing the book',
  close: 'Writing, on quitting NEO',
  recovered: 'Writing found uncommitted at start',
  sync: 'Writing, before a sync with the remote',
  'librarian-before': 'Writing, before a librarian edit',
  'librarian-after': 'Librarian edit',
  'import-author': 'Pages imported to the wiki: quotations and code, as the author\'s',
  import: 'Pages imported to the wiki',
  'page-before': 'Writing, before a page rename',
  'page-rename': 'Page renamed, and the links to it rewritten',
};

// Whose commit each reason is: the librarian's own changes are theirs, all else the author's.
const LIBRARIANS: ReadonlySet<Reason> = new Set(['librarian-after', 'import']);
export const whoFor = (reason: Reason): Who => (LIBRARIANS.has(reason) ? 'librarian' : 'author');

export interface CommitOptions {
  who: Who;
  reason: Reason;
  librarian: Identity;
  /** The author's identity from the plugin settings; git config's when absent. */
  author?: Identity | null;
  /** Only these paths, relative to the library; everything else waits for the next commit. */
  paths?: readonly string[];
  /** Judges the staged files; none, and nothing is judged. */
  gate?: Pick<Gate, 'held' | 'judge'>;
  /** Trailer lines (`Neo-Device: tablet`) added under Neo-Checkpoint, in the order given. */
  trailers?: readonly string[];
  log?: GitLog;
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

/**
 * Stages and commits every change, or those of options.paths; null when nothing changed.
 * Add, diff and commit all carry the same pathspecs, rooted at the top of the work tree
 * under the library's prefix, so a file staged outside the library by anyone else is never
 * committed here, and the commit holds what was staged and judged, no more.
 */
export async function commitAll(git: Git, where: RepoLike, options: CommitOptions): Promise<Committed | null> {
  const repo = toRepo(where);
  const { library } = repo;
  const leftOut = booksWithOwnRepo(library);
  const { gate } = options;
  // Only a librarian edit blocks; every other commit warns. A refused edit's files wait
  // outside every commit but a librarian edit's, so the writer is never credited with them.
  const blocking = options.reason === 'librarian-after';
  const held = gate && !blocking ? gate.held() : [];
  const only = options.paths ? options.paths.map((p) => literalSpec(repo, p)) : [wholeSpec(repo)];
  const scope = [
    '--', ...only,
    ...ignoreSpecs(repo, IGNORED),
    ...leftOut.map((b) => excludeSpec(repo, b)),
    ...held.map((p) => excludeSpec(repo, p)),
  ];
  await git.run(library, ['add', '-A', ...scope]);
  const { stdout: staged } = await git.run(library, ['diff', '--cached', '--name-only', '-z', ...scope]);
  const names = libraryNames(repo, staged.split('\0').filter(Boolean), options.log);
  if (!names.length) return null;
  if (gate) {
    try {
      gate.judge(names, blocking);
    } catch (err) {
      await git.run(library, ['reset', '-q', '--', ...names.map((p) => literalSpec(repo, p))]);
      throw err;
    }
  }
  await git.run(library, [
    '-c', 'user.useConfigOnly=true',
    'commit', '-q', '--no-verify',
    '-m', SUBJECTS[options.reason],
    '-m', [`Neo-Checkpoint: ${options.reason}`, ...(options.trailers ?? [])].join('\n'),
    ...scope,
  ], { env: identityEnv(options.who, options) });
  const { stdout: head } = await git.run(library, ['rev-parse', 'HEAD']);
  return { commit: head.trim(), files: names.length, leftOut };
}
