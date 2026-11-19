// The library tree: the only module that writes library files. It owns the path-to-version
// index and the seq, and one queue serialises every write, so the HTTP handlers and any
// later server code that go through it cannot disagree about either.
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from './errors.ts';
import { makeSyncDir, renameRetrying, writeFileDurable, type SyncDir } from './durable.ts';
import { createRepoGit } from './git.ts';
import type { Log } from './log.ts';
import { checkPath, foldKey, TEMP_PREFIX } from './paths.ts';
import { assertOutsideRepo, loadState, saveState, type Entry } from './state.ts';

export interface TreeOptions {
  repo: string; library: string; state: string; log: Log;
  /** Folder fsync; a test records the calls. */
  syncDir?: SyncDir;
  /** Reads a library file; a test interleaves a write with it. */
  readFile?: (file: string) => Promise<Buffer>;
}
export interface Preconditions { ifMatch?: string; ifNoneMatch?: string }
export interface Change { path: string; version: string | null }

export interface Tree {
  state(): Promise<{ epoch: string; seq: number; head: string | null; library: string; serverTime: string }>;
  currentSeq(): number;
  changes(since: number, limit: number): { epoch: string; seq: number; changes: Change[]; more: boolean };
  read(p: string): Promise<{ bytes: Buffer; version: string }>;
  put(p: string, bytes: Buffer, pre: Preconditions): Promise<{ version: string; seq: number }>;
  remove(p: string, ifMatch: string | undefined): Promise<{ seq: number }>;
  move(from: string, to: string, ifMatch: string | undefined): Promise<{ version: string; seq: number }>;
  /** Waits for queued writes to finish. */
  close(): Promise<void>;
}

const stale = (version: string | null) => new ApiError('stale', 412, 'the base version is not the current version', { version });
const notFound = (p: string) => new ApiError('not_found', 404, `no such file: ${p}`);
const needsPrecondition = () => new ApiError('precondition_required', 428, 'send If-Match with the version you saw, or If-None-Match: * to create');

/** Every file under `root` whose relative path is acceptable; the rest are logged and skipped. */
async function walk(root: string, log: Log): Promise<string[]> {
  const found: string[] = [];
  async function visit(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const entry of entries) {
      const relative = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.name.startsWith(TEMP_PREFIX)) {
        // Only this process writes here, and it has not started yet, so a temp file is the debris of a crash.
        if (!entry.isFile()) { log('warn', 'reconcile.skip_bad_path', { path: relative }); continue; }
        try {
          await unlink(path.join(abs, entry.name));
          log('warn', 'reconcile.temp_removed', { path: relative });
        } catch (e) {
          log('warn', 'reconcile.temp_remove_failed', { path: relative, code: (e as NodeJS.ErrnoException).code });
        }
        continue;
      }
      try { checkPath(relative); } catch { log('warn', 'reconcile.skip_bad_path', { path: relative }); continue; }
      if (entry.isDirectory()) await visit(path.join(abs, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
      else log('warn', 'reconcile.skip_special', { path: relative });
    }
  }
  await visit(root, '');
  return found.sort();
}

