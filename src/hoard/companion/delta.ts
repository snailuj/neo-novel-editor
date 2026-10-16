// Which paragraphs of a chapter are new writing, hoard's companion delta for NEO's
// paragraphs. A paragraph of the text after counts when its words, white space folded,
// were not in the text before; copies are counted, so a second copy of a paragraph is
// new and a moved one is not. Formatting never reaches here: paragraphs are their text.
// Empty paragraphs never count. Pure.

const words = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** The indexes, in `after`, of the paragraphs whose words are new. */
export function newParagraphs(before: readonly string[], after: readonly string[]): number[] {
  const left = new Map<string, number>();
  for (const p of before) {
    const w = words(p);
    left.set(w, (left.get(w) ?? 0) + 1);
  }
  const out: number[] = [];
  after.forEach((p, i) => {
    const w = words(p);
    if (!w) return;
    const n = left.get(w) ?? 0;
    if (n > 0) left.set(w, n - 1);
    else out.push(i);
  });
  return out;
}
