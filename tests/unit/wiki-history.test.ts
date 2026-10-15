// Rule: the wiki pane's history goes back and forward as a browser's does: a new page
// drops what was ahead, going back and forward moves along the trail without changing
// it, and the same page twice in a row is one stop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PageHistory } from '../../src/hoard/wiki/history.ts';

test('back and forward move along the trail, and a new page drops what was ahead', () => {
  const h = new PageHistory();
  assert.equal(h.current, null);
  assert.deepEqual([h.canBack, h.canForward], [false, false]);
  h.visit('a');
  h.visit('b');
  h.visit('c');
  assert.equal(h.back(), 'b');
  assert.equal(h.back(), 'a');
  assert.equal(h.back(), null, 'nothing before the first page');
  assert.equal(h.current, 'a');
  assert.equal(h.forward(), 'b');
  h.visit('d');
  assert.equal(h.forward(), null, 'c was dropped');
  assert.equal(h.back(), 'b');
  assert.deepEqual([h.canBack, h.canForward], [true, true]);
});

test('the same page twice in a row is one stop', () => {
  const h = new PageHistory();
  h.visit('a');
  h.visit('a');
  assert.equal(h.canBack, false);
});
