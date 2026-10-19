// What applying one ripple proposal does, worked out before anything is written, so the
// rules can be tested without a disk: a plan the engine (engine.ts) carries out.
//
// - A claim on the librarian's words is written over them, inside a librarian commit
//   pair. A claim on words the author wrote (by blame, or anywhere on a page that is the
//   author's) becomes the librarian's suggestion for the author to take or leave: the
//   author's words are never written over (hoard's spans rule, read from blame).
// - A topic adds its line to a page of the librarian's, or comments it onto one of the
//   author's.
// - A mint makes a new wiki page, unless a page or alias holds the title.
// - A quote that is not the source's words, a target that is not a page, and anchor
//   words that are gone or found twice defer the proposal with the reason.
// - Run again after a kill, a plan finds its own change already there and says done, so
//   replay duplicates nothing.
import { randomBytes } from 'node:crypto';
import type { Mark, MarkAnchor } from '../../generated/hoard-marks-v1.js';
import type { BlameLine } from '../git/blame.ts';
import { paragraphHtml, paragraphTexts, textOf } from '../html.ts';
import { anchorAt } from '../marks/anchor.ts';
import { inline } from '../wiki/inline.ts';
import { plainText, quoteIn } from './contract.ts';
import { findPage, type Wiki, type WikiPage } from './pages.ts';
import type { RippleProposal } from './rulings.ts';

export type Plan =
  | { type: 'write'; page: WikiPage; html: string; outcome: 'written'; delta?: string }
  | { type: 'mark'; page: WikiPage; mark: MarkRequest; outcome: 'suggested' | 'commented'; delta?: string }
  | { type: 'mint'; title: string; paragraphs: string[]; origin: string; outcome: 'minted' }
  | { type: 'done'; outcome: 'written' | 'suggested' | 'commented' | 'minted'; delta: string; page?: WikiPage }
  | { type: 'defer'; delta: string };

export interface MarkRequest {
  kind: 'substitution' | 'deletion' | 'comment';
  anchor: Omit<MarkAnchor, 'commit'>;
  proposed?: string;
  body: string;
}

export interface PlanInput {
  proposal: RippleProposal;
  wiki: Wiki;
  /** The source's text where its quotes are checked: as it stood at the job's commit. */
  source: string;
  /** A page's chapter file as it is now. */
  html(page: WikiPage): string | null;
  /** Who wrote each paragraph of a page; [] with no history. */
  blame(page: WikiPage): Promise<BlameLine[]>;
  /** A page's marks now. */
  marks(page: WikiPage): Promise<Mark[]>;
  /** Where a page came from, as its sidecar says, for a page ripple minted. */
  origin(page: WikiPage): string | null;
  newBlockId?: () => string;
}

/** NEO's serialiser escapes these, so a chapter file holds a paragraph's words like this. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
}

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0);

const P = /<p(?:\s[^>]*)?>[\s\S]*?<\/p>/gi;

/** The chapter with paragraph pIdx's inner HTML replaced. */
export function replaceInner(html: string, pIdx: number, inner: string): string {
  let n = 0;
  return html.replace(P, (whole) => {
    if (n++ !== pIdx) return whole;
    const open = whole.slice(0, whole.indexOf('>') + 1);
    return `${open}${inner}</p>`;
  });
}

const quoted = (q: string) => `“${q}”`;

function from(p: RippleProposal): string {
  return `From [[${p.source.title}]]`;
}

const waitingMine = (m: Mark) => m.created.who === 'librarian' && (m.state === 'open' || m.state === 'flagged');

