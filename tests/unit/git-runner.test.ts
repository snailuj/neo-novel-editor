// Rule: a failed git call says why it failed. A non-zero exit keeps its code and
// stderr, a timeout and a missing binary are told apart, and a success hands back
// stdout untouched.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGit, GitError } from '../../src/hoard/git/runner.ts';

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hoard-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a successful call hands back stdout', async (t) => {
  const dir = tempDir(t);
  const git = createGit({ hooksPath: dir });
  await git.run(dir, ['init', '-q']);
  const { stdout } = await git.run(dir, ['rev-parse', '--is-inside-work-tree']);
  assert.equal(stdout, 'true\n');
});

test('a non-zero exit keeps the exit code and stderr', async (t) => {
  const dir = tempDir(t);
  const git = createGit({ hooksPath: dir });
  await git.run(dir, ['init', '-q']);
  const err = await git.run(dir, ['rev-parse', '--verify', 'no-such-ref']).then(
    () => assert.fail('resolved'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof GitError);
  assert.equal(err.kind, 'exit');
  assert.equal(err.exitCode, 128);
  assert.match(err.stderr, /no-such-ref|Needed a single revision/);
  assert.deepEqual(err.args.slice(-3), ['rev-parse', '--verify', 'no-such-ref']);
  assert.match(err.message, /exit 128/);
});

test('a missing binary is reported as missing, not as a failed command', async (t) => {
  const dir = tempDir(t);
  const git = createGit({ git: path.join(dir, 'no-such-git'), hooksPath: dir });
  const err = await git.run(dir, ['status']).then(() => assert.fail('resolved'), (e: unknown) => e);
  assert.ok(err instanceof GitError);
  assert.equal(err.kind, 'missing');
  assert.equal(err.exitCode, null);
});

test('a call that runs past its limit is reported as a timeout', async (t) => {
  const dir = tempDir(t);
  // A stand-in git that never answers: node waiting on a timer.
  const slow = path.join(dir, 'slow-git.cjs');
  writeFileSync(slow, 'setTimeout(() => {}, 60000);\n');
  const git = createGit({ git: process.execPath, prefix: [slow], hooksPath: dir });
  const err = await git.run(dir, ['status'], { timeoutMs: 200 }).then(
    () => assert.fail('resolved'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof GitError);
  assert.equal(err.kind, 'timeout');
});

test('every call runs without the repo\'s own hooks, prompts or signing', async (t) => {
  const dir = tempDir(t);
  const hooks = path.join(dir, 'empty-hooks');
  const git = createGit({ hooksPath: hooks });
  await git.run(dir, ['init', '-q']);
  const read = async (key: string) => (await git.run(dir, ['config', '--get', key])).stdout.trim();
  assert.equal(await read('core.hooksPath'), hooks);
  assert.equal(await read('commit.gpgsign'), 'false');
});

test('each call is logged with its exit code and time', async (t) => {
  const dir = tempDir(t);
  const lines: { level: string; message: string; data: unknown }[] = [];
  const git = createGit({ hooksPath: dir, log: (level, message, data) => lines.push({ level, message, data }) });
  await git.run(dir, ['init', '-q']);
  await git.run(dir, ['rev-parse', '--verify', 'nope']).catch(() => {});
  assert.equal(lines.length, 2);
  assert.equal(lines[0].message, 'git.run');
  const last = lines[1].data as { args: string[]; exitCode: number; ms: number };
  assert.equal(last.exitCode, 128);
  assert.equal(typeof last.ms, 'number');
});
