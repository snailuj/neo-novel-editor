// Ripple's packet and its cards: what the judge reads for one job. Fixtures are synthetic.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPacket, type PacketInput } from '../../src/hoard/ripple/packet.ts';
import type { WikiPage } from '../../src/hoard/ripple/pages.ts';
import type { RippleJob } from '../../src/hoard/ripple/rulings.ts';
import { buildCorpus, type Embed } from '../../src/hoard/ripple/shortlist.ts';

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
});
