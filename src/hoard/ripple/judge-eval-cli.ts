// npm run ripple:judge-eval -- --vault <hoard> --scored <folder holding key.json>
//   [--ticks <sheet.md> ...] --out <folder> [--arms base,base,screen,screened,budget,wide,map]
//   [--dry-run] [--model opus] [--screen-model opus] [--embed <model>[#titles]]
//   [--map-chars 12000] [--jobs 4] [--cases <n>] [--claude <command>] [--tools <list>]
// Runs the judge arms of plans/ripple-judge-tweaks.md over the scorer's cases and scores
// them against the tick sheets. Each case's corpus is rebuilt from git as it stood before
// its source came in, and exported to <out>/libs/<case> with the default brief, so the
// judge reads that and never the vault. --dry-run builds every packet and scores where
// the ticked pages sit, with no model call. Every call is cached, so a rerun skips
// finished work. A spike for choosing ripple's packet; not part of the app.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FrontmatterError, split } from '../../librarian/frontmatter.ts';
import { key as linkKey } from '../../librarian/links.ts';
import { ownerOf } from '../review/owner.ts';
import { AnswerError, readAnswer, type Brief } from './contract.ts';
import { EmbedderMissing, GEMMA, loadEmbedder } from './embedder.ts';
import { DEFAULT_BRIEF } from './engine.ts';
import { renderEval, scoreEval, wideShortlist, type EvalCase, type Outcome, type Placement, type Usage } from './judge-eval.ts';
import { wikiMap, type WikiMap } from './map.ts';
import { buildPacket, shortlistFor, type Packet, type PacketInput } from './packet.ts';
import type { WikiPage } from './pages.ts';
import { sha256, type RippleJob } from './rulings.ts';
import { readScreen, screenPrompt, type Screen } from './screen.ts';
import { readSheet, type Key } from './sheet.ts';
import { buildCorpus, embeddingRank, lexicalRank, rosterRank, type Corpus, type Embed, type Ranked, type Source } from './shortlist.ts';
import { readSnapshot } from './snapshot.ts';

export class UsageError extends Error {}

/** One process: the command, its arguments, what goes on stdin, and where it runs. */
export type Runner = (call: { command: string; args: string[]; stdin: string; cwd: string }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const spawnRunner: Runner = ({ command, args, stdin, cwd }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (b: Buffer) => out.push(b));
  child.stderr.on('data', (b: Buffer) => err.push(b));
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  child.stdin.end(stdin);
});

const ARMS = ['base', 'screen', 'screened', 'budget', 'wide', 'map'] as const;
type Arm = typeof ARMS[number];
// The judge must hash the brief for its preflight, so it may run a hash command and no other.
const JUDGE_TOOLS = 'Read,Grep,Glob,Write,Bash(sha256sum:*),Bash(shasum:*)';

interface Prepared {
  c: EvalCase;
  lib: string;
  corpus: Corpus;
  source: Source;
  byPath: Map<string, WikiPage>;
  job: RippleJob;
  base: { ranked: Ranked[]; modelled: boolean };
  wide: Ranked[];
  baseChars: number;
  map: WikiMap;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const stem = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/, '');

function ownerOfText(text: string): WikiPage['owner'] {
  try {
    return ownerOf(split(text).fm);
  } catch (err) {
    if (err instanceof FrontmatterError) return 'author'; // as a sidecar that does not read
    throw err;
  }
}

// With "verbose": true in the user's settings, `claude -p --output-format json` prints every
// message as an array; the result object is its last `result` entry.
function resultOf(stdout: string): Record<string, any> {
  const json = JSON.parse(stdout) as Record<string, any> | Record<string, any>[];
  if (!Array.isArray(json)) return json;
  const result = json.findLast((m) => m?.['type'] === 'result');
  if (!result) throw new Error('claude printed no result entry');
  return result;
}

function usageOf(json: Record<string, any>): Usage {
  const u = json['usage'] ?? {};
  return {
    inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    costUsd: json['total_cost_usd'] ?? 0, ms: json['duration_ms'] ?? 0,
  };
}

function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return { ...b };
  return {
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: a.costUsd + b.costUsd, ms: a.ms + b.ms,
  };
}

