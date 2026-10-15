// Ported from hoard's tests/test_manifest.py: the provenance manifest is append-only and
// idempotent, and verify holds every pinned page to its body as it arrived. Hoard's tests
// wrote a manifest and a vault to a temporary folder; these build the records in memory
// and hand verify a fake vault, which hashes as the command line's probe will.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { captureLogs } from '../../../src/librarian/log.ts';
import {
  type ManifestRecordV1, type VerifyProbe,
  alreadyIngested, appendRecord, duplicates, hashedBody, moveRecords, parseManifest,
  relativiseDest, repairRecords, serialiseRecord, successorRewrites, unrepairableDests, verify,
} from '../../../src/librarian/manifest.ts';

const DOC = '---\ntype: writing\n---\nExact prose body.\n';

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const bodySha = (text: string): string => sha(hashedBody(text));

/**
 * A vault in memory: `tree` is the working tree, `history` every past version of a dest
 * as `git log --follow` would find it. `asked` records each history lookup.
 */
function fakeVault(files: Record<string, string> = {}, history: Record<string, string[]> = {}) {
  const tree = new Map(Object.entries(files));
  const asked: [string, string, boolean][] = [];
  const probe: VerifyProbe = {
    exists: (rel) => tree.has(rel),
    bodySha: (rel) => bodySha(tree.get(rel)!),
    fileSha: (rel) => sha(tree.get(rel)!),
    hashInHistory: (dest, want, md) => {
      asked.push([dest, want, md]);
      return (history[dest] ?? []).some((text) => (md ? bodySha(text) : sha(text)) === want);
    },
  };
  return { tree, probe, asked };
}

/** Appends each record as hoard's `append` would, deduping unless told not to. */
function appendAll(records: ManifestRecordV1[], ...more: ManifestRecordV1[]): ManifestRecordV1[] {
  return more.reduce((acc, record) => appendRecord(acc, record).records, records);
}

const roundTrip = (records: ManifestRecordV1[]): ManifestRecordV1[] =>
  parseManifest(records.map(serialiseRecord).join(''));

test('the hashed body ignores frontmatter', () => {
  const other = '---\ntype: writing\nproject: path\n---\nExact prose body.\n';
  assert.equal(bodySha(DOC), bodySha(other));
});

test('append and load round trip', () => {
  const rec: ManifestRecordV1 = {
    src: 'old-vault/a.md', dest: 'writing/a.md', method: 'verbatim',
    src_sha256: 's', body_sha256: 'b', ingested_at: '2026-07-18T00:00:00Z',
  };
  const { records, added } = appendRecord([], rec);
  assert.equal(added, true);
  assert.deepEqual(roundTrip(records), [rec]);
});

test('append skips a duplicate', () => {
  const rec: ManifestRecordV1 = {
    src: 's.md', dest: 'writing/a.md', method: 'verbatim',
    src_sha256: 'x', body_sha256: 'b', ingested_at: 't',
  };
  const first = appendRecord([], rec);
  assert.equal(first.added, true);
  const second = appendRecord(first.records, rec);
  assert.equal(second.added, false);
  assert.equal(second.records.length, 1);
});

// No-swallow rule: a skipped append is logged, naming a retire record by its shape.
test('a skipped append is logged as hoard logs it', () => {
  const rec: ManifestRecordV1 = { dest: 'sources/a.md', method: 'retire', successor: null, reason: 'r', retired_at: 't' };
  const { records } = captureLogs(() => appendRecord([rec], rec));
  assert.deepEqual(records, [{ logger: 'librarian.manifest', level: 'info', message: 'manifest: duplicate skipped (retire) -> sources/a.md' }]);
  const added = captureLogs(() => appendRecord([], { src: null, dest: 'w/b.md', method: 'converted' }));
  assert.deepEqual(added.records.map((r) => r.message), ['manifest: recorded None -> w/b.md (converted)']);
});

