// Which page a [[link]] names. A target resolves by title, folded by key() as the link
// grammar folds it (case, a folder path and .md set aside). A wiki page wins over a
// source page with the same title, so a writer's own page is what a link reaches. Pure.
import { key } from '../../librarian/links.ts';
import type { Tree } from './identity.ts';

export interface Titled {
  id: string;
  tree: Tree;
  title: string;
}

export interface TitleIndex<P extends Titled> {
  /** The page a link target reaches, or undefined. */
  resolve(target: string): P | undefined;
  /** The page of `tree` already holding this title, other than `except`; undefined if free. */
  taken(tree: Tree, title: string, except?: string): P | undefined;
  /** Groups of pages in one tree whose titles fold alike; the first of each group is the one that resolves. */
  duplicates: P[][];
}

export function titleIndex<P extends Titled>(pages: readonly P[]): TitleIndex<P> {
  const byTree: Record<Tree, Map<string, P[]>> = { wiki: new Map(), sources: new Map() };
  for (const page of [...pages].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const k = key(page.title);
    if (!k) continue;
    const group = byTree[page.tree].get(k);
    if (group) group.push(page);
    else byTree[page.tree].set(k, [page]);
  }
  return {
    resolve(target) {
      const k = key(target);
      return byTree.wiki.get(k)?.[0] ?? byTree.sources.get(k)?.[0];
    },
    taken(tree, title, except) {
      return byTree[tree].get(key(title))?.find((p) => p.id !== except);
    },
    duplicates: [...byTree.wiki.values(), ...byTree.sources.values()].filter((g) => g.length > 1),
  };
}
