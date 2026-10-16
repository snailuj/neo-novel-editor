// Ported from hoard's tests/test_frontmatter.py (read side). The write primitive
// (set_key, write_key, join) stays in hoard: nothing in Neo writes YAML.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FrontmatterError, bodyOffset, keyRange, locateFrontmatter, split,
} from '../../../src/librarian/frontmatter.ts';
import { PyDate, splitlines } from '../../../src/librarian/py.ts';

const DOC = '---\ntype: writing\nproject: path\n---\nThe kettle sang low.\n';

test('split returns the mapping and the exact body', () => {
  const { fm, body } = split(DOC);
  assert.deepEqual(fm, { type: 'writing', project: 'path' });
  assert.equal(body, 'The kettle sang low.\n');
});

test('split without frontmatter returns null and the full text', () => {
  const { fm, body } = split('Just prose.\n');
  assert.equal(fm, null);
  assert.equal(body, 'Just prose.\n');
});

test('split of malformed YAML throws a FrontmatterError', () => {
  assert.throws(() => split('---\n: : :\n---\nbody\n'), FrontmatterError);
});

test('split of a block that is not a mapping throws', () => {
  assert.throws(() => split('---\n- a\n- b\n---\nbody\n'), /not a mapping/);
});

test('split of frontmatter alone gives an empty body', () => {
  const { fm, body } = split('---\ntype: meta\n---\n');
  assert.deepEqual(fm, { type: 'meta' });
  assert.equal(body, '');
});

test('an unterminated block is no frontmatter, and its offset is zero', () => {
  const doc = '---\ntype: meta\nbody with no close\n';
  assert.deepEqual(split(doc), { fm: null, body: doc });
  assert.equal(bodyOffset(doc), 0);
});

// Body line N is FILE line N + offset, so lint findings can be clicked.
test('bodyOffset counts the frontmatter block', () => {
  const doc = '---\ntype: lore\nsetting: era/harbour\n---\nfirst body line\n';
  assert.equal(bodyOffset(doc), 4);
  const { body } = split(doc);
  assert.equal(splitlines(body)[0], 'first body line');
  assert.equal(splitlines(doc)[bodyOffset(doc)], 'first body line');
});

test('bodyOffset is zero without frontmatter', () => {
  assert.equal(bodyOffset('bare prose, no metadata\n'), 0);
});

// PyYAML's safe_load is YAML 1.1 and keeps the last of two keys; the port reads the same.
test('frontmatter reads as PyYAML reads it', () => {
  const { fm } = split('---\nflag: yes\ncreated: 2026-10-15\nkey: 1\nkey: 2\nempty:\n---\n');
  assert.equal(fm!['flag'], true);
  assert.ok(fm!['created'] instanceof PyDate);
  assert.equal(String(fm!['created']), '2026-10-15');
  assert.equal(fm!['key'], 2);
  assert.equal(fm!['empty'], null);
});

test('an empty block is an empty mapping read as null, as PyYAML loads it', () => {
  assert.deepEqual(split('---\n\n---\nbody\n'), { fm: null, body: 'body\n' });
});

test('the CRLF-safe locator finds the closing delimiter by line', () => {
  const lines = splitlines('---\r\ntype: meta\r\n---\r\nbody\r\n', true);
  assert.equal(locateFrontmatter(lines), 2);
  assert.equal(locateFrontmatter(splitlines('no block\n', true)), null);
  assert.equal(locateFrontmatter([]), null);
});

test('keyRange spans a key and its continuation lines, up to the next top-level key', () => {
  const fm = ['type: lore\n', 'topics:\n', '  - "[[a]]"\n', '- "[[b]]"\n', 'tags: [x]\n'];
  assert.deepEqual(keyRange(fm, 'topics'), [1, 4]);
  assert.deepEqual(keyRange(fm, 'tags'), [4, 5]);
  assert.equal(keyRange(fm, 'aliases'), null);
});
