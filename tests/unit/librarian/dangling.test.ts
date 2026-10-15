// Ported from hoard's tests/test_dangling.py, names made up. Unresolved links are how a
// writer outlines, so the list is an inventory; the one real signal in it is a link that
// almost names an existing page. The command-line cases are in cli.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINK } from '../../../src/librarian/links.ts';
import { type Dangling, collect, matching, report } from '../../../src/librarian/dangling.ts';
import { captureLogs } from '../../../src/librarian/log.ts';

const PAGE = '---\ntype: subject\n---\n';

function vault(files: Record<string, string>, attachments: string[] = []): Dangling[] {
  return collect(Object.entries(files), attachments);
}

const targets = (items: Dangling[]) => items.map((d) => d.target);

test('an unresolved link is listed with the pages that link it', () => {
  const items = vault({ 'lore/A.md': `${PAGE}See [[Nowhere]].\n`, 'lore/B.md': `${PAGE}Also [[Nowhere]].\n` });
  assert.deepEqual(targets(items), ['Nowhere']);
  assert.deepEqual(items[0]!.sources, ['lore/A.md', 'lore/B.md']);
});

// Basename, case and path forms resolve; an alias hit is LK1's, so it is not listed.
test('resolvable links are not listed', () => {
  assert.deepEqual(vault({
    'lore/Tidecraft.md': '---\ntype: subject\naliases:\n- shared current\n---\n',
    'writing/path/the-boathouse.md': PAGE,
    'lore/A.md': `${PAGE}[[tidecraft]] [[Shared Current]] [[writing/path/the-boathouse]] [[the-boathouse.md]]\n`,
  }), []);
});

test('code is not a link', () => {
  assert.deepEqual(vault({ 'lore/A.md': `${PAGE}Cite as \`[[page]] (Speaker)\`.\n\n\`\`\`\n[[example-target]]\n\`\`\`\n` }), []);
});

test('frontmatter topics count as links', () => {
  assert.deepEqual(targets(vault({ 'lore/A.md': '---\ntype: subject\ntopics:\n- "[[Ilsa\'n]]"\n---\nBody.\n' })),
    ["Ilsa'n"]);
});

test('author bodies count and infra and inbox do not', () => {
  const items = vault({
    'writing/path/x.md': `${PAGE}[[FromWriting]]\n`, 'sources/s.md': `${PAGE}[[FromSource]]\n`,
    'inbox/i.md': '[[FromInbox]]\n', '_meta/m.md': '[[FromMeta]]\n', '_deprecated/d.md': '[[FromDeprecated]]\n',
  });
  assert.deepEqual(targets(items).sort(), ['FromSource', 'FromWriting']);
});

test('a near miss is flagged against the page it nearly names', () => {
  const items = vault({
    'lore/Rivers-Ash-and-Stone.md': PAGE,
    'writing/odr-anvil/odr-lst-2-the-vault.md': PAGE,
    'lore/A.md': `${PAGE}[[Rivers-and-Stone]] and [[ODR-LST-2-The-Vault-XQ]]\n`,
  });
  const near = Object.fromEntries(items.filter((d) => d.near).map((d) => [d.target, d.near]));
  assert.deepEqual(near, {
    'Rivers-and-Stone': 'lore/Rivers-Ash-and-Stone.md',
    'ODR-LST-2-The-Vault-XQ': 'writing/odr-anvil/odr-lst-2-the-vault.md',
  });
});

// Obsidian folds case, so a name differing from a page only in case or separators is the
// page itself or a deliberate twin, never a slip.
test('a separator twin is never a near miss', () => {
  const items = vault({ 'writing/path/harbour-town.md': PAGE, 'lore/A.md': `${PAGE}[[Harbour Town]]\n` });
  assert.deepEqual(targets(items), ['Harbour Town']);
  assert.equal(items[0]!.near, null);
});

// A page that writes a name as a link has declared it a separate node.
test('a node a page declares in its own topics is not a near miss', () => {
  const essay = '---\ntype: writing\ntopics:\n- "[[Ash-and-Stone]]"\n- "[[Rivers-and-Stone]]"\n---\nProse.\n';
  const items = vault({ 'writing/garden/rivers-ash-and-stone.md': essay, 'projects/seed-archive.md': `${PAGE}[[Rivers-and-Stone]]\n` });
  assert.deepEqual(items.map((d) => d.near), [null, null]);
});

