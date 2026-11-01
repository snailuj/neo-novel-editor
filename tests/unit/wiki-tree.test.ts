// The Pages tree in the wiki pane, as data: folders and pages from pages.list, the rows
// drawn, the paths a rename, a move or a new page asks for, and the row editor's states.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tree } from '../../src/hoard/pages/identity.ts';
import { buildTree, visibleRows } from '../../src/hoard/wiki/tree.ts';

const page = (id: string) => {
  const tree = id.slice(0, id.indexOf('/')) as Tree;
  const path = id.slice(id.indexOf('/') + 1);
  return { id, tree, path, title: path.slice(path.lastIndexOf('/') + 1, -'.html'.length) };
};

const shape = (rows: ReturnType<typeof visibleRows>) => rows.map((r) => `${'  '.repeat(r.depth)}${r.kind === 'folder' ? `${r.name}/` : r.name}`);

// Rule: each tree lists its folders before its pages, folders by name and pages by title,
// in the order a reader expects (case aside, numbers by value), and both trees are there
// even with no pages in them.
test('folders come first, then pages by title, in each tree', () => {
  const roots = buildTree([
    'wiki/page 10.html', 'wiki/Page 2.html', 'wiki/people/Zed.html', 'wiki/Places/Vell.html',
    'wiki/people/ada.html', 'wiki/People notes.html', 'wiki/places/inner/Deep.html',
  ].map(page));
  assert.deepEqual(roots.map((r) => [r.key, r.name]), [['wiki', 'wiki'], ['sources', 'sources']]);
  const all = new Set(['wiki', 'sources', 'wiki/people', 'wiki/Places', 'wiki/places', 'wiki/places/inner']);
  assert.deepEqual(shape(visibleRows(roots, all)), [
    'wiki/',
    '  people/',
    '    ada',
    '    Zed',
    '  places/',
    '    inner/',
    '      Deep',
    '  Places/',
    '    Vell',
    '  Page 2',
    '  page 10',
    '  People notes',
    'sources/',
  ]);
});

// Rule: the rows drawn are those of open folders only, so a closed folder costs one row
// however many pages it holds, and each row knows its folder, for the keys that walk the tree.
test('only open folders draw their rows', () => {
  const ids: string[] = [];
  for (let f = 0; f < 50; f++) for (let p = 0; p < 100; p++) ids.push(`sources/F${f}/P${p}.html`);
  ids.push('wiki/Top.html');
  const roots = buildTree(ids.map(page));
  assert.deepEqual(roots.map((r) => r.count), [1, 5000], 'a folder counts the pages in the folders inside it');
  const rows = visibleRows(roots, new Set(['wiki', 'sources']));
  assert.equal(rows.length, 1 + 1 + 1 + 50, 'two roots, one wiki page and fifty closed folders');
  const f3 = rows.find((r) => r.key === 'sources/F3')!;
  assert.deepEqual([f3.kind, f3.depth, f3.parent, f3.kind === 'folder' && f3.open, f3.kind === 'folder' && f3.count], ['folder', 1, 'sources', false, 100]);
  const opened = visibleRows(roots, new Set(['wiki', 'sources', 'sources/F3']));
  assert.equal(opened.length, rows.length + 100);
  const p0 = opened.find((r) => r.key === 'sources/F3/P0.html')!;
  assert.deepEqual([p0.kind, p0.depth, p0.parent], ['page', 2, 'sources/F3']);
  assert.equal(visibleRows(roots, new Set()).length, 2, 'closed roots draw only themselves');
});
