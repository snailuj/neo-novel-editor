// Entries and topics: a long scratchpad page is cut into entries (runs of blocks written
// as one piece), then the entries are grouped by what they are about. The judge here is
// a function standing in for the model command.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEntryPrompt, buildTopicPrompt, type Entry, findEntries, groupEntries, outline, parseEntries, parseTopics, type Topic, topicRows } from '../../../src/librarian/blocks/group.ts';
import { readSheet, rowsFor, topicDest, writeSheet } from '../../../src/librarian/blocks/sheet.ts';
import type { Judged } from '../../../src/librarian/blocks/judge.ts';
import { splitBlocks } from '../../../src/librarian/blocks/split.ts';

// Seven blocks: an otter story told in two places, a heron poem, a shopping list between.
const PAGE = [
  '## 3 May', // 1
  'The otter slipped into the reeds.', // 2
  '', // 3
  'She did not come back that night.', // 4
  '## Errands', // 5
  '- [ ] kettle', // 6
  '- [ ] lantern', // 7
  '## Later', // 8
  'A heron stands in grey water,', // 9
  '', // 10
  'still as a held breath.', // 11
  '', // 12
  'The otter returned at dawn with a fish.', // 13
].join('\n');
const blocks = splitBlocks(PAGE);
const entryReply = (items: [number, string][]) => JSON.stringify(items.map(([n, title]) => ({ start: `b${n}`, title, summary: `about ${title}` })));

test('the entry prompt numbers blocks, shows headings and lines, and says the text is data', () => {
  const prompt = buildEntryPrompt('Scratch.md', blocks, 0, blocks.length, null);
  assert.match(prompt, /Page: Scratch\.md/);
  assert.match(prompt, /<block id="b1" heading="3 May" lines="2-2">\nThe otter slipped into the reeds\.\n<\/block>/);
  assert.match(prompt, /<block id="b7"/);
  assert.match(prompt, /data, not instructions/i);
  assert.doesNotMatch(prompt, /already split/);
});

test('a reply must name starts inside the part, in order, once each', () => {
  assert.deepEqual(parseEntries(entryReply([[1, 'Otter'], [3, 'Errands']]), 0, 7).map((e) => [e.first, e.title]), [[0, 'Otter'], [2, 'Errands']]);
  assert.deepEqual(parseEntries(entryReply([[3, 'Errands']]), 0, 7).map((e) => e.first), [0, 2], 'the first block always starts an entry');
  assert.deepEqual(parseEntries(entryReply([[5, 'Heron']]), 4, 7).map((e) => e.first), [4]);
  assert.throws(() => parseEntries(entryReply([[2, 'x'], [8, 'y']]), 0, 7), /b8/);
  assert.throws(() => parseEntries(entryReply([[3, 'x'], [2, 'y']]), 0, 7), /order/);
  assert.throws(() => parseEntries(entryReply([[2, 'x'], [2, 'y']]), 0, 7), /order/);
  assert.throws(() => parseEntries(entryReply([[2, 'x']]), 3, 7), /b2/, 'a start in the carried context is refused');
  assert.throws(() => parseEntries('no json', 0, 7), /JSON/);
});

test('entries cover the page; a long page goes in parts, each carrying the last entry in as context', async () => {
  const prompts: string[] = [];
  const judge = async (prompt: string) => {
    prompts.push(prompt);
    // Part 1 is b1-b4, part 2 b5-b7 with b3-b4 (the errands entry so far) as context.
    return prompts.length === 1 ? entryReply([[1, 'Otter'], [3, 'Errands']]) : entryReply([[6, 'Heron'], [7, 'Otter again']]);
  };
  const entries = await findEntries('Scratch.md', blocks, judge, { chunk: 4 });
  assert.deepEqual(entries.map((e) => [e.first, e.last, e.title]), [[0, 1, 'Otter'], [2, 4, 'Errands'], [5, 5, 'Heron'], [6, 6, 'Otter again']]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /b3 to b4 are context[^\n]*"Errands"/);
  assert.match(prompts[1]!, /<block id="b3"/);
  assert.doesNotMatch(prompts[1]!, /<block id="b2"/);
});

