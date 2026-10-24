// A ripple packet: what the judge reads for one job. It names the brief and never holds
// it, so the preflight's echo proves the brief was read; it holds the source, the output
// contract, and a shortlist of candidate pages in place of hoard's whole roster.
//
// The shortlist (ruling Shortlist-Fused-From-Merged-Chunks, 24 Oct, scored on 173 ticks):
// the roster's first 30 (pages the source names, then pages near it in the link graph),
// then the 15 pages those lack that rank fusion of BM25 and the on-device model ranks
// highest, both reading merged chunks. Without the model it is the 16 Oct list: the
// roster's 30 then the first 10 pages BM25 finds on paragraph chunks, and the packet
// says the model is missing. Pure, but for the embedder it is handed.
import type { RippleJob } from './rulings.ts';
import { card, embeddingRank, fuse, lexicalRank, rosterRank, withExtras, type Corpus, type Embed, type Ranked, type Source } from './shortlist.ts';
import type { WikiPage } from './pages.ts';

export const ROSTER_CARDS = 30;
export const LEXICAL_EXTRAS = 10;
export const FUSED_EXTRAS = 15;
/** Each leg is cut to this before fusing, as on the sheets the ruling was scored on. */
export const FUSE_DEPTH = 30;

export interface PacketInput {
  job: RippleJob;
  /** The source's text, paragraphs a blank line apart. */
  sourceText: string;
  /** The source as a corpus path, so it is never its own candidate. */
  sourcePath: string;
  corpus: Corpus;
  byPath: Map<string, WikiPage>;
  /** Absolute paths, as the judge opens them. */
  briefFile: string;
  inboxFile: string;
  library: string;
  embed?: Embed;
}

export interface Packet {
  text: string;
  /** The candidates' titles, in the packet's order. */
  candidates: string[];
  /** Whether the model's extras are in. */
  modelled: boolean;
}

const CONTRACT = `## How to answer

Read the brief first, then the source, then any candidate you need in full (each card names its file). Write your answer as JSON, one object per line, to the answer file. Nothing else goes in it.

The first line is the preflight:

    {"kind": "preflight", "brief_sha256": "<the SHA-256 of the brief file's bytes, in hex>", "echo": "<at least 40 characters copied from the brief>"}

Then one line for each page you rule on:

    {"kind": "nothing", "target": "<page title>", "reason": "<why the page needs no change>"}
    {"kind": "claim", "target": "<page title>", "anchor": "<words on that page now, inside one paragraph>", "text": "<what those words become>", "reason": "<why>", "quote": "<the source's words this rests on>"}
    {"kind": "topic", "target": "<page title>", "line": "<a line to add to the page, usually naming the source as a [[link]]>", "reason": "<why>", "quote": "<the source's words>"}
    {"kind": "mint", "title": "<a new page's title>", "text": "<its first passage; a blank line parts paragraphs>", "reason": "<why>", "quote": "<the source's words>"}

- A target is a page title as a card gives it, or a page you found in the wiki.
- A quote is the source's own words, 12 characters or more. [Brackets] may hold your own words and ... may mark a gap.
- An anchor and its text stay inside one paragraph, with no line break.
- Say nothing of a page you leave alone. A "nothing" line is for a page you looked at and decided against, so the decision is kept.
- Nothing you write changes the library by itself: the author reads each proposal and applies it or not.`;

function why(r: Ranked): string {
  return r.why === 'named' ? 'named' : r.why.startsWith('hop') ? r.why : r.why === 'lexical' ? 'shares words' : r.why === 'embedding' ? 'close in meaning' : r.why;
}

/** The shortlist, as the ruling has it. */
export async function shortlistFor(corpus: Corpus, source: Source, embed?: Embed): Promise<{ ranked: Ranked[]; modelled: boolean }> {
  const roster = rosterRank(corpus, source);
  if (!embed) return { ranked: withExtras(roster, ROSTER_CARDS, [{ ranked: lexicalRank(corpus, source), n: LEXICAL_EXTRAS }]), modelled: false };
  const cut = { merge: true };
  const legs = [lexicalRank(corpus, source, cut), await embeddingRank(corpus, source, embed, cut)].map((l) => l.slice(0, FUSE_DEPTH));
  return { ranked: withExtras(roster, ROSTER_CARDS, [{ ranked: fuse(legs), n: FUSED_EXTRAS }]), modelled: true };
}

export async function buildPacket(input: PacketInput): Promise<Packet> {
  const { job, corpus, byPath } = input;
  const source: Source = { relpath: input.sourcePath, text: input.sourceText };
  const { ranked, modelled } = await shortlistFor(corpus, source, input.embed);
  const cards: string[] = [];
  const candidates: string[] = [];
  for (const r of ranked) {
    const doc = corpus.byRel.get(r.relpath);
    const page = byPath.get(r.relpath);
    if (!doc || !page) continue;
    candidates.push(page.title);
    const lines = card({ ...doc, name: page.title }, { ...r, why: why(r) }).split('\n');
    lines.splice(1, 0, `  file: ${page.rel}${page.owner === 'author' ? ' (the author\'s page: a claim on it becomes a suggestion)' : ''}`);
    cards.push(lines.join('\n'));
  }
  const at = job.commit ? `, commit ${job.commit.slice(0, 12)}` : '';
  const text = [
    `# Ripple packet ${job.id}`,
    '',
    `One change came into the library: the page below. Decide what it means for the wiki's other pages: which need a change, which should name it, and whether a page is missing.`,
    '',
    `- Source: [[${job.source.title}]], hop ${job.hop}${at}`,
    `- Brief: ${input.briefFile}. Read it before anything else; it is not in this packet.`,
    `- Answer file: ${input.inboxFile}`,
    `- Library: ${input.library} (read-only for you)`,
    '',
    CONTRACT,
    '',
    `## Source: ${job.source.title}`,
    '',
    input.sourceText.trim() || '(The page is empty.)',
    '',
    `## Candidates (${cards.length})`,
    '',
    modelled
      ? 'The pages the source names or sits near in the links, then pages that share its words or are close in meaning.'
      : 'The pages the source names or sits near in the links, then pages that share its words. (The meaning model is not set up, so its pages are missing.)',
    '',
    ...cards,
    '',
  ].join('\n');
  return { text, candidates, modelled };
}
