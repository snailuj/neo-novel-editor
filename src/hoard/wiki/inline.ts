// A line of Markdown as NEO's inline HTML. Emphasis becomes NEO's own b, i and s, and a
// code span <code>, by CommonMark's rules for delimiter runs: a run opens or closes by
// what stands either side of it, an underscore never inside a word, and a closer takes
// the nearest opener of its kind. ~~ is strike; a single ~ is text, as in Obsidian.
// Wikilinks, Markdown links, bare web addresses and code spans are kept whole, so
// nothing in them is emphasis; the links stay as written, which is how a writer makes
// one in NEO. A backslash before punctuation makes it a plain letter. Raw HTML is text.
//
// map[i] is where the line's unit i lands in the text (map[length] is the text's
// length): a run that became a tag lands where the next letter does, so a span of the
// line maps to the words it held.
//
// Pure.

export interface Inline {
  /** What the page shows: the paragraph's textContent. */
  text: string;
  html: string;
  map: number[];
}

const PUNCT = /[\p{P}\p{S}]/u;
const SPACE = /\s/u;
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const WHOLE = [
  /!?\[\[[^\]\n]*\]\]/y, // a wikilink or an embed
  /!?\[[^\]\n]*\]\([^)\s]*(?:\s+"[^"\n]*")?\)/y, // a Markdown link or image
  /<?https?:\/\/[^\s<>]+>?/y, // a web address
];

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Text { kind: 'text'; from: number; to: number; text: string; code?: boolean }
interface Delim {
  kind: 'delim';
  ch: '*' | '_' | '~';
  from: number;
  /** letters of the run not yet paired */
  left: number;
  /** letters that closed tags, from the run's left */
  closedBy: number;
  /** letters that opened tags, from the run's right */
  openedBy: number;
  canOpen: boolean;
  canClose: boolean;
  length: number;
  active: boolean;
  /** tags this run opens, outermost first, written after its leftover letters */
  opens: string[];
  /** tags this run closes, innermost first, written before its leftover letters */
  closes: string[];
}
type Atom = Text | Delim;

function runOf(s: string, at: number): number {
  let end = at;
  while (s[end] === s[at]) end++;
  return end - at;
}

function atoms(s: string): Atom[] {
  const out: Atom[] = [];
  let plainFrom = 0;
  let plain = '';
  const flush = (to: number) => {
    if (to > plainFrom || plain) out.push({ kind: 'text', from: plainFrom, to, text: plain });
    plain = '';
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) {
      flush(i);
      out.push({ kind: 'text', from: i, to: i + 2, text: s[i + 1]! });
      i += 2;
      plainFrom = i;
      continue;
    }
    if (ch === '`') {
      const n = runOf(s, i);
      const close = s.indexOf('`'.repeat(n), i + n);
      let end = close;
      while (end >= 0 && s[end + n] === '`') end = s.indexOf('`'.repeat(n), end + n + 1);
      if (end >= 0) {
        flush(i);
        out.push({ kind: 'text', from: i, to: end + n, text: s.slice(i + n, end), code: true });
        i = end + n;
        plainFrom = i;
        continue;
      }
      plain += s.slice(i, i + n);
      i += n;
      continue;
    }
    let whole = '';
    for (const re of WHOLE) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m) { whole = m[0]; break; }
    }
    if (whole) {
      plain += whole;
      i += whole.length;
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const n = runOf(s, i);
      if (ch === '~' && n !== 2) {
        plain += s.slice(i, i + n);
        i += n;
        continue;
      }
      const before = i === 0 ? ' ' : s[i - 1]!;
      const after = i + n >= s.length ? ' ' : s[i + n]!;
      const leftFlank = !SPACE.test(after) && (!PUNCT.test(after) || SPACE.test(before) || PUNCT.test(before));
      const rightFlank = !SPACE.test(before) && (!PUNCT.test(before) || SPACE.test(after) || PUNCT.test(after));
      const canOpen = ch === '_' ? leftFlank && (!rightFlank || PUNCT.test(before)) : leftFlank;
      const canClose = ch === '_' ? rightFlank && (!leftFlank || PUNCT.test(after)) : rightFlank;
      flush(i);
      out.push({ kind: 'delim', ch, from: i, left: n, closedBy: 0, openedBy: 0, canOpen, canClose, length: n, active: true, opens: [], closes: [] });
      i += n;
      plainFrom = i;
      continue;
    }
    plain += ch;
    i++;
  }
  flush(s.length);
  return out;
}

