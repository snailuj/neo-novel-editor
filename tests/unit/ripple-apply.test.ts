// Rules for applying a ripple proposal (ripple/apply.ts):
// - a claim on the librarian's words writes over them, keeping the paragraph's id and
//   the formatting around them; on the author's page, or on words blame gives the
//   author, it is a suggestion, and words with formatting inside are a suggestion too;
// - a topic adds its line to the librarian's page, and comments it on the author's;
// - a mint is a new page, unless a page or alias holds the title;
// - a quote not in the source, a page that is not there, and anchor words gone or found
//   twice defer, with why;
// - run again, each finds its own change there and says done.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import type { BlameLine } from '../../src/hoard/git/blame.ts';
import { escapeText, plan, replaceInner, type PlanInput } from '../../src/hoard/ripple/apply.ts';
import type { PageLibrary, RipplePage } from '../../src/hoard/ripple/library.ts';
import type { RippleProposal } from '../../src/hoard/ripple/rulings.ts';

const AT = '2026-10-16T12:00:00.000Z';
const SOURCE = 'The harbour wall was rebuilt in stone after the long storm. The [[Lighthouse]] keeper moved inland.';
const page = (id: string, owner: 'author' | 'librarian', aliases: string[] = []): RipplePage => ({
  id, tree: id.startsWith('wiki/') ? 'wiki' : 'sources', title: id.slice(id.lastIndexOf('/') + 1).replace(/\.html$/, ''), aliases, owner, text: '',
});
const library: PageLibrary = {
  pages: [page('wiki/Harbour.html', 'librarian', ['The Harbour']), page('wiki/Lighthouse.html', 'author'), page('wiki/New Quay.html', 'librarian'), page('sources/Harbour.html', 'author'), page('sources/Notes/Tide Table.html', 'author')],
};
const files: Record<string, string> = {
  'wiki/Harbour.html': '<p class="wiki-h1" data-block="a1">Harbour</p><p data-block="a2">The harbour wall is made of timber.</p><p data-block="a3">Boats come in at high water.</p>',
  'wiki/Lighthouse.html': '<p data-block="b1">The keeper lives in the tower.</p>',
  'wiki/New Quay.html': '<p data-block="c1">The <em>old</em> quay, of timber, by the mill.</p>',
  'sources/Harbour.html': '<p data-block="d1">Field notes: the harbour wall is made of timber.</p>',
  'sources/Notes/Tide Table.html': '<p data-block="e1">High water at noon.</p>',
};
const proposal = (fields: Partial<RippleProposal>): RippleProposal => ({
  version: 1, type: 'proposal', id: 'r-000000000001', at: AT, job: 'j-000000000001', kind: 'claim', status: 'proposed', hop: 0,
  source: { page: 'sources/Dawn.html', title: 'Chapter One' }, reason: 'The wall was rebuilt.', quote: 'rebuilt in stone after the long storm', ...fields,
});
const input = (p: RippleProposal, o: { html?: Record<string, string>; blame?: BlameLine[]; marks?: Mark[]; origin?: string } = {}): PlanInput => ({
  proposal: p, library, source: SOURCE,
  html: async (pg) => (o.html ?? files)[pg.id] ?? null,
  blame: async () => o.blame ?? [],
  marks: async () => o.marks ?? [],
  origin: () => o.origin ?? null,
  newBlockId: () => 'z9',
});
const line = (who: BlameLine['who']): BlameLine => ({ html: '', commit: 'c'.repeat(40), author: '', email: '', time: 0, who });

test('a claim on the librarian\'s words writes over them in place', async () => {
  const made = await plan(input(proposal({ target: 'The Harbour', anchor: 'made of timber', text: 'rebuilt in *stone*' })));
  assert.equal(made.type, 'write');
  if (made.type !== 'write') return;
  assert.equal(made.page.id, 'wiki/Harbour.html', 'the wiki page wins the title the source also holds');
  assert.equal(made.before, files['wiki/Harbour.html'], 'the write is checked against the bytes the plan read');
  assert.equal(made.html, files['wiki/Harbour.html']!.replace('made of timber', 'rebuilt in <i>stone</i>'));
  assert.match(made.html, /data-block="a2"/, 'the paragraph keeps its id');
});

