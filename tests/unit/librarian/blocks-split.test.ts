// Splitting a scratchpad page into blocks. The rule: every non-blank line outside a
// heading, a separator and the blank lines belongs to exactly one block, and a block's
// lines read back from the page give its text. Fixtures are made up.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitBlocks } from '../../../src/librarian/blocks/split.ts';

const PAGE = [
  '---', // 1
  'id: 1', // 2
  '---', // 3
  '', // 4
  '## Habits', // 5
  '- [ ] Walk', // 6
  '- [x] Read', // 7
  '    - nested note', // 8
  '', // 9
  '## Morning Pages', // 10
  'Topics:: [[Some-Page]]', // 11
  '', // 12
  'First line of free writing', // 13
  'runs on here.', // 14
  '    indented but still the paragraph', // 15
  '', // 16
  '---', // 17
  'A scene after a separator.', // 18
  '### Deeper', // 19
  '```', // 20
  '# not a heading', // 21
  '', // 22
  '```', // 23
  '> a quote', // 24
  '> more', // 25
  '%% a comment', // 26
  'over two lines %%', // 27
  '| a | b |', // 28
  '|---|---|', // 29
  '1. first', // 30
  '', // 31
  '   still first', // 32
  '2. second', // 33
  'tail paragraph', // 34
].join('\n');

test('every non-blank line that is not a heading or separator lands in exactly one block', () => {
  const blocks = splitBlocks(PAGE);
  const lines = PAGE.split('\n');
  const owned = new Map<number, number>();
  for (const b of blocks) {
    for (let n = b.start; n <= b.end; n++) owned.set(n, (owned.get(n) ?? 0) + 1);
    assert.equal(b.text, lines.slice(b.start - 1, b.end).join('\n'), `block at ${b.start} reads back`);
  }
  lines.forEach((line, i) => {
    const n = i + 1;
    const structural = /^#{1,6}\s/.test(line) && n !== 21 || line === '---' && n === 17 || line.trim() === '';
    if (structural) return;
    assert.equal(owned.get(n), 1, `line ${n} (${line}) is in one block`);
  });
  // Separators and headings are in no block.
  for (const n of [5, 10, 17, 19]) assert.equal(owned.get(n), undefined, `line ${n} is not in a block`);
});

test('kinds, ranges and heading paths', () => {
  const got = splitBlocks(PAGE).map((b) => [b.kind, b.start, b.end, b.heading.join(' > ')]);
  assert.deepEqual(got, [
    ['frontmatter', 1, 3, ''],
    ['list-item', 6, 6, 'Habits'],
    ['list-item', 7, 8, 'Habits'],
    ['paragraph', 11, 11, 'Morning Pages'],
    ['paragraph', 13, 15, 'Morning Pages'],
    ['paragraph', 18, 18, 'Morning Pages'],
    ['fence', 20, 23, 'Morning Pages > Deeper'],
    ['quote', 24, 25, 'Morning Pages > Deeper'],
    ['comment', 26, 27, 'Morning Pages > Deeper'],
    ['table', 28, 29, 'Morning Pages > Deeper'],
    ['list-item', 30, 32, 'Morning Pages > Deeper'],
    // An unindented line straight after an item is a lazy continuation, as in Markdown.
    ['list-item', 33, 34, 'Morning Pages > Deeper'],
  ]);
});

test('a heading of the same level replaces its sibling in the path', () => {
  const blocks = splitBlocks('# A\n## B\nx\n## C\ny\n# D\nz');
  assert.deepEqual(blocks.map((b) => b.heading.join('>')), ['A>B', 'A>C', 'D']);
});

test('ids are stable, content-based and unique within a page', () => {
  const a = splitBlocks('- [ ] Walk\n- [ ] Walk\n\nWords.');
  const b = splitBlocks('# New heading\n\n- [ ] Walk\n- [ ] Walk\n\nWords.');
  assert.equal(new Set(a.map((x) => x.id)).size, 3);
  assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id), 'moving a block does not change its id');
  assert.match(a[0]!.id, /^[0-9a-f]{10}$/);
  assert.equal(a[1]!.id, `${a[0]!.id}-2`);
  const c = splitBlocks('- [ ] Walk\n- [ ] Walk\n\nOther words.');
  assert.notEqual(c[2]!.id, a[2]!.id, 'changed text, new id');
});

test('CRLF pages split the same way and keep line numbers', () => {
  const lf = splitBlocks(PAGE);
  const crlf = splitBlocks(PAGE.replace(/\n/g, '\r\n'));
  assert.deepEqual(crlf.map((b) => [b.start, b.end, b.id]), lf.map((b) => [b.start, b.end, b.id]));
});

test('a page with no frontmatter whose first line is a separator', () => {
  const blocks = splitBlocks('---\nA scene.\n\n---\nAnother.');
  assert.deepEqual(blocks.map((b) => [b.kind, b.text]), [['paragraph', 'A scene.'], ['paragraph', 'Another.']]);
});

test('an unclosed fence runs to the end of the page', () => {
  const blocks = splitBlocks('```\ncode\n## not heading');
  assert.deepEqual(blocks.map((b) => [b.kind, b.start, b.end]), [['fence', 1, 3]]);
});

test('a tab-indented child stays with its list item', () => {
  const blocks = splitBlocks('- [ ] ideas:\n\t- a story idea\n\t\t- deeper\n- [ ] next');
  assert.deepEqual(blocks.map((b) => [b.start, b.end]), [[1, 3], [4, 4]]);
});
