// Unresolved wikilinks: an inventory, and the near misses worth a human glance. Ported
// from hoard's dangling.py.
//
// A writer outlines by linking things not yet written, and such a link stays unresolved
// until the page exists. So this reports and does not police. Only one row in it is a
// defect: a link that almost names an existing page, a typo dressed as an outline.
import { linksIn } from './links.ts';
import { getLogger } from './log.ts';
import { PageIndex } from './page-index.ts';
import { byCodePoint, sequenceRatio } from './py.ts';
import { HOARD_LAYOUT, type Layout, startsWithAny } from './scheme.ts';
import { type Note, zoneOf } from './vault.ts';

const log = getLogger('librarian.dangling');

/** Close enough to be a slip of the fingers, far enough not to be a naming choice. */
export const NEAR_MISS_RATIO = 0.85;
export const SOURCES_SHOWN = 3;

/** One unresolved target, every page that links it, and its nearest page. */
export interface Dangling {
  target: string;
  sources: string[];
  near: string | null;
  ratio: number;
}

/** Case and separators removed: what two names share when only style differs. */
function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Unresolved targets across the librarian zone, capture folders left out, most linked
 * first. Author bodies count: a typo in them is repaired by relink. A link only an alias
 * answers is neither resolved nor dangling; lint's LK1 owns it, so it is counted in the
 * log and skipped here.
 */
export function collect(notes: readonly Note[], attachments: Iterable<string> = [],
  layout: Layout = HOARD_LAYOUT): Dangling[] {
  const index = PageIndex.fromNotes(notes, attachments);
  // Basenames only: a suggestion must name something a basename link can reach.
  const known = new Map<string, string>();
  for (const [k, page] of index.entries()) known.set(normalise(k), page.relpath);
  const unresolved = new Map<string, Dangling>();
  let aliasOnly = 0;
  for (const [relpath, text] of notes) {
    if (zoneOf(relpath, layout) !== 'librarian' || startsWithAny(relpath, layout.captureDirs)) continue;
    for (const target of linksIn(text)) {
      if (index.resolve(target)) continue;
      if (index.resolveAlias(target)) {
        aliasOnly += 1;
        continue;
      }
      let item = unresolved.get(target);
      if (!item) unresolved.set(target, item = { target, sources: [], near: null, ratio: 0 });
      if (!item.sources.includes(relpath)) item.sources.push(relpath);
    }
  }
  for (const item of unresolved.values()) {
    [item.near, item.ratio] = nearest(item.target, known, new Set(item.sources));
  }
  log.info(`dangling: ${unresolved.size} unresolved target(s) over ${notes.length} note(s); `
    + `${aliasOnly} alias-only link(s) left to lint LK1`);
  return [...unresolved.values()].sort((a, b) => b.sources.length - a.sources.length
    || byCodePoint(a.target.toLowerCase(), b.target.toLowerCase()));
}

/**
 * The page this target nearly names, if it nearly names one. An exact match after
 * normalising differs from a page only in case or separators, so it is the page itself
 * or a deliberate twin. A page that writes the name as a link has declared it a separate
 * node, so it is never the suggestion.
 */
function nearest(target: string, known: Map<string, string>, exclude: Set<string>): [string | null, number] {
  const want = normalise(target);
  if (!want || known.has(want)) return [null, 0];
  let best: string | null = null;
  let ratio = 0;
  for (const [k, relpath] of known) {
    if (exclude.has(relpath)) continue;
    const score = sequenceRatio(want, k);
    if (score > ratio) [best, ratio] = [relpath, score];
  }
  return ratio >= NEAR_MISS_RATIO ? [best, ratio] : [null, 0];
}

/**
 * The unresolved targets whose name contains `name`, styling ignored: is anything
 * already linking the page an import is about to write? A name with no letters or
 * digits matches everything.
 */
export function matching(items: readonly Dangling[], name: string): Dangling[] {
  const want = normalise(name);
  return items.filter((d) => normalise(d.target).includes(want));
}

/**
 * Near misses first and in full, then the inventory. A ratio is 2M/T, so the only
 * exact tie at two places at or above the threshold is 0.875, which toFixed and
 * Python's format both round to 0.88.
 */
export function report(items: readonly Dangling[]): string[] {
  const lines = items.filter((d) => d.near)
    .map((d) => `near-miss: [[${d.target}]] ~ ${d.near} (${d.ratio.toFixed(2)}, linked from ${d.sources.join(', ')})`);
  if (lines.length) lines.push('');
  lines.push(`${items.length} unresolved target(s)`);
  for (const d of items) {
    const shown = d.sources.slice(0, SOURCES_SHOWN).join(', ');
    const more = d.sources.length - SOURCES_SHOWN;
    lines.push(`  ${String(d.sources.length).padStart(3)}  [[${d.target}]]  ${shown}${more > 0 ? `, +${more} more` : ''}`);
  }
  return lines;
}
