// Ripple on the main side: the jobs, the packets, the judge's answers and the author's
// rulings, all in one log (rulings.ts). The judge is not in NEO: Run Ripple writes a
// packet for each waiting job to .neo/ripple/packets/, a judge (a person with an agent, or
// a script) writes its answer to .neo/ripple/inbox/<job>.jsonl, and the next run reads it.
// Packets and answers are scratch and stay out of the history (.neo/ripple/.gitignore);
// the brief, the rulings and every change ripple makes are kept.
//
// Nothing a judge proposes changes the library until the author applies it, one proposal
// at a time, and nothing is written into the wiki while the wiki is the open book, since
// the window writes the open book's files itself. A change the librarian writes runs as a
// librarian edit (GitLayer.around), so blame credits it, and opens the next hop's job for
// the page it changed; a suggestion or comment waits on the author instead. Calls run one
// at a time, so two runs never write one packet twice.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { HoardChangeV1 } from '../../generated/hoard-change-v1.js';
import { validateHoardChangeV1, validateHoardPageV1 } from '../../generated/validators.cjs';
import type { BlameLine } from '../git/blame.ts';
import type { Paired } from '../git/layer.ts';
import type { AddRequest } from '../marks/store.ts';
import type { Mark, MarkWho } from '../../generated/hoard-marks-v1.js';
import { oneName, writeWhole } from '../files.ts';
import type { WikiPages } from '../wiki/store.ts';
import { plan, type Plan } from './apply.ts';
import { AnswerError, readAnswer, type Proposed } from './contract.ts';
import { buildPacket } from './packet.ts';
import { chapterRel, corpusPath, pageText, readWiki, wikiCorpus, type Wiki, type WikiPage } from './pages.ts';
import { newJob, reconcile, superseded } from './reconcile.ts';
import { LAST_HOP, proposalId, Rulings, sha256, type RippleJob, type RippleProposal, type RippleState } from './rulings.ts';
import type { Corpus, Embed } from './shortlist.ts';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

export interface RippleOptions {
  library: () => string;
  wiki: {
    pages(): WikiPages | null;
    wikiId(): string | null;
    mint(page: { title: string; paragraphs: readonly string[]; frontmatter: Record<string, unknown>; origin: string }, openBookId: string | null): { bookId: string; chId: string; files: string[] };
  };
  marks: {
    add(req: AddRequest, who: MarkWho): Promise<{ id: string; marks: Mark[] }>;
    chapter(bookId: string, chId: string): Promise<Mark[]>;
  };
  layer: {
    head(): Promise<string | null>;
    show(commit: string, rel: string): Promise<string | null>;
    changed(from: string, to: string, under: string): Promise<{ rel: string; byAuthor: boolean }[]>;
    blame(ids: { bookId: string; chId: string }): Promise<BlameLine[]>;
    around<T>(paths: readonly string[], apply: () => Promise<T>): Promise<Paired<T>>;
  };
  /** Told after a write outside a librarian edit, so the history takes it. */
  wrote?: (name: string) => void;
  /** The meaning model, once it is set up; without it packets leave its ten out. */
  embed?: () => Embed | undefined;
  now?: () => Date;
  log: Log;
}

export interface RunSummary {
  /** false before the first import: there is no wiki to ripple through. */
  wiki: boolean;
  /** The first run: the cursor is set and no job is made. */
  baseline: boolean;
  made: number;
  packeted: number;
  /** Answers taken in, and the proposals they held. */
  read: number;
  proposals: number;
  /** An answer that could not be taken, with why, by the source's title. */
  problems: string[];
  packets: string;
}

export interface Overview {
  wiki: boolean;
  packets: string;
  inbox: string;
  brief: string;
  jobs: { id: string; title: string; hop: number; origin: RippleJob['origin']; state: RippleJob['state']; problem: string | null; packet: string; answer: string }[];
  proposals: (Pick<RippleProposal, 'id' | 'kind' | 'status' | 'hop' | 'reason'> & {
    from: string; target: string; anchor: string | null; text: string | null; line: string | null; quote: string | null; delta: string | null;
  })[];
  applied: number;
  rejected: number;
}

export interface Decided {
  proposal: RippleProposal;
  /** What applying did, in a sentence for the author. */
  said: string;
  /** The page it changed or marked, so the window can show it. */
  page: { bookId: string; chId: string } | null;
}

