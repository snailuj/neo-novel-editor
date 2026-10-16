// Rule: the findings box names every file with a finding, and every file held out of
// history, however many there are; a long list is cut with a count of what is left.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFindings, type Finding } from '../../src/hoard/git/gate.ts';

const finding = (n: number): Finding => ({ path: `book-wiki-1/chapters/ch-${n}.html`, rule: 'Block-Ids-Citable', message: `block id 'b ${n}' cannot be cited` });

test('with nothing found the box says so', () => {
  assert.deepEqual(describeFindings([], []), {
    message: 'No file committed since NEO started has a finding.',
    detail: 'NEO checks the wiki\'s pages and hoard\'s files each time it commits.',
  });
});

test('each finding is a line, and held files come first', () => {
  const box = describeFindings([finding(1), finding(2)], ['book-wiki-1/chapters/ch-3.html']);
  assert.equal(box.message, '2 findings, and 1 librarian edit held out of history until it is fixed.');
  assert.deepEqual(box.detail.split('\n'), [
    'Held out of history:',
    'book-wiki-1/chapters/ch-3.html',
    '',
    "book-wiki-1/chapters/ch-1.html: block id 'b 1' cannot be cited",
    "book-wiki-1/chapters/ch-2.html: block id 'b 2' cannot be cited",
  ]);
});

test('a long list is cut at twenty lines, with a count of the rest', () => {
  const box = describeFindings(Array.from({ length: 25 }, (_, i) => finding(i)), []);
  assert.equal(box.message, '25 findings.');
  const lines = box.detail.split('\n');
  assert.equal(lines.length, 21);
  assert.equal(lines.at(-1), 'and 5 more, in neo-errors.log.');
});
