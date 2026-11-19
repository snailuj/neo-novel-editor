// Shared by the server history and sync tests: a library opened with its history on a fake
// clock, and small readers of the clone's git state.
import { execFileSync } from 'node:child_process';
import { openLibrary, type LibraryOptions, type OpenLibrary } from '../../../server/library.ts';
import { fakeClock } from './clock.ts';
import { captureLog, type Hoard, type LogLine } from './hoard.ts';

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
