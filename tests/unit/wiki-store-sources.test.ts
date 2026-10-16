// Rules for bringing an old vault's pages into the wiki:
// - a source that changed updates its page in place when NEO has not changed the page,
//   keeping every mark on it; when NEO has changed it too, the new source comes in as
//   the next page, and later imports follow that newest page;
// - a list entry may name the page, and may take one or more sections of a source,
//   which become one page recorded as a split, without the source's frontmatter;
// - a line range takes those lines of the whole file, and is refused once the file no
//   longer has the hash the list read it against, or is too short for it;
// - a store for another book (Morning Pages) makes that book, named in .neo/books, and
//   leaves the wiki alone;
// - a page hoard already holds (by hoard's own manifest) is not imported again, an
//   older hoard copy is named, and hoard's own pages are never taken for either;
// - a page's images and PDFs are copied into the wiki book once, recorded verbatim
//   and logged, and the ones the vault lacks are named;
// - every change line and page sidecar is checked against its schema.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateHoardChangeV1, validateHoardPageV1 } from '../../src/generated/validators.cjs';
import { paragraphTexts } from '../../src/hoard/html.ts';
import { MarkStore } from '../../src/hoard/marks/store.ts';
import { bookSlug, WikiStore } from '../../src/hoard/wiki/store.ts';
import { parseManifest } from '../../src/librarian/manifest.ts';
import { tempDir } from './git-support.ts';

type T = { after(fn: () => void): void };

