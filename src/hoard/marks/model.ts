// A mark's life, as the roadmap's sheet 4 draws it. Comments and highlights close by
// resolution and can be reopened. Suggestions (insertion, deletion, substitution) are
// accepted, rejected or flagged, and a flagged one is then accepted or rejected. Stale
// is not a state here: a mark whose quote is gone is drawn as stale while that lasts.
// Every function returns a new mark and leaves the one it was given alone; ids and
// times come from the caller, so this file reads no clock and makes no ids.
import type { Mark, MarkAnchor, MarkEntry, MarkKind, MarkState, MarkWho } from '../../generated/hoard-marks-v1.js';

const NOTE_LINES = new Set(['open>resolved', 'resolved>open']);
const SUGGESTION_LINES = new Set(['open>accepted', 'open>rejected', 'open>flagged', 'flagged>accepted', 'flagged>rejected']);

export const isSuggestion = (kind: MarkKind): boolean => kind === 'insertion' || kind === 'deletion' || kind === 'substitution';

export function canMove(kind: MarkKind, from: MarkState, to: MarkState): boolean {
  return (isSuggestion(kind) ? SUGGESTION_LINES : NOTE_LINES).has(`${from}>${to}`);
}

export interface NewMark {
  id: string;
  kind: MarkKind;
  anchor: MarkAnchor;
  body?: string;
  proposed?: string;
  who: MarkWho;
  at: string;
}

const blank = (text: string | undefined) => text === undefined || text.trim() === '';

export function newMark(input: NewMark): Mark {
  const { id, kind, anchor, body, proposed, who, at } = input;
  if (kind === 'comment' && blank(body)) throw new RangeError('a comment needs words');
  if ((kind === 'insertion' || kind === 'substitution') !== (proposed !== undefined)) {
    throw new RangeError(`${kind}: proposed text is for insertions and substitutions only, and they need it`);
  }
  if ((anchor.exact === '') !== (kind === 'insertion')) throw new RangeError(`${kind}: only an insertion has an empty quote`);
  const mark: Mark = {
    id, kind, anchor: { ...anchor }, state: 'open', created: { who, at },
    thread: blank(body) ? [] : [{ id: `${id}-0`, who, at, body: body as string }],
    history: [],
  };
  if (proposed !== undefined) mark.proposed = proposed;
  return mark;
}

export function reply(mark: Mark, entry: MarkEntry): Mark {
  if (blank(entry.body)) throw new RangeError('a reply needs words');
  return { ...mark, thread: [...mark.thread, { ...entry }] };
}

export function transition(mark: Mark, to: MarkState, who: MarkWho, at: string): Mark {
  if (!canMove(mark.kind, mark.state, to)) throw new RangeError(`a ${mark.kind} cannot go from ${mark.state} to ${to}`);
  return { ...mark, state: to, history: [...mark.history, { state: to, who, at }] };
}
