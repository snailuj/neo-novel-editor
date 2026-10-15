// Ported from hoard's tests/test_relink.py, names made up: deterministic repair of links
// that only an alias answers, and target swaps for renames.
//
// Obsidian resolves a wikilink by basename or path and never by alias. A body link to an
// alias becomes `[[Basename|text-as-written]]` so the rendered text is byte-identical; a
// `topics` entry becomes the bare basename; a rename map swaps the target with no pipe
// added; a merge map pipes like an alias hit. The rewrite is permitted in author bytes too.
//
// Left out here: the receipt test (`test_piped_rewrite_is_invisible_to_quotes_normalise`)
// needs quotes.ts, which this branch does not have yet; `--apply` and its tests are not
// ported (Relink-Reports-Only); the `--check` command-line cases are in cli.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FrontmatterIntegrityError } from '../../../src/librarian/frontmatter.ts';
import { type Occurrence, WIKILINK } from '../../../src/librarian/links.ts';
import { PageIndex } from '../../../src/librarian/page-index.ts';
import {
  type Scope, type Target, parseMap, plan, reportLines, rewriteLink, rewriteText, validateMap,
} from '../../../src/librarian/relink.ts';

const MIRELO = '---\ntype: lore\nsetting: brs\naliases:\n- mirelo\n---\n';
const PAGE = '---\ntype: subject\n---\n';

function index(pages: Record<string, string>): PageIndex {
  return PageIndex.fromNotes(Object.entries(pages));
}

function occ(link: string, where: Occurrence['where'] = 'body', quote = ''): Occurrence {
  const m = new RegExp(WIKILINK.source, 'u').exec(link)!;
  const g = m.groups!;
  return {
    lineno: 1, where, embed: g['embed']!, target: g['target']!, anchor: g['anchor'] ?? '',
    display: g['display'] ?? '', span: [m.index, m.index + m[0].length], quote,
    value: where === 'topics' ? link : '',
  };
}

const target = (name: string, pipe = false): Target => ({ name, pipe });
const map = (entries: Record<string, Target>) => new Map(Object.entries(entries));
const NONE = new Map<string, Target>();

const IDX = index({ "lore/Mirel'o.md": MIRELO });

test('alias hit in a body is piped with the written text', () => {
  assert.equal(rewriteLink(occ('[[mirelo]]'), IDX, NONE), "[[Mirel'o|mirelo]]");
  assert.equal(rewriteLink(occ('[[mirelo|her]]'), IDX, NONE), "[[Mirel'o|her]]");
  // an anchored link rendered as its heading (quotes._display_text), so that is the pipe
  assert.equal(rewriteLink(occ('[[mirelo#Sheet]]'), IDX, NONE), "[[Mirel'o#Sheet|Sheet]]");
  assert.equal(rewriteLink(occ('[[mirelo#Sheet|her]]'), IDX, NONE), "[[Mirel'o#Sheet|her]]");
  assert.equal(rewriteLink(occ('![[mirelo]]'), IDX, NONE), "![[Mirel'o|mirelo]]");
});

test('basename, path, case and piped basename are left alone', () => {
  for (const link of ["[[Mirel'o]]", "[[MIREL'O]]", "[[lore/Mirel'o]]", "[[Mirel'o.md]]", "[[Mirel'o|she]]",
    '[[Nobody]]']) {
    assert.equal(rewriteLink(occ(link), IDX, NONE), null, link);
  }
});

test('alias hit in topics becomes the bare basename', () => {
  assert.equal(rewriteLink(occ('[[mirelo]]', 'topics', '"'), IDX, NONE), "[[Mirel'o]]");
});

test('a map swaps the target and keeps the display byte-exact', () => {
  const mapping = map({ 'The Lantern': target('The-Lantern') });
  assert.equal(rewriteLink(occ('[[The Lantern|Lantern]]'), IDX, mapping), '[[The-Lantern|Lantern]]');
  assert.equal(rewriteLink(occ('[[The Lantern#Era]]'), IDX, mapping), '[[The-Lantern#Era]]');
  assert.equal(rewriteLink(occ('[[The Lantern]]'), IDX, mapping), '[[The-Lantern]]');
  // byte-exact: a case variant is a different link and is not swapped
  assert.equal(rewriteLink(occ('[[the lantern]]'), IDX, mapping), null);
});

