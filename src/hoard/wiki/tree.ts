// The Pages tree in the wiki pane, as data. Pure: the view (wiki/pane-tree.ts) draws what
// this works out. The pages come from one pages.list; each tree (wiki/, sources/) shows its
// folders first, by name, then its pages, by title. Only the rows of open folders are
// worked out, so a library of thousands of pages in closed folders draws a few rows.
import { TREES, type Tree } from '../pages/identity.ts';

/** What the tree needs of a pages.list entry. */
export interface Listed {
  id: string;
  tree: Tree;
  path: string;
  title: string;
}

export interface Folder {
  /** The tree and the folder's path in it, as an id names a page: `wiki` or `wiki/People`. */
  key: string;
  tree: Tree;
  /** The folder's path inside its tree; '' for the tree's own folder. */
  path: string;
  name: string;
  folders: Folder[];
  pages: Listed[];
  /** Pages in this folder and every folder inside it. */
  count: number;
}

interface RowBase {
  key: string;
  tree: Tree;
  path: string;
  name: string;
  depth: number;
  /** The folder row this row sits in; null for a tree's own folder. */
  parent: string | null;
}
export type Row = (RowBase & { kind: 'folder'; open: boolean; count: number }) | (RowBase & { kind: 'page' });

// numbers by value, then a total order so the same list always draws the same way
const collator = new Intl.Collator(undefined, { numeric: true });
const byName = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** The folder a page path sits in, '' at the top of its tree. */
export const folderOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export function buildTree(entries: readonly Listed[]): Folder[] {
  const folders = new Map<string, Folder>();
  const folder = (tree: Tree, path: string): Folder => {
    const key = path ? `${tree}/${path}` : tree;
    let f = folders.get(key);
    if (!f) {
      f = { key, tree, path, name: path ? path.slice(path.lastIndexOf('/') + 1) : tree, folders: [], pages: [], count: 0 };
      folders.set(key, f);
      if (path) folder(tree, folderOf(path)).folders.push(f);
    }
    return f;
  };
  const roots = TREES.map((tree) => folder(tree, ''));
  for (const entry of entries) {
    folder(entry.tree, folderOf(entry.path)).pages.push(entry);
    for (let at = folderOf(entry.path); ; at = folderOf(at)) {
      folder(entry.tree, at).count++;
      if (!at) break;
    }
  }
  for (const f of folders.values()) {
    f.folders.sort((a, b) => byName(a.name, b.name));
    f.pages.sort((a, b) => byName(a.title, b.title));
  }
  return roots;
}

/** The rows drawn, in order: each open folder's folders and pages under it. */
export function visibleRows(roots: readonly Folder[], open: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (f: Folder, depth: number, parent: string | null) => {
    const isOpen = open.has(f.key);
    rows.push({ kind: 'folder', key: f.key, tree: f.tree, path: f.path, name: f.name, depth, parent, open: isOpen, count: f.count });
    if (!isOpen) return;
    for (const sub of f.folders) walk(sub, depth + 1, f.key);
    for (const p of f.pages) rows.push({ kind: 'page', key: p.id, tree: p.tree, path: p.path, name: p.title, depth: depth + 1, parent: f.key });
  };
  for (const root of roots) walk(root, 0, null);
  return rows;
}
