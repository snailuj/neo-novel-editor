// Rules for the gate inside a commit, with real git:
// Gate-Warns-The-Writer: a commit of the writer's work commits every change, findings or
//   not, and the gate keeps the findings for each file it judged.
// Librarian-Edit-Refused: a librarian edit with a failing finding commits nothing and
//   leaves the index as HEAD has it; the words stay on disk.
// Refused-Edit-Held-Back: a refused edit's files stay out of the writer's commits until
//   the writer saves them or a librarian commit of them passes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { commitAll } from '../../src/hoard/git/commit.ts';
import { Gate, GateRefused } from '../../src/hoard/git/gate.ts';
import { isolateGitConfig, log, tempLibrary } from './git-support.ts';

const librarian = { name: 'Librarian', email: 'librarian@neo-hoard.invalid' };
const CHAPTER = 'wiki/Harbour.html';
const BAD = '<p data-block="b1">One.</p>\n<p data-block="b 2">Two.</p>';
const GOOD = '<p data-block="b1">One.</p>\n<p data-block="b2">Two.</p>';

async function setup(t: Parameters<typeof tempLibrary>[0]) {
  isolateGitConfig(t, { name: 'Ada Author', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  const logged: string[] = [];
  const gate = new Gate({ library: () => lib.library, log: (level, message) => logged.push(`${level}|${message}`) });
  lib.write(CHAPTER, '<p data-block="b1">Old.</p>');
  await lib.git.run(lib.library, ['init', '-q']);
  await commitAll(lib.git, lib.library, { who: 'author', reason: 'start', librarian, gate });
  const changed = async () => (await lib.git.run(lib.library, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean);
  const files = async (rev: string) => (await lib.git.run(lib.library, ['show', '--name-only', '--format=', rev])).stdout.split('\n').filter(Boolean);
  return { ...lib, gate, logged, changed, files };
}

test('Gate-Warns-The-Writer: a writer\'s commit with a finding still commits every change, and the finding is kept', async (t) => {
  const { library, git, write, gate, logged, changed } = await setup(t);
  write(CHAPTER, BAD);
  const made = await commitAll(git, library, { who: 'author', reason: 'idle', librarian, gate });
  assert.ok(made);
  assert.equal(made.files, 1);
  assert.deepEqual(await changed(), []);
  assert.deepEqual(gate.findings().map((f) => `${f.path}|${f.rule}`), [`${CHAPTER}|Block-Ids-Citable`]);
  assert.ok(logged.some((l) => l.startsWith('warn|') && l.includes(CHAPTER)), logged.join('\n'));
});

test('Gate-Warns-The-Writer: a finding is logged once, and dropped once its file is fixed', async (t) => {
  const { library, git, write, gate, logged } = await setup(t);
  write(CHAPTER, BAD);
  await commitAll(git, library, { who: 'author', reason: 'idle', librarian, gate });
  write(CHAPTER, `${BAD}\n<p>More.</p>`);
  await commitAll(git, library, { who: 'author', reason: 'idle', librarian, gate });
  assert.equal(logged.filter((l) => l.startsWith('warn|')).length, 1);
  assert.equal(gate.findings().length, 1);
  write(CHAPTER, GOOD);
  await commitAll(git, library, { who: 'author', reason: 'idle', librarian, gate });
  assert.deepEqual(gate.findings(), []);
});

test('Gate-Warns-The-Writer: import only warns, even when the librarian is credited with it', async (t) => {
  const { library, git, write, gate, changed } = await setup(t);
  write(CHAPTER, BAD);
  const made = await commitAll(git, library, { who: 'librarian', reason: 'import', librarian, gate });
  assert.ok(made);
  assert.deepEqual(await changed(), []);
});

test('Librarian-Edit-Refused: a failing librarian edit commits nothing, stages nothing, and keeps its words on disk', async (t) => {
  const { library, git, write, gate, changed } = await setup(t);
  const head = (await git.run(library, ['rev-parse', 'HEAD'])).stdout.trim();
  write(CHAPTER, BAD);
  await assert.rejects(
    commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: [CHAPTER] }),
    (err: unknown) => err instanceof GateRefused && err.findings.length === 1 && err.findings[0]!.path === CHAPTER,
  );
  assert.equal((await git.run(library, ['rev-parse', 'HEAD'])).stdout.trim(), head);
  assert.deepEqual(await changed(), [` M ${CHAPTER}`]); // modified on disk, nothing staged
  assert.equal(readFileSync(path.join(library, CHAPTER), 'utf8'), BAD);
});

test('Librarian-Edit-Refused: a clean librarian edit commits as the librarian', async (t) => {
  const { library, git, write, gate } = await setup(t);
  write(CHAPTER, GOOD);
  const made = await commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: [CHAPTER] });
  assert.ok(made);
  assert.deepEqual(await log(git, library, '%an'), ['Librarian', 'Ada Author']);
});

