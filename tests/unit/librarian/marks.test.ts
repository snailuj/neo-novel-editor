// Ported from hoard's tests/test_marks.py: the CriticMarkup parser the lint and quote
// checks share. Six mark forms, an optional key="value" prefix inside the opening brace,
// no nesting (an inner mark is the outer one's content), no escaping (a malformed mark is
// literal prose), and code regions skipped whole. Every fixture is synthetic.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { captureLogs } from '../../../src/librarian/log.ts';
import type { LogRecord } from '../../../src/librarian/log.ts';
import {
  WARNED, findMarks, librarianMask, malformed, mask, maskChrome, markAt, resolve, stripMarks,
} from '../../../src/librarian/marks.ts';
import type { Mark } from '../../../src/librarian/marks.ts';

// The repeated-key warning is logged once per process per mark, so each test starts
// from an empty memo or it would see none.
beforeEach(() => WARNED.clear());

function only(text: string): Mark {
  const found = findMarks(text);
  assert.equal(found.length, 1, text);
  return found[0]!;
}

test('a prefix-free insertion parses', () => {
  const text = 'Lorem ipsum{++ sit++} amet.';
  const mark = only(text);
  assert.equal(mark.kind, 'insertion');
  assert.equal(mark.proposedText, ' sit');
  assert.equal(mark.authorText, '');
  assert.deepEqual(mark.attrs, {});
  assert.equal(text.slice(mark.start, mark.end), '{++ sit++}');
});

test('an insertion with an attribute prefix parses', () => {
  const mark = only('Lorem{author="Claude" date="2026-06-14"++ ipsum++} dolor.');
  assert.equal(mark.kind, 'insertion');
  assert.equal(mark.proposedText, ' ipsum');
  assert.deepEqual(mark.attrs, { author: 'Claude', date: '2026-06-14' });
});

test("a deletion's content is author text", () => {
  const mark = only('Lorem{-- ipsum--} dolor.');
  assert.equal(mark.kind, 'deletion');
  assert.equal(mark.authorText, ' ipsum');
  assert.equal(mark.proposedText, '');
});

test('a substitution splits old from new', () => {
  const mark = only('Lorem {author="Claude"~~hipsum~>ipsum~~} dolor.');
  assert.equal(mark.kind, 'substitution');
  assert.equal(mark.authorText, 'hipsum');
  assert.equal(mark.proposedText, 'ipsum');
});

test("a highlight's content is author text", () => {
  const mark = only('{==Vestibulum at orci magna.==}');
  assert.equal(mark.kind, 'highlight');
  assert.equal(mark.authorText, 'Vestibulum at orci magna.');
});

test("a comment's content is comment text", () => {
  const mark = only('{author="Claude">>a comment<<}');
  assert.equal(mark.kind, 'comment');
  assert.equal(mark.commentText, 'a comment');
  assert.equal(mark.authorText, '');
});

test('an AI text mark parses', () => {
  const mark = only('{=+drafted clause+=}');
  assert.equal(mark.kind, 'ai');
  assert.equal(mark.proposedText, 'drafted clause');
});

test('a highlight-anchored comment is an adjacent pair', () => {
  const [anchor, comment] = findMarks('{==confusing span==}{author="Claude">>why?<<}');
  assert.equal(anchor!.kind, 'highlight');
  assert.equal(comment!.kind, 'comment');
  assert.equal(anchor!.end, comment!.start);
});

test('a mark may wrap a line inside a paragraph', () => {
  assert.equal(only('Prose before {--first line\nsecond line--} and after.\n').authorText, 'first line\nsecond line');
});

test('a candidate crossing a blank line is prose', () => {
  assert.deepEqual(findMarks('Prose {--start of it\n\nnext paragraph--} tail.\n'), []);
});

test('an inner mark is content, not a mark', () => {
  const mark = only('{++outer {--inner--} text++}');
  assert.equal(mark.kind, 'insertion');
  assert.equal(mark.proposedText, 'outer {--inner--} text');
  assert.equal(mark.nested, true);
});

test('an opener inside inline code is ignored', () => {
  assert.deepEqual(findMarks('Write `{++x++}` to insert.'), []);
});

test('an opener inside a fenced block is ignored', () => {
  assert.deepEqual(findMarks('Prose.\n\n```\n{++x++}\n```\n\nMore prose.\n'), []);
});

test('a Tandem Comments block is ignored', () => {
  assert.deepEqual(findMarks('Prose.\n\n```tandem-comments\n{\n  "a1f3": {"text": "{++x++}"}\n}\n```\n'), []);
});

test('a Tandem block with trailing footnotes is still ignored', () => {
  const text = 'Prose.\n\n```tandem-comments\n{"a1f3": {"text": "{--y--}"}}\n```\n'
    + '\n[^1]: a footnote definition Obsidian appended.\n';
  assert.deepEqual(findMarks(text), []);
});