test('a claim on the author\'s words is a suggestion, by page or by blame', async () => {
  const byPage = await plan(input(proposal({ target: 'Lighthouse', anchor: 'lives in the tower', text: 'moved inland' })));
  assert.equal(byPage.type, 'mark');
  if (byPage.type !== 'mark') return;
  assert.equal(byPage.outcome, 'suggested');
  assert.equal(byPage.mark.kind, 'substitution');
  assert.equal(byPage.mark.proposed, 'moved inland');
  assert.equal(byPage.mark.anchor.exact, 'lives in the tower');
  assert.match(byPage.mark.body, /^From \[\[Chapter One\]\]: The wall was rebuilt\./);

  const byBlame = await plan(input(proposal({ target: 'Harbour', anchor: 'made of timber', text: '' }), { blame: [line('librarian'), line('author'), line('librarian')] }));
  assert.equal(byBlame.type, 'mark');
  if (byBlame.type === 'mark') assert.equal(byBlame.mark.kind, 'deletion');
  const uncommitted = await plan(input(proposal({ target: 'Harbour', anchor: 'made of timber', text: 'stone' }), { blame: [line('librarian'), line('uncommitted')] }));
  assert.equal(uncommitted.type, 'mark', 'words not yet committed may be the author\'s');
});

test('a claim or topic on a page under sources/ is a mark, never a write', async () => {
  const claim = await plan(input(proposal({ target: 'sources/Harbour.html', anchor: 'made of timber', text: 'rebuilt in stone' })));
  assert.equal(claim.type, 'mark');
  if (claim.type === 'mark') assert.deepEqual([claim.page.id, claim.outcome, claim.mark.kind, claim.mark.proposed], ['sources/Harbour.html', 'suggested', 'substitution', 'rebuilt in stone']);
  const topic = await plan(input(proposal({ kind: 'topic', target: 'Tide Table', line: 'High water follows the [[Harbour]] wall.', quote: 'The Lighthouse keeper moved inland' })));
  assert.equal(topic.type, 'mark');
  if (topic.type === 'mark') assert.deepEqual([topic.page.id, topic.outcome, topic.mark.kind], ['sources/Notes/Tide Table.html', 'commented', 'comment']);
});

test('a claim across formatting waits as a suggestion', async () => {
  const made = await plan(input(proposal({ target: 'New Quay', anchor: 'old quay, of timber', text: 'new quay, of stone' })));
  assert.equal(made.type, 'mark');
  if (made.type === 'mark') assert.match(made.delta ?? '', /formatting/);
});

test('a claim defers when its words are gone, doubled, or its quote is not the source\'s', async () => {
  const why = async (p: Partial<RippleProposal>, html?: Record<string, string>) => {
    const made = await plan(input(proposal(p), { html }));
    assert.equal(made.type, 'defer', JSON.stringify(made));
    return made.type === 'defer' ? made.delta : '';
  };
  assert.match(await why({ target: 'Nowhere', anchor: 'x', text: 'y' }), /No page is called/);
  assert.match(await why({ target: 'Harbour', anchor: 'made of brick', text: 'y' }), /no longer on the page/);
  assert.match(await why({ target: 'Harbour', anchor: 'the', text: 'y' }, { 'wiki/Harbour.html': '<p>the the</p>' }), /more than once/);
  assert.match(await why({ target: 'Harbour', anchor: 'made of timber', text: 'stone', quote: 'rebuilt in brick after the storm' }), /quote is not in the source/);
});