test('map pipe mode keeps the written text as display', () => {
  const mapping = map({ 'Folded-Sky': target('folded-sky-(project)', true) });
  assert.equal(rewriteLink(occ('[[Folded-Sky]]'), IDX, mapping), '[[folded-sky-(project)|Folded-Sky]]');
  assert.equal(rewriteLink(occ('[[Folded-Sky|Folded Sky]]'), IDX, mapping), '[[folded-sky-(project)|Folded Sky]]');
  assert.equal(rewriteLink(occ('[[Folded-Sky]]', 'topics', '"'), IDX, mapping), '[[folded-sky-(project)]]');
  // An anchored link rendered as its heading, exactly as the alias branch reads it;
  // pinning the written TARGET here changed the rendered text.
  assert.equal(rewriteLink(occ('[[Folded-Sky#Eras]]'), IDX, mapping), '[[folded-sky-(project)#Eras|Eras]]');
});

// After both renames of a page the key `the-lantern` belongs to the entity page; the hub
// links must still swap to the suffixed project page.
test('a map beats a live basename', () => {
  const idx = index({ 'lore/The-Lantern.md': PAGE });
  const mapping = map({ 'the-lantern': target('the-lantern-(project)') });
  assert.equal(rewriteLink(occ('[[the-lantern]]'), idx, mapping), '[[the-lantern-(project)]]');
});

test('never rewrites toward a ghost or a contested alias', () => {
  const ghost = index({ '_deprecated/2025-x.md': '---\naliases:\n- old-name\n---\n' });
  assert.equal(rewriteLink(occ('[[old-name]]'), ghost, NONE), null);
  const a = '---\ntype: subject\naliases:\n- x\n---\n';
  const contested = index({ 'lore/A.md': a, 'lore/B.md': a });
  assert.equal(rewriteLink(occ('[[x]]'), contested, NONE), null);
});

test('a unicode target is matched NFC and written as it was', () => {
  const nfd = 'Kirāṇeḥ'.normalize('NFD');
  const idx = index({
    'writing/kiraneh.md': '---\ntype: writing\naliases:\n- Kirāṇeḥ\nprovenance:\n  origin: o\n---\n',
  });
  assert.equal(rewriteLink(occ(`[[${nfd}]]`), idx, NONE), `[[kiraneh|${nfd}]]`);
});

// --- rewriteText: pure over one note ---

test('rewriteText rebuilds lines from spans and tags owners', () => {
  const text = '---\ntype: subject\ntopics:\n- "[[mirelo]]"\n- \'[[mirelo]]\'\n---\n'
    + 'See [[mirelo]] and `[[mirelo]]` and [[mirelo|her]].\n'
    + '```\n[[mirelo]]\n```\n';
  const { text: next, rewrites, notes } = rewriteText('lore/X.md', text, IDX, NONE);
  assert.equal(next, '---\ntype: subject\ntopics:\n- "[[Mirel\'o]]"\n- \'[[Mirel\'\'o]]\'\n---\n'
    + "See [[Mirel'o|mirelo]] and `[[mirelo]]` and [[Mirel'o|her]].\n"
    + '```\n[[mirelo]]\n```\n');
  assert.deepEqual(rewrites.map((r) => [r.lineno, r.where, r.owner, r.old, r.new]), [
    [4, 'topics', 'librarian', '"[[mirelo]]"', '"[[Mirel\'o]]"'],
    [5, 'topics', 'librarian', "'[[mirelo]]'", "'[[Mirel''o]]'"],
    [7, 'body', 'librarian', '[[mirelo]]', "[[Mirel'o|mirelo]]"],
    [7, 'body', 'librarian', '[[mirelo|her]]', "[[Mirel'o|her]]"]]);
  assert.deepEqual(notes, []);
  const again = rewriteText('lore/X.md', next, IDX, NONE);
  assert.equal(again.text, next);
  assert.deepEqual(again.rewrites, []);
});

test('rewriteText tags author body and human span owners', () => {
  const author = '---\ntype: writing\nprovenance:\n  origin: o\n---\nHis [[mirelo]].\n';
  assert.deepEqual(rewriteText('writing/a.md', author, IDX, NONE).rewrites.map((r) => r.owner), ['author-body']);
  const human = '---\ntype: subject\n---\n> [!human]- s\n\nHer [[mirelo]].\n\n'
    + '> [!librarian]- f\n\nOurs [[mirelo]].\n';
  assert.deepEqual(rewriteText('lore/H.md', human, IDX, NONE).rewrites.map((r) => [r.lineno, r.owner]),
    [[6, 'human-span'], [10, 'librarian']]);
});

