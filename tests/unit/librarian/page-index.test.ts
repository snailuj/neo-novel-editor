// Ported from hoard's tests/test_lint.py: the PageIndex, human spans, the vault layout
// and the citation patterns, which dangling, quotes, relink and lint all share.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INLINE_CITE } from '../../../src/librarian/citations.ts';
import { captureLogs } from '../../../src/librarian/log.ts';
import { PageIndex } from '../../../src/librarian/page-index.ts';
import { HOARD_LAYOUT } from '../../../src/librarian/scheme.ts';
import { HUMAN_OPENER, LIBRARIAN_OPENER, humanSpanLines } from '../../../src/librarian/spans.ts';
import { includeAttachment, includeNote, zoneOf } from '../../../src/librarian/vault.ts';

/** PageIndex over relpath to text, in the order given. */
function index(pages: Record<string, string>): PageIndex {
  return PageIndex.fromNotes(Object.entries(pages));
}

const KELLA = "---\ntype: lore\nsetting: era\naliases:\n- kella\n---\n";
const PAGE_FM = '---\ntype: subject\n---\n';
const AUTHOR_NOTE = '---\ntype: writing\nproject: path\nprovenance:\n  origin: o\n'
  + "  method: verbatim\n---\nThe author's own prose.\n";

// Obsidian resolves by basename (case-folded) or path, never by alias.
test('resolve is by basename only', () => {
  const idx = index({ "lore/Kell'a.md": KELLA });
  assert.equal(idx.resolve('kella'), null);
  for (const form of ["Kell'a", "KELL'A", "lore/Kell'a", "Kell'a.md", "lore/Kell'a.md"]) {
    assert.equal(idx.resolve(form)?.relpath, "lore/Kell'a.md", form);
  }
});

test('resolveAlias and resolveAny', () => {
  const idx = index({ "lore/Kell'a.md": KELLA });
  assert.equal(idx.resolveAlias('kella')?.relpath, "lore/Kell'a.md");
  assert.equal(idx.resolveAlias("Kell'a"), null);
  assert.equal(idx.resolveAny('kella')?.relpath, "lore/Kell'a.md");
  assert.equal(idx.resolveAny("Kell'a")?.relpath, "lore/Kell'a.md");
  assert.equal(idx.resolveAny('nobody'), null);
});

// Basenames win, as in Obsidian: an alias that is also a page name can never reach its
// own page, and the index records the collision whichever page comes first.
test('an alias loses to another basename', () => {
  const lattice = '---\ntype: subject\naliases:\n- Tide\n---\n';
  const tide = '---\ntype: subject\n---\n';
  for (const order of [{ 'lore/Lattice.md': lattice, 'lore/Tide.md': tide },
    { 'lore/Tide.md': tide, 'lore/Lattice.md': lattice }]) {
    const idx = index(order);
    assert.equal(idx.resolve('Tide')?.relpath, 'lore/Tide.md');
    assert.equal(idx.resolveAlias('Tide'), null);
    assert.deepEqual(idx.collisions().map((c) => [c.kind, c.name, c.page, c.other]),
      [['alias-basename', 'Tide', 'lore/Lattice.md', 'lore/Tide.md']]);
  }
});

test('a contested alias resolves to nothing', () => {
  const a = '---\ntype: subject\naliases:\n- x\n---\n';
  const idx = index({ 'lore/A.md': a, 'lore/B.md': a });
  assert.equal(idx.resolveAlias('x'), null);
  assert.deepEqual(idx.collisions().map((c) => [c.kind, c.name, c.page, c.other]),
    [['alias-alias', 'x', 'lore/B.md', 'lore/A.md']]);
});

test('a basename collision is recorded and the first page wins', () => {
  const idx = index({ 'lore/Ember-Road.md': PAGE_FM, 'projects/ember-road.md': PAGE_FM });
  assert.equal(idx.resolve('ember-road')?.relpath, 'lore/Ember-Road.md');
  assert.deepEqual(idx.collisions().map((c) => [c.kind, c.name, c.page, c.other]),
    [['basename', 'ember-road', 'projects/ember-road.md', 'lore/Ember-Road.md']]);
});

test('an alias equal to its own basename is not a collision', () => {
  const idx = index({ 'lore/Saltmarsh.md': '---\ntype: lore\naliases:\n- saltmarsh\n---\n' });
  assert.deepEqual(idx.collisions(), []);
  assert.equal(idx.resolve('saltmarsh')?.relpath, 'lore/Saltmarsh.md');
});

test('entries are basenames only', () => {
  const idx = index({ "lore/Kell'a.md": KELLA });
  assert.deepEqual([...idx.entries()].map(([k]) => k), ["kell'a"]);
  assert.deepEqual([...idx.aliasEntries()].map(([k, a, p]) => [k, a, p.relpath]), [['kella', 'kella', "lore/Kell'a.md"]]);
});

