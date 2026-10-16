// The ripple shortlist spike: ways to pick the pages a judge sees for one source, and
// the hand-reading sheet that compares them. Fixtures are synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  blend, buildCorpus, card, chunks, embeddingRank, inRoster, lexicalRank, packetChars, rosterChars, rosterRank,
  type Embed, type Source,
} from '../../src/hoard/ripple/shortlist.ts';
import { buildSheet, pastTargets, pickSources, readSheet, scoreSheet, withUnions, type Key } from '../../src/hoard/ripple/sheet.ts';
import { readSnapshot } from '../../src/hoard/ripple/snapshot.ts';
import { isolateGitConfig, tempDir } from './git-support.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const fixtures = path.join(root, 'tests/fixtures/ripple');
const vault = path.join(fixtures, 'vault');

function readTree(dir: string, rel = ''): [string, string][] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? readTree(dir, child) : [[child, readFileSync(path.join(dir, child), 'utf8')] as [string, string]];
  });
}

const notes = readTree(vault);
const corpus = buildCorpus(notes);
const sourceRel = 'sources/Tide-Ledger.md';
const source: Source = { relpath: sourceRel, text: readFileSync(path.join(vault, sourceRel), 'utf8') };

test('the roster holds the four zones only, never the inbox, a deprecated folder or a dot folder', () => {
  assert.ok(inRoster('lore/Wren-Calder.md'));
  assert.ok(inRoster('sources/a/b.md'));
  assert.ok(!inRoster('inbox/Loose-Note.md'));
  assert.ok(!inRoster('lore/_deprecated/Old-Wren.md'));
  assert.ok(!inRoster('lore/.trash/x.md'));
  assert.ok(!inRoster('lore/x.canvas'));
  const names = corpus.docs.map((d) => d.relpath);
  assert.ok(names.includes('lore/Brine-Works.md'), 'baseline: the corpus was read');
  assert.ok(!names.some((n) => n.startsWith('inbox/') || n.includes('_deprecated')));
});

// Rule: every page the source names or links to, or that links to it, comes before any
// page that is none of those, and the source is never its own candidate.
test('the roster order puts every named or linked page before the rest', () => {
  const ranked = rosterRank(corpus, source).map((r) => r.relpath);
  const near = ['lore/Wren-Calder.md', 'lore/Harbour-Light.md', 'lore/Kelp-Tithe.md', 'writing/Chapter-One.md'];
  for (const n of near) assert.ok(ranked.includes(n), `${n} is ranked`);
  const lastNear = Math.max(...near.map((n) => ranked.indexOf(n)));
  const others = ranked.filter((n) => !near.includes(n));
  assert.ok(others.length > 0, 'baseline: some pages are neither named nor linked');
  for (const o of others) assert.ok(ranked.indexOf(o) > lastNear, `${o} comes after every near page`);
  assert.ok(!ranked.includes(sourceRel));
});

test('a page two links away ranks above one the source cannot reach', () => {
  const ranked = rosterRank(corpus, source);
  const gull = ranked.findIndex((r) => r.relpath === 'lore/Gull-Rock.md');
  const mill = ranked.findIndex((r) => r.relpath === 'lore/Old-Mill.md');
  assert.ok(gull >= 0 && mill >= 0);
  assert.ok(gull < mill);
  assert.equal(ranked[gull]!.why, 'hop 2');
});

test('a name inside inline code or a fence is not a mention', () => {
  const ranked = rosterRank(corpus, source);
  assert.equal(ranked.find((r) => r.relpath === 'lore/Old-Mill.md')!.why, '');
  const fenced: Source = { relpath: 'sources/X.md', text: '```\nWren Calder\n```\n' };
  assert.notEqual(rosterRank(corpus, fenced).find((r) => r.relpath === 'lore/Wren-Calder.md')!.why, 'named');
  const plain: Source = { relpath: 'sources/X.md', text: 'Wren was there.' };
  assert.equal(rosterRank(corpus, plain).find((r) => r.relpath === 'lore/Wren-Calder.md')!.why, 'named', 'an alias names its page');
});

