// Rules for finding ripple's work (ripple/reconcile.ts):
// - the first run sets the cursor and makes no job;
// - each new page-imported or page-updated line is a hop-0 job for that page, in either
//   tree; an attachment, a book import and a page that is gone make none;
// - each page under wiki/ or sources/ that the author's commits changed in words is
//   exactly one hop-0 job; the librarian's commits, changes of formatting alone and
//   files that are not pages are not;
// - the same words make the same job once; a page's later state in one run wins;
// - a newer job for a page sets the page's older waiting job aside;
// - git that cannot read from the cursor moves the cursor on rather than stopping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcile, sourceHash, wordsOf, type ReconcileInput } from '../../src/hoard/ripple/reconcile.ts';
import { fold, type RippleCursor, type RippleJob } from '../../src/hoard/ripple/rulings.ts';

const AT = '2026-10-16T12:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const HARBOUR = 'wiki/Harbour.html';
const LIGHT = 'sources/Notes/Lighthouse.html';
const pages = [{ id: HARBOUR, title: 'Harbour' }, { id: LIGHT, title: 'Lighthouse' }];
const imported = (page: string, kind = 'page-imported') => ({ version: 1, at: AT, kind, page, src: '/v/x.md' });
const cursor = (commit: string | null, changes: number): RippleCursor => ({ version: 1, type: 'cursor', id: 'cursor', at: AT, commit, changes });
const stateOf = (...records: unknown[]) => fold(records.map((r) => JSON.stringify(r)).join('\n'));

function input(fields: Partial<Omit<ReconcileInput, 'at'>> & { files?: Record<string, string>; commits?: Record<string, Record<string, string>> }): ReconcileInput {
  const files = fields.files ?? {};
  return {
    state: stateOf(), pages, head: null, changes: [],
    changed: async () => [],
    show: async (commit, rel) => fields.commits?.[commit]?.[rel] ?? null,
    read: async (rel) => files[rel] ?? null,
    log: () => {},
    ...fields, at: AT,
  };
}

test('the first run sets the cursor and makes no job', async () => {
  const done = await reconcile(input({ head: A, changes: [imported(HARBOUR)], files: { [HARBOUR]: '<p>x</p>' } }));
  assert.equal(done.baseline, true);
  assert.deepEqual(done.made, []);
  assert.deepEqual(done.records, [cursor(A, 1)]);
});

test('new imports and updates, in either tree, are jobs once; empty pages, attachments and book imports are not', async () => {
  const files = { [HARBOUR]: '<p>The wall.</p>', [LIGHT]: '<p>The tower.</p>', 'wiki/Empty.html': '<p><br></p>' };
  const state = stateOf(cursor(null, 1));
  const lines = [
    imported('wiki/Empty.html'), imported(LIGHT, 'page-updated'), imported(HARBOUR), imported(HARBOUR, 'attachment-imported'),
    { version: 1, at: AT, kind: 'page-imported', bookId: 'book-wiki-1', chId: 'ch-h', dest: 'book-wiki-1/chapters/ch-h.html', src: '/v/h.md' },
    { type: 'page-imported', page: 'wiki/Gone.html' }, { kind: 'page-imported', page: 7 }, null,
  ];
  const done = await reconcile(input({ state, changes: lines, files, pages: [...pages, { id: 'wiki/Empty.html', title: 'Empty' }] }));
  assert.deepEqual(done.made.map((j) => [j.origin, j.source.page, j.source.title, j.hop, j.state]), [
    ['imported', LIGHT, 'Lighthouse', 0, 'open'], ['imported', HARBOUR, 'Harbour', 0, 'open'],
  ]);
  assert.deepEqual(done.records.at(-1), cursor(null, lines.length));
  const again = await reconcile(input({ state: stateOf(cursor(null, 1), ...done.records), changes: [...lines, imported(HARBOUR)], files }));
  assert.deepEqual(again.made, [], 'the same words are the same job');
});

test('every page the author changed in words, in either tree, is exactly one job; nothing else is', async () => {
  const commits: Record<string, Record<string, string>> = {
    [A]: { [HARBOUR]: '<p>The wall is timber.</p>', [LIGHT]: '<p>The keeper.</p>', 'wiki/Quay.html': '<p>The quay.</p>' },
    [B]: {
      [HARBOUR]: '<p>The wall is <b>timber</b>.</p>', [LIGHT]: '<p>The keeper left.</p>', 'wiki/Quay.html': '<p>The quay.</p>',
      'wiki/New.html': '<p>A new page.</p>', 'wiki/notes.txt': 'not html', 'sources/Mill.html': '<p>The librarian\'s.</p>',
    },
  };
  const seen: string[] = [];
  const changed = async (from: string, to: string, under: string) => {
    assert.deepEqual([from, to], [A, B]);
    seen.push(under);
    return under === 'wiki/'
      ? [HARBOUR, 'wiki/Quay.html', 'wiki/New.html', 'wiki/notes.txt', 'wiki/Removed.html'].map((rel) => ({ rel, byAuthor: true }))
      : [{ rel: LIGHT, byAuthor: true }, { rel: LIGHT, byAuthor: true }, { rel: 'sources/Mill.html', byAuthor: false }];
  };
  const all = [...pages, { id: 'wiki/Quay.html', title: 'Quay' }, { id: 'wiki/New.html', title: 'New' }, { id: 'sources/Mill.html', title: 'Mill' }];
  const done = await reconcile(input({ state: stateOf(cursor(A, 0)), head: B, changed, commits, pages: all }));
  assert.deepEqual(seen, ['wiki/', 'sources/']);
  assert.deepEqual(done.made.map((j) => [j.origin, j.source.page, j.hop, j.commit]), [['changed', 'wiki/New.html', 0, B], ['changed', LIGHT, 0, B]]);
  assert.equal(done.made[1]!.source_hash, sourceHash('<p>The keeper <i>left</i>.</p>'), 'the hash is of the words');
  assert.deepEqual(done.records.at(-1), cursor(B, 0));
});

test('a newer job sets the page\'s older waiting job aside, and a page imported then changed is one job', async () => {
  const first = await reconcile(input({ state: stateOf(cursor(A, 0)), head: A, changes: [imported(HARBOUR)], files: { [HARBOUR]: '<p>One.</p>' } }));
  const old = first.made[0] as RippleJob;
  const state = stateOf(cursor(A, 0), ...first.records, { ...old, state: 'packeted' });
  const next = await reconcile(input({
    state, head: B, changes: [imported(HARBOUR), imported(HARBOUR)], files: { [HARBOUR]: '<p>Two.</p>' },
    changed: async (_from, _to, under) => (under === 'wiki/' ? [{ rel: HARBOUR, byAuthor: true }] : []),
    commits: { [A]: { [HARBOUR]: '<p>One.</p>' }, [B]: { [HARBOUR]: '<p>Three.</p>' } },
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