test('alreadyIngested matches src and hash', () => {
  const recs = [{ src: 'a.md', dest: 'w/a.md', method: 'verbatim', src_sha256: 'h1' }] as ManifestRecordV1[];
  assert.equal(alreadyIngested(recs, 'a.md', 'h1'), true);
  assert.equal(alreadyIngested(recs, 'a.md', 'h2'), false);
  assert.equal(alreadyIngested(recs, 'b.md', 'h1'), false);
});

test('verify flags a missing dest and a body mismatch', () => {
  const { probe } = fakeVault({ 'writing/ok.md': DOC });
  const records = appendAll([],
    { src: 's1', dest: 'writing/ok.md', method: 'verbatim', src_sha256: 'x', body_sha256: bodySha(DOC), ingested_at: 't' },
    { src: 's2', dest: 'writing/gone.md', method: 'verbatim', src_sha256: 'y', body_sha256: 'whatever', ingested_at: 't' },
    { src: 's3', dest: 'writing/ok.md', method: 'verbatim', src_sha256: 'z', body_sha256: 'WRONG', ingested_at: 't' });
  const errors = verify(records, probe);
  assert.ok(errors.some((e) => e.includes('gone.md') && e.includes('missing')));
  assert.ok(errors.some((e) => e.includes('ok.md') && e.includes('mismatch')));
  assert.equal(errors.length, 2);
  // the finding hoard prints, byte for byte
  assert.ok(errors.includes('writing/ok.md: hash mismatch \u2014 verbatim law broken (src s3)'));
});

test('verify hashes a non-md dest as a whole file', () => {
  const dest = 'writing/kite-and-heron/material/outline.canvas';
  const { tree, probe } = fakeVault({ [dest]: '{"nodes": []}' });
  const records = appendAll([],
    { src: 's', dest, method: 'verbatim', src_sha256: 'x', file_sha256: sha('{"nodes": []}'), ingested_at: 't' });
  assert.deepEqual(verify(records, probe), []);
  tree.set(dest, '{"nodes": ["tampered"]}');
  assert.ok(verify(records, probe).some((e) => e.includes('outline.canvas')));
});

// A retire tombstone (latest record per dest) ends the missing-dest check: renamed or
// author-discarded pages must not read as verbatim-law breaches.
test('verify skips a retired dest', () => {
  const { probe } = fakeVault();
  const records = appendAll([],
    { src: 's', dest: 'writing/old-name.md', method: 'verbatim', src_sha256: 'x', body_sha256: 'b', ingested_at: 't' },
    { dest: 'writing/old-name.md', method: 'retire', successor: 'writing/new-name.md', reason: 'renamed', retired_at: 't2' });
  // the successor is absent too, which only warns
  assert.deepEqual(verify(records, probe), []);
});

// A tombstone over a file that still exists is a bookkeeping lie: flag it.
test('verify flags a retired dest that is still present', () => {
  const { probe } = fakeVault({ 'writing/still-here.md': DOC });
  const records = appendAll([],
    { dest: 'writing/still-here.md', method: 'retire', successor: null, reason: 'discarded', retired_at: 't' });
  const errors = verify(records, probe);
  assert.ok(errors.some((e) => e.includes('still-here.md') && e.includes('retired')));
});

test('duplicates flags the same hash under different srcs', () => {
  const recs = [
    { src: 'a.md', dest: 'd1.md', method: 'verbatim', body_sha256: 'same' },
    { src: 'b.md', dest: 'd2.md', method: 'verbatim', body_sha256: 'same' },
    { src: 'c.md', dest: 'd3.md', method: 'verbatim', body_sha256: 'other' },
  ] as ManifestRecordV1[];
  const dupes = duplicates(recs);
  assert.equal(dupes.length, 1);
  assert.deepEqual(new Set(dupes[0]!.map((r) => r.src)), new Set(['a.md', 'b.md']));
});

