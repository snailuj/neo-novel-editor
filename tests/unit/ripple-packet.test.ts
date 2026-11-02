// Rules for the packet (ripple/packet.ts):
// - every candidate entry names its tree and its file (the page id), and the author's
//   pages in either tree say a claim on them becomes a suggestion;
// - the source is never its own candidate, and a title held in both trees lists both pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { corpusPath, pagesCorpus, type PageLibrary, type RipplePage } from '../../src/hoard/ripple/library.ts';
import { buildPacket } from '../../src/hoard/ripple/packet.ts';
import { jobId, sha256, type RippleJob } from '../../src/hoard/ripple/rulings.ts';

const page = (id: string, owner: 'author' | 'librarian', text: string): RipplePage => ({
  id, tree: id.startsWith('wiki/') ? 'wiki' : 'sources', title: id.slice(id.lastIndexOf('/') + 1).replace(/\.html$/, ''), aliases: [], owner, text,
});
const library: PageLibrary = {
  pages: [
    page('sources/Harbour.html', 'author', 'Field notes on the harbour wall.'),
    page('sources/Notes/Storm.html', 'author', 'The long storm broke the harbour wall.'),
    page('wiki/Harbour.html', 'librarian', 'The harbour wall is made of timber.'),
    page('wiki/People/Keeper.html', 'author', 'The keeper lives by the harbour.'),
  ],
};

test('every candidate entry names its tree and its file, whichever tree it is in', async () => {
  const { corpus, byPath } = pagesCorpus(library);
  const source = library.pages[1]!;
  const source_hash = sha256(source.text);
  const job: RippleJob = {
    version: 1, type: 'job', id: jobId({ page: source.id }, source_hash, 0), at: '2026-11-01T12:00:00.000Z', state: 'open', origin: 'changed',
    source: { page: source.id, title: source.title }, source_hash, commit: null, hop: 0,
  };
  const packet = await buildPacket({
    job, sourceText: source.text, sourcePath: corpusPath(source.id), corpus, byPath,
    briefFile: '/lib/.neo/ripple/brief.md', inboxFile: '/lib/.neo/ripple/inbox/x.jsonl', library: '/lib',
  });
  const entries = packet.text.split('\n').filter((l) => l.startsWith('- [['));
  assert.equal(entries.length, 3, 'every page but the source');
  const body = packet.text.slice(packet.text.indexOf('## Candidates'));
  const entry = (file: string) => body.split(/\n(?=- \[\[)/).find((e) => e.includes(`file: ${file}`));
  assert.match(entry('sources/Harbour.html') ?? '', /\n {2}tree: sources\n {2}file: sources\/Harbour\.html \(the author's page/);
  assert.match(entry('wiki/Harbour.html') ?? '', /\n {2}tree: wiki\n {2}file: wiki\/Harbour\.html\n/);
  assert.match(entry('wiki/People/Keeper.html') ?? '', /\n {2}tree: wiki\n {2}file: wiki\/People\/Keeper\.html \(the author's page/);
  assert.ok(!body.includes('file: sources/Notes/Storm.html'), 'the source is not a candidate');
  assert.equal(packet.candidates.filter((t) => t === 'Harbour').length, 2);
});
