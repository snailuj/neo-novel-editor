// Rules the gate keeps over page files (wiki/**/*.html, sources/**/*.html) and the
// sidecars beside them:
// Block-Ids-Citable: a page in either tree has the block-id check a chapter has, so an id
//   a citation cannot name (an empty one included) is a finding.
// Citations-Resolve: a [[Page#^id]] citation in a page in either tree names a page by
//   title, a wiki page winning over a source with the same title, and a block that page has.
// Sidecar-Fits-Its-Schema: a page sidecar fits hoard-page-v1 and a page marks file fits
//   hoard-marks-v1.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFiles, type CheckContext, type StagedFile } from '../../src/hoard/git/gate.ts';

const NONE: CheckContext = { schemeText: () => null };
const rules = (files: StagedFile[], context: CheckContext = NONE) => checkFiles(files, context).map((f) => `${f.path}|${f.rule}`);

/** A library of pages: id to html. */
function library(pages: Record<string, string>): CheckContext {
  return {
    schemeText: () => null,
    pages: () => Object.keys(pages).map((id) => {
      const tree = id.startsWith('wiki/') ? 'wiki' as const : 'sources' as const;
      return { id, tree, title: id.slice(id.lastIndexOf('/') + 1).replace(/\.html$/, '') };
    }),
    pageHtml: (id) => pages[id] ?? null,
  };
}

const sidecar = (over: object = {}) => JSON.stringify({
  version: 1,
  source: { path: '/vault/lore/Harbour.md', name: 'Harbour', sha256: 'a'.repeat(64) },
  frontmatter: { type: 'subject' },
  imported: '2026-10-15T10:00:00Z',
  ...over,
});

test('Block-Ids-Citable: a page in either tree has the id check a chapter has', () => {
  const html = '<p data-block="b1">One.</p>\n<p data-block="">Empty.</p>\n<p data-block="b 2">Spaced.</p>';
  const found = checkFiles([
    { path: 'wiki/People/Harbour.html', text: html },
    { path: 'sources/Notes/Log.html', text: html },
    { path: 'book-fox-1/chapters/c1.html', text: html },
  ], NONE);
  assert.deepEqual(found.map((f) => `${f.path}|${f.rule}|${f.message}`), [
    "wiki/People/Harbour.html|Block-Ids-Citable|block id '' cannot be cited (letters, digits and hyphens only)",
    "wiki/People/Harbour.html|Block-Ids-Citable|block id 'b 2' cannot be cited (letters, digits and hyphens only)",
    "sources/Notes/Log.html|Block-Ids-Citable|block id '' cannot be cited (letters, digits and hyphens only)",
    "sources/Notes/Log.html|Block-Ids-Citable|block id 'b 2' cannot be cited (letters, digits and hyphens only)",
    "book-fox-1/chapters/c1.html|Block-Ids-Citable|block id '' cannot be cited (letters, digits and hyphens only)",
    "book-fox-1/chapters/c1.html|Block-Ids-Citable|block id 'b 2' cannot be cited (letters, digits and hyphens only)",
  ]);
});

test('Block-Ids-Citable: clean pages, a repeated id and files outside a tree are no finding', () => {
  assert.deepEqual(rules([
    { path: 'wiki/Harbour.html', text: '<p data-block="b1">One.</p>\n<p data-block="b1">One, split.</p>' },
    { path: 'sources/a/b/Log.html', text: '<p data-block="b-1">One.</p>' },
    { path: 'wiki/Harbour.md', text: '<p data-block="b 1"></p>' },
    { path: 'wiki/.hidden/Harbour.html', text: '<p data-block="b 1"></p>' },
    { path: 'elsewhere/Harbour.html', text: '<p data-block="b 1"></p>' },
  ]), []);
});

test('Citations-Resolve: a broken citation in a sources page is a finding, and in a wiki page too', () => {
  const lib = library({
    'wiki/Harbour.html': '<p data-block="h1">Docks.</p>',
    'sources/Log.html': '<p data-block="l1">See [[Harbour#^h1]], [[Harbour#^gone]] and [[Nowhere#^x]].</p>',
  });
  const found = checkFiles([
    { path: 'sources/Log.html', text: '<p data-block="l1">See [[Harbour#^h1]], [[Harbour#^gone]] and [[Nowhere#^x]].</p>' },
    { path: 'wiki/Mill.html', text: '<p data-block="m1">[[Log#^missing]]</p>' },
  ], lib);
  assert.deepEqual(found.map((f) => `${f.path}|${f.rule}|${f.message}`), [
    "sources/Log.html|Citations-Resolve|[[Harbour#^gone]] names no block 'gone' in wiki/Harbour.html",
    'sources/Log.html|Citations-Resolve|[[Nowhere#^x]] names no page',
    "wiki/Mill.html|Citations-Resolve|[[Log#^missing]] names no block 'missing' in sources/Log.html",
  ]);
});

test('Citations-Resolve: a citation resolves by title, and a wiki page wins over a source of the same title', () => {
  const lib = library({
    'wiki/Harbour.html': '<p data-block="w1">Wiki.</p>',
    'sources/Harbour.html': '<p data-block="s1">Source.</p>',
    'sources/Deep/Quay.html': '<p data-block="q1">Quay.</p>',
  });
  const cite = (link: string) => checkFiles([{ path: 'wiki/Mill.html', text: `<p data-block="m1">${link}</p>` }], lib).map((f) => f.message);
  assert.deepEqual(cite('[[Harbour#^w1]]'), []);
  assert.deepEqual(cite('[[harbour#^s1]]'), ["[[harbour#^s1]] names no block 's1' in wiki/Harbour.html"]);
  assert.deepEqual(cite('[[Deep/Quay#^q1|the quay]]'), [], 'a folder path and a display text are set aside');
});

