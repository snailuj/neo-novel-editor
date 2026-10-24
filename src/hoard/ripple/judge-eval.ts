// Scores the ripple judge's arms against the author's tick sheets. The ticks say which
// pages the judge should see, not which need an edit, so every arm is read the same way:
// a ticked page the judge acted on (a claim or a topic) is caught, a page on the sheet
// but not ticked is false, and a page never on the sheet is unrated. Mints and targets
// that name no page are counted apart. Arms pair page by page against a baseline run
// with the exact McNemar test. Pure; judge-eval-cli.ts runs the arms.
import type { Proposed } from './contract.ts';
import type { Screen } from './screen.ts';
import { mcnemar } from './sheet.ts';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  ms: number;
}

export type Outcome =
  | { kind: 'judge'; proposals: Proposed[]; usage?: Usage }
  /** By candidate relpath. */
  | { kind: 'screen'; results: Map<string, Screen>; usage?: Usage }
  | { kind: 'failed'; why: string; usage?: Usage };

export interface EvalCase {
  slug: string;
  source: string;
  ticked: ReadonlySet<string>;
  /** Every page the sheet showed for the case. */
  shown: ReadonlySet<string>;
  /** A target's relpath in the case's corpus, as a [[link]] finds it. */
  resolve: (title: string) => string | null;
}

export interface CaseScore {
  acted: string[];
  lookedAt: string[];
  caught: number;
  false: number;
  unrated: number;
  mints: number;
  unresolved: string[];
}

/** Where a packet puts each page: as a full card, a locator line, or in the map only. */
export interface Placement {
  full: ReadonlySet<string>;
  locator: ReadonlySet<string>;
  map: ReadonlySet<string>;
  chars: number;
}

export interface Placed { full: number; locator: number; map: number; absent: number }

export interface EvalInput {
  cases: EvalCase[];
  runs: { run: string; arm: string; outcomes: Map<string, Outcome> }[];
  placements: { arm: string; byCase: Map<string, Placement> }[];
  /** The run every other is paired against. */
  baseline?: string;
}

export interface RunTotals extends Usage {
  run: string;
  arm: string;
  /** Cases answered, and cases whose answer failed. */
  cases: number;
  failed: number;
  ticked: number;
  caught: number;
  false: number;
  unrated: number;
  lookedAt: number;
  mints: number;
  unresolved: number;
  /** Calls whose usage is known. */
  calls: number;
}

export interface PairedRow { run: string; cases: number; caught: number; gained: number; lost: number; p: number }

export interface PlacementTotals extends Placed { arm: string; cases: number; meanChars: number }

export interface EvalReport {
  totals: RunTotals[];
  paired?: { baseline: string; rows: PairedRow[] };
  placement: PlacementTotals[];
  cases: {
    slug: string;
    source: string;
    ticked: number;
    runs: ({ run: string } & (CaseScore | { failed: string }))[];
    placement: ({ arm: string; chars: number } & Placed)[];
  }[];
  failures: { run: string; slug: string; why: string }[];
}

const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, ms: 0 };

/** One case's run as caught, false and unrated pages; null when the run failed. */
export function scoreOutcome(c: EvalCase, o: Outcome): CaseScore | null {
  if (o.kind === 'failed') return null;
  const acted = new Set<string>();
  const lookedAt = new Set<string>();
  const unresolved: string[] = [];
  let mints = 0;
  if (o.kind === 'screen') {
    for (const [rel, s] of o.results) if (s.affects) acted.add(rel);
  } else {
    for (const p of o.proposals) {
      if (p.kind === 'mint') { mints++; continue; }
      const rel = c.resolve(p.target);
      if (p.kind === 'nothing') { if (rel) lookedAt.add(rel); continue; }
      if (rel) acted.add(rel);
      else unresolved.push(p.target);
    }
  }
  const list = [...acted];
  return {
    acted: list,
    lookedAt: [...lookedAt],
    caught: list.filter((r) => c.ticked.has(r)).length,
    false: list.filter((r) => c.shown.has(r) && !c.ticked.has(r)).length,
    unrated: list.filter((r) => !c.shown.has(r)).length,
    mints,
    unresolved,
  };
}

