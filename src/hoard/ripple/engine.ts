// Ripple on the main side: the jobs, the packets, the judge's answers and the author's
// rulings, all in one log (rulings.ts). The judge is not in NEO: Run Ripple writes a
// packet for each waiting job to .neo/ripple/packets/, a judge (a person with an agent, or
// a script) writes its answer to .neo/ripple/inbox/<job>.jsonl, and the next run reads it.
// Packets and answers are scratch and stay out of the history (.neo/ripple/.gitignore);
// the brief, the rulings and every change ripple makes are kept.
//
// Ripple reads the page store (pages/store.ts) and so both trees, wiki/ and sources/.
// Nothing a judge proposes changes the library until the author applies it, one proposal
// at a time. A change to a librarian-owned wiki page, and a new wiki page, run as a
// librarian edit (GitLayer.around) over the page's own file, so blame credits it, and
// open the next hop's job for the page they changed. Every change to an author-owned
// page, in either tree, is a suggestion or comment mark that waits on the author: ripple
// never writes such a page's bytes. Calls run one at a time, so two runs never write one
// packet twice.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { validateHoardPageV1 } from '../../generated/validators.cjs';
import type { HoardPageV1 } from '../../generated/hoard-page-v1.js';
import { oneName, writeWhole } from '../files.ts';
import type { BlameLine } from '../git/blame.ts';
import type { Paired } from '../git/layer.ts';
import { PageRefused, titleOf } from '../pages/identity.ts';
import { asLibrarian } from '../review/edit.ts';
import type { PageStore } from '../pages/store.ts';
import { inline } from '../wiki/inline.ts';
import { plan, type Plan } from './apply.ts';
import { AnswerError, readAnswer, type Proposed } from './contract.ts';
import { corpusPath, findPage, pagesCorpus, pageText, readLibrary, readSidecar, sidecarRel, type PageLibrary, type RipplePage } from './library.ts';
import { buildPacket } from './packet.ts';
import type { OwnerOf, RippleMarks } from './ports.ts';
import { newJob, reconcile, superseded } from './reconcile.ts';
import { cardKey, heldCards, LAST_HOP, proposalId, repeatOf, Rulings, sha256, type RippleJob, type RippleProposal, type RippleState } from './rulings.ts';
import type { Corpus, Embed } from './shortlist.ts';

type Log = (level: 'error' | 'warn' | 'info' | 'debug', message: string, data?: unknown) => void;

export interface RippleOptions {
  library: () => string;
  pages: Pick<PageStore, 'list' | 'read' | 'write' | 'create'>;
  marks: RippleMarks;
  ownerOf: OwnerOf;
  layer: {
    head(): Promise<string | null>;
    show(commit: string, rel: string): Promise<string | null>;
    changed(from: string, to: string, under: string): Promise<{ rel: string; byAuthor: boolean }[]>;
    around<T>(paths: readonly string[], apply: () => Promise<T>): Promise<Paired<T>>;
    /** Lets the writer's commits take these paths again, once a refused edit of them is put back. */
    release(paths: readonly string[]): void;
    /** Those of these paths the gate still holds from an earlier refused edit. */
    held(paths: readonly string[]): string[];
  };
  /** Who wrote each paragraph of a page; without it a librarian-owned page counts as the librarian's throughout. */
  blame?: (page: string) => Promise<BlameLine[]>;
  /** Told after a write outside a librarian edit, so the history takes it. */
  wrote?: (name: string) => void;
  /** The meaning model, once it is set up; without it packets leave its ten out. */
  embed?: () => Embed | undefined;
  now?: () => Date;
  log: Log;
}

export interface RunSummary {
  /** false while the library has no page in either tree: there is nothing to ripple through. */
  wiki: boolean;
  /** The first run: the cursor is set and no job is made. */
  baseline: boolean;
  made: number;
  packeted: number;
  /** Answers taken in, and the proposals they held. */
  read: number;
  proposals: number;
  /** Proposals left out because the writer has the same change waiting, or rejected it. */
  repeats: number;
  /** An answer that could not be taken, with why, by the source's title. */
  problems: string[];
  packets: string;
}

export interface Overview {
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
  /** The id of the page it changed or marked, so the window can show it. */
  page: string | null;
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

Each proposal waits for the writer, who applies it, rejects it or sets it aside. Words the writer wrote are never written over: a claim on them becomes a suggestion they can take or leave. That holds for every page in the sources too. Write your reasons for the writer: one or two plain sentences.
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

