// Scoring the ripple judge's arms against the author's ticks. The ticks say which pages
// the judge should see, not which need an edit, so every arm is read the same way.
// Fixtures are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Proposed } from '../../src/hoard/ripple/contract.ts';
import { placeTicked, renderEval, scoreEval, scoreOutcome, type EvalCase, type Outcome } from '../../src/hoard/ripple/judge-eval.ts';
import { mcnemar } from '../../src/hoard/ripple/sheet.ts';

const titles: Record<string, string> = { Alder: 'lore/Alder.md', Birch: 'lore/Birch.md', Cedar: 'lore/Cedar.md', Dogwood: 'lore/Dogwood.md', Elm: 'lore/Elm.md', Fir: 'lore/Fir.md' };
const resolve = (t: string) => titles[t] ?? null;
const one: EvalCase = { slug: '01-one', source: 'sources/One.md', ticked: new Set(['lore/Alder.md', 'lore/Birch.md', 'lore/Cedar.md']), shown: new Set(['lore/Alder.md', 'lore/Birch.md', 'lore/Cedar.md', 'lore/Dogwood.md', 'lore/Elm.md']), resolve };
const two: EvalCase = { slug: '02-two', source: 'sources/Two.md', ticked: new Set(['lore/Dogwood.md']), shown: new Set(['lore/Dogwood.md', 'lore/Elm.md']), resolve };

const q = { reason: 'r', quote: 'a quote of the source' };
const claim = (target: string): Proposed => ({ kind: 'claim', target, anchor: 'x', text: 'y', ...q });
const topic = (target: string): Proposed => ({ kind: 'topic', target, line: 'See [[One]].', ...q });
const nothing = (target: string): Proposed => ({ kind: 'nothing', target, reason: 'r' });
const mint = (title: string): Proposed => ({ kind: 'mint', title, text: 't', ...q });
const judged = (proposals: Proposed[], cost = 0): Outcome => ({ kind: 'judge', proposals, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1, costUsd: cost, ms: 1000 } });

// Rule: each page acted on is exactly one of caught, false or unrated; a "nothing" is
// looked at, never acted on; mints and targets that resolve to no page are counted apart.
test('a judge run is scored as caught, false and unrated, with nothing, mint and unresolved apart', () => {
  const s = scoreOutcome(one, judged([claim('Alder'), topic('Alder'), topic('Dogwood'), claim('Fir'), nothing('Birch'), mint('Gorse'), topic('Nowhere')]))!;
  assert.deepEqual(s.acted, ['lore/Alder.md', 'lore/Dogwood.md', 'lore/Fir.md'], 'a page acted on twice counts once');
  assert.equal(s.caught + s.false + s.unrated, s.acted.length);
  assert.deepEqual([s.caught, s.false, s.unrated], [1, 1, 1]);
  assert.deepEqual(s.lookedAt, ['lore/Birch.md']);
  assert.equal(s.mints, 1);
  assert.deepEqual(s.unresolved, ['Nowhere']);
});

test('a screen run acts on the pages it said yes to', () => {
  const results = new Map([['lore/Alder.md', { affects: true, confidence: 0.9, why: 'w' }], ['lore/Birch.md', { affects: false, confidence: 0.7, why: 'w' }], ['lore/Elm.md', { affects: true, confidence: 0.2, why: 'w' }]]);
  const s = scoreOutcome(one, { kind: 'screen', results })!;
  assert.deepEqual(s.acted, ['lore/Alder.md', 'lore/Elm.md']);
  assert.deepEqual([s.caught, s.false, s.unrated], [1, 1, 0]);
  assert.equal(scoreOutcome(one, { kind: 'failed', why: 'no answer' }), null);
});