/** Each ticked page in the best place the packet gives it. */
export function placeTicked(c: EvalCase, p: Placement): Placed {
  const out: Placed = { full: 0, locator: 0, map: 0, absent: 0 };
  for (const rel of c.ticked) out[p.full.has(rel) ? 'full' : p.locator.has(rel) ? 'locator' : p.map.has(rel) ? 'map' : 'absent']++;
  return out;
}

export function scoreEval(input: EvalInput): EvalReport {
  const failures: EvalReport['failures'] = [];
  const scores = new Map<string, Map<string, CaseScore | null>>();
  const totals = input.runs.map((r): RunTotals => {
    const t: RunTotals = { run: r.run, arm: r.arm, cases: 0, failed: 0, ticked: 0, caught: 0, false: 0, unrated: 0, lookedAt: 0, mints: 0, unresolved: 0, calls: 0, ...ZERO };
    const byCase = new Map<string, CaseScore | null>();
    for (const c of input.cases) {
      const o = r.outcomes.get(c.slug);
      if (!o) continue;
      if (o.usage) {
        t.calls++;
        for (const k of Object.keys(ZERO) as (keyof Usage)[]) t[k] += o.usage[k];
      }
      const s = scoreOutcome(c, o);
      byCase.set(c.slug, s);
      if (!s) {
        t.failed++;
        failures.push({ run: r.run, slug: c.slug, why: (o as { why: string }).why });
        continue;
      }
      t.cases++;
      t.ticked += c.ticked.size;
      t.caught += s.caught;
      t.false += s.false;
      t.unrated += s.unrated;
      t.lookedAt += s.lookedAt.length;
      t.mints += s.mints;
      t.unresolved += s.unresolved.length;
    }
    scores.set(r.run, byCase);
    return t;
  });

  let paired: EvalReport['paired'];
  if (input.baseline !== undefined) {
    const base = scores.get(input.baseline);
    if (!base) throw new Error(`no run is named ${input.baseline} (runs: ${[...scores.keys()].join(', ') || 'none'})`);
    // Pages pair within a case, and only where both runs answered it.
    const rows = input.runs.map((r): PairedRow => {
      const row: PairedRow = { run: r.run, cases: 0, caught: 0, gained: 0, lost: 0, p: 1 };
      for (const c of input.cases) {
        const mine = scores.get(r.run)!.get(c.slug);
        const theirs = base.get(c.slug);
        if (!mine || !theirs) continue;
        const a = new Set(mine.acted.filter((x) => c.ticked.has(x)));
        const b = new Set(theirs.acted.filter((x) => c.ticked.has(x)));
        row.cases++;
        row.caught += a.size;
        row.gained += [...a].filter((x) => !b.has(x)).length;
        row.lost += [...b].filter((x) => !a.has(x)).length;
      }
      row.p = mcnemar(row.gained, row.lost);
      return row;
    });
    paired = { baseline: input.baseline, rows };
  }

  const placement = input.placements.map(({ arm, byCase }): PlacementTotals => {
    const t: PlacementTotals = { arm, cases: 0, meanChars: 0, full: 0, locator: 0, map: 0, absent: 0 };
    let chars = 0;
    for (const c of input.cases) {
      const p = byCase.get(c.slug);
      if (!p) continue;
      const placed = placeTicked(c, p);
      t.cases++;
      chars += p.chars;
      for (const k of ['full', 'locator', 'map', 'absent'] as const) t[k] += placed[k];
    }
    t.meanChars = t.cases ? Math.round(chars / t.cases) : 0;
    return t;
  });

  const cases = input.cases.map((c) => ({
    slug: c.slug,
    source: c.source,
    ticked: c.ticked.size,
    runs: input.runs.flatMap((r) => {
      const o = r.outcomes.get(c.slug);
      if (!o) return [];
      const s = scores.get(r.run)!.get(c.slug);
      return [s ? { run: r.run, ...s } : { run: r.run, failed: (o as { why: string }).why }];
    }),
    placement: input.placements.flatMap(({ arm, byCase }) => {
      const p = byCase.get(c.slug);
      return p ? [{ arm, chars: p.chars, ...placeTicked(c, p) }] : [];
    }),
  }));
  return { totals, paired, placement, cases, failures };
}

