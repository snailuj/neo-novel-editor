import fs from 'node:fs';
import path from 'node:path';

// Writing that survives the power going out. A new file is written beside the old one,
// pushed all the way to the disk (fsync), and only then swapped in. Without the push, a
// power cut right after the swap can leave the swap done and the words not: an empty
// book.json, and the book gone from its shelf. A missing file or an unlucky moment never
// costs more than the last few seconds.
//
// Every call goes through the `fs` object (never a destructured name) so a test can make a
// disk that writes in pieces or refuses a swap.

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// On Windows the swap is refused while anything else has the file open, even for a moment:
// antivirus looking at what was just written, the search indexer, a backup or sync client.
// Wait a beat and try again (up to ~0.6 s) before calling the save failed, so a passing
// glance never reaches the writer as "NEO can't save". A folder that really refuses writes
// still fails, and is still explained.
function renameIntoPlace(from: string, to: string, platform: string): void {
  for (let wait = 5; ; wait *= 2) {
    try { return fs.renameSync(from, to); } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (platform !== 'win32' || wait > 320 || !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '')) throw err;
      sleepSync(wait);
    }
  }
}

export function writeFileDurable(file: string, data: string | Buffer, platform: string = process.platform): void {
  const tmp = file + '.tmp';
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const fd = fs.openSync(tmp, 'w');
  try {
    // a write can take less than it was given; keep going until every byte is down, and
    // never swap in a file that is only partly written
    for (let off = 0; off < buf.length;) {
      const n = fs.writeSync(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw Object.assign(new Error('Short write: ' + tmp), { code: 'EIO', path: tmp });
      off += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameIntoPlace(tmp, file, platform);
  // the swap itself, on systems that let a folder be pushed too
  if (platform !== 'win32') {
    try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* fine */ }
  }
}
