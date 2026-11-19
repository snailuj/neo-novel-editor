// Runs git for the library's history. Every failure keeps what went wrong: the exit
// code and stderr of a command that failed, or that git timed out or could not start,
// so a locked or corrupt repository is never read as an empty answer. Every call skips
// the repository's own hooks (a hook that arrived with a synced library must not stall
// a commit), never prompts for credentials and never signs.
import { execFile } from 'node:child_process';

export type GitLog = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

export type GitErrorKind = 'exit' | 'timeout' | 'missing' | 'overflow' | 'spawn';

export class GitError extends Error {
  readonly kind: GitErrorKind;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(kind: GitErrorKind, args: readonly string[], detail: {
    exitCode?: number | null; signal?: string | null; stderr?: string; stdout?: string; cause?: unknown;
  }) {
    const exitCode = detail.exitCode ?? null;
    const stderr = detail.stderr ?? '';
    const what = kind === 'exit' ? `exit ${exitCode}` : kind;
    const tail = stderr.trim().split('\n').slice(-3).join(' | ');
    super(`git ${args.join(' ')}: ${what}${tail ? `: ${tail}` : ''}`, { cause: detail.cause });
    this.name = 'GitError';
    this.kind = kind;
    this.args = args;
    this.exitCode = exitCode;
    this.signal = detail.signal ?? null;
    this.stderr = stderr;
    this.stdout = detail.stdout ?? '';
  }
}

export interface GitRunOptions {
  /** Default 30 s. */
  timeoutMs?: number;
  /** Bytes of stdout or stderr kept before the call fails as overflow. Default 16 MiB. */
  maxBuffer?: number;
  /** Added to the environment git runs with. */
  env?: Record<string, string>;
}

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface Git {
  run(cwd: string, args: readonly string[], options?: GitRunOptions): Promise<GitResult>;
}

export interface GitConfig {
  /** The git binary. Default `git`, found on the PATH. */
  git?: string;
  /** Arguments put before everything else; lets a test stand a script in for git. */
  prefix?: readonly string[];
  /** An empty folder git is told holds the hooks. */
  hooksPath: string;
  log?: GitLog;
}

interface ExecFailure extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function classify(err: ExecFailure): GitErrorKind {
  if (err.code === 'ENOENT') return 'missing';
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'overflow';
  if (err.killed) return 'timeout';
  if (typeof err.code === 'number') return 'exit';
  return 'spawn';
}

export function createGit(config: GitConfig): Git {
  const binary = config.git || 'git';
  const fixed = ['-c', `core.hooksPath=${config.hooksPath}`, '-c', 'commit.gpgsign=false'];
  const log = config.log ?? (() => {});
  return {
    run(cwd, args, options = {}) {
      const full = [...(config.prefix ?? []), ...fixed, ...args];
      const start = performance.now();
      return new Promise((resolve, reject) => {
        execFile(binary, full, {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        }, (err, stdout, stderr) => {
          const ms = Math.round(performance.now() - start);
          if (!err) {
            log('debug', 'git.run', { args, exitCode: 0, ms });
            resolve({ stdout, stderr });
            return;
          }
          const failure = err as ExecFailure;
          const kind = classify(failure);
          const exitCode = typeof failure.code === 'number' ? failure.code : null;
          log('debug', 'git.run', { args, exitCode, kind, ms });
          reject(new GitError(kind, args, {
            exitCode, signal: failure.signal ?? null, stderr, stdout, cause: err,
          }));
        });
      });
    },
  };
}