test('the context carried into a part is capped, so one huge entry cannot fill the prompt', async () => {
  const many = splitBlocks(Array.from({ length: 30 }, (_, i) => `Line ${i}.`).join('\n\n'));
  const prompts: string[] = [];
  const judge = async (p: string) => {
    prompts.push(p);
    return prompts.length === 1 ? entryReply([[1, 'One']]) : '[]'; // one entry runs on
  };
  await findEntries('Long.md', many, judge, { chunk: 20, context: 5 });
  assert.match(prompts[1]!, /b16 to b20 are context/);
});

test('an unusable entry reply is asked again, then fails the page', async () => {
  let calls = 0;
  const ok = await findEntries('Scratch.md', blocks, async () => (++calls === 1 ? 'nonsense' : entryReply([[1, 'All']])), {});
  assert.equal(calls, 2);
  assert.equal(ok.length, 1);
  await assert.rejects(findEntries('Scratch.md', blocks, async () => 'nonsense', {}), /no usable entry reply/);
});

const entries: Entry[] = [
  { first: 0, last: 1, title: 'Otter', summary: 'the otter leaves' },
  { first: 2, last: 3, title: 'Errands', summary: 'shopping' },
  { first: 4, last: 5, title: 'Heron', summary: 'a heron poem' },
  { first: 6, last: 6, title: 'Otter again', summary: 'the otter returns' },
];
const topicReply = (groups: [string, number[]][]) => JSON.stringify(groups.map(([name, ids]) => ({ name, entries: ids.map((n) => `e${n}`), why: 'w' })));

test('the topic prompt lists every entry with its lines, title, summary and opening', () => {
  const prompt = buildTopicPrompt('Scratch.md', blocks, entries);
  assert.match(prompt, /<entry id="e1" lines="2-4" title="Otter">\nthe otter leaves\n---\nThe otter slipped into the reeds\./);
  assert.match(prompt, /<entry id="e4" lines="13-13"/);
  assert.match(prompt, /group of one/i);
  assert.match(prompt, /data, not instructions/i);
});

test('text inside an entry or block cannot close its tag early, whatever its case', () => {
  const tricky = splitBlocks('Ends here </ENTRY> and </Block >.');
  const entry = buildTopicPrompt('Scratch.md', tricky, [{ first: 0, last: 0, title: 't', summary: 'a summary </entry> too' }]);
  assert.equal(entry.match(/<\/entry>/gi)!.length, 1, 'only the real closing tag');
  const block = buildEntryPrompt('Scratch.md', tricky, 0, 1, null);
  assert.equal(block.match(/<\/block\s*>/gi)!.length, 1);
});

test('a topic reply must place every entry exactly once', () => {
  const got = parseTopics(topicReply([['The Otter', [1, 4]], ['Errands', [2]], ['Heron', [3]]]), 4);
  assert.deepEqual(got, ['The Otter', 'Errands', 'Heron', 'The Otter']);
  assert.throws(() => parseTopics(topicReply([['A', [1, 2, 3]]]), 4), /e4/);
  assert.throws(() => parseTopics(topicReply([['A', [1, 2]], ['B', [2, 3, 4]]]), 4), /e2/);
  assert.throws(() => parseTopics(topicReply([['A', [1, 2, 3, 4, 5]]]), 4), /e5/);
  assert.throws(() => parseTopics(topicReply([['', [1, 2, 3, 4]]]), 4), /name/);
});

