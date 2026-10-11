#!/usr/bin/env node
'use strict';

// node neo-compact.js [--write] <file-or-folder>...
//
// Turns a lined chapter file back into the compact HTML Neo writes. A chapter
// is lined on disk after a merge conflict the writer has settled (the merge
// driver leaves a conflict in lined form) and in libraries saved by earlier
// builds of this fork. Neo loads such a file with stray line-break text nodes.

const fs = require('node:fs');
const { compactLines } = require('./neo-lines.js');

// Files are read and written as latin1, like the merge driver, so every byte
// of the UTF-8 text survives.
function compactFile(file, { write }) {
  const text = fs.readFileSync(file).toString('latin1');
  const compact = compactLines(text);
  if (compact === text) return { status: 'unchanged' };
  if (write) fs.writeFileSync(file, compact, 'latin1');
  return { status: 'changed' };
}

function main(argv) {
  const write = argv.includes('--write');
  const files = argv.filter((a) => a !== '--write');
  let changed = 0;
  let unchanged = 0;
  for (const file of files) {
    const r = compactFile(file, { write });
    if (r.status === 'changed') {
      changed++;
      process.stdout.write(`${write ? 'changed' : 'would change'} ${file}\n`);
    } else {
      unchanged++;
      process.stdout.write(`unchanged ${file}\n`);
    }
  }
  process.stdout.write(`${files.length} files: ${changed} ${write ? 'changed' : 'would change'}, ${unchanged} unchanged\n`);
  return 0;
}

module.exports = { compactFile };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
