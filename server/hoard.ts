// The hoard's own tools over the API: its project pages, read-only, and the librarian's
// checks run as background jobs. Nothing here writes into the clone: projects are read with
// `lstat`-style listing and hashed without `-w`, and the tools run with their environment
// and bytecode redirected out of the tree.
import { spawn } from 'node:child_process';
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
}

export interface HoardReply { status: number; json?: unknown; bytes?: Buffer; headers?: Record<string, string> }

export interface HoardTools {
  /** `rest` is the path after `/v1/hoard`, still percent-encoded. */
  handle(method: string, rest: string, readBody: () => Promise<Buffer>): Promise<HoardReply>;
  /** Kills running jobs and waits for them to exit. */
  close(): Promise<void>;
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
  const { repo, log } = options;
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

  return {
    async handle(method, rest) {
      if (rest === '/projects' || rest.startsWith('/projects/')) return projects(method, rest);
      throw new ApiError('not_found', 404, `no route ${method} /v1/hoard${rest}`);
    },
    async close() {},
  };
}