const fmtP = (p: number): string => (p < 0.001 ? '<0.001' : p.toFixed(3));
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderEval(report: EvalReport, notes: readonly string[] = []): string {
  const out = [
    '# Ripple judge eval',
    '',
    'Caught counts ticked pages a run acted on (a claim or a topic line; for the screen, a yes). False counts pages on the sheet that were not ticked; unrated, pages never on the sheet. The ticks say which pages the judge should see, not which need an edit.',
    ...notes.flatMap((n) => ['', n]),
  ];
  if (report.totals.length) {
    out.push('', '## All cases', '',
      '| Run | Cases | Ticked pages caught | False | Unrated | Looked at | Mints | Unresolved | Failed | Input tokens | Cache read | Output tokens | Cost (USD) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...report.totals.map((t) => `| ${t.run} | ${t.cases} | ${t.caught} of ${t.ticked} | ${t.false} | ${t.unrated} | ${t.lookedAt} | ${t.mints} | ${t.unresolved} | ${t.failed} | ${t.inputTokens + t.cacheWriteTokens} | ${t.cacheReadTokens} | ${t.outputTokens} | ${t.costUsd.toFixed(2)} |`));
  }
  if (report.paired) {
    out.push('', `## Against ${report.paired.baseline}`, '',
      'Gained and lost count ticked pages this run acted on and the baseline did not, or the reverse, case by case, over the cases both answered. p is the exact McNemar test on those pages. The baseline arm run twice gives the noise floor: an arm that moves less than that has shown nothing.',
      '', '| Run | Cases | Ticked pages caught | Gained | Lost | p |', '| --- | --- | --- | --- | --- | --- |',
      ...report.paired.rows.map((r) => `| ${r.run} | ${r.cases} | ${r.caught} | ${r.gained} | ${r.lost} | ${fmtP(r.p)} |`));
  }
  if (report.placement.length) {
    out.push('', '## Where the ticked pages sit', '',
      'Each ticked page in the best place an arm\'s packet gives it: a full card, a locator line, the wiki map only, or nowhere. Packet sizes are characters, not tokens (mean per case).',
      '', '| Arm | Cases | Full card | Locator | Map only | Absent | Packet chars |', '| --- | --- | --- | --- | --- | --- | --- |',
      ...report.placement.map((p) => `| ${p.arm} | ${p.cases} | ${p.full} | ${p.locator} | ${p.map} | ${p.absent} | ${p.meanChars} |`));
  }
  if (report.failures.length) {
    out.push('', '## Runs that failed', '', 'A failed run is left out of its totals and of every pairing for that case.', '',
      '| Run | Case | Why |', '| --- | --- | --- |',
      ...report.failures.map((f) => `| ${f.run} | ${f.slug} | ${cell(f.why)} |`));
  }
  report.cases.forEach((c, i) => {
    out.push('', `## Case ${i + 1}: ${c.source}`, '', `${c.ticked} ticked pages.`);
    if (c.runs.length) {
      out.push('', '| Run | Caught | False | Unrated | Looked at | Mints | Unresolved |', '| --- | --- | --- | --- | --- | --- | --- |',
        ...c.runs.map((r) => ('failed' in r
          ? `| ${r.run} | failed: ${cell(r.failed)} | | | | | |`
          : `| ${r.run} | ${r.caught} | ${r.false} | ${r.unrated} | ${r.lookedAt.length} | ${r.mints} | ${cell(r.unresolved.join(', '))} |`)));
    }
    if (c.placement.length) {
      out.push('', '| Arm | Full card | Locator | Map only | Absent | Packet chars |', '| --- | --- | --- | --- | --- | --- |',
        ...c.placement.map((p) => `| ${p.arm} | ${p.full} | ${p.locator} | ${p.map} | ${p.absent} | ${p.chars} |`));
    }
  });
  return `${out.join('\n')}\n`;
}
