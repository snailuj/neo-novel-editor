// The hoard's own tools over the API: its project pages, read-only, and the librarian's
// checks run as background jobs. Nothing here writes into the clone: projects are read with
// `lstat`-style listing and hashed without `-w`, and the tools run with their environment
// and bytecode redirected out of the tree.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.ts';
import { createRepoGit } from './git.ts';
import type { Log } from './log.ts';

export interface HoardToolsOptions {
  /** The hoard clone. */
  repo: string;
  /** The server state folder, outside the repo. */
  state: string;
  log: Log;
  /** `uv` itself; `args` go before `run`. */
  uv?: { command: string; args?: string[] };
  /** Bytes kept per output stream. */
  outputLimit?: number;
  /** Finished jobs remembered. */
  keepJobs?: number;
  timeoutMs?: number;
  /** How long `uv --version` may take before uv counts as unavailable. */
  probeTimeoutMs?: number;
}

export interface HoardReply { status: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> }

export interface HoardTools {
  /** `rest` is the path after `/v1/hoard`, still percent-encoded. */
  handle(method: string, rest: string, readBody: () => Promise<Buffer>): Promise<HoardReply>;
  /** Kills running jobs and waits for them to exit. */
  close(): Promise<void>;
}

const TOOLS = ['lint', 'verify', 'quotes'] as const;
type Tool = (typeof TOOLS)[number];

interface Job {
  id: string; tool: Tool; state: 'running' | 'done' | 'failed';
  exitCode: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean;
  startedAt: string; endedAt: string | null; ms: number | null; reason?: string;
}

const methodNotAllowed = () => new ApiError('method_not_allowed', 405, 'method not allowed for this route');

/** NFC, non-empty, no separators, no leading dot, no NUL. */
function projectName(encoded: string): string {
  let name: string;
  try {
    name = decodeURIComponent(encoded).normalize('NFC');
  } catch {
    throw new ApiError('bad_name', 400, 'the name is not valid percent-encoding');
  }
  if (name === '' || /[/\\\0]/.test(name) || name.startsWith('.')) throw new ApiError('bad_name', 400, 'the project name is not valid');
  return name;
}