async function claim(p: RippleProposal, input: PlanInput): Promise<Plan> {
  const anchor = p.anchor ?? '';
  const text = p.text ?? '';
  const page = findPage(input.wiki, p.target ?? '');
  if (!page) return { type: 'defer', delta: `No wiki page is called ${p.target}.` };
  const html = input.html(page);
  if (html === null) return { type: 'defer', delta: `The page ${page.title} is not there.` };
  const paras = paragraphTexts(html);
  const hits = paras.flatMap((t, i) => Array.from({ length: count(t, anchor) }, () => i));
  const marks = await input.marks(page);
  const suggested = marks.some((m) => waitingMine(m) && m.anchor.exact === anchor && (m.proposed ?? '') === text);
  if (suggested) return { type: 'done', outcome: 'suggested', delta: 'The suggestion is already on the page.', page };
  if (!hits.length) {
    if (text && paras.some((t) => t.includes(text))) return { type: 'done', outcome: 'written', delta: 'The new words are already on the page.', page };
    return { type: 'defer', delta: 'The words the claim rewrites are no longer on the page.' };
  }
  if (hits.length > 1) return { type: 'defer', delta: 'The words the claim rewrites are on the page more than once, so it is not clear which to change.' };
  if (!quoteIn(p.quote ?? '', input.source)) return { type: 'defer', delta: 'The quote is not in the source as it stood.' };
  const pIdx = hits[0]!;
  const off = paras[pIdx]!.indexOf(anchor);
  const blame = await input.blame(page);
  const line = blame[pIdx];
  const authors = page.owner === 'author' || (blame.length > 0 && line?.who !== 'librarian');
  const suggestion = (delta?: string): Plan => ({
    type: 'mark', page, outcome: 'suggested', delta,
    mark: {
      kind: text === '' ? 'deletion' : 'substitution',
      anchor: withoutCommit(anchorAt(paras, { pIdx, off, len: anchor.length })),
      ...(text === '' ? {} : { proposed: text }),
      body: `${from(p)}: ${p.reason}\n\n${quoted(p.quote ?? '')}`,
    },
  });
  if (authors) return suggestion();
  const inner = paragraphHtml(html)[pIdx] ?? '';
  const escaped = escapeText(anchor);
  let next: string | null = null;
  if (count(inner, escaped) === 1) next = inner.replace(escaped, () => inline(text).html);
  else if (textOf(inner) === anchor && !/<(?!br\b)[^>]+>/i.test(inner)) next = inline(text).html;
  if (next === null) return suggestion('The words carry formatting the librarian cannot rewrite cleanly, so the change waits as a suggestion.');
  return { type: 'write', page, html: replaceInner(html, pIdx, next || '<br>'), outcome: 'written' };
}

function withoutCommit(anchor: MarkAnchor): Omit<MarkAnchor, 'commit'> {
  const { commit: _commit, ...rest } = anchor;
  return rest;
}

async function topic(p: RippleProposal, input: PlanInput): Promise<Plan> {
  const line = p.line ?? '';
  const page = findPage(input.wiki, p.target ?? '');
  if (!page) return { type: 'defer', delta: `No wiki page is called ${p.target}.` };
  const html = input.html(page);
  if (html === null) return { type: 'defer', delta: `The page ${page.title} is not there.` };
  const paras = paragraphTexts(html);
  if (paras.some((t) => plainText(t) === plainText(line))) return { type: 'done', outcome: 'written', delta: 'The line is already on the page.', page };
  const body = `Ripple suggests adding this line, ${from(p).toLowerCase()}: ${quoted(line)}\n\n${p.reason}`;
  const marks = await input.marks(page);
  if (marks.some((m) => waitingMine(m) && m.thread[0]?.body === body)) return { type: 'done', outcome: 'commented', delta: 'The comment is already on the page.', page };
  if (!quoteIn(p.quote ?? '', input.source)) return { type: 'defer', delta: 'The quote is not in the source as it stood.' };
  if (page.owner === 'author') {
    const last = paras.reduce((at, t, i) => (t.trim() ? i : at), 0);
    if (!paras[last]) return { type: 'defer', delta: `The page ${page.title} is empty, so there is nowhere to comment.` };
    return { type: 'mark', page, outcome: 'commented', mark: { kind: 'comment', anchor: withoutCommit(anchorAt(paras, { pIdx: last, off: 0, len: 0 })), body } };
  }
  const id = input.newBlockId?.() ?? randomBytes(3).toString('hex');
  const added = `<p data-block="${id}">${inline(line).html || '<br>'}</p>`;
  const kept = /^<p[^>]*><br><\/p>$/i.test(html.trim()) ? '' : html;
  return { type: 'write', page, html: kept + added, outcome: 'written' };
}

function mint(p: RippleProposal, input: PlanInput): Plan {
  const title = (p.target ?? '').trim();
  const origin = `ripple:${p.id}`;
  const there = findPage(input.wiki, title);
  if (there) {
    if (input.origin(there) === origin) return { type: 'done', outcome: 'minted', delta: 'The page is already in the wiki.', page: there };
    return { type: 'defer', delta: `A page or alias already holds the title ${title}.` };
  }
  if (!quoteIn(p.quote ?? '', input.source)) return { type: 'defer', delta: 'The quote is not in the source as it stood.' };
  const paragraphs = (p.text ?? '').split(/\n\s*\n/).map((t) => t.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  return { type: 'mint', title, paragraphs, origin, outcome: 'minted' };
}

/** What applying a proposal would do. Reads; never writes. */
export async function plan(input: PlanInput): Promise<Plan> {
  const p = input.proposal;
  if (p.kind === 'claim') return claim(p, input);
  if (p.kind === 'topic') return topic(p, input);
  if (p.kind === 'mint') return mint(p, input);
  throw new RangeError(`a ${p.kind} has nothing to apply`);
}
