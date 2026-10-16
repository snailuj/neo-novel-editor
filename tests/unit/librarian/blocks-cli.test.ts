// The blocks command line, end to end in a made-up vault with a stub judge: classify
// writes a sheet, a re-run judges only new blocks and keeps the author's edits, and
// apply writes from the reviewed sheet.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { main } from '../../../src/librarian/blocks/cli.ts';
import { readSheet, writeSheet } from '../../../src/librarian/blocks/sheet.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'blocks-cli-')));
  temps.push(dir);
  return dir;
};

// Labels a block writing when it mentions an otter, morning-pages under a Morning Pages
// heading, else tasks; counts its calls in calls.txt.
function stubJudge(dir: string): string {
  const script = path.join(dir, 'judge.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  fs.appendFileSync(${JSON.stringify(path.join(dir, 'calls.txt'))}, 'x');
  const out = [...s.matchAll(/<block id="(b\\d+)" heading="([^"]*)"[^>]*>\\n([\\s\\S]*?)\\n<\\/block>/g)].map(([, id, h, text]) => ({
    id, label: /otter/i.test(text) ? 'writing' : /Morning Pages/.test(h) ? 'morning-pages' : 'tasks', pasted: false, reason: 'stub',
  }));
  process.stdout.write(JSON.stringify(out));
});`);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

function run(args: string[], cwd: string) {
  let stdout = '';
  let stderr = '';
  return main(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd }).then((code) => ({ code, stdout, stderr }));
}

function setup() {
  const dir = tempDir();
  const vault = path.join(dir, 'vault');
  mkdirSync(path.join(vault, 'Daily'), { recursive: true });
  writeFileSync(path.join(vault, 'Daily', '2026-01-01.md'), '## Morning Pages\nI woke.\n\nAn otter at the door.\n\n## Tasks\n- [ ] Walk');
  writeFileSync(path.join(vault, 'Scratch.md'), 'The otter again.\n\n- [ ] Shop');
  writeFileSync(path.join(dir, 'pages.txt'), 'Daily/2026-01-01.md\n');
  return { dir, vault, judge: stubJudge(dir) };
}

test('classify, review, re-run, apply', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  const first = await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, '--votes', '2', '--pages', 'pages.txt', 'Scratch.md'], dir);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(readFileSync(path.join(dir, 'calls.txt'), 'utf8').length, 4, 'two pages, two votes');
  let rows = readSheet(readFileSync(sheet, 'utf8'));
  assert.deepEqual(rows.map((r) => [r.page, r.label, r.wiki]), [
    ['Daily/2026-01-01.md', 'morning-pages', 'no'],
    ['Daily/2026-01-01.md', 'writing', 'yes'],
    ['Daily/2026-01-01.md', 'tasks', 'no'],
    ['Scratch.md', 'writing', 'yes'],
    ['Scratch.md', 'tasks', 'no'],
  ]);
  assert.match(first.stdout, /5 blocks/);
  assert.match(first.stderr, /"logger":"librarian\.blocks\.cli".*Scratch\.md/);

  // The author renames a dest; the page gains a block; a re-run judges only that one.
  rows[3]!.wiki_page = 'Otter-Notes';
  writeFileSync(sheet, writeSheet(rows));
  writeFileSync(path.join(vault, 'Scratch.md'), 'The otter again.\n\n- [ ] Shop\n\nA second otter.');
  const second = await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, '--pages', 'pages.txt', 'Scratch.md'], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(readFileSync(path.join(dir, 'calls.txt'), 'utf8').length, 5, 'one more call, for the new block only');
  rows = readSheet(readFileSync(sheet, 'utf8'));
  assert.equal(rows.length, 6);
  assert.equal(rows[3]!.wiki_page, 'Otter-Notes');

  const out = path.join(dir, 'out');
  const applied = await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out, '--path-prefix', 'E:\\Private\\out', '--picks', 'picks.jsonl'], dir);
  assert.equal(applied.code, 0, applied.stderr);
  const picks = readFileSync(path.join(dir, 'picks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; target: string });
  assert.deepEqual(picks.map((p) => p.kind).sort(), ['morning-pages', 'morning-pages', 'writing', 'writing', 'writing']);
  assert.ok(picks.some((p) => p.target === 'Otter-Notes'));
  await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out, '--path-prefix', 'E:\\Private\\out', '--picks', 'wiki.jsonl', '--picks-kinds', 'writing'], dir);
  const wikiOnly = readFileSync(path.join(dir, 'wiki.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
  assert.deepEqual(wikiOnly.map((p) => p.kind), ['writing', 'writing', 'writing']);
  assert.equal((await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out, '--picks', 'x.jsonl', '--picks-kinds', 'poems'], dir)).code, 2);
  assert.ok(existsSync(path.join(out, 'wiki', 'Otter-Notes.md')));
  assert.ok(existsSync(path.join(out, 'Morning Pages.md')));
  assert.match(readFileSync(path.join(out, 'import-list.txt'), 'utf8'), /^E:\\Private\\out\\wiki\\/);
});

test('a page run alone keeps the rows of pages not in this run', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, '--pages', 'pages.txt', 'Scratch.md'], dir);
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(readSheet(readFileSync(sheet, 'utf8')).length, 5);
});

test('with no judge every unruled block is marked to check', async () => {
  const { dir, vault } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  const r = await run(['classify', '--vault', vault, '--out', sheet, 'Scratch.md'], dir);
  assert.equal(r.code, 0);
  assert.deepEqual(readSheet(readFileSync(sheet, 'utf8')).map((x) => [x.label, x.wiki, x.by]), [['other', 'check', 'no-judge'], ['tasks', 'check', 'no-judge']]);
});

test('apply exits 1 and names a block that changed since review', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  writeFileSync(path.join(vault, 'Scratch.md'), 'The otter, changed.\n\n- [ ] Shop');
  const r = await run(['apply', '--vault', vault, '--sheet', sheet, '--out', path.join(dir, 'out')], dir);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /changed since review: Scratch\.md lines 1-1/);
});

test('usage and a missing page', async () => {
  const { dir, vault } = setup();
  assert.equal((await run(['classify', '--vault', vault], dir)).code, 2, '--out is required');
  assert.equal((await run(['nope'], dir)).code, 2);
  const r = await run(['classify', '--vault', vault, '--out', path.join(dir, 's.csv'), 'Missing.md', 'Scratch.md'], dir);
  assert.equal(r.code, 3, 'a missing page is an error');
  assert.equal(readSheet(readFileSync(path.join(dir, 's.csv'), 'utf8')).length, 2, 'the other pages still go in');
});
