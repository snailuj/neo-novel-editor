// Rules for importing into the library's trees of page files (sources/ and wiki/):
// - a source page lands in the folder its file has in its vault, a wiki page at the top
//   of wiki/, and a folder the list names places either; each page's sidecar is at
//   .neo/pages/<tree>/<path>.json with the hash the page was written with, and its
//   change line names the page by id;
// - a changed source updates a page nobody has changed, wherever it was moved to, and
//   keeps the marks on it; a page changed since gets the new source beside it, dated, in
//   its folder;
// - a title is one to a tree: a second page of a title is a clash in its tree only, and
//   a name no link could reach is refused;
// - splits, line ranges and attachments carry over from the Wiki book's import;
// - a page's marks go to the page marks store, or, with none, are counted as left out;
// - with history kept, the author's blocks are committed before the librarian's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { validateHoardChangeV1, validateHoardPageV1 } from '../../src/generated/validators.cjs';
import { paragraphTexts } from '../../src/hoard/html.ts';
import type { Tree } from '../../src/hoard/pages/identity.ts';
import { PageImport, type PageImportOptions, type PageMarks } from '../../src/hoard/wiki/page-import.ts';
import { parseManifest } from '../../src/librarian/manifest.ts';
import { tempDir } from './git-support.ts';

type T = { after(fn: () => void): void };

// A page marks store kept in memory, as stage 3's will be on disk.
function memoryMarks(): PageMarks & { by: Map<string, Mark[]> } {
  const by = new Map<string, Mark[]>();
  return {
    by,
    list: async (page) => [...(by.get(page) ?? [])],
    addAll: async (page, marks) => { by.set(page, [...(by.get(page) ?? []), ...marks]); },
  };
}

