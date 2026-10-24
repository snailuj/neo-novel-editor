// npm run ripple:shortlist -- --vault <hoard> --out <folder> [--source <relpath> ...]
//   [--pick N --rulings <RIPPLE.jsonl>] [--skip-key <earlier key.json> ...]
//   [--cases-from <earlier key.json> ...] [--seen <earlier sheet.md> ...] [--git] [--k 30]
//   [--embed <model>[#titles] ...] [--chunks paragraph|merge]
// Writes sheet.md (each candidate once, to tick by hand) and key.json to --out, never
// inside the vault. `--score <folder> [--ticks <sheet.md> ...] [--union N] [--fuse N[@R] ...] [--baseline <list>] [--baseline-from <folder>]` then reads the
// ticks back into score.md, with --union adding the roster plus N pages from each model.
// A spike for choosing ripple's shortlist method; not part of the app.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readText } from '../../librarian/vault-fs.ts';
import { buildSheet, pastTargets, pickSources, readSheet, renderScore, scoreSheet, mergeKeys, withFusion, withUnions, type Key, type SheetCase, type SheetList } from './sheet.ts';
import {
  ROSTER_ZONES, blend, buildCorpus, embeddingRank, inRoster, lexicalRank, phraseRank, rosterChars, rosterRank,
  type Embed, type Source,
} from './shortlist.ts';
import { readSnapshot } from './snapshot.ts';
import { EmbedderMissing, loadEmbedder as load, type EmbedOptions } from './embedder.ts';

class UsageError extends Error {}

const log = (message: string): void => { process.stderr.write(`ripple-shortlist: ${message}\n`); };

async function loadEmbedder(o: EmbedOptions): Promise<Embed> {
  try {
    return await load(o, log);
  } catch (err) {
    if (err instanceof EmbedderMissing) throw new UsageError(`--embed ${err.message}`);
    throw err;
  }
}