test('verify checks the latest record per dest', () => {
  const { probe } = fakeVault({ 'writing/a.md': DOC });
  const records = appendAll([],
    { src: 's@v1', dest: 'writing/a.md', method: 'verbatim', src_sha256: 'h1', body_sha256: 'STALE', ingested_at: 't1' },
    { src: 's@v2', dest: 'writing/a.md', method: 'verbatim', src_sha256: 'h2', body_sha256: bodySha(DOC), ingested_at: 't2' });
  assert.deepEqual(verify(records, probe), []); // superseded record ignored
});

// Living vault (A14): the author edits an ingested file; verify finds the at-ingest body
// in git history and reports evolution, not violation.
test('verify accepts authorial evolution', () => {
  const evolved = `${DOC}\nThe author kept writing.\n`;
  const { probe } = fakeVault({ 'writing/a.md': evolved }, { 'writing/a.md': [DOC, evolved] });
  const records = appendAll([],
    { src: 's', dest: 'writing/a.md', method: 'verbatim', src_sha256: 'x', body_sha256: bodySha(DOC), ingested_at: 't' });
  const { result, records: logged } = captureLogs(() => verify(records, probe));
  assert.deepEqual(result, []);
  assert.ok(logged.some((r) => r.message === 'writing/a.md: evolved since ingest (verbatim at ingest verified)'));
});

// Non-md verbatim dests (PDFs) must hash historical blobs as bytes. Reading blobs as
// bytes is the command line's git probe; here, verify asks history for the whole-file
// hash of a non-md dest, never a body hash.
test('verify searches history for a non-md dest by its whole-file hash', () => {
  const original = '%PDF-1.4\n\xff\xfe\x00binary\x80payload\n';
  const { probe, asked } = fakeVault({ 'sources/blob.bin': `${original}\x00evolved` }, { 'sources/blob.bin': [original] });
  const records = appendAll([],
    { src: 's', dest: 'sources/blob.bin', method: 'verbatim', src_sha256: 'x', file_sha256: sha(original), ingested_at: 't' });
  assert.deepEqual(verify(records, probe), []); // history holds the ingest bytes
  assert.deepEqual(asked, [['sources/blob.bin', sha(original), false]]);
});

// --- repair: absolute dest paths ---
// One record of 94 was written with a machine-absolute dest, so verify passed only on
// the machine that wrote it.

const VAULT = '/home/agent/projects/hoard';

test('relativiseDest leaves relative paths alone', () => {
  assert.equal(relativiseDest('sources/a.md', VAULT), null);
});

test('relativiseDest strips the vault root', () => {
  assert.equal(relativiseDest('/home/agent/projects/hoard/sources/a.md', VAULT), 'sources/a.md');
});

// Media lives outside git by design (iron law 8): not ours to rewrite.
test('relativiseDest refuses paths outside the vault', () => {
  assert.equal(relativiseDest('/home/agent/hoard-media/x.m4a', VAULT), null);
  // a sibling folder sharing the root's name as a prefix is still outside it
  assert.equal(relativiseDest('/home/agent/projects/hoard-old/a.md', VAULT), null);
});

// Paths compare by component as pathlib does: doubled slashes and `.` fall away.
test('relativiseDest compares paths by component', () => {
  assert.equal(relativiseDest('/home/agent//projects/./hoard/sources/a.md', VAULT), 'sources/a.md');
  assert.equal(relativiseDest('/home/agent/projects/hoard/sources/a.md', `${VAULT}/`), 'sources/a.md');
});

// A Windows checkout writes drive paths; they are absolute, and their drive and folders
// compare without case, as Windows does.
test('a Windows drive path is absolute and relativises against a Windows root', () => {
  assert.equal(relativiseDest('C:\\Users\\agent\\hoard\\sources\\a.md', 'C:\\Users\\agent\\hoard'), 'sources/a.md');
  assert.equal(relativiseDest('c:/users/agent/hoard/sources/a.md', 'C:\\Users\\agent\\hoard'), 'sources/a.md');
  assert.equal(relativiseDest('D:\\elsewhere\\a.md', 'C:\\Users\\agent\\hoard'), null);
  assert.deepEqual(unrepairableDests([{ dest: 'D:\\elsewhere\\a.md', method: 'verbatim' }], VAULT), ['D:\\elsewhere\\a.md']);
});

