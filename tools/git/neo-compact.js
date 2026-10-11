#!/usr/bin/env node
'use strict';

// node neo-compact.js [--write] <file-or-folder>...
//
// Turns a lined chapter file back into the compact HTML Neo writes. A chapter
// is lined on disk after a merge conflict the writer has settled (the merge
// driver leaves a conflict in lined form) and in libraries saved by earlier
// builds of this fork. Neo loads such a file with stray line-break text nodes.
//
// A folder stands for the library: its book-*/chapters/*.html files. The
// default is a dry run that lists what would change; --write applies it.
// A file already compact is not rewritten. A file with conflict markers, or
// one that would not line back to what it was, is refused and left alone.

const fs = require('node:fs');
const path = require('node:path');
const { paragraphLines, compactLines } = require('./neo-lines.js');

const USAGE = `usage: node neo-compact.js [--write] <file-or-folder>...
  A folder is a library: its book-*/chapters/*.html files are compacted.
  no --write   list the files that would change; change nothing
  --write      compact them in place
  exit status is 1 if any file was refused, 2 for a usage error
`;

// git's own markers (|||||||  is diff3's base), at the start of a line
const CONFLICT = /^(?:<{7}|={7}|>{7}|\|{7})(?![<=>|])/m;

// The file goes through a temp file in its own folder and a rename, so a
// crash leaves either the old chapter or the new one, never half of one.
function writeAtomic(file, text, rename = fs.renameSync) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, Buffer.from(text, 'latin1'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, fs.statSync(file).mode & 0o777);
    rename(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// Files are read and written as latin1, like the merge driver, so every byte
// of the UTF-8 text survives.
function compactFile(file, { write }) {
  const text = fs.readFileSync(file).toString('latin1');
  if (CONFLICT.test(text)) return { status: 'refused', reason: 'still holds conflict markers' };
  const compact = compactLines(text);
  if (compact === text) return { status: 'unchanged' };
  // Lining the result must give the input back, or compacting loses something
  // (CRLF, a space between blocks, a half-lined file) that the writer put there.
  if (paragraphLines(compact) !== text) return { status: 'refused', reason: 'does not survive lining after compacting' };
  if (write) writeAtomic(file, compact);
  return { status: 'changed' };
}

const dirents = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));

// A symlink is skipped: the walk stays inside the folder it was given.
function chapterFiles(library) {
  const found = [];
  for (const book of dirents(library)) {
    if (!book.isDirectory() || !book.name.startsWith('book-')) continue;
    const chapters = path.join(library, book.name, 'chapters');
    // lstat, not exists: a junction or symlink here would lead out of the library
    if (!fs.lstatSync(chapters, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const f of dirents(chapters)) {
      if (f.isFile() && f.name.endsWith('.html') && !f.name.startsWith('.')) found.push(path.join(chapters, f.name));
    }
  }
  return found;
}

function main(argv, out = process.stdout, err = process.stderr) {
  const write = argv.includes('--write');
  const args = argv.filter((a) => a !== '--write');
  const unknown = args.find((a) => a.startsWith('--'));
  if (unknown || !args.length) {
    err.write(`${unknown ? `unknown option ${unknown}\n` : ''}${USAGE}`);
    return 2;
  }

  const count = { changed: 0, unchanged: 0, refused: 0 };
  const seen = new Set();
  const report = (file, r) => {
    count[r.status]++;
    if (r.status === 'refused') err.write(`refused ${file}: ${r.reason}\n`);
    else out.write(`${r.status === 'changed' && !write ? 'would change' : r.status} ${file}\n`);
  };
  const handle = (file) => {
    const key = path.resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    try {
      report(file, compactFile(file, { write }));
    } catch (e) {
      report(file, { status: 'refused', reason: e.message });
    }
  };

  for (const arg of args) {
    let stat;
    try {
      stat = fs.statSync(arg);
    } catch (e) {
      report(arg, { status: 'refused', reason: e.code === 'ENOENT' ? 'not found' : e.message });
      continue;
    }
    if (!stat.isDirectory()) {
      handle(arg);
      continue;
    }
    const files = chapterFiles(arg);
    if (!files.length) err.write(`no book-*/chapters/*.html files under ${arg}\n`);
    files.forEach(handle);
  }

  const total = count.changed + count.unchanged + count.refused;
  out.write(`${total} files: ${count.changed} ${write ? 'changed' : 'would change'}, ${count.unchanged} unchanged, ${count.refused} refused\n`);
  return count.refused ? 1 : 0;
}

module.exports = { compactFile, chapterFiles, writeAtomic, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
