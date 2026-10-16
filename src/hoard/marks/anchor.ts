// Where a mark sits in a chapter. A mark keeps its exact quote, which lies inside one
// paragraph, and up to CONTEXT units of the chapter's text either side of it, with the
// paragraphs joined by a newline. Finding it again looks for the quote in every
// paragraph and takes the copy whose surroundings still match best; the place it was
// made only breaks a full tie. There is no fuzzy match: a quote that is gone is gone,
// and the mark is stale until it comes back. Offsets are UTF-16 units of a paragraph's
// text, as the plugin host's places count them.

import type { MarkAnchor } from '../../generated/hoard-marks-v1.js';

export const CONTEXT = 32;

export type Anchor = MarkAnchor;

export interface Span {
  pIdx: number;
  off: number;
  len: number;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// The context before and after [start, end) of the joined text, never half a pair.
function context(joined: string, start: number, end: number): { prefix: string; suffix: string } {
  let prefix = joined.slice(Math.max(0, start - CONTEXT), start);
  if (prefix && start - CONTEXT > 0 && isLow(prefix.charCodeAt(0))) prefix = prefix.slice(1);
  let suffix = joined.slice(end, end + CONTEXT);
  if (suffix && end + CONTEXT < joined.length && isHigh(suffix.charCodeAt(suffix.length - 1))) suffix = suffix.slice(0, -1);
  return { prefix, suffix };
}

function starts(paragraphs: readonly string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const p of paragraphs) {
    out.push(at);
    at += p.length + 1;
  }
  return out;
}

// A place with no length stands for its whole paragraph.
export function anchorAt(paragraphs: readonly string[], place: Span, commit: string | null = null): Anchor {
  const text = paragraphs[place.pIdx];
  if (text === undefined) throw new RangeError(`no paragraph ${place.pIdx}`);
  const whole = place.len === 0;
  const off = whole ? 0 : place.off;
  const len = whole ? text.length : place.len;
  if (off < 0 || off + len > text.length) throw new RangeError(`place ${place.off}+${place.len} is outside paragraph ${place.pIdx}`);
  const joined = paragraphs.join('\n');
  const start = starts(paragraphs)[place.pIdx] + off;
  return { exact: text.slice(off, off + len), ...context(joined, start, start + len), pIdx: place.pIdx, off, commit };
}

// An insertion's anchor: a point between two units, with an empty quote.
export function anchorPoint(paragraphs: readonly string[], point: { pIdx: number; off: number }, commit: string | null = null): Anchor {
  const text = paragraphs[point.pIdx];
  if (text === undefined) throw new RangeError(`no paragraph ${point.pIdx}`);
  if (point.off < 0 || point.off > text.length) throw new RangeError(`point ${point.off} is outside paragraph ${point.pIdx}`);
  const start = starts(paragraphs)[point.pIdx] + point.off;
  return { exact: '', ...context(paragraphs.join('\n'), start, start), pIdx: point.pIdx, off: point.off, commit };
}

function sharedEnd(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// The span in `at`'s paragraph that the joined text's offset falls in, or null on the
// newline between two paragraphs.
function spanAt(paragraphs: readonly string[], at: number[], pos: number): Span | null {
  for (let pIdx = paragraphs.length - 1; pIdx >= 0; pIdx--) {
    if (at[pIdx] <= pos) return pos - at[pIdx] <= paragraphs[pIdx].length ? { pIdx, off: pos - at[pIdx], len: 0 } : null;
  }
  return null;
}

// An insertion point is where the whole of its prefix ends or the whole of its suffix
// starts; of those, the one whose other side matches more wins, then the nearest.
function locatePoint(paragraphs: readonly string[], anchor: Anchor): Span | null {
  const joined = paragraphs.join('\n');
  const at = starts(paragraphs);
  const { prefix, suffix } = anchor;
  const points = new Set<number>();
  if (!prefix && !suffix) points.add(0);
  for (let i = prefix ? joined.indexOf(prefix) : -1; i !== -1; i = joined.indexOf(prefix, i + 1)) points.add(i + prefix.length);
  for (let i = suffix ? joined.indexOf(suffix) : -1; i !== -1; i = joined.indexOf(suffix, i + 1)) points.add(i);
  let best: { span: Span; score: number; distance: [number, number] } | null = null;
  for (const pos of [...points].sort((a, b) => a - b)) {
    const span = spanAt(paragraphs, at, pos);
    if (!span) continue;
    const found = context(joined, pos, pos);
    const score = sharedEnd(found.prefix, prefix) + sharedStart(found.suffix, suffix);
    const distance: [number, number] = [Math.abs(span.pIdx - anchor.pIdx), Math.abs(span.off - anchor.off)];
    const closer = best !== null && score === best.score
      && (distance[0] < best.distance[0] || (distance[0] === best.distance[0] && distance[1] < best.distance[1]));
    if (best === null || score > best.score || closer) best = { span, score, distance };
  }
  return best === null ? null : (best as { span: Span }).span;
}

export function locate(paragraphs: readonly string[], anchor: Anchor): Span | null {
  const { exact } = anchor;
  if (exact === '') return locatePoint(paragraphs, anchor);
  if (exact.includes('\n')) return null;
  const joined = paragraphs.join('\n');
  const at = starts(paragraphs);
  let best: { span: Span; score: number; distance: [number, number] } | null = null;
  paragraphs.forEach((text, pIdx) => {
    for (let off = text.indexOf(exact); off !== -1; off = text.indexOf(exact, off + 1)) {
      const start = at[pIdx] + off;
      const found = context(joined, start, start + exact.length);
      const score = sharedEnd(found.prefix, anchor.prefix) + sharedStart(found.suffix, anchor.suffix);
      const distance: [number, number] = [Math.abs(pIdx - anchor.pIdx), Math.abs(off - anchor.off)];
      const closer = best !== null && score === best.score
        && (distance[0] < best.distance[0] || (distance[0] === best.distance[0] && distance[1] < best.distance[1]));
      if (best === null || score > best.score || closer) best = { span: { pIdx, off, len: exact.length }, score, distance };
    }
  });
  return best === null ? null : (best as { span: Span }).span;
}