test('repairRecords reports and rewrites only dest', () => {
  const records = [
    { src: '/home/agent/hoard-media/x.m4a', dest: '/home/agent/projects/hoard/sources/a.md', method: 'converted' },
    { src: 'old-vault/b.md', dest: 'writing/b.md', method: 'verbatim' },
  ] as ManifestRecordV1[];
  const { records: repaired, changes } = repairRecords(records, VAULT);
  assert.deepEqual(changes, [['/home/agent/projects/hoard/sources/a.md', 'sources/a.md']]);
  assert.equal(repaired[0]!.dest, 'sources/a.md');
  assert.equal(repaired[0]!.src, '/home/agent/hoard-media/x.m4a'); // src untouched
  assert.equal(repaired[0]!.method, 'converted'); // other keys intact
  assert.deepEqual(repaired[1], records[1]); // clean record intact
});

test('repairRecords is idempotent', () => {
  const records = [{ src: 's', dest: '/home/agent/projects/hoard/sources/a.md', method: 'converted' }] as ManifestRecordV1[];
  const once = repairRecords(records, VAULT);
  const twice = repairRecords(once.records, VAULT);
  assert.ok(once.changes.length > 0 && twice.changes.length === 0);
  assert.deepEqual(once.records, twice.records);
});

test('repairRecords preserves order and count', () => {
  const records = [0, 1, 2, 3, 4].map((i) => ({ dest: `writing/${i}.md`, method: 'verbatim' })) as ManifestRecordV1[];
  records[2]!.dest = '/home/agent/projects/hoard/writing/2.md';
  const { records: repaired, changes } = repairRecords(records, VAULT);
  assert.equal(repaired.length, 5);
  assert.equal(changes.length, 1);
  assert.deepEqual(repaired.map((r) => r.dest), [0, 1, 2, 3, 4].map((i) => `writing/${i}.md`));
});

test('repairRecords with nothing to repair returns an equal list', () => {
  const records = [{ dest: 'writing/a.md', method: 'verbatim' }, { dest: 'sources/b.md', method: 'verbatim' }] as ManifestRecordV1[];
  const { records: repaired, changes } = repairRecords(records, VAULT);
  assert.deepEqual(changes, []);
  assert.deepEqual(repaired, records);
});

// hoard's `rewrite` wrote every record as a line; reading the text back gives them again.
test('rewritten records round trip through parseManifest', () => {
  const records = [
    { src: 's', dest: 'writing/a.md', method: 'verbatim' },
    { src: 't', dest: 'writing/b.md', method: 'converted' },
  ] as ManifestRecordV1[];
  assert.deepEqual(roundTrip(records), records);
});

// A dest is vault-relative by convention, so any absolute one is a defect, but only the
// machine that wrote it can safely relativise it.
test('unrepairableDests flags absolute paths from another machine', () => {
  const records = [
    { dest: '/somewhere/else/hoard/sources/a.md' }, // another machine's root
    { dest: '/home/agent/projects/hoard/sources/b.md' }, // ours, repairable
    { dest: 'writing/c.md' }, // fine
  ] as ManifestRecordV1[];
  assert.deepEqual(unrepairableDests(records, VAULT), ['/somewhere/else/hoard/sources/a.md']);
});

test('unrepairableDests is empty when every dest is clean or repairable', () => {
  const records = [{ dest: 'writing/c.md' }, { dest: '/home/agent/projects/hoard/sources/b.md' }] as ManifestRecordV1[];
  assert.deepEqual(unrepairableDests(records, VAULT), []);
});

// --- move (shadow-copy plumbing): retire the old path, carry the record to the ghost ---

const MOVE_RECS: ManifestRecordV1[] = [
  {
    src: 'old-vault/50_Projects/Project-QVL.md', dest: 'sources/project-qvl.md',
    method: 'verbatim', src_sha256: 's', body_sha256: 'b', ingested_at: 't0',
  },
];

