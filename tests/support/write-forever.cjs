'use strict';

// Usage: node write-forever.cjs <dir> <chapter|aux> [--in-place]
//
// Loads main.js through the loader, prints `writing`, then writes 4 MiB payloads A and B
// in turn through its chapter:write (or aux:write, to notes.html) handler until killed.
// write-kill.test.ts SIGKILLs it mid-write and inspects what is left.
//
// It also stops by itself after 30 s (NEO_WRITE_FOREVER_MAX_MS overrides, for the test of
// that limit). A round needs well under a second, but Windows does not take a child down
// with a parent that was interrupted, and an orphan would rewrite 4 MiB files for ever.
//
// <dir> is a library holding one book folder; in chapter mode that book's chapters/ holds
// one chapter, and that is the file written. --in-place first replaces writeFileDurable in
// the vm context with fs.writeFileSync, the truncate-then-write that the durable path
// exists to avoid. The test uses it to show that a kill can leave a torn file.

const fs = require('node:fs');
const path = require('node:path');
const { loadMain } = require('./main-loader.cjs');

const SIZE = 4 * 1024 * 1024;
const MAX_RUN_MS = Number(process.env.NEO_WRITE_FOREVER_MAX_MS) || 30000;

// Exactly 4 MiB of ASCII each, differing in every byte of the body, so a file cut short or
// part-way through a swap equals neither.
function payloads() {
  const body = (c) => '<p>' + c.repeat(SIZE - 7) + '</p>';
  return { A: body('a'), B: body('b') };
}

function only(names, what) {
  if (names.length !== 1) throw new Error(`expected one ${what}, found ${names.length}`);
  return names[0];
}

function run(dir, mode, inPlace) {
  const end = Date.now() + MAX_RUN_MS;
  const neo = loadMain();
  neo.pointAt(dir);
  const bookId = only(fs.readdirSync(dir).filter((name) => name.startsWith('book-')), 'book folder in ' + dir);
  const write = mode === 'chapter'
    ? (() => {
      const file = only(fs.readdirSync(path.join(dir, bookId, 'chapters')).filter((name) => name.endsWith('.html')), 'chapter');
      const chapterId = file.slice(0, -'.html'.length);
      return (html) => neo.call('chapter:write', bookId, chapterId, html);
    })()
    : (html) => neo.call('aux:write', bookId, 'notes', html);
  if (inPlace) neo.context.writeFileDurable = (file, data) => fs.writeFileSync(file, data);
  const { A, B } = payloads();
  // synchronous, so the line is out before the first write starts
  fs.writeSync(1, 'writing\n');
  while (Date.now() < end) {
    write(A);
    write(B);
  }
}

if (require.main === module) {
  const [dir, mode, flag, ...extra] = process.argv.slice(2);
  if (!dir || !['chapter', 'aux'].includes(mode) || (flag !== undefined && flag !== '--in-place') || extra.length) {
    process.stderr.write('usage: write-forever.cjs <dir> <chapter|aux> [--in-place]\n');
    process.exit(2);
  }
  run(dir, mode, flag === '--in-place');
}

module.exports = { payloads };