test('resolve accept keeps insertions and drops deletions', () => {
  assert.equal(resolve('Lorem{++ sit++} ipsum{-- dolor--} amet{>>note<<}.', 'accept'), 'Lorem sit ipsum amet.');
});

test('resolve reject is the inverse', () => {
  assert.equal(resolve('Lorem{++ sit++} ipsum{-- dolor--} amet{>>note<<}.', 'reject'), 'Lorem ipsum dolor amet.');
});

test('a substitution resolves to new on accept and old on reject', () => {
  const text = 'Lorem {~~hipsum~>ipsum~~} dolor.';
  assert.equal(resolve(text, 'accept'), 'Lorem ipsum dolor.');
  assert.equal(resolve(text, 'reject'), 'Lorem hipsum dolor.');
});

test('resolve strips a highlight wrapper in both modes', () => {
  assert.equal(resolve('{==kept prose==}', 'accept'), 'kept prose');
  assert.equal(resolve('{==kept prose==}', 'reject'), 'kept prose');
});

test('an unknown mode is refused', () => {
  assert.throws(() => resolve('x', 'maybe' as 'accept'), /mode must be one of/);
});

test('stripMarks is reject', () => {
  const text = 'Lorem{++ sit++} ipsum{-- dolor--}.';
  assert.equal(stripMarks(text), resolve(text, 'reject'));
});

test('mask preserves length and newlines', () => {
  const text = 'Lorem {--a\nb--} ipsum{++ sit++}.\n';
  for (const mode of ['accept', 'reject'] as const) {
    const masked = mask(text, mode);
    assert.equal(masked.length, text.length);
    assert.equal(masked.split('\n').length, text.split('\n').length);
  }
});

test('mask accept blanks deleted words and keeps inserted ones', () => {
  const masked = mask('Lorem{-- dolor--}{++ sit++}.', 'accept');
  assert.ok(!masked.includes('dolor'));
  assert.ok(masked.includes(' sit'));
});

test('librarianMask keeps proposals and comments and blanks author bytes', () => {
  const text = 'Lorem{-- dolor--}{++ sit++}{>>why<<}.';
  const masked = librarianMask(text);
  assert.ok(!masked.includes('dolor'));
  assert.ok(masked.includes(' sit') && masked.includes('why'));
  assert.equal(masked.length, text.length);
});

test('maskChrome keeps every content word', () => {
  const text = 'Lorem {author="Claude"~~hipsum~>ipsum~~} dolor.';
  const masked = maskChrome(text);
  assert.ok(masked.includes('hipsum') && masked.includes('ipsum'));
  assert.ok(!masked.includes('Claude')); // the prefix is chrome, and its quotes with it
  assert.equal(masked.length, text.length);
});

test('markAt finds the mark covering a position', () => {
  const text = 'Lorem {++sit++} amet.';
  assert.equal(markAt(text, 8)?.kind, 'insertion');
  assert.equal(markAt(text, 0), null);
});

test('an unclosed opener is reported as malformed', () => {
  const bad = malformed('Prose.\n\nA line with {++ no close on it.\n\nMore prose.\n');
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.lineno, 3);
  assert.equal(bad[0]!.opener, '{++');
});

test('a broken attribute prefix is reported as malformed', () => {
  const bad = malformed('A line {author="Claude++x++} here.\n');
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.lineno, 1);
});

test('a well-formed mark is not malformed', () => {
  assert.deepEqual(malformed('{author="Claude" date="2026-06-14"++x++}'), []);
});

test('a brace in ordinary prose is not a candidate', () => {
  assert.deepEqual(malformed('The set {a, b} and the field {key=value}.'), []);
  assert.deepEqual(findMarks('The set {a, b}.'), []);
});

// Each of the six forms parses the same with and without an attribute prefix.
const SIX_FORMS: [Mark['kind'], string, 'proposedText' | 'authorText' | 'commentText'][] = [
  ['insertion', '{++body++}', 'proposedText'],
  ['deletion', '{--body--}', 'authorText'],
  ['substitution', '{~~body~>new~~}', 'authorText'],
  ['highlight', '{==body==}', 'authorText'],
  ['comment', '{>>body<<}', 'commentText'],
  ['ai', '{=+body+=}', 'proposedText'],
];
const PREFIX = 'author="Claude" date="2026-06-14"';

