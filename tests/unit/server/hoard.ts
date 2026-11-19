// A temporary hoard repo and state folder for the server's tests, and a log that keeps its lines.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isolateGitConfig, tempDir } from '../git-support.ts';

interface Cleanup { after(fn: () => void): void }

export interface LogLine { level: string; msg: string; [key: string]: unknown }

export function captureLog(): { lines: LogLine[]; log: (level: string, msg: string, data?: Record<string, unknown>) => void } {
  const lines: LogLine[] = [];
  return { lines, log: (level, msg, data) => { lines.push({ level, msg, ...data }); } };
}

export interface Hoard { repo: string; state: string; library: string; root: string }

/** A git repo with no commits, a state folder beside it (never inside), and an isolated git config. */
export function tempHoard(t: Cleanup, library = 'library'): Hoard {
  isolateGitConfig(t, { name: 'Test', email: 'test@example.invalid' });
  const root = tempDir(t, 'neo-server-');
  const repo = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  return { repo, state: path.join(root, 'state'), library, root };
}