test('chunks are paragraphs, none longer than the cap, and nothing is lost', () => {
  const long = `${'word '.repeat(400)}\n\nShort one.\n\n\`\`\`\ncode\n\n\`\`\``;
  const cs = chunks(long, 300);
  assert.ok(cs.length > 2);
  for (const c of cs) assert.ok(c.length <= 300, `chunk of ${c.length}`);
  assert.equal(cs.join(' ').replace(/\s+/g, ' ').trim(), long.replace(/\s+/g, ' ').trim());
});

// Rule: a page sharing the source's rare words outranks one sharing none, whatever links say.
test('lexical ranking finds the page that shares the source\'s words, and quotes the passage', () => {
  const ranked = lexicalRank(corpus, source);
  const brine = ranked.findIndex((r) => r.relpath === 'lore/Brine-Works.md');
  const era = ranked.findIndex((r) => r.relpath === 'projects/Saltmere-Era.md');
  assert.ok(brine >= 0);
  assert.ok(era === -1 || brine < era);
  assert.match(ranked[brine]!.passage ?? '', /kilns/);
  assert.ok(!ranked.some((r) => r.relpath === sourceRel));
});

// A fake model: a page is near the source when it shares letters. Enough to test the
// plumbing, which is all the container can test.
const letters: Embed = async (texts) => texts.map((t) => {
  const v = new Array<number>(26).fill(0);
  for (const ch of t.toLowerCase()) { const i = ch.charCodeAt(0) - 97; if (i >= 0 && i < 26) v[i]! += 1; }
  return v;
});

test('embedding ranking scores each page by its closest chunk, asking for query and document roles', async () => {
  const roles: string[] = [];
  const spy: Embed = async (texts, role) => { roles.push(role); return letters(texts, role); };
  const twin: Source = { relpath: 'sources/T.md', text: 'The harbour light stands on the breakwater and is lit at dusk.' };
  const ranked = await embeddingRank(corpus, twin, spy);
  assert.equal(ranked[0]!.relpath, 'lore/Harbour-Light.md');
  assert.ok(ranked[0]!.score > ranked.at(-1)!.score);
  assert.deepEqual([...new Set(roles)].sort(), ['document', 'query']);
});

// EmbeddingGemma's document prefix carries the page's title, so each chunk goes in with
// the name of the page it came from, and the source's chunks with none.
test('embedding ranking hands each document chunk its page name as a title', async () => {
  const seen: { role: string; texts: string[]; titles?: string[] }[] = [];
  const spy: Embed = async (texts, role, titles) => { seen.push({ role, texts, titles }); return letters(texts, role); };
  const twin: Source = { relpath: 'sources/T.md', text: 'The harbour light stands on the breakwater and is lit at dusk.' };
  await embeddingRank(corpus, twin, spy);
  const docs = seen.find((s) => s.role === 'document')!;
  assert.equal(docs.titles?.length, docs.texts.length);
  const at = docs.texts.findIndex((t) => /breakwater/i.test(t));
  assert.ok(at >= 0, 'baseline: a chunk of Harbour-Light is embedded');
  assert.equal(docs.titles![at], 'Harbour-Light');
  assert.equal(seen.find((s) => s.role === 'query')!.titles, undefined);
});

// Rule: the blend never drops a page the source names or links directly, however low the
// filler ranks it, and holds no page twice.
test('the blend keeps every named and hop-1 page first, then fills to k without repeats', () => {
  const roster = rosterRank(corpus, source);
  const fill = [...roster].reverse();
  const k = 6;
  const b = blend(roster, fill, k).map((r) => r.relpath);
  const direct = roster.filter((r) => r.why === 'named' || r.why === 'hop 1').map((r) => r.relpath);
  assert.ok(direct.length >= 3, 'baseline: the source has direct neighbours');
  assert.deepEqual(b.slice(0, direct.length).sort(), [...direct].sort());
  assert.equal(b.length, k);
  assert.equal(new Set(b).size, b.length);
});

