// Applying a reviewed sheet. Rules: only included rows are written; each wiki page holds
// its blocks in source order with where they came from; the Morning Pages file reads
// through NEO's own import as one chapter per day with every word kept; a block that
// changed since review is never written; a re-run replaces what the last run wrote.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

test('included writing becomes wiki pages with their sources; nothing else does', () => {
  const dir = vault();
  const out = tempDir();
  const result = applySheet(dir, sheet(), out, { pathPrefix: 'E:\\Out' });
  assert.deepEqual(result.missing, []);
  const pages = readdirSync(path.join(out, 'wiki')).sort();
  assert.deepEqual(pages, ['2026-01-01-Notes-(snippets).md', '2026-01-02-Later-(snippets).md']);
  const later = readFileSync(path.join(out, 'wiki', '2026-01-02-Later-(snippets).md'), 'utf8');
  assert.match(later, /^---\nsources:\n {2}- "Daily\/2026-01-02 Week 1\.md lines 13-13 \^[0-9a-f]{10}"\n---\n\nAn idea: the otter keeps a ledger of debts\.\n$/);
  const list = readFileSync(path.join(out, 'import-list.txt'), 'utf8');
  assert.equal(list, 'E:\\Out\\wiki\\2026-01-01-Notes-(snippets).md\nE:\\Out\\wiki\\2026-01-02-Later-(snippets).md\n');
});

test('rows of several sections joined in one dest keep their order under their headings', () => {
  const rows = sheet();
  for (const r of rows) if (r.label === 'writing') r.wiki_page = 'Otter-Ideas';
  const out = tempDir();
  applySheet(vault(), rows, out, {});
  const text = readFileSync(path.join(out, 'wiki', 'Otter-Ideas.md'), 'utf8');
  const body = text.slice(text.indexOf('---\n\n') + 5);
  assert.equal(body, '## Morning Pages > Later\n\nAn idea: the otter keeps a ledger of debts.\n\n## Notes\n\nThe heron never lands.\n');
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
  const result = applySheet(dir, rows, tempDir(), {});
  assert.deepEqual(result.missing.map((m) => [m.page, m.lines]), [['Daily/2026-01-01 Week 1.md', '5-5']], 'only the changed block');
  assert.ok(result.written.includes('Morning Pages.md'), 'the unchanged block of that page still is');
  assert.equal(result.written.some((f) => f.includes('Notes')), false);
});

test('rows to check are not written, and are counted', () => {
  const rows = sheet();
  const idea = rows.find((r) => r.preview.startsWith('An idea'))!;
  idea.wiki = 'check';
  const out = tempDir();
  const result = applySheet(vault(), rows, out, {});
  assert.equal(result.unresolved, 1);
  assert.equal(existsSync(path.join(out, 'wiki', '2026-01-02-Later-(snippets).md')), false);
});

test('a re-run removes the pages the last run wrote and this one does not', () => {
  const out = tempDir();
  const rows = sheet();
  applySheet(vault(), rows, out, {});
  for (const r of rows) if (r.preview.startsWith('The heron')) r.wiki = 'no';
  applySheet(vault(), rows, out, {});
  assert.deepEqual(readdirSync(path.join(out, 'wiki')), ['2026-01-02-Later-(snippets).md']);
});

test('a wiki_page that is not one path segment is refused', () => {
  const rows = sheet();
  for (const r of rows) if (r.label === 'writing') r.wiki_page = '../escape';
  assert.throws(() => applySheet(vault(), rows, tempDir(), {}), /wiki_page/);
});

test('picks name each included block by lines under the whole file\'s hash, once per home', () => {
  const dir = vault();
  const { picks, missing } = blockPicks(dir, sheet());
  assert.deepEqual(missing, []);
  const sha = createHash('sha256').update(readFileSync(path.join(dir, 'Daily', '2026-01-02 Week 1.md'))).digest('hex');
  const day1 = picks.filter((p) => p.path === 'Daily/2026-01-02 Week 1.md');
  assert.ok(day1.every((p) => p.src_sha256 === sha));
  assert.deepEqual(day1.map((p) => [p.start, p.end, p.kind, p.target]), [
    [7, 7, 'morning-pages', '2026-01-02'],
    [9, 10, 'morning-pages', '2026-01-02'],
    [13, 13, 'writing', '2026-01-02-Later-(snippets)'],
    [13, 13, 'morning-pages', '2026-01-02'],
    [15, 17, 'morning-pages', '2026-01-02'],
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
