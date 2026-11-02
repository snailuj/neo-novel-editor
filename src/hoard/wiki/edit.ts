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

// ---- block patches ---------------------------------------------------------------------
// The pane saves what the writer did as a patch of blocks, not of words: a block is a <p>
// with the id citations point at (data-block). Blocks the writer did not touch are kept
// as bytes; one touched keeps its stored opening tag, and so every attribute the pane does
// not show, with the pane's id and aliases put in it; a block the pane made is written from
// the opening tag the pane gives; a block the pane no longer holds is gone.

export interface NowBlock {
  /** The stored block this one came from (blockKeys), or null for one the pane made. */
  key: string | null;
  /** Its data-block id as the pane holds it; '' for none. */
  id: string;
  /** Its data-alias ids, space-separated; '' for none. */
  alias: string;
  /** For a block the pane made: its opening tag. */
  open: string;
  inner: string;
  touched: boolean;
}

export interface Stored { key: string; start: number; end: number; open: string; inner: string }

const OPEN = /^<p(?:\s[^>]*)?>/i;
const ID = /\sdata-block="([^"]*)"/;
const ALIAS = /\sdata-alias="[^"]*"/;
const escapeAttr = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The page's blocks: each one's key, where it is in the bytes, its opening tag and inner HTML. */
export function readBlocks(html: string): Stored[] {
  const seen = new Map<string, number>();
  return [...html.matchAll(P)].map((m, i) => {
    const open = OPEN.exec(m[0])![0];
    const id = ID.exec(open)?.[1];
    // the first holder of an id owns it; a later one is addressed by its turn, and a block
    // with no id by its place in the page
    let key = `@${i}`;
    if (id !== undefined) {
      const turn = seen.get(id) ?? 0;
      seen.set(id, turn + 1);
      key = turn ? `${id}#${turn}` : id;
    }
    return { key, start: m.index!, end: m.index! + m[0].length, open, inner: m[0].slice(open.length, -4) };
  });
}

/** Each paragraph's key, in order: its data-block id, or a place for one with none. */
export const blockKeys = (html: string): string[] => readBlocks(html).map((b) => b.key);

/** An opening tag with its data-block and data-alias as given; '' leaves an attribute out. */
export function withIds(open: string, id: string, alias: string): string {
  let tag = open;
  if (id) tag = ID.test(tag) ? tag.replace(ID, ` data-block="${escapeAttr(id)}"`) : tag.replace(/>$/, ` data-block="${escapeAttr(id)}">`);
  else tag = tag.replace(ID, '');
  if (!alias) return tag.replace(ALIAS, '');
  const attr = ` data-alias="${escapeAttr(alias)}"`;
  return ALIAS.test(tag) ? tag.replace(ALIAS, attr) : tag.replace(/>$/, `${attr}>`);
}

/**
 * The page's HTML with the pane's blocks in it, or null when the page's blocks cannot be
 * told apart in its bytes, a stored block the pane touched is not as it was when read from
 * readFrom (another device changed it), or one is not there.
 */
export function patchBlocks(html: string, now: readonly NowBlock[], readFrom: string = html): string | null {
  const stored = readBlocks(html);
  if (stored.length !== paragraphHtml(html).length) return null;
  // anything between the blocks would have no place in the new order
  for (let i = 1; i < stored.length; i++) if (html.slice(stored[i - 1]!.end, stored[i]!.start) !== '') return null;
  const byKey = new Map(stored.map((b) => [b.key, b]));
  const then = new Map(readBlocks(readFrom).map((b) => [b.key, b]));
  const out: string[] = [];
  for (const block of now) {
    if (block.key === null) {
      out.push(`${withIds(block.open, block.id, block.alias)}${block.inner || '<br>'}</p>`);
      continue;
    }
    const at = byKey.get(block.key);
    if (!at) return null;
    if (!block.touched) { out.push(html.slice(at.start, at.end)); continue; }
    const read = then.get(block.key);
    // a place only means the same block while the page is the one the pane read
    if (!read || read.inner !== at.inner || read.open !== at.open || (block.key.startsWith('@') && html !== readFrom)) return null;
    out.push(`${withIds(at.open, block.id, block.alias)}${block.inner || '<br>'}</p>`);
  }
  const first = stored[0]?.start ?? html.length;
  const last = stored.at(-1)?.end ?? html.length;
  return html.slice(0, first) + out.join('') + html.slice(last);
}

// ---- ids an edit removed (Join-Keeps-Both-Ids) -----------------------------------------

/** A line as it was before an edit: its ids, whether it held no words, and whether it is still there. */
export interface Was { id: string; alias: readonly string[]; empty: boolean; live: boolean }

/**
 * Where the ids of the lines an edit removed go, by the index of the line before the edit
 * that takes them: the nearest line above still there, or below when none is, as aliases.
 * Words joined into a line that was empty bring their own id, and the empty line's id
 * becomes an alias. Only ids in onDisk are kept as aliases: one never saved was never cited.
 */
export function joinedIds(before: readonly Was[], onDisk: ReadonlySet<string>): Map<number, { id: string; alias: string[] }> {
  const out = new Map<number, { id: string; alias: string[] }>();
  const add = (into: { id: string; alias: string[] }, id: string) => {
    if (id && id !== into.id && onDisk.has(id) && !into.alias.includes(id)) into.alias.push(id);
  };
  before.forEach((line, i) => {
    if (line.live) return;
    let to = -1;
    for (let j = i - 1; j >= 0 && to === -1; j--) if (before[j]!.live) to = j;
    for (let j = i + 1; j < before.length && to === -1; j++) if (before[j]!.live) to = j;
    if (to === -1) return;
    const into = out.get(to) ?? { id: before[to]!.id, alias: [...before[to]!.alias] };
    out.set(to, into);
    if (before[to]!.empty && !line.empty && into.id === before[to]!.id && line.id) {
      const own = into.id;
      into.id = line.id;
      into.alias = into.alias.filter((a) => a !== line.id);
      for (const a of line.alias) add(into, a);
      add(into, own);
      return;
    }
    add(into, line.id);
    for (const a of line.alias) add(into, a);
  });
  return out;
}