// Rule: arms pair page by page within a case, over ticked pages, and only over cases
// both runs answered; a failed case is reported, never scored as an empty answer.
test('runs total over the cases they answered and pair against the baseline', () => {
  const report = scoreEval({
    cases: [one, two],
    runs: [
      { run: 'base-1', arm: 'base', outcomes: new Map([['01-one', judged([claim('Alder'), topic('Birch')], 0.5)], ['02-two', judged([topic('Dogwood')], 0.25)]]) },
      { run: 'map-1', arm: 'map', outcomes: new Map<string, Outcome>([['01-one', judged([claim('Cedar'), topic('Birch'), topic('Elm')])], ['02-two', { kind: 'failed', why: 'line 1 must be the preflight' }]]) },
    ],
    placements: [],
    baseline: 'base-1',
  });
  const base = report.totals.find((t) => t.run === 'base-1')!;
  assert.deepEqual([base.cases, base.caught, base.ticked, base.costUsd, base.inputTokens, base.cacheReadTokens], [2, 3, 4, 0.75, 20, 200]);
  const map = report.totals.find((t) => t.run === 'map-1')!;
  assert.deepEqual([map.cases, map.failed, map.caught, map.false, map.ticked], [1, 1, 2, 1, 3]);
  const row = report.paired!.rows.find((r) => r.run === 'map-1')!;
  assert.deepEqual([row.cases, row.gained, row.lost], [1, 1, 1], 'case two is left out of the pairing');
  assert.equal(row.p, mcnemar(1, 1));
  assert.deepEqual(report.failures, [{ run: 'map-1', slug: '02-two', why: 'line 1 must be the preflight' }]);
  assert.throws(() => scoreEval({ cases: [one], runs: [], placements: [], baseline: 'nope' }), /nope/);
});

// Rule: each ticked page sits in exactly one place, the best the packet gives it.
test('placement puts each ticked page in its best place, and the places add up', () => {
  const placed = placeTicked(one, { full: new Set(['lore/Alder.md']), locator: new Set(['lore/Birch.md', 'lore/Alder.md']), map: new Set(['lore/Birch.md', 'lore/Alder.md']), chars: 900 });
  assert.deepEqual(placed, { full: 1, locator: 1, map: 0, absent: 1 });
  const report = scoreEval({
    cases: [one, two], runs: [],
    placements: [{ arm: 'map', byCase: new Map([
      ['01-one', { full: new Set(['lore/Alder.md']), locator: new Set<string>(), map: new Set(['lore/Birch.md', 'lore/Cedar.md']), chars: 1000 }],
      ['02-two', { full: new Set<string>(), locator: new Set<string>(), map: new Set<string>(), chars: 500 }],
    ]) }],
  });
  const p = report.placement[0]!;
  assert.deepEqual([p.full, p.locator, p.map, p.absent, p.meanChars], [1, 0, 2, 1, 750]);
  assert.equal(p.full + p.locator + p.map + p.absent, one.ticked.size + two.ticked.size);
});

test('the report renders totals, the pairing, placement and each case, in plain Markdown', () => {
  const report = scoreEval({
    cases: [one],
    runs: [
      { run: 'base-1', arm: 'base', outcomes: new Map([['01-one', judged([claim('Alder')])]]) },
      { run: 'base-2', arm: 'base', outcomes: new Map<string, Outcome>([['01-one', { kind: 'failed', why: 'the answer is empty' }]]) },
    ],
    placements: [{ arm: 'base', byCase: new Map([['01-one', { full: new Set(['lore/Alder.md']), locator: new Set<string>(), map: new Set<string>(), chars: 10 }]]) }],
    baseline: 'base-1',
  });
  const md = renderEval(report);
  for (const heading of ['# Ripple judge eval', '## All cases', '## Against base-1', '## Where the ticked pages sit', '## Runs that failed', '## Case 1: sources/One.md']) {
    assert.ok(md.includes(`\n${heading}\n`) || md.startsWith(`${heading}\n`), heading);
  }
  assert.match(md, /\| base-1 \| 1 \| 1 of 3 \|/);
  assert.match(md, /the answer is empty/);
  assert.ok(!md.includes('**'), 'no bold');
});
