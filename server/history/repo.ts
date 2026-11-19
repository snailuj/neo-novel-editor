// Which repository, if any, holds the library. The layer commits only when the library
// folder is the top of its own repository: a library inside a bigger repository would
// sweep the writer's other files into the book's history.
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { GitError, type Git } from './runner.ts';

export type RepoState =
  | { state: 'tracked'; top: string }
  | { state: 'untracked' }
  | { state: 'inside-another-repo'; top: string }
  | { state: 'no-git'; error: string };

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try { return realpathSync.native(p); } catch { return path.resolve(p); }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' || process.platform === 'darwin'
    ? x.toLowerCase() === y.toLowerCase()
    : x === y;
}

export async function repoState(git: Git, library: string): Promise<RepoState> {
  try {
    const { stdout } = await git.run(library, ['rev-parse', '--show-toplevel']);
    const top = stdout.trim();
    return samePath(top, library) ? { state: 'tracked', top } : { state: 'inside-another-repo', top };
  } catch (err) {
    if (err instanceof GitError && err.kind === 'exit' && /not a git repository/i.test(err.stderr)) {
      return { state: 'untracked' };
    }
    if (err instanceof GitError && err.kind === 'missing') return { state: 'no-git', error: err.message };
    throw err;
  }
}

/**
 * The sync service that keeps the library folder, or null. Two machines writing one
 * synced .git folder can corrupt it, so the layer warns when it finds one.
 */
export function syncedFolder(library: string): string | null {
  if (existsSync(path.join(library, '.stfolder'))) return 'Syncthing';
  if (/[\\/](Mobile Documents|iCloudDrive)[\\/]/i.test(library)) return 'iCloud Drive';
  return null;
}
