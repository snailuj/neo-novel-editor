// Ripple's one log, .neo/ripple/rulings.jsonl: jobs, the judge's proposals with the
// author's ruling on each, and how far reconcile has read. It is event-sourced, as
// hoard's RIPPLE.jsonl is: a change is a new line, and the newest line for an id is that
// id's state, so replaying a run after a kill repeats lines but never changes a ruling.
// There is no queue beside it: what is waiting is worked out from the log.
//
// The file is written whole each time (temporary file, fsync, rename), as every library
// file is; appends from one process wait for each other. A line that does not read
// stops the read rather than skewing the state, and nothing writes over the file until
// it is mended.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RippleCursor, RippleJob, RippleProposal, RippleRulingV1 } from '../../generated/ripple-ruling-v1.js';
import { validateRippleRulingV1 } from '../../generated/validators.cjs';
import { writeWhole } from '../files.ts';
import { plainText } from './contract.ts';

export type { RippleCursor, RippleJob, RippleProposal };

/** Ripple opens no job past this hop: a change made at hop 2 is a hop-3 change, and stops. */
export const LAST_HOP = 2;

export class RulingsError extends Error {
  constructor(file: string, why: string) {
    super(`${file} does not read as ripple's rulings (${why}); ripple waits until it is mended`);
    this.name = 'RulingsError';
  }
}

export interface RippleState {
  jobs: Map<string, RippleJob>;
  proposals: Map<string, RippleProposal>;
  cursor: RippleCursor | null;
  /** How many lines the file holds. */
  lines: number;
}

const short = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A job's id: the same source text at the same hop, from the same parent, is one job. */
export function jobId(source: { bookId: string; chId: string }, sourceHash: string, hop: number, parent?: string): string {
  return `j-${short(['job', source.bookId, source.chId, sourceHash, String(hop), parent ?? ''].join('\0'))}`;
}

/** A proposal's id: one answer file read twice yields the same ids. */
export function proposalId(job: string, kind: string, target: string, quote: string): string {
  return `r-${short(['proposal', job, kind, target, quote].join('\0'))}`;
}

// case, spacing and punctuation aside
const norm = (text: string) => plainText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// The pages a line links, so two wordings of one link line are one change.
const linked = (line: string) => [...new Set([...line.matchAll(/\[\[([^\]|#]*)/g)].map((m) => norm(m[1]!)))].sort().join('\n');

type Card = Pick<RippleProposal, 'kind' | 'source' | 'target'> & Partial<Pick<RippleProposal, 'anchor' | 'line'>>;

/**
 * What a card changes, wording and job aside: its kind, source and target page, and the
 * words a claim replaces, the pages a topic line links (or, with none, its words) or a
 * mint's title. A judge asked twice words one change differently, so a proposal's id,
 * which holds the quote and the job, does not find the earlier card (re-run test, 24 Oct).
 */
export function cardKey(p: Card): string {
  const what = p.kind === 'claim' ? norm(p.anchor ?? '') : p.kind === 'topic' ? linked(p.line ?? '') || norm(p.line ?? '') : '';
  return ['card', p.kind, p.source.bookId, p.source.chId, norm(p.target), what].join('\0');
}

/** The cards a new proposal must not repeat, by key: those waiting on the writer and those they rejected. */
export function heldCards(state: RippleState): Map<string, RippleProposal> {
  const held = new Map<string, RippleProposal>();
  for (const q of state.proposals.values()) {
    // an applied card is on its page now, where the judge reads it; a nothing is no card
    if (q.kind === 'nothing' || q.status === 'applied') continue;
    held.set(cardKey(q), q);
  }
  return held;
}

/** The earlier card a proposal repeats, or null. */
export function repeatOf(state: RippleState, p: RippleProposal, held = heldCards(state)): RippleProposal | null {
  if (p.kind === 'nothing') return null;
  const q = held.get(cardKey(p));
  return q && q.id !== p.id ? q : null;
}

/** The state the lines give: the newest line for each id. */
export function fold(text: string, file = 'rulings.jsonl'): RippleState {
  const state: RippleState = { jobs: new Map(), proposals: new Map(), cursor: null, lines: 0 };
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    state.lines++;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (err) {
      throw new RulingsError(file, `line ${i + 1}: ${(err as Error).message}`);
    }
    if (!validateRippleRulingV1(record)) {
      const why = (validateRippleRulingV1.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
      throw new RulingsError(file, `line ${i + 1}: ${why}`);
    }
    const r = record as RippleRulingV1;
    if (r.type === 'job') {
      state.jobs.delete(r.id); // a map keeps first-insertion order; a job moves to its newest line
      state.jobs.set(r.id, r);
    } else if (r.type === 'proposal') {
      state.proposals.delete(r.id);
      state.proposals.set(r.id, r);
    } else {
      state.cursor = r;
    }
  });
  return state;
}

/** The proposals of a job, in the order they first came. */
export function proposalsOf(state: RippleState, job: string): RippleProposal[] {
  return [...state.proposals.values()].filter((p) => p.job === job);
}

/**
 * Whether a job is finished: judged (or set aside) with every proposal applied or
 * rejected. A deferred proposal keeps its job open until the author rules on it.
 */
export function complete(state: RippleState, job: RippleJob): boolean {
  if (job.state === 'skipped') return true;
  if (job.state !== 'judged') return false;
  return proposalsOf(state, job.id).every((p) => p.status === 'applied' || p.status === 'rejected');
}

export class Rulings {
  readonly #file: () => string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(library: () => string) {
    this.#file = () => path.join(library(), '.neo', 'ripple', 'rulings.jsonl');
  }

  get file(): string {
    return this.#file();
  }

  /** The state as the file holds it now; an empty state before the first line. */
  read(): RippleState {
    const file = this.#file();
    return fold(existsSync(file) ? readFileSync(file, 'utf8') : '', file);
  }

  /** Appends lines, each checked first; resolves with the state they make. */
  append(records: readonly RippleRulingV1[]): Promise<RippleState> {
    const run = this.#queue.then(() => this.#append(records));
    this.#queue = run.catch(() => {});
    return run;
  }

  #append(records: readonly RippleRulingV1[]): RippleState {
    const file = this.#file();
    for (const r of records) {
      if (!validateRippleRulingV1(r)) throw new TypeError(`ripple: refusing to log ${JSON.stringify(r)}: ${JSON.stringify(validateRippleRulingV1.errors)}`);
    }
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    fold(before, file); // a file that does not read is never written over
    if (!records.length) return fold(before, file);
    const lead = before && !before.endsWith('\n') ? `${before}\n` : before;
    const text = lead + records.map((r) => `${JSON.stringify(r)}\n`).join('');
    writeWhole(file, text);
    return fold(text, file);
  }
}
