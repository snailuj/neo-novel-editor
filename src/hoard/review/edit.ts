// A page edited by its id (pages.edit), and the librarian's pages named by id
// (review.owners). The librarian's edit is the one rule here that wiki/write.ts also
// keeps for chapters, so it lives once, in asLibrarian.
//
// The librarian's change sits between two commits (GitLayer.around): what the writer had
// pending is committed as theirs, then the page as the librarian's. When the pre-commit
// gate refuses that commit, the page is put back as it was, so the change is in neither
// the history nor the file. The writer's own change is left to the next checkpoint, as
// their typing is.
//
// The librarian writes only a wiki page its sidecar makes its own (ownerOf): never a
// sources page, never an author-owned wiki page. It suggests on those instead (marks).
import { existsSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { GateRefused, type Finding } from '../git/gate.ts';
import type { GitLayer } from '../git/layer.ts';
import { parseId, type Tree } from '../pages/identity.ts';
import type { PageStore } from '../pages/store.ts';
import { ownerOf } from './owner.ts';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

export type Refusal = 'missing' | 'stale';

export type Written =
  | { ok: true }
  | { ok: false; reason: Refusal }
  | { ok: false; reason: 'refused'; findings: Finding[] };

export type Edited = Written | { ok: false; reason: 'owned' };

/**
 * Runs `swap` (which writes `paths` and returns why it could not, or null) between the
 * librarian's two commits. A gate refusal calls `restore` and answers 'refused'; any
 * other error goes on. A restored file is released from the gate's hold; a `restore` that
 * throws leaves it held and the error goes on.
 */
export async function asLibrarian(
  o: { layer: Pick<GitLayer, 'around' | 'release'>; log: Log },
  label: string,
  subject: Record<string, unknown>,
  paths: readonly string[],
  swap: () => Promise<Refusal | null>,
  restore: () => void | Promise<void>,
): Promise<Written> {
  try {
    const { result: refused, after } = await o.layer.around(paths, swap);
    if (refused) return { ok: false, reason: refused };
    o.log('info', label, { ...subject, as: 'librarian', commit: after });
    return { ok: true };
  } catch (err) {
    if (!(err instanceof GateRefused)) throw err;
    await restore();
    o.layer.release(paths); // the gate holds a refused file until the writer saves it; put back, it is theirs again
    o.log('warn', `${label}: the library check refused the librarian's change, so the page is as it was`, { ...subject, findings: err.findings });
    return { ok: false, reason: 'refused', findings: err.findings };
  }
}

export interface PageEdit {
  /** The page's id, <tree>/<path>. */
  page: string;
  /** The page's HTML as the caller read it. */
  before: string;
  /** The page's HTML with the change. */
  after: string;
  as: 'librarian' | 'author';
}

export interface PageEditorOptions {
  library(): string;
  store: Pick<PageStore, 'write'>;
  layer: Pick<GitLayer, 'around' | 'release'>;
  log: Log;
  /** Told the page's id once the author's edit of it is written; never for the librarian's. */
  saved?: (page: string) => void;
}

export async function editPage(o: PageEditorOptions, ask: PageEdit): Promise<Edited> {
  const { page, before, after } = ask;
  parseId(page);
  const swap = async (): Promise<Refusal | null> => {
    const written = await o.store.write(page, before, after);
    return written.ok ? null : written.reason;
  };
  if (ask.as === 'author') {
    const refused = await swap();
    if (refused) return { ok: false, reason: refused };
    o.log('info', 'pages.edit', { page, as: 'author' });
    o.saved?.(page);
    return { ok: true };
  }
  if (await ownerOf(o.library(), page, o.log) !== 'librarian') {
    o.log('warn', 'pages.edit: the librarian writes only its own wiki pages, so the page is as it was', { page });
    return { ok: false, reason: 'owned' };
  }
  const restore = async (): Promise<void> => {
    const put = await o.store.write(page, after, before);
    if (put.ok) return;
    // The page is no longer what the swap wrote, so the refused text may still be on disk: it stays held.
    o.log('error', 'pages.edit: the refused librarian change could not be put back, so the page stays held', { page, reason: put.reason });
    throw new Error(`pages.edit: could not put ${page} back after the library check refused the change (${put.reason})`);
  };
  return asLibrarian(o, 'pages.edit', { page }, [page], swap, restore);
}

const CHUNK = 64;

/** Those of `pages` that are the librarian's. Reads sidecars, never page bodies. */
export async function librarianAmong(library: string, pages: readonly string[], log: Log): Promise<string[]> {
  const found: string[] = [];
  for (let i = 0; i < pages.length; i += CHUNK) {
    const chunk = pages.slice(i, i + CHUNK);
    const owners = await Promise.all(chunk.map((p) => ownerOf(library, p, log)));
    chunk.forEach((p, n) => { if (owners[n] === 'librarian') found.push(p); });
  }
  return found;
}

async function* sidecars(dir: string, rel: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await opendir(path.join(dir, rel));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const names: { name: string; dir: boolean }[] = [];
  for await (const e of entries) names.push({ name: e.name, dir: e.isDirectory() });
  for (const { name, dir: isDir } of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const next = rel ? `${rel}/${name}` : name;
    if (isDir) yield* sidecars(dir, next);
    else if (name.endsWith('.html.json') && !name.startsWith('.')) yield next.slice(0, -'.json'.length);
  }
}

/**
 * The librarian's pages in one tree. A page without a sidecar is the author's, so the
 * sidecars are the whole answer; one whose page is gone, or that does not read, is left out.
 */
export async function librarianInTree(library: string, tree: Tree, log: Log): Promise<string[]> {
  if (tree === 'sources') return [];
  const dir = path.join(library, '.neo', 'pages', tree);
  const ids: string[] = [];
  for await (const rel of sidecars(dir, '')) {
    const id = `${tree}/${rel}`;
    try {
      parseId(id);
    } catch {
      log('warn', `review: ${id} is not a page id, so it is not the librarian's`);
      continue;
    }
    if (existsSync(path.join(library, tree, ...rel.split('/')))) ids.push(id);
  }
  return librarianAmong(library, ids, log);
}
