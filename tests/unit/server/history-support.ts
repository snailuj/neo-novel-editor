// Shared by the server history and sync tests: a library opened with its history on a fake
// clock, and small readers of the clone's git state.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openLibrary, type LibraryOptions, type OpenLibrary } from '../../../server/library.ts';
import { fakeClock } from './clock.ts';
import { captureLog, type Hoard, type LogLine } from './hoard.ts';
import { isolateGitConfig, tempDir } from './history/git-support.ts';

interface Cleanup { after(fn: () => void): void }

export const NEW = { ifNoneMatch: '*' } as const;

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

export async function openWithHistory(t: Cleanup, hoard: Hoard, extra: Partial<LibraryOptions> = {}): Promise<OpenLibrary & { time: ReturnType<typeof fakeClock>; lines: LogLine[] }> {
  const time = fakeClock();
  const captured = captureLog();
  const lib = await openLibrary({
    repo: hoard.repo, library: hoard.library, state: hoard.state, log: captured.log,
    author: null, idleSeconds: 60, syncSeconds: 0, clock: time.clock, ...extra,
  });
  t.after(async () => { await lib.close(); });
  return { ...lib, time, lines: captured.lines };
}

const hasHead = (repo: string): boolean => {
  try { git(repo, 'rev-parse', '--verify', '-q', 'HEAD'); return true; } catch { return false; }
};

/** The commits of the clone, newest first, each with its files and trailers. */
export function commits(repo: string): { sha: string; subject: string; files: string[]; devices: string[]; checkpoint: string }[] {
  if (!hasHead(repo)) return [];
  const out = git(repo, 'log', '--format=%x01%H%x02%s%x02%(trailers:key=Neo-Device,valueonly,separator=%x03)%x02%(trailers:key=Neo-Checkpoint,valueonly)', '--name-only').split('\x01').filter(Boolean);
  return out.map((block) => {
    const [head, ...files] = block.split('\n');
    const [sha, subject, devices, checkpoint] = head.split('\x02');
    return { sha, subject, files: files.filter(Boolean).sort(), devices: devices.split('\x03').filter(Boolean), checkpoint: checkpoint.trim() };
  });
}

/** A bare remote seeded with one library file, the server's clone of it, and a second clone for another writer. */
export function syncHoard(t: Cleanup): Hoard & { remote: string; other: string } {
  isolateGitConfig(t, { name: 'Test', email: 'test@example.invalid' });
  const root = tempDir(t, 'neo-sync-');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  mkdirSync(path.join(seed, 'library', 'wiki'), { recursive: true });
  writeFileSync(path.join(seed, 'library', 'wiki', 'shared.html'), 'shared v1');
  writeFileSync(path.join(seed, 'README.md'), 'a hoard');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  const repo = path.join(root, 'repo');
  const other = path.join(root, 'other');
  execFileSync('git', ['clone', '-q', remote, repo]);
  execFileSync('git', ['clone', '-q', remote, other]);
  return { repo, state: path.join(root, 'state'), library: 'library', root, remote, other };
}

/** Another writer's push: files (paths from the repo top) committed on top of the remote's main. */
export function pushFrom(other: string, files: Record<string, string | null>, message = 'from another clone'): void {
  git(other, 'pull', '-q', '--rebase', 'origin', 'main');
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(other, rel);
    if (text === null) { rmSync(file); continue; }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', message);
  git(other, 'push', '-q', 'origin', 'main');
}
