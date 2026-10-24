// The hand-reading sheet for choosing ripple's shortlist method. Past rulings are a
// noisy key (two runs of one judge agreed on 8 of 24 targets by kind), so the author
// reads the candidates instead. The sheet hides which list held a page; the key says.
import { key as linkKey } from '../../librarian/links.ts';
import { card, packetChars, rrf, type Corpus, type Ranked } from './shortlist.ts';

export { rrf };

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
  method: string;
  /** The list's pages, best first. */
  pages: string[];
  packetChars: number;
  pastCaught: number;
}

export interface Key {
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

/** The `n` sources with the most applied hop-0 rulings, ties by path, leaving out `skip`. */
export function pickSources(log: string, n: number, skip: readonly string[] = []): string[] {
  const counts = new Map<string, number>();
  for (const r of latest(log).filter(applied)) counts.set(r.source as string, (counts.get(r.source as string) ?? 0) + 1);
  const skipped = new Set(skip.map(linkKey));
  return [...counts].filter(([s]) => !skipped.has(linkKey(s)))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([s]) => s);
}

/**
 * Every page any list holds, once, in name order, with its path and gloss: nothing on a
 * row says which list put it there or where it ranked. The key keeps each list's pages
 * and what the judge's packet would cost with it, in characters.
 */
export function buildSheet(cases: SheetCase[], seen?: Map<string, Set<string>>): { sheet: string; key: Key } {
  const out: string[] = [
    '# Ripple shortlist: hand-reading sheet',
    '',
    'For each case, read the source, then tick (`[x]`) every page the judge should see when it decides what this source changes. Leave the rest. Then run the score step; key.json says which method listed which page.',
  ];
  // A top-up sheet leaves out the pages an earlier sheet already showed for the case, so
  // the author reads only what is new; the score step reads both sheets' ticks together.
  if (seen) out.push('', 'This sheet holds only pages the earlier sheets did not show. Score it together with them.');
  const key: Key = {
    note: 'Characters, not tokens. pastCaught counts past applied hop-0 targets in the list; past rulings are a noisy key.',
    cases: [],
  };
  cases.forEach((c, n) => {
    out.push('', `## Case ${n + 1}: ${c.source}`, '');
    if (c.readAt) out.push(`Read as the vault stood at ${c.readAt.slice(0, 12)}, before the source came in.`, '');
    const union = new Map<string, string>();
    for (const list of c.lists) for (const r of list.ranked) union.set(r.relpath, c.corpus.byRel.get(r.relpath)?.name ?? r.relpath);
    const done = seen?.get(linkKey(c.source));
    const rows = [...union].filter(([rel]) => !done?.has(rel)).sort((a, b) => a[1].localeCompare(b[1]) || (a[0] < b[0] ? -1 : 1));
    for (const [rel, name] of rows) out.push(`- [ ] [[${name}]] (${rel}): ${c.corpus.byRel.get(rel)?.gloss ?? ''}`);
    out.push('', 'Notes:', '');
    key.cases.push({
      source: c.source,
      readAt: c.readAt,
      pastTargets: c.pastTargets,
      wholeRosterPacketChars: c.briefChars + c.sourceChars + c.rosterChars,
      lists: c.lists.map((list) => {
        const cards = list.ranked.flatMap((r) => {
          const doc = c.corpus.byRel.get(r.relpath);
          return doc ? [card(doc, r)] : [];
        });
        const held = new Set(list.ranked.map((r) => linkKey(r.relpath)));
        return {
          method: list.method,
          pages: list.ranked.map((r) => r.relpath),
          packetChars: packetChars(cards, c.sourceChars, c.briefChars),
          pastCaught: c.pastTargets.filter((t) => held.has(t)).length,
        };
      }),
    });
  });
  return { sheet: `${out.join('\n')}\n`, key };
}

/**
 * Adds, per case, the roster's list joined with the first `extra` pages of each other
 * single-method list that the roster lacks, and with each pair of them. Every page in a
 * union was on the sheet, so the ticks already score it. Its packet is estimated pro
 * rata from the roster's.
 */
export function withUnions(key: Key, extra: number): Key {
  return {
    ...key,
    cases: key.cases.map((c) => {
      const roster = c.lists.find((l) => l.method === 'roster');
      if (!roster) return c;
      const singles = c.lists.filter((l) => l !== roster && !l.method.startsWith('blend'));
      const join = (fills: KeyList[]): KeyList => {
        const pages = [...roster.pages];
        for (const fill of fills) pages.push(...fill.pages.filter((p) => !pages.includes(p)).slice(0, extra));
        return {
          method: `roster + ${extra} ${fills.map((f) => f.method).join(' + ')}`,
          pages,
          packetChars: Math.round(roster.packetChars * pages.length / (roster.pages.length || 1)),
          pastCaught: 0,
        };
      };
      // each model alone, then each pair, the second taking its N after the first's
      const pairs = singles.flatMap((a, i) => singles.slice(i + 1).map((b) => [a, b]));
      return { ...c, lists: [...c.lists, ...singles.map((l) => join([l])), ...pairs.map(join)] };
    }),
  };
}

