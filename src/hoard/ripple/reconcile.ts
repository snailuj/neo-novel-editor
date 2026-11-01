// Reconcile: which changes ripple has not yet taken a job for. It reads two things since
// its cursor: the change log's new page-imported and page-updated lines, and the pages
// under wiki/ and sources/ that the author's commits changed in git. Each becomes a hop-0
// job for the page as it stands, unless its words are the same as a job's already in the
// log (formatting aside), so running it twice makes nothing new. A newer job for a page
// sets the page's older waiting ones aside. The librarian's own commits are not changes
// here: a ripple change opens its next hop itself (engine.ts).
//
// The change log is read leniently, line by line as parsed: an attachment, a book import
// (which names a chapter, not a page) and a line that is not a page event make no job.
// The first run only sets the cursor, so a library that has pages already does not wake
// to a job for every page. Pure, but for what it is handed.
import { paragraphTexts } from '../html.ts';
import { plainText } from './contract.ts';
import { jobId, LAST_HOP, sha256, type RippleCursor, type RippleJob, type RippleState } from './rulings.ts';

export interface ReconcileInput {
  state: RippleState;
  /** The pages of both trees as they are now. */
  pages: readonly { id: string; title: string }[];
  /** The library's last commit; null with no history. */
  head: string | null;
  /** Every line of .neo/changes.jsonl, in order, as parsed; null for one that does not read. */
  changes: readonly unknown[];
  /** The files under a folder that commits from..to changed, as GitLayer.changed has it. */
  changed(from: string, to: string, under: string): Promise<{ rel: string; byAuthor: boolean }[]>;
  /** A file at a commit (a page id is its file), or null. */
  show(commit: string, rel: string): Promise<string | null>;
  /** A page's html as it is now, by its id, or null. */
  read(id: string): Promise<string | null>;
  at: string;
  log(level: 'warn' | 'info', message: string, data?: unknown): void;
}

export interface Reconciled {
  records: (RippleJob | RippleCursor)[];
  /** The new jobs among the records. */
  made: RippleJob[];
  baseline: boolean;
}

// A link's target and anchor are a name, not words: a rename rewrites them in other
// pages. A link keeps its shown text (`[[Old|shown]]`), which is words the author chose.
const LINK = /\[\[[^\]|#]*(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

/** A page's words as a job compares them: each paragraph's plain text with links reduced to their shown text, empty ones gone. */
export function wordsOf(html: string): string {
  return paragraphTexts(html).map((p) => plainText(p.replace(LINK, (_m, shown?: string) => (shown ? `\u27e6${shown}\u27e7` : '\u27e6link\u27e7')))).filter(Boolean).join('\n');
}

/** The hash a job keeps of its source's words. */
export const sourceHash = (html: string) => sha256(wordsOf(html));

/** The jobs an earlier, waiting job of the same page and hop gives way to. */
export function superseded(state: RippleState, made: readonly RippleJob[], at: string): RippleJob[] {
  const out: RippleJob[] = [];
  for (const job of made) {
    for (const old of state.jobs.values()) {
      if (old.id === job.id || old.hop !== job.hop || old.parent !== job.parent) continue;
      if (old.source.page !== job.source.page) continue;
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

const PAGE_EVENTS = new Set(['page-imported', 'page-updated']);
const TREES = ['wiki/', 'sources/'];

/** The page a change-log line says came in or was updated; null for any other line. */
export function pageEvent(line: unknown): string | null {
  if (typeof line !== 'object' || line === null) return null;
  const { kind, type, page } = line as Record<string, unknown>;
  const what = typeof kind === 'string' ? kind : type;
  return typeof what === 'string' && PAGE_EVENTS.has(what) && typeof page === 'string' ? page : null;
}

export async function reconcile(input: ReconcileInput): Promise<Reconciled> {
  const { state, pages, head, changes, at } = input;
  const cursor = (commit: string | null): RippleCursor => ({ version: 1, type: 'cursor', id: 'cursor', at, commit, changes: changes.length });
  if (!state.cursor) return { records: [cursor(head)], made: [], baseline: true };
  const made: RippleJob[] = [];
  const take = (id: string, html: string, origin: 'imported' | 'changed') => {
    const page = pages.find((p) => p.id === id);
    if (!page || !wordsOf(html)) return;
    const job = newJob(state, made, { source: { page: id, title: page.title }, html, commit: head, origin, hop: 0, at });
    if (!job) return;
    // the page's later state in this same run is the one to judge
    const earlier = made.findIndex((j) => j.source.page === id);
    if (earlier !== -1) made.splice(earlier, 1);
    made.push(job);
  };

  for (const line of changes.slice(state.cursor.changes)) {
    const id = pageEvent(line);
    if (id === null) continue;
    const html = await input.read(id);
    if (html !== null) take(id, html, 'imported');
  }

  let moved = state.cursor.commit;
  if (head && state.cursor.commit && head !== state.cursor.commit) {
    try {
      for (const under of TREES) {
        for (const { rel, byAuthor } of await input.changed(state.cursor.commit, head, under)) {
          if (!byAuthor || !pages.some((p) => p.id === rel)) continue;
          const after = await input.show(head, rel);
          if (after === null) continue;
          const before = await input.show(state.cursor.commit, rel);
          if (before !== null && wordsOf(before) === wordsOf(after)) continue;
          take(rel, after, 'changed');
        }
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
