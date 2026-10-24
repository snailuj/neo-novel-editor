// Ripple's shortlist, as a spike: ways to pick the few pages a judge reads for one
// source, in place of hoard's whole roster, which was about 73% of every packet. Pure
// over the notes it is handed; the command line (shortlist-cli.ts) reads the disk.
import { FrontmatterError, split } from '../../librarian/frontmatter.ts';
import { isFence, key, linksIn, maskCodeSpans } from '../../librarian/links.ts';
import { PageIndex } from '../../librarian/page-index.ts';

/** The folders hoard's roster ranks (R/roster.py:26). */
export const ROSTER_ZONES = ['sources/', 'writing/', 'lore/', 'projects/'];
const GLOSS = 200;
const PASSAGE = 300;

export interface Doc {
  relpath: string;
  name: string;
  body: string;
  gloss: string;
  aliases: string[];
}

export interface Corpus {
  docs: Doc[];
  byRel: Map<string, Doc>;
  index: PageIndex;
  /** Undirected link graph by relpath. */
  edges: Map<string, Set<string>>;
}

/** A source page: it may be absent from the corpus, as when read before it came in. */
export interface Source {
  relpath: string;
  text: string;
}

export interface Ranked {
  relpath: string;
  score: number;
  /** Why the page is there: 'named', 'hop N', a method's own word, or '' for nothing. */
  why: string;
  passage?: string;
}

/**
 * Texts in, one vector each out. `query` is the source, `document` a page's chunks, with
 * `titles` naming each chunk's page for a model whose prompt takes one.
 */
export type Embed = (texts: string[], role: 'query' | 'document', titles?: string[]) => Promise<number[][]>;

/** Whether a vault path is a page the roster considers: Markdown in a zone, no `_` or `.` folder. */
export function inRoster(relpath: string, zones: readonly string[] = ROSTER_ZONES): boolean {
  if (!relpath.endsWith('.md') || !zones.some((z) => relpath.startsWith(z))) return false;
  return !relpath.split('/').slice(0, -1).some((part) => part.startsWith('_') || part.startsWith('.'));
}

