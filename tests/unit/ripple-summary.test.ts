// The run message (ripple/summary.ts): when a re-run leaves out proposals that repeat a
// card the writer has waiting or rejected, the message says how many, so a short list of
// new cards does not read as the judge finding less.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunSummary } from '../../src/hoard/ripple/engine.ts';
import { describeRun } from '../../src/hoard/ripple/summary.ts';

const run = (fields: Partial<RunSummary> = {}): RunSummary => ({
  wiki: true, baseline: false, made: 0, packeted: 0, read: 1, proposals: 2, repeats: 0, problems: [], packets: '/lib/.neo/ripple/packets', ...fields,
});

test('the message counts repeats left out, and says nothing of them when there are none', () => {
  assert.doesNotMatch(describeRun(run()).detail, /repeat/);
  assert.match(describeRun(run()).detail, /2 proposals for you to rule on/);
  assert.match(describeRun(run({ repeats: 1 })).detail, /1 more repeated a card you have waiting or rejected, so no new card was made for it\./);
  assert.match(describeRun(run({ repeats: 3 })).detail, /3 more repeated cards you have waiting or rejected, so no new cards were made for them\./);
});
