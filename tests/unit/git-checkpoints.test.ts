// Rule: commits follow the writer's pauses, not their saves. However many saves land,
// there is one commit per idle gap and never more; a requested checkpoint waits for
// the last save to land, but not for ever; and commits never overlap.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Checkpoints, type Clock } from '../../src/hoard/git/checkpoints.ts';
import type { Reason } from '../../src/hoard/git/commit.ts';

// Virtual time: timers run when advance() passes them, in order, and the promises they
// start are let settle before the next one runs.
function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const clock: Clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id as number);
    },
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = end;
    await settle();
  }
  return { clock, advance, settle };
}

function setup(commitMs = 0) {
  const time = fakeClock();
  const made: { reason: Reason; at: number }[] = [];
  let running = 0;
  let overlapped = false;
  const checkpoints = new Checkpoints({
    idleMs: 60_000,
    clock: time.clock,
    commit: async (reason) => {
      running++;
      if (running > 1) overlapped = true;
      if (commitMs) await new Promise<void>((resolve) => time.clock.setTimeout(resolve, commitMs));
      made.push({ reason, at: time.clock.now() });
      running--;
    },
  });
  return { ...time, made, checkpoints, overlapped: () => overlapped };
}

test('1,000 saves across 50 chapters make one commit per idle gap and no more', async () => {
  const s = setup();
  // A seeded mix of typing bursts and pauses: most gaps are seconds, some pass a minute.
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  let gaps = 0;
  for (let i = 0; i < 1000; i++) {
    s.checkpoints.wrote(`c${i % 50}`);
    const gap = rand() < 0.03 ? 61_000 + Math.floor(rand() * 600_000) : 800 + Math.floor(rand() * 20_000);
    if (gap >= 60_000) gaps++;
    await s.advance(gap);
  }
  assert.ok(gaps > 10, `the run has idle gaps to count (${gaps})`);
  assert.equal(s.made.length, gaps);
  assert.ok(s.made.every((m) => m.reason === 'idle'));
});

test('an idle commit comes 60 s after the last save, not after the first', async () => {
  const s = setup();
  s.checkpoints.wrote('c1');
  await s.advance(50_000);
  s.checkpoints.wrote('c1');
  await s.advance(59_000);
  assert.equal(s.made.length, 0);
  await s.advance(1_000);
  assert.deepEqual(s.made, [{ reason: 'idle', at: 110_000 }]);
});

test('a requested checkpoint waits until saves stop for a second', async () => {
  const s = setup();
  s.checkpoints.request('chapter-switch');
  await s.advance(500);
  s.checkpoints.wrote('c1');
  await s.advance(900);
  assert.equal(s.made.length, 0);
  await s.advance(100);
  assert.deepEqual(s.made, [{ reason: 'chapter-switch', at: 1_500 }]);
});

test('a requested checkpoint waits no more than five seconds', async () => {
  const s = setup();
  s.checkpoints.request('book-close');
  for (let i = 0; i < 20; i++) {
    s.checkpoints.wrote('c1');
    await s.advance(500);
  }
  assert.equal(s.made[0].reason, 'book-close');
  assert.equal(s.made[0].at, 5_000);
});

test('a requested checkpoint takes the place of the idle one', async () => {
  const s = setup();
  s.checkpoints.wrote('c1');
  s.checkpoints.request('chapter-switch');
  await s.advance(120_000);
  assert.deepEqual(s.made.map((m) => m.reason), ['chapter-switch']);
});

test('commits never overlap: a trigger during a commit runs once after it', async () => {
  const s = setup(3_000);
  s.checkpoints.now('recovered');
  await s.advance(1_000);
  s.checkpoints.now('close');
  s.checkpoints.request('chapter-switch');
  await s.advance(10_000);
  assert.equal(s.overlapped(), false);
  assert.equal(s.made.length, 2);
  assert.equal(s.made[0].reason, 'recovered');
});

test('drained() waits for the commit in flight', async () => {
  const s = setup(3_000);
  s.checkpoints.now('close');
  let done = false;
  const drained = s.checkpoints.drained().then(() => { done = true; });
  await s.advance(2_000);
  assert.equal(done, false);
  await s.advance(2_000);
  await drained;
  assert.equal(s.made.length, 1);
});

test('a failed commit is reported and the next trigger still runs', async () => {
  const time = fakeClock();
  const errors: unknown[] = [];
  let calls = 0;
  const checkpoints = new Checkpoints({
    idleMs: 60_000,
    clock: time.clock,
    commit: async () => {
      calls++;
      if (calls === 1) throw new Error('index.lock exists');
    },
    onError: (err) => errors.push(err),
  });
  checkpoints.wrote('c1');
  await time.advance(60_000);
  checkpoints.wrote('c1');
  await time.advance(60_000);
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
});