test('an unrelated name is not a near miss', () => {
  assert.equal(vault({ 'lore/Tidecraft.md': PAGE, 'lore/A.md': `${PAGE}[[Pebble Brigade]]\n` })[0]!.near, null);
});

test('the report puts near misses first and names both strings', () => {
  const lines = report(vault({ 'lore/Rivers-Ash-and-Stone.md': PAGE, 'lore/A.md': `${PAGE}[[Rivers-and-Stone]] [[Nowhere]]\n` }));
  assert.equal(lines[0], 'near-miss: [[Rivers-and-Stone]] ~ lore/Rivers-Ash-and-Stone.md (0.90, linked from lore/A.md)');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '2 unresolved target(s)');
  assert.ok(lines.slice(1).some((line) => line.includes('[[Nowhere]]')));
});

test('the inventory shows three sources and counts the rest', () => {
  const files: Record<string, string> = {};
  for (const n of ['a', 'b', 'c', 'd', 'e']) files[`lore/${n}.md`] = `${PAGE}[[Nowhere]]\n`;
  files['lore/f.md'] = `${PAGE}[[Elsewhere]]\n`;
  assert.deepEqual(report(vault(files)), [
    '2 unresolved target(s)',
    '    5  [[Nowhere]]  lore/a.md, lore/b.md, lore/c.md, +2 more',
    '    1  [[Elsewhere]]  lore/f.md',
  ]);
});

test('targets sort by link count, then by name case-blind', () => {
  const items = vault({ 'lore/A.md': `${PAGE}[[beta]] [[Alpha]] [[Gamma]]\n`, 'lore/B.md': `${PAGE}[[Gamma]]\n` });
  assert.deepEqual(targets(items), ['Gamma', 'Alpha', 'beta']);
});

test('matching filters by name, case and separators ignored', () => {
  const items = vault({
    'lore/Rivers-Ash-and-Stone.md': PAGE,
    'lore/A.md': `${PAGE}[[Rivers-and-Stone]] and [[Ossuary Ledger]]\n`,
  });
  assert.deepEqual(targets(matching(items, 'OSSUARY-ledger')), ['Ossuary Ledger']);
  assert.equal(matching(items, '--').length, 2);
});

// A suggestion must name a page a basename link can reach, so a near miss is never
// steered at a page by way of its alias.
test('alias-only links are neither listed nor near-missed', () => {
  const items = vault({
    'lore/Tidecraft.md': '---\ntype: subject\naliases:\n- Shared-Current\n---\n',
    'lore/A.md': `${PAGE}[[Shared-Current]] and [[Shared-Currentt]]\n`,
  });
  assert.deepEqual(targets(items), ['Shared-Currentt']);
  assert.equal(items[0]!.near, null);
});

test('the link pattern drops a table-escaped pipe from the target', () => {
  const m = new RegExp(LINK.source, 'u').exec(String.raw`[[seed-archive\|Project-Seed-Archive]]`);
  assert.equal(m?.[1], 'seed-archive');
});

test('a link to a landed canvas is not dangling', () => {
  const items = vault({ 'lore/A.md': '---\ntype: lore\n---\n# A\n\nSee [[Outline.canvas]] and [[Missing.canvas]].\n' },
    ['writing/s/material/Outline.canvas']);
  assert.deepEqual(targets(items), ['Missing.canvas']);
});

test('the count is logged, alias-only links included', () => {
  const { records } = captureLogs(() => vault({
    'lore/Tidecraft.md': '---\ntype: subject\naliases:\n- Shared-Current\n---\n',
    'lore/A.md': `${PAGE}[[Shared-Current]] [[Nowhere]]\n`,
  }));
  assert.deepEqual(records, [{
    logger: 'librarian.dangling', level: 'info',
    message: 'dangling: 1 unresolved target(s) over 2 note(s); 1 alias-only link(s) left to lint LK1',
  }]);
});