test('Refused-Edit-Held-Back: the writer\'s commits leave a refused file out until the writer saves it', async (t) => {
  const { library, git, write, gate, changed, files } = await setup(t);
  write(CHAPTER, BAD);
  await assert.rejects(commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: [CHAPTER] }), GateRefused);
  assert.deepEqual(gate.held(), [CHAPTER]);
  write('wiki/Ferry.html', '<p>Elsewhere.</p>');
  const made = await commitAll(git, library, { who: 'author', reason: 'idle', librarian, gate });
  assert.ok(made);
  assert.deepEqual(await files('HEAD'), ['wiki/Ferry.html']);
  assert.deepEqual(await changed(), [` M ${CHAPTER}`]);

  gate.saved(CHAPTER);
  assert.deepEqual(gate.held(), []);
  await commitAll(git, library, { who: 'author', reason: 'idle', librarian, gate });
  assert.deepEqual(await files('HEAD'), [CHAPTER]);
  assert.deepEqual(await changed(), []);
});

test('Refused-Edit-Held-Back: releasing paths frees exactly those, and the rest stay held', async (t) => {
  const { library, git, write, gate } = await setup(t);
  const other = 'wiki/Ferry.html';
  write(CHAPTER, BAD);
  await assert.rejects(commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: [CHAPTER] }), GateRefused);
  write(other, BAD);
  await assert.rejects(commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: [other] }), GateRefused);
  assert.deepEqual(gate.held(), [other, CHAPTER]);
  gate.release([CHAPTER, 'wiki/Never.html']);
  assert.deepEqual(gate.held(), [other]);
});

test('Refused-Edit-Held-Back: a later librarian commit of the file that passes lets it go', async (t) => {
  const { library, git, write, gate, changed } = await setup(t);
  write(CHAPTER, BAD);
  await assert.rejects(commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: [CHAPTER] }), GateRefused);
  await commitAll(git, library, { who: 'author', reason: 'librarian-before', librarian, gate });
  assert.deepEqual(await changed(), [` M ${CHAPTER}`]);
  write(CHAPTER, GOOD);
  await commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: [CHAPTER] });
  assert.deepEqual(gate.held(), []);
  assert.deepEqual(await changed(), []);
  assert.deepEqual(await log(git, library, '%an'), ['Librarian', 'Ada Author']);
});

test('Librarian-Edit-Refused: a librarian edit of a wiki page citing a block of a sources page the library lacks is refused, and one citing a real block commits', async (t) => {
  const { library, git, write, gate } = await setup(t);
  write('sources/Log.html', '<p data-block="l1">The docks open at dawn.</p>');
  await commitAll(git, library, { who: 'author', reason: 'idle', librarian, gate });
  write('wiki/Harbour.html', '<p data-block="h1">[[Log#^l9]]</p>');
  await assert.rejects(
    commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: ['wiki/Harbour.html'] }),
    (err: unknown) => err instanceof GateRefused && err.findings.map((f) => f.rule).join() === 'Citations-Resolve',
  );
  write('wiki/Harbour.html', '<p data-block="h1">[[Log#^l1]]</p>');
  assert.ok(await commitAll(git, library, { who: 'librarian', reason: 'librarian-after', librarian, gate, paths: ['wiki/Harbour.html'] }));
});
