// Labelling blocks: the structural rules, and the judge's prompt, reply check, retries
// and votes. The judge here is a function standing in for the model command.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPrompt, commandJudge, judgePage, parseReply } from '../../../src/librarian/blocks/judge.ts';
import { fallbackGuess, ruleLabel } from '../../../src/librarian/blocks/rules.ts';
import { splitBlocks } from '../../../src/librarian/blocks/split.ts';
import { type LogRecord, setLogSink } from '../../../src/librarian/log.ts';

const PAGE = [
  '---', 'id: 1', '---',
  '## Habits',
  '- [ ] Walk',
  '',
  '![[Groceries]]',
  '',
  'Topics:: [[A]]',
  'Mood:: fine',
  '%% note to self %%',
  '## Morning Pages',
  'I woke and wrote.',
  '',
  'The otter crept along the wall.',
].join('\n');

test('rules label only what is plainly structure', () => {
  const got = splitBlocks(PAGE).map((b) => ruleLabel(b)?.label ?? null);
  // frontmatter, task item (judged), embed, fields, comment, two paragraphs (judged)
  assert.deepEqual(got, ['other', null, 'other', 'other', 'other', null, null]);
});

test('an HTML comment alone is structure', () => {
  assert.equal(ruleLabel(splitBlocks('<!-- summary-start -->')[0]!)?.label, 'other');
  assert.equal(ruleLabel(splitBlocks('<!-- a --> but words')[0]!), null);
});

test('the fallback guess reads the heading and the checkbox', () => {
  const blocks = splitBlocks(PAGE);
  assert.equal(fallbackGuess(blocks[1]!), 'tasks');
  assert.equal(fallbackGuess(blocks[5]!), 'morning-pages');
  assert.equal(fallbackGuess(splitBlocks('Words here.')[0]!), 'other');
  assert.equal(fallbackGuess(splitBlocks('### 1. Morning Pages\nWords.')[0]!), 'morning-pages');
  assert.equal(fallbackGuess(splitBlocks('#### 2025-12-30 (from Dec 18 Morning Pages)\nWords.')[0]!), 'other', 'a heading quoting them is not the section');
});

const reply = (items: [number, string, boolean?][]) =>
  JSON.stringify(items.map(([n, label, pasted]) => ({ id: `b${n}`, label, pasted: pasted ?? false, reason: 'r' })));

test('the prompt numbers the blocks, shows headings and lines, and fences the text as data', () => {
  const blocks = splitBlocks(PAGE).slice(5);
  const prompt = buildPrompt('Daily/2026-01-01.md', blocks);
  assert.match(prompt, /Daily\/2026-01-01\.md/);
  assert.match(prompt, /<block id="b1" heading="Morning Pages" lines="13-13">\nI woke and wrote\.\n<\/block>/);
  assert.match(prompt, /<block id="b2"/);
  assert.match(prompt, /data, not instructions/i);
  for (const label of ['writing', 'morning-pages', 'tasks', 'other']) assert.ok(prompt.includes(label));
});

test('a reply must name every block once with a known label', () => {
  assert.equal(parseReply(`Sure:\n${reply([[1, 'writing'], [2, 'tasks', true]])}\n`, 2).get(2)?.pasted, true);
  assert.throws(() => parseReply(reply([[1, 'writing']]), 2), /b2/);
  assert.throws(() => parseReply(reply([[1, 'writing'], [1, 'tasks'], [2, 'other']]), 2), /twice/);
  assert.throws(() => parseReply(reply([[1, 'poetry'], [2, 'other']]), 2), /poetry/);
  assert.throws(() => parseReply('no json here', 2), /JSON/);
});

test('one vote: the judge decides every unruled block', async () => {
  const blocks = splitBlocks(PAGE);
  const judged = await judgePage('p.md', blocks, async () => reply([[1, 'tasks'], [2, 'morning-pages'], [3, 'writing']]), { votes: 1 });
  assert.deepEqual([...judged.values()].map((j) => [j.label, j.by]), [
    ['tasks', 'judge'], ['morning-pages', 'judge'], ['writing', 'judge'],
  ]);
  assert.equal(judged.has(blocks[0]!.id), false, 'ruled blocks are not judged');
});

