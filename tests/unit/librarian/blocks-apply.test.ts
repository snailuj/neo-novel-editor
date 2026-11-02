// Applying a reviewed sheet. Rules: only included rows are listed; each page of the
// library is cut from its one vault page by lines, in source order, under the headings it
// had, and the list reads as Import List… reads it; the Morning Pages file reads
// through NEO's own import as one chapter per day with every word kept; a block that
// changed since review is never written; a re-run replaces what the last run wrote.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { applySheet, blockPicks, bookText } from '../../../src/librarian/blocks/apply.ts';
import type { Judged } from '../../../src/librarian/blocks/judge.ts';
import { type Row, rowsFor } from '../../../src/librarian/blocks/sheet.ts';
import { splitBlocks } from '../../../src/librarian/blocks/split.ts';
import { readImportList } from '../../../src/hoard/wiki/import-list.ts';
import { convertPick, picked } from '../../../src/hoard/wiki/picks.ts';

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'blocks-')));
  temps.push(dir);
  return dir;
};

const DAY1 = [
  '## Habits',
  '- [ ] Walk',
  '',
  '## Morning Pages',
  'Topics:: [[Project-Morning-Pages]]',
  '',
  'I woke early and the [[Harbour|harbour]] was grey. %% aside %%',
  '',
  '- a list of worries',
  '    - a nested worry',
  '',
  '### Later',
  'An idea: the otter keeps a ledger of debts.',
  '',
  '```',
  '# a line that looks like a heading',
  '```',
].join('\n');
const DAY2 = '## Morning Pages\nSecond day, short.\n\n## Notes\nThe heron never lands.';

function vault(): string {
  const dir = tempDir();
  mkdirSync(path.join(dir, 'Daily'));
  writeFileSync(path.join(dir, 'Daily', '2026-01-02 Week 1.md'), DAY1);
  writeFileSync(path.join(dir, 'Daily', '2026-01-01 Week 1.md'), DAY2);
  return dir;
}

// Labels by block, in page order, standing in for the judge.
function sheet(): Row[] {
  const day1 = splitBlocks(DAY1);
  const day2 = splitBlocks(DAY2);
  const judge = (blocks: ReturnType<typeof splitBlocks>, labels: (string | null)[]) => new Map(blocks.flatMap((b, i) =>
    labels[i] ? [[b.id, { label: labels[i], pasted: false, reason: 'r', by: 'judge', votes: [labels[i]] } as Judged]] : []));
  return [
    ...rowsFor('Daily/2026-01-02 Week 1.md', day1, judge(day1, ['tasks', null, 'morning-pages', 'morning-pages', 'writing', 'morning-pages']), []),
    ...rowsFor('Daily/2026-01-01 Week 1.md', day2, judge(day2, ['morning-pages', 'writing']), []),
  ];
}

const LIST_SHA = (dir: string, page: string) => createHash('sha256').update(readFileSync(path.join(dir, page))).digest('hex').slice(0, 16);

test('included writing becomes import list lines that cut each block from its vault page; nothing else does', () => {
  const dir = vault();
  const out = tempDir();
  const result = applySheet(dir, sheet(), out, { vaultPrefix: 'E:\\Vault\\' });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.written.sort(), ['Morning Pages.md', 'import-list.txt']);
  const [d1, d2] = [LIST_SHA(dir, 'Daily/2026-01-02 Week 1.md'), LIST_SHA(dir, 'Daily/2026-01-01 Week 1.md')];
  assert.equal(readFileSync(path.join(out, 'import-list.txt'), 'utf8'), [
    '# Written by blocks apply from the review sheet: each page is cut from its vault page by lines.',
    '',
    'to: sources',
    `E:\\Vault\\Daily\\2026-01-01 Week 1.md#L5-L5@${d2} -> 2026-01-01-Notes-(snippets)`,
    `E:\\Vault\\Daily\\2026-01-02 Week 1.md#L13-L13@${d1} -> 2026-01-02-Later-(snippets)`,
    '',
  ].join('\n'));
});

