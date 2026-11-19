// A temporary hoard repo and state folder for the server's tests, and a log that keeps its lines.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ApiError } from '../../../server/errors.ts';
import { openTree, type Tree } from '../../../server/tree.ts';
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

export async function openTestTree(hoard: Hoard, log = captureLog()): Promise<{ tree: Tree; lines: LogLine[] }> {
  const tree = await openTree({ repo: hoard.repo, library: hoard.library, state: hoard.state, log: log.log });
  return { tree, lines: log.lines };
}

/** Asserts that `p` rejects with an ApiError of this code and status, and returns it. */
export async function refused(p: Promise<unknown>, code: string, status: number): Promise<ApiError> {
  const e = await p.then(() => assert.fail('accepted'), (err: unknown) => err);
  assert.ok(e instanceof ApiError, String(e));
  assert.equal(e.code, code);
  assert.equal(e.status, status);
  return e;
}