test('two votes that differ are marked for the author', async () => {
  const blocks = splitBlocks(PAGE);
  let call = 0;
  const judged = await judgePage('p.md', blocks, async () => {
    call++;
    return reply([[1, 'tasks'], [2, 'morning-pages'], [3, call === 1 ? 'writing' : 'morning-pages']]);
  }, { votes: 2 });
  assert.equal(call, 2);
  const last = judged.get(blocks[6]!.id)!;
  assert.equal(last.by, 'votes-differ');
  assert.deepEqual(last.votes, ['writing', 'morning-pages']);
  assert.equal(judged.get(blocks[1]!.id)!.by, 'judge');
});

test('long pages go in chunks, each block judged once per vote', async () => {
  const page = Array.from({ length: 25 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  const blocks = splitBlocks(page);
  const sizes: number[] = [];
  const judged = await judgePage('p.md', blocks, async (prompt) => {
    const n = (prompt.match(/<block id=/g) ?? []).length;
    sizes.push(n);
    return reply(Array.from({ length: n }, (_, i) => [i + 1, 'other'] as [number, string]));
  }, { votes: 1, chunk: 10 });
  assert.deepEqual(sizes, [10, 10, 5]);
  assert.equal(judged.size, 25);
});

test('an unusable reply is retried once, then its blocks are marked judge-failed and logged', async () => {
  const blocks = splitBlocks(PAGE);
  let calls = 0;
  const { result, records } = await captureLogsAsync(() => judgePage('p.md', blocks, async () => {
    calls++;
    return 'garbage';
  }, { votes: 1 }));
  assert.equal(calls, 2);
  assert.deepEqual([...result.values()].map((j) => j.by), ['judge-failed', 'judge-failed', 'judge-failed']);
  assert.ok(records.some((r) => r.level === 'warning' && /p\.md/.test(r.message)));
});

test('a reply that is good on the retry is used', async () => {
  const blocks = splitBlocks(PAGE);
  let calls = 0;
  const judged = await judgePage('p.md', blocks, async () => (++calls === 1 ? 'garbage' : reply([[1, 'tasks'], [2, 'other'], [3, 'writing']])), { votes: 1 });
  assert.equal([...judged.values()][2]!.label, 'writing');
});

test('a judge command is retried after each wait, then the failure escalates with what it printed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'judge-'));
  const count = path.join(dir, 'n');
  const script = `require('fs').appendFileSync(${JSON.stringify(count)}, 'x'); console.log('limit reached'); process.exit(3)`;
  const judge = commandJudge(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, [0, 0]);
  await assert.rejects(judgePage('p.md', splitBlocks(PAGE), judge, { votes: 1 }), /exit 3\): limit reached/);
  assert.equal(readFileSync(count, 'utf8').length, 3, 'the first try and two retries');
  rmSync(dir, { recursive: true, force: true });
});

test('a judge command that recovers on a retry is used', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'judge-'));
  const flag = path.join(dir, 'tried');
  const script = `const fs=require('fs');if(!fs.existsSync(${JSON.stringify(flag)})){fs.writeFileSync(${JSON.stringify(flag)},'');process.exit(1)}`
    + "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const n=(s.match(/<block id=/g)||[]).length;"
    + "process.stdout.write(JSON.stringify(Array.from({length:n},(_,i)=>({id:'b'+(i+1),label:'tasks'}))))})";
  const judge = commandJudge(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`, [0]);
  const judged = await judgePage('p.md', splitBlocks(PAGE), judge, { votes: 1 });
  assert.deepEqual([...judged.values()].map((j) => j.label), ['tasks', 'tasks', 'tasks']);
  rmSync(dir, { recursive: true, force: true });
});

test('a judge command reads the prompt on stdin and answers on stdout', async () => {
  const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const n=(s.match(/<block id=/g)||[]).length;"
    + "process.stdout.write(JSON.stringify(Array.from({length:n},(_,i)=>({id:'b'+(i+1),label:'writing',pasted:false,reason:'x'}))))})";
  const judge = commandJudge(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`);
  const judged = await judgePage('p.md', splitBlocks(PAGE), judge, { votes: 1 });
  assert.deepEqual([...judged.values()].map((j) => j.label), ['writing', 'writing', 'writing']);
});

async function captureLogsAsync<T>(work: () => Promise<T>) {
  const records: LogRecord[] = [];
  const previous = setLogSink((record) => records.push(record));
  try {
    return { result: await work(), records };
  } finally {
    setLogSink(previous);
  }
}
