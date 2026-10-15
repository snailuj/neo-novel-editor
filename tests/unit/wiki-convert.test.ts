// Rules for bringing a Markdown page in. The page arrives as NEO HTML: each block is a
// paragraph whose class names what it was (a heading, a list item, a quotation, a line
// of code), its emphasis is NEO's own b, i and s, and every block carries an id that a
// citation can point at. The frontmatter is handed back apart from the words, and each
// CriticMarkup mark becomes a mark on the words it was about, the text reading as if
// every mark were rejected. Whatever cannot be a mark stays in the text, so no word is
// lost. Blame credits the author with what hoard counts as theirs: quotations and code.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrontmatterError } from '../../src/librarian/frontmatter.ts';
import { paragraphTexts } from '../../src/hoard/html.ts';
import { convertPage, pageHtml } from '../../src/hoard/wiki/convert.ts';

const ids = () => {
  let n = 0;
  return () => `b${++n}`;
};
const convert = (source: string) => convertPage(source, ids());
const shape = (source: string) => convert(source).blocks.map((b) => [b.kind, b.text]);

test('each block is a paragraph with its own class and id, and its text is what the page shows', () => {
  const page = convert('# Harbour\n\nThe **old** quay & the <new> one.\nA second line.\n');
  assert.equal(page.html, '<p class="wiki-h1" data-block="b1">Harbour</p><p data-block="b2">The <b>old</b> quay &amp; the &lt;new&gt; one.</p><p data-block="b3">A second line.</p>');
  assert.deepEqual(page.paragraphs, ['Harbour', 'The old quay & the <new> one.', 'A second line.']);
  assert.deepEqual(paragraphTexts(page.html), page.paragraphs);
  assert.equal(page.frontmatter, null);
  assert.deepEqual(page.marks, []);
});

test('headings of every level, written either way', () => {
  assert.deepEqual(shape('## Two ##\n###### Six\nSet\n===\nAlso\n---\n#NotAHeading'), [
    ['h2', 'Two'], ['h6', 'Six'], ['h1', 'Set'], ['h2', 'Also'], ['p', '#NotAHeading'],
  ]);
  // past a blank line, --- is a rule
  assert.deepEqual(shape('Text\n\n---'), [['p', 'Text'], ['break', '***']]);
});

test('list items keep their depth, number and tick', () => {
  const page = convert('- one\n  - *two*\n    1. three\n- [ ] four\n- [x] five\n7) seven');
  assert.equal(page.html, [
    '<p class="wiki-li" data-depth="0" data-block="b1">one</p>',
    '<p class="wiki-li" data-depth="1" data-block="b2"><i>two</i></p>',
    '<p class="wiki-li" data-depth="2" data-n="1" data-block="b3">three</p>',
    '<p class="wiki-li" data-depth="0" data-task="open" data-block="b4">four</p>',
    '<p class="wiki-li" data-depth="0" data-task="done" data-block="b5">five</p>',
    '<p class="wiki-li" data-depth="0" data-n="7" data-block="b6">seven</p>',
  ].join(''));
});

test('a quotation, a callout and a rule', () => {
  const page = convert('> She said it.\n>> Twice.\n> -- [[Log]] (Ada)\n\n> [!note] Mind the tide\n> It turns.\n\n***');
  assert.equal(page.html, [
    '<p class="wiki-quote" data-depth="1" data-block="b1">She said it.</p>',
    '<p class="wiki-quote" data-depth="2" data-block="b2">Twice.</p>',
    '<p class="wiki-quote" data-depth="1" data-block="b3">-- [[Log]] (Ada)</p>',
    '<p class="wiki-callout" data-callout="note" data-block="b4">Mind the tide</p>',
    '<p class="wiki-quote" data-depth="1" data-block="b5">It turns.</p>',
    '<p class="scene-break" data-block="b6">***</p>',
  ].join(''));
});

test('code keeps every line as written, a blank one too, with no emphasis read', () => {
  const page = convert('Before\n\n```js\nconst a_b = *c*;\n\n  x <y>\n```\nAfter\n');
  assert.deepEqual(page.blocks.map((b) => [b.kind, b.text]), [
    ['p', 'Before'], ['code', 'const a_b = *c*;'], ['code', ''], ['code', '  x <y>'], ['p', 'After'],
  ]);
  assert.match(page.html, /<p class="wiki-code" data-lang="js" data-block="b3"><br><\/p>/);
  assert.match(page.html, /<p class="wiki-code" data-lang="js" data-block="b4"> {2}x &lt;y&gt;<\/p>/);
});

test('a fence left open runs to the end of the page', () => {
  assert.deepEqual(shape('Intro\n```\ncode\n'), [['p', 'Intro'], ['code', 'code']]);
});

test('a table row stays as written, the header row marked and the rule row dropped', () => {
  const page = convert('| Name | **Age** |\n|:--|--:|\n| Ada | 30 |');
  assert.equal(page.html, '<p class="wiki-table" data-head="" data-block="b1">| Name | <b>Age</b> |</p><p class="wiki-table" data-block="b2">| Ada | 30 |</p>');
});

test("a block's own ^id is its id, on its line or the next, and no other block takes it", () => {
  const page = convertPage('First ^b2\n\n- item\n^keep-me\n\nThird', ids());
  assert.deepEqual(page.blocks.map((b) => [b.id, b.text]), [['b2', 'First'], ['keep-me', 'item'], ['b1', 'Third']]);
  // an id the page gives twice belongs to its first block
  assert.deepEqual(convert('A ^x\nB ^x').blocks.map((b) => [b.id, b.text]), [['x', 'A'], ['b1', 'B']]);
});

