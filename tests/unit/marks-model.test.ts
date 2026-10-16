// Rule: a mark changes state only along the lines of the roadmap's life of a mark, and
// every change says who made it and when. Comments and highlights close by resolution
// and can be reopened; suggestions are accepted, rejected or flagged, and a flagged one
// is then accepted or rejected. Nothing a mark held is lost by a change.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mark, MarkKind, MarkState } from '../../src/generated/hoard-marks-v1.js';
import { validateHoardMarksV1 } from '../../src/generated/validators.cjs';
import { canMove, newMark, reply, transition } from '../../src/hoard/marks/model.ts';

const at = '2026-10-15T21:00:00.000Z';
const later = '2026-10-15T22:00:00.000Z';
const anchor = { exact: 'boats', prefix: 'counted the ', suffix: ' twice.', pIdx: 1, off: 17, commit: null };
const KINDS: MarkKind[] = ['comment', 'highlight', 'insertion', 'deletion', 'substitution'];
const STATES: MarkState[] = ['open', 'flagged', 'accepted', 'rejected', 'resolved'];
const ALLOWED: Record<'note' | 'suggestion', string[]> = {
  note: ['open>resolved', 'resolved>open'],
  suggestion: ['open>accepted', 'open>rejected', 'open>flagged', 'flagged>accepted', 'flagged>rejected'],
};

const made = (kind: MarkKind): Mark => newMark({
  id: 'm-abcd1', kind, anchor: kind === 'insertion' ? { ...anchor, exact: '' } : anchor,
  body: kind === 'comment' ? 'Which boats?' : undefined,
  proposed: kind === 'insertion' || kind === 'substitution' ? 'ships' : undefined,
  who: 'author', at,
});

const valid = (marks: Mark[]) => {
  const ok = validateHoardMarksV1({ version: 1, marks });
  assert.ok(ok, JSON.stringify(validateHoardMarksV1.errors));
};

test('a new mark is open, names its maker, and fits the sidecar schema', () => {
  const marks = KINDS.map(made);
  for (const mark of marks) {
    assert.equal(mark.state, 'open');
    assert.deepEqual(mark.created, { who: 'author', at });
    assert.deepEqual(mark.history, []);
  }
  assert.deepEqual(marks[0].thread, [{ id: 'm-abcd1-0', who: 'author', at, body: 'Which boats?' }]);
  valid(marks);
});

test('a mark is refused when it lacks what its kind needs', () => {
  assert.throws(() => newMark({ id: 'm-abcd1', kind: 'comment', anchor, who: 'author', at }), RangeError);
  assert.throws(() => newMark({ id: 'm-abcd1', kind: 'comment', anchor, body: '   ', who: 'author', at }), RangeError);
  assert.throws(() => newMark({ id: 'm-abcd1', kind: 'substitution', anchor, who: 'author', at }), RangeError);
  assert.throws(() => newMark({ id: 'm-abcd1', kind: 'deletion', anchor: { ...anchor, exact: '' }, who: 'author', at }), RangeError);
  assert.throws(() => newMark({ id: 'm-abcd1', kind: 'deletion', anchor, proposed: 'x', who: 'author', at }), RangeError);
});

test('every kind moves only along its own lines, from every state', () => {
  let checked = 0;
  for (const kind of KINDS) {
    const lines = ALLOWED[kind === 'comment' || kind === 'highlight' ? 'note' : 'suggestion'];
    for (const from of STATES) {
      for (const to of STATES) {
        const allowed = lines.includes(`${from}>${to}`);
        assert.equal(canMove(kind, from, to), allowed, `${kind} ${from}>${to}`);
        const mark = { ...made(kind), state: from };
        if (allowed) {
          const moved = transition(mark, to, 'librarian', later);
          assert.equal(moved.state, to);
          assert.deepEqual(moved.history.at(-1), { state: to, who: 'librarian', at: later });
          assert.equal(mark.state, from, 'the old mark is left as it was');
          valid([moved]);
        } else {
          assert.throws(() => transition(mark, to, 'librarian', later), RangeError);
        }
        checked++;
      }
    }
  }
  assert.equal(checked, KINDS.length * STATES.length * STATES.length);
});

test('a reply goes on the end of the thread and keeps everything before it', () => {
  const first = made('comment');
  const resolved = transition(first, 'resolved', 'author', later);
  const answered = reply(resolved, { id: 'm-abcd1-1', who: 'librarian', at: later, body: 'The ones at the quay.' });
  assert.deepEqual(answered.thread.map((e) => e.body), ['Which boats?', 'The ones at the quay.']);
  assert.equal(answered.state, 'resolved', 'a reply does not reopen');
  assert.deepEqual(answered.history, resolved.history);
  assert.equal(resolved.thread.length, 1);
  assert.throws(() => reply(first, { id: 'm-abcd1-2', who: 'author', at, body: '' }), RangeError);
  valid([answered]);
});
