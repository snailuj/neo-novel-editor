'use strict';

// merge.neochapter.driver: node neo-merge.js %O %A %B
//
// Merges the three versions of a chapter one paragraph per line with
// `git merge-file`, so edits to different paragraphs merge cleanly, then
// writes the result back compact. Edits to the same or to adjacent
// paragraphs conflict, as git's line merge always has; the file then holds
// the lined text with conflict markers for the writer to settle.
//
// A version with whitespace between its top-level blocks is not what Neo
// writes. Making it compact again would drop that whitespace, so if any of
// the three would not survive the round trip, the raw files are merged.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { paragraphLines, compactLines } = require('./neo-lines.js');

function mergeFile(current, base, other) {
  const r = spawnSync('git', ['merge-file', current, base, other], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  if (r.error) throw r.error;
  return r.status;
}

function main([base, current, other]) {
  if (!base || !current || !other) {
    process.stderr.write('usage: neo-merge.js <base> <current> <other>\n');
    return 2;
  }
  const read = (file) => fs.readFileSync(file).toString('latin1');
  const [b, c, o] = [base, current, other].map(read);
  const compact = [b, c, o].every((text) => compactLines(paragraphLines(text)) === text);
  if (!compact) return mergeFile(current, base, other) === 0 ? 0 : 1;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-merge-'));
  try {
    const files = [b, c, o].map((text, i) => {
      const file = path.join(dir, ['base', 'current', 'other'][i]);
      fs.writeFileSync(file, paragraphLines(text), 'latin1');
      return file;
    });
    const status = mergeFile(files[1], files[0], files[2]);
    const merged = fs.readFileSync(files[1]).toString('latin1');
    // on a conflict the lined text with its markers is the result
    fs.writeFileSync(current, status === 0 ? compactLines(merged) : merged, 'latin1');
    return status === 0 ? 0 : 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(main(process.argv.slice(2)));