function setup(t: T, extra: Partial<PageImportOptions> = {}) {
  const library = tempDir(t, 'hoard-lib-');
  const disk = tempDir(t, 'hoard-disk-');
  mkdirSync(path.join(disk, 'vault', '.obsidian'), { recursive: true });
  let n = 0;
  let clock = Date.parse('2026-11-01T09:00:00.000Z');
  const options = {
    library: () => library,
    now: () => new Date((clock += 1000)),
    newId: (prefix: string) => `${prefix}-t${(n++).toString().padStart(4, '0')}`,
    log: () => {},
    ...extra,
  };
  const into = (tree: Tree) => new PageImport({ ...options, tree });
  const put = (rel: string, data: string | Buffer) => {
    const file = path.join(disk, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };
  const at = (rel: string) => path.join(library, ...rel.split('/'));
  const read = (rel: string) => readFileSync(at(rel), 'utf8');
  const json = (rel: string) => JSON.parse(read(rel));
  const text = (id: string) => paragraphTexts(read(id));
  const files = (tree: string) => {
    const walk = (dir: string, rel: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? walk(path.join(dir, e.name), r) : [r];
    }) : []);
    return walk(at(tree), '').sort();
  };
  const changes = () => read('.neo/changes.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  const manifest = () => parseManifest(read('.neo/manifest.jsonl'));
  const kinds = (sorted: { verdicts: { kind: string; name: string }[] }) => sorted.verdicts.map((v) => [v.kind, v.name]);
  return { library, disk, into, put, at, read, json, text, files, changes, manifest, kinds };
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

test('a source lands in its vault folder, a wiki page at the top of wiki/, and a named folder places either', async (t) => {
  const s = setup(t);
  const ebb = s.put('vault/Daily/Notes/Ebb.md', '---\ntype: note\n---\nThe tide went out.\n');
  const flow = s.put('vault/Flow.md', 'In again.\n');
  const quay = s.put('vault/lore/Quay.md', 'Built of stone.\n');
  const loose = s.put('elsewhere/Loose.md', 'No vault here.\n');
  const sources = s.into('sources');
  const done = await sources.apply(sources.sort([ebb, flow, loose, { path: quay, name: 'Old Quay', folder: 'Places/Coast' }]));
  assert.deepEqual(done.imported.map((p) => [p.page, p.name]), [
    ['sources/Daily/Notes/Ebb.html', 'Ebb'], ['sources/Flow.html', 'Flow'], ['sources/Loose.html', 'Loose'], ['sources/Places/Coast/Old Quay.html', 'Old Quay'],
  ]);
  const wiki = s.into('wiki');
  await wiki.apply(wiki.sort([{ path: quay, name: 'Quay' }, { path: flow, name: 'Flow', folder: 'Sea' }]));
  assert.deepEqual(s.files('wiki'), ['Quay.html', 'Sea/Flow.html']);
  assert.deepEqual(s.text('sources/Daily/Notes/Ebb.html'), ['The tide went out.']);

  const sidecar = s.json('.neo/pages/sources/Daily/Notes/Ebb.html.json');
  assert.ok(validateHoardPageV1(sidecar), JSON.stringify(validateHoardPageV1.errors));
  assert.deepEqual([sidecar.source.path, sidecar.source.sha256, sidecar.frontmatter, sidecar.written],
    [ebb, sha(readFileSync(ebb)), { type: 'note' }, sha(s.read('sources/Daily/Notes/Ebb.html'))]);
  for (const c of s.changes()) assert.ok(validateHoardChangeV1(c), JSON.stringify(validateHoardChangeV1.errors));
  assert.deepEqual(s.changes().map((c) => [c.kind, c.page, c.dest, 'bookId' in c]), [
    ['page-imported', 'sources/Daily/Notes/Ebb.html', 'sources/Daily/Notes/Ebb.html', false],
    ['page-imported', 'sources/Flow.html', 'sources/Flow.html', false],
    ['page-imported', 'sources/Loose.html', 'sources/Loose.html', false],
    ['page-imported', 'sources/Places/Coast/Old Quay.html', 'sources/Places/Coast/Old Quay.html', false],
    ['page-imported', 'wiki/Sea/Flow.html', 'wiki/Sea/Flow.html', false],
    ['page-imported', 'wiki/Quay.html', 'wiki/Quay.html', false],
  ]);
  assert.deepEqual(s.manifest().map((r) => [r.dest, r.method]).slice(0, 2), [['sources/Daily/Notes/Ebb.html', 'converted'], ['sources/Flow.html', 'converted']]);
});

test('a changed source updates a page nobody changed, even after a move, and keeps its marks', async (t) => {
  const marks = memoryMarks();
  const s = setup(t, { marks });
  const owl = s.put('vault/Birds/Owl.md', 'Grey.\nHunts at {==night==}{>>Which night?<<}.\n');
  const sources = s.into('sources');
  await sources.apply(sources.sort([owl]));
  assert.equal(marks.by.get('sources/Birds/Owl.html')?.length, 1);
  // the writer moves the page and its sidecar, as a rename does
  mkdirSync(s.at('sources/Fauna'), { recursive: true });
  mkdirSync(s.at('.neo/pages/sources/Fauna'), { recursive: true });
  renameSync(s.at('sources/Birds/Owl.html'), s.at('sources/Fauna/Owl.html'));
  renameSync(s.at('.neo/pages/sources/Birds/Owl.html.json'), s.at('.neo/pages/sources/Fauna/Owl.html.json'));
  marks.by.set('sources/Fauna/Owl.html', marks.by.get('sources/Birds/Owl.html')!);

  writeFileSync(owl, 'Grey and white.\nHunts at {==night==}{>>Which night?<<}.\n');
  const sorted = sources.sort([owl]);
  assert.deepEqual(s.kinds(sorted), [['update', 'Owl']]);
  const done = await sources.apply(sorted);
  assert.deepEqual([done.updated, done.imported, done.marks], [[{ page: 'sources/Fauna/Owl.html', name: 'Owl' }], [], 0]);
  assert.deepEqual(s.text('sources/Fauna/Owl.html'), ['Grey and white.', 'Hunts at night.']);
  assert.equal(marks.by.get('sources/Fauna/Owl.html')?.length, 1);
  assert.deepEqual(s.changes().map((c) => [c.kind, c.page]).at(-1), ['page-updated', 'sources/Fauna/Owl.html']);
  assert.deepEqual(s.kinds(sources.sort([owl])), [['same', 'Owl']]);
});

test('a page changed since it came in gets the newer source beside it, dated, in its folder', async (t) => {
  const s = setup(t);
  const owl = s.put('vault/Birds/Owl.md', 'Grey.\n');
  const sources = s.into('sources');
  await sources.apply(sources.sort([owl]));
  writeFileSync(s.at('sources/Birds/Owl.html'), '<p data-block="x1">Grey, says the writer.</p>');
  writeFileSync(owl, 'Grey and white.\n');
  const sorted = sources.sort([owl]);
  assert.deepEqual(s.kinds(sorted), [['beside', 'Owl (source changed 2026-11-01)']]);
  await sources.apply(sorted);
  assert.deepEqual(s.files('sources'), ['Birds/Owl (source changed 2026-11-01).html', 'Birds/Owl.html']);
  assert.deepEqual(s.text('sources/Birds/Owl.html'), ['Grey, says the writer.']);
  // the next import follows the newest page
  assert.deepEqual(s.kinds(sources.sort([owl])), [['same', 'Owl (source changed 2026-11-01)']]);
});

test('a title is one to a tree, and a name no link could reach is refused', async (t) => {
  const s = setup(t);
  const a = s.put('vault/a/Tide.md', 'One.\n');
  const b = s.put('vault/b/Tide.md', 'Two.\n');
  const odd = s.put('vault/C# notes.md', 'Sharp.\n');
  const sources = s.into('sources');
  const wiki = s.into('wiki');
  await sources.apply(sources.sort([a]));
  assert.deepEqual(s.kinds(sources.sort([b, odd])), [['unreadable', 'C# notes'], ['clash', 'Tide']]);
  const why = sources.sort([odd]).verdicts[0]!;
  assert.match(why.kind === 'unreadable' ? why.why : '', /cannot be a page title/);
  assert.deepEqual(s.kinds(wiki.sort([b, { path: odd, name: 'C-sharp notes' }])), [['new', 'C-sharp notes'], ['new', 'Tide']]);
  mkdirSync(s.at('wiki'), { recursive: true });
  writeFileSync(s.at('wiki/Harbour.html'), '<p>Made in NEO.</p>');
  assert.deepEqual(s.kinds(wiki.sort([{ path: b, name: 'harbour' }])), [['clash', 'harbour']]);
});

test('sections and line ranges become one page, recorded as a split, and attachments are copied into the tree', async (t) => {
  const s = setup(t);
  const day = s.put('vault/Daily/2025-12-15.md', '---\ntype: daily\n---\n# Tasks\n- [ ] sweep\n# Idea\nA ship of glass.\n![[Glass.png]]\nIt sails.\n');
  s.put('vault/assets/Glass.png', Buffer.from([1, 2, 3]));
  const wiki = s.into('wiki');
  const sorted = wiki.sort([
    { path: day, name: 'Glass Ship', section: 'Idea' },
    { path: day, name: 'Glass Ship', section: 'L9-L9', sha: sha(readFileSync(day)).slice(0, 12) },
  ]);
  assert.deepEqual(s.kinds(sorted), [['new', 'Glass Ship']]);
  const done = await wiki.apply(sorted);
  assert.deepEqual([done.attachments, done.missing], [1, []]);
  assert.deepEqual(s.text('wiki/Glass Ship.html'), ['Idea', 'A ship of glass.', '![[Glass.png]]', 'It sails.', 'It sails.']);
  assert.deepEqual(s.json('.neo/pages/wiki/Glass Ship.html.json').source.sections, ['Idea', 'L9-L9']);
  assert.deepEqual(s.files('wiki'), ['Glass Ship.html', 'attachments/Glass.png']);
  assert.deepEqual(s.manifest().map((r) => [r.dest, r.method]), [['wiki/attachments/Glass.png', 'verbatim'], ['wiki/Glass Ship.html', 'split']]);
  assert.deepEqual(s.changes().map((c) => [c.kind, c.page, c.dest]), [
    ['attachment-imported', 'wiki/Glass Ship.html', 'wiki/attachments/Glass.png'], ['page-imported', 'wiki/Glass Ship.html', 'wiki/Glass Ship.html'],
  ]);
});

test('without a page marks store, a page\'s marks are counted as left out', async (t) => {
  const s = setup(t);
  const gulls = s.put('vault/Gulls.md', 'She {==waited==}{>>For whom?<<} there.\n');
  const sources = s.into('sources');
  const done = await sources.apply(sources.sort([gulls]));
  assert.deepEqual([done.marks, done.marksLeft], [0, 1]);
  assert.deepEqual(s.text('sources/Gulls.html'), ['She waited there.']);
});

test('an import commits the author\'s blocks and pages first, then the librarian\'s', async (t) => {
  const seen: { part: string; files: string[]; quay: string }[] = [];
  const s: ReturnType<typeof setup> = setup(t, {
    commit: async (part) => {
      seen.push({ part, files: s.files('wiki'), quay: paragraphTexts(s.read('wiki/Quay.html')).join(' | ') });
    },
  });
  const quay = s.put('vault/Quay.md', '---\ntype: lore\n---\n> "Mind the step," she said.\nThe quay is old.\n');
  const plain = s.put('vault/Plain.md', 'Nothing quoted.\n');
  const wiki = s.into('wiki');
  await wiki.apply(wiki.sort([quay, plain]));
  assert.deepEqual(seen, [
    { part: 'author', files: ['Plain.html', 'Quay.html'], quay: '"Mind the step," she said.' },
    { part: 'librarian', files: ['Plain.html', 'Quay.html'], quay: '"Mind the step," she said. | The quay is old.' },
  ]);
});
