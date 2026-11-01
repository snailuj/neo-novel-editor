// What typing in the Wiki pane changed in one paragraph, as the one span the main half
// writes (wiki/edit.ts): the words between what stayed at the front and what stayed at
// the end. Offsets count as textContent does, in UTF-16 units, and a span never starts
// or ends inside a character outside the Basic Multilingual Plane.

export interface TextChange {
  off: number;
  len: number;
  /** What the span read. */
  expected: string;
  /** What it reads now. */
  text: string;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The span of was that now reads differently, or null when nothing changed. */
export function textChange(was: string, now: string): TextChange | null {
  if (was === now) return null;
  let front = 0;
  const most = Math.min(was.length, now.length);
  while (front < most && was.charCodeAt(front) === now.charCodeAt(front)) front++;
  // a pair cut after its high half: the whole character is in the span
  if (front > 0 && isHigh(was.charCodeAt(front - 1))) front--;
  let back = 0;
  while (back < most - front && was.charCodeAt(was.length - 1 - back) === now.charCodeAt(now.length - 1 - back)) back++;
  // a pair cut before its low half
  if (back > 0 && isLow(was.charCodeAt(was.length - back))) back--;
  return {
    off: front,
    len: was.length - front - back,
    expected: was.slice(front, was.length - back),
    text: now.slice(front, now.length - back),
  };
}
