// What the window draws for one chapter's marks: where each is found now, the places to
// highlight under each name, and which are stale. Pure, so it is tested without a page.
// Only open and flagged marks are drawn; resolved, accepted and rejected ones stay in
// the list but not on the page. A mark whose quote is gone is stale: listed, not drawn.
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { locate, type Span } from './anchor.ts';
import { isSuggestion } from './model.ts';

export const NAMES = ['comment', 'highlight', 'suggestion', 'flagged'] as const;
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
  if (isSuggestion(mark.kind)) return 'suggestion';
  return mark.kind === 'highlight' ? 'highlight' : 'comment';
};

export function drawChapter(chId: string, marks: readonly Mark[], paragraphs: readonly string[]): Drawn {
  const drawn: Drawn = { found: new Map(), places: { comment: [], highlight: [], suggestion: [], flagged: [] }, stale: [] };
  for (const mark of marks) {
    const span = locate(paragraphs, mark.anchor);
    drawn.found.set(mark.id, span);
    if (span === null) {
      drawn.stale.push(mark.id);
      continue;
    }
    const name = drawnUnder(mark);
    // an insertion's quote is empty: there are no words to draw it on
    if (name && span.len > 0) drawn.places[name].push({ chId, ...span });
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