test('a card is bounded, and a shortlist packet is smaller than the whole roster\'s', () => {
  const doc = corpus.byRel.get('lore/Brine-Works.md')!;
  const c = card(doc, { relpath: doc.relpath, score: 1, why: 'named', passage: 'x'.repeat(900) });
  assert.ok(c.length <= 600, `card of ${c.length}`);
  assert.ok(c.includes('Brine-Works'));
  const cards = rosterRank(corpus, source).slice(0, 3).map((r) => card(corpus.byRel.get(r.relpath)!, r));
  assert.ok(packetChars(cards, source.text.length, 1000) < packetChars([], source.text.length, 1000) + rosterChars(corpus, source) || cards.length === 0);
  assert.ok(rosterChars(corpus, source) > 0);
});

test('past targets are the applied, hop-0 proposals of a source, newest record per id', () => {
  const log = readFileSync(path.join(fixtures, 'RIPPLE.jsonl'), 'utf8');
  assert.deepEqual(pastTargets(log, sourceRel).sort(), ['brine-works', 'wren-calder']);
  assert.deepEqual(pickSources(log, 1), ['sources/Tide-Ledger.md']);
  assert.ok(!pickSources(log, 5, ['sources/Tide-Ledger.md']).includes('sources/Tide-Ledger.md'));
  assert.throws(() => pastTargets('{"id":"a"}\nnot json\n', sourceRel), /line 2/);
});

// Rule: the sheet never says which method put a page there, and asks about each page once.
test('the sheet lists each candidate once, by name, and the key says which lists held it', () => {
  const roster = rosterRank(corpus, source);
  const lists = [
    { method: 'roster', ranked: roster.slice(0, 4) },
    { method: 'lexical', ranked: lexicalRank(corpus, source).slice(0, 4) },
  ];
  const union = new Set(lists.flatMap((l) => l.ranked.map((r) => r.relpath)));
  assert.ok(union.size < 8, 'baseline: the two lists overlap');
  const { sheet, key } = buildSheet([{ source: sourceRel, corpus, lists, pastTargets: ['wren-calder'], rosterChars: 9999, briefChars: 100, sourceChars: 50 }]);
  assert.doesNotMatch(sheet, /roster|lexical|embedding|blend|named|hop \d/i);
  const rows = sheet.split('\n').filter((l) => l.startsWith('- [ ] '));
  assert.equal(rows.length, union.size);
  for (const rel of union) assert.equal(rows.filter((r) => r.includes(`(${rel})`)).length, 1, rel);
  const names = rows.map((r) => /\[\[([^\]]*)\]\]/.exec(r)![1]!);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'rows are in name order, not list order');
  assert.deepEqual(key.cases[0]!.lists.map((l) => l.method), ['roster', 'lexical']);
  assert.deepEqual(key.cases[0]!.lists[0]!.pages, lists[0]!.ranked.map((r) => r.relpath));
  assert.equal(key.cases[0]!.lists.find((l) => l.method === 'roster')!.pastCaught, 1);
});

// Rule: a method scores by the author's ticks alone: the share of ticked pages its list
// held, and the share of its list that was ticked.
test('scoring reads the ticks back against each list', () => {
  const lists = [
    { method: 'roster', ranked: rosterRank(corpus, source).slice(0, 4) },
    { method: 'lexical', ranked: lexicalRank(corpus, source).slice(0, 4) },
  ];
  const { sheet, key } = buildSheet([{ source: sourceRel, corpus, lists, pastTargets: [], rosterChars: 1, briefChars: 1, sourceChars: 1 }]);
  const ticked = sheet.replace('- [ ] [[Brine-Works]]', '- [x] [[Brine-Works]]').replace('- [ ] [[Wren-Calder]]', '- [X] [[Wren-Calder]]');
  assert.notEqual(ticked, sheet, 'baseline: the ticks landed');
  const score = scoreSheet(ticked, key);
  const by = Object.fromEntries(score.cases[0]!.lists.map((l) => [l.method, l]));
  assert.equal(score.cases[0]!.ticked, 2);
  assert.equal(by['lexical']!.caught, lists[1]!.ranked.filter((r) => ['lore/Brine-Works.md', 'lore/Wren-Calder.md'].includes(r.relpath)).length);
  assert.equal(by['roster']!.caught, 1, 'the roster list holds Wren-Calder, not Brine-Works');
  assert.equal(by['roster']!.recall, 0.5);
  assert.equal(by['roster']!.precision, 0.25);
  assert.equal(score.totals.find((t) => t.method === 'roster')!.caught, 1);
  assert.throws(() => scoreSheet('# nothing\n', key), /case/);
});