test('a row whose dest is wiki is listed under to: wiki, after the sources', () => {
  const rows = sheet();
  rows.find((r) => r.preview.startsWith('The heron'))!.dest = 'wiki';
  const out = tempDir();
  applySheet(vault(), rows, out, {});
  const list = readFileSync(path.join(out, 'import-list.txt'), 'utf8');
  assert.match(list, /\nto: sources\n[^\n]*2026-01-02-Later-\(snippets\)\n\nto: wiki\n[^\n]*-> 2026-01-01-Notes-\(snippets\)\n$/);
});

test('the list reads as an import list, and the blocks of one page under several headings come in with their headings', () => {
  const dir = vault();
  const rows = sheet();
  for (const r of rows) {
    if (r.page.includes('01-02') && (r.preview.startsWith('I woke') || r.preview.startsWith('An idea'))) {
      r.dest = 'sources';
      r.dest_page = 'Otter-Ideas';
    }
  }
  const out = tempDir();
  applySheet(dir, rows.filter((r) => r.page.includes('01-02')), out, {});
  const listFile = path.join(out, 'import-list.txt');
  const list = readImportList(listFile, readFileSync(listFile, 'utf8'));
  const otter = list.entries.filter((e) => e.name === 'Otter-Ideas');
  assert.deepEqual(otter.map((e) => [e.section, e.to, e.folder]), [['L4-L4', 'sources', null], ['L7-L7', 'sources', null], ['L12-L12', 'sources', null], ['L13-L13', 'sources', null]]);
  const [page] = picked(otter.map((e) => ({ path: e.path, name: e.name, section: e.section, sha: e.sha })));
  let n = 0;
  const made = convertPick(page!, readFileSync(page!.path), new Map(), () => `b${++n}`);
  assert.ok(!('why' in made), JSON.stringify(made));
  assert.deepEqual(made.page.blocks.map((b) => b.text), ['Morning Pages', 'I woke early and the [[Harbour|harbour]] was grey. %% aside %%', 'Later', 'An idea: the otter keeps a ledger of debts.']);
});

test('one dest_page fed from two vault pages is refused, since a page is cut from one', () => {
  const rows = sheet();
  for (const r of rows) if (r.label === 'writing') r.dest_page = 'Otter-Ideas';
  assert.throws(() => applySheet(vault(), rows, tempDir(), {}), /Otter-Ideas.*takes blocks from Daily\/2026-01-02 Week 1\.md and Daily\/2026-01-01 Week 1\.md/);
});
test('the Morning Pages file reads through NEO\'s import as one chapter per day, in date order, every word kept', async () => {
  const out = tempDir();
  applySheet(vault(), sheet(), out, {});
  const r = await neoImport(path.join(out, 'Morning Pages.md'));
  assert.equal(r.title, 'Morning Pages');
  assert.deepEqual(r.chapters.map((c) => c.title), ['2026-01-01', '2026-01-02']);
  assert.deepEqual(r.chapters.map((c) => c.paras.map((p) => p.text)), [
    ['Second day, short.'],
    [
      'I woke early and the harbour was grey.',
      '- a list of worries',
      '- a nested worry',
      // a writing block inside Morning Pages stays in the day too
      'An idea: the otter keeps a ledger of debts.',
      '```',
      '\u200B# a line that looks like a heading',
      '```',
    ],
  ]);
});

test('a block that changed since review is not written, and is named', () => {
  const dir = vault();
  const rows = sheet();
  writeFileSync(path.join(dir, 'Daily', '2026-01-01 Week 1.md'), DAY2.replace('never lands', 'lands at last'));
  const out2 = tempDir();
  const result = applySheet(dir, rows, out2, {});
  assert.deepEqual(result.missing.map((m) => [m.page, m.lines]), [['Daily/2026-01-01 Week 1.md', '5-5']], 'only the changed block');
  assert.ok(result.written.includes('Morning Pages.md'), 'the unchanged block of that page still is');
  assert.doesNotMatch(readFileSync(path.join(out2, 'import-list.txt'), 'utf8'), /Notes/);
});