export const DEFAULT_BRIEF = `# Ripple brief

You are the librarian's judge for a writer's world-building wiki. A packet names one page that changed (the source) and a shortlist of other pages. Your work is to say what the change means for those pages, so the wiki keeps agreeing with itself.

## What to propose

- A claim, where a candidate page now says something the source contradicts or has made out of date. Rewrite only the words that are wrong, inside one paragraph, and keep the page's voice.
- A topic, where a candidate page should mention the source but does not. One line, usually naming the source as a [[link]].
- A mint, only where the source names something important that has no page of its own and no candidate covers. Keep a new page short: what the source says of it, no more.
- A nothing, for a candidate you read closely and chose to leave alone, so the choice is on record.

## What to leave alone

- Never invent facts. Every proposal rests on the source's own words, quoted.
- Do not restyle, tidy or expand a page beyond what the change needs.
- Do not propose changes to the source itself.
- When you are unsure, say nothing about the page: the writer would rather miss a ripple than undo a wrong one.

## How the writer sees your work

Each proposal waits for the writer, who applies it, rejects it or sets it aside. Words the writer wrote are never written over: a claim on them becomes a suggestion they can take or leave. Write your reasons for the writer: one or two plain sentences.
`;

const GITIGNORE = 'packets/\ninbox/\n';