test('moveRecords emits a tombstone and a carried record', () => {
  const out = moveRecords(MOVE_RECS, 'sources/project-qvl.md', '_deprecated/2025-11-16-project-qvl.md',
    { successor: 'projects/qvl.md', reason: 'shadow-copy', now: 't1' });
  assert.deepEqual(out.map((r) => r.method), ['retire', 'verbatim']);
  const [tomb, carried] = out as [ManifestRecordV1, ManifestRecordV1];
  assert.equal(tomb.dest, 'sources/project-qvl.md');
  assert.equal(tomb.successor, 'projects/qvl.md');
  assert.equal(tomb.reason, 'shadow-copy');
  assert.equal(carried.dest, '_deprecated/2025-11-16-project-qvl.md');
  assert.equal(carried.src, 'old-vault/50_Projects/Project-QVL.md');
  assert.equal(carried.body_sha256, 'b');
  assert.equal(carried.moved_from, 'sources/project-qvl.md');
  assert.equal(carried.moved_at, 't1');
});

test('moveRecords carries the latest record for the old dest', () => {
  const recs: ManifestRecordV1[] = [...MOVE_RECS, {
    src: 'old-vault/50_Projects/Project-QVL.md', dest: 'sources/project-qvl.md',
    method: 'verbatim', src_sha256: 's2', body_sha256: 'b2', ingested_at: 't1',
  }];
  const [, carried] = moveRecords(recs, 'sources/project-qvl.md', '_deprecated/x.md',
    { successor: 'projects/qvl.md', reason: 'shadow-copy', now: 't2' });
  assert.equal(carried!.body_sha256, 'b2');
});

// Librarian-authored pages were never ingested, so they carry no dest record; a rename of
// one must still be recordable (iron law 10).
test('moveRecords on an unpinned dest yields a rename record', () => {
  const out = moveRecords([], 'projects/qvl.md', 'projects/qvl-(project).md',
    { successor: null, reason: 'disambiguation', now: 't' });
  assert.deepEqual(out, [{
    dest: 'projects/qvl-(project).md', method: 'rename',
    moved_from: 'projects/qvl.md', reason: 'disambiguation', moved_at: 't',
  }]);
  // key order is part of the line hoard writes
  assert.deepEqual(Object.keys(out[0]!), ['dest', 'method', 'moved_from', 'reason', 'moved_at']);
});

test('moveRecords refuses an already retired dest', () => {
  const recs: ManifestRecordV1[] = [...MOVE_RECS, {
    dest: 'sources/project-qvl.md', method: 'retire', successor: 'projects/qvl.md', reason: 'gone', retired_at: 't1',
  }];
  assert.throws(
    () => moveRecords(recs, 'sources/project-qvl.md', '_deprecated/x.md', { successor: null, reason: 'r', now: 't2' }),
    { message: 'move: sources/project-qvl.md is already retired' });
});

// The known defect this exists for: a git mv alone turns verify red.
test('verify goes green after moveRecords', () => {
  const { tree, probe } = fakeVault({ 'sources/a.md': DOC });
  let records = appendAll([],
    { src: 'old/a.md', dest: 'sources/a.md', method: 'verbatim', src_sha256: 'x', body_sha256: bodySha(DOC), ingested_at: 't' });
  tree.delete('sources/a.md');
  tree.set('_deprecated/2025-a.md', DOC);
  assert.ok(verify(records, probe).length > 0); // red: dest missing
  records = appendAll(records, ...moveRecords(records, 'sources/a.md', '_deprecated/2025-a.md',
    { successor: 'lore/A.md', reason: 'shadow-copy', now: 't1' }));
  tree.set('lore/A.md', '# A\n');
  assert.deepEqual(verify(records, probe), []);
});

