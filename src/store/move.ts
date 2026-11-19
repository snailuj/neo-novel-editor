import fs from 'node:fs';
import path from 'node:path';
import { createICloud, type ICloud } from './icloud.ts';
import { createJsonFiles, type JsonFiles } from './json.ts';
import type { LibraryRecord, Log } from './types.ts';

// Moving a library to another folder, and the folders a library can be moved to. The
// questions to the writer, the closing of the window and the relaunch stay in main.js.

/** NEO Pocket's folder in iCloud Drive, as this Mac sees it. It's there once the app has run
 * on an iPad or iPhone signed in to the same iCloud account; desktop NEO never makes it (only
 * the app it belongs to can). */
export function pocketCloudLibrary({ home, platform = process.platform }: { home: string; platform?: string }): string | null {
  if (platform !== 'darwin') return null;
  const dir = path.join(home, 'Library', 'Mobile Documents', 'iCloud~com~hughhowey~neo~pocket', 'Documents');
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  return path.join(dir, 'NEO Library');
}

// what a library folder holds that moving it carries: books and anything else the writer
// keeps there, but not NEO's own half-written spares
const MOVE_SKIP = new Set(['library.json', '.neo-write-test', '.DS_Store']);
export function libraryEntries(dir: string): string[] {
  try { return fs.readdirSync(dir).filter((n) => !MOVE_SKIP.has(n) && !/\.(tmp|bak)$/.test(n)); } catch { return []; }
}
export const hasBooks = (dir: string): boolean => libraryEntries(dir).some((n) => n.startsWith('book-'));

/** `a` is inside `b`, or is `b`. */
export function insideFolder(a: string, b: string): boolean {
  const r = path.relative(path.resolve(b), path.resolve(a));
  return !r.startsWith('..') && !path.isAbsolute(r);
}

type Shelf = { id: string; bookIds?: string[]; [key: string]: unknown };
type Author = { id: string; name?: string; [key: string]: unknown };
type Library = LibraryRecord & { shelves?: Shelf[]; authors?: Author[]; penNames?: string[]; authorName?: string; firstRunDone?: boolean };

// Two libraries become one: the shelves of `from` join those of `into` (a shelf both have
// keeps every book of both), and so do the pen names. What `into` already says stays; `from`
// fills in what it lacks.
export function mergeLibraries(intoLibrary: LibraryRecord | null, fromLibrary: LibraryRecord | null): LibraryRecord | null {
  if (!intoLibrary) return fromLibrary;
  if (!fromLibrary) return intoLibrary;
  const into = intoLibrary as Library;
  const from = fromLibrary as Library;
  const out: Library = { ...from, ...into };
  const shelves = (into.shelves || []).map((sh) => ({ ...sh, bookIds: [...(sh.bookIds || [])] }));
  for (const sh of from.shelves || []) {
    const same = shelves.find((x) => x.id === sh.id);
    if (same) {
      for (const b of sh.bookIds || []) if (!same.bookIds.includes(b)) same.bookIds.push(b);
    } else {
      shelves.push({ ...sh, bookIds: [...(sh.bookIds || [])] });
    }
  }
  out.shelves = shelves;
  const authors = (into.authors || []).map((a) => ({ ...a }));
  for (const a of from.authors || []) {
    const same = authors.find((x) => x.id === a.id);
    if (!same) authors.push({ ...a });
    else if ((!same.name || same.name === 'Anonymous') && a.name) same.name = a.name;
  }
  if (authors.length) out.authors = authors;
  out.penNames = [...new Set([...(into.penNames || []), ...(from.penNames || [])])];
  out.authorName = into.authorName || from.authorName || '';
  out.firstRunDone = !!(into.firstRunDone || from.firstRunDone);
  return out;
}

// every file of a folder, by its path inside it, with its size
function treeSizes(dir: string, base = dir, out = new Map<string, number>()): Map<string, number> {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    const st = fs.statSync(f);
    if (st.isDirectory()) treeSizes(f, base, out);
    else out.set(path.relative(base, f), st.size);
  }
  return out;
}

export interface MoveOptions {
  log: Log;
  icloud?: ICloud;
  json?: JsonFiles;
  platform?: string;
}

// The books of one library folder copied into another, beside whatever is there already (a
// book both have keeps the copy that's there), checked file by file, and library.json
// merged. Nothing leaves `from`: the caller puts it in the Trash once this has worked. If
// anything fails, what was copied is taken away again and the error goes up, so `to` is as
// it was. A library.json at `to` that iCloud has not brought down is waited for, and if it
// never comes the move does not start (merging would write over words nobody has read).
export async function moveLibrary(from: string, to: string, options: MoveOptions): Promise<void> {
  const platform = options.platform ?? process.platform;
  const icloud = options.icloud ?? createICloud({ platform });
  const { readJSON, writeJSON } = options.json ?? createJsonFiles({ log: options.log, icloud, platform });
  const theirsFile = path.join(to, 'library.json');
  const waiting = fs.existsSync(theirsFile) ? icloud.whenLocal([theirsFile]) : null;
  if (waiting && (await waiting).size) throw icloud.cloudError(theirsFile);

  fs.mkdirSync(to, { recursive: true });
  const made: string[] = [];
  try {
    for (const name of libraryEntries(from)) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      if (fs.existsSync(dst)) continue;
      made.push(dst);
      fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      if (fs.statSync(src).isDirectory()) {
        const a = treeSizes(src), b = treeSizes(dst);
        for (const [f, size] of a) if (b.get(f) !== size) throw Object.assign(new Error('Not every file came across: ' + path.join(name, f)), { code: 'EINCOMPLETE' });
      } else if (fs.statSync(src).size !== fs.statSync(dst).size) {
        throw Object.assign(new Error('Not every file came across: ' + name), { code: 'EINCOMPLETE' });
      }
    }
    const mine = readJSON(path.join(from, 'library.json'), null) as LibraryRecord | null;
    const theirs = fs.existsSync(theirsFile) ? (readJSON(theirsFile, null) as Library | null) : null;
    if (mine || theirs) writeJSON(theirsFile, mergeLibraries(theirs, mine));
  } catch (err) {
    for (const p of made) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* as much as can go */ } }
    throw err;
  }
}
