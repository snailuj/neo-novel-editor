// Rules for finding ripple's work (ripple/reconcile.ts):
// - the first run sets the cursor and makes no job;
// - each new 'page-imported' line for the wiki is a job for that page;
// - each wiki page the author's commits changed in words is a job; the librarian's
//   commits, and changes of formatting alone, are not;
// - the same words make the same job once; a page's later state in one run wins;
// - a newer job for a page sets the page's older waiting job aside;
// - git that cannot read from the cursor moves the cursor on rather than stopping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HoardChangeV1 } from '../../src/generated/hoard-change-v1.js';
import type { Wiki } from '../../src/hoard/ripple/pages.ts';
import { reconcile, sourceHash, wordsOf, type ReconcileInput } from '../../src/hoard/ripple/reconcile.ts';
import { fold, type RippleCursor, type RippleJob } from '../../src/hoard/ripple/rulings.ts';

const AT = '2026-10-16T12:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const wiki: Wiki = { bookId: 'book-wiki-1', pages: ['ch-h', 'ch-l'].map((chId, i) => ({ chId, title: ['Harbour', 'Lighthouse'][i]!, aliases: [], owner: 'librarian' as const, rel: `book-wiki-1/chapters/${chId}.html` })) };
const imported = (chId: string): HoardChangeV1 => ({ version: 1, at: AT, kind: 'page-imported', bookId: wiki.bookId, chId, dest: `book-wiki-1/chapters/${chId}.html`, src: `/v/${chId}.md` });
const cursor = (commit: string | null, changes: number): RippleCursor => ({ version: 1, type: 'cursor', id: 'cursor', at: AT, commit, changes });
const stateOf = (...records: unknown[]) => fold(records.map((r) => JSON.stringify(r)).join('\n'));

function input(fields: Partial<Omit<ReconcileInput, 'at'>> & { files?: Record<string, string>; commits?: Record<string, Record<string, string>> }): ReconcileInput {
  const files = fields.files ?? {};
  return {
    state: stateOf(), wiki, head: null, changes: [],
    changed: async () => [],
    show: async (commit, rel) => fields.commits?.[commit]?.[rel] ?? null,
    read: (rel) => files[rel] ?? null,
    log: () => {},
    ...fields, at: AT,
  };
}

test('the first run sets the cursor and makes no job', async () => {
  const done = await reconcile(input({ head: A, changes: [imported('ch-h')], files: { 'book-wiki-1/chapters/ch-h.html': '<p>x</p>' } }));
  assert.equal(done.baseline, true);
  assert.deepEqual(done.made, []);
  assert.deepEqual(done.records, [cursor(A, 1)]);
});

test('new imports are jobs, once, and empty pages are left out', async () => {
  const files = { 'book-wiki-1/chapters/ch-h.html': '<p>The wall.</p>', 'book-wiki-1/chapters/ch-l.html': '<p><br></p>' };
  const state = stateOf(cursor(null, 1));
  const done = await reconcile(input({ state, changes: [imported('ch-l'), imported('ch-h'), imported('ch-l'), null], files }));
  assert.deepEqual(done.made.map((j) => [j.origin, j.source.title, j.hop, j.state]), [['imported', 'Harbour', 0, 'open']]);
  assert.deepEqual(done.records.at(-1), cursor(null, 4));
  const again = await reconcile(input({ state: stateOf(cursor(null, 1), ...done.records), changes: [imported('ch-l'), imported('ch-h'), imported('ch-l'), null, imported('ch-h')], files }));
  assert.deepEqual(again.made, [], 'the same words are the same job');
});

test('the author\'s changes in words are jobs; the librarian\'s and formatting alone are not', async () => {
  const rel = (chId: string) => `book-wiki-1/chapters/${chId}.html`;
  const commits = {
    [A]: { [rel('ch-h')]: '<p>The wall is timber.</p>', [rel('ch-l')]: '<p>The keeper.</p>' },
    [B]: { [rel('ch-h')]: '<p>The wall is <b>timber</b>.</p>', [rel('ch-l')]: '<p>The keeper left.</p>', [rel('ch-x')]: '<p>Not a page.</p>' },
  };
  const changed = async (from: string, to: string, under: string) => {
    assert.deepEqual([from, to, under], [A, B, 'book-wiki-1/chapters/']);
    return [{ rel: rel('ch-h'), byAuthor: true }, { rel: rel('ch-l'), byAuthor: true }, { rel: rel('ch-x'), byAuthor: true }, { rel: 'book-wiki-1/chapters/ch-q.html', byAuthor: false }];
  };
  const done = await reconcile(input({ state: stateOf(cursor(A, 0)), head: B, changed, commits }));
  assert.deepEqual(done.made.map((j) => [j.origin, j.source.chId, j.commit]), [['changed', 'ch-l', B]]);
  assert.equal(done.made[0]!.source_hash, sourceHash('<p>The keeper <i>left</i>.</p>'), 'the hash is of the words');
  assert.deepEqual(done.records.at(-1), cursor(B, 0));
});

test('a newer job sets the page\'s older waiting job aside, and a page imported then changed is one job', async () => {
  const rel = 'book-wiki-1/chapters/ch-h.html';
  const first = await reconcile(input({ state: stateOf(cursor(A, 0)), head: A, changes: [imported('ch-h')], files: { [rel]: '<p>One.</p>' } }));
  const old = first.made[0] as RippleJob;
  const state = stateOf(cursor(A, 0), ...first.records, { ...old, state: 'packeted' });
  const next = await reconcile(input({
    state, head: B, changes: [imported('ch-h'), imported('ch-h')], files: { [rel]: '<p>Two.</p>' },
    changed: async () => [{ rel, byAuthor: true }], commits: { [A]: { [rel]: '<p>One.</p>' }, [B]: { [rel]: '<p>Three.</p>' } },
  }));
  assert.equal(next.made.length, 1, 'one job for the page in one run');
  assert.equal(next.made[0]!.source_hash, sourceHash('<p>Three.</p>'));
  const skipped = next.records.find((r) => r.type === 'job' && r.id === old.id) as RippleJob;
  assert.equal(skipped.state, 'skipped');
  assert.match(skipped.problem ?? '', /newer change/);
});

test('git that cannot read from the cursor moves the cursor on', async () => {
  const said: string[] = [];
  const done = await reconcile(input({
    state: stateOf(cursor(A, 0)), head: B,
    changed: async () => { throw new Error('bad revision'); },
    log: (_level, message) => { said.push(message); },
  }));
  assert.deepEqual(done.made, []);
  assert.deepEqual(done.records, [cursor(B, 0)]);
  assert.equal(said.length, 1);
});

test('a page\'s words are its paragraphs\' plain text', () => {
  assert.equal(wordsOf('<p>One <b>two</b>.</p><p><br></p><p>“Three”</p>'), 'One two.\n"Three"');
});
