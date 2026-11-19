import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createFsStore } from '../../../src/store/index.ts';
import { harness } from './support.ts';

// Rule: logging never creates a library. A line goes to the library's neo-errors.log only
// while the library is open and its folder is there; in every other case nothing is made
// and the answer is false, so the caller writes the line somewhere else.

const quiet = () => {};

test('an open library takes the line, and the log is a plain file beside the books', async () => {
  const h = harness();
  await h.store.open();
  assert.equal(await h.store.appendErrorLog('[t] [one] boom\n'), true);
  assert.equal(await h.store.appendErrorLog('[t] [two] bang\n'), true);
  assert.equal(h.read('neo-errors.log'), '[t] [one] boom\n[t] [two] bang\n');
});

test('a library that has not been opened takes nothing and is not made', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(tmpdir(), 'neo-log-')), 'NEO Library');
  const store = createFsStore({ root: dir, log: quiet });
  assert.equal(await store.appendErrorLog('x\n'), false);
  assert.equal(fs.existsSync(dir), false, 'no folder');
  fs.mkdirSync(dir);
  assert.equal(await store.appendErrorLog('x\n'), false, 'a folder that is there is still not an open library');
  assert.deepEqual(fs.readdirSync(dir), [], 'no library.json, no log');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('opening makes the folder and library.json of a new library, and leaves an existing one as it is', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(tmpdir(), 'neo-log-')), 'NEO Library');
  const store = createFsStore({ root: dir, log: quiet });
  await store.open();
  const seed = fs.readFileSync(path.join(dir, 'library.json'), 'utf8');
  assert.equal(JSON.parse(seed).shelves.length, 1);
  fs.writeFileSync(path.join(dir, 'library.json'), '{"shelves":[]}');
  await createFsStore({ root: dir, log: quiet }).open();
  assert.equal(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'), '{"shelves":[]}');
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

test('a library whose folder goes away is not made again by a log line', async () => {
  const h = harness();
  await h.store.open();
  fs.rmSync(h.dir, { recursive: true, force: true });
  assert.equal(await h.store.appendErrorLog('x\n'), false);
  assert.equal(fs.existsSync(h.dir), false);
});

test('a library that cannot be opened stays closed, and takes no log line', async () => {
  const base = fs.mkdtempSync(path.join(tmpdir(), 'neo-log-'));
  const blocker = path.join(base, 'file');
  fs.writeFileSync(blocker, 'not a folder');
  const store = createFsStore({ root: path.join(blocker, 'NEO Library'), log: quiet });
  await assert.rejects(store.open());
  assert.equal(await store.appendErrorLog('x\n'), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('a log that cannot be written to is false, not an error to log', async () => {
  const h = harness();
  await h.store.open();
  fs.mkdirSync(h.at('neo-errors.log')); // a folder where the log should be
  assert.equal(await h.store.appendErrorLog('x\n'), false);
});
