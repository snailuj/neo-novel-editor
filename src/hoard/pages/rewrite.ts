// Rewriting [[links]] in a page's or chapter's HTML, for a rename. A link is found as the
// window finds it (wiki/links.ts): in each paragraph's text, inline code masked, by the
// grammar in librarian/links.ts. Only the link's target is replaced; its anchor, alias,
// spacing and any markup around it stay byte for byte. Paragraphs of class wiki-code are
// fenced code (wiki/convert.ts), so they are left alone. A target that markup splits
// (`[[<b>Old</b>]]`) cannot be replaced without unbalancing the tags, so it is counted and
// left. Pure: the caller says which targets resolve to the renamed page.
import { maskCodeSpans, WIKILINK } from '../../librarian/links.ts';

// Named entities as html.ts reads them, so offsets agree with the window's textContent.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const ENTITY = /^&(#x[0-9a-f]+|#\d+|[a-z]+);/i;
const PARAGRAPH = /<p(\s[^>]*)?>([\s\S]*?)<\/p>/gi;
const CODE_CLASS = /\bclass\s*=\s*(?:"[^"]*\bwiki-code\b[^"]*"|'[^']*\bwiki-code\b[^']*')/i;

/** Given a link's target, the title it should now carry, or null to leave the link. */
export type Retarget = (target: string) => string | null;

/** The text of a paragraph's inner HTML, and for each UTF-16 unit of it where it sits in the HTML. */
export function textUnits(inner: string): { text: string; start: number[]; end: number[] } {
  let text = '';
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < inner.length;) {
    if (inner[i] === '<') {
      const close = inner.indexOf('>', i);
      if (close >= 0) { i = close + 1; continue; }
    }
    let decoded = inner[i]!;
    let width = 1;
    if (inner[i] === '&') {
      const m = ENTITY.exec(inner.slice(i, i + 12));
      const name = m?.[1];
      if (m && name) {
        let value: string | undefined;
        if (name[0] === '#') {
          const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
          if (Number.isFinite(code) && code <= 0x10ffff) value = String.fromCodePoint(code);
        } else {
          value = ENTITIES[name.toLowerCase()];
        }
        if (value !== undefined) { decoded = value; width = m[0].length; }
      }
    }
    for (let u = 0; u < decoded.length; u++) { start.push(i); end.push(i + width); }
    text += decoded;
    i += width;
  }
  return { text, start, end };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');

interface Found {
  pIdx: number;
  /** Where the paragraph's inner HTML begins in the file. */
  innerAt: number;
  inner: string;
  units: ReturnType<typeof textUnits>;
  /** The link in the paragraph's text. */
  off: number;
  len: number;
  /** The target's range in the paragraph's text, and its title now. */
  from: number;
  to: number;
  title: string;
}

function* found(html: string, retarget: Retarget): Generator<Found> {
  const pattern = new RegExp(WIKILINK.source, 'gud');
  let pIdx = -1;
  for (const p of html.matchAll(PARAGRAPH)) {
    pIdx++;
    if (CODE_CLASS.test(p[1] ?? '')) continue;
    const inner = p[2]!;
    if (!inner.includes('[[')) continue;
    const units = textUnits(inner);
    for (const m of maskCodeSpans(units.text).matchAll(pattern)) {
      const range = m.indices?.groups?.['target'];
      if (!range) continue;
      const title = retarget(m.groups!['target']!.trim());
      if (title === null || title === units.text.slice(range[0], range[1])) continue;
      yield { pIdx, innerAt: p.index + p[0].indexOf('>') + 1, inner, units, off: m.index, len: m[0].length, from: range[0], to: range[1], title };
    }
  }
}

export interface Rewritten {
  html: string;
  rewritten: number;
  /** Links that resolve to the page but could not be rewritten safely. */
  skipped: number;
}

export function rewriteHtml(html: string, retarget: Retarget): Rewritten {
  const splices: { at: number; to: number; with: string }[] = [];
  let skipped = 0;
  for (const f of found(html, retarget)) {
    const a = f.units.start[f.from]!;
    const b = f.units.end[f.to - 1]!;
    if (f.to <= f.from || f.inner.slice(a, b).includes('<')) { skipped++; continue; }
    splices.push({ at: f.innerAt + a, to: f.innerAt + b, with: escapeHtml(f.title) });
  }
  let out = html;
  for (const s of splices.reverse()) out = out.slice(0, s.at) + s.with + out.slice(s.to);
  return { html: out, rewritten: splices.length, skipped };
}

/** One link to change through the window's `replace`: the paragraph, the link's range in its text, what it reads and what it should. */
export interface WindowEdit {
  pIdx: number;
  off: number;
  len: number;
  expected: string;
  replacement: string;
}

/** The same rewrite as window edits, in file order. A target that markup splits is included: `replace` works on text. */
export function editsFor(html: string, retarget: Retarget): WindowEdit[] {
  const edits: WindowEdit[] = [];
  for (const f of found(html, retarget)) {
    const expected = f.units.text.slice(f.off, f.off + f.len);
    const replacement = f.units.text.slice(f.off, f.from) + f.title + f.units.text.slice(f.to, f.off + f.len);
    edits.push({ pIdx: f.pIdx, off: f.off, len: f.len, expected, replacement });
  }
  return edits;
}

/** Paragraph texts with edits applied, as the window would: later offsets first, so earlier ones hold. */
export function applyToText(texts: readonly string[], edits: readonly WindowEdit[]): string[] {
  const out = [...texts];
  for (const e of [...edits].reverse()) out[e.pIdx] = out[e.pIdx]!.slice(0, e.off) + e.replacement + out[e.pIdx]!.slice(e.off + e.len);
  return out;
}