/**
 * Adds, per case and per model, the roster's first `rosterCut` pages (all of them by
 * default) then `fill` pages from the fusion of lexical and the model, and the fusion of
 * all three cut to the same size. A page cut from the roster may come back on its fused
 * rank. Like a union, every page was on the sheet.
 */
export function withFusion(key: Key, fill: number, rosterCut?: number, k = 60): Key {
  const label = rosterCut === undefined ? 'roster' : `roster ${rosterCut}`;
  return {
    ...key,
    cases: key.cases.map((c) => {
      const roster = c.lists.find((l) => l.method === 'roster');
      const lexical = c.lists.find((l) => l.method === 'lexical');
      if (!roster || !lexical) return c;
      const kept = roster.pages.slice(0, rosterCut ?? roster.pages.length);
      const size = kept.length + fill;
      const packetChars = Math.round(roster.packetChars * size / (roster.pages.length || 1));
      const models = c.lists.filter((l) => l.method.startsWith('embedding '));
      const fused = models.flatMap((m): KeyList[] => {
        const extra = rrf([lexical.pages, m.pages], k).filter((p) => !kept.includes(p)).slice(0, fill);
        return [
          { method: `${label} + ${fill} rrf(lexical, ${m.method})`, pages: [...kept, ...extra], packetChars, pastCaught: 0 },
          { method: `rrf(roster, lexical, ${m.method}) to ${label} + ${fill}`, pages: rrf([roster.pages, lexical.pages, m.pages], k).slice(0, size), packetChars, pastCaught: 0 },
        ];
      });
      return { ...c, lists: [...c.lists, ...fused] };
    }),
  };
}

/**
 * This key's cases with another key's lists added under `prefix`, paired by source, so a
 * run with another chunking or ranking scores page by page against the run it changes.
 */
export function mergeKeys(key: Key, other: Key, prefix: string): Key {
  const theirs = new Map(other.cases.map((c) => [linkKey(c.source), c]));
  return {
    ...key,
    cases: key.cases.map((c) => {
      const match = theirs.get(linkKey(c.source));
      if (!match) throw new Error(`the baseline key has no case for ${c.source}`);
      return { ...c, lists: [...c.lists, ...match.lists.map((l) => ({ ...l, method: prefix + l.method }))] };
    }),
  };
}

/**
 * Exact two-sided McNemar test on the discordant pages: the chance of a split at least
 * this uneven if either list were as likely to catch a page the other missed.
 */
export function mcnemar(gained: number, lost: number): number {
  const n = gained + lost;
  let tail = 0;
  let choose = 1;
  for (let i = 0; i <= Math.min(gained, lost); i++) {
    tail += choose;
    choose = choose * (n - i) / (i + 1);
  }
  return Math.min(1, 2 * tail / 2 ** n);
}

export interface PairedRow {
  method: string;
  size: number;
  caught: number;
  /** Ticked pages this list caught and the baseline missed, summed over cases. */
  gained: number;
  lost: number;
  p: number;
}

export interface ListScore {
  method: string;
  size: number;
  /** Ticked pages the list held. */
  caught: number;
  ticked: number;
  /** Pages of the list the sheet never showed, as when a later run is scored on older ticks. */
  unrated: number;
  recall: number;
  /** Over the pages the sheet showed. */
  precision: number;
  packetChars: number;
}

export interface Score {
  cases: { source: string; ticked: number; lists: ListScore[] }[];
  totals: ListScore[];
  paired?: { baseline: string; rows: PairedRow[] };
}

// A row ends its path with "): " and the gloss follows, so a path holding brackets, as
// hoard's `Era-(project).md` hubs do, still reads whole.
const ROW = /^- \[([ xX])\] \[\[[^\]]*\]\] \((.+?)\): /;
const CASE = /^## Case \d+: (.*)$/;

interface Section { shown: Set<string>; ticked: Set<string> }

/**
 * Each case's shown and ticked pages, keyed by the source's link key. A case that comes
 * twice, as when an earlier sheet and its top-up are read together, is one case.
 */
export function readSheet(sheet: string): { sections: Map<string, Section>; headings: string[] } {
  const sections = new Map<string, Section>();
  const headings: string[] = [];
  let current: Section | null = null;
  for (const line of sheet.split('\n')) {
    const heading = CASE.exec(line);
    if (heading) {
      // The author may rewrite a heading as a link to the source; both pair by link key.
      const name = heading[1]!.trim();
      const id = linkKey(name.replace(/^\[\[(.*)\]\]$/, '$1'));
      headings.push(name);
      current = sections.get(id) ?? { shown: new Set(), ticked: new Set() };
      sections.set(id, current);
      continue;
    }
    const m = ROW.exec(line);
    if (!m || !current) continue;
    current.shown.add(m[2]!);
    if (m[1] !== ' ') current.ticked.add(m[2]!);
  }
  return { sections, headings };
}

