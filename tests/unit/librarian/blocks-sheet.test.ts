// The review sheet: one row per block with the classifier's proposal and the author's
// copy to edit. Rules: a sheet reads back as written; an author's edits survive a
// re-run; nothing already on an import list is proposed again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Judged } from '../../../src/librarian/blocks/judge.ts';
import { defaultBook, defaultDest, mergeRows, parseAlready, readSheet, rowsFor, writeSheet } from '../../../src/librarian/blocks/sheet.ts';
import { splitBlocks } from '../../../src/librarian/blocks/split.ts';

const PAGE = [
  '## Morning Pages', // 1
  'I woke and wrote.', // 2
  '', // 3
  'The fox crept along the wall, "quiet," she said.', // 4
  '## Tasks', // 5
  '- [ ] Walk', // 6
  '## The Story', // 7
  'Once, a car.', // 8
].join('\n');
const PATH = 'Daily/2026-01-02 Week 1.md';

const judged = (blocks: ReturnType<typeof splitBlocks>, items: [string, boolean?, Judged['by']?][]) =>
  new Map(blocks.map((b, i) => {
    const [label, pasted, by] = items[i]!;
    return [b.id, { label, pasted: pasted ?? false, reason: `why ${i}`, by: by ?? 'judge', votes: [label] } as Judged];
  }));

test('rows carry the proposal and sensible defaults for include, dest and book', () => {
  const blocks = splitBlocks(PAGE);
  const rows = rowsFor(PATH, blocks, judged(blocks, [['morning-pages'], ['writing'], ['tasks'], ['writing', true]]), []);
  assert.deepEqual(rows.map((r) => [r.proposed, r.label, r.include, r.dest, r.book, r.by]), [
    ['morning-pages', 'morning-pages', 'yes', '', '2026-01-02', 'judge'],
    ['writing', 'writing', 'yes', '2026-01-02-Week-1-Morning-Pages-(snippets)', '2026-01-02', 'judge'],
    ['tasks', 'tasks', 'no', '', '', 'judge'],
    // pasted writing is left out by default
    ['writing', 'writing', 'no', '2026-01-02-Week-1-The-Story-(snippets)', '', 'judge'],
  ]);
  assert.equal(rows[1]!.lines, '4-4');
  assert.equal(rows[1]!.heading, 'Morning Pages');
  assert.equal(rows[3]!.pasted, 'yes');
});

test('votes that differ, a failed judge and no judge all ask the author', () => {
  const blocks = splitBlocks(PAGE);
  const verdicts = judged(blocks, [['writing', false, 'votes-differ'], ['writing', false, 'judge-failed'], ['tasks'], ['other']]);
  verdicts.delete(blocks[3]!.id);
  const rows = rowsFor(PATH, blocks, verdicts, []);
  assert.deepEqual(rows.map((r) => [r.include, r.by]), [['check', 'votes-differ'], ['check', 'judge-failed'], ['no', 'judge'], ['check', 'no-judge']]);
});

test('ruled blocks say so and are never included', () => {
  const blocks = splitBlocks('---\nid: 1\n---\n![[Groceries]]');
  const rows = rowsFor(PATH, blocks, new Map(), []);
  assert.deepEqual(rows.map((r) => [r.label, r.include, r.by, r.reason]), [['other', 'no', 'rule', 'frontmatter'], ['other', 'no', 'rule', 'embed']]);
});

test('a page or section already on an import list is not proposed again', () => {
  const already = parseAlready([
    '# a comment',
    'E:\\Vault\\Daily\\2026-01-02 Week 1.md#The Story -> Story-(memoir)',
    'E:\\Vault\\Other.md',
    '',
  ].join('\n'));
  const blocks = splitBlocks(PAGE);
  const rows = rowsFor(PATH, blocks, judged(blocks, [['morning-pages'], ['writing'], ['tasks'], ['writing']]), already);
  assert.deepEqual(rows.map((r) => r.include), ['yes', 'yes', 'no', 'no']);
  assert.match(rows[3]!.reason, /already imported as Story-\(memoir\)/);
  const whole = rowsFor('Other.md', splitBlocks('Words.'), new Map(), already);
  assert.equal(whole[0]!.include, 'no');
  assert.match(whole[0]!.reason, /already imported/);
  assert.equal(rowsFor('Not/Other.md', splitBlocks('Words.'), new Map(), already)[0]!.include, 'check', 'a path matches whole segments only');
});

test('a sheet reads back as written, quotes, commas, newlines and all', () => {
  const blocks = splitBlocks(PAGE);
  const rows = rowsFor(PATH, blocks, judged(blocks, [['morning-pages'], ['writing'], ['tasks'], ['writing']]), []);
  rows[0]!.reason = 'has "quotes", commas\nand a newline';
  const text = writeSheet(rows);
  assert.ok(text.startsWith('\uFEFFpage,block,lines,'), 'a BOM so Excel reads UTF-8');
  assert.deepEqual(readSheet(text), rows);
  assert.deepEqual(readSheet(text.replace(/\r?\n/g, '\r\n')), rows, 'CRLF too');
  assert.match(rows[1]!.preview, /fox crept/);
});

test('a re-run keeps every reviewed row and adds new blocks', () => {
  const blocks = splitBlocks(PAGE);
  const old = rowsFor(PATH, blocks, judged(blocks, [['morning-pages'], ['writing'], ['tasks'], ['writing']]), []);
  old[2]!.label = 'writing';
  old[2]!.include = 'yes';
  old[2]!.dest = 'My-Page';
  const page2 = `${PAGE}\n\nA new line.`;
  const blocks2 = splitBlocks(page2);
  const fresh = rowsFor(PATH, blocks2, judged(blocks2, [['other'], ['other'], ['other'], ['other'], ['writing']]), []);
  const merged = mergeRows(old, fresh);
  assert.equal(merged.length, 5);
  assert.deepEqual([merged[2]!.label, merged[2]!.include, merged[2]!.dest], ['writing', 'yes', 'My-Page']);
  assert.equal(merged[0]!.proposed, 'morning-pages', 'the old proposal stays too');
  assert.equal(merged[4]!.proposed, 'writing');
});

test('default names are one safe path segment', () => {
  assert.equal(defaultDest('a/b: c?.md', 'x/y #z'), 'b-c-x-y-z-(snippets)');
  assert.equal(defaultDest('Notes.md', ''), 'Notes-(snippets)');
  assert.equal(defaultBook('Garuda.md', '2026-04-14 > Sub'), '2026-04-14');
  assert.equal(defaultBook('Garuda.md', 'July'), 'Garuda');
});
