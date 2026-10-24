// Rules for reading the judge's answer (ripple/contract.ts):
// - the first line is the preflight; its hash names the brief as it is, and its echo is
//   40 characters or more of the brief, emphasis aside, that the packet does not hold;
// - every other line is a proposal the schema allows, and a second preflight is refused;
// - a quote is the source's own words in order, with [insertions] and ... gaps allowed,
//   links read as shown, case and curly quotes aside, and 12 characters at the least.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnswerError, plainText, quoteIn, readAnswer } from '../../src/hoard/ripple/contract.ts';
import { sha256 } from '../../src/hoard/ripple/rulings.ts';

const briefText = 'Ripple brief.\n\nNever invent facts. Every proposal rests on the **source\'s own words**, quoted.\n';
const brief = { text: briefText, sha256: sha256(briefText) };
const packet = '# Ripple packet\n\nRead the brief first.';
const echo = 'Every proposal rests on the source\'s own words, quoted.';
const pre = (fields: Record<string, unknown> = {}) => JSON.stringify({ kind: 'preflight', brief_sha256: brief.sha256, echo, ...fields });
const topic = JSON.stringify({ kind: 'topic', target: 'Tide Tables', line: 'See [[Harbour]].', reason: 'r', quote: 'the harbour wall' });

test('plainText reads links as shown and drops emphasis and curly quotes', () => {
  assert.equal(plainText('The **[[Harbour|harbour]]** wall’s “old” stones — mostly'), 'The harbour wall\'s "old" stones - mostly');
  assert.equal(plainText('  two\n\nlines  '), 'two lines');
});

test('a quote may hold insertions and gaps, in the source\'s order', () => {
  const source = 'The harbour wall was built in the dry year. Later, the [[Lighthouse]] went dark.';
  assert.ok(quoteIn('the harbour wall was built', source));
  assert.ok(quoteIn('The harbour wall [the old one] was built ... the Lighthouse went dark', source));
  assert.ok(quoteIn('THE HARBOUR WALL… went dark', source));
  assert.equal(quoteIn('the Lighthouse went dark ... the harbour wall', source), false, 'out of order');
  assert.equal(quoteIn('the harbour', source), false, 'under 12 characters');
  assert.equal(quoteIn('the harbour wall was rebuilt', source), false);
});

test('an answer reads when its preflight shows the brief was read', () => {
  const answer = readAnswer(`${pre()}\n${topic}\n\n`, brief, packet);
  assert.deepEqual(answer.proposals.map((p) => p.kind), ['topic']);
  assert.equal(readAnswer(pre({ echo: 'Every proposal rests on the **source\'s own words**, quoted.' }), brief, packet).proposals.length, 0);
});

test('an answer without a fitting preflight is refused, with why', () => {
  const refused = (text: string, why: RegExp, p = packet) => assert.throws(() => readAnswer(text, brief, p), (err: unknown) => err instanceof AnswerError && why.test(err.message));
  refused('', /empty/);
  refused(topic, /must be the preflight/);
  refused(pre({ brief_sha256: 'a'.repeat(64) }), /another version of the brief/);
  refused(pre({ echo: '**Never** **invent** **facts.** **Every** proposal' }), /under 40/, packet);
  refused(pre({ echo: 'This sentence is long enough but was never in the brief at all.' }), /not the brief's words/);
  refused(pre(), /is in the packet/, `${packet}\n${echo}`);
  refused(`${pre()}\n{not json`, /line 2 is not JSON/);
  refused(`${pre()}\n${JSON.stringify({ kind: 'claim', target: 'T', reason: 'r' })}`, /line 2 is not a ripple answer line/);
  refused(`${pre()}\n${pre()}`, /second preflight/);
});
