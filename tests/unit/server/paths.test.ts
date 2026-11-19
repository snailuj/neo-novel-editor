// Rule: a path the server accepts names one file inside the library on every host
// filesystem the server may run on, and a path that could not (traversal, git
// internals, Windows-illegal names, non-NFC text) is refused before it touches disk.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../../../server/errors.ts';
import { checkPath, foldKey, TEMP_PREFIX } from '../../../server/paths.ts';

const refused: Array<[string, string]> = [
  ['empty', ''],
  ['leading slash', '/wiki/place.html'],
  ['trailing slash', 'wiki/'],
  ['backslash', 'wiki\\place.html'],
  ['NUL', 'wiki/pla\u0000ce.html'],
  ['control character', 'wiki/pla\nce.html'],
  ['DEL', 'wiki/pla\u007fce.html'],
  ['empty segment', 'wiki//place.html'],
  ['dot segment', 'wiki/./place.html'],
  ['dot-dot segment', 'wiki/../place.html'],
  ['dot-dot first', '../place.html'],
  ['.git segment', '.git/config'],
  ['.git nested, any case', 'wiki/.GiT/config'],
  ['not NFC', 'wiki/café.html'],
  ['angle bracket', 'wiki/a<b.html'],
  ['colon', 'wiki/a:b.html'],
  ['quote', 'wiki/a"b.html'],
  ['pipe', 'wiki/a|b.html'],
  ['question mark', 'wiki/a?b.html'],
  ['asterisk', 'wiki/a*b.html'],
  ['segment ends in dot', 'wiki./place.html'],
  ['segment ends in space', 'wiki/place.html '],
  ['reserved CON', 'wiki/CON'],
  ['reserved with extension', 'wiki/nul.html'],
  ['reserved mixed case', 'book-1/Com3.txt'],
  ['reserved lpt9 directory', 'lpt9/place.html'],
  ['8.3 short name', 'book-1/CHAPTE~1.HTM'],
  ['8.3 short name in a folder', 'BOOK-1~2/one.html'],
  ['reserved CONIN$', 'wiki/CONIN$'],
  ['reserved CONOUT$ with extension', 'wiki/conout$.html'],
  ['segment over 255 UTF-16 units', `wiki/${'a'.repeat(252)}.html`],
  ['temp prefix', `wiki/${TEMP_PREFIX}1234`],
];

for (const [why, p] of refused) {
  test(`checkPath refuses ${why}`, () => {
    assert.throws(() => checkPath(p), (e: unknown) => e instanceof ApiError && e.code === 'bad_path' && e.status === 400);
  });
}

test('checkPath accepts ordinary library paths and returns them unchanged', () => {
  for (const p of [
    'library.json', 'book-1/chapters/one.html', 'wiki/place.html', '.neo/marks/one.json',
    'wiki/Café au lait.html', 'wiki/console.html', 'wiki/conx/y.html', 'a.b.c/d.e', `wiki/${'a'.repeat(250)}.html`, 'wiki/\ud83d\ude00.html',
  ]) assert.equal(checkPath(p), p);
});

test('foldKey makes paths that differ only by case or Unicode form equal', () => {
  assert.equal(foldKey('Wiki/Place.html'), foldKey('wiki/place.HTML'));
  assert.equal(foldKey('wiki/café.html'), foldKey('wiki/café.html'));
  assert.notEqual(foldKey('wiki/a.html'), foldKey('wiki/b.html'));
});

test('foldKey folds the Unicode case pairs a Windows or macOS disk treats as equal', () => {
  assert.equal(foldKey('wiki/\u0131.html'), foldKey('wiki/i.html'));
  assert.equal(foldKey('wiki/\u017f.html'), foldKey('wiki/s.html'));
});