// Rule: a tick counts for the page on its row whatever characters the page's path holds,
// and a list scored against another run's sheet says how many of its pages were never read.
test('scoring reads a path with brackets, aligns cases by source, and counts pages the sheet never showed', () => {
  const key: Key = { note: '', cases: [{
    source: sourceRel, pastTargets: [], wholeRosterPacketChars: 1,
    lists: [{ method: 'm', pages: ['projects/Saltmere-(era).md', 'lore/Wren-Calder.md', 'lore/Unshown.md'], packetChars: 1, pastCaught: 0 }],
  }] };
  const sheet = `## Case 1: ${sourceRel}\n\n- [x] [[Saltmere-(era)]] (projects/Saltmere-(era).md): An era (the first).\n- [x] [[Wren-Calder]] (lore/Wren-Calder.md): \n`;
  const l = scoreSheet(sheet, key).cases[0]!.lists[0]!;
  assert.equal(l.caught, 2);
  assert.equal(l.unrated, 1);
  assert.throws(() => scoreSheet('## Case 1: sources/Other.md\n', key), /sources\/Other\.md/);
  const renamed = sheet.replace(`## Case 1: ${sourceRel}`, '## Case 1: [[Tide-Ledger]]');
  assert.notEqual(renamed, sheet, 'baseline: the heading changed');
  assert.equal(scoreSheet(renamed, key).cases[0]!.lists[0]!.caught, 2, 'a heading may name the source as a link');
});

// Rule: a top-up sheet shows only pages no earlier sheet showed for the case, and the two
// sheets' ticks score as one.
test('a top-up sheet leaves out pages already shown, and scores together with the first', () => {
  const roster = rosterRank(corpus, source);
  const mk = (n: number, seen?: Map<string, Set<string>>) => buildSheet([{
    source: sourceRel, corpus, lists: [{ method: 'roster', ranked: roster.slice(0, n) }], pastTargets: [],
    rosterChars: 1, briefChars: 0, sourceChars: 1,
  }], seen);
  const first = mk(2);
  const top = mk(4, new Map([...readSheet(first.sheet).sections].map(([id, sec]) => [id, sec.shown])));
  const firstRows = [...readSheet(first.sheet).sections.values()][0]!.shown;
  const topRows = [...readSheet(top.sheet).sections.values()][0]!.shown;
  assert.equal(firstRows.size, 2);
  assert.equal(topRows.size, 2, 'only the two pages the first sheet lacked');
  assert.ok([...topRows].every((r) => !firstRows.has(r)));
  const tickAll = (sheet: string) => sheet.replaceAll('- [ ] ', '- [x] ');
  const l = scoreSheet(`${tickAll(first.sheet)}\n${tickAll(top.sheet)}`, top.key).cases[0]!.lists[0]!;
  assert.equal(l.caught, 4);
  assert.equal(l.unrated, 0);
});

// Rule: a union keeps the whole roster list and adds the first pages of another list
// it lacks, so its score needs no ticks beyond the sheet's: every page was shown.
test('a union adds another list\'s first pages the roster lacks, and leaves blends alone', () => {
  const key: Key = { note: '', cases: [{
    source: sourceRel, pastTargets: [], wholeRosterPacketChars: 1,
    lists: [
      { method: 'roster', pages: ['a.md', 'b.md'], packetChars: 1000, pastCaught: 0 },
      { method: 'embedding m', pages: ['b.md', 'c.md', 'd.md', 'e.md'], packetChars: 1000, pastCaught: 0 },
      { method: 'blend m', pages: ['a.md', 'c.md'], packetChars: 1000, pastCaught: 0 },
    ],
  }] };
  const lists = withUnions(key, 2).cases[0]!.lists;
  const union = lists.find((l) => l.method === 'roster + 2 embedding m')!;
  assert.deepEqual(union.pages, ['a.md', 'b.md', 'c.md', 'd.md']);
  assert.equal(union.packetChars, 2000);
  assert.ok(!lists.some((l) => l.method.includes('blend m') && l.method.startsWith('roster +')));
  assert.equal(key.cases[0]!.lists.length, 3, 'the key itself is unchanged');
});

