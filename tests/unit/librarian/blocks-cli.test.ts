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
  if (s.includes('Find where each entry starts')) {
    // Every block starts an entry, titled by its text.
    const starts = [...s.matchAll(/<block id="(b\\d+)"[^>]*>\\n([^\\n]*)/g)].map(([, id, text]) => ({ start: id, title: text, summary: 's' }));
    process.stdout.write(JSON.stringify(starts));
    return;
  }
  if (s.includes('Group the entries')) {
    // Entries about an otter share a topic; the rest stand alone.
    const ids = [...s.matchAll(/<entry id="(e\\d+)"[^>]*title="([^"]*)"/g)];
    const otters = ids.filter(([, , t]) => /otter/i.test(t)).map(([, id]) => id);
    const rest = ids.filter(([, , t]) => !/otter/i.test(t)).map(([, id, t]) => ({ name: t, entries: [id] }));
    process.stdout.write(JSON.stringify([...(otters.length ? [{ name: 'Otters', entries: otters }] : []), ...rest]));
    return;
  }
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
  assert.deepEqual(rows.map((r) => [r.page, r.label, r.dest]), [
    ['Daily/2026-01-01.md', 'morning-pages', 'out'],
    ['Daily/2026-01-01.md', 'writing', 'sources'],
    ['Daily/2026-01-01.md', 'tasks', 'out'],
    ['Scratch.md', 'writing', 'sources'],
    ['Scratch.md', 'tasks', 'out'],
  ]);
  assert.match(first.stdout, /5 blocks/);
  assert.match(first.stderr, /"logger":"librarian\.blocks\.cli".*Scratch\.md/);

  // The author renames a dest; the page gains a block; a re-run judges only that one.
  rows[3]!.dest_page = 'Otter-Notes';
  writeFileSync(sheet, writeSheet(rows));
  writeFileSync(path.join(vault, 'Scratch.md'), 'The otter again.\n\n- [ ] Shop\n\nA second otter.');
  const second = await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, '--pages', 'pages.txt', 'Scratch.md'], dir);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(readFileSync(path.join(dir, 'calls.txt'), 'utf8').length, 5, 'one more call, for the new block only');
  rows = readSheet(readFileSync(sheet, 'utf8'));
  assert.equal(rows.length, 6);
  assert.equal(rows[3]!.dest_page, 'Otter-Notes');

  const out = path.join(dir, 'out');
  const applied = await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out, '--vault-prefix', 'E:\\Private\\vault', '--picks', 'picks.jsonl'], dir);
  assert.equal(applied.code, 0, applied.stderr);
  const picks = readFileSync(path.join(dir, 'picks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; target: string });
  assert.deepEqual(picks.map((p) => p.kind).sort(), ['morning-pages', 'morning-pages', 'writing', 'writing', 'writing']);
  assert.ok(picks.some((p) => p.target === 'Otter-Notes'));
  await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out, '--vault-prefix', 'E:\\Private\\vault', '--picks', 'wiki.jsonl', '--picks-kinds', 'writing'], dir);
  const wikiOnly = readFileSync(path.join(dir, 'wiki.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string });
  assert.deepEqual(wikiOnly.map((p) => p.kind), ['writing', 'writing', 'writing']);
  assert.equal((await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out, '--picks', 'x.jsonl', '--picks-kinds', 'poems'], dir)).code, 2);
  assert.ok(existsSync(path.join(out, 'Morning Pages.md')));
  assert.match(readFileSync(path.join(out, 'import-list.txt'), 'utf8'), /^E:\\Private\\vault\\Scratch\.md#L1-L1@[0-9a-f]{16} -> Otter-Notes$/m);
  assert.match(readFileSync(path.join(out, 'import-list.txt'), 'utf8'), /^to: sources$/m);
  assert.equal((await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out, '--path-prefix', 'E:\\x'], dir)).code, 2, 'the old option is refused');
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
  assert.deepEqual(readSheet(readFileSync(sheet, 'utf8')).map((x) => [x.label, x.dest, x.by]), [['other', 'check', 'no-judge'], ['tasks', 'check', 'no-judge']]);
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

