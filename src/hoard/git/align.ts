// Puts blame lines against the window's paragraphs. The chapter driver gives each
// top-level block a line, and a list or a quotation holds several paragraphs in one;
// the window counts every <p> in order. Each <p> in a line takes that line's blame,
// provided its text is the paragraph's text; one that differs (written since the save,
// say) is credited to no one rather than to the wrong person.
import { paragraphTexts } from '../html.ts';
import type { BlameLine } from './blame.ts';

export function alignBlame<L extends BlameLine>(lines: readonly L[], paragraphs: readonly string[]): (L | null)[] {
  const out: (L | null)[] = paragraphs.map(() => null);
  let i = 0;
  for (const line of lines) {
    for (const text of paragraphTexts(line.html)) {
      if (i >= paragraphs.length) return out;
      if (text === paragraphs[i]) out[i] = line;
      i++;
    }
  }
  return out;
}
