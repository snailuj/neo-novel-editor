// A map of the wiki for the judge: every page by folder, so it can reach a page the
// shortlist missed. Cut to a size by a ladder: aliases go first, then link counts, then
// pages, farthest from the source in links first, with a count of what is not shown.
// Pure.
import { linkHops, type Corpus, type Doc, type Source } from './shortlist.ts';

export interface WikiMap {
  text: string;
  rung: 1 | 2 | 3 | 4;
  /** Relpaths the map lists. */
  listed: string[];
  /** Pages left out to fit. */
  hidden: number;
}

const HEADER = {
  1: 'Rung 1 of 4: every page, with its aliases and link count.',
  2: 'Rung 2 of 4: every page, with its link count; aliases left out to fit.',
  3: 'Rung 3 of 4: every page, titles only; aliases and link counts left out to fit.',
  4: 'Rung 4 of 4: titles only, the pages nearest the source in links; the rest left out to fit.',
} as const;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function folderOf(relpath: string): string {
  const at = relpath.lastIndexOf('/');
  return at === -1 ? '/' : `${relpath.slice(0, at)}/`;
}

function render(corpus: Corpus, rung: WikiMap['rung'], docs: readonly Doc[], hidden: number): string {
  const folders = new Map<string, Doc[]>();
  for (const d of docs) folders.set(folderOf(d.relpath), [...folders.get(folderOf(d.relpath)) ?? [], d]);
  const out: string[] = [HEADER[rung]];
  for (const folder of [...folders.keys()].sort(cmp)) {
    out.push('', folder);
    for (const d of folders.get(folder)!.sort((a, b) => cmp(a.name, b.name) || cmp(a.relpath, b.relpath))) {
      const n = corpus.edges.get(d.relpath)?.size ?? 0;
      const aka = rung === 1 && d.aliases.length ? ` (aka ${[...d.aliases].sort(cmp).join(', ')})` : '';
      const links = rung <= 2 ? ` [${n} link${n === 1 ? '' : 's'}]` : '';
      out.push(`- ${d.name}${aka}${links}`);
    }
  }
  if (hidden) out.push('', `${hidden} pages not shown, the farthest from the source in links.`);
  return `${out.join('\n')}\n`;
}

export function wikiMap(corpus: Corpus, maxChars: number, source?: Source): WikiMap {
  const pages = corpus.docs.filter((d) => d.relpath !== source?.relpath);
  for (const rung of [1, 2, 3] as const) {
    const text = render(corpus, rung, pages, 0);
    if (text.length <= maxChars) return { text, rung, listed: pages.map((d) => d.relpath), hidden: 0 };
  }
  // Nearest first, a page no link reaches last, ties by title; the map keeps the longest
  // run of that order that fits. Each page adds a line, so the length only grows with it.
  const hops = source ? linkHops(corpus, source) : new Map<string, number>();
  const far = Number.MAX_SAFE_INTEGER;
  const order = [...pages].sort((a, b) => (hops.get(a.relpath) ?? far) - (hops.get(b.relpath) ?? far)
    || cmp(a.name, b.name) || cmp(a.relpath, b.relpath));
  const fits = (k: number) => render(corpus, 4, order.slice(0, k), order.length - k).length <= maxChars;
  if (!fits(0)) return { text: '', rung: 4, listed: [], hidden: order.length };
  let lo = 0;
  let hi = order.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  const kept = order.slice(0, lo);
  return { text: render(corpus, 4, kept, order.length - lo), rung: 4, listed: kept.map((d) => d.relpath), hidden: order.length - lo };
}
