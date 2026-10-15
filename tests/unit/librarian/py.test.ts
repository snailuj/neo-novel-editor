import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  PyDate, byCodePoint, casefold, pyLen, pyRepr, pySlice, pyStr, pyStrip, sequenceRatio, splitlines,
} from '../../../src/librarian/py.ts';

const srcDir = fileURLToPath(new URL('../../../src/librarian/', import.meta.url));

test('splitlines breaks on every terminator Python does, and keeps them on request', () => {
  const text = 'a\nb\r\nc\rd\ve\ff\x1cg\x1dh\x1ei\x85j\u2028k\u2029l';
  assert.deepEqual(splitlines(text), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
  assert.deepEqual(splitlines('a\r\nb\n', true), ['a\r\n', 'b\n']);
  assert.deepEqual(splitlines(''), []);
  assert.deepEqual(splitlines('a\n\n'), ['a', '']);
  // \x1f is whitespace to Python but not a line break
  assert.deepEqual(splitlines('a\x1fb'), ['a\x1fb']);
});

test('strip uses Python whitespace: \\x1c is stripped and a byte order mark is not', () => {
  assert.equal(pyStrip('\x1c a \x1f'), 'a');
  assert.equal(pyStrip('\ufeffa'), '\ufeffa');
  assert.equal(pyStrip('xxaxx', 'x'), 'a');
  assert.equal(pyStrip('[[a]]', '[]'), 'a');
});

test('casefold folds sharp s and long s as Python does', () => {
  assert.equal(casefold('Straße'), 'strasse');
  assert.equal(casefold('ſ'), 's');
  assert.equal(casefold('ABC'), 'abc');
});

test('strings sort by code point, so an astral character follows U+FFFD', () => {
  const words = ['\u{1D518}', '\ufffd', 'a', 'B'];
  assert.deepEqual([...words].sort(byCodePoint), ['B', 'a', '\ufffd', '\u{1D518}']);
  assert.notDeepEqual([...words].sort(), [...words].sort(byCodePoint));
  assert.deepEqual(['ab', 'a'].sort(byCodePoint), ['a', 'ab']);
});

test('lengths and slices count code points', () => {
  assert.equal(pyLen('\u{1D518}x'), 2);
  assert.equal(pySlice('\u{1D518}xyz', 0, 2), '\u{1D518}x');
});

// Each ratio was printed by CPython's difflib.SequenceMatcher(None, a, b).ratio().
test('sequenceRatio matches difflib, autojunk included', () => {
  const cases: [string, string, number][] = [
    ['', '', 1.0],
    ['abc', '', 0.0],
    ['abcd', 'bcde', 0.75],
    ['collectiveagency', 'collectiveagencyy', 0.9696969696969697],
    ['moonharbour', 'moonharbor', 0.9523809523809523],
    ['harbourwatch', 'harborwatch', 0.9565217391304348],
    ['abcabcabc', 'abc', 0.5],
    ['kettle', 'settle', 0.8333333333333334],
    ['straße', 'strasse', 0.7692307692307693],
    ['\u{1D518}nicode', 'unicode', 0.8571428571428571],
    ['aaaaab'.repeat(40), 'aaaab'.repeat(45), 0.017204301075268817],
    ['x'.repeat(150) + 'y'.repeat(100), 'y'.repeat(100) + 'x'.repeat(150), 0.0],
  ];
  for (const [a, b, want] of cases) assert.equal(sequenceRatio(a, b), want, `${a.slice(0, 12)} / ${b.slice(0, 12)}`);
});

test('pyStr and pyRepr print values the way a finding printed them in Python', () => {
  assert.equal(pyStr('plain'), 'plain');
  assert.equal(pyStr(true), 'True');
  assert.equal(pyStr(null), 'None');
  assert.equal(pyStr(3), '3');
  assert.equal(pyStr(1.5), '1.5');
  assert.equal(pyStr(['a', "b'c"]), `['a', "b'c"]`);
  assert.equal(pyStr({ k: 'v' }), "{'k': 'v'}");
  assert.equal(pyStr(new PyDate('2026-10-15')), '2026-10-15');
  assert.equal(pyRepr(new PyDate('2026-1-5')), 'datetime.date(2026, 1, 5)');
  assert.equal(pyStr(new PyDate('2026-10-15T10:00:00Z')), '2026-10-15 10:00:00Z');
});

// The checks are pure over text: disk, the clock and git arrive as arguments. Only the
// command line and the vault reader may reach for them.
test('no librarian module but the command line and vault reader touches disk, clock or processes', () => {
  const allowed = new Set(['cli.ts', 'vault-fs.ts']);
  const forbidden = /from 'node:(?:fs|fs\/promises|child_process)'|Date\.now\(|new Date\(\)/;
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !allowed.has(f));
  assert.ok(files.includes('py.ts'), 'the guard must see the modules it guards');
  for (const file of files) {
    assert.doesNotMatch(readFileSync(path.join(srcDir, file), 'utf8'), forbidden, file);
  }
});