export async function openHoardTools(options: HoardToolsOptions): Promise<HoardTools> {
  const { repo, state, log, outputLimit = 2 * 1024 * 1024, keepJobs = 20, timeoutMs = 10 * 60_000, probeTimeoutMs = 10_000 } = options;
  const uv = { command: options.uv?.command ?? 'uv', args: options.uv?.args ?? [] };
  const git = createRepoGit(repo);
  const projectsDir = path.join(repo, 'projects');

  /** Regular `.md` files directly in projects/, by real file name. Dirent comes from lstat, so links and folders are out. */
  async function pages(): Promise<{ name: string; file: string }[] | null> {
    let entries;
    try {
      entries = await readdir(projectsDir, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      log('warn', 'hoard.projects.missing', { dir: projectsDir });
      return null;
    }
    return entries.filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => ({ name: d.name.slice(0, -'.md'.length).normalize('NFC'), file: d.name }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async function projects(method: string, rest: string): Promise<HoardReply> {
    if (method !== 'GET') throw methodNotAllowed();
    if (rest === '/projects') {
      const found = (await pages()) ?? [];
      log('info', 'hoard.projects.list', { count: found.length });
      return { status: 200, json: { projects: found.map((p) => ({ name: p.name })) } };
    }
    const name = projectName(rest.slice('/projects/'.length));
    // Exact match against the listing: the host disk may fold case, the API must not.
    const page = (await pages())?.find((p) => p.name === name);
    if (!page) throw new ApiError('not_found', 404, `no project ${JSON.stringify(name)}`);
    const bytes = await readFile(path.join(projectsDir, page.file));
    log('info', 'hoard.project.read', { name, bytes: bytes.length });
    return { status: 200, bytes, headers: { 'Content-Type': 'text/markdown; charset=utf-8', ETag: `"${await git.blobId(bytes)}"` } };
  }

  // Why uv cannot run, or null. Probed at start and again on a request while it is down,
  // so installing uv needs no restart.
  let unavailable: string | null = null;
  let probing: Promise<void> | null = null;

  /** Resolves with the reason uv cannot run, or null. Never rejects: spawn may throw as well as emit. */
  function probeOnce(): Promise<{ reason: string | null; version: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let version = '';
      let child: ChildProcess | undefined;
      const finish = (reason: string | null) => {
        if (settled) return; // a failed spawn emits 'error' and may then emit 'close'
        settled = true;
        clearTimeout(timer);
        resolve({ reason, version: version.trim() });
      };
      const timer = setTimeout(() => {
        child?.kill();
        finish(`uv --version did not answer within ${probeTimeoutMs} ms`);
      }, probeTimeoutMs);
      const failed = (e: NodeJS.ErrnoException) => finish(e.code === 'ENOENT' ? `uv was not found on the host (${e.message})` : `uv could not be started (${e.message})`);
      try {
        child = spawn(uv.command, [...uv.args, '--version'], { cwd: repo, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) {
        failed(e as NodeJS.ErrnoException);
        return;
      }
      child.stdout?.on('data', (c: Buffer) => { version += c.toString('utf8'); });
      child.on('error', failed);
      child.on('close', (code) => { finish(code === 0 ? null : `uv --version exited with code ${code}`); });
    });
  }

  function probe(): Promise<void> {
    probing ??= probeOnce().then(({ reason, version }) => {
      unavailable = reason;
      log(reason === null ? 'info' : 'warn', 'hoard.uv.probe', { available: reason === null, reason, version });
    }).finally(() => { probing = null; });
    return probing;
  }
  await probe();

  const jobs = new Map<string, Job>();
  const ended: string[] = []; // finished job ids, oldest end first
  const running = new Map<Tool, Job>();
  const live = new Map<string, { child: ChildProcess; exited: Promise<void> }>();

  function evict(id: string): void {
    ended.push(id);
    for (const old of ended.splice(0, Math.max(0, ended.length - keepJobs))) jobs.delete(old);
  }

  function start(tool: Tool): Job {
    const t0 = performance.now();
    const job: Job = {
      id: randomUUID(), tool, state: 'running', exitCode: null, signal: null, stdout: '', stderr: '', truncated: false,
      startedAt: new Date().toISOString(), endedAt: null, ms: null,
    };
    const env = { ...process.env, UV_PROJECT_ENVIRONMENT: path.join(state, 'hoard-venv'), PYTHONDONTWRITEBYTECODE: '1' };
    const args = [...uv.args, 'run', '--project', '_meta/infra/tools', 'python', '_meta/infra/tools/librarian/cli.py', tool];
    const out: Buffer[][] = [[], []];
    const kept = [0, 0];
    const keep = (i: number) => (chunk: Buffer) => {
      const room = Math.max(0, outputLimit - kept[i]);
      if (chunk.length > room) job.truncated = true;
      if (room > 0) { out[i].push(chunk.subarray(0, room)); kept[i] += Math.min(room, chunk.length); }
    };
    jobs.set(job.id, job);
    running.set(tool, job);
    log('info', 'hoard.job.start', { id: job.id, tool });

    let settle!: () => void;
    const exited = new Promise<void>((resolve) => { settle = resolve; });
    let timer: NodeJS.Timeout | undefined;
    const end = (state: 'done' | 'failed', exitCode: number | null, signal: string | null) => {
      if (job.state !== 'running') return;
      job.state = state;
      job.exitCode = exitCode;
      job.signal = signal;
      job.stdout = Buffer.concat(out[0]).toString('utf8');
      job.stderr = Buffer.concat(out[1]).toString('utf8');
      job.endedAt = new Date().toISOString();
      job.ms = Math.round(performance.now() - t0);
      running.delete(tool);
      live.delete(job.id);
      clearTimeout(timer);
      evict(job.id);
      log(state === 'done' ? 'info' : 'warn', 'hoard.job.end', { id: job.id, tool, state, exitCode, signal, reason: job.reason, ms: job.ms, truncated: job.truncated });
      settle();
    };

    let child: ChildProcess;
    try {
      child = spawn(uv.command, args, { cwd: repo, shell: false, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      // spawn throws for some bad paths and arguments instead of emitting 'error'.
      job.reason = `spawn failed (${(e as Error).message})`;
      end('failed', null, null);
      return job;
    }
    live.set(job.id, { child, exited });
    child.stdout.on('data', keep(0));
    child.stderr.on('data', keep(1));
    timer = setTimeout(() => {
      job.reason ??= 'timeout';
      child.kill();
      // A tool that ignores the polite kill must not hold the job open for ever.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.on('error', (e) => { job.reason ??= `spawn failed (${e.message})`; end('failed', null, null); });
    child.on('close', (code, signal) => {
      if (job.reason === undefined && code === null) job.reason = `killed by ${signal}`;
      end(job.reason === undefined ? 'done' : 'failed', code, signal);
    });
    return job;
  }

  async function librarian(method: string, rest: string, readBody: () => Promise<Buffer>): Promise<HoardReply> {
    const tail = rest.slice('/librarian/'.length);
    if (tail.startsWith('jobs/')) {
      if (method !== 'GET') throw methodNotAllowed();
      let id = tail.slice('jobs/'.length);
      try { id = decodeURIComponent(id); } catch { /* an undecodable id matches no job */ }
      const found = jobs.get(id);
      if (!found) throw new ApiError('not_found', 404, 'no such job');
      return { status: 200, json: found };
    }
    if (method !== 'POST') throw methodNotAllowed();
    const tool = TOOLS.find((name) => name === tail);
    if (!tool) throw new ApiError('unknown_tool', 404, `unknown librarian tool ${JSON.stringify(tail)}`);
    await readBody(); // ignored, but read so the limit applies and the connection is left clean
    if (unavailable !== null) await probe();
    if (unavailable !== null) throw new ApiError('tool_unavailable', 503, unavailable);
    const job = running.get(tool) ?? start(tool);
    return { status: 202, json: { id: job.id, tool: job.tool, state: job.state, startedAt: job.startedAt } };
  }

  return {
    async handle(method, rest, readBody) {
      if (rest === '/projects' || rest.startsWith('/projects/')) return projects(method, rest);
      if (rest.startsWith('/librarian/')) return librarian(method, rest, readBody);
      throw new ApiError('not_found', 404, `no route ${method} /v1/hoard${rest}`);
    },
    async close() {
      const pending = [...live.values()];
      for (const { child } of pending) child.kill();
      await Promise.all(pending.map((p) => p.exited));
    },
  };
}
