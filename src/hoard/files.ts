// Writing inside the library the way NEO does. A file is written whole: a temporary
// file, fsync, then a rename into place, so a crash leaves the old file or the new one,
// never half of either. A name is one path segment, as main.js's libName() allows.
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

export function oneName(name: unknown, what: string): string {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new TypeError(`${what} must be one name inside the library: ${JSON.stringify(name)}`);
  }
  return name;
}

// lstat's throwIfNoEntry covers ENOENT only; a path through a file (`a.html/b.html`) is
// ENOTDIR, and names nothing either.
function lstatOrNull(file: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(file, { throwIfNoEntry: false });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw err;
  }
}

/**
 * Whether `file` can be read or written without leaving `root` (a real path) by a link.
 * The nearest part of the path that exists decides, so a file not there yet is judged by
 * its folder. 'out' is a link that leads out of `root`; 'dangling' is one that leads nowhere,
 * which a write would follow. Null when the path is safe.
 */
export function linkProblem(root: string, file: string): 'out' | 'dangling' | null {
  for (let probe = file; ; probe = path.dirname(probe)) {
    let real: string;
    try {
      real = realpathSync(probe);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      if (lstatOrNull(probe)) return 'dangling';
      continue;
    }
    return real === root || real.startsWith(root + path.sep) ? null : 'out';
  }
}

/**
 * linkProblem for a file under a folder of the library (`wiki`, `.neo/marks`, `.neo/pages`):
 * the one rule MarkStore and PageStore share. `folder` is a path under `library`. Two things
 * must hold: the folder itself stays inside the library's real path, and the file stays
 * inside the folder's. 'root' is a folder that is a link out of the library (itself, or
 * through a link above it). A folder not there yet holds nothing that can lead out, so a
 * file under it is safe. A file that is not under the folder is not judged here.
 */
export function folderLinkProblem(library: string, folder: string, file: string): 'root' | 'out' | 'dangling' | null {
  const at = path.join(library, ...folder.split('/'));
  if (path.relative(at, file).startsWith('..')) return null;
  let lib: string;
  try {
    lib = realpathSync(library);
  } catch {
    return null;
  }
  const rootProblem = linkProblem(lib, at);
  if (rootProblem) return rootProblem === 'out' ? 'root' : 'dangling';
  let root: string;
  try {
    root = realpathSync(at);
  } catch {
    return null;
  }
  return linkProblem(root, file);
}

/** Why folderLinkProblem refused a file, for the message of the refusal. */
export function folderLinkText(problem: 'root' | 'out' | 'dangling', folder: string): string {
  if (problem === 'root') return `${folder} is a link that leads out of the library`;
  return problem === 'out' ? `a link in it leads out of ${folder}` : 'it goes through a link that leads nowhere';
}

/**
 * The first folder on the way to `rel` (a '/'-path under `root`) that is a file, as
 * `Foo.html` is in `Foo.html/Bar.html`: nothing can be read or made below it. Null if none.
 */
export function fileAbove(root: string, rel: string): string | null {
  const parts = rel.split('/').slice(0, -1);
  for (let n = 1; n <= parts.length; n++) {
    const at = parts.slice(0, n).join('/');
    if (lstatOrNull(path.join(root, ...at.split('/')))?.isFile()) return at;
  }
  return null;
}

export function writeWhole(file: string, text: string | Uint8Array): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const buf = Buffer.from(text);
  const fd = openSync(tmp, 'w');
  try {
    for (let off = 0; off < buf.length;) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw Object.assign(new Error(`short write: ${tmp}`), { code: 'EIO', path: tmp });
      off += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** NEO's writeJSON: the version on disk, while it reads whole, becomes the .bak. */
export function writeJson(file: string, data: unknown): void {
  if (existsSync(file)) {
    try {
      JSON.parse(readFileSync(file, 'utf8'));
      copyFileSync(file, `${file}.bak`);
    } catch {
      // a file that does not read is no spare; the write still goes ahead
    }
  }
  writeWhole(file, JSON.stringify(data, null, 2));
}
