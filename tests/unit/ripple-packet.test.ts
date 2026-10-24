// Ripple's packet and its cards: what the judge reads for one job. Fixtures are synthetic.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderCards } from '../../src/hoard/ripple/cards.ts';
import { buildPacket, type PacketInput } from '../../src/hoard/ripple/packet.ts';
import type { WikiPage } from '../../src/hoard/ripple/pages.ts';
import type { RippleJob } from '../../src/hoard/ripple/rulings.ts';
import { buildCorpus, rosterRank, type Embed } from '../../src/hoard/ripple/shortlist.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../fixtures/ripple');
const vault = path.join(fixtures, 'vault');

function readTree(dir: string, rel = ''): [string, string][] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? readTree(dir, child) : [[child, readFileSync(path.join(dir, child), 'utf8')] as [string, string]];
  });
}

const corpus = buildCorpus(readTree(vault));
const sourceRel = 'sources/Tide-Ledger.md';
const sourceText = readFileSync(path.join(vault, sourceRel), 'utf8');
// Every other page is the librarian's, so both forms of the file line are pinned.
const byPath = new Map<string, WikiPage>(corpus.docs.map((d, i): [string, WikiPage] => [d.relpath, {
  chId: `c${i}`, title: d.name.replace(/-/g, ' '), aliases: d.aliases, owner: i % 2 ? 'author' : 'librarian', rel: `book-w/chapters/c${i}.html`,
}]));
const job = {
  version: 1, type: 'job', id: 'job-t0001', at: '2026-10-16T12:00:00.000Z', state: 'packeted', origin: 'imported',
  source: { bookId: 'book-w', chId: 'c99', title: 'Tide Ledger' }, source_hash: 'a'.repeat(64), commit: 'b'.repeat(40), hop: 0,
} as unknown as RippleJob;

const letters: Embed = async (texts) => texts.map((t) => {
  const v = new Array<number>(26).fill(0);
  for (const ch of t.toLowerCase()) { const i = ch.charCodeAt(0) - 97; if (i >= 0 && i < 26) v[i]! += 1; }
  return v;
});

const input = (extra: Partial<PacketInput> = {}): PacketInput => ({
  job, sourceText, sourcePath: sourceRel, corpus, byPath,
  briefFile: '/lib/.neo/ripple/brief.md', inboxFile: '/lib/.neo/ripple/inbox/job-t0001.jsonl', library: '/lib', ...extra,
});

// Rule: with none of the eval's options, the packet is byte for byte what the app wrote
// before they existed, with or without the meaning model.
test('a packet built without the new options is byte-identical to the pinned packet', async () => {
  for (const [name, embed] of [['packet-plain.md', undefined], ['packet-modelled.md', letters]] as const) {
    const packet = await buildPacket(input({ embed }));
    assert.ok(packet.candidates.length > 3, 'baseline: the packet holds candidates');
    assert.equal(packet.text, readFileSync(path.join(fixtures, name), 'utf8'), name);
  }
  // With no candidates the packet ends on the list's opening sentence, as it always did.
  const empty = await buildPacket(input({ corpus: buildCorpus([]) }));
  assert.equal(empty.candidates.length, 0);
  assert.ok(empty.text.endsWith('## Candidates (0)\n\nThe pages the source names or sits near in the links, then pages that share its words. (The meaning model is not set up, so its ten are missing.)\n\n'));
});

const ranked = rosterRank(corpus, { relpath: sourceRel, text: sourceText });
const all = ranked.map((r) => r.relpath);
const fullLines = (text: string) => text.split('\n').filter((l) => /^- \[\[/.test(l));

// Rule: under a budget, the full cards never pass it, and every candidate appears once,
// in rank order, either as a full card or as a locator line, as the counts line says.
test('budgeted cards keep the budget and list every candidate once, in rank order', () => {
  const whole = renderCards(corpus, ranked);
  assert.equal(whole.locator.length, 0, 'baseline: with no budget every card is full');
  assert.ok(whole.fullChars > 100);
  let mixed = 0;
  for (let budget = 0; budget <= whole.fullChars + 20; budget += 7) {
    const c = renderCards(corpus, ranked, { budgetChars: budget });
    assert.ok(c.fullChars <= budget, `full cards fit ${budget}`);
    assert.deepEqual([...c.full, ...c.locator].sort(), [...all].sort(), 'each candidate once');
    assert.deepEqual(c.full, all.slice(0, c.full.length), 'full cards are the first in rank order');
    const titles = fullLines(c.text).map((l) => /^- \[\[([^\]]+)\]\]/.exec(l)![1]);
    assert.deepEqual(titles, all.map((r) => corpus.byRel.get(r)!.name), 'the text lists them in rank order');
    for (const rel of c.locator) assert.match(c.text, new RegExp(`^- \\[\\[${corpus.byRel.get(rel)!.name}\\]\\][^\\n]* file: ${rel}$`, 'm'));
    assert.match(c.text, new RegExp(`^${c.full.length} in full and ${c.locator.length} by name only\\.`, 'm'));
    if (c.full.length && c.locator.length) mixed++;
  }
  assert.ok(mixed > 2, 'baseline: some budgets split the list');
});

test('a locator line is the title, why and file; a full card keeps its gloss and passage', () => {
  const c = renderCards(corpus, ranked, { budgetChars: 0, pageOf: (rel) => ({ title: `T ${corpus.byRel.get(rel)!.name}`, file: `x/${rel}` }) });
  assert.equal(c.full.length, 0);
  assert.match(c.text, /^- \[\[T Harbour-Light\]\] \(named\) file: x\/lore\/Harbour-Light\.md$/m);
  assert.match(c.text, /^- \[\[T Old-Mill\]\] file: x\/lore\/Old-Mill\.md$/m, 'no why, no brackets');
});

// Rule: a page outside the screened set is a locator whatever the budget.
test('pages outside the full-only set become locators, the rest stay full', () => {
  const keep = new Set([all[1]!, all[4]!]);
  const c = renderCards(corpus, ranked, { fullOnly: keep });
  assert.deepEqual(c.full, [all[1], all[4]]);
  assert.equal(c.locator.length, all.length - 2);
  assert.match(c.text, new RegExp(`^2 in full and ${all.length - 2} by name only\\.`, 'm'));
  const tight = renderCards(corpus, ranked, { fullOnly: keep, budgetChars: 1 });
  assert.equal(tight.full.length, 0, 'the budget still holds');
});

test('a packet with a budget and a map says what is full and gives the map after the candidates', async () => {
  const plain = await buildPacket(input());
  const packet = await buildPacket(input({ budgetChars: 300, map: 'lore/\n- Harbour-Light' }));
  assert.deepEqual(packet.candidates, plain.candidates, 'the same candidates');
  assert.match(packet.text, new RegExp(`^${packet.full.length} in full and ${packet.locator.length} by name only\\.`, 'm'));
  assert.ok(packet.full.length > 0 && packet.locator.length > 0, 'baseline: the budget splits the list');
  assert.equal(packet.full.length + packet.locator.length, packet.candidates.length);
  const cands = packet.text.indexOf('## Candidates');
  const map = packet.text.indexOf('## Wiki map');
  assert.ok(cands > 0 && map > cands, 'the map comes after the candidates');
  assert.match(packet.text.slice(map), /target any page/);
  assert.ok(packet.text.trimEnd().endsWith('- Harbour-Light'));
  assert.ok(!plain.text.includes('## Wiki map'));
});
