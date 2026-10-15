// What the window draws for one chapter's marks: where each is found now, the places to
// highlight under each name, and which are stale. Pure, so it is tested without a page.
// Only open and flagged marks are drawn; resolved, accepted and rejected ones stay in
// the list but not on the page. An open or flagged mark whose quote is gone is stale:
// listed, not drawn. A closed one is not, since an accepted change takes its words away.
// An insertion has no words, so it is drawn on the letter after its point, or the one
// before at a paragraph's end.
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { locate, type Span } from './anchor.ts';
import { isSuggestion } from './model.ts';

export const NAMES = ['comment', 'highlight', 'suggestion', 'insertion', 'flagged'] as const;
export type DrawName = (typeof NAMES)[number];

export interface Place { chId: string; pIdx: number; off: number; len: number }

export interface Drawn {
  /** Every mark's span now; null when its quote is gone. */
  found: Map<string, Span | null>;
  places: Record<DrawName, Place[]>;
  stale: string[];
}

const drawnUnder = (mark: Mark): DrawName | null => {
  if (mark.state === 'flagged') return 'flagged';
  if (mark.state !== 'open') return null;
  if (mark.kind === 'insertion') return 'insertion';
  if (isSuggestion(mark.kind)) return 'suggestion';
  return mark.kind === 'highlight' ? 'highlight' : 'comment';
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

// The letter beside an insertion's point, whole even when it is a surrogate pair.
function letterBeside(text: string, off: number): { off: number; len: number } | null {
  if (off < text.length) return { off, len: isHigh(text.charCodeAt(off)) && isLow(text.charCodeAt(off + 1)) ? 2 : 1 };
  if (off === 0) return null;
  const pair = off >= 2 && isLow(text.charCodeAt(off - 1)) && isHigh(text.charCodeAt(off - 2));
  return pair ? { off: off - 2, len: 2 } : { off: off - 1, len: 1 };
}

export function drawChapter(chId: string, marks: readonly Mark[], paragraphs: readonly string[]): Drawn {
  const drawn: Drawn = { found: new Map(), places: { comment: [], highlight: [], suggestion: [], insertion: [], flagged: [] }, stale: [] };
  for (const mark of marks) {
    const span = locate(paragraphs, mark.anchor);
    drawn.found.set(mark.id, span);
    const name = drawnUnder(mark);
    if (span === null) {
      if (name) drawn.stale.push(mark.id);
      continue;
    }
    if (!name) continue;
    const at = span.len > 0 ? span : letterBeside(paragraphs[span.pIdx], span.off);
    if (at) drawn.places[name].push({ chId, pIdx: span.pIdx, off: at.off, len: at.len });
  }
  return drawn;
}

// In page order; a stale mark sits where it was made.
export function orderForList(marks: readonly Mark[], drawn: Drawn): Mark[] {
  const key = (m: Mark) => drawn.found.get(m.id) ?? m.anchor;
  return [...marks].sort((a, b) => key(a).pIdx - key(b).pIdx || key(a).off - key(b).off);
}

const clip = (text: string, n = 140) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const quoted = (text: string) => `“${clip(text)}”`;

// What a card says its mark is about: a note's words, or the change a suggestion asks.
export function label(mark: Mark): string {
  const proposed = mark.proposed ?? '';
  switch (mark.kind) {
    case 'insertion': return `Insert ${quoted(proposed)}`;
    case 'deletion': return `Delete ${quoted(mark.anchor.exact)}`;
    case 'substitution': return `Replace ${quoted(mark.anchor.exact)} with ${quoted(proposed)}`;
    default: return quoted(mark.anchor.exact);
  }
}

// The drawn mark around a caret or selection start, the smallest when they nest.
export function markAt(drawn: Drawn, marks: readonly Mark[], place: Place): string | null {
  let best: { id: string; len: number } | null = null;
  for (const mark of marks) {
    if (drawnUnder(mark) === null) continue;
    const span = drawn.found.get(mark.id);
    if (!span || span.pIdx !== place.pIdx || place.off < span.off || place.off > span.off + span.len) continue;
    if (best === null || span.len < best.len) best = { id: mark.id, len: span.len };
  }
  return best?.id ?? null;
}