test('text repeated across pages goes to the library once', async () => {
  const { dir, vault, judge } = setup();
  writeFileSync(path.join(vault, 'Copy.md'), 'The otter again.');
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md', 'Copy.md'], dir);
  const rows = readSheet(readFileSync(sheet, 'utf8'));
  assert.deepEqual(rows.filter((r) => r.preview === 'The otter again.').map((r) => [r.page, r.dest]), [['Scratch.md', 'sources'], ['Copy.md', 'out']]);
});

test('group cuts classified pages into entries and topics, once unless asked again', async () => {
  const { dir, vault, judge } = setup();
  writeFileSync(path.join(vault, 'Scratch.md'), 'The otter again.\n\n- [ ] Shop\n\nA second otter.');
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  const calls = () => readFileSync(path.join(dir, 'calls.txt'), 'utf8').length;
  const before = calls();

  const r = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(calls() - before, 3, 'one entry call, two topic votes');
  const rows = readSheet(readFileSync(sheet, 'utf8'));
  assert.deepEqual(rows.map((x) => [x.entry, x.topic, x.topic_by, x.dest_page]), [
    ['e1', 'Otters', 'judge', 'Scratch-Otters-(snippets)'],
    ['e2', '- [ ] Shop', 'judge', ''],
    ['e3', 'Otters', 'judge', 'Scratch-Otters-(snippets)'],
  ]);
  const text = readFileSync(path.join(dir, 'outlines', 'Scratch.md'), 'utf8');
  assert.match(text, /## Otters \(2 entries\)/);
  assert.match(r.stdout, /Grouped 1 of 1 pages/);

  await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(calls() - before, 3, 'a grouped page is left alone');
  await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, '--redo', 'Scratch.md'], dir);
  assert.equal(calls() - before, 6, '--redo groups it again');
});

test('group needs a judge and a page classified as it now stands', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal((await run(['group', '--vault', vault, '--sheet', sheet, 'Scratch.md'], dir)).code, 2);
  const unknown = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Daily/2026-01-01.md'], dir);
  assert.equal(unknown.code, 3);
  assert.match(unknown.stderr, /classify it first/);
  writeFileSync(path.join(vault, 'Scratch.md'), 'The otter, changed.\n\n- [ ] Shop');
  const changed = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(changed.code, 3);
  assert.match(changed.stderr, /classify it again first/);
  writeFileSync(path.join(vault, 'Scratch.md'), 'The otter again.');
  const shrunk = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(shrunk.code, 3, 'a block gone from the page counts as a change too');
  assert.match(shrunk.stderr, /classify it again first/);
});

test('when the outline cannot be written the page is not marked grouped', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  mkdirSync(path.join(dir, 'outlines', 'Scratch.md'), { recursive: true }); // a folder where the file should go
  const r = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(r.code, 3);
  assert.ok(readSheet(readFileSync(sheet, 'utf8')).every((x) => x.entry === ''), 'a re-run will group it');
  // A page grouped after it saves the sheet, but not the failed page's grouping.
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, '--pages', 'pages.txt'], dir);
  const both = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md', 'Daily/2026-01-01.md'], dir);
  assert.equal(both.code, 3);
  const rows = readSheet(readFileSync(sheet, 'utf8'));
  assert.ok(rows.filter((x) => x.page === 'Scratch.md').every((x) => x.entry === ''));
  assert.ok(rows.filter((x) => x.page !== 'Scratch.md').every((x) => x.entry !== ''));
});

test('each page gets its own outline, in the folders the page sits in', async () => {
  const { dir, vault, judge } = setup();
  mkdirSync(path.join(vault, 'A'));
  writeFileSync(path.join(vault, 'A', 'B.md'), 'An otter in a folder.');
  writeFileSync(path.join(vault, 'A - B.md'), 'An otter beside it.');
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'A/B.md', 'A - B.md'], dir);
  const r = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'A/B.md', 'A - B.md'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(path.join(dir, 'outlines', 'A', 'B.md'), 'utf8'), /in a folder/);
  assert.match(readFileSync(path.join(dir, 'outlines', 'A - B.md'), 'utf8'), /beside it/);
});

