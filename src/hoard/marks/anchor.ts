// Where a mark sits in a chapter. A mark keeps its exact quote, which lies inside one
// paragraph, and up to CONTEXT units of the chapter's text either side of it, with the
// paragraphs joined by a newline. Finding it again looks for the quote in every
// paragraph and takes the copy whose surroundings still match best; the place it was
// made only breaks a full tie. There is no fuzzy match: a quote that is gone is gone,
// and the mark is stale until it comes back. Offsets are UTF-16 units of a paragraph's
// text, as the plugin host's places count them.

export const CONTEXT = 32;

export interface Anchor {
  exact: string;
  prefix: string;
  suffix: string;
  pIdx: number;
  off: number;
  commit: string | null;
}

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

export function locate(paragraphs: readonly string[], anchor: Anchor): Span | null {
  const { exact } = anchor;
  if (!exact || exact.includes('\n')) return null;
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