test('every form parses prefixed and prefix-free', () => {
  for (const [kind, raw, slot] of SIX_FORMS) {
    for (const prefixed of [false, true]) {
      const text = `Prose ${prefixed ? `{${PREFIX}${raw.slice(1)}` : raw} tail.`;
      const mark = only(text);
      assert.equal(mark.kind, kind, text);
      assert.equal(mark[slot], 'body', text);
      assert.deepEqual(mark.attrs, prefixed ? { author: 'Claude', date: '2026-06-14' } : {}, text);
      assert.ok(text.slice(mark.start, mark.end).endsWith(raw.slice(-3)), text);
    }
  }
});

// The reject reading of every form and of each non-mark case, which a guard comparing
// stripMarks over an author region relies on.
test('stripMarks pins the reject reading of all six forms', () => {
  assert.equal(stripMarks('a {++new++}b'), 'a b');
  assert.equal(stripMarks('a {--gone--}b'), 'a goneb');
  assert.equal(stripMarks('a {~~old~>new~~}b'), 'a oldb');
  assert.equal(stripMarks('a {==lit==}b'), 'a litb');
  assert.equal(stripMarks('a {>>note<<}b'), 'a b');
  assert.equal(stripMarks('a {=+drafted+=}b'), 'a b');
});

test('stripMarks accepts the attribute prefix', () => {
  assert.equal(stripMarks('a {author="Claude" date="2026-09-22"++new++}b'), 'a b');
  assert.equal(stripMarks('a {date="2026-09-22"~~old~>new~~}b'), 'a oldb');
});

test('stripMarks leaves code and malformed candidates alone', () => {
  assert.equal(stripMarks('use `{++x++}` here'), 'use `{++x++}` here');
  assert.equal(stripMarks('```\n{++x++}\n```\n'), '```\n{++x++}\n```\n');
  assert.equal(stripMarks('{++one\n\ntwo++}'), '{++one\n\ntwo++}');
  assert.equal(stripMarks('a { not a mark'), 'a { not a mark');
});

test('stripMarks treats a nested mark as content', () => {
  assert.equal(stripMarks('a {--x {>>y<<} z--}b'), 'a x {>>y<<} zb');
});

// Paragraph breaks are a fact about the raw text: masking blanks a line that is only
// inline code to spaces, which must not read as a blank line.
test('a mark may wrap over a line that is only inline code', () => {
  const text = 'Prose {--foo\n`bar`\nbaz--} tail.\n';
  const mark = only(text);
  assert.equal(mark.kind, 'deletion');
  assert.equal(mark.authorText, 'foo\n`bar`\nbaz');
  assert.deepEqual(malformed(text), []);
});

test('a mark still may not cross a real blank line beside code', () => {
  assert.deepEqual(findMarks('Prose {--foo\n`bar`\n\nbaz--} tail.\n'), []);
});

// A blank line is a blank line under either terminator.
test('a candidate crossing a blank line is prose under CRLF and whitespace', () => {
  for (const text of ['Prose {--a\r\n\r\nb--} tail.\r\n', 'Prose {--a\r\n \t\r\nb--} tail.\r\n',
    'Prose {--a\n \t\nb--} tail.\n']) {
    assert.deepEqual(findMarks(text), [], JSON.stringify(text));
    assert.equal(malformed(text).length, 1, JSON.stringify(text));
  }
});

test('a mark may wrap a CRLF line inside a paragraph', () => {
  assert.equal(only('Prose {--first\r\nsecond--} tail.\r\n').authorText, 'first\r\nsecond');
});

// Fail closed: when the first occurrence won, `author="Ada" author="Bram"` read as Ada.
test('a key given more than once is dropped as ambiguous', () => {
  for (const text of ['{Author="Ada" author="Bram">>c<<}', '{author="Ada" author="Bram">>c<<}',
    '{author="" author="Ada">>c<<}']) {
    assert.ok(!('author' in only(text).attrs), text);
  }
  assert.deepEqual(only('{author="Ada" date="d">>c<<}').attrs, { author: 'Ada', date: 'd' });
});

function repeatWarnings(records: LogRecord[]): LogRecord[] {
  return records.filter((r) => r.logger === 'librarian.marks' && r.level === 'warning'
    && r.message.includes('given more than once'));
}

test('a repeated key is logged', () => {
  const { records } = captureLogs(() => findMarks('{author="Ada" Author="Bram">>c<<}'));
  assert.equal(repeatWarnings(records).length, 1);
});

// One pass parses a page several times; the anomaly is one fact about one mark.
test('a repeated key is logged once per mark', () => {
  const { records } = captureLogs(() => {
    for (let i = 0; i < 4; i++) findMarks('{date="a" Date="b">>once<<}');
  });
  assert.equal(repeatWarnings(records).length, 1);
});

test('a second distinct offending mark is logged too', () => {
  const { records } = captureLogs(() => {
    for (let i = 0; i < 2; i++) {
      findMarks('{date="a" Date="b">>one<<}');
      findMarks('{author="a" author="b">>two<<}');
    }
  });
  assert.equal(repeatWarnings(records).length, 2);
});

// The scan's stated bound: a candidate costs a search bounded by its paragraph, so
// unclosed openers in one long paragraph stay far from quadratic in the whole text.
test('a long paragraph of unclosed openers is scanned in bounded time', () => {
  const text = `${'{++ word '.repeat(2000)}\n\n${'tail '.repeat(20000)}`;
  const start = performance.now();
  assert.equal(malformed(text).length, 2000);
  assert.ok(performance.now() - start < 2000, `took ${performance.now() - start} ms`);
});
