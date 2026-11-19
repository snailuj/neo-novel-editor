import assert from 'node:assert/strict';
import { execFileSync, fork as nodeFork } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import type { BackupWorker, ForkWorker } from '../../../src/store/index.ts';
import { harness } from './support.ts';

// Rules for the daily backup. It runs in a process of its own, so a file that never answers
// holds up only the backup; there is at most one at a time; one zip a day; and a backup that
// fails or overruns says so and leaves nothing half-written, and the next try can run.

const worker = path.join(import.meta.dirname, '..', '..', '..', 'backup-worker.js');
const requireHere = createRequire(import.meta.url);
const today = () => new Date().toISOString().slice(0, 10);

// the real backup-worker.js, as a plain Node child (Electron's utilityProcess is the same job)
const realFork: ForkWorker = (script) => {
  const child = nodeFork(script, [], {});
  return {
    on: (ev: string, fn: (arg: never) => void) => child.on(ev, ev === 'exit' ? (code: number | null) => (fn as (n: number) => void)(code || 0) : (fn as () => void)),
    postMessage: (m: unknown) => child.send(m as never),
    kill: () => child.kill(),
  } as BackupWorker;
};

// a worker that answers with what the test says
function fake(reply: (post: (m: unknown) => void, exit: (code: number) => void) => void) {
  const forked: unknown[] = [];
  const fork: ForkWorker = (script) => {
    const handlers: Record<string, (arg: never) => void> = {};
    forked.push(script);
    let killed = false;
    return {
      on: (ev: string, fn: (arg: never) => void) => { handlers[ev] = fn; },
      postMessage: () => setImmediate(() => reply((m) => handlers.message?.(m as never), (c) => handlers.exit?.(c as never))),
      kill: () => { killed = true; void killed; },
    } as BackupWorker;
  };
  return { fork, forked };
}

async function zipOf(file: string) {
  const JSZip = requireHere('jszip');
  return JSZip.loadAsync(fs.readFileSync(file));
}

test('the day\'s backup is one zip of the books, and a second look the same day makes no second one', async () => {
  const h = harness();
  const book = await h.withBook();
  await h.store.backup(realFork, { workerPath: worker });
  const zips = fs.readdirSync(h.at('Backups')).filter((f) => f.endsWith('.zip'));
  assert.deepEqual(zips, [`neo-backup-${today()}.zip`]);
  const zip = await zipOf(h.at('Backups', zips[0]));
  assert.ok(zip.file(`${book.id}/chapters/ch-aaa.html`), 'a chapter is in it');
  assert.ok(zip.file('library.json'));
  const second = fake((post) => post({ ok: true }));
  await h.store.backup(second.fork, { workerPath: worker });
  assert.deepEqual(second.forked, [], 'a day that has its zip starts no worker');
});

test('a backup already running is not started a second time', async () => {
  const h = harness();
  await h.withBook();
  let finish: () => void = () => {};
  const slow = fake((post) => { finish = () => post({ ok: true }); });
  const first = h.store.backup(slow.fork, { workerPath: worker });
  await h.store.backup(slow.fork, { workerPath: worker });
  assert.equal(slow.forked.length, 1);
  await new Promise((r) => setImmediate(r));
  finish();
  await first;
  const again = fake((post) => post({ ok: true }));
  await h.store.backup(again.fork, { workerPath: worker });
  assert.equal(again.forked.length, 1, 'and once it is done the next can run');
});

test('a backup that fails is logged, its half-made file removed, and the next try can run', async () => {
  const h = harness();
  await h.withBook();
  fs.mkdirSync(h.at('Backups'));
  const target = h.at('Backups', `neo-backup-${today()}.zip`);
  fs.writeFileSync(target + '.tmp', 'half');
  await h.store.backup(fake((post) => post({ ok: false, error: 'disk full' })).fork, { workerPath: worker });
  assert.match(h.logs.join('\n'), /backup: disk full/);
  assert.equal(fs.existsSync(target + '.tmp'), false);
  const retry = fake((post) => post({ ok: true }));
  await h.store.backup(retry.fork, { workerPath: worker });
  assert.equal(retry.forked.length, 1);
});