// The pinned body may exist only at the pre-rename path: ingest, author edit, then git
// mv. Following the file through the rename is the git probe's job; verify asks it about
// the new dest with the pin the move carried.
test('verify follows a rename when the pin predates the move', () => {
  const edited = `${DOC}\nauthor edit\n`;
  const { probe, asked } = fakeVault(
    { '_deprecated/2025-a.md': edited, 'lore/A.md': '# A\n' },
    { '_deprecated/2025-a.md': [DOC, edited] });
  let records = appendAll([],
    { src: 'old/a.md', dest: 'sources/a.md', method: 'verbatim', src_sha256: 'x', body_sha256: bodySha(DOC), ingested_at: 't' });
  records = appendAll(records, ...moveRecords(records, 'sources/a.md', '_deprecated/2025-a.md',
    { successor: 'lore/A.md', reason: 'shadow-copy', now: 't1' }));
  assert.deepEqual(verify(records, probe), []);
  assert.deepEqual(asked, [['_deprecated/2025-a.md', bodySha(DOC), true]]);
});

test('verify accepts a rename record whose dest exists', () => {
  const { probe } = fakeVault({ 'projects/qvl-(project).md': DOC });
  const records = appendAll([],
    { dest: 'projects/qvl-(project).md', method: 'rename', moved_from: 'projects/qvl.md', reason: 'r', moved_at: 't' });
  assert.deepEqual(verify(records, probe), []);
});

// A rename record carries no `src`, so the missing-dest message must not assume one.
test('verify flags a rename record whose dest is gone', () => {
  const { probe } = fakeVault();
  const records = appendAll([],
    { dest: 'projects/qvl-(project).md', method: 'rename', moved_from: 'projects/qvl.md', reason: 'r', moved_at: 't' });
  assert.deepEqual(verify(records, probe), ['projects/qvl-(project).md: missing (src none)']);
});

// Retire records share the dedupe key (None, dest, None), so an updated copy of one is
// otherwise silently dropped.
test('append can be told not to dedupe', () => {
  const rec: ManifestRecordV1 = { dest: 'sources/a.md', method: 'retire', successor: 'projects/a.md', reason: 'r', retired_at: 't' };
  const updated = { ...rec, successor: 'projects/a-(project).md' };
  let step = appendRecord([], rec);
  assert.equal(step.added, true);
  step = appendRecord(step.records, updated);
  assert.equal(step.added, false);
  step = appendRecord(step.records, updated, { dedupe: false });
  assert.equal(step.added, true);
  assert.equal(step.records.length, 2);
});

test('successorRewrites repoints a stale successor', () => {
  const recs: ManifestRecordV1[] = [{
    dest: 'sources/project-qvl.md', method: 'retire', successor: 'projects/qvl.md', reason: 'shadow-copy', retired_at: 't0',
  }];
  assert.deepEqual(successorRewrites(recs, 'projects/qvl.md', 'projects/qvl-(project).md'), [{
    dest: 'sources/project-qvl.md', method: 'retire', successor: 'projects/qvl-(project).md',
    reason: 'shadow-copy', retired_at: 't0',
  }]);
});

test('successorRewrites ignores other successors and records without one', () => {
  const recs = [
    { dest: 'sources/b.md', method: 'retire', successor: 'projects/other.md' },
    { dest: 'sources/c.md', method: 'verbatim', src: 's' },
  ] as ManifestRecordV1[];
  assert.deepEqual(successorRewrites(recs, 'projects/qvl.md', 'projects/qvl-(p).md'), []);
});

// Copying a superseded record forward would make it latest again and lie to verify about
// the dest's state.
test('successorRewrites rewrites only the latest record per dest', () => {
  const recs = [
    { dest: 'sources/a.md', method: 'retire', successor: 'projects/qvl.md', reason: 'old', retired_at: 't0' },
    { dest: 'sources/a.md', method: 'verbatim', src: 's', body_sha256: 'b', ingested_at: 't1' },
  ] as ManifestRecordV1[];
  assert.deepEqual(successorRewrites(recs, 'projects/qvl.md', 'projects/qvl-(p).md'), []);
});

