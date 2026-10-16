// Writing inside the library the way NEO does. A file is written whole: a temporary
// file, fsync, then a rename into place, so a crash leaves the old file or the new one,
// never half of either. A name is one path segment, as main.js's libName() allows.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import path from 'node:path';

export function oneName(name: unknown, what: string): string {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new TypeError(`${what} must be one name inside the library: ${JSON.stringify(name)}`);
  }
  return name;
}

export function writeWhole(file: string, text: string): void {
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