test('a failed outline write leaves the last outline whole', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  const file = path.join(dir, 'outlines', 'Scratch.md');
  const last = readFileSync(file, 'utf8');
  mkdirSync(`${file}.tmp`); // the temporary file cannot be written
  const r = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, '--redo', 'Scratch.md'], dir);
  assert.equal(r.code, 3);
  assert.equal(readFileSync(file, 'utf8'), last);
});

test('a page name that only starts with two dots still gets its outline', async () => {
  const { dir, vault, judge } = setup();
  writeFileSync(path.join(vault, '..draft.md'), 'An otter, dotted.');
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, '..draft.md'], dir);
  const r = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, '..draft.md'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(readFileSync(path.join(dir, 'outlines', '..draft.md'), 'utf8'), /dotted/);
});

test('group counts a block moved under another heading as a change', async () => {
  const { dir, vault, judge } = setup();
  writeFileSync(path.join(vault, 'Scratch.md'), '## Ideas\nThe otter again.\n\n## Shopping\n- [ ] Shop');
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  writeFileSync(path.join(vault, 'Scratch.md'), '## Ideas\n\n## Shopping\nThe otter again.\n\n- [ ] Shop');
  const moved = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(moved.code, 3);
  assert.match(moved.stderr, /classify it again first/);
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md'], dir);
  const again = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md'], dir);
  assert.equal(again.code, 0, again.stderr);
});

test('a page that cannot be read is counted, and the pages after it still run', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md', 'Daily/2026-01-01.md'], dir);
  rmSync(path.join(vault, 'Scratch.md'));
  mkdirSync(path.join(vault, 'Scratch.md')); // there, but not a file
  const grouped = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, 'Scratch.md', 'Daily/2026-01-01.md'], dir);
  assert.equal(grouped.code, 3);
  assert.match(grouped.stdout, /Grouped 1 of 2 pages/);
  assert.ok(readSheet(readFileSync(sheet, 'utf8')).filter((x) => x.page !== 'Scratch.md').every((x) => x.entry !== ''));
  const classified = await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md', 'Daily/2026-01-01.md'], dir);
  assert.equal(classified.code, 3);
  assert.match(classified.stderr, /Scratch\.md/);
});

test('pages outside the vault are refused before they are read', async () => {
  const { dir, vault, judge } = setup();
  writeFileSync(path.join(dir, 'outside.md'), 'An otter outside.');
  const sheet = path.join(dir, 'sheet.csv');
  const classified = await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, 'Scratch.md', '../outside.md'], dir);
  assert.equal(classified.code, 3);
  assert.match(classified.stderr, /\.\.\/outside\.md: outside the vault/);
  const rows = readSheet(readFileSync(sheet, 'utf8'));
  assert.ok(!rows.some((x) => x.page === '../outside.md'));
  // A row someone wrote by hand is refused too, and nothing of the page reaches the judge.
  writeFileSync(sheet, writeSheet([...rows, { ...rows[0]!, page: '../outside.md' }]));
  const calls = () => readFileSync(path.join(dir, 'calls.txt'), 'utf8').length;
  const before = calls();
  const grouped = await run(['group', '--vault', vault, '--sheet', sheet, '--judge', judge, '../outside.md'], dir);
  assert.equal(grouped.code, 3);
  assert.match(grouped.stderr, /outside the vault/);
  assert.equal(calls(), before);
});

test('apply refuses a sheet with no rows, and leaves the last outputs alone', async () => {
  const { dir, vault, judge } = setup();
  const sheet = path.join(dir, 'sheet.csv');
  const out = path.join(dir, 'out');
  await run(['classify', '--vault', vault, '--out', sheet, '--judge', judge, '--pages', 'pages.txt'], dir);
  assert.equal((await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out], dir)).code, 0);
  const before = readFileSync(path.join(out, 'import-list.txt'), 'utf8');
  writeFileSync(sheet, writeSheet([]));
  const r = await run(['apply', '--vault', vault, '--sheet', sheet, '--out', out], dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no rows/);
  assert.equal(readFileSync(path.join(out, 'import-list.txt'), 'utf8'), before);
});