  // The change log's lines as parsed; reconcile picks out the page events and ignores the
  // rest. A line that does not parse is logged the run that first reads it (index >= unread).
  #changes(unread: number): unknown[] {
    const text = this.#read('.neo/changes.jsonl') ?? '';
    return text.split('\n').filter((l) => l.trim()).map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (err) {
        if (i >= unread) this.#o.log('warn', 'ripple: a line of the change log does not parse, so it is skipped', { line: i + 1, why: String(err) });
        return null;
      }
    });
  }

  #library(): Promise<PageLibrary> {
    return readLibrary({ root: this.#lib, store: this.#o.pages, ownerOf: this.#o.ownerOf, log: this.#o.log });
  }

  async #html(page: string): Promise<string | null> {
    return (await this.#o.pages.read(page))?.html ?? null;
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
    const summary: RunSummary = { wiki: false, baseline: false, made: 0, packeted: 0, read: 0, proposals: 0, repeats: 0, problems: [], packets: this.#dir('packets') };
    const library = await this.#library();
    if (!library.pages.length) return summary;
    summary.wiki = true;
    this.#setUp();
    let state = this.#rulings.read();
    const rec = await reconcile({
      state, pages: library.pages, head: await this.#o.layer.head(), changes: this.#changes(state.cursor?.changes ?? 0),
      changed: (from, to, under) => this.#o.layer.changed(from, to, under),
      show: (commit, rel) => this.#o.layer.show(commit, rel),
      read: (id) => this.#html(id),
      at: this.#now(),
      log: this.#o.log,
    });
    if (rec.records.length) state = await this.#append(rec.records);
    summary.baseline = rec.baseline;
    summary.made = rec.made.length;
    for (const job of rec.made) this.#o.log('info', 'ripple.job', { id: job.id, page: job.source.page, origin: job.origin, hop: job.hop });
    ({ state, n: summary.packeted } = await this.#packets(state, library));
    const answers = await this.#answers(state);
    summary.read = answers.read;
    summary.proposals = answers.proposals;
    summary.repeats = answers.repeats;
    summary.problems = answers.problems;
    this.#o.log('info', 'ripple.run', { ...summary, packets: undefined });
    return summary;
  }

  // A packet for each open job; a job whose page is gone is set aside.
  async #packets(state: RippleState, library: PageLibrary): Promise<{ state: RippleState; n: number }> {
    const open = [...state.jobs.values()].filter((j) => j.state === 'open');
    if (!open.length) return { state, n: 0 };
    const { corpus, byPath } = pagesCorpus(library, this.#o.log);
    const embed = this.#o.embed?.();
    const records: RippleJob[] = [];
    let n = 0;
    for (const job of open) {
      const { problem: _problem, ...rest } = job;
      const html = await this.#html(job.source.page);
      if (html === null) {
        records.push({ ...rest, at: this.#now(), state: 'skipped', problem: 'The page is no longer in the library.' });
        continue;
      }
      const packet = await packetOf({ library: this.#lib, job, html, corpus, byPath, embed });
      writeWhole(this.#packetFile(job.id), packet.text);
      records.push({ ...rest, at: this.#now(), state: 'packeted' });
      n++;
    }
    return { state: await this.#append(records), n };
  }

  // Each answer waiting in the inbox for a packeted job.
  async #answers(state: RippleState): Promise<{ read: number; proposals: number; repeats: number; problems: string[] }> {
    const out = { read: 0, proposals: 0, repeats: 0, problems: [] as string[] };
    // a target is judged by the page it names, so a title and an id are one card
    const library = [...state.jobs.values()].some((j) => j.state === 'packeted' && existsSync(this.#inboxFile(j.id))) ? await this.#library() : { pages: [] };
    const resolve = (target: string) => findPage(library, target)?.id ?? null;
    const held = heldCards(state, resolve);
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
      const fresh = made.filter((p, i) => made.findIndex((q) => q.id === p.id) === i).filter((p) => {
        const was = repeatOf(state, p, held, resolve);
        if (was) {
          out.repeats++;
          this.#o.log('info', `ripple: ${job.source.title}: left out a ${p.kind} on ${p.target}, which repeats card ${was.id} (${was.status})`);
          return false;
        }
        // a change said twice, in one answer or two, is one card
        if (p.kind !== 'nothing') held.set(cardKey(p, resolve), p);
        return true;
      });
      records.push(...fresh, { ...rest, at, state: 'judged' });
      out.read++;
      out.proposals += fresh.filter((p) => p.status === 'proposed').length;
    }
    if (records.length) await this.#append(records);
    return out;
  }

  /** A job for a page of either tree, Ripple This Page; then its packet. */
  ask(source: { page: string }): Promise<{ job: string; made: boolean; packet: string | null }> {
    return this.#queued(async () => {
      const library = await this.#library();
      this.#setUp();
      const html = await this.#html(source.page);
      if (html === null) throw new Error('The page is not in the library.');
      let state = this.#rulings.read();
      const at = this.#now();
      const job = newJob(state, [], { source: { page: source.page, title: titleOf(source.page) }, html, commit: await this.#o.layer.head(), origin: 'asked', hop: 0, at });
      if (!job) {
        const known = [...state.jobs.values()].reverse().find((j) => j.source.page === source.page && j.hop === 0);
        const id = known?.id ?? '';
        return { job: id, made: false, packet: id && existsSync(this.#packetFile(id)) ? this.#packetFile(id) : null };
      }
      state = await this.#append([...superseded(state, [job], at), job]);
      this.#o.log('info', 'ripple.job', { id: job.id, page: source.page, origin: job.origin, hop: job.hop });
      await this.#packets(state, library);
      return { job: job.id, made: true, packet: this.#packetFile(job.id) };
    });
  }

  /** The author's ruling on a proposal. */
  decide(id: string, decision: 'apply' | 'reject' | 'defer'): Promise<Decided> {
    return this.#queued(() => this.#decide(id, decision));
  }

  async #decide(id: string, decision: 'apply' | 'reject' | 'defer'): Promise<Decided> {
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

    const library = await this.#library();
    const job = state.jobs.get(p.job);
    const rel = p.source.page;
    const then = job?.commit ? await this.#o.layer.show(job.commit, rel) : null;
    const now = await this.#html(rel);
    const source = [then, now].filter((t): t is string => t !== null).map(pageText).join('\n\n');
    const made = await plan({
      proposal: p, library, source,
      html: (page) => this.#html(page.id),
      blame: async (page) => (await this.#o.blame?.(page.id)) ?? [],
      marks: (page) => this.#o.marks.list(page.id),
      origin: (page) => readSidecar(this.#lib, page.id, this.#o.log)?.source.path ?? null,
    });
    return this.#carryOut(made, p, ruled);
  }

  async #carryOut(
    made: Plan, p: RippleProposal,
    ruled: (fields: Partial<RippleProposal>, said: string, page?: Decided['page']) => Promise<Decided>,
  ): Promise<Decided> {
    const at = this.#now();
    if (made.type === 'defer') return ruled({ status: 'deferred', delta: made.delta }, made.delta);
    if (made.type === 'done') return ruled({ status: 'applied', outcome: made.outcome, delta: made.delta }, made.delta, made.page?.id ?? null);
    if (made.type === 'mark') {
      await this.#o.marks.add({ page: made.page.id, ...made.mark }, 'librarian');
      this.#o.log('info', 'ripple.mark', { page: made.page.id, kind: made.mark.kind, proposal: p.id });
      const said = made.outcome === 'suggested'
        ? `The change waits on ${made.page.title} as a suggestion for you to accept or reject.`
        : `A comment on ${made.page.title} holds the line for you to add or not.`;
      return ruled({ status: 'applied', outcome: made.outcome, ...(made.delta ? { delta: made.delta } : {}) }, made.delta ? `${said} ${made.delta}` : said, made.page.id);
    }
    // A change the librarian makes: the edit, the ruling and the next hop's job land in
    // one librarian commit.
    const next = (state: RippleState, page: { page: string; title: string }, html: string, commit: string | null) =>
      (p.hop + 1 > LAST_HOP ? null : newJob(state, [], { source: page, html, commit, origin: 'ripple', hop: p.hop + 1, parent: p.id, at }));
    if (made.type === 'write') {
      const page = made.page;
      const proposal: RippleProposal = { ...p, at, status: 'applied', outcome: 'written', ...(made.delta ? { delta: made.delta } : {}) };
      await this.#asLibrarian('ripple.apply', { page: page.id, proposal: p.id }, [page.id, this.#rulingsRel], async () => {
        const written = await this.#o.pages.write(page.id, made.before, made.html);
        if (!written.ok) return new Error(`${page.title} changed while ripple was working on it (${written.reason}). Apply again to read it afresh.`);
        const state = this.#rulings.read();
        const job = next(state, { page: page.id, title: page.title }, made.html, await this.#o.layer.head());
        await this.#rulings.append([proposal, ...(job ? [job] : [])]);
        if (job) this.#o.log('info', 'ripple.job', { id: job.id, page: page.id, origin: job.origin, hop: job.hop });
        return null;
      });
      this.#o.log('info', 'ripple.write', { page: page.id, proposal: p.id });
      return { proposal, said: `${page.title} is changed. Undo it from the page's history, or by hand.`, page: page.id };
    }
    const proposal: RippleProposal = { ...p, at, status: 'applied', outcome: 'minted' };
    const id = `wiki/${made.title}.html`;
    let created = false;
    try {
      await this.#asLibrarian('ripple.apply', { page: id, proposal: p.id }, [id, sidecarRel(id), this.#rulingsRel], async () => {
        const html = made.paragraphs.map((t) => `<p data-block="${randomBytes(3).toString('hex')}">${inline(t).html || '<br>'}</p>`).join('');
        try {
          await this.#o.pages.create('wiki', `${made.title}.html`, html);
        } catch (err) {
          if (err instanceof PageRefused) return err; // a page by that name came meanwhile: nothing of ours was written
          throw err;
        }
        created = true;
        // a page with no sidecar is the author's, so the sidecar follows the page and a stop between leaves it safe
        const sidecar: HoardPageV1 = {
          version: 1, source: { path: made.origin, name: made.title, sha256: sha256(html) },
          frontmatter: { type: 'lore', tags: ['needs-gathering'], ripple: { from: p.source.title, proposal: p.id } }, imported: at,
        };
        if (!validateHoardPageV1(sidecar)) throw new TypeError(`ripple: refusing to write a page sidecar: ${JSON.stringify(validateHoardPageV1.errors)}`);
        writeWhole(path.join(this.#lib, ...sidecarRel(id).split('/')), `${JSON.stringify(sidecar, null, 2)}\n`);
        const job = next(this.#rulings.read(), { page: id, title: made.title }, html, await this.#o.layer.head());
        await this.#rulings.append([proposal, ...(job ? [job] : [])]);
        if (job) this.#o.log('info', 'ripple.job', { id: job.id, page: id, origin: job.origin, hop: job.hop });
        return null;
      });
    } catch (err) {
      if (!created && err instanceof PageRefused) return ruled({ status: 'deferred', delta: err.message }, err.message);
      throw err;
    }
    this.#o.log('info', 'ripple.mint', { page: id, proposal: p.id });
    return { proposal, said: `${made.title} is a new page in the wiki.`, page: id };
  }

  // A librarian edit of `paths` (one commit, GitLayer.around). When the pre-commit gate
  // refuses it, every path is put back as it was (a file the edit made is removed), so the
  // library is as it was and the refusal goes to the caller.
  async #asLibrarian(label: string, subject: Record<string, unknown>, paths: readonly string[], apply: () => Promise<Error | null>): Promise<void> {
    const before = paths.map((rel) => [rel, this.#read(rel)] as const);
    // every file is tried; one that will not go back throws, so the gate keeps its paths held
    const restore = () => {
      const failed: string[] = [];
      for (const [rel, text] of before) {
        const file = path.join(this.#lib, ...rel.split('/'));
        try {
          if (text === null) rmSync(file, { force: true });
          else writeWhole(file, text);
        } catch (err) {
          failed.push(rel);
          this.#o.log('error', 'ripple: a refused change could not be put back', { path: rel, why: String(err) });
        }
      }
      if (failed.length) throw new Error(`The library check refused this change and ripple could not put back ${failed.join(', ')}; they are held out of the history until they are mended.`);
    };
    // An apply that did not write returns why, rather than throwing: a throw reaches the git
    // layer as a failed edit, whose paths it commits as the librarian's, and they would hold
    // whatever the writer put there meanwhile. Returned, the layer makes no commit.
    let unwritten: Error | null = null;
    const done = await asLibrarian({ layer: this.#o.layer, log: this.#o.log }, label, subject, paths, async () => {
      unwritten = await apply();
      return unwritten ? 'stale' : null;
    }, restore);
    if (unwritten) throw unwritten;
    if (done.ok) return;
    // the card stays waiting: nothing was written, and the caller is told why
    if (done.reason === 'refused') throw new Error(`The library check refused this change, so nothing was written: ${done.findings.map((f) => `${f.path}: ${f.message}`).join('; ')}`);
    if (done.reason === 'held') throw new Error(`The library check still holds ${paths.join(', ')} from an earlier refusal, so nothing was written. Save the page, then apply again.`);
    throw new Error(`The change could not be written (${done.reason}). Apply again to read the page afresh.`);
  }

  /** What waits: jobs for the judge, proposals for the author. Reads; never writes. */
  overview(): Overview {
    const state = this.#rulings.read();
    const proposals = [...state.proposals.values()];
    return {
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
export function packetOf(o: { library: string; job: RippleJob; html: string; corpus: Corpus; byPath: Map<string, RipplePage>; embed?: Embed }) {
  const files = rippleFiles(o.library, o.job.id);
  return buildPacket({
    job: o.job, sourceText: pageText(o.html), sourcePath: corpusPath(o.job.source.page),
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