function walk(root: string, rel = ''): string[] {
  return readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.')) return [];
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(root, child) : e.isFile() ? [child] : [];
  });
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      vault: { type: 'string' },
      out: { type: 'string' },
      source: { type: 'string', multiple: true },
      pick: { type: 'string' },
      rulings: { type: 'string' },
      'skip-key': { type: 'string', multiple: true },
      'cases-from': { type: 'string', multiple: true },
      seen: { type: 'string', multiple: true },
      git: { type: 'boolean', default: false },
      k: { type: 'string', default: '30' },
      embed: { type: 'string', multiple: true },
      score: { type: 'string' },
      ticks: { type: 'string', multiple: true },
      union: { type: 'string' },
      fuse: { type: 'string', multiple: true },
      baseline: { type: 'string' },
      'baseline-from': { type: 'string' },
      chunks: { type: 'string', default: 'paragraph' },
      pooling: { type: 'string', default: 'mean' },
      dtype: { type: 'string', default: 'q8' },
      device: { type: 'string' },
      'brief-chars': { type: 'string', default: '20338' },
    },
  });
  if (values.score) {
    const dir = path.resolve(values.score);
    const fuses = (values.fuse ?? []).map((spec) => {
      const [n, r] = spec.split('@').map(Number);
      if (!(n! > 0) || (spec.includes('@') && !(r! >= 0))) throw new UsageError(`--fuse ${spec}: give N or N@R`);
      return { n: n!, r: spec.includes('@') ? r : undefined };
    });
    if (values.union && !(Number(values.union) > 0)) throw new UsageError('--union takes a number');
    // --union N also scores the roster plus each model's first N pages it lacks; --fuse
    // N[@R] the roster's first R pages (all by default) then N pages fused from lexical and
    // each model, and all three fused to that size.
    const derive = (k: Key): Key => fuses.reduce((acc, f) => withFusion(acc, f.n, f.r), values.union ? withUnions(k, Number(values.union)) : k);
    const readKey = (d: string): Key => JSON.parse(readFileSync(path.join(path.resolve(d), 'key.json'), 'utf8')) as Key;
    let key = derive(readKey(dir));
    // --baseline-from adds another run's lists, marked "base: ", so a run with other
    // chunking or ranking can name one of them as --baseline.
    if (values['baseline-from']) key = mergeKeys(key, derive(readKey(values['baseline-from'])), 'base: ');
    // --ticks scores this run's lists against sheets ticked for earlier runs; several are
    // read as one, so a top-up sheet scores together with the sheet it tops up.
    const ticks = values.ticks?.length ? values.ticks.map((t) => path.resolve(t)) : [path.join(dir, 'sheet.md')];
    const score = scoreSheet(ticks.map((t) => readFileSync(t, 'utf8')).join('\n'), key, values.baseline);
    writeFileSync(path.join(dir, 'score.md'), renderScore(score));
    for (const t of score.totals) log(`${t.method}: caught ${t.caught} of ${t.ticked} ticked, ${t.size} listed`);
    log(`wrote ${path.join(dir, 'score.md')}`);
    return;
  }
  if (!values.vault || !values.out) throw new UsageError('--vault and --out are required');
  // --chunks merge joins short paragraphs before ranking (shortlist.ts merged()).
  if (values.chunks !== 'paragraph' && values.chunks !== 'merge') throw new UsageError('--chunks takes paragraph or merge');
  const cut = { merge: values.chunks === 'merge' };
  const vault = path.resolve(values.vault);
  const out = path.resolve(values.out);
  if (inside(out, vault)) throw new UsageError(`refusing to write inside the vault: ${out}`);
  const k = Number(values.k);
  const briefChars = Number(values['brief-chars']);
  if (!(k > 0) || !(briefChars >= 0)) throw new UsageError('--k and --brief-chars take numbers');
  const rulings = values.rulings ? readFileSync(values.rulings, 'utf8') : '';
  const sources = [...(values.source ?? [])];
  // --cases-from runs an earlier key's cases again, as with another model or precision.
  for (const file of values['cases-from'] ?? []) {
    for (const c of (JSON.parse(readFileSync(file, 'utf8')) as Key).cases) if (!sources.includes(c.source)) sources.push(c.source);
  }
  if (values.pick) {
    if (!rulings) throw new UsageError('--pick needs --rulings');
    // An earlier run's key names the cases already read, so a second sheet holds new ones.
    const skip = (values['skip-key'] ?? []).flatMap((file) => (JSON.parse(readFileSync(file, 'utf8')) as Key).cases.map((c) => c.source));
    sources.push(...pickSources(rulings, Number(values.pick), skip).filter((s) => !sources.includes(s)));
  }
  if (!sources.length) throw new UsageError('name a --source, or --pick N with --rulings');
  mkdirSync(out, { recursive: true });

  // Each model also fills a blend of its own. `<model>#titles` hands EmbeddingGemma each
  // page's name; the model loads once however many ways it is named.
  const embedders: { model: string; embed: Embed }[] = [];
  for (const spec of values.embed ?? []) {
    const [model, flag] = spec.split('#') as [string, string | undefined];
    if (flag !== undefined && flag !== 'titles') throw new UsageError(`--embed ${spec}: the only flag is #titles`);
    embedders.push({ model: flag ? `${model} titled` : model, embed: await loadEmbedder({
      model, titles: flag === 'titles', pooling: values.pooling, dtype: values.dtype, device: values.device,
      cacheFile: path.join(out, `embed-cache-${model.replace(/[^\w.-]+/g, '_')}.jsonl`),
    }) });
  }

  let live: ReturnType<typeof buildCorpus> | null = null;
  if (!values.git) {
    const t0 = Date.now();
    const files = walk(vault).filter((rel) => inRoster(rel, ROSTER_ZONES));
    live = buildCorpus(files.map((rel) => [rel, readText(path.join(vault, rel))] as const));
    log(`read ${live.docs.length} roster pages in ${Date.now() - t0} ms`);
  }

  const cases: SheetCase[] = [];
  const timings: Record<string, Record<string, number>> = {};
  for (const rel of sources) {
    const t: Record<string, number> = {};
    let mark = Date.now();
    const lap = (name: string) => { const now = Date.now(); t[name] = now - mark; mark = now; };
    let corpus = live;
    let source: Source;
    let readAt: string | undefined;
    if (values.git) {
      const snap = readSnapshot(vault, rel);
      corpus = buildCorpus(snap.notes);
      source = snap.source;
      readAt = snap.before ?? undefined;
      log(`${rel}: read ${corpus.docs.length} pages at ${snap.before?.slice(0, 12) ?? 'the empty tree'}`);
    } else {
      const file = path.join(vault, rel);
      if (!existsSync(file)) throw new UsageError(`no such source: ${rel}`);
      source = { relpath: rel, text: readText(file) };
    }
    lap('read');
    const roster = rosterRank(corpus!, source);
    lap('roster');
    const lexical = lexicalRank(corpus!, source, cut);
    lap('lexical');
    const phrase = phraseRank(corpus!, source);
    lap('phrase');
    const lists: SheetList[] = [{ method: 'roster', ranked: roster.slice(0, k) }, { method: 'lexical', ranked: lexical.slice(0, k) },
      { method: 'phrase', ranked: phrase.slice(0, k) }];
    const blends: SheetList[] = [];
    for (const { model, embed } of embedders) {
      const embedded = await embeddingRank(corpus!, source, embed, cut);
      lap(`embedding ${model}`);
      lists.push({ method: `embedding ${model}`, ranked: embedded.slice(0, k) });
      blends.push({ method: `blend ${model}`, ranked: blend(roster, embedded, k) });
    }
    if (!embedders.length) blends.push({ method: 'blend', ranked: blend(roster, lexical, k) });
    lists.push(...blends);
    timings[rel] = t;
    cases.push({
      source: rel, corpus: corpus!, lists, readAt, briefChars, sourceChars: source.text.length,
      pastTargets: rulings ? pastTargets(rulings, rel) : [], rosterChars: rosterChars(corpus!, source),
    });
  }

  // --seen makes a top-up: rows the named sheets already showed are left out.
  const seen = values.seen?.length ? readSheet(values.seen.map((f) => readFileSync(f, 'utf8')).join('\n')).sections : undefined;
  const { sheet, key } = buildSheet(cases, seen && new Map([...seen].map(([id, sec]) => [id, sec.shown])));
  writeFileSync(path.join(out, 'sheet.md'), sheet);
  writeFileSync(path.join(out, 'key.json'), `${JSON.stringify({ ...key, k, models: values.embed ?? [], timings }, null, 2)}\n`);
  for (const c of key.cases) {
    log(`${c.source}: whole roster packet ${c.wholeRosterPacketChars} chars; `
      + c.lists.map((l) => `${l.method} ${l.packetChars}`).join(', '));
  }
  log(`wrote ${path.join(out, 'sheet.md')} and key.json`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  process.exitCode = err instanceof UsageError ? 2 : 1;
});