const TAGS = { '*': ['i', 'b'], _: ['i', 'b'], '~': ['s', 's'] } as const;

// CommonMark's process_emphasis, without the bottoms it keeps only for speed.
function match(list: Atom[]): void {
  for (let c = 0; c < list.length; c++) {
    const closer = list[c]!;
    if (closer.kind !== 'delim' || !closer.canClose) continue;
    while (closer.left > 0) {
      let o = c - 1;
      for (; o >= 0; o--) {
        const opener = list[o]!;
        if (opener.kind !== 'delim' || !opener.active || opener.ch !== closer.ch || !opener.canOpen || opener.left === 0) continue;
        // the rule of three: a run that can both open and close pairs by length
        const both = opener.canClose || closer.canOpen;
        if (both && (opener.length + closer.length) % 3 === 0 && (opener.length % 3 !== 0 || closer.length % 3 !== 0)) continue;
        if (closer.ch === '~' && (opener.left < 2 || closer.left < 2)) continue;
        break;
      }
      if (o < 0) break;
      const opener = list[o] as Delim;
      const used = closer.ch === '~' ? 2 : opener.left >= 2 && closer.left >= 2 ? 2 : 1;
      const tag = TAGS[closer.ch][used - 1]!;
      opener.left -= used;
      opener.openedBy += used;
      closer.left -= used;
      closer.closedBy += used;
      opener.opens.unshift(tag);
      closer.closes.push(tag);
      // what lies between can no longer pair across these
      for (let k = o + 1; k < c; k++) {
        const between = list[k]!;
        if (between.kind === 'delim') between.active = false;
      }
    }
  }
}

export function inline(s: string): Inline {
  const list = atoms(s);
  match(list);
  let text = '';
  let html = '';
  const map: number[] = new Array(s.length + 1);
  for (const atom of list) {
    if (atom.kind === 'text') {
      if (atom.code) {
        // the opening backticks land where the code starts, the closing ones after it
        const n = runOf(s, atom.from);
        for (let k = atom.from; k < atom.from + n; k++) map[k] = text.length;
        for (let k = 0; k < atom.text.length; k++) map[atom.from + n + k] = text.length + k;
        for (let k = atom.from + n + atom.text.length; k < atom.to; k++) map[k] = text.length + atom.text.length;
        html += `<code>${escapeHtml(atom.text)}</code>`;
      } else if (atom.to - atom.from !== atom.text.length) {
        // an escape: the backslash lands on the letter it frees
        for (let k = atom.from; k < atom.to; k++) map[k] = text.length;
        html += escapeHtml(atom.text);
      } else {
        for (let k = 0; k < atom.text.length; k++) map[atom.from + k] = text.length + k;
        html += escapeHtml(atom.text);
      }
      text += atom.text;
      continue;
    }
    // a run's letters: those that closed tags (its leftmost), those left over as text,
    // then those that opened tags (its rightmost); a tag's letters land where the next
    // letter of text does
    const kept = atom.length - atom.closedBy - atom.openedBy;
    html += atom.closes.map((t) => `</${t}>`).join('');
    for (let k = 0; k < atom.length; k++) {
      const into = Math.min(Math.max(k - atom.closedBy, 0), kept);
      map[atom.from + k] = text.length + into;
    }
    html += escapeHtml(atom.ch.repeat(kept));
    text += atom.ch.repeat(kept);
    html += atom.opens.map((t) => `<${t}>`).join('');
  }
  map[s.length] = text.length;
  return { text, html, map };
}
