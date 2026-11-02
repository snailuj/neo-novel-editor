// The librarian's review on the main side: which pages are the librarian's (from their
// page sidecars), and its verdicts on the writer's suggestions, signed as the librarian.
// A page in wiki/ or sources/ is edited by its id (pages.edit, edit.ts), since no window
// holds that page, and its owners asked for by id or tree (review.owners).
import type { GitLayer } from '../git/layer.ts';
import { targeted, type MarkStore } from '../marks/store.ts';
import type { PageStore } from '../pages/store.ts';
import type { AuthorSaved } from './saved.ts';
import { editPage, librarianAmong, librarianInTree } from './edit.ts';
import { validateHoardPagesEditV1, validateHoardReviewOwnersV1, validateHoardReviewVerdictV1 } from '../../generated/validators.cjs';

type Validator<T> = { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null };

function checked<T>(name: string, validate: Validator<T>, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

export function startReview(host: NeoMainHost, marks: MarkStore, o: { layer: GitLayer; pages: PageStore; authorSavedPage?: AuthorSaved }): void {
  const log = host.log.bind(host);
  host.handle('pages.edit', (payload) => editPage({
    library: () => host.paths.library(),
    store: o.pages,
    layer: o.layer,
    log,
    saved: o.authorSavedPage,
  }, checked('pages.edit', validateHoardPagesEditV1, payload)));
  host.handle('review.owners', async (payload) => {
    const ask = checked('review.owners', validateHoardReviewOwnersV1, payload);
    const library = host.paths.library();
    if (ask.pages !== undefined) return { librarian: await librarianAmong(library, ask.pages, log) };
    return { librarian: await librarianInTree(library, ask.tree!, log) }; // the schema requires pages or tree
  });
  host.handle('review.verdict', async (payload) => {
    const { reason, ...req } = checked('review.verdict', validateHoardReviewVerdictV1, payload);
    const answer = await marks.review(targeted(req), 'librarian', reason);
    log('info', 'review.verdict', { ...req, reason });
    return answer;
  });
}
