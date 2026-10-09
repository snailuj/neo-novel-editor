import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// A killed save (characterisation of upstream 1.4.7). main.js runs in a child that writes
// 4 MiB payloads through its own chapter:write or aux:write handler until it is killed, so
// the kill lands inside a write. Whatever is on disk afterwards must be a whole payload.
// The child is SIGKILLed, so the operating system keeps every byte it had handed over:
// this checks that a write is never half-visible, not that the disk honours fsync.

const cjs = createRequire(import.meta.url);
const { loadMain } = cjs('../support/main-loader.cjs');
const { payloads } = cjs('../support/write-forever.cjs');
const writer = fileURLToPath(new URL('../support/write-forever.cjs', import.meta.url));

const ROUNDS = 40;
const KILL_WINDOW_MS = 50;
// A kill tears an in-place write only if it lands between the truncate and the end of the
// write, which took 1 round in 8 on the machine this was written on and as few as 1 in 40
// on a bad run. The control stops at its first torn file, so a high cap costs nothing
// when the harness works.
const CONTROL_ROUNDS = 200;
const CHAPTER = 'ch-aaa';
const { A, B } = payloads() as { A: string; B: string };
const main = loadMain();

type Mode = 'chapter' | 'aux';

// A fresh library with one book whose chapter and notes both hold payload A, so the file
// is whole before the child starts and any later content is the child's doing.
function library() {
  const dir = mkdtempSync(path.join(tmpdir(), 'neo-kill-'));
  main.pointAt(dir);
  main.call('library:read');
  const book = main.call('book:create', { title: 'The Long Night' });
  main.call('chapter:write', book.id, CHAPTER, A);
  main.call('aux:write', book.id, 'notes', A);
  const bookDir = path.join(dir, book.id);
  return {
    dir,
    bookId: book.id as string,
    bookDir,
    chaptersDir: path.join(bookDir, 'chapters'),
    chapterFile: path.join(bookDir, 'chapters', CHAPTER + '.html'),
    notesFile: path.join(bookDir, 'notes.html'),
  };
}

// Never put 4 MiB into an assertion message.
function describePayload(text: string): string {
  return text === A ? 'A' : text === B ? 'B' : `neither A nor B (${Buffer.byteLength(text)} bytes)`;
}

function assertWhole(file: string): void {
  const got = describePayload(readFileSync(file, 'utf8'));
  assert.ok(got === 'A' || got === 'B', `${path.basename(file)} is ${got}`);
}

// Runs `node ...args`, waits for its `writing` line, then SIGKILLs it `delay` ms later.
// Resolves once the child has exited, so no handle on its files is left open. It resolves
// only if our SIGKILL was delivered to a live child and that is how the child ended; any
// other ending rejects, because a round whose kill never landed proves nothing.
function killAfterWriting(args: string[], delay: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    let scheduled = false;
    let delivered = false;
    let timer: NodeJS.Timeout | undefined;
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // Both checks: on POSIX kill() succeeds on a child that has exited but is not yet
      // reaped (then signal is null), and an outside SIGKILL (the OOM killer) leaves
      // signal SIGKILL with no kill of ours delivered.
      if (delivered && signal === 'SIGKILL') resolve();
      else reject(new Error(`writer exited on its own (code ${code}, signal ${signal})`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
      if (scheduled || !out.includes('writing')) return;
      scheduled = true;
      timer = setTimeout(() => {
        delivered = child.exitCode === null && child.kill('SIGKILL');
      }, delay);
    });
  });
}

function writeThenKill(dir: string, mode: Mode, delay: number, inPlace: boolean): Promise<void> {
  return killAfterWriting([writer, dir, mode, ...(inPlace ? ['--in-place'] : [])], delay);
}

// Rounds with the kill spread evenly over 0 to 50 ms after the `writing` line (40 steps,
// repeated if there are more rounds). The library is rebuilt each round, so every round
// starts from a whole file and a clean folder. `each` returns false to stop early.
async function rounds(
  mode: Mode,
  inPlace: boolean,
  each: (lib: ReturnType<typeof library>, before: string[], round: number) => boolean | void,
  count = ROUNDS,
): Promise<void> {
  for (let round = 0; round < count; round++) {
    const lib = library();
    try {
      const before = readdirSync(lib.bookDir);
      await writeThenKill(lib.dir, mode, Math.round(((round % ROUNDS) * KILL_WINDOW_MS) / (ROUNDS - 1)), inPlace);
      if (each(lib, before, round) === false) return;
    } finally {
      rmSync(lib.dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

// The helper itself. A writer that dies on its own after `writing` (a handler throws, a
// rename gives up, out of memory) must fail the round: the file is still whole, so every
// later assertion would pass without a kill ever landing in a write.
const SAYS_WRITING = "require('fs').writeSync(1, 'writing'); ";

test('a writer that exits on its own after writing fails the round', async () => {
  await assert.rejects(
    killAfterWriting(['-e', SAYS_WRITING + 'setTimeout(() => process.exit(3), 5)'], 200),
    /exited on its own \(code 3, signal null\)/,
  );
});

test('a writer still running when the timer fires is killed and the round resolves', async () => {
  await killAfterWriting(['-e', SAYS_WRITING + 'setInterval(() => {}, 1000)'], 10);
});

test('a killed chapter save leaves the old or the new file whole', async () => {
  await rounds('chapter', false, (lib, _before, round) => {
    assertWhole(lib.chapterFile);
    const left = readdirSync(lib.chaptersDir).sort();
    assert.ok(
      left.includes(CHAPTER + '.html') && left.every((name) => name === CHAPTER + '.html' || name === CHAPTER + '.html.tmp'),
      `round ${round}: chapters/ holds ${JSON.stringify(left)}`,
    );
    const after = '<p>written after the kill</p>';
    assert.equal(main.call('chapter:write', lib.bookId, CHAPTER, after), true);
    assert.equal(readFileSync(lib.chapterFile, 'utf8'), after);
  });
});

test('a killed notes save leaves the old or the new file whole', async () => {
  await rounds('aux', false, (lib, before, round) => {
    assertWhole(lib.notesFile);
    const gained = readdirSync(lib.bookDir).filter((name) => !before.includes(name));
    assert.deepEqual(gained.filter((name) => name !== 'notes.html.tmp'), [], `round ${round}: the book folder gained files`);
  });
});

// Without this the two tests above could pass because the kill never lands in a write.
// An in-place write truncates first, so some kill must leave a file that is neither payload.
test('the test can fail', async () => {
  let torn = false;
  await rounds('chapter', true, (lib) => {
    torn = describePayload(readFileSync(lib.chapterFile, 'utf8')).startsWith('neither');
    return !torn;
  }, CONTROL_ROUNDS);
  assert.ok(torn, `no round out of ${CONTROL_ROUNDS} left a torn file`);
});
