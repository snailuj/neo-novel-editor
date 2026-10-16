// npm run ripple:shortlist -- --vault <hoard> --out <folder> [--source <relpath> ...]
//   [--pick N --rulings <RIPPLE.jsonl>] [--skip-key <earlier key.json> ...] [--git] [--k 30]
//   [--embed <model>[#titles] ...]
// Writes sheet.md (each candidate once, to tick by hand) and key.json to --out, never
// inside the vault. `--score <folder> [--ticks <sheet.md>]` then reads the ticks back into
// score.md. A spike for choosing ripple's shortlist method; not part of the app.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readText } from '../../librarian/vault-fs.ts';
import { buildSheet, pastTargets, pickSources, renderScore, scoreSheet, type Key, type SheetCase, type SheetList } from './sheet.ts';
import {
  ROSTER_ZONES, blend, buildCorpus, embeddingRank, inRoster, lexicalRank, rosterChars, rosterRank,
  type Embed, type Source,
} from './shortlist.ts';
import { readSnapshot } from './snapshot.ts';

class UsageError extends Error {}

const log = (message: string): void => { process.stderr.write(`ripple-shortlist: ${message}\n`); };

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

interface EmbedOptions { model: string; titles: boolean; pooling: string; dtype: string; device?: string; cacheFile: string }

type Run = (texts: string[]) => Promise<number[][]>;
const loaded = new Map<string, Promise<Run>>();

// transformers.js is optional and never a dependency of the fork: a run on the author's
// machine installs it with `npm i --no-save`. Vectors are cached by chunk hash, so cases
// read at different commits embed only what changed.
async function loadEmbedder(o: EmbedOptions): Promise<Embed> {
  const gemma = /embeddinggemma/i.test(o.model);
  // EmbeddingGemma's document prompt is "title: {title} | text: ", "none" when there is
  // none (Google's model card). `#titles` gives it the page's name.
  const prefix = (role: 'query' | 'document', title?: string): string => {
    if (!gemma) return '';
    return role === 'query' ? 'task: search result | query: ' : `title: ${(o.titles && title) || 'none'} | text: `;
  };
  if (!loaded.has(o.model)) loaded.set(o.model, loadModel(o, gemma));
  const run = await loaded.get(o.model)!;
  const cache = new Map<string, number[]>();
  if (existsSync(o.cacheFile)) {
    for (const line of readFileSync(o.cacheFile, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const { h, v } = JSON.parse(line) as { h: string; v: number[] };
        cache.set(h, v);
      } catch {
        log(`skipped a torn line in ${o.cacheFile}`);
      }
    }
    log(`${cache.size} cached vectors`);
  }
  return async (texts, role, titles) => {
    const keyed = texts.map((t, i) => {
      const input = prefix(role, titles?.[i]) + t;
      return { input, h: createHash('sha256').update(`${o.model}\0${o.dtype}\0${input}`).digest('hex') };
    });
    const missing = [...new Map(keyed.filter((k) => !cache.has(k.h)).map((k) => [k.h, k])).values()];
    const t0 = Date.now();
    for (let i = 0; i < missing.length; i += 16) {
      const batch = missing.slice(i, i + 16);
      const vectors = await run(batch.map((b) => b.input));
      batch.forEach((b, j) => {
        cache.set(b.h, vectors[j]!);
        appendFileSync(o.cacheFile, `${JSON.stringify({ h: b.h, v: vectors[j] })}\n`);
      });
      if ((i / 16) % 30 === 29) log(`embedded ${i + batch.length} of ${missing.length}`);
    }
    if (missing.length) {
      const ms = Date.now() - t0;
      log(`embedded ${missing.length} ${role} chunks in ${ms} ms (${(missing.length / (ms / 1000 || 1)).toFixed(1)} a second)`);
    }
    return keyed.map((k) => cache.get(k.h)!);
  };
}