test('verify warns on a successor that does not exist', () => {
  const { probe } = fakeVault();
  const records = appendAll([],
    { dest: 'sources/a.md', method: 'retire', successor: 'projects/gone.md', reason: 'r', retired_at: 't' });
  const { result, records: logged } = captureLogs(() => verify(records, probe));
  assert.deepEqual(result, []);
  const warnings = logged.filter((r) => r.level === 'warning' && r.logger === 'librarian.manifest');
  assert.deepEqual(warnings.map((r) => r.message), ['sources/a.md: successor projects/gone.md does not exist']);
});

test('verify is quiet about a successor that exists', () => {
  const { probe } = fakeVault({ 'projects/a.md': DOC });
  const records = appendAll([],
    { dest: 'sources/a.md', method: 'retire', successor: 'projects/a.md', reason: 'r', retired_at: 't' });
  const { result, records: logged } = captureLogs(() => verify(records, probe));
  assert.deepEqual(result, []);
  assert.deepEqual(logged.filter((r) => r.level === 'warning'), []);
});

// --- reading and writing lines ---

test('parseManifest reads one record per line and skips blank lines', () => {
  const text = '{"dest": "a.md", "method": "verbatim"}\n\n   \n{"dest": "b.md", "method": "retire", "extra": 1}\n';
  assert.deepEqual(parseManifest(text), [
    { dest: 'a.md', method: 'verbatim' },
    { dest: 'b.md', method: 'retire', extra: 1 },
  ]);
  assert.deepEqual(parseManifest(''), []);
});

test('parseManifest names the line that is not JSON', () => {
  const text = '{"dest": "a.md", "method": "verbatim"}\n\n{"dest": "b.md", \n';
  assert.throws(() => parseManifest(text), /manifest line 3: /);
});

test('parseManifest names the line that is not a record', () => {
  const text = '{"dest": "a.md", "method": "verbatim"}\n{"src": "s", "method": "verbatim"}\n';
  assert.throws(() => parseManifest(text), (err: Error) => err.message.startsWith('manifest line 2: ') && err.message.includes('dest'));
  assert.throws(() => parseManifest('{"dest": "a.md", "method": "moved"}\n'), /manifest line 1: .*method/);
  assert.throws(() => parseManifest('["dest"]\n'), /manifest line 1: /);
});

// Each expected line was printed by CPython's json.dumps(record): separators ", " and
// ": ", ASCII only, an astral character as a surrogate pair, lower-case hex.
test('serialiseRecord writes the line json.dumps writes', () => {
  const record = {
    src: 'old-vault/Café Éclair.md', dest: 'writing/café-éclair.md', method: 'verbatim', src_sha256: null,
    reviewed: 'Wenna’s pass 𝔘', shadow_pair: true, n: 3, f: 0.5,
    esc: 'tab\tquote" back\\ nl\n ctl\u0001 del\u007f sep\u2028',
    list: [1, 'a', null, false], obj: {}, empty: [], nested: { k: ['v', {}] },
  } as ManifestRecordV1;
  assert.equal(serialiseRecord(record), String.raw`{"src": "old-vault/Caf\u00e9 \u00c9clair.md", "dest": "writing/caf\u00e9-\u00e9clair.md", "method": "verbatim", "src_sha256": null, "reviewed": "Wenna\u2019s pass \ud835\udd18", "shadow_pair": true, "n": 3, "f": 0.5, "esc": "tab\tquote\" back\\ nl\n ctl\u0001 del\u007f sep\u2028", "list": [1, "a", null, false], "obj": {}, "empty": [], "nested": {"k": ["v", {}]}}` + "\n");
  assert.equal(serialiseRecord({ x: [1e-5, 0.0001, 123456789.125, -2.5, 1e-7, 2.5e-5, 1.5e-300, 0.1, 3, -7, 0] } as never),
    String.raw`{"x": [1e-05, 0.0001, 123456789.125, -2.5, 1e-07, 2.5e-05, 1.5e-300, 0.1, 3, -7, 0]}` + "\n");
});
