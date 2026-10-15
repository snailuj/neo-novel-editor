// Folding, so a search finds words however they were typed: capitals, accents (NFKD less
// its combining marks, so Ș is S and ﬁ is fi), curly quotes and apostrophes (as straight
// ones), a run of white space (as one space) and Markdown's emphasis marks * and _ (as
// nothing, since a wiki page keeps its Markdown as text). The folded text maps back to
// the text as written, so a match is a place that selects exactly the words.

const SINGLE = /[‘’‚‛′]/;
const DOUBLE = /[“”„‟″]/;
const SPACE = /\s/;
const MARKS = /\p{M}/gu;

export interface Folded {
  text: string;
  /**
   * For each unit of the folded text, where the character that made it starts in the
   * text as written. null when that is the unit's own index throughout and the two are
   * the same length, as for most prose.
   */
  at: Uint32Array | null;
}

function foldChar(ch: string): string {
  if (ch === '*' || ch === '_') return '';
  if (SINGLE.test(ch)) return "'";
  if (DOUBLE.test(ch)) return '"';
  return ch.normalize('NFKD').replace(MARKS, '').toLowerCase();
}

export function fold(text: string): Folded {
  let out = '';
  const at: number[] = [];
  let same = true;
  let spaced = false;
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i);
    let ch: string;
    let made: string;
    if (code < 0x80) {
      ch = text[i]!;
      made = code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : ch === '*' || ch === '_' ? '' : ch;
    } else {
      ch = String.fromCodePoint(text.codePointAt(i)!);
      made = foldChar(ch);
    }
    if (SPACE.test(ch)) {
      made = spaced ? '' : ' ';
      spaced = true;
    } else if (made) {
      spaced = false;
    }
    if (made.length !== ch.length || out.length !== i) same = false;
    for (let k = 0; k < made.length; k++) at.push(i);
    out += made;
    i += ch.length;
  }
  return { text: out, at: same ? null : Uint32Array.from(at) };
}

/** A query folded as the text is, without its spaces at either end. */
export function foldQuery(query: string): string {
  return fold(query).text.trim();
}

/** The place in the text as written of the folded text's units a to b (b past a). */
export function originalSpan(text: string, at: Uint32Array | null, a: number, b: number): { off: number; len: number } {
  if (!at) return { off: a, len: b - a };
  const off = at[a]!;
  const last = at[b - 1]!;
  const end = last + ((text.codePointAt(last) ?? 0) > 0xffff ? 2 : 1);
  return { off, len: end - off };
}
