// Ripple from end to end on a made-up wiki (ripple/engine.ts), with the history off:
// - the first run only starts watching; a page imported after it gets a packet that
//   names the brief, never holds it, and lists the pages near the source;
// - an answer with a fitting preflight becomes proposals for the author, a nothing a
//   ruling at once; one that does not fit is a problem on the job, said once;
// - applying writes the librarian's page in a librarian edit and opens the next hop,
//   comments on the author's page instead, and mints a page as the librarian's;
// - nothing applies while the wiki is open, and a ruling made stays made;
// - Ripple This Chapter packets a chapter of the manuscript;
// - the meaning model's top-up writes a waiting packet again with its pages, once, and
//   leaves a packet the judge has answered alone.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { topUp } from '../../src/hoard/ripple/embed-cli.ts';
import { DEFAULT_BRIEF, Ripple } from '../../src/hoard/ripple/engine.ts';
import { sha256 } from '../../src/hoard/ripple/rulings.ts';
import { WikiStore } from '../../src/hoard/wiki/store.ts';
import { tempDir } from './git-support.ts';

type T = { after(fn: () => void): void };

function setup(t: T) {
  const library = tempDir(t);
  const vault = tempDir(t);
  let n = 0;
  let clock = Date.parse('2026-10-16T12:00:00.000Z');
  const now = () => new Date((clock += 1000));
  const newId = (prefix: string) => `${prefix}-t${(n++).toString().padStart(4, '0')}`;
  const log = () => {};
  const marks = new MarkStore({ library: () => library, now, newId, log });
  const wiki = new WikiStore({ library: () => library, now, newId, marks, log });
  const arounds: string[][] = [];
  const ripple = new Ripple({
    library: () => library, wiki, marks, now, log,
    layer: {
      head: async () => null,
      show: async () => null,
      changed: async () => [],
      blame: async () => [],
      around: async (paths, apply) => { arounds.push([...paths]); return { result: await apply(), before: null, after: null }; },
    },
  });
  const importPages = async (pages: Record<string, string>) => {
    const files = Object.entries(pages).map(([name, text]) => {
      const file = path.join(vault, `${name}.md`);
      writeFileSync(file, text);
      return file;
    });
    return wiki.apply(wiki.sort(files), null);
  };
  const chapter = (title: string) => {
    const w = wiki.pages()!;
    const chId = w.pages.find((p) => p.title === title)!.chId;
    return { bookId: w.bookId, chId, file: path.join(library, w.bookId, 'chapters', `${chId}.html`) };
  };
  return { library, wiki, marks, ripple, arounds, importPages, chapter };
}

const ECHO = 'When you are unsure, say nothing about the page: the writer would rather miss a ripple than undo a wrong one.';
const answer = (lines: object[]) => [{ kind: 'preflight', brief_sha256: sha256(DEFAULT_BRIEF), echo: ECHO }, ...lines].map((l) => JSON.stringify(l)).join('\n');

