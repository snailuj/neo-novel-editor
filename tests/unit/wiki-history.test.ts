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

// Rule: after a page is renamed, every stop of the trail that named it names the new id,
// the place in the trail is kept, and two stops that now name one page side by side are one.
test('a rename moves every stop of the old id to the new id, in place', () => {
  const h = new PageHistory();
  h.visit('wiki/Old.html');
  h.visit('ch-1');
  h.visit('wiki/Old.html');
  h.visit('sources/Other.html');
  h.back();
  h.rename('wiki/Old.html', 'wiki/Folder/New.html');
  assert.equal(h.current, 'wiki/Folder/New.html');
  assert.equal(h.forward(), 'sources/Other.html');
  assert.equal(h.back(), 'wiki/Folder/New.html');
  assert.equal(h.back(), 'ch-1');
  assert.equal(h.back(), 'wiki/Folder/New.html');
  assert.equal(h.canBack, false);
});

test('a rename onto the stop beside it leaves one stop', () => {
  const h = new PageHistory();
  h.visit('wiki/A.html');
  h.visit('wiki/B.html');
  h.visit('ch-1');
  h.rename('wiki/A.html', 'wiki/B.html');
  assert.equal(h.current, 'ch-1');
  assert.equal(h.back(), 'wiki/B.html');
  assert.equal(h.canBack, false, 'A and B were one page after the rename');
  h.rename('ch-9', 'ch-10');
  assert.equal(h.current, 'wiki/B.html', 'a rename of an id not on the trail changes nothing');
});
