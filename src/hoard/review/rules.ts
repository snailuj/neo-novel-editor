// The librarian's review of the writer's suggestion on one of its pages. It accepts
// unless applying the change would go wrong, and then it flags it with a reason the
// writer reads as the librarian's comment: the words it changes are gone, another
// suggestion still waiting changes the same words, or the change leaves a [[link]] that
// names no page where the words before had none. Hoard's checks join this list later.
// There is no judgement of whether the change is true to the world: nothing here has a
// model to make one. Pure, so it runs against the page as the window holds it now.
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { locate, type Span } from '../marks/anchor.ts';
import { isSuggestion } from '../marks/model.ts';
import { linksIn } from '../wiki/links.ts';

export type Review =
  | { verdict: 'accept'; place: Span; expected: string; text: string }
  | { verdict: 'flag'; reason: string };

interface Pages { get(target: string): string | undefined }

const waiting = (mark: Mark) => isSuggestion(mark.kind) && (mark.state === 'open' || mark.state === 'flagged');
const clip = (text: string, n = 60) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// Two changes in one paragraph meet when their words overlap; an insertion meets words
// it falls strictly inside, and another insertion at its own point.
function meets(a: Span, b: Span): boolean {
  if (a.pIdx !== b.pIdx) return false;
  if (a.len === 0 && b.len === 0) return a.off === b.off;
  if (a.len === 0) return b.off < a.off && a.off < b.off + b.len;
  if (b.len === 0) return a.off < b.off && b.off < a.off + a.len;
  return a.off < b.off + b.len && b.off < a.off + a.len;
}

const missing = (text: string, pages: Pages) => new Set(linksIn([text]).map((l) => l.target).filter((t) => !pages.get(t)));

export function reviewSuggestion(mark: Mark, marks: readonly Mark[], paragraphs: readonly string[], pages: Pages): Review {
  if (!waiting(mark)) throw new RangeError(`${mark.id} is a ${mark.state} ${mark.kind}, not a suggestion waiting for review`);
  const span = locate(paragraphs, mark.anchor);
  if (!span) {
    return { verdict: 'flag', reason: 'The words this suggestion changes are no longer on the page, so it was not applied.' };
  }
  for (const other of marks) {
    if (other.id === mark.id || !waiting(other)) continue;
    const there = locate(paragraphs, other.anchor);
    if (there && meets(span, there)) {
      return {
        verdict: 'flag',
        reason: `Another suggestion is still waiting on these words (“${clip(other.anchor.exact || other.proposed || '')}”). Settle that one first; this one stays here until then.`,
      };
    }
  }
  const text = mark.proposed ?? '';
  const before = paragraphs[span.pIdx];
  const after = before.slice(0, span.off) + text + before.slice(span.off + span.len);
  const was = missing(before, pages);
  const broken = [...missing(after, pages)].filter((t) => !was.has(t));
  if (broken.length) {
    const named = broken.map((t) => `[[${t}]]`).join(', ');
    return {
      verdict: 'flag',
      reason: `${named} ${broken.length === 1 ? 'names' : 'name'} no wiki page, so the change would leave a link that goes nowhere. Check the name, or accept it anyway if the page is still to come.`,
    };
  }
  return { verdict: 'accept', place: span, expected: before.slice(span.off, span.off + span.len), text };
}