async function loadModel(o: EmbedOptions, gemma: boolean): Promise<Run> {
  let lib: any;
  try {
    const spec = '@huggingface/transformers';
    lib = await import(spec);
  } catch (err) {
    throw new UsageError(`--embed needs transformers.js 4.3.1 or later: npm i --no-save @huggingface/transformers (${(err as Error).message})`);
  }
  const started = Date.now();
  let run: Run;
  if (gemma) {
    // EmbeddingGemma 2 is multimodal; with the vision and audio encoders nulled in its
    // config only the 270M text model loads (onnx-community/embeddinggemma-2-ONNX card).
    // Google's card warns against fp16, so q8 or fp32. Needs transformers.js 4.3.1 or later.
    const tokenizer = await lib.AutoTokenizer.from_pretrained(o.model);
    let config: any;
    try {
      config = await lib.AutoConfig.from_pretrained(o.model);
      if ('vision_config' in config) config.vision_config = null;
      if ('audio_config' in config) config.audio_config = null;
    } catch (err) {
      log(`loading the whole model, as its config did not read: ${(err as Error).message}`);
      config = undefined;
    }
    const model = await lib.AutoModel.from_pretrained(o.model, { dtype: o.dtype, device: o.device, config });
    run = async (texts) => {
      const inputs = await tokenizer(texts, { padding: true, truncation: true });
      return (await model(inputs)).sentence_embedding.tolist();
    };
  } else {
    const extract = await lib.pipeline('feature-extraction', o.model, { dtype: o.dtype, device: o.device });
    run = async (texts) => (await extract(texts, { pooling: o.pooling, normalize: true })).tolist();
  }
  log(`loaded ${o.model} (${o.dtype}) in ${Date.now() - started} ms`);
  return run;
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
      git: { type: 'boolean', default: false },
      k: { type: 'string', default: '30' },
      embed: { type: 'string', multiple: true },
      score: { type: 'string' },
      ticks: { type: 'string' },
      pooling: { type: 'string', default: 'mean' },
      dtype: { type: 'string', default: 'q8' },
      device: { type: 'string' },
      'brief-chars': { type: 'string', default: '20338' },
    },
  });
  if (values.score) {
    const dir = path.resolve(values.score);
    const key = JSON.parse(readFileSync(path.join(dir, 'key.json'), 'utf8')) as Key;
    // --ticks scores this run's lists against a sheet ticked for an earlier run.
    const ticks = values.ticks ? path.resolve(values.ticks) : path.join(dir, 'sheet.md');
    const score = scoreSheet(readFileSync(ticks, 'utf8'), key);
    writeFileSync(path.join(dir, 'score.md'), renderScore(score));
    for (const t of score.totals) log(`${t.method}: caught ${t.caught} of ${t.ticked} ticked, ${t.size} listed`);
    log(`wrote ${path.join(dir, 'score.md')}`);
    return;
  }
  if (!values.vault || !values.out) throw new UsageError('--vault and --out are required');
  const vault = path.resolve(values.vault);
  const out = path.resolve(values.out);
  if (inside(out, vault)) throw new UsageError(`refusing to write inside the vault: ${out}`);
  const k = Number(values.k);
  const briefChars = Number(values['brief-chars']);
  if (!(k > 0) || !(briefChars >= 0)) throw new UsageError('--k and --brief-chars take numbers');
  const rulings = values.rulings ? readFileSync(values.rulings, 'utf8') : '';
  const sources = [...(values.source ?? [])];
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
    const lexical = lexicalRank(corpus!, source);
    lap('lexical');
    const lists: SheetList[] = [{ method: 'roster', ranked: roster.slice(0, k) }, { method: 'lexical', ranked: lexical.slice(0, k) }];
    const blends: SheetList[] = [];
    for (const { model, embed } of embedders) {
      const embedded = await embeddingRank(corpus!, source, embed);
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

  const { sheet, key } = buildSheet(cases);
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
