// The librarian's edits as the window makes them. The chapter is held, so the writer
// cannot type in it; the main half commits what the writer wrote as theirs; the edit
// runs (through the host's replace, which still edits a held chapter); the main half
// commits the chapter as the librarian's once the save holding the edit has landed; and
// only then is the chapter let go, whatever happened on the way.
import type { Begun, Ended } from './pair.ts';
import type { Holds } from '../holds.ts';

export type LibrarianEdit<T> =
  | ({ ok: true; result: T } & Ended)
  | { ok: false; reason: 'missing' | 'unsaved' };

type Neo = Pick<NeoApiV3, 'book' | 'chapter' | 'invoke' | 'replace'>;

export function librarianEdits(neo: Neo, holds: Holds) {
  /**
   * Runs apply between the author's commit and the librarian's, with the chapter held.
   * missing: the chapter is not in the open book. unsaved: the writer's last words in
   * it had not reached the disk, so apply did not run. An author commit that fails
   * rejects and apply does not run; an apply that fails still has its pair ended.
   */
  async function edit<T>(chId: string, apply: () => Promise<T>): Promise<LibrarianEdit<T>> {
    const book = neo.book();
    const chapter = neo.chapter(chId);
    if (!book || !chapter) return { ok: false, reason: 'missing' };
    const release = holds.hold([chId]);
    try {
      const begun = await neo.invoke('git.librarian-begin', { bookId: book.id, chId, html: chapter.html }) as Begun;
      if ('refused' in begun) return { ok: false, reason: begun.refused };
      let result!: T;
      let failed: { err: unknown } | null = null;
      try {
        result = await apply();
      } catch (err) {
        failed = { err };
      }
      // null when the book closed meanwhile: the main half commits the disk as it is
      const html = neo.chapter(chId)?.html ?? null;
      const ended = await neo.invoke('git.librarian-end', { pair: begun.pair, html }) as Ended;
      if (failed) throw failed.err;
      return { ok: true, result, ...ended };
    } finally {
      release();
    }
  }

  /** The host's replace, as a librarian edit. */
  function replace(place: NeoPlace, expectedText: string, newText: string) {
    return edit(place.chId, () => neo.replace(place, expectedText, newText));
  }

  return { edit, replace };
}

export type LibrarianEdits = ReturnType<typeof librarianEdits>;
