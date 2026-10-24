// A ripple packet: what the judge reads for one job. It names the brief and never holds
// it, so the preflight's echo proves the brief was read; it holds the source, the output
// contract, and a shortlist of candidate pages in place of hoard's whole roster.
//
// The shortlist is the one snailuj's reading chose (16 Oct, plan "Full precision and
// mixes"): the roster's first 30 (pages the source names, then pages near it in the link
// graph), then the first 10 pages BM25 finds that those lack, then the first 10 an
// on-device model finds that all of those lack. Without the model the model's ten are
// left out and the packet says so. Pure, but for the embedder it is handed.
import { renderCards } from './cards.ts';
import type { RippleJob } from './rulings.ts';
import { embeddingRank, lexicalRank, rosterRank, withExtras, type Corpus, type Embed, type Ranked, type Source } from './shortlist.ts';
import type { WikiPage } from './pages.ts';

export const ROSTER_CARDS = 30;
export const LEXICAL_EXTRAS = 10;
export const MODEL_EXTRAS = 10;

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
  /** The eval's options; the app passes none. A list to card in place of the ruled one. */
  shortlist?: { ranked: Ranked[]; modelled: boolean };
  /** Full cards while they fit this many characters, the rest as locator lines. */
  budgetChars?: number;
  /** Pages carded in full; the rest are locator lines. */
  fullOnly?: ReadonlySet<string>;
  /** A rendered wiki map (map.ts), given after the candidates. */
  map?: string;
}

export interface Packet {
  text: string;
  /** The candidates' titles, in the packet's order. */
  candidates: string[];
  /** Whether the model's extras are in. */
  modelled: boolean;
  /** Corpus paths carded in full, and those given a locator line only. */
  full: string[];
  locator: string[];
  /** The full cards' characters, a newline each, as a budget counts them. */
  fullChars: number;
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

/** The shortlist, as the ruling has it. */
export async function shortlistFor(corpus: Corpus, source: Source, embed?: Embed): Promise<{ ranked: Ranked[]; modelled: boolean }> {
  const fills = [{ ranked: lexicalRank(corpus, source), n: LEXICAL_EXTRAS }];
  if (embed) fills.push({ ranked: await embeddingRank(corpus, source, embed), n: MODEL_EXTRAS });
  return { ranked: withExtras(rosterRank(corpus, source), ROSTER_CARDS, fills), modelled: Boolean(embed) };
}

export async function buildPacket(input: PacketInput): Promise<Packet> {
  const { job, corpus, byPath } = input;
  const source: Source = { relpath: input.sourcePath, text: input.sourceText };
  const { ranked, modelled } = input.shortlist ?? await shortlistFor(corpus, source, input.embed);
  const cards = renderCards(corpus, ranked, {
    budgetChars: input.budgetChars, fullOnly: input.fullOnly,
    pageOf: (rel) => {
      const page = byPath.get(rel);
      return page ? { title: page.title, file: page.rel, note: page.owner === 'author' ? '(the author\'s page: a claim on it becomes a suggestion)' : undefined } : null;
    },
  });
  const map = input.map === undefined ? [] : [
    '## Wiki map',
    '',
    'Every page in the wiki, by folder. You may target any page in it, as you may a candidate.',
    '',
    input.map.trimEnd(),
    '',
  ];
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
    `## Candidates (${cards.candidates.length})`,
    '',
    modelled
      ? 'The pages the source names or sits near in the links, then pages that share its words, then pages close in meaning.'
      : 'The pages the source names or sits near in the links, then pages that share its words. (The meaning model is not set up, so its ten are missing.)',
    '',
    ...(cards.text ? [cards.text] : []),
    '',
    ...map,
  ].join('\n');
  return { text, candidates: cards.candidates, modelled, full: cards.full, locator: cards.locator, fullChars: cards.fullChars };
}
