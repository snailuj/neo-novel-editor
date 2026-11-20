import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { awaitChosenLibrary, checkLibraryWritable, probeFolder, type StartupOptions } from '../../../src/store/index.ts';

// Rules for finding a folder to keep the library in at launch. The test file written there is
// the only thing that says whether NEO can save; a first library is never lost to a folder
// that can't hold it; and a folder the writer chose is never swapped for another without them.

const refusal = (code: string) => Object.assign(new Error(code + ': the file is in use'), { code });
const temp = () => fs.mkdtempSync(path.join(tmpdir(), 'neo-startup-'));
const probeFile = (file: unknown) => String(file).endsWith('.neo-write-test');

// the first writes of the test file fail with these errors, in turn; deleting it fails with `unlink`
function failing({ writes = [] as Error[], unlink = null as Error | null } = {}) {
  const log = { writes: 0, unlinks: 0 };
  const write = fs.writeFileSync;
  const remove = fs.unlinkSync;
  const w = mock.method(fs, 'writeFileSync', ((file: never, ...rest: never[]) => {
    if (probeFile(file)) { const err = writes[log.writes++]; if (err) throw err; }
    return (write as (...a: unknown[]) => void)(file, ...rest);
  }) as typeof fs.writeFileSync);
  const u = mock.method(fs, 'unlinkSync', ((file: never) => {
    if (probeFile(file)) { log.unlinks++; if (unlink) throw unlink; }
    return (remove as (f: unknown) => void)(file);
  }) as typeof fs.unlinkSync);
  return { log, restore: () => { w.mock.restore(); u.mock.restore(); } };
}

const quiet = () => {};
const probe = (dir: string, extra: { sleep?: (ms: number) => void } = {}) => probeFolder(dir, { log: quiet, sleep: () => {}, ...extra });

test('a plain folder passes, and the test file is gone', () => {
  const dir = temp();
  const f = failing();
  try {
    assert.equal(probe(dir).writable, true);
    assert.equal(f.log.writes, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { f.restore(); }
});

test('a test file that is written but can\'t be deleted still passes', () => {
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const f = failing({ unlink: refusal(code) });
    try {
      assert.equal(probe(temp()).writable, true, code);
      assert.equal(f.log.unlinks, 1);
    } finally { f.restore(); }
  }
});

test('a folder that holds the test file for a moment passes on the next try, after a wait that grows', () => {
  const f = failing({ writes: [refusal('EBUSY'), refusal('EPERM')] });
  const waits: number[] = [];
  try {
    assert.equal(probe(temp(), { sleep: (ms) => waits.push(ms) }).writable, true);
    assert.equal(f.log.writes, 3);
    assert.deepEqual(waits, [150, 300]);
  } finally { f.restore(); }
});

test('a folder that keeps refusing is reported after three tries, with the reason', () => {
  const f = failing({ writes: [refusal('EPERM'), refusal('EPERM'), refusal('EPERM'), refusal('EPERM')] });
  const logged: string[] = [];
  try {
    const result = probeFolder(temp(), { log: (source) => logged.push(source), sleep: () => {} });
    assert.equal(result.writable, false);
    assert.equal(result.error?.code, 'EPERM');
    assert.equal(f.log.writes, 3);
    assert.match(logged[0], /^library folder not writable: /);
  } finally { f.restore(); }
});

test('a folder that can\'t exist is reported at once, with no waiting', () => {
  const f = failing({ writes: [refusal('ENOSPC')] });
  const waits: number[] = [];
  try {
    assert.equal(probe(temp(), { sleep: (ms) => waits.push(ms) }).writable, false);
    assert.equal(f.log.writes, 1);
    assert.deepEqual(waits, []);
  } finally { f.restore(); }
});

// a computer: a home (with or without Documents) and a "Documents" that cannot be written in
// (a path below a file, as a OneDrive folder on a computer where OneDrive isn't set up is)
function computer({ documents = true } = {}) {
  const base = temp();
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  if (documents) fs.mkdirSync(path.join(home, 'Documents'));
  const gone = path.join(base, 'OneDrive');
  fs.writeFileSync(gone, 'not a folder');
  const broken = path.join(gone, 'Documents', 'NEO Library');
  const asked: unknown[] = [];
  const remembered: string[] = [];
  const options = (extra: Partial<StartupOptions> = {}): StartupOptions => ({
    dir: broken, chosen: false, home, log: quiet, sleep: () => {},
    ask: (dir, error) => { asked.push({ dir, code: (error as { code?: string } | null)?.code }); return 'continue'; },
    pick: () => null,
    remember: (dir) => remembered.push(dir),
    ...extra,
  });
  return { home, broken, asked, remembered, options };
}

test('a first library that Documents can\'t hold goes in the home Documents folder, and is remembered, with no question', () => {
  const pc = computer();
  const out = checkLibraryWritable(pc.options());
  const want = path.join(pc.home, 'Documents', 'NEO Library');
  assert.equal(out.dir, want);
  assert.deepEqual(out.fallback, { from: pc.broken, to: want });
  assert.deepEqual(pc.remembered, [want]);
  assert.deepEqual(pc.asked, []);
});

test('with no Documents folder in the home, a first library goes in the home itself', () => {
  const pc = computer({ documents: false });
  const out = checkLibraryWritable(pc.options());
  assert.equal(out.dir, path.join(pc.home, 'NEO Library'));
  assert.equal(fs.existsSync(path.join(pc.home, 'Documents')), false);
});

test('a folder the writer chose is never swapped: they are asked instead', () => {
  const pc = computer();
  const out = checkLibraryWritable(pc.options({ chosen: true }));
  assert.equal(out.dir, pc.broken);
  assert.equal(out.fallback, null);
  assert.equal(pc.asked.length, 1);
  assert.deepEqual(pc.remembered, []);
  assert.equal(fs.existsSync(path.join(pc.home, 'Documents', 'NEO Library')), false);
});

test('a library that already lives in the folder is never swapped either', () => {
  const pc = computer();
  const dir = path.join(pc.home, 'Documents', 'Mine');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'library.json'), '{}');
  const probes = failing({ writes: [refusal('EPERM'), refusal('EPERM'), refusal('EPERM')] });
  try {
    const out = checkLibraryWritable(pc.options({ dir }));
    assert.equal(out.dir, dir);
    assert.equal(probes.log.writes, 0, 'off Windows a library that is there is not sent a test file');
    const win = checkLibraryWritable(pc.options({ dir, platform: 'win32' }));
    assert.equal(win.dir, dir);
    assert.equal(win.fallback, null);
    assert.equal(pc.asked.length, 1, 'on Windows it is probed, and the writer is asked, not moved');
  } finally { probes.restore(); }
});

