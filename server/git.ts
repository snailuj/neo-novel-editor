// The only git the server runs: hash a file's bytes into the repo's object store, and
// read HEAD. The version of a file is the blob id of its RAW bytes, so every hash uses
// `--no-filters`: `.gitattributes` and `core.autocrlf` must never change a version.
import { spawn } from 'node:child_process';
import { GitError } from '../src/hoard/git/runner.ts';

export { GitError };

interface Done { stdout: string; stderr: string; code: number | null }

function run(cwd: string, args: readonly string[], input?: Buffer | string, timeoutMs = 120_000): Promise<Done> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    // git may exit before reading all of stdin; the exit code says why, so EPIPE is not the story.
    child.stdin.on('error', () => {});
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new GitError(e.code === 'ENOENT' ? 'missing' : 'spawn', args, { cause: e }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) reject(new GitError('timeout', args, { signal, stderr, stdout }));
      else resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}

async function ok(cwd: string, args: readonly string[], input?: Buffer | string): Promise<string> {
  const done = await run(cwd, args, input);
  if (done.code !== 0) throw new GitError('exit', args, { exitCode: done.code, stderr: done.stderr, stdout: done.stdout });
  return done.stdout;
}

export interface RepoGit {
  /** Blob id of `bytes`, written to the object store. */
  hashBytes(bytes: Buffer): Promise<string>;
  /** Blob ids of the files at `absolutePaths`, in order, from one git process. */
  hashPaths(absolutePaths: readonly string[]): Promise<string[]>;
  /** The commit HEAD names, or null while the repo has no commit. */
  head(): Promise<string | null>;
}

export function createRepoGit(repo: string): RepoGit {
  return {
    async hashBytes(bytes) {
      return (await ok(repo, ['hash-object', '-w', '--no-filters', '--stdin'], bytes)).trim();
    },
    async hashPaths(absolutePaths) {
      if (absolutePaths.length === 0) return [];
      const args = ['hash-object', '-w', '--no-filters', '--stdin-paths'];
      const ids = (await ok(repo, args, `${absolutePaths.join('\n')}\n`)).split('\n').filter(Boolean);
      if (ids.length !== absolutePaths.length) {
        throw new GitError('exit', args, { stdout: `${ids.length} ids for ${absolutePaths.length} paths` });
      }
      return ids;
    },
    async head() {
      const args = ['rev-parse', '--verify', '--quiet', 'HEAD'];
      const done = await run(repo, args);
      if (done.code === 0) return done.stdout.trim();
      // --quiet exits 1 with no message for a ref that does not resolve; anything else is a real failure.
      if (done.code === 1 && done.stderr.trim() === '') return null;
      throw new GitError('exit', args, { exitCode: done.code, stderr: done.stderr });
    },
  };
}

/** True when `dir` is inside a git work tree. */
export async function isWorkTree(dir: string): Promise<boolean> {
  try {
    const done = await run(dir, ['rev-parse', '--is-inside-work-tree']);
    return done.code === 0 && done.stdout.trim() === 'true';
  } catch (e) {
    if (e instanceof GitError && e.kind === 'spawn') return false;
    throw e;
  }
}
