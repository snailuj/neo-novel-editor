// The librarian's review on the main side: which chapters of a book are the librarian's
// (from their page sidecars), and its verdicts on the writer's suggestions, signed as the
// librarian. Applying an accepted change is the window's (through the host's replace);
// around it the history commits what was waiting before, and the change as the
// librarian's after, through LibrarianCommits.
import type { MarkStore } from '../marks/store.ts';
import { librarianPages } from './owner.ts';
import {
  validateHoardReviewBeginV1, validateHoardReviewOwnersV1, validateHoardReviewVerdictV1,
} from '../../generated/validators.cjs';

/** The commits around a change the librarian applies. */
export interface LibrarianCommits {
  /** Commits what is waiting, as its author, before the librarian's change. */
  before(): Promise<void>;
  /** Commits the librarian's change under the librarian's identity. */
  after(): Promise<void>;
}

// Until the librarian's paired commits land in the git layer, an accepted change is
// committed by the usual idle checkpoint.
export const NO_PAIR: LibrarianCommits = { before: async () => {}, after: async () => {} };

type Validator<T> = { (data: unknown): data is T; errors?: { instancePath: string; message?: string }[] | null };

function checked<T>(name: string, validate: Validator<T>, payload: unknown): T {
  if (!validate(payload)) {
    const why = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    throw new TypeError(`${name}: ${why}`);
  }
  return payload;
}

export function startReview(host: NeoMainHost, marks: MarkStore, commits: LibrarianCommits = NO_PAIR): void {
  const log = host.log.bind(host);
  host.handle('review.owners', (payload) => {
    const { bookId } = checked('review.owners', validateHoardReviewOwnersV1, payload);
    return { librarian: librarianPages(host.paths.library(), bookId, log) };
  });
  host.handle('review.begin', async (payload) => {
    const req = checked('review.begin', validateHoardReviewBeginV1, payload);
    log('info', 'review.begin', req);
    await commits.before();
    return null;
  });
  host.handle('review.verdict', async (payload) => {
    const { reason, ...req } = checked('review.verdict', validateHoardReviewVerdictV1, payload);
    const answer = await marks.review(req, 'librarian', reason);
    log('info', 'review.verdict', { ...req, reason });
    if (req.state === 'accepted') await commits.after();
    return answer;
  });
}
