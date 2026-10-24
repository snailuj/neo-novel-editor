// npm run ripple:embed -- --library <NEO Library> [--device cpu|dml|cuda] [--cache <folder>]
// Adds the meaning model's pages to each packet still waiting for the judge, on the
// author's machine and outside NEO (snailuj's 16 Oct ruling: roster, then ten BM25
// pages, then ten from EmbeddingGemma 2 at full precision with page titles). Run it
// after Run Ripple and before the judge reads the packets. Only packets with no answer
// yet are written again, and only when the model changes them; jobs, rulings and pages
// are never touched. Vectors are cached outside the library (by default
// ~/.cache/neo-ripple), so the first run embeds the whole wiki and later runs only what
// changed. Needs transformers.js: npm i --no-save @huggingface/transformers.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeWhole } from '../files.ts';
import { MarkStore } from '../marks/store.ts';
import { WikiStore } from '../wiki/store.ts';
import { EmbedderMissing, GEMMA, loadEmbedder } from './embedder.ts';
import { packetOf, rippleFiles } from './engine.ts';
import { chapterRel, readWiki, wikiCorpus } from './pages.ts';
import { Rulings } from './rulings.ts';
import type { Embed } from './shortlist.ts';

const say = (message: string): void => { process.stderr.write(`ripple-embed: ${message}\n`); };

export interface TopUp {
  waiting: number;
  written: number;
}

/** Writes each waiting packet again with the model's pages; returns how many changed. */
export async function topUp(library: string, embed: Embed, log: (message: string) => void = () => {}): Promise<TopUp> {
  const quiet = () => {};
  const marks = new MarkStore({ library: () => library, log: quiet });
  const pages = new WikiStore({ library: () => library, marks, log: quiet }).pages();
  if (!pages) throw new Error(`${library} has no wiki yet`);
  const wiki = readWiki(library, pages, quiet);
  const state = new Rulings(() => library).read();
  const waiting = [...state.jobs.values()].filter((j) => j.state === 'packeted' && !existsSync(rippleFiles(library, j.id).answer));
  const out: TopUp = { waiting: waiting.length, written: 0 };
  if (!waiting.length) return out;
  const { corpus, byPath } = wikiCorpus(library, wiki);
  for (const job of waiting) {
    const file = path.join(library, chapterRel(job.source.bookId, job.source.chId));
    if (!existsSync(file)) continue;
    const packet = await packetOf({ library, job, html: readFileSync(file, 'utf8'), wiki, corpus, byPath, embed });
    const target = rippleFiles(library, job.id).packet;
    if (existsSync(target) && readFileSync(target, 'utf8') === packet.text) continue;
    writeWhole(target, packet.text);
    out.written++;
    log(`${job.source.title}: ${packet.candidates.length} candidates`);
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      library: { type: 'string' },
      device: { type: 'string' },
      cache: { type: 'string', default: path.join(homedir(), '.cache', 'neo-ripple') },
    },
  });
  if (!values.library) throw new Error('name the library: --library <NEO Library folder>');
  const library = path.resolve(values.library);
  if (!existsSync(path.join(library, '.neo', 'ripple', 'rulings.jsonl'))) throw new Error(`${library} has no ripple log yet: choose Run Ripple in NEO first`);
  mkdirSync(values.cache, { recursive: true });
  let embed: Embed;
  try {
    embed = await loadEmbedder({
      ...GEMMA, device: values.device,
      cacheFile: path.join(values.cache, `${GEMMA.model.replace(/[^\w.-]+/g, '_')}-${GEMMA.dtype}.jsonl`),
    }, say);
  } catch (err) {
    if (err instanceof EmbedderMissing) throw new Error(`the meaning model ${err.message}`);
    throw err;
  }
  const done = await topUp(library, embed, say);
  say(done.waiting
    ? `${done.written} of ${done.waiting} waiting packet${done.waiting === 1 ? '' : 's'} now carry the model's pages`
    : 'no packet is waiting for the judge');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    say(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
