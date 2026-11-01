// The page store's channels on the main side. The window half asks for the list, a page,
// a write, a new page or a rename; each payload is checked against its schema (schemas/ipc)
// before the store sees it. Nothing in the window calls these yet: pages as files sit
// beside the Wiki book until each consumer is moved over.
import {
  validateHoardPagesCreateV1, validateHoardPagesReadV1, validateHoardPagesRenameV1, validateHoardPagesWriteV1,
} from '../../generated/validators.cjs';
import { checked } from '../checked.ts';
import type { GitLayer } from '../git/layer.ts';
import { PageStore } from './store.ts';

/**
 * Registers the channels and, once `ready` has settled (the library's history is open, so
 * the commit lands), finishes any rename the last run left part way. Recovery assumes no
 * book is open yet: the main half starts when the window first asks for its plugins, and
 * NEO opens on the shelf. `written` is told the id of each page the author's save has
 * written, so the caller can wake whatever waits for it (a librarian pair) without this
 * file knowing of git.
 */
export function startPages(
  host: NeoMainHost,
  layer: Pick<GitLayer, 'around' | 'wrote'> | undefined,
  ready: Promise<unknown> = Promise.resolve(),
  written?: (id: string) => void,
): { store: PageStore; recovery: Promise<void> } {
  const store = new PageStore({ library: () => host.paths.library(), layer, log: host.log.bind(host) });
  host.handle('pages.list', () => store.list());
  host.handle('pages.read', (payload) => store.read(checked('pages.read', validateHoardPagesReadV1, payload).id));
  host.handle('pages.write', async (payload) => {
    const { id, before, after } = checked('pages.write', validateHoardPagesWriteV1, payload);
    const result = await store.write(id, before, after);
    if (result.ok) {
      try {
        written?.(id);
      } catch (err) {
        // the page is written; a failed wake only leaves a waiter to its time limit
        host.log('error', 'pages.write: telling that the page was written failed', { id, why: String(err) });
      }
    }
    return result;
  });
  host.handle('pages.create', (payload) => {
    const { tree, path, html } = checked('pages.create', validateHoardPagesCreateV1, payload);
    return store.create(tree, path, html);
  });
  host.handle('pages.rename', (payload) => {
    const { id, newPath, openBookId } = checked('pages.rename', validateHoardPagesRenameV1, payload);
    return store.rename(id, newPath, openBookId);
  });
  const recovery = ready
    .then(() => store.recover(null))
    .then(() => undefined)
    .catch((err: unknown) => host.log('error', 'pages.recover failed, so a rename left part way waits for the next start', String(err)));
  return { store, recovery };
}
