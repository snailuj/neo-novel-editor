// Rules for bringing a Markdown page in: the page's words arrive as written, one
// paragraph per line, with the Markdown left as text; the frontmatter is handed back
// apart from the words; and each CriticMarkup mark becomes a mark on the words it was
// about, the text reading as if every mark were rejected. Whatever cannot be a mark
// stays in the text, so no word is lost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrontmatterError } from '../../src/librarian/frontmatter.ts';
import { convertPage } from '../../src/hoard/wiki/convert.ts';

test('each non-blank line is a paragraph, with its Markdown kept as text and its HTML escaped', () => {
  const page = convertPage('# Harbour\n\nThe **old** quay & the <new> one.\n- [[Tide Tables|tides]]\n\n\n| a | b |\n');
  assert.deepEqual(page.paragraphs, ['# Harbour', 'The **old** quay & the <new> one.', '- [[Tide Tables|tides]]', '| a | b |']);
  assert.equal(page.html, '<p># Harbour</p><p>The **old** quay &amp; the &lt;new&gt; one.</p><p>- [[Tide Tables|tides]]</p><p>| a | b |</p>');
  assert.equal(page.frontmatter, null);
  assert.deepEqual(page.marks, []);
});

test('inside a code fence every line is kept, a blank one as an empty paragraph', () => {
  const page = convertPage('Before\n\n```\nfirst\n\n  second\n```\nAfter\n');
  assert.deepEqual(page.paragraphs, ['Before', '```', 'first', '', '  second', '```', 'After']);
  assert.equal(page.html, '<p>Before</p><p>```</p><p>first</p><p><br></p><p>  second</p><p>```</p><p>After</p>');
});

test('CRLF line ends and a byte-order mark read as plain lines', () => {
  assert.deepEqual(convertPage('﻿One\r\nTwo\r\n').paragraphs, ['One', 'Two']);
});

test('an empty page is one empty paragraph', () => {
  const page = convertPage('');
  assert.deepEqual(page.paragraphs, ['']);
  assert.equal(page.html, '<p><br></p>');
});

test('frontmatter is handed back apart from the words, a date as it was written', () => {
  const page = convertPage('---\ntype: lore\ncreated: 2026-01-02\ntags: [sea, salt]\n---\nBody line.\n');
  assert.deepEqual(page.frontmatter, { type: 'lore', created: '2026-01-02', tags: ['sea', 'salt'] });
  assert.deepEqual(page.paragraphs, ['Body line.']);
});

test('frontmatter that does not read stops the page', () => {
  assert.throws(() => convertPage('---\ntype: [lore\n---\nBody.\n'), FrontmatterError);
});

test('each kind of mark lands on the words it was about, the text reading as rejected', () => {
  const page = convertPage([
    'The {++grey ++}gulls {--always --}cried.',
    'A {~~boat~>ship~~} sailed {==at dawn==}.',
    'She {==waited==}{>>For whom?<<} there.',
    'He {~~ran~>fled~~}{>>Stronger.<<} home.',
  ].join('\n'));
  assert.deepEqual(page.paragraphs, ['The gulls always cried.', 'A boat sailed at dawn.', 'She waited there.', 'He ran home.']);
  const shape = page.marks.map(({ kind, pIdx, off, len, proposed, body }) => ({ kind, pIdx, off, len, proposed, body }));
  assert.deepEqual(shape, [
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
  const page = convertPage('A {author="librarian" date="2026-03-04"==quiet==}{>>Check this.<<} bay. A {author="Julian"--loud --}gull.');
  assert.deepEqual(page.marks.map((m) => [m.kind, m.who, m.at]), [
    ['comment', 'librarian', '2026-03-04T00:00:00.000Z'],
    ['deletion', 'author', null],
  ]);
});

test('what cannot be a mark stays in the text as written and is counted', () => {
  const lone = 'A lone {>>note to self<<} here.';
  const ai = 'Some {=+machine words+=} here.';
  const empty = 'Nothing {----} here.';
  const page = convertPage([lone, ai, empty].join('\n\n'));
  assert.deepEqual(page.paragraphs, [lone, ai, empty]);
  assert.deepEqual(page.marks, []);
  assert.equal(page.keptAsText, 3);
});

test('a mark across two lines stays in the text, since a paragraph is one line', () => {
  const page = convertPage('One {==two\nthree==} four.');
  assert.deepEqual(page.paragraphs, ['One {==two', 'three==} four.']);
  assert.equal(page.keptAsText, 1);
});

test('a line that held only an insertion stays as an empty paragraph, so the mark has a place', () => {
  const page = convertPage('Before.\n\n{++A whole new line.++}\n\nAfter.');
  assert.deepEqual(page.paragraphs, ['Before.', '', 'After.']);
  assert.deepEqual(page.marks.map((m) => [m.kind, m.pIdx, m.off, m.proposed]), [['insertion', 1, 0, 'A whole new line.']]);
});

test('marks in code are code, not marks', () => {
  const page = convertPage('Use `{++x++}` like so.\n```\n{--y--}\n```');
  assert.deepEqual(page.paragraphs, ['Use `{++x++}` like so.', '```', '{--y--}', '```']);
  assert.deepEqual(page.marks, []);
});

test('a fence left open runs to the end of the page, and the final newline adds no paragraph', () => {
  assert.deepEqual(convertPage('Intro\n```\ncode\n').paragraphs, ['Intro', '```', 'code']);
});
