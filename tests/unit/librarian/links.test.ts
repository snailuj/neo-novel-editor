// Ported from hoard's tests/test_links.py: one wikilink grammar for every tool that reads
// or rewrites links, with the display half captured.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LINK_SRC, WIKILINK, isFence, key, linksIn, maskCodeSpans, occurrences,
} from '../../../src/librarian/links.ts';
import { captureLogs } from '../../../src/librarian/log.ts';
import { pyLen } from '../../../src/librarian/py.ts';

function groups(s: string): [string, string, string, string] {
  const m = new RegExp(WIKILINK.source, WIKILINK.flags.replace('g', '')).exec(s);
  assert.ok(m?.groups, s);
  const g = m.groups;
  return [g['embed']!, g['target']!, g['anchor'] ?? '', g['display'] ?? ''];
}

test('the wikilink pattern captures every half', () => {
  assert.deepEqual(groups('[[X]]'), ['', 'X', '', '']);
  assert.deepEqual(groups('![[X]]'), ['!', 'X', '', '']);
  assert.deepEqual(groups('[[X#H]]'), ['', 'X', '#H', '']);
  assert.deepEqual(groups('[[X^blk]]'), ['', 'X', '^blk', '']);
  assert.deepEqual(groups('[[X|t]]'), ['', 'X', '', '|t']);
  assert.deepEqual(groups('[[X#H|t]]'), ['', 'X', '#H', '|t']);
  assert.deepEqual(groups('[[ X ]]'), ['', 'X', '', '']);
  assert.deepEqual(groups('[[a/b/X.md|t]]'), ['', 'a/b/X.md', '', '|t']);
  // Obsidian's escape for a pipe inside a markdown table cell
  assert.deepEqual(groups('[[X\\|t]]'), ['', 'X', '', '\\|t']);
  assert.deepEqual(groups('[[X#H\\|t]]'), ['', 'X', '#H', '\\|t']);
});

test('a wikilink never spans a line', () => {
  assert.equal(new RegExp(WIKILINK.source, 'u').exec('[[broken\nline]]'), null);
  assert.equal(new RegExp(WIKILINK.source, 'u').exec('[[X|two\nlines]]'), null);
});

test('key folds case, path and suffix and normalises to NFC, nothing more', () => {
  assert.equal(key("Kell'a"), "kell'a");
  assert.equal(key(" lore/Kell'a.md "), "kell'a");
  assert.equal(key('/Owl-Clan/'), 'owl-clan');
  assert.equal(key('Ilōraḥ'.normalize('NFD')), key('Ilōraḥ'));
  // diacritics are never folded away: a different name is a different key
  assert.notEqual(key('Ilōraḥ'), key('Ilorah'));
});

// Lowering U+0130 gives i and a combining dot, the only lowering in Unicode that
// lengthens, so a page named with it could never match the one-character form typed.
test('the key of a dotted capital I is one character', () => {
  assert.equal(key('İstanbul'), key('istanbul'));
  assert.equal(pyLen(key('İ')), 1);
});

test('maskCodeSpans preserves length', () => {
  const line = 'see `[[x]]` and [[y]]';
  const masked = maskCodeSpans(line);
  assert.equal(masked.length, line.length);
  assert.ok(masked.includes('[[y]]') && !masked.includes('[[x]]'));
});

const FM = "---\ntype: subject\ntopics:\n- \"[[Kell'a]]\"\n- '[[Owl''s-Nest]]'\n"
  + 'provenance:\n  legacy_frontmatter: |\n    Topics:: [[legacy-only]]\n---\n';

test('occurrences report file lines for topics and the body', () => {
  const text = `${FM}# T\n\nSee [[kella]] and \`[[code]]\` then [[b|B]].\n`;
  const occ = occurrences(text);
  const topics = occ.filter((o) => o.where === 'topics');
  const body = occ.filter((o) => o.where === 'body');
  assert.deepEqual(topics.map((o) => [o.lineno, o.target, o.quote]), [[4, "Kell'a", '"'], [5, "Owl's-Nest", "'"]]);
  assert.equal(topics[0]!.value, "[[Kell'a]]");
  assert.equal(topics[1]!.value, "[[Owl's-Nest]]");
  // the closing --- is file line 9, so the body starts at 10 and the link line is 12
  assert.deepEqual(body.map((o) => [o.lineno, o.target, o.display]), [[12, 'kella', ''], [12, 'b', '|B']]);
  // spans index the raw line
  const line = 'See [[kella]] and `[[code]]` then [[b|B]].';
  assert.equal(line.slice(...body[0]!.span), '[[kella]]');
  assert.equal(line.slice(...body[1]!.span), '[[b|B]]');
});