test('a claim already carried out says done', async () => {
  const written = await plan(input(proposal({ target: 'Harbour', anchor: 'made of timber', text: 'rebuilt in stone' }), { html: { 'wiki/Harbour.html': '<p>The harbour wall is rebuilt in stone.</p>' } }));
  assert.equal(written.type, 'done');
  const mark = { created: { who: 'librarian' }, state: 'open', anchor: { exact: 'lives in the tower' }, proposed: 'moved inland', thread: [] } as unknown as Mark;
  const suggested = await plan(input(proposal({ target: 'Lighthouse', anchor: 'lives in the tower', text: 'moved inland' }), { marks: [mark] }));
  assert.deepEqual([suggested.type, suggested.type === 'done' && suggested.outcome], ['done', 'suggested']);
});

test('a topic adds its line to the librarian\'s page and comments it on the author\'s', async () => {
  const added = await plan(input(proposal({ kind: 'topic', target: 'Harbour', line: 'See [[Lighthouse]] & the wall.', quote: 'The Lighthouse keeper moved inland' })));
  assert.equal(added.type, 'write');
  if (added.type === 'write') assert.equal(added.html, `${files['wiki/Harbour.html']}<p data-block="z9">See [[Lighthouse]] &amp; the wall.</p>`);

  const commented = await plan(input(proposal({ kind: 'topic', target: 'Lighthouse', line: 'The keeper moved inland.', quote: 'The Lighthouse keeper moved inland' })));
  assert.equal(commented.type, 'mark');
  if (commented.type !== 'mark') return;
  assert.equal(commented.mark.kind, 'comment');
  assert.equal(commented.mark.anchor.exact, 'The keeper lives in the tower.');
  assert.match(commented.mark.body, /“The keeper moved inland\.”/);

  const there = await plan(input(proposal({ kind: 'topic', target: 'Harbour', line: 'Boats come in at *high water*.', quote: 'The Lighthouse keeper moved inland' })));
  assert.equal(there.type, 'done', 'the line is on the page already, emphasis aside');
  const empty = await plan(input(proposal({ kind: 'topic', target: 'Harbour', line: 'A line.', quote: 'The Lighthouse keeper moved inland' }), { html: { 'wiki/Harbour.html': '<p><br></p>' } }));
  assert.equal(empty.type === 'write' && empty.html, '<p data-block="z9">A line.</p>', 'an empty page\'s break gives way');
});

test('a mint is a new page unless the title is taken', async () => {
  const made = await plan(input(proposal({ kind: 'mint', target: 'Storm Year', text: 'The long storm.\n\nThe wall fell\nand was rebuilt.', quote: 'after the long storm' })));
  assert.deepEqual(made, { type: 'mint', title: 'Storm Year', paragraphs: ['The long storm.', 'The wall fell and was rebuilt.'], origin: 'ripple:r-000000000001', outcome: 'minted' });
  const taken = await plan(input(proposal({ kind: 'mint', target: 'the harbour', text: 't', quote: 'after the long storm' })));
  assert.equal(taken.type, 'defer', 'an alias holds the title');
  const again = await plan(input(proposal({ kind: 'mint', target: 'Harbour', text: 't', quote: 'after the long storm' }), { origin: 'ripple:r-000000000001' }));
  assert.equal(again.type, 'done', 'the page this proposal minted');
});

test('a mint whose title would make a folder is deferred', async () => {
  const made = await plan(input(proposal({ kind: 'mint', target: 'Wind/Rain', text: 't', quote: 'after the long storm' })));
  assert.deepEqual([made.type, made.type === 'defer' && /slash/.test(made.delta)], ['defer', true]);
});

test('text is escaped as NEO writes it, and a paragraph\'s inside is replaced alone', () => {
  assert.equal(escapeText('a & b < c d'), 'a &amp; b &lt; c&nbsp;d');
  assert.equal(replaceInner('<p data-block="x">one</p><p class="k">two</p>', 1, 'three'), '<p data-block="x">one</p><p class="k">three</p>');
});