function setup(t: T) {
  const library = tempDir(t, 'hoard-lib-');
  const root = tempDir(t, 'hoard-disk-');
  let n = 0;
  let clock = Date.parse('2026-10-15T22:00:00.000Z');
  const now = () => new Date((clock += 1000));
  const newId = (prefix: string) => `${prefix}-t${(n++).toString().padStart(4, '0')}`;
  const log = () => {};
  const marks = new MarkStore({ library: () => library, now, newId, log });
  const wiki = new WikiStore({ library: () => library, now, newId, marks, log });
  const other = (book: string) => new WikiStore({ library: () => library, now, newId, marks, log, book });
  const put = (rel: string, data: string | Buffer) => {
    const file = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return file;
  };
  const json = (rel: string) => JSON.parse(readFileSync(path.join(library, rel), 'utf8'));
  const book = () => json(`${wiki.wikiId()}/book.json`);
  const titles = () => { const b = book(); return b.chapterOrder.map((id: string) => b.chapterTitles[id]); };
  const text = (chId: string) => paragraphTexts(readFileSync(path.join(library, wiki.wikiId()!, 'chapters', `${chId}.html`), 'utf8'));
  const manifest = () => parseManifest(readFileSync(path.join(library, '.neo', 'manifest.jsonl'), 'utf8'));
  const changes = () => readFileSync(path.join(library, '.neo', 'changes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const kinds = (sorted: { verdicts: { kind: string; name: string }[] }) => sorted.verdicts.map((v) => [v.kind, v.name]);
  return { library, root, wiki, other, marks, put, json, book, titles, text, manifest, changes, kinds };
}

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

test('a changed source updates a page NEO has not changed, and keeps the marks on it', async (t) => {
  const s = setup(t);
  const owl = s.put('vault/Owl.md', '---\ntype: lore\n---\nGrey.\nHunts at night.\n');
  await s.wiki.apply(s.wiki.sort([owl]), null);
  const bookId = s.wiki.wikiId()!;
  const [chId] = s.book().chapterOrder;
  await s.marks.add({ bookId, chId, kind: 'comment', body: 'Which night?', anchor: { exact: 'Hunts at night.', prefix: 'Grey.\n', suffix: '', pIdx: 1, off: 0 } }, 'author');

  writeFileSync(owl, '---\ntype: lore\ntags: [bird]\n---\nGrey and white.\nHunts at night.\n');
  const sorted = s.wiki.sort([owl]);
  assert.deepEqual(s.kinds(sorted), [['update', 'Owl']]);
  const done = await s.wiki.apply(sorted, null);
  assert.deepEqual(done.updated.map((p) => [p.chId, p.name]), [[chId, 'Owl']]);
  assert.deepEqual(s.titles(), ['Owl']);
  assert.deepEqual(s.text(chId), ['Grey and white.', 'Hunts at night.']);
  const sidecar = s.json(`.neo/${bookId}/pages/${chId}.json`);
  assert.ok(validateHoardPageV1(sidecar), JSON.stringify(validateHoardPageV1.errors));
  assert.deepEqual([sidecar.source.sha256, sidecar.frontmatter], [sha(readFileSync(owl)), { type: 'lore', tags: ['bird'] }]);
  const dest = `${bookId}/chapters/${chId}.html`;
  assert.deepEqual(s.manifest().filter((r) => r.dest === dest).map((r) => [r.method, r.src_sha256]),
    [['converted', s.manifest()[0]!.src_sha256], ['converted', sidecar.source.sha256]]);
  assert.deepEqual(s.changes().map((c) => c.kind), ['page-imported', 'page-updated']);
  for (const c of s.changes()) assert.ok(validateHoardChangeV1(c), JSON.stringify(validateHoardChangeV1.errors));
  const kept = s.json(`.neo/${bookId}/chapters/${chId}.json`).marks;
  assert.deepEqual(kept.map((m: { thread: { body: string }[] }) => m.thread[0]!.body), ['Which night?']);
  assert.deepEqual(s.kinds(s.wiki.sort([owl])), [['same', 'Owl']]);
});

test('a changed source of a page NEO changed too comes in as the next page, which later imports follow', async (t) => {
  const s = setup(t);
  const owl = s.put('vault/Owl.md', 'Grey.\n');
  const fox = s.put('vault/Fox.md', 'Red.\n');
  await s.wiki.apply(s.wiki.sort([owl, fox]), null);
  const bookId = s.wiki.wikiId()!;
  const [foxId, owlId] = s.book().chapterOrder;
  const owlFile = path.join(s.library, bookId, 'chapters', `${owlId}.html`);
  writeFileSync(owlFile, readFileSync(owlFile, 'utf8').replace('Grey.', 'Grey, written in NEO.'));

  writeFileSync(owl, 'Grey and white.\n');
  const sorted = s.wiki.sort([owl]);
  assert.deepEqual(s.kinds(sorted), [['beside', 'Owl (source changed 2026-10-15)']]);
  const done = await s.wiki.apply(sorted, null);
  assert.deepEqual(s.titles(), ['Fox', 'Owl', 'Owl (source changed 2026-10-15)']);
  const besideId = s.book().chapterOrder[2];
  assert.deepEqual(done.imported.map((p) => p.chId), [besideId]);
  assert.deepEqual([s.text(owlId), s.text(besideId)], [['Grey, written in NEO.'], ['Grey and white.']]);
  assert.equal(s.book().chapterKinds[besideId], 'unnumbered');
  assert.notEqual(foxId, besideId);

  assert.deepEqual(s.kinds(s.wiki.sort([owl])), [['same', 'Owl (source changed 2026-10-15)']]);
  writeFileSync(owl, 'Grey, white and brown.\n');
  const again = s.wiki.sort([owl]);
  assert.deepEqual(s.kinds(again), [['update', 'Owl (source changed 2026-10-15)']]);
  await s.wiki.apply(again, null);
  assert.deepEqual([s.text(owlId), s.text(besideId)], [['Grey, written in NEO.'], ['Grey, white and brown.']]);
});

test('a list entry names its page, and sections of a source become one page recorded as a split', async (t) => {
  const s = setup(t);
  const hub = s.put('hoard/projects/tide-(project).md', [
    '---', 'type: project', '---', '# Tide', '## Overview', 'The era.', '## Tasks', '- [ ] a task', '## Peoples', 'Boat folk.', '',
  ].join('\n'));
  const fox = s.put('vault/Fox.md', 'Red.\n');
  const sorted = s.wiki.sort([
    { path: hub, section: 'Overview', name: 'tide-(era)' },
    { path: hub, section: 'Peoples', name: 'tide-(era)' },
    { path: hub, section: 'Nowhere', name: 'tide-(lost)' },
    { path: fox, name: 'Fox-(animal)' },
  ]);
  assert.deepEqual(s.kinds(sorted), [['new', 'Fox-(animal)'], ['new', 'tide-(era)'], ['unreadable', 'tide-(lost)']]);
  assert.match((sorted.verdicts[2] as { why: string }).why, /no heading “Nowhere”/);
  await s.wiki.apply(sorted, null);
  const bookId = s.wiki.wikiId()!;
  assert.deepEqual(s.titles(), ['Fox-(animal)', 'tide-(era)']);
  const eraId = s.book().chapterOrder[1];
  assert.deepEqual(s.text(eraId), ['Overview', 'The era.', 'Peoples', 'Boat folk.']);
  const sidecar = s.json(`.neo/${bookId}/pages/${eraId}.json`);
  assert.ok(validateHoardPageV1(sidecar), JSON.stringify(validateHoardPageV1.errors));
  assert.deepEqual([sidecar.source.sections, sidecar.source.name, sidecar.frontmatter], [['Overview', 'Peoples'], 'tide-(era)', null]);
  assert.deepEqual(s.manifest().map((r) => [r.method, r.src, r.src_sha256]), [
    ['converted', fox, sha(readFileSync(fox))], ['split', hub, sha(readFileSync(hub))],
  ]);
  assert.deepEqual(s.kinds(s.wiki.sort([{ path: hub, section: 'Overview', name: 'tide-(era)' }, { path: hub, section: 'Peoples', name: 'tide-(era)' }])),
    [['same', 'tide-(era)']]);
});

test('a line range takes those lines of the file, joined into one page, while the file keeps its hash', async (t) => {
  const s = setup(t);
  const daily = s.put('vault/Daily/2026-01-23.md', [
    '---', 'day: 23', '---', '## Morning Pages', '- [ ] a task', 'Woke early.', '', 'The sea again.', '## Habits', '- [x] walk', '',
  ].join('\n'));
  const hash = sha(readFileSync(daily)).slice(0, 12);
  const sorted = s.wiki.sort([
    { path: daily, section: 'L4-L4', name: '2026-01-23', sha: hash },
    { path: daily, section: 'L6-L8', name: '2026-01-23' },
    { path: daily, section: 'L6-L80', name: 'too-long' },
    { path: daily, section: 'L6-L8', name: 'moved', sha: 'deadbeef00' },
  ]);
  assert.deepEqual(s.kinds(sorted), [['new', '2026-01-23'], ['unreadable', 'moved'], ['unreadable', 'too-long']]);
  assert.match((sorted.verdicts[1] as { why: string }).why, /changed after the list was made/);
  assert.match((sorted.verdicts[2] as { why: string }).why, /only 10 lines, not 80/);
  await s.wiki.apply(sorted, null);
  const chId = s.book().chapterOrder[0];
  assert.deepEqual(s.text(chId), ['Morning Pages', 'Woke early.', 'The sea again.']);
  assert.deepEqual(s.json(`.neo/${s.wiki.wikiId()}/pages/${chId}.json`).source.sections, ['L4-L4', 'L6-L8']);
  writeFileSync(daily, `${readFileSync(daily, 'utf8')}More.\n`);
  const again = s.wiki.sort([{ path: daily, section: 'L4-L4', name: '2026-01-23', sha: hash }, { path: daily, section: 'L6-L8', name: '2026-01-23' }]);
  assert.deepEqual(s.kinds(again), [['unreadable', '2026-01-23']]);
});

test('a store for another book makes that book beside the wiki, named in .neo/books', async (t) => {
  const s = setup(t);
  const day = s.put('vault/Daily/2025-12-15.md', '# Day\n## Morning Pages\nRain on the roof.\n## Tasks\n- [ ] call\n');
  const lore = s.put('vault/Harbour.md', 'The harbour.\n');
  await s.wiki.apply(s.wiki.sort([lore]), null);
  const pages = s.other('Morning Pages');
  assert.equal(pages.title, 'Morning Pages');
  assert.equal(pages.wikiId(), null);
  const sorted = pages.sort([{ path: day, section: 'Morning Pages', name: '2025-12-15' }]);
  assert.deepEqual(s.kinds(sorted), [['new', '2025-12-15']]);
  await assert.rejects(async () => {
    await pages.apply(sorted, null);
    await pages.apply(pages.sort([{ path: lore, name: 'x' }]), pages.wikiId());
  }, /Morning Pages is open/);
  const bookId = pages.wikiId()!;
  assert.match(bookId, /^book-morning-pages-/);
  assert.deepEqual(s.json('.neo/books/morning-pages.json'), { version: 1, bookId });
  const book = s.json(`${bookId}/book.json`);
  assert.equal(book.title, 'Morning Pages');
  assert.deepEqual(book.chapterOrder.map((id: string) => book.chapterTitles[id]), ['2025-12-15']);
  assert.deepEqual(s.titles(), ['Harbour'], 'the wiki keeps only its own page');
  assert.notEqual(s.wiki.wikiId(), bookId);
  assert.deepEqual([bookSlug('Morning Pages'), bookSlug('Café / Notes!'), bookSlug('***')], ['morning-pages', 'cafe-notes', 'book']);
});

test('a page hoard already holds is not imported again, an older hoard copy is named, and hoard\'s own pages come in', async (t) => {
  const s = setup(t);
  const record = (src: string, bytes: string) => JSON.stringify({ src, dest: 'lore/x.md', method: 'verbatim', src_sha256: sha(bytes) });
  s.put('hoard/_meta/MANIFEST.jsonl', `${record('20_Atoms/Harbour.md', 'harbour')}\n${record('20_Atoms/Quay.md', 'quay v1')}\n`);
  const hoardPage = s.put('hoard/lore/Harbour.md', 'harbour');
  mkdirSync(path.join(s.root, 'old', '.obsidian'), { recursive: true });
  const harbour = s.put('old/20_Atoms/Harbour.md', 'harbour');
  const quay = s.put('old/20_Atoms/Quay.md', 'quay v2');
  const tide = s.put('old/20_Atoms/Tide.md', 'tide');
  const hoardQuay = s.put('hoard/lore/Quay.md', 'quay v1');

  assert.deepEqual(s.kinds(s.wiki.sort([quay])), [['new', 'Quay']], 'with no hoard page in the wiki, hoard is not known');
  await s.wiki.apply(s.wiki.sort([hoardPage]), null);
  assert.deepEqual(s.titles(), ['Harbour']);
  assert.deepEqual(s.kinds(s.wiki.sort([harbour, quay, tide])), [['through-hoard', 'Harbour'], ['hoard-older', 'Quay'], ['new', 'Tide']]);
  assert.deepEqual(s.kinds(s.wiki.sort([hoardQuay])), [['new', 'Quay']], 'a hoard page whose bytes match a source it took in is still hoard\'s own page');
});

test('a page\'s images are copied into the wiki book once, recorded verbatim and logged, and missing ones are named', async (t) => {
  const s = setup(t);
  mkdirSync(path.join(s.root, 'old', '.obsidian'), { recursive: true });
  const png = Buffer.from([137, 80, 78, 71, 0, 1]);
  const map = s.put('old/_attachments/Map.png', png);
  const harbour = s.put('old/lore/Harbour.md', 'See ![[Map.png|200]] and ![[Gone.png]].\n');
  const quay = s.put('old/lore/Quay.md', 'Also ![[Map.png]].\n');
  const sorted = s.wiki.sort([harbour, quay]);
  const fresh = sorted.verdicts.find((v) => v.name === 'Harbour') as { attachments: { file: string }[]; missing: string[] };
  assert.deepEqual([fresh.attachments.map((a) => a.file), fresh.missing], [[map], ['Gone.png']]);
  const done = await s.wiki.apply(sorted, null);
  const bookId = s.wiki.wikiId()!;
  assert.deepEqual([done.attachments, done.missing], [1, ['Gone.png']]);
  assert.deepEqual(readFileSync(path.join(s.library, bookId, 'attachments', 'Map.png')), png);
  const verbatim = s.manifest().filter((r) => r.method === 'verbatim');
  assert.deepEqual(verbatim.map((r) => [r.src, r.dest, r.file_sha256, r.src_sha256]), [[map, `${bookId}/attachments/Map.png`, sha(png), sha(png)]]);
  const logged = s.changes().filter((c) => c.kind === 'attachment-imported');
  assert.deepEqual(logged.map((c) => [c.src, c.dest]), [[map, `${bookId}/attachments/Map.png`]]);
  for (const c of s.changes()) assert.ok(validateHoardChangeV1(c), JSON.stringify(validateHoardChangeV1.errors));
  const [harbourId] = s.book().chapterOrder;
  assert.deepEqual(s.text(harbourId), ['See ![[Map.png|200]] and ![[Gone.png]].'], 'the embed stays as written');
});
