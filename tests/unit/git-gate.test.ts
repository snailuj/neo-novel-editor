// Rules the pre-commit gate keeps, each over the files a commit stages:
// Sidecar-Fits-Its-Schema: a sidecar of a known kind that will not parse or breaks its
//   schema is a finding naming the file; a .neo file of no known kind is left alone.
// Frontmatter-Fits-The-Scheme: a page sidecar's frontmatter is judged by lint's FM and
//   PR rules against the library's scheme, or the neutral one without it.
// Block-Ids-Unique: no two blocks of one chapter share a data-block id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFiles, type StagedFile } from '../../src/hoard/git/gate.ts';

const page = (frontmatter: unknown) => JSON.stringify({
  version: 1,
  source: { path: '/vault/lore/Harbour.md', name: 'Harbour', sha256: 'a'.repeat(64) },
  frontmatter,
  imported: '2026-10-15T10:00:00Z',
});
const PAGE = '.neo/book-wiki-1/pages/ch-1.json';
const rules = (files: StagedFile[], scheme?: string) => checkFiles(files, { schemeText: () => scheme ?? null })
  .map((f) => `${f.path}|${f.rule}`);

test('a clean set of staged files gives no finding', () => {
  const files: StagedFile[] = [
    { path: '.neo/wiki.json', text: '{"version":1,"bookId":"book-wiki-1"}' },
    { path: PAGE, text: page({ type: 'subject' }) },
    { path: '.neo/book-wiki-1/chapters/ch-1.json', text: '{"version":1,"marks":[]}' },
    { path: 'book-wiki-1/chapters/ch-1.html', text: '<p data-block="b1">One.</p>\n<p data-block="b2">Two.</p>' },
    { path: 'library.json', text: '{}' },
  ];
  assert.deepEqual(checkFiles(files, { schemeText: () => null }), []);
});

test('Sidecar-Fits-Its-Schema: each known sidecar that breaks its schema or will not parse is named', () => {
  const files: StagedFile[] = [
    { path: '.neo/wiki.json', text: '{"version":2,"bookId":"book-wiki-1"}' },
    { path: PAGE, text: '{"version":1' },
    { path: '.neo/book-wiki-1/chapters/ch-1.json', text: '{"version":1,"marks":"none"}' },
    { path: '.neo/changes.jsonl', text: '{"version":1,"at":"2026-10-15T10:00:00Z","kind":"page-imported","bookId":"b","chId":"c","dest":"d","src":"s"}\n{"version":1}\n' },
    { path: '.neo/manifest.jsonl', text: '{"dest":"x"}\n' },
    { path: '.neo/scheme.json', text: '{"colours":[]}' },
  ];
  const found = checkFiles(files, { schemeText: () => null });
  assert.deepEqual(found.map((f) => `${f.path}|${f.rule}`), [
    '.neo/wiki.json|Sidecar-Fits-Its-Schema',
    `${PAGE}|Sidecar-Fits-Its-Schema`,
    '.neo/book-wiki-1/chapters/ch-1.json|Sidecar-Fits-Its-Schema',
    '.neo/changes.jsonl|Sidecar-Fits-Its-Schema',
    '.neo/manifest.jsonl|Sidecar-Fits-Its-Schema',
    '.neo/scheme.json|Sidecar-Fits-Its-Schema',
  ]);
  assert.match(found[3]!.message, /line 2/);
});

test('Sidecar-Fits-Its-Schema: a .neo file of no known kind, and any file outside .neo, is left alone', () => {
  assert.deepEqual(rules([
    { path: '.neo/notes.txt', text: '{' },
    { path: '.neo/book-wiki-1/other/x.json', text: '{' },
    { path: 'book-fox-1/book.json', text: '{' },
  ]), []);
});

