// Rules for the marks and verdict requests from the window: a request names its place
// either as a chapter ({bookId, chId}) or as a page ({page}), never both and never
// neither; and a librarian's verdict on a page's suggestion lands in that page's sidecar.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  validateHoardMarksAddV1, validateHoardMarksListV1, validateHoardMarksReplyV1, validateHoardMarksStateV1, validateHoardReviewVerdictV1,
} from '../../src/generated/validators.cjs';
import { MarkStore, pageSidecarPath } from '../../src/hoard/marks/store.ts';
import { startReview } from '../../src/hoard/review/main.ts';
import { tempDir } from './git-support.ts';

const anchor = { exact: 'boats', prefix: 'counted the ', suffix: ' twice.', pIdx: 1, off: 17 };
const chapter = { bookId: 'book-fox-1', chId: 'c1' };
const page = 'wiki/People/Harbour.html';

const requests: [string, (d: unknown) => boolean, Record<string, unknown>][] = [
  ['marks.add', validateHoardMarksAddV1, { kind: 'comment', anchor, body: 'Which?' }],
  ['marks.reply', validateHoardMarksReplyV1, { markId: 'm-1', body: 'Here.' }],
  ['marks.state', validateHoardMarksStateV1, { markId: 'm-1', state: 'resolved' }],
  ['review.verdict', validateHoardReviewVerdictV1, { markId: 'm-1', state: 'accepted' }],
  ['marks.list', validateHoardMarksListV1, {}],
];

test('every marks request names a chapter or a page, never both, never neither, never half a chapter', () => {
  for (const [name, valid, rest] of requests) {
    const list = name === 'marks.list';
    assert.ok(valid(list ? { bookId: chapter.bookId } : { ...chapter, ...rest }), `${name} takes a chapter`);
    assert.ok(valid({ page, ...rest }), `${name} takes a page`);
    assert.ok(valid({ page: 'sources/Notes/Tides.html', ...rest }), `${name} takes a sources page`);
    assert.ok(!valid({ ...rest }), `${name} needs a place`);
    assert.ok(!valid({ page, bookId: chapter.bookId, ...rest }), `${name} refuses a page with a book`);
    assert.ok(!valid({ page, ...chapter, ...rest }), `${name} refuses a page with a chapter`);
    assert.ok(!valid({ page: '', ...rest }), `${name} refuses an empty page`);
    assert.ok(!valid({ page: 'notes/x.html', ...rest }), `${name} refuses a page outside the two trees`);
    if (!list) assert.ok(!valid({ bookId: chapter.bookId, ...rest }), `${name} refuses a book with no chapter`);
  }
});

test('a verdict on a page\'s suggestion is signed by the librarian and written to the page\'s sidecar', async (t) => {
  const library = tempDir(t);
  mkdirSync(path.dirname(path.join(library, page)), { recursive: true });
  writeFileSync(path.join(library, page), '<p>The wall.</p>');
  const store = new MarkStore({ library: () => library, log: () => {} });
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const host = { handle: (name: string, fn: (payload: unknown) => unknown) => handlers.set(name, fn), log: () => {}, paths: { library: () => library } };
  startReview(host as never, store, { layer: {} as never, wiki: {} as never, pages: {} as never });
  const made = await store.add({ page, kind: 'substitution', anchor, proposed: 'vessels' }, 'author');
  await handlers.get('review.verdict')!({ page, markId: made.id, state: 'flagged', reason: 'Not there.' });
  const saved = JSON.parse(readFileSync(pageSidecarPath(library, page), 'utf8')) as { marks: { history: { state: string; who: string }[]; thread: { who: string; body: string }[] }[] };
  assert.deepEqual(saved.marks[0].history.at(-1), { ...saved.marks[0].history.at(-1), state: 'flagged', who: 'librarian' });
  assert.equal(saved.marks[0].thread.at(-1)?.body, 'Not there.');
  assert.equal(existsSync(path.join(library, '.neo', 'book-fox-1')), false);
});
