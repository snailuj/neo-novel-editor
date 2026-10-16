// The meaning model for ripple's shortlist, run on the author's machine and never in
// NEO: transformers.js is optional and never a dependency of the fork, so a run installs
// it with `npm i --no-save @huggingface/transformers`. Vectors are cached by the hash of
// what was embedded, so a run embeds only what changed since the last. Used by the
// shortlist spike (shortlist-cli.ts) and by ripple's packet top-up (embed-cli.ts).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Embed } from './shortlist.ts';

export class EmbedderMissing extends Error {}

/** The model snailuj's 16 Oct reading chose, at full precision, with page titles. */
export const GEMMA = { model: 'onnx-community/embeddinggemma-2-ONNX', dtype: 'fp32', titles: true, pooling: 'mean' } as const;

export interface EmbedOptions { model: string; titles: boolean; pooling: string; dtype: string; device?: string; cacheFile: string }

type Run = (texts: string[]) => Promise<number[][]>;
const loaded = new Map<string, Promise<Run>>();

export async function loadEmbedder(o: EmbedOptions, log: (message: string) => void): Promise<Embed> {
  const gemma = /embeddinggemma/i.test(o.model);
  // EmbeddingGemma's document prompt is "title: {title} | text: ", "none" when there is
  // none (Google's model card). `#titles` gives it the page's name.
  const prefix = (role: 'query' | 'document', title?: string): string => {
    if (!gemma) return '';
    return role === 'query' ? 'task: search result | query: ' : `title: ${(o.titles && title) || 'none'} | text: `;
  };
  if (!loaded.has(o.model)) loaded.set(o.model, loadModel(o, gemma, log));
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

async function loadModel(o: EmbedOptions, gemma: boolean, log: (message: string) => void): Promise<Run> {
  let lib: any;
  try {
    const spec = '@huggingface/transformers';
    lib = await import(spec);
  } catch (err) {
    throw new EmbedderMissing(`needs transformers.js 4.3.1 or later: npm i --no-save @huggingface/transformers (${(err as Error).message})`);
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