async function pool<T>(items: readonly T[], jobs: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

const tail = (text: string) => text.trim().split('\n').slice(-3).join(' ').slice(0, 300);

export async function main(argv: string[], deps: { runner?: Runner; log?: (message: string) => void } = {}): Promise<void> {
  const log = deps.log ?? ((m: string) => { process.stderr.write(`ripple-judge-eval: ${m}\n`); });
  const runner = deps.runner ?? spawnRunner;
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      scored: { type: 'string' },
      ticks: { type: 'string', multiple: true },
      out: { type: 'string' },
      arms: { type: 'string', default: 'base,base,screen,screened,budget,wide,map' },
      'dry-run': { type: 'boolean', default: false },
      model: { type: 'string', default: 'opus' },
      'screen-model': { type: 'string', default: 'opus' },
      embed: { type: 'string' },
      'map-chars': { type: 'string', default: '12000' },
      jobs: { type: 'string', default: '4' },
      cases: { type: 'string' },
      claude: { type: 'string', default: 'claude' },
      tools: { type: 'string', default: JUDGE_TOOLS },
      dtype: { type: 'string', default: GEMMA.dtype },
      pooling: { type: 'string', default: GEMMA.pooling },
      device: { type: 'string' },
    },
  });
  if (!values.vault || !values.scored || !values.out) throw new UsageError('--vault, --scored and --out are required');
  const vault = path.resolve(values.vault);
  const out = path.resolve(values.out);
  if (inside(out, vault) || inside(vault, out)) throw new UsageError(`refusing to write inside the vault: ${out}`);
  const mapChars = Number(values['map-chars']);
  const jobs = Number(values.jobs);
  if (!(mapChars > 0) || !(jobs >= 1)) throw new UsageError('--map-chars and --jobs take numbers');
  const arms = values.arms.split(',').map((a) => a.trim()).filter(Boolean);
  for (const a of arms) if (!(ARMS as readonly string[]).includes(a)) throw new UsageError(`no arm is named ${a} (arms: ${ARMS.join(', ')})`);
  // base,base is runs 1 and 2 of base
  const seen = new Map<string, number>();
  const runs = arms.map((arm) => {
    const n = (seen.get(arm) ?? 0) + 1;
    seen.set(arm, n);
    return { arm: arm as Arm, name: `${arm}-${n}` };
  });
  const dry = values['dry-run'];
  const tools = values.tools.split(',').map((x) => x.trim()).filter(Boolean);

  let key = JSON.parse(readFileSync(path.join(path.resolve(values.scored), 'key.json'), 'utf8')) as Key;
  if (values.cases) {
    if (!(Number(values.cases) >= 1)) throw new UsageError('--cases takes a number');
    key = { ...key, cases: key.cases.slice(0, Number(values.cases)) };
  }
  const ticks = values.ticks?.length ? values.ticks.map((t) => path.resolve(t)) : [path.join(path.resolve(values.scored), 'sheet.md')];
  const { sections, headings } = readSheet(ticks.map((t) => readFileSync(t, 'utf8')).join('\n'));
  mkdirSync(out, { recursive: true });

  let embed: Embed | undefined;
  if (values.embed) {
    const [model, flag] = values.embed.split('#') as [string, string | undefined];
    if (flag !== undefined && flag !== 'titles') throw new UsageError(`--embed ${values.embed}: the only flag is #titles`);
    try {
      embed = await loadEmbedder({
        model, titles: flag === 'titles', pooling: values.pooling, dtype: values.dtype, device: values.device,
        cacheFile: path.join(out, `embed-cache-${model.replace(/[^\w.-]+/g, '_')}-${values.dtype}.jsonl`),
      }, log);
    } catch (err) {
      if (err instanceof EmbedderMissing) throw new UsageError(`--embed ${err.message}`);
      throw err;
    }
  } else {
    log('WARNING: no --embed, so the model extras are missing: base lacks its ten model pages and wide fuses lexical alone. Arms still compare with each other, not with the app.');
  }

  const brief: Brief = { text: DEFAULT_BRIEF, sha256: sha256(DEFAULT_BRIEF) };
  const prepared: Prepared[] = [];
  for (const [i, kc] of key.cases.entries()) {
    const t0 = Date.now();
    const slug = `${String(i + 1).padStart(2, '0')}-${stem(kc.source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const section = sections.get(linkKey(kc.source));
    if (!section) throw new UsageError(`the ticks have no case for ${kc.source} (their cases: ${headings.join(', ') || 'none'})`);
    const snap = readSnapshot(vault, kc.source);
    if (kc.readAt && snap.before !== kc.readAt) log(`${slug}: WARNING the key read this case at ${kc.readAt.slice(0, 12)}, git now gives ${snap.before?.slice(0, 12) ?? 'the empty tree'}`);
    // The judge's library: the vault as it stood, and the brief where the app keeps it.
    const lib = path.join(out, 'libs', slug);
    for (const [rel, text] of snap.notes) {
      const file = path.resolve(lib, rel);
      if (!inside(file, lib)) throw new Error(`${rel} would land outside ${lib}`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    mkdirSync(path.join(lib, '.neo', 'ripple'), { recursive: true });
    writeFileSync(path.join(lib, '.neo', 'ripple', 'brief.md'), DEFAULT_BRIEF);
    const corpus = buildCorpus(snap.notes);
    const texts = new Map(snap.notes);
    const byPath = new Map(corpus.docs.map((d): [string, WikiPage] => [d.relpath, {
      chId: d.relpath, title: d.name, aliases: d.aliases, owner: ownerOfText(texts.get(d.relpath) ?? ''), rel: d.relpath,
    }]));
    const source = snap.source;
    const base = await shortlistFor(corpus, source, embed);
    const wide = wideShortlist(rosterRank(corpus, source), lexicalRank(corpus, source), embed ? await embeddingRank(corpus, source, embed) : []);
    const job = {
      version: 1, type: 'job', id: slug, at: new Date().toISOString(), state: 'packeted', origin: 'imported',
      source: { bookId: 'hoard', chId: slug, title: stem(source.relpath) }, source_hash: sha256(source.text), commit: snap.added, hop: 0,
    } as RippleJob;
    const c: EvalCase = {
      slug, source: kc.source, ticked: section.ticked, shown: section.shown,
      resolve: (title) => corpus.index.resolveAny(title.replace(/^\[\[|\]\]$/g, ''))?.relpath ?? null,
    };
    const p: Prepared = { c, lib, corpus, source, byPath, job, base, wide, baseChars: 0, map: wikiMap(corpus, mapChars, source) };
    p.baseChars = (await packetFor(p, 'base', 'base-0')).fullChars;
    prepared.push(p);
    log(`${slug}: ${kc.source}, ${corpus.docs.length} pages at ${snap.before?.slice(0, 12) ?? 'the empty tree'}, ${section.ticked.size} ticked, `
      + `base ${base.ranked.length} cards (${p.baseChars} chars), wide ${wide.length}, map rung ${p.map.rung} (${p.map.hidden} not shown), in ${Date.now() - t0} ms`);
  }

  function answerFile(run: string, slug: string): string {
    return path.join(out, 'runs', run, `${slug}.jsonl`);
  }

  async function packetFor(p: Prepared, arm: Exclude<Arm, 'screen'>, run: string, yes?: ReadonlySet<string>): Promise<Packet> {
    const common: PacketInput = {
      job: p.job, sourceText: p.source.text, sourcePath: p.source.relpath, corpus: p.corpus, byPath: p.byPath,
      briefFile: path.join(p.lib, '.neo', 'ripple', 'brief.md'), inboxFile: answerFile(run, p.c.slug), library: p.lib, shortlist: p.base,
    };
    const input: PacketInput = arm === 'budget' ? { ...common, budgetChars: Math.floor(p.baseChars / 2) }
      : arm === 'wide' ? { ...common, shortlist: { ranked: p.wide, modelled: p.base.modelled }, budgetChars: p.baseChars }
        : arm === 'map' ? { ...common, map: p.map.text }
          : arm === 'screened' ? { ...common, fullOnly: yes }
            : common;
    return buildPacket(input);
  }

  // The screen first: the screened arm reads its answers.
  const screens = new Map<string, { results: Map<string, Screen>; usage?: Usage; failed: number }>();
  const screenDir = path.join(out, 'screen');
  for (const p of prepared) {
    const file = path.join(screenDir, `${p.c.slug}.jsonl`);
    const results = new Map<string, Screen>();
    let usage: Usage | undefined;
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as Screen & { relpath: string; usage?: Usage };
          results.set(rec.relpath, { affects: rec.affects, confidence: rec.confidence, why: rec.why });
          if (rec.usage) usage = addUsage(usage, rec.usage);
        } catch {
          log(`${p.c.slug}: skipped a torn line in ${file}`);
        }
      }
    }
    screens.set(p.c.slug, { results, usage, failed: 0 });
  }
  const screenRun = runs.find((r) => r.arm === 'screen');
  if (screenRun && !dry) {
    mkdirSync(screenDir, { recursive: true });
    const tasks = prepared.flatMap((p) => p.base.ranked.filter((r) => !screens.get(p.c.slug)!.results.has(r.relpath)).map((r) => ({ p, r })));
    log(`screen: ${tasks.length} calls to make, ${prepared.reduce((s, p) => s + screens.get(p.c.slug)!.results.size, 0)} cached`);
    await pool(tasks, jobs, async ({ p, r }) => {
      const doc = p.corpus.byRel.get(r.relpath)!;
      const t0 = Date.now();
      const s = screens.get(p.c.slug)!;
      try {
        const res = await runner({
          command: values.claude, cwd: screenDir, stdin: screenPrompt({ title: p.job.source.title, text: p.source.text }, { title: doc.name, body: doc.body, passage: r.passage }),
          args: ['-p', '--output-format', 'json', '--model', values['screen-model'], '--max-turns', '1', '--tools', ''],
        });
        if (res.code !== 0) throw new Error(`claude exited ${res.code}: ${tail(res.stderr || res.stdout)}`);
        const json = resultOf(res.stdout);
        if (json['is_error']) throw new Error(`claude said: ${tail(String(json['result'] ?? json['subtype'] ?? ''))}`);
        const answer = readScreen(String(json['result'] ?? ''));
        const usage = usageOf(json);
        s.results.set(r.relpath, answer);
        s.usage = addUsage(s.usage, usage);
        appendFileSync(path.join(screenDir, `${p.c.slug}.jsonl`), `${JSON.stringify({ relpath: r.relpath, ...answer, usage })}\n`);
        log(`screen ${p.c.slug} ${r.relpath}: ${answer.affects ? 'yes' : 'no'} (${answer.confidence}) in ${Date.now() - t0} ms`);
      } catch (err) {
        s.failed++;
        log(`screen ${p.c.slug} ${r.relpath}: FAILED in ${Date.now() - t0} ms: ${(err as Error).message}`);
      }
    });
  }

  const outcomes = new Map(runs.map((r) => [r.name, new Map<string, Outcome>()]));
  const placements = new Map<string, Map<string, Placement>>();
  const judgeTasks: { run: typeof runs[number]; p: Prepared; packet: Packet }[] = [];
  for (const run of runs) {
    for (const p of prepared) {
      const s = screens.get(p.c.slug)!;
      if (run.arm === 'screen') {
        if (!dry) outcomes.get(run.name)!.set(p.c.slug, s.results.size ? { kind: 'screen', results: s.results, usage: s.usage } : { kind: 'failed', why: 'no screen answer came back', usage: s.usage });
        continue;
      }
      if (run.arm === 'screened' && !s.results.size) {
        log(`${run.name} ${p.c.slug}: no screen answers yet, so no screened packet; run the screen arm first`);
        if (!dry) outcomes.get(run.name)!.set(p.c.slug, { kind: 'failed', why: 'no screen answers for this case; run the screen arm first' });
        continue;
      }
      const yes = new Set([...s.results].filter(([, v]) => v.affects).map(([rel]) => rel));
      const packet = await packetFor(p, run.arm, run.name, yes);
      const file = path.join(out, 'packets', run.name, `${p.c.slug}.md`);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, packet.text);
      if (!placements.has(run.arm)) placements.set(run.arm, new Map());
      if (!placements.get(run.arm)!.has(p.c.slug)) {
        placements.get(run.arm)!.set(p.c.slug, {
          full: new Set(packet.full), locator: new Set(packet.locator), map: new Set(run.arm === 'map' ? p.map.listed : []), chars: packet.text.length,
        });
      }
      if (!dry) judgeTasks.push({ run, p, packet });
    }
  }

  await pool(judgeTasks, jobs, async ({ run, p, packet }) => {
    const answer = answerFile(run.name, p.c.slug);
    const usageFile = `${answer}.usage.json`;
    const readUsage = (): Usage | undefined => {
      try {
        return existsSync(usageFile) ? usageOf(resultOf(readFileSync(usageFile, 'utf8'))) : undefined;
      } catch {
        return undefined;
      }
    };
    const record = (o: Outcome) => outcomes.get(run.name)!.set(p.c.slug, o);
    if (existsSync(answer)) {
      try {
        record({ kind: 'judge', proposals: readAnswer(readFileSync(answer, 'utf8'), brief, packet.text).proposals, usage: readUsage() });
        log(`${run.name} ${p.c.slug}: answered before, skipped`);
        return;
      } catch (err) {
        if (!(err instanceof AnswerError)) throw err;
        renameSync(answer, `${answer}.rejected`); // kept to read, and out of the judge's way
        log(`${run.name} ${p.c.slug}: the earlier answer does not validate (${err.message}), so it runs again`);
      }
    }
    mkdirSync(path.dirname(answer), { recursive: true });
    const t0 = Date.now();
    log(`${run.name} ${p.c.slug}: judging (${packet.text.length} chars)`);
    let res: Awaited<ReturnType<Runner>>;
    try {
      res = await runner({
        command: values.claude, cwd: p.lib, stdin: packet.text,
        args: ['-p', '--output-format', 'json', '--model', values.model, '--permission-mode', 'acceptEdits',
          '--allowedTools', ...tools, '--add-dir', p.lib, '--add-dir', path.dirname(answer)],
      });
    } catch (err) {
      record({ kind: 'failed', why: `claude did not start: ${(err as Error).message}` });
      log(`${run.name} ${p.c.slug}: FAILED to start claude: ${(err as Error).message}`);
      return;
    }
    if (res.stdout.trim()) writeFileSync(usageFile, res.stdout);
    const usage = readUsage();
    const spent = usage ? `, ${usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens} in and ${usage.outputTokens} out tokens, $${usage.costUsd.toFixed(3)}` : '';
    if (res.code !== 0) {
      record({ kind: 'failed', why: `claude exited ${res.code}: ${tail(res.stderr || res.stdout)}`, usage });
      log(`${run.name} ${p.c.slug}: FAILED, claude exited ${res.code} in ${Date.now() - t0} ms${spent}`);
      return;
    }
    if (!existsSync(answer)) {
      record({ kind: 'failed', why: 'the judge wrote no answer file', usage });
      log(`${run.name} ${p.c.slug}: FAILED, no answer file, in ${Date.now() - t0} ms${spent}`);
      return;
    }
    try {
      const { proposals } = readAnswer(readFileSync(answer, 'utf8'), brief, packet.text);
      record({ kind: 'judge', proposals, usage });
      log(`${run.name} ${p.c.slug}: ${proposals.length} proposals in ${Date.now() - t0} ms${spent}`);
    } catch (err) {
      if (!(err instanceof AnswerError)) throw err;
      record({ kind: 'failed', why: err.message, usage });
      log(`${run.name} ${p.c.slug}: FAILED, the answer does not validate: ${err.message}`);
    }
  });

  const firstJudged = runs.find((r) => [...outcomes.get(r.name)!.values()].length);
  const report = scoreEval({
    cases: prepared.map((p) => p.c),
    runs: dry ? [] : runs.map((r) => ({ run: r.name, arm: r.arm, outcomes: outcomes.get(r.name)! })),
    placements: [...placements].map(([arm, byCase]) => ({ arm, byCase })),
    baseline: dry ? undefined : firstJudged?.name,
  });
  const screenFailed = [...screens.values()].reduce((s, x) => s + x.failed, 0);
  const notes = [
    dry ? 'A dry run: packets only, no model call. Only where the ticked pages sit is scored.' : `Judge model ${values.model}; screen model ${values['screen-model']}.`,
    embed ? `Model extras from ${values.embed}.` : 'The meaning model was not loaded, so base lacks its ten model pages and wide fuses lexical alone.',
    `The wiki map is cut to ${mapChars} characters.`,
    ...(screenFailed ? [`${screenFailed} screen calls failed; their pages count as not affected and run again next time.`] : []),
  ];
  writeFileSync(path.join(out, 'eval.md'), renderEval(report, notes));
  writeFileSync(path.join(out, 'eval.json'), `${JSON.stringify({ arms, model: values.model, screenModel: values['screen-model'], embed: values.embed ?? null, dryRun: dry, mapChars, report }, null, 2)}\n`);
  for (const t of report.totals) {
    log(`${t.run}: caught ${t.caught} of ${t.ticked} ticked over ${t.cases} cases (${t.failed} failed); tokens ${t.inputTokens} in, ${t.cacheWriteTokens} cache write, ${t.cacheReadTokens} cache read, ${t.outputTokens} out; $${t.costUsd.toFixed(2)}`);
  }
  for (const pl of report.placement) log(`${pl.arm}: ticked pages ${pl.full} full, ${pl.locator} locator, ${pl.map} map only, ${pl.absent} absent; ${pl.meanChars} chars a packet`);
  log(`wrote ${path.join(out, 'eval.md')} and eval.json`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`ripple-judge-eval: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = err instanceof UsageError ? 2 : 1;
  });
}
