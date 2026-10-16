// A wiki page's HTML with one change made, worked out in the window on a detached copy of
// the page (DOMParser runs no script and loads nothing), so the browser's own parser and
// serialiser, which NEO saves with, shape it. Paragraphs and offsets count as the host
// counts them: every <p> in the page, and each one's textContent. Only the changed
// paragraph's bytes change; the rest of the file is kept as it was, so a page that came
// in from an import keeps its own bytes but for the one paragraph.
import { paragraphHtml } from '../html.ts';

export interface Spot { pIdx: number; off: number; len: number }

const P = /<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi;

// The range of a paragraph's text from off to off + len, as textContent counts it.
function rangeIn(p: Element, off: number, len: number): Range | null {
  const doc = p.ownerDocument;
  const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  const range = doc.createRange();
  let at = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const n = node.textContent?.length ?? 0;
    if (!started && off <= at + n) { range.setStart(node, off - at); started = true; }
    if (started && off + len <= at + n) { range.setEnd(node, off + len - at); return range; }
    at += n;
  }
  // an empty paragraph has no text to stand in: the point is its start
  if (!started && off === 0 && len === 0) { range.setStart(p, 0); range.collapse(true); return range; }
  return null;
}

/** Each paragraph's words, as the host counts them. */
export function paragraphTexts(html: string): string[] {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  return [...doc.body.querySelectorAll('p')].map((p) => p.textContent ?? '');
}

/**
 * The page's HTML with the len units at off in paragraph pIdx made to read text, or null
 * when they do not read expected, the paragraph is not there, or the page's paragraphs
 * cannot be told apart in its bytes.
 */
export function editPage(html: string, at: Spot, expected: string, text: string): string | null {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const ps = doc.body.querySelectorAll('p');
  const p = ps[at.pIdx];
  // the bytes' paragraphs must be the parsed ones, one for one, to splice one back in
  if (!p || ps.length !== paragraphHtml(html).length) return null;
  const was = p.textContent ?? '';
  // NEO's empty paragraph is a lone <br>, which typing into it takes away
  const placeholder = was === '' && p.childNodes.length === 1 && p.firstChild?.nodeName === 'BR';
  if (was.slice(at.off, at.off + at.len) !== expected) return null;
  const want = was.slice(0, at.off) + text + was.slice(at.off + at.len);
  const range = rangeIn(p, at.off, at.len);
  if (!range) return null;
  // the elements that held words before, so only those the change empties go
  const held = new Set([...p.querySelectorAll('*')].filter((e) => e.textContent));
  range.deleteContents();
  if (text) range.insertNode(doc.createTextNode(text));
  for (const e of [...p.querySelectorAll('*')].reverse()) {
    if (held.has(e) && !e.textContent && !e.querySelector('br, img')) e.remove();
  }
  if (placeholder && text) p.querySelector('br')?.remove();
  p.normalize();
  // NEO's empty paragraph holds a <br>, so it keeps its height
  if (!p.textContent && !p.querySelector('br')) p.append(doc.createElement('br'));
  if ((p.textContent ?? '') !== want) return null;
  let n = -1;
  return html.replace(P, (whole) => (++n === at.pIdx ? p.outerHTML : whole));
}