test('rows to check are not written, and are counted', () => {
  const rows = sheet();
  const idea = rows.find((r) => r.preview.startsWith('An idea'))!;
  idea.dest = 'check';
  const out = tempDir();
  const result = applySheet(vault(), rows, out, {});
  assert.equal(result.unresolved, 1);
  assert.doesNotMatch(readFileSync(path.join(out, 'import-list.txt'), 'utf8'), /Later/);
});

test('a re-run removes the files the last run wrote and this one does not', () => {
  const out = tempDir();
  const rows = sheet();
  applySheet(vault(), rows, out, {});
  for (const r of rows) if (r.label === 'writing') r.dest = 'out';
  applySheet(vault(), rows, out, {});
  assert.deepEqual(readdirSync(out).sort(), ['.blocks-apply.json', 'Morning Pages.md']);
});

test('a dest_page that is not one path segment, or a dest that is not one of the four, is refused', () => {
  const rows = sheet();
  for (const r of rows) if (r.label === 'writing') r.dest_page = '../escape';
  assert.throws(() => applySheet(vault(), rows, tempDir(), {}), /dest_page/);
  const yes = sheet();
  yes[0]!.dest = 'yes';
  assert.throws(() => applySheet(vault(), yes, tempDir(), {}), /dest 'yes' .* is not one of sources, wiki, out, check/);
  assert.throws(() => blockPicks(vault(), yes), /dest 'yes'/);
});

test('picks name each included block by lines under the whole file\'s hash, once per home', () => {
  const dir = vault();
  const { picks, missing } = blockPicks(dir, sheet());
  assert.deepEqual(missing, []);
  const sha = createHash('sha256').update(readFileSync(path.join(dir, 'Daily', '2026-01-02 Week 1.md'))).digest('hex');
  const day1 = picks.filter((p) => p.path === 'Daily/2026-01-02 Week 1.md');
  assert.ok(day1.every((p) => p.src_sha256 === sha));
  assert.deepEqual(day1.map((p) => [p.start, p.end, p.kind, p.target, p.dest]), [
    [7, 7, 'morning-pages', '2026-01-02', undefined],
    [9, 10, 'morning-pages', '2026-01-02', undefined],
    [13, 13, 'writing', '2026-01-02-Later-(snippets)', 'sources'],
    [13, 13, 'morning-pages', '2026-01-02', undefined],
    [15, 17, 'morning-pages', '2026-01-02', undefined],
  ]);
  assert.ok(day1.every((p) => p.why.length > 0));
});

test('bookText strips links, comments and inline embeds but keeps every word', () => {
  assert.equal(bookText('See [[A|the a]] and [[B]] ![[C]] %% hidden %%here.'), 'See the a and B C here.');
});

// NEO's own import, from main.js in a sandbox (as scripts/import.test.js loads it).
const root = fileURLToPath(new URL('../../../', import.meta.url));
interface Imported { title: string; chapters: { title: string; paras: { text?: string }[] }[] }
async function neoImport(file: string): Promise<Imported> {
  const localRequire = createRequire(path.join(root, 'main.js'));
  const handlers = new Map<string, (...args: unknown[]) => Promise<Imported[]>>();
  const electron = {
    app: { commandLine: { appendSwitch() {} }, getPath: () => tmpdir(), getLocale: () => 'en', requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }), on() {} },
    ipcMain: { on() {}, handle: (name: string, fn: (...args: unknown[]) => Promise<Imported[]>) => handlers.set(name, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items: unknown) => items, setApplicationMenu() {} },
    dialog: { showMessageBox: () => Promise.resolve({}) },
    utilityProcess: { fork: () => ({ on() {}, postMessage() {} }) },
    screen: {},
  };
  vm.runInContext(readFileSync(path.join(root, 'main.js'), 'utf8'), vm.createContext({
    require: (name: string) => (name === 'electron' ? electron : localRequire(name)),
    __dirname: root, process: { platform: process.platform, on() {}, env: {} }, console,
  }), { filename: path.join(root, 'main.js') });
  const [r] = await handlers.get('import:files')!(null, [file]);
  return JSON.parse(JSON.stringify(r)) as Imported;
}
