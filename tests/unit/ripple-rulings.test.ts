// Rules for ripple's log (ripple/rulings.ts):
// - the newest line for an id is its state, and a job moves to its newest line's place;
// - ids come from what a job or proposal is, so the same answer read twice is the same ids;
// - a job is done once judged with every proposal applied or rejected, or set aside;
// - a line that does not read stops the read, and nothing writes over the file then;
// - a record that is not a ruling is refused before anything is written;
// - a card's key is what it changes, wording and job aside, and a proposal repeats a card
//   the writer still has waiting or rejected, never one applied or a judge's nothing.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cardKey, complete, fold, jobId, proposalId, repeatOf, Rulings, RulingsError, sha256, type RippleJob, type RippleProposal } from '../../src/hoard/ripple/rulings.ts';
import { tempDir } from './git-support.ts';

const AT = '2026-10-16T12:00:00.000Z';
const source = { bookId: 'book-wiki-1', chId: 'ch-a', title: 'Harbour' };
const job = (fields: Partial<RippleJob> = {}): RippleJob => ({
  version: 1, type: 'job', id: jobId(source, sha256('x'), 0), at: AT, state: 'open', origin: 'imported',
  source, source_hash: sha256('x'), commit: null, hop: 0, ...fields,
});
const proposal = (fields: Partial<RippleProposal> = {}): RippleProposal => ({
  version: 1, type: 'proposal', id: proposalId(job().id, 'topic', 'Tide Tables', 'the wall'), at: AT, job: job().id,
  kind: 'topic', status: 'proposed', hop: 0, source, target: 'Tide Tables', reason: 'r', line: 'See [[Harbour]].', quote: 'the harbour wall', ...fields,
});
const lines = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n');

test('the newest line for an id is its state', () => {
  const other = job({ id: jobId({ ...source, chId: 'ch-b' }, sha256('y'), 0), source: { ...source, chId: 'ch-b' } });
  const state = fold(lines(job(), other, job({ state: 'packeted' }), { version: 1, type: 'cursor', id: 'cursor', at: AT, commit: null, changes: 3 }));
  assert.equal(state.jobs.get(job().id)?.state, 'packeted');
  assert.deepEqual([...state.jobs.keys()], [other.id, job().id], 'a job moves to its newest line');
  assert.equal(state.cursor?.changes, 3);
  assert.equal(state.lines, 4);
});

test('ids come from what the job or proposal is', () => {
  assert.equal(jobId(source, 'a'.repeat(64), 1, 'r-000000000000'), jobId(source, 'a'.repeat(64), 1, 'r-000000000000'));
  assert.notEqual(jobId(source, 'a'.repeat(64), 1), jobId(source, 'a'.repeat(64), 2));
  assert.match(proposalId('j-1', 'claim', 'T', 'q'), /^r-[0-9a-f]{12}$/);
  assert.notEqual(proposalId('j-1', 'claim', 'T', 'q'), proposalId('j-1', 'claim', 'T', 'q2'));
});

test('a job is done once every proposal is ruled on, a deferred one keeping it open', () => {
  const judged = job({ state: 'judged' });
  const open = fold(lines(judged, proposal()));
  assert.equal(complete(open, judged), false);
  assert.equal(complete(fold(lines(judged, proposal({ status: 'deferred' }))), judged), false);
  assert.equal(complete(fold(lines(judged, proposal({ status: 'applied', outcome: 'written' }))), judged), true);
  assert.equal(complete(fold(lines(job({ state: 'skipped' }))), job({ state: 'skipped' })), true);
  assert.equal(complete(fold(lines(job({ state: 'packeted' }))), job({ state: 'packeted' })), false);
});

test('a line that does not read stops the read, and append writes nothing over it', async (t) => {
  const library = tempDir(t);
  const rulings = new Rulings(() => library);
  await rulings.append([job()]);
  const file = rulings.file;
  assert.equal(file, path.join(library, '.neo', 'ripple', 'rulings.jsonl'));
  const bad = `${readFileSync(file, 'utf8')}{"version":1,"type":"job"\n`;
  writeFileSync(file, bad);
  assert.throws(() => rulings.read(), RulingsError);
  await assert.rejects(rulings.append([proposal()]), RulingsError);
  assert.equal(readFileSync(file, 'utf8'), bad);
});