test('blame goes to the author for quotations and code, and to the librarian for the rest', () => {
  const page = convert('# Notes\n> A quote.\n> -- [[Log]] (Ada)\n```\nx\n```\nPlain.');
  assert.deepEqual(page.blocks.map((b) => b.owner), ['librarian', 'author', 'librarian', 'author', 'librarian']);
  assert.equal(pageHtml(page.blocks, 'author'), '<p class="wiki-quote" data-depth="1" data-block="b2">A quote.</p><p class="wiki-code" data-block="b4">x</p>');
  assert.equal(pageHtml([], 'author'), '<p><br></p>');
});

test('CRLF line ends and a byte-order mark read as plain lines', () => {
  assert.deepEqual(convert('﻿One\r\nTwo\r\n').paragraphs, ['One', 'Two']);
});

test('an empty page is one empty paragraph', () => {
  const page = convert('');
  assert.deepEqual(page.paragraphs, ['']);
  assert.equal(page.html, '<p data-block="b1"><br></p>');
});

test('frontmatter is handed back apart from the words, a date as it was written', () => {
  const page = convert('---\ntype: lore\ncreated: 2026-01-02\ntags: [sea, salt]\n---\nBody line.\n');
  assert.deepEqual(page.frontmatter, { type: 'lore', created: '2026-01-02', tags: ['sea', 'salt'] });
  assert.deepEqual(page.paragraphs, ['Body line.']);
});

test('frontmatter that does not read stops the page', () => {
  assert.throws(() => convert('---\ntype: [lore\n---\nBody.\n'), FrontmatterError);
});

test('each kind of mark lands on the words it was about, the text reading as rejected', () => {
  const page = convert([
    'The {++grey ++}gulls {--always --}cried.',
    'A {~~boat~>ship~~} sailed {==at dawn==}.',
    'She {==waited==}{>>For whom?<<} there.',
    '- He **{~~ran~>fled~~}{>>Stronger.<<}** home.',
  ].join('\n'));
  assert.deepEqual(page.paragraphs, ['The gulls always cried.', 'A boat sailed at dawn.', 'She waited there.', 'He ran home.']);
  const placed = page.marks.map(({ kind, pIdx, off, len, proposed, body }) => ({ kind, pIdx, off, len, proposed, body }));
  assert.deepEqual(placed, [
    { kind: 'insertion', pIdx: 0, off: 4, len: 0, proposed: 'grey ', body: undefined },
    { kind: 'deletion', pIdx: 0, off: 10, len: 7, proposed: undefined, body: undefined },
    { kind: 'substitution', pIdx: 1, off: 2, len: 4, proposed: 'ship', body: undefined },
    { kind: 'highlight', pIdx: 1, off: 14, len: 7, proposed: undefined, body: undefined },
    { kind: 'comment', pIdx: 2, off: 4, len: 6, proposed: undefined, body: 'For whom?' },
    { kind: 'substitution', pIdx: 3, off: 3, len: 3, proposed: 'fled', body: 'Stronger.' },
  ]);
  for (const m of page.marks) {
    const text = page.paragraphs[m.pIdx]!.slice(m.off, m.off + m.len);
    assert.ok(m.kind === 'insertion' ? text === '' : text.length > 0);
  }
  assert.equal(page.keptAsText, 0);
});

test('a mark says who made it and when, where its attributes say', () => {
  const page = convert('A {author="librarian" date="2026-03-04"==quiet==}{>>Check this.<<} bay. A {author="Ada"--loud --}gull.');
  assert.deepEqual(page.marks.map((m) => [m.kind, m.who, m.at]), [
    ['comment', 'librarian', '2026-03-04T00:00:00.000Z'],
    ['deletion', 'author', null],
  ]);
});

test('what cannot be a mark stays in the text as written and is counted', () => {
  const lone = 'A lone {>>note to self<<} here.';
  const ai = 'Some {=+machine words+=} here.';
  const empty = 'Nothing {----} here.';
  const page = convert([lone, ai, empty].join('\n\n'));
  assert.deepEqual(page.paragraphs, [lone, ai, empty]);
  assert.deepEqual(page.marks, []);
  assert.equal(page.keptAsText, 3);
});

test('a mark across two lines stays in the text, since a paragraph is one line', () => {
  const page = convert('One {==two\nthree==} four.');
  assert.deepEqual(page.paragraphs, ['One {==two', 'three==} four.']);
  assert.equal(page.keptAsText, 1);
});

test('a line that held only an insertion stays as an empty paragraph, so the mark has a place', () => {
  const page = convert('Before.\n\n{++A whole new line.++}\n\nAfter.');
  assert.deepEqual(page.paragraphs, ['Before.', '', 'After.']);
  assert.deepEqual(page.marks.map((m) => [m.kind, m.pIdx, m.off, m.proposed]), [['insertion', 1, 0, 'A whole new line.']]);
});

test('marks in code are code, not marks', () => {
  const page = convert('Use `{++x++}` like so.\n```\n{--y--}\n```');
  assert.deepEqual(page.paragraphs, ['Use {++x++} like so.', '{--y--}']);
  assert.deepEqual(page.marks, []);
});
