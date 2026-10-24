// The per-candidate screen: one small question per page, with the source first so the
// prompts of one case share a prefix the model's cache can keep. Fixtures are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readScreen, screenPrompt, ScreenError, SCREEN_BODY } from '../../src/hoard/ripple/screen.ts';

const source = { title: 'Tide Ledger', text: 'Wren Calder kept the ledger for the brine kilns.\n\nThe kelp tithe rose twice.' };
const a = { title: 'Brine Works', body: 'The brine works run six kilns.', passage: 'six kilns' };
const b = { title: 'Old Mill', body: `${'A ruined mill upriver. '.repeat(100)}LAST WORDS` };

// Rule: every prompt of a case is the same text up to the candidate, which comes last.
test('the screen prompt puts the source first, the same for every candidate of a case', () => {
  const pa = screenPrompt(source, a);
  const pb = screenPrompt(source, b);
  let shared = 0;
  while (shared < pa.length && pa[shared] === pb[shared]) shared++;
  const prefix = pa.slice(0, shared);
  assert.ok(prefix.includes(source.text), 'the source is in the shared prefix');
  assert.ok(prefix.includes('"affects"') && prefix.includes('order'), 'so is the question');
  assert.ok(!prefix.includes(a.title) && !prefix.includes(b.title), 'no candidate is in it');
  assert.ok(pa.endsWith(`${a.body}\n`), 'the candidate comes last');
});

test('the candidate shows its best passage first and its text cut to the limit', () => {
  const pa = screenPrompt(source, a);
  assert.ok(pa.indexOf(a.passage) < pa.indexOf(a.body), 'the passage comes before the text');
  const pb = screenPrompt(source, b);
  assert.ok(b.body.length > SCREEN_BODY, 'baseline: the page is longer than the limit');
  assert.ok(pb.includes(b.body.slice(0, SCREEN_BODY)));
  assert.ok(!pb.includes('LAST WORDS'), 'the rest is cut');
  assert.equal(SCREEN_BODY, 1200);
});

test('a screen answer reads from a bare line, a fence, or prose around it', () => {
  const want = { affects: true, confidence: 0.8, why: 'The kilns { count } changed.' };
  for (const reply of [
    JSON.stringify(want),
    `\`\`\`json\n${JSON.stringify(want)}\n\`\`\``,
    `Here is my answer {as asked}:\n${JSON.stringify(want)}\nThanks.`,
  ]) assert.deepEqual(readScreen(reply), want);
});

test('a screen answer that does not fit says what is wrong', () => {
  assert.throws(() => readScreen('No.'), (e) => e instanceof ScreenError && /no JSON/.test(e.message));
  assert.throws(() => readScreen('{"affects": "yes", "confidence": 0.5, "why": "x"}'), /affects/);
  assert.throws(() => readScreen('{"affects": false, "confidence": 1.5, "why": "x"}'), /confidence/);
  assert.throws(() => readScreen('{"affects": false, "confidence": 0.5}'), /why/);
  assert.deepEqual(readScreen('{"affects": false, "confidence": 0, "why": "Unrelated."}'), { affects: false, confidence: 0, why: 'Unrelated.' });
});
