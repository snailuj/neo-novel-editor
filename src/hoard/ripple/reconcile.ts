// Reconcile: which changes ripple has not yet taken a job for. It reads two things since
// its cursor: the change log's new 'page-imported' lines for the wiki, and the wiki's
// chapter files that the author's commits changed in git. Each becomes a hop-0 job for
// the page as it stands, unless its words are the same as a job's already in the log
// (formatting aside), so running it twice makes nothing new. A newer job for a page sets
// the page's older waiting ones aside. The librarian's own commits are not changes here:
// a ripple change opens its next hop itself (engine.ts).
//
// The first run only sets the cursor, so a library that has a wiki already does not wake
// to a job for every page. Pure, but for what it is handed.
import type { HoardChangeV1 } from '../../generated/hoard-change-v1.js';
import { paragraphTexts } from '../html.ts';
import { plainText } from './contract.ts';
import type { Wiki } from './pages.ts';
import { jobId, LAST_HOP, sha256, type RippleCursor, type RippleJob, type RippleState } from './rulings.ts';

export interface ReconcileInput {
  state: RippleState;
  wiki: Wiki | null;
  /** The library's last commit; null with no history. */
  head: string | null;
  /** Every line of .neo/changes.jsonl, in order; null for one that does not read. */
  changes: readonly (HoardChangeV1 | null)[];
  /** The files under a folder that commits from..to changed, as GitLayer.changed has it. */
  changed(from: string, to: string, under: string): Promise<{ rel: string; byAuthor: boolean }[]>;
  /** A file at a commit, or null. */
  show(commit: string, rel: string): Promise<string | null>;
  /** A file as it is now, relative to the library, or null. */
  read(rel: string): string | null;
  at: string;
  log(level: 'warn' | 'info', message: string, data?: unknown): void;
}

export interface Reconciled {
  records: (RippleJob | RippleCursor)[];
  /** The new jobs among the records. */
  made: RippleJob[];
  baseline: boolean;
}

/** A page's words as a job compares them: each paragraph's plain text, empty ones gone. */
export function wordsOf(html: string): string {
  return paragraphTexts(html).map(plainText).filter(Boolean).join('\n');
}

/** The hash a job keeps of its source's words. */
export const sourceHash = (html: string) => sha256(wordsOf(html));

/** The jobs an earlier, waiting job of the same page and hop gives way to. */
export function superseded(state: RippleState, made: readonly RippleJob[], at: string): RippleJob[] {
  const out: RippleJob[] = [];
  for (const job of made) {
    for (const old of state.jobs.values()) {
      if (old.id === job.id || old.hop !== job.hop || old.parent !== job.parent) continue;
      if (old.source.bookId !== job.source.bookId || old.source.chId !== job.source.chId) continue;
      if (old.state !== 'open' && old.state !== 'packeted') continue;
      if (out.some((o) => o.id === old.id)) continue;
      out.push({ ...old, at, state: 'skipped', problem: 'A newer change to the page took its place.' });
    }
  }
  return out;
}

/** A new job, or null when the log has it (or the batch does). */
export function newJob(
  state: RippleState, made: readonly RippleJob[],
  fields: { source: RippleJob['source']; html: string; commit: string | null; origin: RippleJob['origin']; hop: number; parent?: string; at: string },
): RippleJob | null {
  if (fields.hop > LAST_HOP) return null;
  const hash = sourceHash(fields.html);
  const id = jobId(fields.source, hash, fields.hop, fields.parent);
  if (state.jobs.has(id) || made.some((j) => j.id === id)) return null;
  return {
    version: 1, type: 'job', id, at: fields.at, state: 'open', origin: fields.origin,
    source: fields.source, source_hash: hash, commit: fields.commit, hop: fields.hop,
    ...(fields.parent ? { parent: fields.parent } : {}),
  };
}

export async function reconcile(input: ReconcileInput): Promise<Reconciled> {
  const { state, wiki, head, changes, at } = input;
  const cursor = (commit: string | null): RippleCursor => ({ version: 1, type: 'cursor', id: 'cursor', at, commit, changes: changes.length });
  if (!state.cursor) return { records: [cursor(head)], made: [], baseline: true };
  const made: RippleJob[] = [];
  const take = (chId: string, html: string, origin: 'imported' | 'changed') => {
    const page = wiki?.pages.find((p) => p.chId === chId);
    if (!page || !wordsOf(html)) return;
    const job = newJob(state, made, { source: { bookId: wiki!.bookId, chId, title: page.title }, html, commit: head, origin, hop: 0, at });
    if (!job) return;
    // the page's later state in this same run is the one to judge
    const earlier = made.findIndex((j) => j.source.chId === chId);
    if (earlier !== -1) made.splice(earlier, 1);
    made.push(job);
  };

  if (wiki) {
    for (const change of changes.slice(state.cursor.changes)) {
      if (!change || change.kind !== 'page-imported' || change.bookId !== wiki.bookId) continue;
      const html = input.read(change.dest);
      if (html !== null) take(change.chId, html, 'imported');
    }
  }

  let moved = state.cursor.commit;
  if (wiki && head && state.cursor.commit && head !== state.cursor.commit) {
    try {
      const files = await input.changed(state.cursor.commit, head, `${wiki.bookId}/chapters/`);
      for (const { rel, byAuthor } of files) {
        if (!byAuthor) continue;
        const m = /\/chapters\/([^/]+)\.html$/.exec(rel);
        if (!m) continue;
        const after = await input.show(head, rel);
        if (after === null) continue;
        const before = await input.show(state.cursor.commit, rel);
        if (before !== null && wordsOf(before) === wordsOf(after)) continue;
        take(m[1]!, after, 'changed');
      }
    } catch (err) {
      // the cursor's commit is gone (history rewritten): start again from here
      input.log('warn', 'ripple: git could not say what changed since the last run, so it reads on from now', String(err));
    }
  }
  if (head) moved = head;

  const records: (RippleJob | RippleCursor)[] = [...superseded(state, made, at), ...made];
  if (moved !== state.cursor.commit || changes.length !== state.cursor.changes) records.push(cursor(moved));
  return { records, made, baseline: false };
}
