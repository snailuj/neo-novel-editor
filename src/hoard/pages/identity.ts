// What names a page: its tree (a folder at the library's root) and its path inside that
// folder, with forward slashes on every system. Pure. A path is checked here once, so
// the store never joins one that could leave its tree or land in a hidden folder.

export type Tree = 'wiki' | 'sources';
export const TREES: readonly Tree[] = ['wiki', 'sources'];

export interface PageRef {
  tree: Tree;
  path: string;
}

/** A request the store will not carry out; `code` is stable for callers, `message` for the log. */
export class PageRefused extends Error {
  readonly code: 'unsafe' | 'taken' | 'other-tree' | 'missing' | 'stale' | 'title';

  constructor(code: PageRefused['code'], message: string) {
    super(message);
    this.name = 'PageRefused';
    this.code = code;
  }
}

const EXTENSION = '.html';

/** The path itself, or a PageRefused saying why it is not one the store may touch. */
export function checkPath(p: unknown): string {
  const refuse = (why: string) => new PageRefused('unsafe', `${JSON.stringify(p)} is not a page path: ${why}`);
  if (typeof p !== 'string' || p === '') throw refuse('it is empty');
  if (/[\\\0]/.test(p)) throw refuse('it holds a backslash or a null');
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) throw refuse('it is absolute');
  const segments = p.split('/');
  for (const s of segments) {
    if (s === '') throw refuse('it has an empty segment');
    if (s === '.' || s === '..') throw refuse('it leaves the tree');
    if (s.startsWith('.')) throw refuse('it is hidden');
  }
  if (!p.endsWith(EXTENSION)) throw refuse(`it does not end in ${EXTENSION}`);
  return p;
}

export function idOf(ref: PageRef): string {
  return `${ref.tree}/${ref.path}`;
}

export function parseId(id: unknown): PageRef {
  if (typeof id !== 'string') throw new PageRefused('unsafe', `${JSON.stringify(id)} is not a page id`);
  const slash = id.indexOf('/');
  const tree = id.slice(0, slash);
  if (slash < 0 || !(TREES as readonly string[]).includes(tree)) {
    throw new PageRefused('unsafe', `${JSON.stringify(id)} does not start with a tree and a slash`);
  }
  return { tree: tree as Tree, path: checkPath(id.slice(slash + 1)) };
}

// A title becomes the target of a [[link]], which the grammar ends at ] | # or ^.
const UNLINKABLE = /[[\]|#^\p{Cc}]/u;

/** The path's title, or a PageRefused('title') when no link could name it. */
export function checkTitle(p: string): string {
  const title = titleOf(p);
  if (title.trim() === '' || title !== title.trim() || UNLINKABLE.test(title)) {
    throw new PageRefused('title', `${JSON.stringify(title)} cannot be a page title: it is empty, has spaces at an end, or holds one of [ ] | # ^`);
  }
  return title;
}

/** The file name without .html. */
export function titleOf(p: string): string {
  const name = p.slice(p.lastIndexOf('/') + 1);
  return name.endsWith(EXTENSION) ? name.slice(0, -EXTENSION.length) : name;
}
