// Rules for importing pages into the wiki book:
// - the first import makes the wiki book, on no shelf, and .neo/wiki.json names it;
// - each new page is an unnumbered chapter titled with its file's name, after the
//   pages already there, and the rest of book.json is kept;
// - a page's frontmatter and source go to its page sidecar, its CriticMarkup marks to
//   the marks sidecar, found on the words they were about;
// - each page adds a manifest line and a change event, and every file is checked;
// - a page already in the wiki is skipped, one whose source changed is never written
//   over, and a name already taken is not imported twice;
// - nothing is written when nothing is new, or when the manifest does not read.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Mark } from '../../src/generated/hoard-marks-v1.js';
import { validateHoardChangeV1, validateHoardMarksV1, validateHoardPageV1, validateHoardWikiV1 } from '../../src/generated/validators.cjs';
import { locate } from '../../src/hoard/marks/anchor.ts';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { paragraphsHtml } from '../../src/hoard/wiki/convert.ts';
import { WikiStore } from '../../src/hoard/wiki/store.ts';
import { ManifestError, parseManifest } from '../../src/librarian/manifest.ts';
import { tempDir } from './git-support.ts';

type T = { after(fn: () => void): void };

function setup(t: T) {
  const library = tempDir(t);
  const vault = tempDir(t);
  const wrote: string[] = [];
  const lines: { level: string; message: string }[] = [];
  let n = 0;
  let clock = Date.parse('2026-10-15T22:00:00.000Z');
  const now = () => new Date((clock += 1000));
  const newId = (prefix: string) => `${prefix}-t${(n++).toString().padStart(4, '0')}`;
  const log = (level: 'error' | 'warn' | 'info' | 'debug', message: string) => { lines.push({ level, message }); };
  const marks = new MarkStore({ library: () => library, now, newId, wrote: (name) => wrote.push(name), log });
  const wiki = new WikiStore({ library: () => library, now, newId, marks, wrote: (name) => wrote.push(name), log });
  const page = (rel: string, text: string) => {
    const file = path.join(vault, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
    return file;
  };
  return { library, vault, wiki, wrote, lines, page };
}

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const bookOf = (library: string, bookId: string) => json(path.join(library, bookId, 'book.json'));

test('the first import makes the wiki book and brings each page in as an unnumbered chapter', async (t) => {
  const { library, wiki, page, wrote } = setup(t);
  const tide = page('lore/Tide Tables.md', '---\ntype: lore\n---\n# Tide Tables\n\nHigh water at [[Harbour]].\n');
  const harbour = page('lore/Harbour.md', 'The harbour wall.\n');
  assert.equal(wiki.wikiId(), null);

  const sorted = wiki.sort([tide, harbour]);
  assert.deepEqual(sorted.verdicts.map((v) => [v.kind, v.name]), [['new', 'Harbour'], ['new', 'Tide Tables']]);
  const done = await wiki.apply(sorted, null);

  const bookId = wiki.wikiId()!;
  assert.match(bookId, /^book-wiki-/);
  assert.ok(validateHoardWikiV1(json(path.join(library, '.neo', 'wiki.json'))));
  const book = bookOf(library, bookId);
  assert.equal(book.id, bookId);
  assert.equal(book.title, 'Wiki');
  assert.equal(book.chapterOrder.length, 2);
  const [first, second] = book.chapterOrder;
  assert.deepEqual(done.imported.map((p) => p.name), ['Harbour', 'Tide Tables']);
  assert.deepEqual([book.chapterTitles[first], book.chapterTitles[second]], ['Harbour', 'Tide Tables']);
  assert.deepEqual([book.chapterKinds[first], book.chapterKinds[second]], ['unnumbered', 'unnumbered']);
  for (const f of ['notes.html', 'outline.html', 'darlings.json', 'stickies.json']) assert.ok(existsSync(path.join(library, bookId, f)), f);

  assert.equal(readFileSync(path.join(library, bookId, 'chapters', `${second}.html`), 'utf8'),
    '<p># Tide Tables</p><p>High water at [[Harbour]].</p>');
  const sidecar = json(path.join(library, '.neo', bookId, 'pages', `${second}.json`));
  assert.ok(validateHoardPageV1(sidecar), JSON.stringify(validateHoardPageV1.errors));
  assert.deepEqual(sidecar.frontmatter, { type: 'lore' });
  assert.deepEqual([sidecar.source.path, sidecar.source.name], [tide, 'Tide Tables']);

  const manifest = parseManifest(readFileSync(path.join(library, '.neo', 'manifest.jsonl'), 'utf8'));
  assert.deepEqual(manifest.map((r) => [r.src, r.dest, r.method]), [
    [harbour, `${bookId}/chapters/${first}.html`, 'converted'],
    [tide, `${bookId}/chapters/${second}.html`, 'converted'],
  ]);
  assert.equal(manifest[1]!.src_sha256, sidecar.source.sha256);
  const changes = readFileSync(path.join(library, '.neo', 'changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(changes.map((c) => [c.kind, c.chId, c.src]), [['page-imported', first, harbour], ['page-imported', second, tide]]);
  for (const c of changes) assert.ok(validateHoardChangeV1(c), JSON.stringify(validateHoardChangeV1.errors));
  assert.ok(wrote.includes('.neo') && wrote.includes(bookId));
  assert.deepEqual(readdirSync(path.join(library, bookId, 'chapters')).filter((f) => f.endsWith('.tmp')), []);
  assert.deepEqual(wiki.pages(), { bookId, pages: [{ chId: first, title: 'Harbour' }, { chId: second, title: 'Tide Tables' }] });
});

test('a later import adds its pages after the ones there and keeps the rest of book.json', async (t) => {
  const { library, wiki, page } = setup(t);
  await wiki.apply(wiki.sort([page('a/Alpha.md', 'One.\n')]), null);
  const bookId = wiki.wikiId()!;
  const file = path.join(library, bookId, 'book.json');
  writeFileSync(file, JSON.stringify({ ...json(file), lastPosition: { chapterId: 'x', pIdx: 0, off: 0 }, hoardOther: 1 }, null, 2));
  await wiki.apply(wiki.sort([page('a/Beta.md', 'Two.\n')]), 'book-other-1');
  const book = json(file);
  assert.deepEqual(book.chapterOrder.map((id: string) => book.chapterTitles[id]), ['Alpha', 'Beta']);
  assert.deepEqual([book.lastPosition.chapterId, book.hoardOther], ['x', 1]);
  assert.ok(existsSync(`${file}.bak`), 'the version before is kept as NEO keeps it');
});

test('a page already in the wiki is skipped, a changed source is not written over, a name is taken once', async (t) => {
  const { library, wiki, page } = setup(t);
  const fox = page('lore/Fox.md', 'Red.\n');
  const owl = page('lore/Owl.md', 'Grey.\n');
  await wiki.apply(wiki.sort([fox, owl]), null);
  writeFileSync(owl, 'Grey and white.\n');
  const otherFox = page('sources/Fox.md', 'Another fox.\n');
  const hare = page('lore/Hare.md', 'Brown.\n');
  const hareAgain = page('inbox/hare.md', 'Brown again.\n');
  const sorted = wiki.sort([fox, owl, otherFox, hare, hareAgain]);
  const verdicts = Object.fromEntries(sorted.verdicts.map((v) => [v.path, v.kind]));
  assert.deepEqual(verdicts, { [fox]: 'same', [owl]: 'changed', [otherFox]: 'clash', [hare]: 'new', [hareAgain]: 'clash' });
  const before = readFileSync(path.join(library, '.neo', 'manifest.jsonl'), 'utf8');
  await wiki.apply(sorted, null);
  const book = bookOf(library, wiki.wikiId()!);
  assert.deepEqual(book.chapterOrder.map((id: string) => book.chapterTitles[id]), ['Fox', 'Owl', 'Hare']);
  const owlId = book.chapterOrder[1];
  assert.equal(readFileSync(path.join(library, wiki.wikiId()!, 'chapters', `${owlId}.html`), 'utf8'), '<p>Grey.</p>');
  assert.equal(parseManifest(readFileSync(path.join(library, '.neo', 'manifest.jsonl'), 'utf8')).length, parseManifest(before).length + 1);
});

test('a page that does not read is named with why, and the others still come in', async (t) => {
  const { wiki, page } = setup(t);
  const bad = page('lore/Bad.md', '---\ntype: [lore\n---\nBody.\n');
  const good = page('lore/Good.md', 'Fine.\n');
  const gone = path.join(path.dirname(good), 'Gone.md');
  const sorted = wiki.sort([bad, good, gone]);
  const byName = Object.fromEntries(sorted.verdicts.map((v) => [v.name, v]));
  assert.equal(byName['Bad']!.kind, 'unreadable');
  assert.match((byName['Bad'] as { why: string }).why, /frontmatter/);
  assert.equal(byName['Gone']!.kind, 'unreadable');
  assert.equal(byName['Good']!.kind, 'new');
  const done = await wiki.apply(sorted, null);
  assert.deepEqual(done.imported.map((p) => p.name), ['Good']);
});

test('CriticMarkup marks land in the marks sidecar, found on the words they were about', async (t) => {
  const { library, wiki, page } = setup(t);
  const file = page('lore/Gulls.md', 'The {++grey ++}gulls {--always --}cried.\nShe {==waited==}{>>For whom?<<} there.\nA lone {>>note<<} stays.\n');
  const done = await wiki.apply(wiki.sort([file]), null);
  assert.deepEqual([done.marks, done.keptAsText], [3, 1]);
  const bookId = wiki.wikiId()!;
  const chId = bookOf(library, bookId).chapterOrder[0];
  const saved = json(path.join(library, '.neo', bookId, 'chapters', `${chId}.json`)) as { version: 1; marks: Mark[] };
  assert.ok(validateHoardMarksV1(saved), JSON.stringify(validateHoardMarksV1.errors));
  const paragraphs = ['The gulls always cried.', 'She waited there.', 'A lone {>>note<<} stays.'];
  assert.equal(readFileSync(path.join(library, bookId, 'chapters', `${chId}.html`), 'utf8'), paragraphsHtml(paragraphs));
  assert.deepEqual(saved.marks.map((m) => [m.kind, m.state, m.proposed ?? null, m.thread.map((e) => e.body), locate(paragraphs, m.anchor)]), [
    ['insertion', 'open', 'grey ', [], { pIdx: 0, off: 4, len: 0 }],
    ['deletion', 'open', null, [], { pIdx: 0, off: 10, len: 7 }],
    ['comment', 'open', null, ['For whom?'], { pIdx: 1, off: 4, len: 6 }],
  ]);
});

test('nothing is written when nothing is new, and no wiki is made for it', async (t) => {
  const { library, wiki, page } = setup(t);
  const done = await wiki.apply(wiki.sort([path.join(page('x/Real.md', 'x'), '..', 'Missing.md')]), null);
  assert.deepEqual(done.imported, []);
  assert.equal(existsSync(path.join(library, '.neo')), false);
  assert.equal(wiki.wikiId(), null);
});

test('a manifest that does not read stops the import before anything is written', async (t) => {
  const { library, wiki, page } = setup(t);
  mkdirSync(path.join(library, '.neo'), { recursive: true });
  writeFileSync(path.join(library, '.neo', 'manifest.jsonl'), '{not json\n');
  await assert.rejects(wiki.apply(wiki.sort([page('a/Page.md', 'x\n')]), null), ManifestError);
  assert.equal(wiki.wikiId(), null);
  assert.deepEqual(readdirSync(library).filter((f) => f.startsWith('book-')), []);
});

test('importing while the wiki is open is refused, and nothing is written', async (t) => {
  const { library, wiki, page } = setup(t);
  await wiki.apply(wiki.sort([page('a/One.md', '1\n')]), null);
  const bookId = wiki.wikiId()!;
  const before = readFileSync(path.join(library, bookId, 'book.json'), 'utf8');
  await assert.rejects(wiki.apply(wiki.sort([page('a/Two.md', '2\n')]), bookId), /open/);
  assert.equal(readFileSync(path.join(library, bookId, 'book.json'), 'utf8'), before);
});

// Rule: the wiki pane reads one page as its chapter file holds it, with the title the
// wiki's book.json gives it; a page the wiki does not list is not read.
test('a page is read for the pane by its chapter id, and only a page of the wiki', async (t) => {
  const { library, wiki, page } = setup(t);
  assert.equal(wiki.page('ch-none'), null, 'no wiki yet');
  await wiki.apply(wiki.sort([page('lore/Fox.md', 'Red [[Owl]].\n')]), null);
  const bookId = wiki.wikiId()!;
  const [chId] = bookOf(library, bookId).chapterOrder;
  assert.deepEqual(wiki.page(chId), { bookId, chId, title: 'Fox', html: '<p>Red [[Owl]].</p>' });
  assert.equal(wiki.page('ch-not-listed'), null);
  assert.throws(() => wiki.page('../book.json'), TypeError);
});
