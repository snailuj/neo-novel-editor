// The one place the author's save of a page or a chapter is announced outside the window:
// a held file is theirs again (Gate.saved), and a librarian pair waiting for the save is
// woken (LibrarianPairs.landed). A page is named by its id, a chapter by its book and
// chapter ids, as gate-main.ts and librarian-main.ts name them for the window's saves.
import type { Gate } from '../git/gate.ts';
import type { LibrarianPairs } from '../git/pair.ts';

export interface AuthorSaved {
  (page: string): void;
  (bookId: string, chId: string): void;
}

export function authorSaved(gate: Pick<Gate, 'saved'>, pairs: Pick<LibrarianPairs, 'landed'>): AuthorSaved {
  return (first: string, chId?: string): void => {
    if (chId === undefined) {
      gate.saved(first);
      pairs.landed({ page: first });
    } else {
      gate.saved(`${first}/chapters/${chId}.html`);
      pairs.landed(first, chId);
    }
  };
}
