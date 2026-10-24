// The librarian's review on the main side: which chapters of a book are the librarian's
// (from their page sidecars), and its verdicts on the writer's suggestions, signed as the
// librarian. Applying an accepted change in the open book is the window's: a librarian
// edit (git/librarian.ts), which sits between the writer's commit and the librarian's.
// A change made from the Wiki pane, beside another book, is written here (wiki.edit,
// wiki/write.ts), since no window holds that page.
import type { GitLayer } from '../git/layer.ts';
import type { MarkStore } from '../marks/store.ts';
import type { WikiStore } from '../wiki/store.ts';
import { writePage } from '../wiki/write.ts';
import { librarianPages } from './owner.ts';
import { validateHoardReviewOwnersV1, validateHoardReviewVerdictV1, validateHoardWikiEditV1 } from '../../generated/validators.cjs';

type Validator<T> = { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null };

function checked<T>(name: string, validate: Validator<T>, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

export function startReview(host: NeoMainHost, marks: MarkStore, o: { layer: GitLayer; wiki: WikiStore }): void {
  const log = host.log.bind(host);
  host.handle('wiki.edit', (payload) => writePage({
    library: () => host.paths.library(),
    listed: (chId) => {
      const wiki = o.wiki.pages();
      return wiki && wiki.pages.some((p) => p.chId === chId) ? { bookId: wiki.bookId } : null;
    },
    layer: o.layer,
    log,
  }, checked('wiki.edit', validateHoardWikiEditV1, payload)));
  host.handle('review.owners', (payload) => {
    const { bookId } = checked('review.owners', validateHoardReviewOwnersV1, payload);
    return { librarian: librarianPages(host.paths.library(), bookId, log) };
  });
  host.handle('review.verdict', async (payload) => {
    const { reason, ...req } = checked('review.verdict', validateHoardReviewVerdictV1, payload);
    const answer = await marks.review(req, 'librarian', reason);
    log('info', 'review.verdict', { ...req, reason });
    return answer;
  });
}
