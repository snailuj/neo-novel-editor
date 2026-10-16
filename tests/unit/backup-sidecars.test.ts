// Rule: the daily backup holds every one of NEO's own things at the library's root, now
// including the .neo folder where the writer's comments are kept, and still nothing else
// that shares the folder. Since NEO 1.5.7 the zip is made by backup-worker.js in a
// process of its own, run here as a plain Node child, as upstream's tests run it.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from './git-support.ts';

const cjs = createRequire(import.meta.url);
const { loadMain } = cjs('../support/main-loader.cjs');
const JSZip = cjs('jszip');

test('the daily backup keeps .neo with the books, and leaves out what is not NEO\'s', async (t) => {
  const main = loadMain();
  const dir = tempDir(t, 'neo-backup-');
  main.pointAt(dir);
  const lib = main.call('library:read');
  const book = main.call('book:create', { title: 'Synthetic' });
  main.call('chapter:write', book.id, 'ch-aaa', '<p>Words.</p>');
  main.call('library:write', lib);
  const sidecar = path.join(dir, '.neo', book.id, 'chapters', 'ch-aaa.json');
  mkdirSync(path.dirname(sidecar), { recursive: true });
  writeFileSync(sidecar, '{"version":1,"marks":[]}\n');
  writeFileSync(path.join(dir, 'someone-elses.txt'), 'not NEO\'s');

  const target = path.join(dir, 'Backups', 'neo-backup-2026-10-16.zip');
  mkdirSync(path.dirname(target), { recursive: true });
  const child = fork(path.join(import.meta.dirname, '..', '..', 'backup-worker.js'));
  const answer = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    child.once('message', (m) => resolve(m as { ok: boolean; error?: string }));
    child.once('error', reject);
    child.send({ libraryDir: dir, target, keep: 14 });
  });
  child.kill();
  assert.equal(answer.ok, true, answer.error);
  const zip = await JSZip.loadAsync(readFileSync(target));
  const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir);
  assert.ok(files.includes(`${book.id}/chapters/ch-aaa.html`), 'the book is there');
  assert.ok(files.includes(`.neo/${book.id}/chapters/ch-aaa.json`), files.join('\n'));
  assert.ok(!files.includes('someone-elses.txt'));
});