function stem(relpath: string): string {
  return relpath.slice(relpath.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

function bodyOf(text: string): string {
  try {
    return split(text).body;
  } catch (err) {
    if (err instanceof FrontmatterError) return text; // the page still ranks on its words
    throw err;
  }
}

// [[Target|Shown]] reads as Shown, [[Target]] as Target, in a gloss or a passage.
function plain(text: string): string {
  return text.replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, t: string, shown?: string) => shown ?? t)
    .replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}...`;
}

function gloss(body: string): string {
  const lines = body.split('\n').filter((l) => l.trim() && !/^\s*#/.test(l) && !isFence(l));
  return clip(plain(lines.join(' ')), GLOSS);
}

export function buildCorpus(notes: Iterable<readonly [string, string]>, zones: readonly string[] = ROSTER_ZONES): Corpus {
  const docs: Doc[] = [];
  const index = new PageIndex();
  const texts = new Map<string, string>();
  for (const [relpath, text] of notes) {
    if (!inRoster(relpath, zones)) continue;
    index.add(relpath, text);
    texts.set(relpath, text);
    const body = bodyOf(text);
    docs.push({ relpath, name: stem(relpath), body, gloss: gloss(body), aliases: [] });
  }
  const byRel = new Map(docs.map((d) => [d.relpath, d]));
  for (const [, alias, page] of index.aliasEntries()) byRel.get(page.relpath)?.aliases.push(alias);
  const edges = new Map<string, Set<string>>(docs.map((d) => [d.relpath, new Set<string>()]));
  for (const d of docs) {
    for (const target of linksIn(texts.get(d.relpath)!)) {
      const to = index.resolveAny(target)?.relpath;
      if (!to || to === d.relpath || !edges.has(to)) continue;
      edges.get(d.relpath)!.add(to);
      edges.get(to)!.add(d.relpath);
    }
  }
  return { docs, byRel, index, edges };
}

/** A page that is not a Markdown file, as a wiki page is: its relpath's stem is its name. */
export interface PageDoc {
  relpath: string;
  aliases: readonly string[];
  body: string;
}

/** A corpus of such pages, every one ranked: their aliases go in as frontmatter would hold them. */
export function corpusOf(pages: Iterable<PageDoc>): Corpus {
  const notes: [string, string][] = [];
  for (const p of pages) {
    const front = p.aliases.length ? `---\naliases: ${JSON.stringify(p.aliases)}\n---\n` : '';
    notes.push([p.relpath, front + p.body]);
  }
  return buildCorpus(notes, ['']);
}

/** The source's prose with code blanked, so a name in a code span or fence is no mention. */
function prose(text: string): string {
  let inFence = false;
  return bodyOf(text).split('\n').map((line) => {
    if (isFence(line)) { inFence = !inFence; return ''; }
    return inFence ? '' : maskCodeSpans(line);
  }).join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A name and, for `Kelp-Tithe`, its spaced form; matched whole-word, case-folded. */
function mentions(text: string, name: string): boolean {
  const forms = new Set([name, name.replace(/[-_]+/g, ' ')]);
  return [...forms].some((f) => f.trim().length > 1
    && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(f)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
}

/**
 * Each page's distance from the source in the undirected link graph: what the source
 * links to, and what links to it, are hop 1. A page it cannot reach is left out.
 */
export function linkHops(corpus: Corpus, source: Source): Map<string, number> {
  const sourceKey = key(source.relpath);
  const start = new Set<string>();
  for (const target of linksIn(source.text)) {
    const to = corpus.index.resolveAny(target)?.relpath;
    if (to && to !== source.relpath && corpus.byRel.has(to)) start.add(to);
  }
  for (const d of corpus.docs) {
    if (d.relpath !== source.relpath && linksIn(d.body).some((t) => key(t) === sourceKey)) start.add(d.relpath);
  }
  const hop = new Map<string, number>();
  let frontier = [...start];
  for (const r of frontier) hop.set(r, 1);
  for (let h = 2; frontier.length; h++) {
    const next: string[] = [];
    for (const r of frontier) {
      for (const n of corpus.edges.get(r) ?? []) {
        if (n === source.relpath || hop.has(n)) continue;
        hop.set(n, h);
        next.push(n);
      }
    }
    frontier = next;
  }
  return hop;
}

/**
 * Hoard's roster order: pages the source names (by name or alias, or a link), then
 * pages by hop distance in the undirected link graph, then the rest by name.
 */
export function rosterRank(corpus: Corpus, source: Source): Ranked[] {
  const text = prose(source.text);
  const named = new Set<string>();
  for (const d of corpus.docs) {
    if (d.relpath === source.relpath) continue;
    if ([d.name, ...d.aliases].some((n) => mentions(text, n))) named.add(d.relpath);
  }
  const hop = linkHops(corpus, source);
  const rank = (r: string): number => (named.has(r) ? 0 : hop.get(r) ?? Number.POSITIVE_INFINITY);
  return corpus.docs.filter((d) => d.relpath !== source.relpath)
    .map((d): Ranked => {
      const h = hop.get(d.relpath);
      const why = named.has(d.relpath) ? 'named' : h ? `hop ${h}` : '';
      return { relpath: d.relpath, score: -rank(d.relpath), why };
    })
    .sort((a, b) => rank(a.relpath) - rank(b.relpath) || (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));
}

/**
 * A body cut at blank lines (a fence kept whole while it fits), each piece at most
 * `max` characters: longer ones are cut at a space where there is one.
 */
export function chunks(body: string, max = 1200): string[] {
  const paras: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (isFence(line)) inFence = !inFence;
    if (!inFence && !isFence(line) && !line.trim()) {
      if (current.length) paras.push(current.join('\n'));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) paras.push(current.join('\n'));
  const out: string[] = [];
  for (const p of paras.map((x) => x.trim()).filter(Boolean)) {
    let rest = p;
    while (rest.length > max) {
      const space = rest.lastIndexOf(' ', max);
      const at = space > max / 2 ? space : max;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

const STOP = new Set(('the and for that with this from was were are but not his her she they them their '
  + 'had has have its into onto over then than when what which who whom will would there here been '
  + 'also only just more most some such very can could may might shall should our out all any one two').split(' '));

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((t) => !STOP.has(t));
}

interface Chunked { relpath: string; name: string; text: string }

function corpusChunks(corpus: Corpus, source: Source): Chunked[] {
  return corpus.docs.filter((d) => d.relpath !== source.relpath)
    .flatMap((d) => chunks(d.body).map((text) => ({ relpath: d.relpath, name: d.name, text })));
}

/** Best chunk per page, pages in score order, ties by path; zero scores dropped. */
function bestPerPage(scored: { relpath: string; text: string; score: number }[], why: string): Ranked[] {
  const best = new Map<string, Ranked>();
  for (const s of scored) {
    const held = best.get(s.relpath);
    if (s.score > 0 && (!held || s.score > held.score)) best.set(s.relpath, { relpath: s.relpath, score: s.score, why, passage: s.text });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || (a.relpath < b.relpath ? -1 : 1));
}

/** BM25 (k1 1.2, b 0.75) over paragraph chunks, the source's distinct words as the query. */
export function lexicalRank(corpus: Corpus, source: Source): Ranked[] {
  const units = corpusChunks(corpus, source).map((c) => ({ ...c, terms: terms(c.text) }));
  const n = units.length;
  if (!n) return [];
  const avg = units.reduce((s, u) => s + u.terms.length, 0) / n;
  const df = new Map<string, number>();
  for (const u of units) for (const t of new Set(u.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const query = new Set(terms(prose(source.text)));
  const scored = units.map((u) => {
    const tf = new Map<string, number>();
    for (const t of u.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const q of query) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (n - df.get(q)! + 0.5) / (df.get(q)! + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (1 - 0.75 + 0.75 * u.terms.length / avg));
    }
    return { relpath: u.relpath, text: u.text, score };
  });
  return bestPerPage(scored, 'lexical');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Each page scored by its chunk closest to any chunk of the source. */
export async function embeddingRank(corpus: Corpus, source: Source, embed: Embed): Promise<Ranked[]> {
  const units = corpusChunks(corpus, source);
  const queries = chunks(prose(source.text));
  if (!units.length || !queries.length) return [];
  const qv = await embed(queries, 'query');
  const dv = await embed(units.map((u) => u.text), 'document', units.map((u) => u.name));
  const scored = units.map((u, i) => ({ ...u, score: Math.max(...qv.map((q) => cosine(q, dv[i]!))) }));
  return bestPerPage(scored, 'embedding');
}

/** Every page the source names or links directly, then `fill` in its order, to `k`. */
export function blend(roster: Ranked[], fill: Ranked[], k: number): Ranked[] {
  const out: Ranked[] = [];
  const seen = new Set<string>();
  const direct = roster.filter((r) => r.why === 'named' || r.why === 'hop 1');
  const passages = new Map(fill.map((f) => [f.relpath, f.passage]));
  for (const r of [...direct, ...fill]) {
    if (out.length >= Math.max(k, direct.length) || seen.has(r.relpath)) continue;
    seen.add(r.relpath);
    out.push({ ...r, passage: r.passage ?? passages.get(r.relpath) });
  }
  return out;
}

/**
 * Ripple's shortlist: the roster's first k, then each fill's first n pages not already
 * held, in the order given. A page keeps the first passage any list found for it.
 */
export function withExtras(roster: Ranked[], k: number, fills: readonly { ranked: Ranked[]; n: number }[]): Ranked[] {
  const out = roster.slice(0, k).map((r) => ({ ...r }));
  const held = new Set(out.map((r) => r.relpath));
  for (const { ranked, n } of fills) {
    let added = 0;
    for (const r of ranked) {
      if (added >= n) break;
      if (held.has(r.relpath)) continue;
      held.add(r.relpath);
      out.push({ ...r });
      added++;
    }
  }
  for (const r of out) {
    if (r.passage) continue;
    for (const { ranked } of fills) {
      const found = ranked.find((f) => f.relpath === r.relpath && f.passage);
      if (found) { r.passage = found.passage; break; }
    }
  }
  return out;
}

/** One candidate as the judge would see it: name, gloss, the passage that matched, why. */
export function card(doc: Doc, r: Ranked): string {
  const lines = [`- [[${doc.name}]]${r.why ? ` (${r.why})` : ''}: ${doc.gloss}`];
  if (r.passage) lines.push(`  > ${clip(plain(r.passage), PASSAGE)}`);
  return lines.join('\n');
}

/** A packet's size in characters: brief, source and cards. Characters, not tokens. */
export function packetChars(cards: string[], sourceChars: number, briefChars: number): number {
  return briefChars + sourceChars + cards.reduce((s, c) => s + c.length + 1, 0);
}

/** What hoard's whole roster would add to the packet: a name-and-gloss row per page. */
export function rosterChars(corpus: Corpus, source: Source): number {
  return corpus.docs.filter((d) => d.relpath !== source.relpath)
    .reduce((s, d) => s + `- [[${d.name}]]: ${d.gloss}\n`.length, 0);
}
