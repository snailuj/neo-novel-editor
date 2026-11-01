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

const byId = (a: Titled, b: Titled) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * A title index that create and rename keep up to date page by page, so a store need not
 * walk its trees again for each request. Each group stays sorted by id, so the first of a
 * group is the one that resolves whatever order the pages came in.
 */
export class Titles<P extends Titled> implements TitleIndex<P> {
  readonly #byTree: Record<Tree, Map<string, P[]>> = { wiki: new Map(), sources: new Map() };
  readonly #ids = new Map<string, P>();

  constructor(pages: readonly P[] = []) {
    for (const page of pages) this.add(page);
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** Adds a page, or replaces the one with its id. */
  add(page: P): void {
    this.remove(page.id);
    this.#ids.set(page.id, page);
    const k = key(page.title);
    if (!k) return;
    const map = this.#byTree[page.tree];
    const group = map.get(k);
    if (!group) {
      map.set(k, [page]);
      return;
    }
    const at = group.findIndex((p) => byId(page, p) < 0);
    group.splice(at < 0 ? group.length : at, 0, page);
  }

  remove(id: string): void {
    const page = this.#ids.get(id);
    if (!page) return;
    this.#ids.delete(id);
    const map = this.#byTree[page.tree];
    const k = key(page.title);
    const group = map.get(k)?.filter((p) => p.id !== id);
    if (group?.length) map.set(k, group);
    else map.delete(k);
  }

  resolve(target: string): P | undefined {
    const k = key(target);
    return this.#byTree.wiki.get(k)?.[0] ?? this.#byTree.sources.get(k)?.[0];
  }

  taken(tree: Tree, title: string, except?: string): P | undefined {
    return this.#byTree[tree].get(key(title))?.find((p) => p.id !== except);
  }

  get duplicates(): P[][] {
    return [...this.#byTree.wiki.values(), ...this.#byTree.sources.values()].filter((g) => g.length > 1);
  }
}

export function titleIndex<P extends Titled>(pages: readonly P[]): Titles<P> {
  return new Titles(pages);
}