export class Ripple {
  readonly #o: RippleOptions;
  readonly #rulings: Rulings;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: RippleOptions) {
    this.#o = options;
    this.#rulings = new Rulings(options.library);
  }

  get #lib(): string {
    return this.#o.library();
  }

  #dir(...parts: string[]): string {
    return path.join(this.#lib, '.neo', 'ripple', ...parts);
  }

  #packetFile(job: string): string {
    return rippleFiles(this.#lib, job).packet;
  }

  #inboxFile(job: string): string {
    return rippleFiles(this.#lib, job).answer;
  }

  get #rulingsRel(): string {
    return '.neo/ripple/rulings.jsonl';
  }

  #now(): string {
    return (this.#o.now?.() ?? new Date()).toISOString();
  }

  #read(rel: string): string | null {
    const file = path.join(this.#lib, rel);
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  #queued<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => {});
    return next;
  }

  // The folders, the brief and the .gitignore, made the first time they are needed.
  #setUp(): void {
    mkdirSync(this.#dir('packets'), { recursive: true });
    mkdirSync(this.#dir('inbox'), { recursive: true });
    let wrote = false;
    if (!existsSync(this.#dir('.gitignore'))) { writeWhole(this.#dir('.gitignore'), GITIGNORE); wrote = true; }
    if (!existsSync(this.#dir('brief.md'))) { writeWhole(this.#dir('brief.md'), DEFAULT_BRIEF); wrote = true; }
    if (wrote) this.#o.wrote?.('.neo');
  }

  #brief(): { text: string; sha256: string } {
    const bytes = readFileSync(this.#dir('brief.md'));
    return { text: bytes.toString('utf8'), sha256: sha256(bytes.toString('utf8')) };
  }

  #changes(): (HoardChangeV1 | null)[] {
    const text = this.#read('.neo/changes.jsonl') ?? '';
    return text.split('\n').filter((l) => l.trim()).map((line) => {
      try {
        const value = JSON.parse(line) as unknown;
        return validateHoardChangeV1(value) ? value : null;
      } catch {
        return null;
      }
    });
  }

  #wiki(): Wiki | null {
    const pages = this.#o.wiki.pages();
    return pages ? readWiki(this.#lib, pages, this.#o.log) : null;
  }

  async #append(records: Parameters<Rulings['append']>[0]): Promise<RippleState> {
    const state = await this.#rulings.append(records);
    if (records.length) this.#o.wrote?.('.neo');
    return state;
  }

  /** Finds new jobs, writes their packets and reads the judge's answers. */
  run(): Promise<RunSummary> {
    return this.#queued(() => this.#run());
  }

  async #run(): Promise<RunSummary> {
    const summary: RunSummary = { wiki: false, baseline: false, made: 0, packeted: 0, read: 0, proposals: 0, problems: [], packets: this.#dir('packets') };
    const wiki = this.#wiki();
    if (!wiki) return summary;
    summary.wiki = true;
    this.#setUp();
    let state = this.#rulings.read();
    const rec = await reconcile({
      state, wiki, head: await this.#o.layer.head(), changes: this.#changes(),
      changed: (from, to, under) => this.#o.layer.changed(from, to, under),
      show: (commit, rel) => this.#o.layer.show(commit, rel),
      read: (rel) => this.#read(rel),
      at: this.#now(),
      log: this.#o.log,
    });
    if (rec.records.length) state = await this.#append(rec.records);
    summary.baseline = rec.baseline;
    summary.made = rec.made.length;
    ({ state, n: summary.packeted } = await this.#packets(state, wiki));
    const answers = await this.#answers(state);
    summary.read = answers.read;
    summary.proposals = answers.proposals;
    summary.problems = answers.problems;
    this.#o.log('info', 'ripple.run', { ...summary, packets: undefined });
    return summary;
  }

  // A packet for each open job; a job whose page is gone is set aside.
  async #packets(state: RippleState, wiki: Wiki): Promise<{ state: RippleState; n: number }> {
    const open = [...state.jobs.values()].filter((j) => j.state === 'open');
    if (!open.length) return { state, n: 0 };
    const { corpus, byPath } = wikiCorpus(this.#lib, wiki);
    const embed = this.#o.embed?.();
    const records: RippleJob[] = [];
    let n = 0;
    for (const job of open) {
      const { problem: _problem, ...rest } = job;
      const html = this.#read(chapterRel(job.source.bookId, job.source.chId));
      if (html === null) {
        records.push({ ...rest, at: this.#now(), state: 'skipped', problem: 'The page is no longer in the library.' });
        continue;
      }
      const packet = await packetOf({ library: this.#lib, job, html, wiki, corpus, byPath, embed });
      writeWhole(this.#packetFile(job.id), packet.text);
      records.push({ ...rest, at: this.#now(), state: 'packeted' });
      n++;
    }
    return { state: await this.#append(records), n };
  }

  // Each answer waiting in the inbox for a packeted job.
  async #answers(state: RippleState): Promise<{ read: number; proposals: number; problems: string[] }> {
    const out = { read: 0, proposals: 0, problems: [] as string[] };
    const records: (RippleJob | RippleProposal)[] = [];
    let brief: { text: string; sha256: string } | null = null;
    for (const job of state.jobs.values()) {
      if (job.state !== 'packeted' || !existsSync(this.#inboxFile(job.id))) continue;
      const { problem: _problem, ...rest } = job;
      const packetFile = this.#packetFile(job.id);
      if (!existsSync(packetFile)) {
        // a packet lost from the scratch folder is written again on the next run
        records.push({ ...rest, at: this.#now(), state: 'open' });
        continue;
      }
      brief ??= this.#brief();
      let proposed: Proposed[];
      try {
        proposed = readAnswer(readFileSync(this.#inboxFile(job.id), 'utf8'), brief, readFileSync(packetFile, 'utf8')).proposals;
      } catch (err) {
        if (!(err instanceof AnswerError)) throw err;
        out.problems.push(`${job.source.title}: ${err.message}`);
        if (job.problem !== err.message) records.push({ ...rest, at: this.#now(), problem: err.message });
        continue;
      }
      const at = this.#now();
      const made = proposed.map((p) => proposalOf(job, p, at)).filter((p) => !state.proposals.has(p.id));
      const fresh = made.filter((p, i) => made.findIndex((q) => q.id === p.id) === i);
      records.push(...fresh, { ...rest, at, state: 'judged' });
      out.read++;
      out.proposals += fresh.filter((p) => p.status === 'proposed').length;
    }
    if (records.length) await this.#append(records);
    return out;
  }

  /** A job for a chapter of the open book, Ripple This Chapter; then its packet. */
  ask(source: { bookId: string; chId: string; title: string }): Promise<{ job: string; made: boolean; packet: string | null; wiki: boolean }> {
    return this.#queued(async () => {
      const wiki = this.#wiki();
      if (!wiki) return { job: '', made: false, packet: null, wiki: false };
      this.#setUp();
      const html = this.#read(chapterRel(source.bookId, source.chId));
      if (html === null) throw new Error('The chapter is not saved yet. Try again in a moment.');
      let state = this.#rulings.read();
      const at = this.#now();
      const job = newJob(state, [], { source, html, commit: await this.#o.layer.head(), origin: 'asked', hop: 0, at });
      if (!job) {
        const known = [...state.jobs.values()].reverse().find((j) => j.source.bookId === source.bookId && j.source.chId === source.chId && j.hop === 0);
        const id = known?.id ?? '';
        return { job: id, made: false, packet: id && existsSync(this.#packetFile(id)) ? this.#packetFile(id) : null, wiki: true };
      }
      state = await this.#append([...superseded(state, [job], at), job]);
      await this.#packets(state, wiki);
      return { job: job.id, made: true, packet: this.#packetFile(job.id), wiki: true };
    });
  }

  /** The author's ruling on a proposal. Applying refuses while the wiki is the open book. */
  decide(openBookId: string | null, id: string, decision: 'apply' | 'reject' | 'defer'): Promise<Decided> {
    return this.#queued(() => this.#decide(openBookId, id, decision));
  }

  async #decide(openBookId: string | null, id: string, decision: 'apply' | 'reject' | 'defer'): Promise<Decided> {
    const state = this.#rulings.read();
    const p = state.proposals.get(id);
    if (!p) throw new Error('Ripple has no such proposal.');
    if (p.status === 'applied' || p.status === 'rejected') return { proposal: p, said: `It was ${p.status} already.`, page: null };
    const at = this.#now();
    const ruled = async (fields: Partial<RippleProposal>, said: string, page: Decided['page'] = null): Promise<Decided> => {
      const proposal: RippleProposal = { ...p, at, ...fields };
      await this.#append([proposal]);
      return { proposal, said, page };
    };
    if (decision === 'reject') return ruled({ status: 'rejected' }, 'Rejected.');
    if (decision === 'defer') return ruled({ status: 'deferred', delta: 'The author set it aside for now.' }, 'Set aside for later.');
    if (p.kind === 'nothing') return ruled({ status: 'rejected' }, 'There was nothing to apply.');

    const wikiId = this.#o.wiki.wikiId();
    if (!wikiId) throw new Error('There is no wiki yet: import pages first.');
    if (wikiId === openBookId) throw new Error('The wiki is open, so ripple writes nothing into it. Go back to the shelf or to another book, then apply.');
    const wiki = this.#wiki()!;
    const job = state.jobs.get(p.job);
    const rel = chapterRel(p.source.bookId, p.source.chId);
    const then = job?.commit ? await this.#o.layer.show(job.commit, rel) : null;
    const source = [then, this.#read(rel)].filter((t): t is string => t !== null).map(pageText).join('\n\n');
    const made = await plan({
      proposal: p, wiki, source,
      html: (page) => this.#read(page.rel),
      blame: (page) => this.#o.layer.blame({ bookId: wiki.bookId, chId: page.chId }),
      marks: (page) => this.#o.marks.chapter(wiki.bookId, page.chId),
      origin: (page) => this.#origin(wiki, page),
    });
    return this.#carryOut(made, p, wiki, openBookId, ruled);
  }

  async #carryOut(
    made: Plan, p: RippleProposal, wiki: Wiki, openBookId: string | null,
    ruled: (fields: Partial<RippleProposal>, said: string, page?: Decided['page']) => Promise<Decided>,
  ): Promise<Decided> {
    const at = this.#now();
    const at$ = (page: WikiPage) => ({ bookId: wiki.bookId, chId: page.chId });
    if (made.type === 'defer') return ruled({ status: 'deferred', delta: made.delta }, made.delta);
    if (made.type === 'done') return ruled({ status: 'applied', outcome: made.outcome, delta: made.delta }, made.delta, made.page ? at$(made.page) : null);
    if (made.type === 'mark') {
      await this.#o.marks.add({ bookId: wiki.bookId, chId: made.page.chId, ...made.mark }, 'librarian');
      const said = made.outcome === 'suggested'
        ? `The change waits on ${made.page.title} as a suggestion for you to accept or reject.`
        : `A comment on ${made.page.title} holds the line for you to add or not.`;
      return ruled({ status: 'applied', outcome: made.outcome, ...(made.delta ? { delta: made.delta } : {}) }, made.delta ? `${said} ${made.delta}` : said, at$(made.page));
    }
    // A change the librarian makes: the edit, the ruling and the next hop's job land in
    // one librarian commit.
    const next = (state: RippleState, page: { bookId: string; chId: string; title: string }, html: string, commit: string | null) =>
      (p.hop + 1 > LAST_HOP ? null : newJob(state, [], { source: page, html, commit, origin: 'ripple', hop: p.hop + 1, parent: p.id, at }));
    if (made.type === 'write') {
      const page = made.page;
      const proposal: RippleProposal = { ...p, at, status: 'applied', outcome: 'written', ...(made.delta ? { delta: made.delta } : {}) };
      await this.#o.layer.around([page.rel, this.#rulingsRel], async () => {
        writeWhole(path.join(this.#lib, page.rel), made.html);
        const state = this.#rulings.read();
        const job = next(state, { bookId: wiki.bookId, chId: page.chId, title: page.title }, made.html, await this.#o.layer.head());
        await this.#rulings.append([proposal, ...(job ? [job] : [])]);
      });
      return { proposal, said: `${page.title} is changed. Undo it from the page's history, or by hand.`, page: at$(page) };
    }
    const proposal: RippleProposal = { ...p, at, status: 'applied', outcome: 'minted' };
    const minted = await this.#o.layer.around([wiki.bookId, `.neo/${wiki.bookId}/pages`, this.#rulingsRel], async () => {
      const result = this.#o.wiki.mint({
        title: made.title, paragraphs: made.paragraphs, origin: made.origin,
        frontmatter: { type: 'lore', tags: ['needs-gathering'], ripple: { from: p.source.title, proposal: p.id } },
      }, openBookId);
      const html = this.#read(chapterRel(result.bookId, result.chId)) ?? '';
      const job = next(this.#rulings.read(), { bookId: result.bookId, chId: result.chId, title: made.title }, html, await this.#o.layer.head());
      await this.#rulings.append([proposal, ...(job ? [job] : [])]);
      return result;
    });
    return { proposal, said: `${made.title} is a new page in the wiki.`, page: { bookId: minted.result.bookId, chId: minted.result.chId } };
  }

  // Where a page came from, as its sidecar says: a page ripple minted names its proposal.
  #origin(wiki: Wiki, page: WikiPage): string | null {
    const text = this.#read(`.neo/${wiki.bookId}/pages/${page.chId}.json`);
    if (text === null) return null;
    try {
      const data = JSON.parse(text) as unknown;
      return validateHoardPageV1(data) ? data.source.path : null;
    } catch {
      return null;
    }
  }

  /** What waits: jobs for the judge, proposals for the author. Reads; never writes. */
  overview(): Overview {
    const state = this.#rulings.read();
    const proposals = [...state.proposals.values()];
    return {
      wiki: this.#o.wiki.wikiId() !== null,
      packets: this.#dir('packets'),
      inbox: this.#dir('inbox'),
      brief: this.#dir('brief.md'),
      jobs: [...state.jobs.values()].filter((j) => j.state === 'open' || j.state === 'packeted').map((j) => ({
        id: j.id, title: j.source.title, hop: j.hop, origin: j.origin, state: j.state, problem: j.problem ?? null,
        packet: this.#packetFile(j.id), answer: this.#inboxFile(j.id),
      })),
      proposals: proposals.filter((p) => p.status === 'proposed' || p.status === 'deferred').map((p) => ({
        id: p.id, kind: p.kind, status: p.status, hop: p.hop, reason: p.reason,
        from: p.source.title, target: p.target ?? '', anchor: p.anchor ?? null, text: p.text ?? null, line: p.line ?? null,
        quote: p.quote ?? null, delta: p.delta ?? null,
      })),
      applied: proposals.filter((p) => p.status === 'applied' && p.kind !== 'nothing').length,
      rejected: proposals.filter((p) => p.status === 'rejected' && p.kind !== 'nothing').length,
    };
  }
}

/** The paths ripple keeps its scratch at, in a library. */
export const rippleFiles = (library: string, job: string) => ({
  brief: path.join(library, '.neo', 'ripple', 'brief.md'),
  packet: path.join(library, '.neo', 'ripple', 'packets', `${oneName(job, 'job')}.md`),
  answer: path.join(library, '.neo', 'ripple', 'inbox', `${oneName(job, 'job')}.jsonl`),
});

/** A job's packet, for its source's HTML as it is now. */
export function packetOf(o: { library: string; job: RippleJob; html: string; wiki: Wiki; corpus: Corpus; byPath: Map<string, WikiPage>; embed?: Embed }) {
  const name = o.job.source.title || o.job.source.chId;
  const files = rippleFiles(o.library, o.job.id);
  return buildPacket({
    job: o.job, sourceText: pageText(o.html),
    sourcePath: o.job.source.bookId === o.wiki.bookId ? corpusPath(name) : `manuscript/${corpusPath(name)}`,
    corpus: o.corpus, byPath: o.byPath,
    briefFile: files.brief, inboxFile: files.answer, library: o.library, embed: o.embed,
  });
}

/** A line of the judge's answer as a proposal of the job. */
export function proposalOf(job: RippleJob, p: Proposed, at: string): RippleProposal {
  const target = p.kind === 'mint' ? p.title : p.target;
  const quote = 'quote' in p ? p.quote : '';
  const where = p.kind === 'claim' ? p.anchor : p.kind === 'topic' ? p.line : '';
  return {
    version: 1, type: 'proposal', id: proposalId(job.id, p.kind, target, `${quote}\0${where}`), at, job: job.id, kind: p.kind,
    // a nothing is the judge declining a page: a decision, kept, with nothing to apply
    status: p.kind === 'nothing' ? 'rejected' : 'proposed',
    hop: job.hop, source: job.source, target, reason: p.reason,
    ...(quote ? { quote } : {}),
    ...(p.kind === 'claim' ? { anchor: p.anchor, text: p.text } : {}),
    ...(p.kind === 'mint' ? { text: p.text } : {}),
    ...(p.kind === 'topic' ? { line: p.line } : {}),
  };
}