test('a worker that stops, or cannot be started, is logged and the backup is over', async () => {
  const h = harness();
  await h.withBook();
  await h.store.backup(fake((_post, exit) => exit(3)).fork, { workerPath: worker });
  assert.match(h.logs.join('\n'), /backup: the backup stopped \(3\)/);
  await h.store.backup(() => { throw new Error('no process'); }, { workerPath: worker });
  assert.match(h.logs.join('\n'), /backup: no process/);
});

test('a backup that overruns is ended, and the overrun logged', async () => {
  const h = harness();
  await h.withBook();
  const never = fake(() => {});
  await h.store.backup(never.fork, { workerPath: worker, totalMs: 40 });
  assert.match(h.logs.join('\n'), /backup: the backup took longer than/);
});

test('files left out are named in the log, and files in iCloud are asked for', async () => {
  const h = harness();
  await h.withBook();
  const away = h.at('book-x', 'chapters', 'c.html');
  await h.store.backup(fake((post) => post({ ok: true, missed: ['a.html (EACCES)', 'b.html (in iCloud, not on this Mac)'], away: [away] })).fork, { workerPath: worker });
  assert.match(h.logs.join('\n'), /left out of today's backup: a\.html \(EACCES\), b\.html/);
  assert.deepEqual(h.asked, [away]);
});

test('a file that never answers is left out and named, and this process keeps running meanwhile', async () => {
  const h = harness();
  const book = await h.withBook();
  const stuck = h.at(book.id, 'stickies.json');
  fs.rmSync(stuck, { force: true });
  execFileSync('mkfifo', [stuck]); // a read of a named pipe waits for ever, as a stuck iCloud file does
  let ticks = 0;
  const beat = setInterval(() => { ticks++; }, 20);
  const t0 = Date.now();
  await h.store.backup(realFork, { workerPath: worker, fileMs: 300 });
  clearInterval(beat);
  assert.ok(Date.now() - t0 < 10000, 'the backup finished');
  assert.ok(ticks > 5, 'the caller kept running while the backup waited');
  const zip = await zipOf(h.at('Backups', `neo-backup-${today()}.zip`));
  assert.match(await zip.file('_left-out-of-this-backup.txt').async('string'), /stickies\.json \(not handed over in time\)/);
  assert.ok(zip.file(`${book.id}/book.json`), 'the rest is backed up');
});

test('what is still in iCloud is left out of the backup and named, not waited on', async () => {
  const h = harness();
  const book = await h.withBook();
  // a placeholder is a file with a size and no blocks; the worker treats such a file as in iCloud when told to
  const file = h.at(book.id, 'chapters', 'ch-aaa.html');
  const size = fs.statSync(file).size;
  fs.rmSync(file);
  fs.closeSync(fs.openSync(file, 'w'));
  fs.truncateSync(file, size);
  assert.equal(fs.statSync(file).blocks, 0, 'this disk makes sparse files');
  const asPlaceholder: ForkWorker = (script) => {
    const child = nodeFork(script, [], { env: { ...process.env, NEO_TEST_SPARSE_IS_CLOUD: '1' } });
    return {
      on: (ev: string, fn: (arg: never) => void) => child.on(ev, ev === 'exit' ? (code: number | null) => (fn as (n: number) => void)(code || 0) : (fn as () => void)),
      postMessage: (m: unknown) => child.send(m as never),
      kill: () => child.kill(),
    } as BackupWorker;
  };
  await h.store.backup(asPlaceholder, { workerPath: worker });
  const zip = await zipOf(h.at('Backups', `neo-backup-${today()}.zip`));
  assert.match(await zip.file('_left-out-of-this-backup.txt').async('string'), /ch-aaa\.html \(in iCloud, not on this Mac\)/);
  assert.deepEqual(h.asked, [file], 'and iCloud is asked for it');
});
