#!/usr/bin/env node
'use strict';

// node neo-compact.js [--write] <file-or-folder>...
//
// Turns a lined chapter file back into the compact HTML Neo writes. A chapter
// is lined on disk after a merge conflict the writer has settled (the merge
// driver leaves a conflict in lined form) and in libraries saved by earlier
// builds of this fork. Neo loads such a file with stray line-break text nodes.

const fs = require('node:fs');
const { paragraphLines, compactLines } = require('./neo-lines.js');

// git's own markers, at the start of a line
const CONFLICT = /^(?:<{7}|={7}|>{7})(?![<=>])/m;

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
  if (write) fs.writeFileSync(file, compact, 'latin1');
  return { status: 'changed' };
}

function main(argv) {
  const write = argv.includes('--write');
  const files = argv.filter((a) => a !== '--write');
  const count = { changed: 0, unchanged: 0, refused: 0 };
  for (const file of files) {
    const r = compactFile(file, { write });
    count[r.status]++;
    if (r.status === 'refused') process.stderr.write(`refused ${file}: ${r.reason}\n`);
    else process.stdout.write(`${r.status === 'changed' && !write ? 'would change' : r.status} ${file}\n`);
  }
  const verb = write ? 'changed' : 'would change';
  process.stdout.write(`${files.length} files: ${count.changed} ${verb}, ${count.unchanged} unchanged, ${count.refused} refused\n`);
  return count.refused ? 1 : 0;
}

module.exports = { compactFile };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