test('rewriteText preserves CRLF and a missing trailing newline', () => {
  const crlf = '---\r\ntype: subject\r\n---\r\nSee [[mirelo]].\r\n';
  assert.equal(rewriteText('lore/X.md', crlf, IDX, NONE).text,
    "---\r\ntype: subject\r\n---\r\nSee [[Mirel'o|mirelo]].\r\n");
  assert.equal(rewriteText('lore/X.md', 'See [[mirelo]]', IDX, NONE).text, "See [[Mirel'o|mirelo]]");
});

test('rewriteText refuses flow-style topics and says so', () => {
  const text = '---\ntype: writing\ntopics: ["[[mirelo]]"]\nprovenance:\n  origin: o\n---\nP.\n';
  const { text: next, rewrites, notes } = rewriteText('writing/x.md', text, IDX, NONE);
  assert.equal(next, text);
  assert.deepEqual(rewrites, []);
  assert.deepEqual(notes, ['writing/x.md:3: not rewritten: `topics` item [[mirelo]] is '
    + 'not a quoted block-list scalar -- edit it by hand']);
});

test('rewriteText never touches legacy frontmatter', () => {
  const text = '---\ntype: writing\nprovenance:\n  origin: o\n  legacy_frontmatter: |\n'
    + '    Topics:: [[mirelo]]\n---\nP.\n';
  const { text: next, rewrites } = rewriteText('writing/x.md', text, IDX, NONE);
  assert.equal(next, text);
  assert.deepEqual(rewrites, []);
});

// A bare `|` inside a markdown table cell splits the cell; Obsidian's own form for a
// display alias in a table is `[[Note\|text]]`. So in a table row the pipe is written
// escaped, the rendered text stays byte-identical, and a pipe map does the same.
test('table rows use the escaped pipe Obsidian reads', () => {
  const text = '| Page | Type |\n| --- | --- |\n| [[mirelo]] | lore |\n| [[Folded-Sky]] | lore |\n';
  const mapping = map({ 'Folded-Sky': target('folded-sky-(project)', true) });
  const { text: next, notes } = rewriteText('lore/X.md', text, IDX, mapping);
  assert.equal(next, "| Page | Type |\n| --- | --- |\n| [[Mirel'o\\|mirelo]] | lore |\n"
    + '| [[folded-sky-(project)\\|Folded-Sky]] | lore |\n');
  assert.deepEqual(notes, []);
  const again = rewriteText('lore/X.md', next, IDX, mapping);
  assert.equal(again.text, next);
  assert.deepEqual(again.rewrites, []);
});

// Not in hoard's tests: the postcondition relink.py keeps on a requoted scalar. `\n` in a
// double-quoted item loads as a newline, which a requote writes raw and YAML folds to a
// space, so the new scalar would not read back as the value meant. It throws, never writes.
test('a requoted topics item that would not parse back throws', () => {
  const text = '---\ntype: subject\ntopics:\n- "[[mirelo]]\\nX"\n---\nP.\n';
  assert.throws(() => rewriteText('lore/X.md', text, IDX, NONE), (err: unknown) => (
    err instanceof FrontmatterIntegrityError
    && err.message === 'relink: requoted topics item does not parse back (lore/X.md:4)'));
});

test('protectedLines, when given, decides which body lines are the author\'s', () => {
  const text = `${PAGE}One [[mirelo]].\nTwo [[mirelo]].\n`;
  const { rewrites } = rewriteText('lore/X.md', text, IDX, NONE, null, false, { protectedLines: () => new Set([5]) });
  assert.deepEqual(rewrites.map((r) => [r.lineno, r.owner]), [[4, 'librarian'], [5, 'human-span']]);
});

// --- maps ---

test('parseMap reads pairs and a map file', () => {
  const file = '# comment\nThe Lantern -> The-Lantern\n\nthe-lantern -> the-lantern-(project)\n';
  assert.deepEqual(parseMap(['Salt Harbour=Salt-Harbour'], ['Folded-Sky=folded-sky-(project)'], file), map({
    'Salt Harbour': target('Salt-Harbour'),
    'Folded-Sky': target('folded-sky-(project)', true),
    'The Lantern': target('The-Lantern'),
    'the-lantern': target('the-lantern-(project)'),
  }));
});

