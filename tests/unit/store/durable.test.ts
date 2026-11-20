import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { writeFileDurable } from '../../../src/store/index.ts';

// Rule: after any write, a file holds either all of its old bytes or all of its new bytes,
// and the new ones are on the disk before they replace the old.

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(tmpdir(), 'neo-durable-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('a write lands whole and leaves no .tmp beside it', () => {
  const file = path.join(dir, 'ch.html');
  writeFileDurable(file, '<p>one</p>');
  writeFileDurable(file, '<p>two</p>');
  assert.equal(fs.readFileSync(file, 'utf8'), '<p>two</p>');
  assert.deepEqual(fs.readdirSync(dir), ['ch.html']);
});

test('the bytes are pushed to the disk before the swap, and the swap is last', () => {
  const file = path.join(dir, 'ch.html');
  const seen: string[] = [];
  const { fsyncSync, renameSync } = fs;
  fs.fsyncSync = (fd) => { seen.push('fsync'); return fsyncSync(fd); };
  fs.renameSync = (from, to) => { seen.push('rename'); return renameSync(from, to); };
  try {
    writeFileDurable(file, 'text', 'linux');
  } finally {
    fs.fsyncSync = fsyncSync;
    fs.renameSync = renameSync;
  }
  assert.deepEqual(seen.slice(0, 2), ['fsync', 'rename']);
});

test('a write the disk takes in pieces still lands whole', () => {
  const file = path.join(dir, 'ch.html');
  const text = '<p>Ünïcode words, ' + 'many '.repeat(400) + 'and the end.</p>';
  const { writeSync } = fs;
  fs.writeSync = ((fd: number, buf: Buffer, off: number, len: number) => writeSync(fd, buf, off, Math.min(len, 7))) as typeof fs.writeSync;
  try {
    writeFileDurable(file, text);
  } finally {
    fs.writeSync = writeSync;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('a write that stalls part-way never replaces the file', () => {
  const file = path.join(dir, 'ch.html');
  writeFileDurable(file, '<p>kept</p>');
  const { writeSync } = fs;
  fs.writeSync = ((fd: number, buf: Buffer, off: number, len: number) => (off > 0 ? 0 : writeSync(fd, buf, off, Math.min(len, 7)))) as typeof fs.writeSync;
  try {
    assert.throws(() => writeFileDurable(file, '<p>cut short, and longer than seven bytes</p>'), { code: 'EIO' });
  } finally {
    fs.writeSync = writeSync;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), '<p>kept</p>');
});

test('on Windows a swap another program holds up is retried, and lands when it lets go', () => {
  const file = path.join(dir, 'ch.html');
  writeFileDurable(file, 'old');
  const { renameSync } = fs;
  let refusals = 3;
  fs.renameSync = (from, to) => {
    if (refusals-- > 0) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    return renameSync(from, to);
  };
  try {
    writeFileDurable(file, 'new', 'win32');
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
});

test('a swap that stays refused fails, and an error that is not a hold-up is not retried', () => {
  const file = path.join(dir, 'ch.html');
  writeFileDurable(file, 'old');
  const { renameSync } = fs;
  let tries = 0;
  fs.renameSync = () => { tries++; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  try {
    assert.throws(() => writeFileDurable(file, 'new', 'win32'), { code: 'EPERM' });
    assert.ok(tries > 3, 'it waited and tried again');
    tries = 0;
    assert.throws(() => writeFileDurable(file, 'new', 'linux'), { code: 'EPERM' });
    assert.equal(tries, 1, 'only Windows waits');
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'old');
});