test('occurrences skip fences, inline code and legacy frontmatter', () => {
  const text = `${FM}\`\`\`\n[[fenced]]\n\`\`\`\nA \`[[coded]]\` link.\n`;
  assert.deepEqual(occurrences(text).map((o) => o.target), ["Kell'a", "Owl's-Nest"]);
});

test('occurrences without frontmatter start at line one', () => {
  assert.deepEqual(occurrences('[[a]]\n\n[[b]]\n').map((o) => [o.lineno, o.target]), [[1, 'a'], [3, 'b']]);
});

test('flow-style topics are seen but unquoted', () => {
  const text = '---\ntype: writing\ntopics: ["[[the-mill]]"]\n---\nProse.\n';
  assert.deepEqual(occurrences(text).map((o) => [o.lineno, o.where, o.target, o.quote]),
    [[3, 'topics', 'the-mill', '']]);
});

// `- [[x]]` is a YAML flow sequence, not a string: the old harvester skipped it, and so
// does this one.
test('an unquoted topics item parses as a list and is skipped', () => {
  const text = '---\ntype: subject\ntopics:\n- [[x]]\n- "[[y]]"\n---\n';
  assert.deepEqual(occurrences(text).map((o) => o.target), ['y']);
});

test('CRLF text keeps its line numbers', () => {
  const text = '---\r\ntype: subject\r\n---\r\nSee [[a]].\r\n';
  assert.deepEqual(occurrences(text).map((o) => [o.lineno, o.target]), [[4, 'a']]);
});

// What the old harvester pinned: topics count, fences and code spans do not,
// blockquotes do, display and anchors drop out.
test('linksIn matches the old harvester on its fixtures', () => {
  const text = "---\ntype: subject\ntopics:\n- \"[[Kell'a]]\"\n---\n"
    + '> quoted [[q]]\n\nCite as `[[page]] (Speaker)`.\n\n```\n[[example-target]]\n```\n'
    + '[[a#h|t]] [[b]]\n';
  assert.deepEqual(linksIn(text), ["Kell'a", 'q', 'a', 'b']);
});

// Group 1 is the target, the composable form lint's citation patterns use.
test('LINK_SRC captures the target before a table-escaped pipe', () => {
  let m = new RegExp(LINK_SRC, 'u').exec('| [[glass-orchard\\|Project-Glass-Orchard]] |');
  assert.equal(m?.[1], 'glass-orchard');
  m = new RegExp(LINK_SRC, 'u').exec('[[Page#Heading|shown]]');
  assert.equal(m?.[1], 'Page');
});

// One fence detector for every reader. Three or more backticks or tildes open and
// close a fence, indented or not; fewer do not.
test('isFence recognises backtick and tilde fences', () => {
  assert.ok(isFence('```'));
  assert.ok(isFence('  ```python'));
  assert.ok(isFence('~~~'));
  assert.ok(isFence('\t~~~~ text'));
  assert.ok(!isFence('``'));
  assert.ok(!isFence('~~ strike ~~'));
  assert.ok(!isFence('a ``` b'));
});

test('occurrences skip tilde fences', () => {
  assert.deepEqual(occurrences(`${FM}~~~\n[[fenced]]\n~~~\n`).map((o) => o.target), ["Kell'a", "Owl's-Nest"]);
});

// No-swallow rule: a flow-style topics key that will not parse is logged.
test('an unparseable flow topics key is logged', () => {
  const { records } = captureLogs(() => occurrences('---\ntopics: {bad: [unclosed\n---\n[[a]]\n'));
  assert.ok(records.some((r) => r.level === 'warning' && r.logger === 'librarian.links' && r.message.includes('topics')));
});

// No-swallow rule: a topics item whose scalar will not parse is skipped, and logged.
test('an unparseable topics block item is logged', () => {
  const { records } = captureLogs(() => occurrences('---\ntopics:\n- {bad: [unclosed\n---\n[[a]]\n'));
  assert.ok(records.some((r) => r.level === 'warning' && r.logger === 'librarian.links' && r.message.includes('topics')));
});