export async function openTree(options: TreeOptions): Promise<Tree> {
  const { repo, state: stateDir, log } = options;
  const libraryName = checkPath(options.library.replace(/\/+$/, ''));
  const libraryDir = path.join(repo, ...libraryName.split('/'));
  const git = createRepoGit(repo);
  const sync = options.syncDir ?? makeSyncDir(log);
  const readBytes = options.readFile ?? ((file: string) => readFile(file));
  const onDisk = (p: string) => path.join(libraryDir, ...p.split('/'));

  await assertOutsideRepo(stateDir, repo);
  try {
    await readdir(libraryDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    await mkdir(libraryDir, { recursive: true });
    log('info', 'library.created', { dir: libraryDir });
  }

  const loaded = await loadState(stateDir, log);
  if (loaded === null) log('warn', 'state.fresh', { stateDir, note: 'seq restarts from 0: clients must resync when state.seq is below their own' });
  // A fresh or rebuilt index starts a new epoch: its seqs mean nothing to a client of the old one.
  const epoch = loaded?.epoch ?? randomUUID();
  let seq = loaded?.seq ?? 0;
  const index = new Map<string, Entry>(Object.entries(loaded?.entries ?? {}));
  /** Fold key of every live path, for the case-clash scan. */
  const folds = new Map<string, string>();
  for (const [p, e] of index) if (e.version !== null) folds.set(p, foldKey(p));

  function setEntry(p: string, version: string | null, at: number): void {
    index.set(p, { version, seq: at });
    if (version === null) folds.delete(p); else folds.set(p, foldKey(p));
  }
  /** Creates the folders above `dir`, and fsyncs the parent of each one it made. */
  async function mkdirDurable(dir: string): Promise<void> {
    const first = await mkdir(dir, { recursive: true });
    if (first === undefined) return;
    let made = first;
    for (const part of path.relative(first, dir).split(path.sep).filter(Boolean).concat('')) {
      await sync(path.dirname(made));
      if (part === '') break;
      made = path.join(made, part);
    }
  }

  /** Removes the folders `p` sat in that are now empty, up to the library root, and fsyncs the one it stopped at. */
  async function pruneEmptyParents(p: string): Promise<void> {
    let removed = false;
    let stoppedAt = libraryDir;
    for (let dir = path.posix.dirname(p); dir !== '.'; dir = path.posix.dirname(dir)) {
      try {
        await rmdir(onDisk(dir));
        removed = true;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') log('warn', 'prune.failed', { dir, code });
        stoppedAt = onDisk(dir);
        break;
      }
    }
    if (removed) await sync(stoppedAt);
  }
  const persist = () => saveState(stateDir, { format: 1, epoch, seq, entries: Object.fromEntries(index) }, sync);

  // Reconcile the index with the disk: whatever differs was changed while the server was
  // down (or the state folder was lost), and gets a seq like any other change.
  {
    const files = await walk(libraryDir, log);
    const versions = await git.hashPaths(files.map(onDisk));
    const present = new Set(files);
    let changed = 0;
    // Vanished files first: a rename the server did not finish recording then replays as delete, then create.
    for (const [p, e] of [...index].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (e.version === null || present.has(p)) continue;
      seq += 1; changed += 1;
      setEntry(p, null, seq);
      log('info', 'reconcile.vanished', { path: p, seq });
    }
    files.forEach((p, i) => {
      if (index.get(p)?.version === versions[i]) return;
      seq += 1; changed += 1;
      setEntry(p, versions[i], seq);
      log('info', 'reconcile.changed', { path: p, version: versions[i], seq });
    });
    if (changed > 0 || loaded === null) await persist();
    log('info', 'reconcile.done', { files: files.length, changed, seq });
  }

  // One write at a time. `busy` lets a read of a path being written wait for the write.
  let tail: Promise<unknown> = Promise.resolve();
  const busy = new Map<string, number>();
  function enqueue<T>(paths: string[], job: () => Promise<T>): Promise<T> {
    for (const p of paths) busy.set(p, (busy.get(p) ?? 0) + 1);
    const result = tail.then(job);
    tail = result.then(() => {}, () => {});
    const release = () => { for (const p of paths) { const n = (busy.get(p) ?? 1) - 1; if (n === 0) busy.delete(p); else busy.set(p, n); } };
    result.then(release, release);
    return result;
  }

  /** A live path that `p` cannot coexist with on a case-insensitive disk or in a tree (file vs folder). */
  function conflict(p: string, ignore?: string): ApiError | null {
    const f = foldKey(p);
    const dirs: string[] = [];
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) dirs.push(p.slice(0, i));
    const dirFolds = dirs.map(foldKey);
    // O(live paths) per create; creates are rare next to updates and a library is thousands of files.
    for (const [q, fq] of folds) {
      // The source of a move is exempt only from the exact-name clash, so a case-only rename works.
      if (fq === f && q !== ignore) return new ApiError('case_clash', 409, `${p} differs only by case from ${q}`, { path: q });
      if (f.startsWith(`${fq}/`) || fq.startsWith(`${f}/`)) return new ApiError('path_conflict', 409, `${p} cannot be a file and a folder: ${q}`, { path: q });
      for (let d = 0; d < dirs.length; d += 1) {
        if (fq.startsWith(`${dirFolds[d]}/`) && !q.startsWith(`${dirs[d]}/`)) return new ApiError('case_clash', 409, `folder ${dirs[d]} differs only by case from the folder of ${q}`, { path: q });
      }
    }
    return null;
  }

  return {
    async state() {
      return { epoch, seq, head: await git.head(), library: `${libraryName}/`, serverTime: new Date().toISOString() };
    },

    currentSeq: () => seq,

    changes(since, limit) {
      const later = [...index].filter(([, e]) => e.seq > since)
        // Within one seq the tombstone comes first, so a client whose disk folds case applies a
        // case-only move as delete then create, never create then delete of the same file.
        .sort(([pa, a], [pb, b]) => (a.seq - b.seq) || (Number(a.version !== null) - Number(b.version !== null)) || (pa < pb ? -1 : 1));
      let end = Math.min(limit, later.length);
      // A group sharing one seq (a move) is never split across pages.
      while (end > 0 && end < later.length && later[end][1].seq === later[end - 1][1].seq) end += 1;
      const page = later.slice(0, end);
      const more = end < later.length;
      return {
        epoch,
        seq: more ? page[page.length - 1][1].seq : seq,
        changes: page.map(([p, e]) => ({ path: p, version: e.version })),
        more,
      };
    },

    async read(p) {
      checkPath(p);
      // Reads do not queue, so a write can land while the bytes are being read. The read
      // counts only if no write touched the path meanwhile; otherwise it starts again.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        while (busy.has(p)) await tail;
        const entry = index.get(p);
        if (entry?.version == null) throw notFound(p);
        let bytes: Buffer | null = null;
        try {
          bytes = await readBytes(onDisk(p));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (busy.has(p) || index.get(p)?.seq !== entry.seq) continue;
        if (bytes === null) {
          log('warn', 'read.missing_on_disk', { path: p, version: entry.version });
          throw notFound(p);
        }
        return { bytes, version: entry.version };
      }
      throw new Error(`reading ${p} kept overlapping writes`);
    },

    async put(p, bytes, { ifMatch, ifNoneMatch }) {
      checkPath(p);
      const version = await git.hashBytes(bytes);
      return enqueue([p], async () => {
        const current = index.get(p)?.version ?? null;
        if (current === version) return { version, seq };
        if (current !== null) {
          if (ifNoneMatch === '*') throw stale(current);
          if (ifMatch === undefined) throw needsPrecondition();
          if (ifMatch !== current) throw stale(current);
        } else {
          if (ifMatch !== undefined) throw stale(null);
          if (ifNoneMatch !== '*') throw needsPrecondition();
          const clash = conflict(p);
          if (clash) throw clash;
        }
        const file = onDisk(p);
        await mkdirDurable(path.dirname(file));
        await writeFileDurable(file, bytes, sync);
        const before = seq;
        seq += 1;
        setEntry(p, version, seq);
        await persist();
        log('info', 'put', { path: p, version, seqBefore: before, seqAfter: seq });
        return { version, seq };
      });
    },

    async remove(p, ifMatch) {
      checkPath(p);
      return enqueue([p], async () => {
        const entry = index.get(p);
        if (entry === undefined) throw notFound(p);
        if (entry.version === null) return { seq };
        if (ifMatch === undefined) throw needsPrecondition();
        if (ifMatch !== entry.version) throw stale(entry.version);
        let unlinked = true;
        try {
          await unlink(onDisk(p));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          unlinked = false;
          log('warn', 'remove.missing_on_disk', { path: p, version: entry.version });
        }
        if (unlinked) await sync(path.dirname(onDisk(p)));
        await pruneEmptyParents(p);
        const before = seq;
        seq += 1;
        setEntry(p, null, seq);
        await persist();
        log('info', 'remove', { path: p, version: entry.version, seqBefore: before, seqAfter: seq });
        return { seq };
      });
    },

    async move(from, to, ifMatch) {
      checkPath(from);
      checkPath(to);
      if (from === to) throw new ApiError('bad_move', 400, 'from and to are the same path');
      return enqueue([from, to], async () => {
        const version = index.get(from)?.version ?? null;
        const target = index.get(to)?.version ?? null;
        if (version === null) {
          if (target !== null && target === ifMatch) return { version: target, seq };
          throw notFound(from);
        }
        if (ifMatch === undefined) throw needsPrecondition();
        if (ifMatch !== version) throw stale(version);
        if (target !== null) throw new ApiError('exists', 409, `${to} already exists`, { version: target });
        const clash = conflict(to, from);
        if (clash) throw clash;
        const caseOnly = foldKey(from) === foldKey(to);
        if (!caseOnly && await access(onDisk(to)).then(() => true, () => false)) {
          log('warn', 'move.untracked_target', { from, to });
          throw new ApiError('exists', 409, `${to} exists on disk`);
        }
        await mkdirDurable(path.dirname(onDisk(to)));
        try {
          await renameRetrying(onDisk(from), onDisk(to));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          log('warn', 'move.missing_on_disk', { path: from, version });
          throw notFound(from);
        }
        for (const dir of new Set([path.dirname(onDisk(from)), path.dirname(onDisk(to))])) await sync(dir);
        await pruneEmptyParents(from);
        const before = seq;
        seq += 1;
        setEntry(from, null, seq);
        setEntry(to, version, seq);
        await persist();
        log('info', 'move', { from, to, version, seqBefore: before, seqAfter: seq });
        return { version, seq };
      });
    },

    async close() { await tail; },
  };
}
