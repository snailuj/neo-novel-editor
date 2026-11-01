// Ripple from end to end on made-up pages in both trees (ripple/engine.ts), against the
// real page store, owner reader and mark store of a temporary library, with the history off
// except where a test turns it on:
// - the first run only starts watching; a page imported after it gets a packet that names
//   the brief, never holds it, and lists the pages of both trees near the source;
// - an answer with a fitting preflight becomes proposals for the author, a nothing a
//   ruling at once; one that does not fit is a problem on the job, said once;
// - applying writes a librarian-owned wiki page in a librarian edit that names the page's
//   file, and opens the next hop; every change to an author-owned page, in either tree, is
//   a mark and leaves the page's bytes alone; a mint is a librarian-owned wiki page;
// - an applied change opens one job one hop further, and none past the cap;
// - Ripple This Page packets a page of either tree;
// - a later answer that repeats a card the writer has waiting or rejected, in other
//   words, makes no new card; one that repeats an applied card does;
// - the meaning model's top-up writes a waiting packet again with its pages, once, and
//   leaves a packet the judge has answered alone.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { GitLayer, resolveSettings } from '../../src/hoard/git/layer.ts';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { ownerOf } from '../../src/hoard/review/owner.ts';
import { topUp } from '../../src/hoard/ripple/embed-cli.ts';
import { DEFAULT_BRIEF, Ripple, type RippleOptions } from '../../src/hoard/ripple/engine.ts';
import { sha256 } from '../../src/hoard/ripple/rulings.ts';
import { isolateGitConfig, log as gitLog, tempDir, tempLibrary } from './git-support.ts';
import { pagesLibrary } from './pages-support.ts';

type T = { after(fn: () => void): void };

const RULINGS = '.neo/ripple/rulings.jsonl';
const AT = '2026-11-01T12:00:00.000Z';

function setup(t: T, extra: { library?: string; layer?: RippleOptions['layer']; pagesLayer?: Parameters<typeof pagesLibrary>[1] } = {}) {
  const lib = pagesLibrary(t, extra.pagesLayer);
  const library = lib.library;
  let clock = Date.parse(AT);
  const now = () => new Date((clock += 1000));
  const arounds: string[][] = [];
  const marks = new MarkStore({ library: () => library, now, log: lib.log });
  const ripple = new Ripple({
    library: () => library, pages: lib.store, marks, ownerOf: (root, id) => ownerOf(root, id, lib.log), now, log: lib.log,
    layer: extra.layer ?? {
      head: async () => null,
      show: async () => null,
      changed: async () => [],
      around: async (paths, apply) => { arounds.push([...paths]); return { result: await apply(), before: null, after: null }; },
    },
  });
  const changes: string[] = [];
  /** A page as an import leaves it: its file, and for the librarian's a lore sidecar. */
  const page = (id: string, html: string, owner: 'author' | 'librarian' = 'author') => {
    lib.put(id, html);
    if (owner === 'librarian') {
      lib.put(`.neo/pages/${id}.json`, JSON.stringify({ version: 1, source: { path: '/v/x.md', name: 'x', sha256: 'a'.repeat(64) }, frontmatter: { type: 'lore' }, imported: AT }));
    }
  };
  const imported = (id: string, kind = 'page-imported') => {
    changes.push(JSON.stringify({ version: 1, at: AT, kind, page: id, src: '/v/x.md' }));
    lib.put('.neo/changes.jsonl', `${changes.join('\n')}\n`);
  };
  const p = (text: string) => `<p data-block="${sha256(text).slice(0, 6)}">${text}</p>`;
  return { ...lib, marks, ripple, arounds, page, imported, p };
}

const ECHO = 'When you are unsure, say nothing about the page: the writer would rather miss a ripple than undo a wrong one.';
const answer = (lines: object[]) => [{ kind: 'preflight', brief_sha256: sha256(DEFAULT_BRIEF), echo: ECHO }, ...lines].map((l) => JSON.stringify(l)).join('\n');

const STORM = 'The long storm broke the [[Harbour]] wall. It was rebuilt in stone the next spring, and the [[Lighthouse]] keeper moved inland.';