test('ripple carries an imported page through the wiki, on the author\'s word', async (t) => {
  const { library, wiki, marks, ripple, arounds, importPages, chapter } = setup(t);
  assert.equal((await ripple.run()).wiki, false, 'no wiki yet');
  await importPages({
    Harbour: '---\ntype: lore\n---\nThe harbour wall is made of timber.\n\nBoats come in at high water.\n',
    Lighthouse: 'The keeper lives in the tower above the [[Harbour]].\n',
    'Tide Tables': '---\ntype: lore\n---\nHigh water at the [[Harbour]] comes twice a day.\n',
  });
  const first = await ripple.run();
  assert.deepEqual([first.wiki, first.baseline, first.made], [true, true, 0]);
  const dir = path.join(library, '.neo', 'ripple');
  assert.equal(readFileSync(path.join(dir, 'brief.md'), 'utf8'), DEFAULT_BRIEF);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'packets/\ninbox/\n');

  await importPages({ 'Long Storm': '---\ntype: lore\n---\nThe long storm broke the [[Harbour]] wall. It was rebuilt in stone the next spring, and the [[Lighthouse]] keeper moved inland.\n' });
  const second = await ripple.run();
  assert.deepEqual([second.baseline, second.made, second.packeted, second.read], [false, 1, 1, 0]);
  const [job] = ripple.overview().jobs;
  assert.equal(job!.title, 'Long Storm');
  const packet = readFileSync(job!.packet, 'utf8');
  assert.match(packet, /Source: \[\[Long Storm\]\], hop 0/);
  assert.match(packet, /## Candidates \(3\)/);
  assert.match(packet, /the author's page: a claim on it becomes a suggestion/);
  assert.match(packet, /meaning model is not set up/);
  assert.ok(!packet.includes(ECHO), 'the packet never holds the brief');
  assert.ok(packet.includes(path.join(dir, 'brief.md')));

  writeFileSync(job!.answer, answer([
    { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'The storm broke the wall.', quote: 'It was rebuilt in stone the next spring' },
    { kind: 'topic', target: 'Lighthouse', line: 'The keeper moved inland after the [[Long Storm]].', reason: 'The keeper left.', quote: 'the Lighthouse keeper moved inland' },
    { kind: 'mint', title: 'Stone Wall', text: 'The harbour wall, rebuilt in stone.', reason: 'Named and has no page.', quote: 'rebuilt in stone' },
    { kind: 'nothing', target: 'Tide Tables', reason: 'The tides did not change.' },
  ]));
  const third = await ripple.run();
  assert.deepEqual([third.read, third.proposals, third.problems], [1, 3, []]);
  const view = ripple.overview();
  assert.deepEqual(view.jobs, [], 'a judged job waits on no one but the author');
  assert.deepEqual(view.proposals.map((p) => [p.kind, p.target, p.status]), [['claim', 'Harbour', 'proposed'], ['topic', 'Lighthouse', 'proposed'], ['mint', 'Stone Wall', 'proposed']]);
  const [claim, topic, mint] = view.proposals;
  assert.equal((await ripple.run()).proposals, 0, 'an answer is read once');

  const wikiId = wiki.wikiId()!;
  await assert.rejects(ripple.decide(wikiId, claim!.id, 'apply'), /The wiki is open/);
  assert.equal(ripple.overview().proposals[0]!.status, 'proposed');

  const harbour = chapter('Harbour');
  const before = readFileSync(harbour.file, 'utf8');
  const applied = await ripple.decide('book-other', claim!.id, 'apply');
  assert.equal(applied.proposal.outcome, 'written');
  assert.deepEqual(applied.page, { bookId: harbour.bookId, chId: harbour.chId });
  assert.equal(readFileSync(harbour.file, 'utf8'), before.replace('made of timber', 'rebuilt in stone'));
  assert.deepEqual(arounds[0], [`${harbour.bookId}/chapters/${harbour.chId}.html`, '.neo/ripple/rulings.jsonl']);
  const hop1 = ripple.overview().jobs;
  assert.deepEqual(hop1.map((j) => [j.title, j.hop, j.state]), [['Harbour', 1, 'open']], 'the change opens the next hop');
  assert.equal((await ripple.decide(null, claim!.id, 'reject')).said, 'It was applied already.');

  const lighthouse = chapter('Lighthouse');
  const lighthouseHtml = readFileSync(lighthouse.file, 'utf8');
  const commented = await ripple.decide(null, topic!.id, 'apply');
  assert.equal(commented.proposal.outcome, 'commented');
  assert.equal(readFileSync(lighthouse.file, 'utf8'), lighthouseHtml, 'the author\'s page is not written');
  const comments = await marks.chapter(lighthouse.bookId, lighthouse.chId);
  assert.deepEqual(comments.map((m) => [m.kind, m.created.who]), [['comment', 'librarian']]);
  assert.match(comments[0]!.thread[0]!.body, /The keeper moved inland after the \[\[Long Storm\]\]/);

  const minted = await ripple.decide(null, mint!.id, 'apply');
  assert.equal(minted.proposal.outcome, 'minted');
  const stone = chapter('Stone Wall');
  assert.match(readFileSync(stone.file, 'utf8'), /<p data-block="[^"]+">The harbour wall, rebuilt in stone\.<\/p>/);
  const sidecar = JSON.parse(readFileSync(path.join(library, '.neo', stone.bookId, 'pages', `${stone.chId}.json`), 'utf8'));
  assert.equal(sidecar.frontmatter.type, 'lore', 'a minted page is the librarian\'s');
  assert.deepEqual(sidecar.frontmatter.tags, ['needs-gathering']);
  assert.equal(sidecar.source.path, `ripple:${mint!.id}`);
  assert.deepEqual(arounds[1], [stone.bookId, `.neo/${stone.bookId}/pages`, '.neo/ripple/rulings.jsonl']);
  assert.deepEqual(ripple.overview().jobs.map((j) => [j.title, j.hop]), [['Harbour', 1], ['Stone Wall', 1]]);
  assert.deepEqual([ripple.overview().applied, ripple.overview().proposals.length], [3, 0]);

  const fourth = await ripple.run();
  assert.equal(fourth.packeted, 2, 'the next hop gets its packets');
  const log = readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((r) => r.type === 'proposal' && r.kind === 'nothing' && r.status === 'rejected'), 'a nothing is kept as a ruling');
});