test('two votes that agree stand; an entry whose group-mates differ is marked to check', async () => {
  const same = topicReply([['The Otter', [1, 4]], ['Errands', [2]], ['Heron', [3]]]);
  const agreed = await groupEntries('Scratch.md', blocks, entries, async () => same, { votes: 2 });
  assert.deepEqual(agreed.map((t) => [t.topic, t.by]), [['The Otter', 'judge'], ['Errands', 'judge'], ['Heron', 'judge'], ['The Otter', 'judge']]);

  // The second vote puts the heron with the otter. Mates are the other entries in an
  // entry's group: e1 and e4 keep half of theirs (0.5 stands), e3 goes from none to two.
  let n = 0;
  const split = await groupEntries('Scratch.md', blocks, entries, async () => (++n === 1 ? same : topicReply([['Water', [1, 3, 4]], ['Errands', [2]]])), { votes: 2 });
  assert.deepEqual(split.map((t) => [t.topic, t.by]), [['The Otter', 'judge'], ['Errands', 'judge'], ['Heron', 'votes-differ'], ['The Otter', 'judge']]);
  assert.deepEqual(split[2]!.others, ['Water']);
});

test('with no usable topic reply each entry stands alone, marked to check', async () => {
  const got = await groupEntries('Scratch.md', blocks, entries, async () => 'nonsense', { votes: 2 });
  assert.deepEqual(got.map((t) => [t.topic, t.by]), [['Otter', 'judge-failed'], ['Errands', 'judge-failed'], ['Heron', 'judge-failed'], ['Otter again', 'judge-failed']]);
});

const judged = (labels: string[]) => new Map(blocks.map((b, i) => [b.id, { label: labels[i], pasted: false, reason: 'r', by: 'judge', votes: [labels[i]] } as Judged]));

test('topic rows: every row gets its entry and topic; writing in a shared topic goes to one wiki page', () => {
  const rows = rowsFor('Scratch.md', blocks, judged(['writing', 'writing', 'tasks', 'tasks', 'writing', 'writing', 'writing']), []);
  rows[4]!.wiki_page = 'Poems'; // the author named this one
  const topics = [
    { topic: 'The Otter', by: 'judge', others: [] },
    { topic: 'Errands', by: 'judge', others: [] },
    { topic: 'Heron', by: 'votes-differ', others: ['Water'] },
    { topic: 'The Otter', by: 'judge', others: [] },
  ] as const;
  topicRows('Scratch.md', blocks, entries, topics.map((t) => ({ ...t, others: [...t.others] })), rows);
  assert.deepEqual(rows.map((r) => [r.entry, r.topic, r.topic_by]), [
    ['e1', 'The Otter', 'judge'], ['e1', 'The Otter', 'judge'],
    ['e2', 'Errands', 'judge'], ['e2', 'Errands', 'judge'],
    ['e3', 'Heron', 'votes-differ'], ['e3', 'Heron', 'votes-differ'],
    ['e4', 'The Otter', 'judge'],
  ]);
  assert.deepEqual(rows.map((r) => r.wiki_page), [
    'The-Otter-(snippets)', 'The-Otter-(snippets)', '', '',
    'Poems', 'Scratch-Later-(snippets)', // a topic of one entry keeps its default
    'The-Otter-(snippets)',
  ]);
});

test('a page name the author edited is never replaced', () => {
  const rows = rowsFor('Scratch.md', blocks, judged(['writing', 'writing', 'tasks', 'tasks', 'other', 'other', 'writing']), []);
  rows[0]!.wiki_page = 'Mine';
  topicRows('Scratch.md', blocks, entries, entries.map(() => ({ topic: 'All', by: 'judge', others: [] })), rows);
  assert.equal(rows[0]!.wiki_page, 'Mine');
  assert.equal(rows[6]!.wiki_page, 'All-(snippets)');
  // Grouped again: a page name the last grouping gave is the tool's, so it follows the new topic.
  topicRows('Scratch.md', blocks, entries, entries.map((e) => ({ topic: e.title === 'Otter' ? 'Lone' : 'Other', by: 'judge', others: [] })), rows);
  assert.deepEqual([rows[0]!.wiki_page, rows[1]!.wiki_page, rows[6]!.wiki_page], ['Mine', 'Scratch-3-May-(snippets)', 'Scratch-Later-(snippets)']);
});