// Rule: a case is read as the vault stood before its source came in, so a link the
// ripple wrote afterwards cannot make its own target look near.
test('a git snapshot reads the corpus at the parent of the commit that added the source', (t) => {
  isolateGitConfig(t, { name: 'Test', email: 'test@example.invalid' });
  const repo = tempDir(t, 'ripple-snap-');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(path.join(repo, 'lore'));
  mkdirSync(path.join(repo, 'sources'));
  writeFileSync(path.join(repo, 'lore/Net-Loft.md'), 'Nets dry here.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  // Hoard's ingest commits the source with its ripple, so the target changed in that commit.
  writeFileSync(path.join(repo, 'sources/Gale-Log.md'), 'The gale tore the nets.\n');
  writeFileSync(path.join(repo, 'lore/Net-Loft.md'), 'Nets dry here. See [[Gale-Log]].\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'ingest and ripple');
  writeFileSync(path.join(repo, 'sources/Gale-Log.md'), 'The gale tore the nets, twice.\n');
  git('commit', '-q', '-am', 'later edit');
  const snap = readSnapshot(repo, 'sources/Gale-Log.md');
  assert.equal(snap.source.text, 'The gale tore the nets.\n');
  assert.deepEqual(snap.notes, [['lore/Net-Loft.md', 'Nets dry here.\n']]);
  assert.match(snap.before ?? '', /^[0-9a-f]{40}$/);
  assert.throws(() => readSnapshot(repo, 'sources/Missing.md'), /never added/);
});

test('the command writes a sheet and a key, scores the ticks, and refuses to write inside the vault', (t) => {
  const out = tempDir(t, 'ripple-out-');
  const cli = path.join(root, 'src/hoard/ripple/shortlist-cli.ts');
  const ok = spawnSync(process.execPath, [cli, '--vault', vault, '--out', out, '--source', sourceRel,
    '--rulings', path.join(fixtures, 'RIPPLE.jsonl'), '--k', '4'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(path.join(out, 'sheet.md')));
  const key = JSON.parse(readFileSync(path.join(out, 'key.json'), 'utf8'));
  assert.deepEqual(key.cases[0].lists.map((l: { method: string }) => l.method).sort(), ['blend', 'lexical', 'roster']);
  const sheetFile = path.join(out, 'sheet.md');
  writeFileSync(sheetFile, readFileSync(sheetFile, 'utf8').replace('- [ ] [[Wren-Calder]]', '- [x] [[Wren-Calder]]'));
  const scored = spawnSync(process.execPath, [cli, '--score', out], { encoding: 'utf8' });
  assert.equal(scored.status, 0, scored.stderr);
  assert.match(readFileSync(path.join(out, 'score.md'), 'utf8'), /\| roster \| 1 of 1 \|/);
  // A second run skips the cases an earlier key already holds, so it picks the next source.
  const again = spawnSync(process.execPath, [cli, '--vault', vault, '--out', tempDir(t, 'ripple-out-'), '--pick', '1',
    '--rulings', path.join(fixtures, 'RIPPLE.jsonl'), '--skip-key', path.join(out, 'key.json')], { encoding: 'utf8' });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /no such source: sources\/Other-Log\.md/);
  const noLib = spawnSync(process.execPath, [cli, '--vault', vault, '--out', out, '--source', sourceRel, '--embed', 'some/model'], { encoding: 'utf8' });
  assert.equal(noLib.status, 2);
  assert.match(noLib.stderr, /npm i --no-save @huggingface\/transformers/);
  const bad = spawnSync(process.execPath, [cli, '--vault', vault, '--out', path.join(vault, 'lore'), '--source', sourceRel], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /inside the vault/);
});