test('Citations-Resolve: only a block citation counts, and code is documentation', () => {
  const lib = library({ 'wiki/Harbour.html': '<p data-block="h1">Docks.</p>' });
  assert.deepEqual(rules([
    { path: 'wiki/Mill.html', text: '<p data-block="m1">[[Nowhere]] and [[Nowhere#Heading]] and `[[Nowhere#^x]]`.</p>\n<p class="wiki-code" data-block="m2">[[Nowhere#^x]]</p>' },
  ], lib), []);
});

test('Citations-Resolve: the staged text of a page is what is cited, and a gate with no library listing judges none', () => {
  const lib = library({ 'wiki/Harbour.html': '<p data-block="old">Docks.</p>' });
  const files: StagedFile[] = [
    { path: 'wiki/Harbour.html', text: '<p data-block="new">Docks.</p>' },
    { path: 'wiki/Mill.html', text: '<p data-block="m1">[[Harbour#^new]]</p>' },
  ];
  assert.deepEqual(rules(files, lib), []);
  assert.deepEqual(rules([{ path: 'wiki/Mill.html', text: '<p data-block="m1">[[Nowhere#^x]]</p>' }]), []);
});

test('Citations-Resolve: the library is listed only when a staged page holds a citation', () => {
  let listed = 0;
  const context: CheckContext = { ...library({}), pages: () => { listed++; return []; } };
  checkFiles([{ path: 'wiki/Mill.html', text: '<p data-block="m1">No citation here.</p>' }], context);
  assert.equal(listed, 0);
  checkFiles([{ path: 'wiki/Mill.html', text: '<p data-block="m1">[[Nowhere#^x]]</p>' }], context);
  assert.equal(listed, 1);
});

test('Sidecar-Fits-Its-Schema: a bad page sidecar or page marks file is a finding, a good one is not', () => {
  assert.deepEqual(rules([
    { path: '.neo/pages/wiki/People/Harbour.html.json', text: sidecar() },
    { path: '.neo/pages/sources/Log.html.json', text: sidecar({ imported: 'yesterday' }) },
    { path: '.neo/pages/wiki/Mill.html.json', text: '{"version":1' },
    { path: '.neo/marks/wiki/People/Harbour.html.json', text: '{"version":1,"marks":[]}' },
    { path: '.neo/marks/sources/Log.html.json', text: '{"version":1,"marks":"none"}' },
    { path: '.neo/marks/wiki/Mill.html.json', text: '{' },
  ]), [
    '.neo/pages/sources/Log.html.json|Sidecar-Fits-Its-Schema',
    '.neo/pages/wiki/Mill.html.json|Sidecar-Fits-Its-Schema',
    '.neo/marks/sources/Log.html.json|Sidecar-Fits-Its-Schema',
    '.neo/marks/wiki/Mill.html.json|Sidecar-Fits-Its-Schema',
  ]);
});

test('Sidecar-Fits-Its-Schema: the rename journal and files outside a tree are left alone', () => {
  assert.deepEqual(rules([
    { path: '.neo/pages/.rename.json', text: '{' },
    { path: '.neo/pages/notes/Harbour.html.json', text: '{' },
    { path: '.neo/pages/wiki/Harbour.json', text: '{' },
    { path: '.neo/marks/other/Harbour.html.json', text: '{' },
  ]), []);
});

test('Frontmatter-Fits-The-Scheme: a page sidecar in either tree is judged against the library\'s scheme', () => {
  const found = checkFiles([
    { path: '.neo/pages/wiki/Harbour.html.json', text: sidecar({ frontmatter: { type: 'lore', colour: 'red' } }) },
    { path: '.neo/pages/sources/Log.html.json', text: sidecar({ frontmatter: { type: 'lore', colour: 'red' } }) },
  ], { schemeText: () => '{}' });
  assert.deepEqual(found.map((f) => `${f.path}|${f.message}`), [
    ".neo/pages/wiki/Harbour.html.json|FM3 unknown key 'colour'",
    ".neo/pages/wiki/Harbour.html.json|FM10 'setting' required on lore (or the page is a 'subject')",
    ".neo/pages/sources/Log.html.json|FM3 unknown key 'colour'",
    ".neo/pages/sources/Log.html.json|FM10 'setting' required on lore (or the page is a 'subject')",
  ]);
});

// Join-Keeps-Both-Ids: a block joined into the one above leaves its id in the survivor's
// data-alias (a space-separated list), and a citation of that id still resolves.
test('Citations-Resolve: an id in a block\'s data-alias is a block id of the page', () => {
  const lib = library({ 'wiki/Harbour.html': '<p data-block="b1" data-alias="b2 b3">Docks. Quay.</p><p data-alias="" data-block="b4">Mill.</p>' });
  const cite = (link: string) => checkFiles([{ path: 'wiki/Mill.html', text: `<p data-block="m1">${link}</p>` }], lib).map((f) => f.message);
  // the baseline: the survivor's own id resolves, and an id on no block does not
  assert.deepEqual(cite('[[Harbour#^b1]]'), []);
  assert.deepEqual(cite('[[Harbour#^b9]]'), ["[[Harbour#^b9]] names no block 'b9' in wiki/Harbour.html"]);
  assert.deepEqual(cite('[[Harbour#^b2]]'), []);
  assert.deepEqual(cite('[[Harbour#^b3]]'), []);
  // an empty alias list names no block
  assert.deepEqual(cite('[[Harbour#^]]').length, 1);
});