/**
 * The author's ticks against each list: recall over ticked pages, precision over the
 * pages shown. Cases pair by source, so a sheet ticked for one run scores another's key.
 */
export function scoreSheet(sheet: string, key: Key, baseline?: string): Score {
  const { sections, headings } = readSheet(sheet);
  const rate = (a: number, b: number): number => (b ? a / b : 0);
  const cases = key.cases.map((c) => {
    const section = sections.get(linkKey(c.source));
    if (!section) throw new Error(`the sheet has no case for ${c.source} (its cases: ${headings.join(', ') || 'none'})`);
    const { shown, ticked } = section;
    return {
      source: c.source,
      ticked: ticked.size,
      lists: c.lists.map((l): ListScore => {
        const caught = l.pages.filter((p) => ticked.has(p)).length;
        const unrated = l.pages.filter((p) => !shown.has(p)).length;
        return {
          method: l.method, size: l.pages.length, caught, ticked: ticked.size, unrated,
          recall: rate(caught, ticked.size), precision: rate(caught, l.pages.length - unrated), packetChars: l.packetChars,
        };
      }),
    };
  });
  const methods = [...new Set(cases.flatMap((c) => c.lists.map((l) => l.method)))];
  const totals = methods.map((method): ListScore => {
    const ls = cases.flatMap((c) => c.lists.filter((l) => l.method === method));
    const sum = (f: (l: ListScore) => number): number => ls.reduce((s, l) => s + f(l), 0);
    return {
      method, size: sum((l) => l.size), caught: sum((l) => l.caught), ticked: sum((l) => l.ticked), unrated: sum((l) => l.unrated),
      recall: rate(sum((l) => l.caught), sum((l) => l.ticked)),
      precision: rate(sum((l) => l.caught), sum((l) => l.size - l.unrated)),
      packetChars: Math.round(rate(sum((l) => l.packetChars), ls.length)),
    };
  });
  if (baseline === undefined) return { cases, totals };
  if (!methods.includes(baseline)) throw new Error(`no list is named ${baseline} (lists: ${methods.join(', ')})`);
  // Pages pair within a case: a page ticked for one source says nothing about another.
  const rows = methods.map((method): PairedRow => {
    let gained = 0;
    let lost = 0;
    let caught = 0;
    let size = 0;
    for (const c of key.cases) {
      const ticked = sections.get(linkKey(c.source))!.ticked;
      const pages = c.lists.find((l) => l.method === method)?.pages;
      if (!pages) continue;
      const mine = new Set(pages.filter((p) => ticked.has(p)));
      const theirs = new Set((c.lists.find((l) => l.method === baseline)?.pages ?? []).filter((p) => ticked.has(p)));
      gained += [...mine].filter((p) => !theirs.has(p)).length;
      lost += [...theirs].filter((p) => !mine.has(p)).length;
      caught += mine.size;
      size += pages.length;
    }
    return { method, size, caught, gained, lost, p: mcnemar(gained, lost) };
  });
  return { cases, totals, paired: { baseline, rows } };
}

function table(rows: ListScore[]): string[] {
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  return [
    '| Method | Ticked pages caught | Recall | Precision | Not on the sheet | Packet chars |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((l) => `| ${l.method} | ${l.caught} of ${l.ticked} | ${pct(l.recall)} | ${pct(l.precision)} | ${l.unrated} | ${l.packetChars} |`),
  ];
}

export function renderScore(score: Score): string {
  const out = [
    '# Ripple shortlist: scores',
    '',
    'Recall is the share of ticked pages a list held; precision is the share of a list that was ticked. Packet sizes are characters, not tokens (mean per case in the totals).',
    '',
    '## All cases',
    '',
    ...table(score.totals),
  ];
  if (score.paired) {
    out.push('', `## Against ${score.paired.baseline}`, '',
      'Gained and lost count ticked pages this list caught and the baseline missed, or the reverse, case by case. p is the exact McNemar test on those pages: below 0.05 means a split that uneven is unlikely by chance.',
      '', '| Method | Pages listed | Ticked pages caught | Gained | Lost | p |', '| --- | --- | --- | --- | --- | --- |',
      ...score.paired.rows.map((r) => `| ${r.method} | ${r.size} | ${r.caught} | ${r.gained} | ${r.lost} | ${r.p < 0.001 ? '<0.001' : r.p.toFixed(3)} |`));
  }
  score.cases.forEach((c, i) => out.push('', `## Case ${i + 1}: ${c.source}`, '', ...table(c.lists)));
  return `${out.join('\n')}\n`;
}
