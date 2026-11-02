// Rule: when the library search fails, the status line names what was not searched for the
// scope asked: the pages for 'pages', the pages and the other books for 'all'.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notSearched } from '../../src/hoard/search/window.ts';

test('a failed library search names the pages for the pages scope and the pages and other books for everything', () => {
  assert.equal(notSearched('pages', 'worker died'), 'The wiki and sources pages were not searched: worker died');
  assert.equal(notSearched('all', 'worker died'), 'The wiki and sources pages and other books were not searched: worker died');
});