test('an answer that does not fit is a problem on its job, and a later fix is read', async (t) => {
  const { ripple, importPages } = setup(t);
  await importPages({ Harbour: '---\ntype: lore\n---\nThe harbour wall.\n' });
  await ripple.run();
  await importPages({ Quay: '---\ntype: lore\n---\nThe quay by the [[Harbour]] wall, rebuilt after the storm.\n' });
  await ripple.run();
  const [job] = ripple.overview().jobs;
  writeFileSync(job!.answer, JSON.stringify({ kind: 'preflight', brief_sha256: 'f'.repeat(64), echo: ECHO }));
  const bad = await ripple.run();
  assert.equal(bad.problems.length, 1);
  assert.match(bad.problems[0]!, /^Quay: the preflight names another version of the brief/);
  assert.match(ripple.overview().jobs[0]!.problem ?? '', /another version/);
  await ripple.run();
  writeFileSync(job!.answer, answer([{ kind: 'topic', target: 'Harbour', line: 'See [[Quay]].', reason: 'r', quote: 'rebuilt after the storm' }]));
  const good = await ripple.run();
  assert.deepEqual([good.read, good.proposals], [1, 1]);
  const [p] = ripple.overview().proposals;
  assert.equal((await ripple.decide(null, p!.id, 'defer')).proposal.status, 'deferred');
  assert.equal(ripple.overview().proposals[0]!.status, 'deferred');
  assert.equal((await ripple.decide(null, p!.id, 'reject')).proposal.status, 'rejected');
  assert.deepEqual([ripple.overview().proposals.length, ripple.overview().rejected], [0, 1]);
});

test('Ripple This Chapter packets a chapter of the manuscript, once for the same words', async (t) => {
  const { library, ripple, importPages } = setup(t);
  await importPages({ Harbour: '---\ntype: lore\n---\nThe harbour wall.\n' });
  mkdirSync(path.join(library, 'book-novel-1', 'chapters'), { recursive: true });
  writeFileSync(path.join(library, 'book-novel-1', 'chapters', 'c1.html'), '<p>She walked along the harbour wall at dawn.</p>');
  const asked = await ripple.ask({ bookId: 'book-novel-1', chId: 'c1', title: 'Dawn' });
  assert.equal(asked.made, true);
  assert.ok(asked.packet && existsSync(asked.packet));
  assert.match(readFileSync(asked.packet!, 'utf8'), /Source: \[\[Dawn\]\]/);
  assert.match(readFileSync(asked.packet!, 'utf8'), /\[\[Harbour\]\]|Harbour/);
  const again = await ripple.ask({ bookId: 'book-novel-1', chId: 'c1', title: 'Dawn' });
  assert.deepEqual([again.made, again.job, again.packet], [false, asked.job, asked.packet]);
  await assert.rejects(ripple.ask({ bookId: 'book-novel-1', chId: 'c2', title: 'Later' }), /not saved yet/);
});

// letters counted: close enough in meaning for a test
const letters = async (texts: string[]) => texts.map((t) => Array.from({ length: 26 }, (_, i) => t.toLowerCase().split(String.fromCharCode(97 + i)).length - 1));

test('the meaning model\'s top-up adds its pages to a waiting packet, once', async (t) => {
  const { library, ripple, importPages } = setup(t);
  await importPages({ Harbour: '---\ntype: lore\n---\nThe harbour wall.\n', Mill: '---\ntype: lore\n---\nThe mill grinds corn by the river.\n' });
  await ripple.run();
  await importPages({ Quay: '---\ntype: lore\n---\nThe quay by the [[Harbour]] wall.\n' });
  await ripple.run();
  const [job] = ripple.overview().jobs;
  assert.match(readFileSync(job!.packet, 'utf8'), /meaning model is not set up/);
  assert.deepEqual(await topUp(library, letters), { waiting: 1, written: 1 });
  const packet = readFileSync(job!.packet, 'utf8');
  assert.match(packet, /then pages that share its words or are close in meaning\./);
  assert.match(packet, /Mill/);
  assert.deepEqual(await topUp(library, letters), { waiting: 1, written: 0 }, 'the same pages write nothing');
  writeFileSync(job!.answer, answer([]));
  assert.deepEqual(await topUp(library, letters), { waiting: 0, written: 0 }, 'an answered packet is left alone');
});