test('append refuses a record that is not a ruling, and keeps what was there', async (t) => {
  const library = tempDir(t);
  const rulings = new Rulings(() => library);
  await rulings.append([job()]);
  await assert.rejects(rulings.append([{ ...proposal(), status: 'maybe' } as unknown as RippleProposal]), TypeError);
  assert.equal(rulings.read().lines, 1);
  const state = await rulings.append([job({ state: 'packeted' }), proposal()]);
  assert.equal(state.lines, 3);
  assert.equal(state.proposals.size, 1);
});

test('append mends a file left without its last line break', async (t) => {
  const library = tempDir(t);
  mkdirSync(path.join(library, '.neo', 'ripple'), { recursive: true });
  const rulings = new Rulings(() => library);
  writeFileSync(rulings.file, JSON.stringify(job()));
  const state = await rulings.append([job({ state: 'packeted' })]);
  assert.equal(state.lines, 2);
  assert.equal(state.jobs.get(job().id)?.state, 'packeted');
});

test('a card\'s key is what it changes, wording and job aside', () => {
  const claim = proposal({ kind: 'claim', target: 'Harbour Wall', anchor: 'made of *timber*', text: 'rebuilt in stone', line: undefined });
  const same = [
    proposal({ job: 'j-other', reason: 'other words', quote: 'other quote', line: 'The [[harbour|wall]] fell, see [[Long-Storm#^b1]].' }),
    proposal({ line: 'See [[Long Storm]] and the [[Harbour]], once more.' }),
  ];
  const base = proposal({ line: 'See [[Harbour]] after the [[Long Storm]].' });
  for (const p of same) assert.equal(cardKey(p), cardKey(base), p.line);
  assert.equal(cardKey({ ...claim, target: 'harbour-wall', anchor: 'made of timber', text: 'other' }), cardKey(claim));
  const differs = [
    proposal({ line: 'See [[Harbour]].' }),
    proposal({ line: 'See [[Harbour]] after the [[Long Storm]].', target: 'Lighthouse' }),
    proposal({ line: 'See [[Harbour]] after the [[Long Storm]].', source: { ...source, chId: 'ch-b' } }),
    { ...claim, kind: 'topic' as const },
  ];
  for (const p of differs) assert.notEqual(cardKey(p), cardKey(base), JSON.stringify(p));
  assert.notEqual(cardKey({ ...claim, anchor: 'made of oak' }), cardKey(claim));
  assert.equal(cardKey(proposal({ line: 'Plain words, no link.' })), cardKey(proposal({ line: 'plain  words, no link' })));
});

test('a proposal repeats a card waiting or rejected, never one applied or a nothing', () => {
  const later = (fields: Partial<RippleProposal> = {}) => proposal({ id: 'r-later0000000', job: 'j-later', line: 'Also [[Harbour]].', ...fields });
  const ruled = (status: RippleProposal['status'], fields: Partial<RippleProposal> = {}) => fold(lines(proposal({ status, ...fields })));
  assert.equal(fold('').proposals.size, 0);
  assert.equal(repeatOf(fold(''), later()), null, 'a clean log holds no repeat');
  for (const status of ['proposed', 'deferred', 'rejected'] as const) {
    assert.equal(repeatOf(ruled(status), later())?.id, proposal().id, status);
  }
  assert.equal(repeatOf(ruled('applied'), later()), null, 'an applied card is on the page, where the judge sees it');
  assert.equal(repeatOf(ruled('rejected', { kind: 'nothing', line: undefined, quote: undefined }), later({ kind: 'nothing', line: undefined, quote: undefined })), null, 'a nothing is not a card');
  assert.equal(repeatOf(ruled('rejected'), later({ line: 'Also [[Lighthouse]].' })), null, 'another change is not a repeat');
  assert.equal(repeatOf(ruled('rejected'), proposal()), null, 'a proposal does not repeat itself');
});
