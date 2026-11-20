import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFsStore, createICloud } from '../../../src/store/index.ts';

// Rule: a look over the whole library asks iCloud for every file it has taken off this Mac,
// without reading a word of any, and only on a Mac. Backups and Exports are not the books.

function library(platform: string) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'neo-fetch-'));
  const asked: string[] = [];
  const logs: string[] = [];
  // a placeholder is a file with a size and no blocks, which a sparse file is
  const away = (...parts: string[]) => {
    const file = path.join(dir, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.closeSync(fs.openSync(file, 'w'));
    fs.truncateSync(file, 4096);
    assert.equal(fs.statSync(file).blocks, 0, 'this disk makes sparse files');
    return file;
  };
  const here = (...parts: string[]) => {
    const file = path.join(dir, ...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'words');
    return file;
  };
  const icloud = createICloud({
    platform,
    detect: (files) => new Set(files),
    download: (file, done) => { asked.push(file); done(); },
  });
  const store = createFsStore({ root: dir, log: (s, d) => logs.push(`${s}: ${d instanceof Error ? d.message : d}`), platform, icloud });
  return { dir, asked, logs, away, here, store, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('every placeholder in the books is asked for, and what is here, and Backups and Exports, are not', async () => {
  const lib = library('darwin');
  try {
    const a = lib.away('book-a', 'chapters', 'c1.html');
    const b = lib.away('library.json');
    lib.here('book-a', 'chapters', 'c2.html');
    lib.away('Backups', 'neo-backup-2026-11-19.zip');
    lib.away('Exports', 'Book-2026.pdf');
    assert.equal(await lib.store.fetchFromICloud(), 2);
    assert.deepEqual(lib.asked.sort(), [a, b].sort());
    assert.match(lib.logs.join('\n'), /icloud: 2 library files were in iCloud only/);
  } finally { lib.done(); }
});

test('a library with nothing in iCloud asks for nothing and says nothing', async () => {
  const lib = library('darwin');
  try {
    lib.here('book-a', 'book.json');
    assert.equal(await lib.store.fetchFromICloud(), 0);
    assert.deepEqual(lib.asked, []);
    assert.deepEqual(lib.logs, []);
  } finally { lib.done(); }
});

test('off a Mac there is no iCloud to ask, and the folder is not walked', async () => {
  const lib = library('linux');
  try {
    lib.away('book-a', 'chapters', 'c1.html');
    assert.equal(await lib.store.fetchFromICloud(), 0);
    assert.deepEqual(lib.asked, []);
  } finally { lib.done(); }
});
