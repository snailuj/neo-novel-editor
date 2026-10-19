// Rules for suggestions in the marks sidecars:
// - the writer's suggestion is stored with its proposed words, and an insertion with an
//   empty quote; the request schema lets nothing else through;
// - a review's verdict and its reason are one write, signed by whoever reviewed;
// - a withdrawn suggestion keeps its words in the file;
// - a change of state the mark's life does not allow is refused and writes nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import {
  validateHoardMarksAddV1, validateHoardMarksStateV1, validateHoardMarksV1, validateHoardReviewOwnersV1, validateHoardReviewVerdictV1,
} from '../../src/generated/validators.cjs';
import { MarkStore, sidecarPath } from '../../src/hoard/marks/store.ts';
import { tempDir } from './git-support.ts';

const ids = { bookId: 'book-wiki-1', chId: 'ch-vell' };
const anchor = { exact: 'west', prefix: 'The harbour of Vell faces ', suffix: '.', pIdx: 0, off: 26 };
const point = { exact: '', prefix: 'The harbour of Vell ', suffix: 'faces west.', pIdx: 0, off: 20 };

function storeFor(t: { after(fn: () => void): void }) {
  const library = tempDir(t);
  let n = 0;
  let clock = Date.parse('2026-10-15T21:00:00.000Z');
  const wrote: string[] = [];
  const store = new MarkStore({
    library: () => library,
    now: () => new Date((clock += 1000)),
    newId: (prefix) => `${prefix}-test${(n++).toString().padStart(3, '0')}`,
    wrote: (name) => wrote.push(name),
    log: () => {},
  });
  return { store, wrote, file: sidecarPath(library, ids.bookId, ids.chId) };
}

const onDisk = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { version: 1; marks: Mark[] };

test('the request schemas take the three suggestion kinds, and nothing looser', () => {
  const ok = (payload: unknown) => validateHoardMarksAddV1(payload);
  assert.ok(ok({ ...ids, kind: 'substitution', anchor, proposed: 'east' }));
  assert.ok(ok({ ...ids, kind: 'deletion', anchor }));
  assert.ok(ok({ ...ids, kind: 'insertion', anchor: point, proposed: 'still ' }));
  assert.ok(ok({ ...ids, kind: 'comment', anchor, body: 'Why?' }));
  assert.ok(!ok({ ...ids, kind: 'comment', anchor: point, body: 'Why?' }), 'an empty quote is for an insertion only');
  assert.ok(!ok({ ...ids, kind: 'substitution', anchor: point, proposed: 'x' }), 'an empty quote is for an insertion only');
  assert.ok(!ok({ ...ids, kind: 'stale', anchor }));
  assert.ok(!ok({ ...ids, kind: 'substitution', anchor, proposed: 'a\nb' }), 'a suggestion lies in one paragraph');
  assert.ok(validateHoardMarksStateV1({ ...ids, markId: 'm-x', state: 'rejected' }));
  assert.ok(validateHoardMarksStateV1({ ...ids, markId: 'm-x', state: 'accepted' }));
  assert.ok(!validateHoardMarksStateV1({ ...ids, markId: 'm-x', state: 'flagged' }), 'only the librarian flags');
  assert.ok(validateHoardReviewVerdictV1({ ...ids, markId: 'm-x', state: 'flagged', reason: 'Gone.' }));
  assert.ok(validateHoardReviewVerdictV1({ ...ids, markId: 'm-x', state: 'accepted' }));
  assert.ok(!validateHoardReviewVerdictV1({ ...ids, markId: 'm-x', state: 'flagged' }), 'a flag says why');
  assert.ok(!validateHoardReviewVerdictV1({ ...ids, markId: 'm-x', state: 'rejected' }), 'the librarian flags, it does not reject');
  assert.ok(validateHoardReviewOwnersV1({ bookId: 'book-wiki-1' }));
  assert.ok(!validateHoardReviewOwnersV1({}));
});

test('a suggestion is stored with its proposed words', async (t) => {
  const { store, file } = storeFor(t);
  await store.add({ ...ids, kind: 'substitution', anchor, proposed: 'east' }, 'author');
  await store.add({ ...ids, kind: 'insertion', anchor: point, proposed: 'still ' }, 'author');
  const saved = onDisk(file);
  assert.ok(validateHoardMarksV1(saved));
  assert.deepEqual(saved.marks.map((m) => [m.kind, m.anchor.exact, m.proposed, m.state, m.thread.length]),
    [['substitution', 'west', 'east', 'open', 0], ['insertion', '', 'still ', 'open', 0]]);
});

test('a flag and its reason are one write, signed by the librarian', async (t) => {
  const { store, wrote, file } = storeFor(t);
  const { id } = await store.add({ ...ids, kind: 'deletion', anchor }, 'author');
  wrote.length = 0;
  const answer = await store.review({ ...ids, markId: id, state: 'flagged' }, 'librarian', 'Another suggestion is waiting.');
  assert.deepEqual(wrote, ['.neo'], 'one write');
  const [mark] = onDisk(file).marks;
  assert.deepEqual(answer.marks, [mark]);
  assert.equal(mark.state, 'flagged');
  assert.deepEqual(mark.history.map((h) => [h.state, h.who]), [['flagged', 'librarian']]);
  assert.deepEqual(mark.thread.map((e) => [e.who, e.body]), [['librarian', 'Another suggestion is waiting.']]);
});

test('accepting and withdrawing keep the words, and say who', async (t) => {
  const { store, file } = storeFor(t);
  const a = await store.add({ ...ids, kind: 'substitution', anchor, proposed: 'east' }, 'author');
  const b = await store.add({ ...ids, kind: 'insertion', anchor: point, proposed: 'still ' }, 'author');
  await store.review({ ...ids, markId: a.id, state: 'accepted' }, 'librarian');
  await store.review({ ...ids, markId: b.id, state: 'flagged' }, 'librarian', 'Why still?');
  await store.setState({ ...ids, markId: b.id, state: 'rejected' }, 'author');
  const [x, y] = onDisk(file).marks;
  assert.deepEqual([x.state, x.proposed, x.history.map((h) => h.who)], ['accepted', 'east', ['librarian']]);
  assert.deepEqual([y.state, y.proposed, y.history.map((h) => `${h.state}:${h.who}`)], ['rejected', 'still ', ['flagged:librarian', 'rejected:author']]);
});

test('a change the mark\'s life does not allow writes nothing', async (t) => {
  const { store, file } = storeFor(t);
  const { id } = await store.add({ ...ids, kind: 'deletion', anchor }, 'author');
  await store.review({ ...ids, markId: id, state: 'accepted' }, 'librarian');
  const text = readFileSync(file, 'utf8');
  await assert.rejects(store.review({ ...ids, markId: id, state: 'flagged' }, 'librarian', 'Late.'), RangeError);
  await assert.rejects(store.setState({ ...ids, markId: id, state: 'rejected' }, 'author'), RangeError);
  assert.equal(readFileSync(file, 'utf8'), text);
  const c = await store.add({ ...ids, kind: 'comment', anchor, body: 'Hm' }, 'author');
  const withComment = readFileSync(file, 'utf8');
  await assert.rejects(store.review({ ...ids, markId: c.id, state: 'accepted' }, 'librarian'), RangeError);
  assert.equal(readFileSync(file, 'utf8'), withComment);
});