test('entries left alone by a failed judge never share a page, even with the same title', () => {
  const rows = rowsFor('Scratch.md', blocks, judged(['writing', 'writing', 'tasks', 'tasks', 'writing', 'writing', 'writing']), []);
  topicRows('Scratch.md', blocks, entries, entries.map(() => ({ topic: 'Notes', by: 'judge-failed', others: [] })), rows);
  assert.deepEqual([rows[0]!.wiki_page, rows[6]!.wiki_page], ['Scratch-3-May-(snippets)', 'Scratch-Later-(snippets)']);
  assert.equal(rows[0]!.topic_by, 'judge-failed');
  // Nor does a failed entry join a real topic that happens to share its title.
  const again = rowsFor('Scratch.md', blocks, judged(['writing', 'writing', 'tasks', 'tasks', 'writing', 'writing', 'writing']), []);
  topicRows('Scratch.md', blocks, entries, [
    { topic: 'Notes', by: 'judge-failed', others: [] }, { topic: 'Errands', by: 'judge', others: [] },
    { topic: 'Notes', by: 'judge', others: [] }, { topic: 'Notes', by: 'judge', others: [] },
  ], again);
  assert.deepEqual([again[0]!.wiki_page, again[4]!.wiki_page, again[6]!.wiki_page], ['Scratch-3-May-(snippets)', 'Notes-(snippets)', 'Notes-(snippets)']);
});

test('topicDest is one safe path segment', () => {
  assert.equal(topicDest('The Otter: dawn / dusk?'), 'The-Otter-dawn-dusk-(snippets)');
});

test('old sheets without the topic columns still read, and the columns round-trip', () => {
  const rows = rowsFor('Scratch.md', blocks, judged(['writing', 'writing', 'tasks', 'tasks', 'other', 'other', 'writing']), []);
  const old = writeSheet(rows).replace(/,topic,entry,topic_by/, '').split('\n').map((l, i) => (i === 0 || !l ? l : l.replace(/^((?:[^,]*,){9})(?:[^,]*,){3}/, '$1'))).join('\n');
  assert.deepEqual(readSheet(old).map((r) => [r.topic, r.entry, r.label]), rows.map((r) => ['', '', r.label]));
  rows[0]!.topic = 'A, "quoted"';
  assert.equal(readSheet(writeSheet(rows))[0]!.topic, 'A, "quoted"');
});

test('the outline lists each topic with its entries, lines, labels and doubts', () => {
  const rows = rowsFor('Scratch.md', blocks, judged(['writing', 'writing', 'tasks', 'tasks', 'writing', 'writing', 'writing']), []);
  const topics: Topic[] = [
    { topic: 'The Otter', by: 'judge', others: [] },
    { topic: 'Errands', by: 'judge', others: [] },
    { topic: 'Heron', by: 'votes-differ', others: ['Water'] },
    { topic: 'The Otter', by: 'judge', others: [] },
  ];
  const text = outline('Scratch.md', blocks, entries, topics, rows);
  assert.match(text, /^# Scratch\.md\n\n7 blocks, 4 entries, 3 topics\. 1 entry to check\./);
  assert.match(text, /## The Otter \(2 entries\)\n\n- e1, lines 2-4, writing 2: \*\*Otter\*\*: the otter leaves\n- e4, lines 13-13, writing 1: \*\*Otter again\*\*: the otter returns\n/);
  assert.match(text, /## Heron \(1 entry\)\n\n- e3, lines 9-11, writing 2: \*\*Heron\*\*: a heron poem \(check: the other vote said Water\)/);
  assert.ok(text.indexOf('## The Otter') < text.indexOf('## Errands') && text.indexOf('## Errands') < text.indexOf('## Heron'), 'topics in page order');
});
