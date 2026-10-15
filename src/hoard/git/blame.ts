// Who wrote each paragraph of a chapter, from git blame. The chapter driver is passed on
// the command line, with an attributes file that names it, so blame reads the chapter a
// paragraph per line on any machine, set up or not; textconv's cache keeps the second
// blame of a chapter fast.
import type { Git } from './runner.ts';

export interface BlameLine {
  /** The paragraph line as the chapter driver prints it. */
  html: string;
  commit: string;
  author: string;
  email: string;
  /** Seconds since the epoch. */
  time: number;
  who: 'author' | 'librarian' | 'uncommitted';
}

export interface BlameOptions {
  librarian: { email: string };
  /** A file holding the chapter attributes line, used as git's attributes file. */
  attributesFile: string;
  textconv: { command: string; env?: Record<string, string> };
}

const UNCOMMITTED = /^0{40}$/;

// textconv's cache is a commit under refs/notes/textconv; it is NEO's, not the writer's,
// and must not fail blame on a machine with no git identity.
const CACHE_IDENTITY = {
  GIT_AUTHOR_NAME: 'NEO', GIT_AUTHOR_EMAIL: 'textconv-cache@neo-hoard.invalid',
  GIT_COMMITTER_NAME: 'NEO', GIT_COMMITTER_EMAIL: 'textconv-cache@neo-hoard.invalid',
};

/** git runs textconv through a shell: quote both paths, and give Windows' forward slashes. */
export function textconvCommand(program: string, script: string, env?: Record<string, string>) {
  const quote = (p: string) => `"${process.platform === 'win32' ? p.replace(/\\/g, '/') : p}"`;
  return { command: `${quote(program)} ${quote(script)}`, env };
}

/** The same rule as main.js's libName: one path segment, never `.` or `..`. */
function oneName(name: unknown, what: string): string {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new TypeError(`${what} must be one name inside the library`);
  }
  return name;
}

export function parseLinePorcelain(text: string, librarianEmail: string): BlameLine[] {
  const lines: BlameLine[] = [];
  let entry: Partial<BlameLine> = {};
  for (const row of text.split('\n')) {
    if (row.startsWith('\t')) {
      const commit = entry.commit ?? '';
      const email = entry.email ?? '';
      const who = UNCOMMITTED.test(commit) ? 'uncommitted' : email === librarianEmail ? 'librarian' : 'author';
      lines.push({ html: row.slice(1), commit, author: entry.author ?? '', email, time: entry.time ?? 0, who });
      entry = {};
    } else if (/^[0-9a-f]{40} /.test(row)) {
      entry.commit = row.slice(0, 40);
    } else if (row.startsWith('author ')) {
      entry.author = row.slice(7);
    } else if (row.startsWith('author-mail ')) {
      entry.email = row.slice(12).replace(/^<|>$/g, '');
    } else if (row.startsWith('author-time ')) {
      entry.time = Number(row.slice(12));
    }
  }
  return lines;
}

export async function blameChapter(
  git: Git,
  library: string,
  ids: { bookId: unknown; chId: unknown },
  options: BlameOptions,
): Promise<BlameLine[]> {
  const file = `${oneName(ids.bookId, 'bookId')}/chapters/${oneName(ids.chId, 'chId')}.html`;
  const { stdout } = await git.run(library, [
    '-c', `core.attributesFile=${options.attributesFile}`,
    '-c', `diff.neochapter.textconv=${options.textconv.command}`,
    '-c', 'diff.neochapter.cachetextconv=true',
    'blame', '--line-porcelain', '--', file,
  ], { env: { ...CACHE_IDENTITY, ...options.textconv.env } });
  return parseLinePorcelain(stdout, options.librarian.email);
}