test('ripple carries a changed page through both trees, on the author\'s word', async (t) => {
  const { library, ripple, arounds, page, imported, p, get, marks, lines, logged } = setup(t);
  assert.equal((await ripple.run()).wiki, false, 'no pages yet');
  page('wiki/Harbour.html', `${p('The harbour wall is made of timber.')}${p('Boats come in at high water.')}`, 'librarian');
  page('wiki/Lighthouse.html', p('The keeper lives in the tower above the [[Harbour]].'));
  page('wiki/Tide Tables.html', p('High water at the [[Harbour]] comes twice a day.'), 'librarian');
  page('sources/Notes/Field Notes.html', p('The harbour wall is described as made of timber in these notes.'));
  const first = await ripple.run();
  assert.deepEqual([first.wiki, first.baseline, first.made], [true, true, 0]);
  const dir = path.join(library, '.neo', 'ripple');
  assert.equal(readFileSync(path.join(dir, 'brief.md'), 'utf8'), DEFAULT_BRIEF);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'packets/\ninbox/\n');

  page('wiki/Long Storm.html', p(STORM), 'librarian');
  imported('wiki/Long Storm.html');
  const second = await ripple.run();
  assert.deepEqual([second.baseline, second.made, second.packeted, second.read], [false, 1, 1, 0]);
  assert.deepEqual(logged('ripple.job').map((l) => l.data), [{ id: ripple.overview().jobs[0]!.id, page: 'wiki/Long Storm.html', origin: 'imported', hop: 0 }], 'a job made is logged');
  const [job] = ripple.overview().jobs;
  assert.equal(job!.title, 'Long Storm');
  const packet = readFileSync(job!.packet, 'utf8');
  assert.match(packet, /Source: \[\[Long Storm\]\], hop 0/);
  assert.match(packet, /## Candidates \(4\)/);
  assert.match(packet, /tree: sources\n {2}file: sources\/Notes\/Field Notes\.html \(the author's page: a claim on it becomes a suggestion\)/);
  assert.match(packet, /tree: wiki\n {2}file: wiki\/Harbour\.html\n/);
  assert.match(packet, /meaning model is not set up/);
  assert.ok(!packet.includes(ECHO), 'the packet never holds the brief');
  assert.ok(packet.includes(path.join(dir, 'brief.md')));

  writeFileSync(job!.answer, answer([
    { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'The storm broke the wall.', quote: 'It was rebuilt in stone the next spring' },
    { kind: 'topic', target: 'Lighthouse', line: 'The keeper moved inland after the [[Long Storm]].', reason: 'The keeper left.', quote: 'the Lighthouse keeper moved inland' },
    { kind: 'claim', target: 'sources/Notes/Field Notes.html', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'The notes are out of date.', quote: 'It was rebuilt in stone the next spring' },
    { kind: 'mint', title: 'Stone Wall', text: 'The harbour wall, rebuilt in stone.', reason: 'Named and has no page.', quote: 'rebuilt in stone' },
    { kind: 'nothing', target: 'Tide Tables', reason: 'The tides did not change.' },
  ]));
  const third = await ripple.run();
  assert.deepEqual([third.read, third.proposals, third.problems], [1, 4, []]);
  const view = ripple.overview();
  assert.deepEqual(view.jobs, [], 'a judged job waits on no one but the author');
  assert.deepEqual(view.proposals.map((q) => [q.kind, q.target, q.status]), [
    ['claim', 'Harbour', 'proposed'], ['topic', 'Lighthouse', 'proposed'], ['claim', 'sources/Notes/Field Notes.html', 'proposed'], ['mint', 'Stone Wall', 'proposed'],
  ]);
  const [claim, topic, onSource, mint] = view.proposals;
  assert.equal((await ripple.run()).proposals, 0, 'an answer is read once');

  const authors = ['wiki/Lighthouse.html', 'sources/Notes/Field Notes.html'];
  const authorBytes = authors.map((id) => get(id));
  const harbour = get('wiki/Harbour.html');
  const applied = await ripple.decide(claim!.id, 'apply');
  assert.equal(applied.proposal.outcome, 'written');
  assert.equal(applied.page, 'wiki/Harbour.html');
  assert.equal(get('wiki/Harbour.html'), harbour.replace('made of timber', 'rebuilt in stone'));
  assert.deepEqual(arounds[0], ['wiki/Harbour.html', RULINGS], 'the librarian edit names the page\'s own file');
  assert.deepEqual(logged('ripple.write').map((l) => l.data), [{ page: 'wiki/Harbour.html', proposal: claim!.id }]);
  assert.deepEqual(ripple.overview().jobs.map((j) => [j.title, j.hop, j.state]), [['Harbour', 1, 'open']], 'the change opens the next hop');
  assert.equal((await ripple.decide(claim!.id, 'reject')).said, 'It was applied already.');

  const commented = await ripple.decide(topic!.id, 'apply');
  assert.equal(commented.proposal.outcome, 'commented');
  const comments = await marks.list('wiki/Lighthouse.html');
  assert.deepEqual(comments.map((m) => [m.kind, m.created.who]), [['comment', 'librarian']]);
  assert.match(comments[0]!.thread[0]!.body, /The keeper moved inland after the \[\[Long Storm\]\]/);

  const suggested = await ripple.decide(onSource!.id, 'apply');
  assert.equal(suggested.proposal.outcome, 'suggested');
  const suggestions = await marks.list('sources/Notes/Field Notes.html');
  assert.deepEqual(suggestions.map((m) => [m.kind, m.created.who, m.proposed]), [['substitution', 'librarian', 'rebuilt in stone']]);
  assert.equal(logged('ripple.mark').length, 2);

  const minted = await ripple.decide(mint!.id, 'apply');
  assert.equal(minted.proposal.outcome, 'minted');
  assert.equal(minted.page, 'wiki/Stone Wall.html');
  assert.match(get('wiki/Stone Wall.html'), /^<p data-block="[^"]+">The harbour wall, rebuilt in stone\.<\/p>$/);
  const sidecar = JSON.parse(get('.neo/pages/wiki/Stone Wall.html.json'));
  assert.equal(sidecar.frontmatter.type, 'lore', 'a minted page is the librarian\'s');
  assert.deepEqual(sidecar.frontmatter.tags, ['needs-gathering']);
  assert.equal(sidecar.source.path, `ripple:${mint!.id}`);
  assert.deepEqual(arounds[1], ['wiki/Stone Wall.html', '.neo/pages/wiki/Stone Wall.html.json', RULINGS]);
  assert.deepEqual(ripple.overview().jobs.map((j) => [j.title, j.hop]), [['Harbour', 1], ['Stone Wall', 1]]);
  assert.deepEqual([ripple.overview().applied, ripple.overview().proposals.length], [4, 0]);
  assert.ok(lines.some((l) => l.message === 'ripple.mint'));

  assert.deepEqual(authors.map((id) => get(id)), authorBytes, 'no author-owned page was written');
  const fourth = await ripple.run();
  assert.equal(fourth.packeted, 2, 'the next hop gets its packets');
  const log = readFileSync(path.join(dir, 'rulings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((r) => r.type === 'proposal' && r.kind === 'nothing' && r.status === 'rejected'), 'a nothing is kept as a ruling');
});

test('ripple never writes the bytes of a wiki page with no sidecar or of a source, whatever the claim', async (t) => {
  const { ripple, page, imported, p, get } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall is made of timber.'));
  page('sources/Wall.html', p('The wall is made of timber.'));
  page('sources/Origin.html', p('Seed.'));
  await ripple.run();
  page('wiki/Storm.html', p(STORM), 'librarian');
  imported('wiki/Storm.html');
  await ripple.run();
  const [job] = ripple.overview().jobs;
  const before = ['wiki/Harbour.html', 'sources/Wall.html'].map((id) => get(id));
  writeFileSync(job!.answer, answer([
    { kind: 'claim', target: 'wiki/Harbour.html', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'rebuilt in stone the next spring' },
    { kind: 'claim', target: 'sources/Wall.html', anchor: 'made of timber', text: '', reason: 'r', quote: 'rebuilt in stone the next spring' },
    { kind: 'topic', target: 'wiki/Harbour.html', line: 'See [[Storm]].', reason: 'r', quote: 'broke the Harbour wall' },
  ]));
  await ripple.run();
  for (const q of ripple.overview().proposals) assert.match((await ripple.decide(q.id, 'apply')).proposal.outcome ?? '', /suggested|commented/);
  assert.deepEqual(['wiki/Harbour.html', 'sources/Wall.html'].map((id) => get(id)), before);
});

test('an applied change opens one job one hop further, and none past the cap', async (t) => {
  const { ripple, page, imported, p, get, arounds } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall is made of timber.'), 'librarian');
  page('wiki/Quay.html', p('The quay is old.'), 'librarian');
  page('wiki/Mill.html', p('The mill is idle.'), 'librarian');
  await ripple.run();
  page('wiki/Storm.html', p(STORM), 'librarian');
  imported('wiki/Storm.html');
  const hop = async (n: number, line: object) => {
    await ripple.run();
    const [job] = ripple.overview().jobs;
    assert.equal(job!.hop, n);
    writeFileSync(job!.answer, answer([line]));
    await ripple.run();
    const [q] = ripple.overview().proposals;
    assert.equal(q!.hop, n);
    assert.equal((await ripple.decide(q!.id, 'apply')).proposal.outcome, 'written');
  };
  await hop(0, { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'It was rebuilt in stone the next spring' });
  assert.deepEqual(ripple.overview().jobs.map((j) => [j.title, j.hop]), [['Harbour', 1]]);
  await hop(1, { kind: 'claim', target: 'Quay', anchor: 'is old', text: 'is new', reason: 'r', quote: 'wall is rebuilt in stone' });
  assert.deepEqual(ripple.overview().jobs.map((j) => [j.title, j.hop]), [['Quay', 2]]);
  await hop(2, { kind: 'claim', target: 'Mill', anchor: 'is idle', text: 'grinds corn', reason: 'r', quote: 'The quay is new' });
  assert.deepEqual(ripple.overview().jobs, [], 'a change at the last hop opens no job');
  assert.match(get('wiki/Mill.html'), /The mill grinds corn\./);
  assert.equal(arounds.length, 3);
});

test('an answer that does not fit is a problem on its job, and a later fix is read', async (t) => {
  const { ripple, page, imported, p } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall.'), 'librarian');
  await ripple.run();
  page('wiki/Quay.html', p('The quay by the [[Harbour]] wall, rebuilt after the storm.'), 'librarian');
  imported('wiki/Quay.html');
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
  const [q] = ripple.overview().proposals;
  assert.equal((await ripple.decide(q!.id, 'defer')).proposal.status, 'deferred');
  assert.equal(ripple.overview().proposals[0]!.status, 'deferred');
  assert.equal((await ripple.decide(q!.id, 'reject')).proposal.status, 'rejected');
  assert.deepEqual([ripple.overview().proposals.length, ripple.overview().rejected], [0, 1]);
});

test('Ripple This Page packets a page of either tree, once for the same words', async (t) => {
  const { ripple, page, put, p } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall.'), 'librarian');
  page('sources/Notes/Dawn.html', p('She walked along the harbour wall at dawn.'));
  const asked = await ripple.ask({ page: 'sources/Notes/Dawn.html' });
  assert.equal(asked.made, true);
  assert.match(readFileSync(asked.packet!, 'utf8'), /Source: \[\[Dawn\]\]/);
  assert.match(readFileSync(asked.packet!, 'utf8'), /file: wiki\/Harbour\.html/);
  const again = await ripple.ask({ page: 'sources/Notes/Dawn.html' });
  assert.deepEqual([again.made, again.job, again.packet], [false, asked.job, asked.packet]);
  put('sources/Notes/Dawn.html', p('She walked along the harbour wall at dusk.'));
  assert.equal((await ripple.ask({ page: 'sources/Notes/Dawn.html' })).made, true, 'new words make a new job');
  await assert.rejects(ripple.ask({ page: 'wiki/Later.html' }), /not in the library/);
});

test('a re-run makes no new card for a change the writer has waiting or rejected', async (t) => {
  const { ripple, page, put, p } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall is made of timber.'), 'librarian');
  page('wiki/Quay.html', p('The quay by the [[Harbour]].'), 'librarian');
  page('wiki/Lighthouse.html', p('The keeper lives in the tower.'), 'librarian');
  await ripple.run();
  const dawn = { page: 'sources/Dawn.html' };
  const judge = async (html: string, lines: object[]) => {
    put(dawn.page, `<p>${html}</p>`);
    const asked = await ripple.ask(dawn);
    assert.equal(asked.made, true, 'new words make a new job');
    writeFileSync(ripple.overview().jobs.find((j) => j.id === asked.job)!.answer, answer(lines));
    return ripple.run();
  };
  const first = await judge('The storm broke the harbour wall; it was rebuilt in stone. The keeper moved inland.', [
    { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'it was rebuilt in stone' },
    { kind: 'topic', target: 'Quay', line: 'The storm in [[Dawn]] broke the wall here.', reason: 'r', quote: 'The storm broke the harbour wall' },
    { kind: 'topic', target: 'Lighthouse', line: 'In [[Dawn]] the keeper moves inland.', reason: 'r', quote: 'The keeper moved inland' },
  ]);
  assert.deepEqual([first.proposals, first.repeats], [3, 0], 'a clean log holds nothing to repeat');
  const [claim, quay, light] = ripple.overview().proposals;
  await ripple.decide(quay!.id, 'reject');
  await ripple.decide(light!.id, 'apply');

  const second = await judge('The storm broke the harbour wall; it was rebuilt in stone. The keeper moved inland at once.', [
    { kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'of stone, after the storm', reason: 'other words', quote: 'rebuilt in stone' },
    { kind: 'topic', target: 'quay', line: 'See [[Dawn]], where the storm breaks the wall.', reason: 'other words', quote: 'broke the harbour wall' },
    { kind: 'topic', target: 'Lighthouse', line: 'The keeper leaves at once in [[Dawn]].', reason: 'r', quote: 'moved inland at once' },
    { kind: 'topic', target: 'Harbour', line: 'The wall falls in [[Dawn]].', reason: 'r', quote: 'The storm broke the harbour wall' },
    { kind: 'topic', target: 'Harbour', line: 'In [[Dawn]] the wall falls.', reason: 'said twice', quote: 'broke the harbour wall' },
  ]);
  assert.deepEqual([second.read, second.proposals, second.repeats], [1, 2, 3], 'one answer saying a change twice makes one card');
  const waiting = ripple.overview().proposals.filter((q) => q.status === 'proposed');
  assert.deepEqual(waiting.map((q) => [q.kind, q.target]), [['claim', 'Harbour'], ['topic', 'Lighthouse'], ['topic', 'Harbour']]);
  assert.equal(waiting[0]!.id, claim!.id, 'the waiting card is the first one, not a second copy');
});

test('a page named by title in one answer and by id in the next is one card', async (t) => {
  const { ripple, page, put, p } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall is made of timber.'), 'librarian');
  await ripple.run();
  const judge = async (words: string, target: string, text: string) => {
    put('sources/Dawn.html', `<p>${words}</p>`);
    const asked = await ripple.ask({ page: 'sources/Dawn.html' });
    writeFileSync(ripple.overview().jobs.find((j) => j.id === asked.job)!.answer, answer([
      { kind: 'claim', target, anchor: 'made of timber', text, reason: 'r', quote: 'it was rebuilt in stone' },
    ]));
    return ripple.run();
  };
  const first = await judge('The wall fell; it was rebuilt in stone.', 'Harbour', 'rebuilt in stone');
  assert.deepEqual([first.proposals, first.repeats], [1, 0]);
  const second = await judge('The wall fell; it was rebuilt in stone, they say.', 'wiki/Harbour.html', 'of stone, after the storm');
  assert.deepEqual([second.proposals, second.repeats], [0, 1], 'the id names the page the title named');
});

test('the same claim on two pages of one title, one in each tree, is two cards', async (t) => {
  const { ripple, page, put, p } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall is made of timber.'), 'librarian');
  page('sources/Harbour.html', p('The harbour wall is made of timber.'));
  await ripple.run();
  put('sources/Dawn.html', p('The wall was rebuilt in stone after the storm.'));
  const asked = await ripple.ask({ page: 'sources/Dawn.html' });
  const line = (target: string) => ({ kind: 'claim', target, anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'rebuilt in stone after the storm' });
  writeFileSync(ripple.overview().jobs.find((j) => j.id === asked.job)!.answer, answer([line('wiki/Harbour.html'), line('sources/Harbour.html')]));
  const read = await ripple.run();
  assert.deepEqual([read.proposals, read.repeats], [2, 0], 'the same claim on two pages is not a repeat');
});

// letters counted: close enough in meaning for a test
const letters = async (texts: string[]) => texts.map((t) => Array.from({ length: 26 }, (_, i) => t.toLowerCase().split(String.fromCharCode(97 + i)).length - 1));

test('the meaning model\'s top-up adds its pages to a waiting packet, once', async (t) => {
  const { library, ripple, page, imported, p } = setup(t);
  page('wiki/Harbour.html', p('The harbour wall.'), 'librarian');
  page('sources/Notes/Mill.html', p('The mill grinds corn by the river.'));
  await ripple.run();
  page('wiki/Quay.html', p('The quay by the [[Harbour]] wall.'), 'librarian');
  imported('wiki/Quay.html');
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

test('a ripple write to a page is a librarian commit of that page\'s own file, after the author\'s pending work', async (t) => {
  isolateGitConfig(t, { name: 'Ada', email: 'ada@example.com' });
  const lib = tempLibrary(t);
  await lib.git.run(lib.library, ['init', '-q']);
  const layer = new GitLayer({
    git: lib.git, library: lib.library, settings: resolveSettings({}, () => {}),
    attributesFile: path.join(tempDir(t), 'attributes'),
    textconv: { command: 'unused' }, log: () => {},
  });
  t.after(async () => { layer.stop(); await layer.drained(); });
  await layer.open();
  await layer.keepHistory();
  const { PageStore } = await import('../../src/hoard/pages/store.ts');
  const store = new PageStore({ library: () => lib.library, layer, log: () => {} });
  const marks = new MarkStore({ library: () => lib.library, head: () => layer.head(), wrote: (n) => layer.wrote(n), log: () => {} });
  const ripple = new Ripple({ library: () => lib.library, pages: store, marks, ownerOf: (root, id) => ownerOf(root, id), layer, log: () => {} });
  const put = (rel: string, text: string) => lib.write(rel, text);
  put('wiki/Harbour.html', '<p data-block="a1">The harbour wall is made of timber.</p>');
  put('.neo/pages/wiki/Harbour.html.json', JSON.stringify({ version: 1, source: { path: '/v/x.md', name: 'x', sha256: 'a'.repeat(64) }, frontmatter: { type: 'lore' }, imported: AT }));
  put('wiki/Storm.html', `<p data-block="b1">${STORM}</p>`);
  await layer.commitNow('import-author');
  await ripple.run();
  const [job] = ((await ripple.ask({ page: 'wiki/Storm.html' })), ripple.overview().jobs);
  writeFileSync(job!.answer, answer([{ kind: 'claim', target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone', reason: 'r', quote: 'It was rebuilt in stone the next spring' }]));
  await ripple.run();
  put('book-fox-1/chapters/c1.html', '<p>Pending words.</p>');
  await ripple.decide(ripple.overview().proposals[0]!.id, 'apply');
  await layer.drained();
  const history = await gitLog(lib.git, lib.library, '%an|%(trailers:key=Neo-Checkpoint,valueonly)');
  assert.deepEqual(history.slice(0, 2).map((l) => l.replace(/\s+$/, '')), ['Librarian|librarian-after', 'Ada|librarian-before']);
  const { stdout } = await lib.git.run(lib.library, ['show', '--name-only', '--format=', 'HEAD']);
  assert.deepEqual(stdout.split('\n').filter(Boolean).sort(), ['.neo/ripple/rulings.jsonl', 'wiki/Harbour.html']);
  assert.equal(readFileSync(path.join(lib.library, 'wiki', 'Harbour.html'), 'utf8'), '<p data-block="a1">The harbour wall is rebuilt in stone.</p>');
  // the librarian's commit of the page is no change of the author's: the run after it makes
  // no hop-0 job, only the packet for the hop-1 job the apply opened
  const after = await ripple.run();
  assert.deepEqual([after.made, after.packeted], [0, 1]);
  const jobs = readFileSync(path.join(lib.library, '.neo', 'ripple', 'rulings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.type === 'job');
  const latest = new Map(jobs.map((j) => [j.id, j]));
  assert.deepEqual([...latest.values()].map((j) => [j.source.page, j.hop, j.origin]), [['wiki/Storm.html', 0, 'asked'], ['wiki/Harbour.html', 1, 'ripple']]);
});