test('the writer can choose another folder, try again, or carry on, and a cancelled pick asks again', () => {
  const pc = computer();
  const picked = temp();
  const answers: ('choose' | 'retry' | 'continue')[] = ['retry', 'choose', 'choose'];
  const picks: (string | null)[] = [null, picked];
  const out = checkLibraryWritable(pc.options({ chosen: true, ask: () => answers.shift() ?? 'continue', pick: () => picks.shift() ?? null }));
  assert.equal(out.dir, picked);
  assert.deepEqual(pc.remembered, [picked]);
  assert.equal(answers.length, 0);
  const carry = checkLibraryWritable(pc.options({ chosen: true }));
  assert.equal(carry.dir, pc.broken, 'Continue keeps the folder, unwritable, for this session');
});

test('a chosen folder that is not there is waited for, then the writer decides; Continue is this session only', () => {
  const base = temp();
  const chosen = path.join(base, 'NAS', 'NEO');
  const fallback = path.join(base, 'Documents', 'NEO Library');
  const remembered: string[] = [];
  const run = (answers: ('retry' | 'choose' | 'continue')[], picks: (string | null)[] = [], mount = false) => awaitChosenLibrary({
    chosen, fallback,
    ask: () => { if (mount && answers.length === 1) fs.mkdirSync(chosen, { recursive: true }); return answers.shift() ?? 'continue'; },
    pick: () => picks.shift() ?? null,
    remember: (dir) => remembered.push(dir),
  });
  assert.equal(run(['continue']), fallback);
  assert.deepEqual(remembered, [], 'nothing is remembered: the choice stays saved');
  const elsewhere = temp();
  assert.equal(run(['choose'], [elsewhere]), elsewhere);
  assert.deepEqual(remembered, [elsewhere]);
  assert.equal(run(['retry', 'retry'], [], true), chosen, 'it came back, and the answer is the folder itself');
});
