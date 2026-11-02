// The one place the author's save of a page is announced outside the window: a held file
// is theirs again (Gate.saved), and a librarian pair waiting for the save is woken
// (LibrarianPairs.landed). A page is named by its id.
import type { Gate } from '../git/gate.ts';
import type { LibrarianPairs } from '../git/pair.ts';

export type AuthorSaved = (page: string) => void;

export function authorSaved(gate: Pick<Gate, 'saved'>, pairs: Pick<LibrarianPairs, 'landed'>): AuthorSaved {
  return (page: string): void => {
    gate.saved(page);
    pairs.landed({ page });
  };
}