test('Frontmatter-Fits-The-Scheme: a page\'s frontmatter breaking the scheme gives lint\'s finding for it', () => {
  const found = checkFiles([{ path: PAGE, text: page({ type: 'lore', colour: 'red' }) }], { schemeText: () => null });
  assert.deepEqual(found.map((f) => f.message), [
    "FM3 unknown key 'colour'",
    "FM10 'setting' required on lore (or the page is a 'subject')",
  ]);
  assert.ok(found.every((f) => f.path === PAGE && f.rule === 'Frontmatter-Fits-The-Scheme'));
});

test('Frontmatter-Fits-The-Scheme: a page with no frontmatter is lint\'s FM1', () => {
  const found = checkFiles([{ path: PAGE, text: page(null) }], { schemeText: () => null });
  assert.deepEqual(found.map((f) => f.message), ['FM1 missing frontmatter']);
});

test('Frontmatter-Fits-The-Scheme: lint\'s body and path rules stay out, so a generator is no finding', () => {
  const fm = { type: 'subject', provenance: { generator: 'librarian', method: 'converted' } };
  assert.deepEqual(rules([{ path: PAGE, text: page(fm) }]), []);
});

test('Frontmatter-Fits-The-Scheme: the library\'s scheme decides what passes', () => {
  const files: StagedFile[] = [{ path: PAGE, text: page({ type: 'creature' }) }];
  assert.deepEqual(rules(files), [`${PAGE}|Frontmatter-Fits-The-Scheme`]);
  assert.deepEqual(rules(files, '{"types":["creature"]}'), []);
});

test('Frontmatter-Fits-The-Scheme: a scheme file that will not load is a finding, and the neutral scheme judges', () => {
  const files: StagedFile[] = [{ path: PAGE, text: page({ type: 'creature' }) }];
  assert.deepEqual(rules(files, '{"types":'), [
    '.neo/scheme.json|Sidecar-Fits-Its-Schema',
    `${PAGE}|Frontmatter-Fits-The-Scheme`,
  ]);
});

test('Frontmatter-Fits-The-Scheme: the scheme is read only when a page is staged', () => {
  let reads = 0;
  checkFiles([{ path: 'book-fox-1/chapters/c1.html', text: '<p>One.</p>' }], { schemeText: () => { reads++; return null; } });
  assert.equal(reads, 0);
  checkFiles([{ path: PAGE, text: page({ type: 'subject' }) }], { schemeText: () => { reads++; return null; } });
  assert.equal(reads, 1);
});

test('Block-Ids-Unique: each repeated data-block id in a chapter is one finding', () => {
  const html = ['<p data-block="b1">One.</p>', '<p class="hy" data-block="b1">One, split.</p>',
    '<p data-block="b2">Two.</p>', '<p data-block="b1">Again.</p>', '<p data-block="b2">Two.</p>'].join('\n');
  const found = checkFiles([{ path: 'book-wiki-1/chapters/ch-1.html', text: html }], { schemeText: () => null });
  assert.deepEqual(found.map((f) => `${f.rule}|${f.message}`), [
    "Block-Ids-Unique|block id 'b1' is on 3 blocks",
    "Block-Ids-Unique|block id 'b2' is on 2 blocks",
  ]);
});

test('Block-Ids-Unique: ids are judged per chapter, so two chapters may each hold b1', () => {
  assert.deepEqual(rules([
    { path: 'book-wiki-1/chapters/ch-1.html', text: '<p data-block="b1">One.</p>' },
    { path: 'book-wiki-1/chapters/ch-2.html', text: '<p data-block="b1">Two.</p>' },
  ]), []);
});

test('Block-Ids-Unique: a file that only looks like a chapter is not judged', () => {
  assert.deepEqual(rules([
    { path: 'book-wiki-1/notes-ch-1.html', text: '<p data-block="b1"></p><p data-block="b1"></p>' },
    { path: 'book-wiki-1/chapters/deeper/ch-1.html', text: '<p data-block="b1"></p><p data-block="b1"></p>' },
  ]), []);
});