test('validateMap refuses a live old name and self maps', () => {
  const idx = index({ 'lore/The Lantern.md': PAGE });
  assert.deepEqual(validateMap(map({ 'The Lantern': target('The-Lantern') }), idx).errors,
    ["map: 'The Lantern' is still a live basename (lore/The Lantern.md) -- git mv first"]);
  assert.deepEqual(validateMap(map({ x: target('x') }), idx).errors, ["map: 'x' maps to itself"]);
  assert.deepEqual(validateMap(map({ 'Salt Harbour': target('Salt-Harbour') }),
    index({ 'writing/path/salt-harbour.md': PAGE })).notes,
  ['map: [[Salt-Harbour]] resolves to writing/path/salt-harbour.md']);
  assert.deepEqual(validateMap(map({ Old: target('Nowhere') }), idx).notes,
    ['map: [[Nowhere]] has no page; the link will be unresolved by design']);
});

// --- plan and its report: what `relink --check` prints, minus the disk ---

test('plan reports pending rewrites over the librarian zone and writes nothing', () => {
  const notes: [string, string][] = [
    ["lore/Mirel'o.md", MIRELO],
    ['lore/X.md', `${PAGE}See [[mirelo]].\n`],
    ['inbox/i.md', 'See [[mirelo]].\n'],
    ['INDEX.md', 'See [[mirelo]].\n'],
  ];
  const report = plan(notes, NONE, 'all');
  assert.deepEqual(Object.keys(report.texts), ['lore/X.md', 'INDEX.md']);
  assert.equal(notes[1]![1], `${PAGE}See [[mirelo]].\n`);
  assert.deepEqual(reportLines(report.rewrites, report.notes, 'pending'), [
    "lore/X.md:4: [[mirelo]] -> [[Mirel'o|mirelo]]  [librarian]",
    "INDEX.md:1: [[mirelo]] -> [[Mirel'o|mirelo]]  [librarian]",
    '2 rewrite(s) pending in 2 file(s): 2 librarian']);
});

test('plan scope splits author bytes from the librarian\'s', () => {
  const notes: [string, string][] = [
    ["lore/Mirel'o.md", MIRELO],
    ['lore/X.md', `${PAGE}> [!human]- s\n\nHer [[mirelo]].\n\n> [!librarian]- f\n\nOurs [[mirelo]].\n`],
    ['writing/a.md', '---\ntype: writing\nprovenance:\n  origin: o\n---\nHis [[mirelo]].\n'],
  ];
  const owners = (scope: Scope) => plan(notes, NONE, scope).rewrites.map((r) => `${r.relpath}:${r.lineno} ${r.owner}`);
  assert.deepEqual(owners('librarian'), ['lore/X.md:10 librarian']);
  assert.deepEqual(owners('author'), ['lore/X.md:6 human-span', 'writing/a.md:6 author-body']);
  const all = plan(notes, NONE, 'all');
  assert.equal(reportLines(all.rewrites, all.notes, 'pending').at(-1),
    '3 rewrite(s) pending in 2 file(s): 1 librarian, 1 human-span, 1 author-body');
});

test('plan with a map swaps, notes a case-only near match and refuses a live old name', () => {
  const notes: [string, string][] = [
    ['lore/The-Lantern.md', PAGE], ['lore/X.md', `${PAGE}[[The Lantern|Lantern]] and [[the lantern]]\n`]];
  const report = plan(notes, map({ 'The Lantern': target('The-Lantern') }), 'all');
  assert.equal(report.texts['lore/X.md'], `${PAGE}[[The-Lantern|Lantern]] and [[the lantern]]\n`);
  assert.deepEqual(report.notes, ['map: [[The-Lantern]] resolves to lore/The-Lantern.md',
    "map: [[the lantern]] matches 'The Lantern' by case only -- not swapped (lore/X.md:4)"]);
  assert.throws(() => plan([['lore/The Lantern.md', PAGE]], map({ 'The Lantern': target('The-Lantern') }), 'all'),
    /still a live basename/);
});

// A rename or merge is one operation with one LOG line; the alias half is another.
test('plan mapOnly leaves alias hits for a later run, and needs a map', () => {
  const notes: [string, string][] = [["lore/Mirel'o.md", MIRELO], ['lore/The-Lantern.md', PAGE],
    ['lore/X.md', `${PAGE}[[The Lantern]] and [[mirelo]]\n`]];
  const report = plan(notes, map({ 'The Lantern': target('The-Lantern') }), 'all', true);
  assert.equal(report.texts['lore/X.md'], `${PAGE}[[The-Lantern]] and [[mirelo]]\n`);
  assert.throws(() => plan(notes, NONE, 'all', true), /--map-only needs at least one --map entry/);
});

test('reportLines says nothing of counts when nothing is pending', () => {
  assert.deepEqual(reportLines([], ['a note'], 'pending'), ['a note']);
});