test('keys are NFC', () => {
  const nfd = 'Ilōraḥ'.normalize('NFD');
  const idx = index({ 'writing/x.md': `---\ntype: writing\naliases:\n- ${nfd}\nprovenance:\n  origin: o\n---\n` });
  assert.equal(idx.resolveAlias('Ilōraḥ')?.relpath, 'writing/x.md');
  const idx2 = index({ 'writing/Ilōraḥ.md': AUTHOR_NOTE });
  assert.equal(idx2.resolve(nfd)?.relpath, 'writing/Ilōraḥ.md');
});

test('an attachment resolves by its full name with the extension', () => {
  const idx = new PageIndex();
  idx.addAttachment('writing/era-one/material/Outline-Canvas.canvas');
  assert.ok(idx.resolve('Outline-Canvas.canvas'));
  assert.ok(idx.resolve('outline-canvas.CANVAS'));
  assert.equal(idx.resolve('Outline-Canvas'), null);
});

// No-swallow rule: the index recovering from malformed frontmatter logs the skip.
test('a malformed frontmatter skip in the index is logged', () => {
  const { records } = captureLogs(() => PageIndex.fromNotes([['lore/x.md', '---\n: : :\n---\nbody\n']]));
  assert.ok(records.some((r) => r.logger === 'librarian.lint' && r.level === 'warning'
    && r.message.includes('link index skipped frontmatter')));
});

test('a page records its voices as a list of alternatives, trimmed', () => {
  const idx = index({
    'sources/a.md': '---\ntype: source\nprovenance:\n  author: Ada Vell, the Harbour Talk\n---\n',
    'sources/b.md': '---\ntype: source\nprovenance:\n  author: [Ada Vell, " Bram "]\n---\n',
  });
  assert.deepEqual(idx.resolve('a')!.voices, ['Ada Vell', 'the Harbour Talk']);
  assert.deepEqual(idx.resolve('b')!.voices, ['Ada Vell', 'Bram']);
});

// Callout type names are case-insensitive: `> [!Human]` opens a span, `> [!LIBRARIAN]` closes it.
test('marker recognition is case-insensitive', () => {
  assert.deepEqual(humanSpanLines('a\n> [!Human]- x\nb\nc\n> [!LIBRARIAN]\nd\n'), new Set([3, 4]));
});

test('a marker indented four spaces is code, not a marker', () => {
  assert.ok(HUMAN_OPENER.test('   > [!human]'));
  assert.ok(!HUMAN_OPENER.test('    > [!human]'));
  assert.ok(LIBRARIAN_OPENER.test('>[!librarian]- title'));
});

test('zones follow the layout', () => {
  assert.equal(zoneOf('lore/x.md', HOARD_LAYOUT), 'librarian');
  assert.equal(zoneOf('Daily/2026-10-15.md', HOARD_LAYOUT), 'as-is');
  assert.equal(zoneOf('_meta/LOG.md', HOARD_LAYOUT), 'infra');
  assert.equal(zoneOf('INDEX.md', HOARD_LAYOUT), 'infra');
});

// Fixture pages mimic real ones by design and would contest link keys, and a
// dot-directory is tooling, so neither is read as a note.
test('notes skip dot-directories, derived output and the test fixture tree', () => {
  assert.ok(includeNote('lore/Y.md', HOARD_LAYOUT));
  assert.ok(includeNote('.hidden.md', HOARD_LAYOUT));
  assert.ok(!includeNote('.git/README.md', HOARD_LAYOUT));
  assert.ok(!includeNote('lore/.obsidian/x.md', HOARD_LAYOUT));
  assert.ok(!includeNote('_meta/infra/tools/tests/fixtures/f/lore/X.md', HOARD_LAYOUT));
  assert.ok(!includeNote('_meta/infra/derived/x.md', HOARD_LAYOUT));
  assert.ok(!includeNote('lore/x.canvas', HOARD_LAYOUT));
});

test('attachments are the non-markdown files of the librarian zones, dotfiles left out', () => {
  assert.ok(includeAttachment('sources/Vision Hall.canvas', HOARD_LAYOUT));
  assert.ok(!includeAttachment('sources/.gitkeep', HOARD_LAYOUT));
  assert.ok(!includeAttachment('sources/note.md', HOARD_LAYOUT));
  assert.ok(!includeAttachment('_meta/x.png', HOARD_LAYOUT));
  assert.ok(!includeAttachment('lore/.cache/x.png', HOARD_LAYOUT));
});

test("an inline citation's target survives a table-escaped pipe", () => {
  const m = new RegExp(INLINE_CITE.source, 'u').exec('| "quoted" ([[the-mill\\|Path - The Mill]] -- Ada, opening) |');
  assert.equal(m?.[1], 'the-mill');
  assert.equal(m?.[2], 'Ada, opening');
});
