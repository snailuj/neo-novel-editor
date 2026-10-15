// The hand-reading sheet for choosing ripple's shortlist method. Past rulings are a
// noisy key (two runs of one judge agreed on 8 of 24 targets by kind), so the author
// reads the lists instead. The sheet hides which list is which; the key says.
import { key as linkKey } from '../../librarian/links.ts';
import { card, packetChars, type Corpus, type Ranked } from './shortlist.ts';

export interface SheetList {
  method: string;
  ranked: Ranked[];
}

export interface SheetCase {
  source: string;
  corpus: Corpus;
  lists: SheetList[];
  /** Link keys of the pages past rulings changed for this source. */
  pastTargets: string[];
  rosterChars: number;
  briefChars: number;
  sourceChars: number;
  /** The commit the corpus was read at, when read from git. */
  readAt?: string;
}

export interface KeyList {
  letter: string;
  method: string;
  size: number;
  packetChars: number;
  pastCaught: number;
}

export interface Key {
  seed: number;
  note: string;
  cases: { source: string; readAt?: string; pastTargets: string[]; wholeRosterPacketChars: number; lists: KeyList[] }[];
}

interface Ruling {
  id?: unknown;
  kind?: unknown;
  status?: unknown;
  source?: unknown;
  target?: unknown;
  hop?: unknown;
}

// Hoard's RIPPLE.jsonl is event-sourced: the newest record for an id is that id's state
// (R/store.py:92-97). A line that does not read stops the run rather than skewing it.
function latest(log: string): Ruling[] {
  const byId = new Map<string, Ruling>();
  log.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let record: Ruling;
    try {
      record = JSON.parse(line) as Ruling;
    } catch (err) {
      throw new Error(`rulings log line ${i + 1} does not read: ${(err as Error).message}`, { cause: err });
    }
    byId.set(String(record.id), record);
  });
  return [...byId.values()];
}

function applied(r: Ruling): boolean {
  return r.status === 'applied' && r.hop === 0 && typeof r.target === 'string'
    && typeof r.source === 'string' && r.kind !== 'nothing' && r.kind !== 'packet';
}

/** Pages the applied hop-0 rulings of a source changed, as link keys. */
export function pastTargets(log: string, source: string): string[] {
  const want = linkKey(source);
  return [...new Set(latest(log).filter((r) => applied(r) && linkKey(r.source as string) === want)
    .map((r) => linkKey(r.target as string)))];
}

/** The `n` sources with the most applied hop-0 rulings, ties by path. */
export function pickSources(log: string, n: number): string[] {
  const counts = new Map<string, number>();
  for (const r of latest(log).filter(applied)) counts.set(r.source as string, (counts.get(r.source as string) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([s]) => s);
}

// A small seeded generator (mulberry32), so the same seed gives the same letters.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const LETTERS = 'ABCDEFGH';

/**
 * The sheet shows each page by name and gloss only, the same in every list, so neither
 * a reason nor a passage gives a list's method away. The key holds what the judge's
 * packet would cost with each list, in characters.
 */
export function buildSheet(cases: SheetCase[], seed: number): { sheet: string; key: Key } {
  const next = random(seed);
  const out: string[] = [
    '# Ripple shortlist: hand-reading sheet',
    '',
    'For each case, read the source, then tick every page the judge should see when it decides what this source changes. Then rank the lists, best first. key.json says which list is which; read it only afterwards.',
  ];
  const key: Key = {
    seed,
    note: 'Characters, not tokens. pastCaught counts past applied hop-0 targets in the list; past rulings are a noisy key.',
    cases: [],
  };
  cases.forEach((c, n) => {
    const lists = shuffled(c.lists, next);
    out.push('', `## Case ${n + 1}: ${c.source}`, '');
    if (c.readAt) out.push(`Read as the vault stood at ${c.readAt.slice(0, 12)}, before the source came in.`, '');
    const keyLists: KeyList[] = [];
    lists.forEach((list, i) => {
      const letter = LETTERS[i]!;
      out.push(`### List ${letter} (${list.ranked.length} pages)`, '');
      for (const r of list.ranked) {
        const doc = c.corpus.byRel.get(r.relpath);
        out.push(`- [ ] [[${doc?.name ?? r.relpath}]]: ${doc?.gloss ?? ''}`);
      }
      out.push('');
      const cards = list.ranked.flatMap((r) => {
        const doc = c.corpus.byRel.get(r.relpath);
        return doc ? [card(doc, r)] : [];
      });
      const caught = new Set(list.ranked.map((r) => linkKey(r.relpath)));
      keyLists.push({
        letter,
        method: list.method,
        size: list.ranked.length,
        packetChars: packetChars(cards, c.sourceChars, c.briefChars),
        pastCaught: c.pastTargets.filter((t) => caught.has(t)).length,
      });
    });
    out.push(`Lists best to worst: ${lists.map((_l, i) => LETTERS[i]).join(', ')} (reorder)`, '', 'Notes:', '');
    key.cases.push({
      source: c.source,
      readAt: c.readAt,
      pastTargets: c.pastTargets,
      wholeRosterPacketChars: c.briefChars + c.sourceChars + c.rosterChars,
      lists: keyLists,
    });
  });
  return { sheet: `${out.join('\n')}\n`, key };
}
