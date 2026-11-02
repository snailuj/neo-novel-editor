// Rule Verdict-Names-Its-Page: when the page shown names itself by a page id
// (ReviewedPage.target), the review's verdicts and the writer's decisions are sent for
// that page, whatever book is open; with no target, as before, they name book and chapter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { anchorAt } from '../../src/hoard/marks/anchor.ts';
import { newMark } from '../../src/hoard/marks/model.ts';
import { reviewFlow, type ReviewedPage } from '../../src/hoard/review/flow.ts';

const TEXT = ['The harbour of Vell faces west.'];
const ID = 'wiki/People/Orrin.html';
const mark = newMark({ id: 'm-1', kind: 'substitution', anchor: anchorAt(TEXT, { pIdx: 0, off: 26, len: 4 }), proposed: 'east', who: 'author', at: '2026-10-15T21:00:00.000Z' });

function setup(shown: Partial<ReviewedPage>) {
  const sent: { channel: string; payload: Record<string, unknown> }[] = [];
  const neo = { invoke: async (channel: string, payload: unknown) => { sent.push({ channel, payload: payload as Record<string, unknown> }); return { marks: [] as Mark[] }; } };
  const page: ReviewedPage = {
    bookId: () => null,
    paragraphs: () => TEXT,
    marksOf: () => [mark],
    isLibrarians: () => true,
    applyAsLibrarian: async () => null,
    applyAsWriter: async () => null,
    settle: () => {},
    tell: () => {},
    warn: () => {},
    relist: () => {},
    ...shown,
  };
  return { sent, flow: reviewFlow(neo as never, () => ({ get: () => 'any' }), page) };
}

test('Verdict-Names-Its-Page: a page with a target gets its verdict and its decision by page id, with no book open', async () => {
  const { sent, flow } = setup({ target: () => ({ page: ID }) });
  await flow.review(ID, 'm-1');
  await flow.decide(ID, 'm-1', 'rejected');
  assert.deepEqual(sent, [
    { channel: 'review.verdict', payload: { page: ID, markId: 'm-1', state: 'accepted' } },
    { channel: 'marks.state', payload: { page: ID, markId: 'm-1', state: 'rejected' } },
  ]);
});

test('Verdict-Names-Its-Page: with no target, a chapter is named by its book and chapter as before', async () => {
  const { sent, flow } = setup({ bookId: () => 'book-fox-1' });
  await flow.review('c1', 'm-1');
  await flow.decide('c1', 'm-1', 'rejected');
  assert.deepEqual(sent, [
    { channel: 'review.verdict', payload: { bookId: 'book-fox-1', chId: 'c1', markId: 'm-1', state: 'accepted' } },
    { channel: 'marks.state', payload: { bookId: 'book-fox-1', chId: 'c1', markId: 'm-1', state: 'rejected' } },
  ]);
});

test('Verdict-Names-Its-Page: with no book and no target, nothing is sent', async () => {
  const { sent, flow } = setup({});
  await flow.review('c1', 'm-1');
  await flow.decide('c1', 'm-1', 'rejected');
  assert.deepEqual(sent, []);
});
