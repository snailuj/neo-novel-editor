// The review of the writer's suggestions, wherever the page is shown: in the open book
// (review/window.ts) or in the Wiki pane beside another book (marks/pane-marks.ts). Each
// passes in how its page is read and changed; the rules, the verdicts and what the
// writer is told are the same in both.
//
// The librarian reviews a suggestion against the page as it is now (rules.ts): it
// applies an accepted change as its own edit, or flags it with its reason as a comment.
// A flagged suggestion is the writer's to accept anyway, as their own edit, or withdraw.
// An open suggestion on the writer's own page (an imported one, say) is theirs to accept
// or reject.
import type { Mark } from '../../generated/hoard-marks-v1.js';
import { isSuggestion } from '../marks/model.ts';
import { reviewSuggestion } from './rules.ts';

interface Pages { get(target: string): string | undefined }
interface Place { pIdx: number; off: number; len: number }

export interface CardAction {
  label: string;
  run: () => Promise<void>;
}

export interface ReviewedPage {
  /** The book the page is in, or null when none is shown. */
  bookId(): string | null;
  /** The page's paragraphs as they read now, or null when it is not shown. */
  paragraphs(chId: string): string[] | null;
  marksOf(chId: string): Mark[];
  isLibrarians(chId: string): boolean;
  /** Each resolves with why the change was not made, or null once it is. */
  applyAsLibrarian(chId: string, place: Place, expected: string, text: string): Promise<string | null>;
  applyAsWriter(chId: string, place: Place, expected: string, text: string): Promise<string | null>;
  /** Takes the main half's answer for a page: its marks as the file now holds them. */
  settle(chId: string, answer: { marks: Mark[] }): void;
  tell(text: string): void;
  warn(text: string): void;
  /** The marks read again from their files, after a failure. */
  relist(): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function reviewFlow(neo: Pick<NeoApiV4, 'invoke'>, pages: () => Pages, page: ReviewedPage) {
  const find = (chId: string, markId: string) => page.marksOf(chId).find((m) => m.id === markId);

  // The librarian's review of one suggestion, against the page as it is now.
  async function review(chId: string, markId: string) {
    const mark = find(chId, markId);
    const paragraphs = page.paragraphs(chId);
    const bookId = page.bookId();
    if (!bookId || !mark || !paragraphs) return;
    const verdict = reviewSuggestion(mark, page.marksOf(chId), paragraphs, pages());
    const flag = async (reason: string) => {
      page.settle(chId, await neo.invoke('review.verdict', { bookId, chId, markId, state: 'flagged', reason }) as { marks: Mark[] });
      page.tell('The librarian flagged your suggestion; its comment says why.');
    };
    if (verdict.verdict === 'flag') { await flag(verdict.reason); return; }
    const refused = await page.applyAsLibrarian(chId, verdict.place, verdict.expected, verdict.text);
    if (page.bookId() !== bookId) return;
    if (refused) { await flag(`The change could not be applied: ${refused}. Suggest it again if it still stands.`); return; }
    page.settle(chId, await neo.invoke('review.verdict', { bookId, chId, markId, state: 'accepted' }) as { marks: Mark[] });
    page.tell('The librarian accepted your suggestion.');
  }

  // The writer's own decision on a suggestion: accept (applied as theirs) or withdraw.
  async function decide(chId: string, markId: string, state: 'accepted' | 'rejected') {
    const bookId = page.bookId();
    if (!bookId) return;
    try {
      if (state === 'accepted') {
        const mark = find(chId, markId);
        const paragraphs = page.paragraphs(chId);
        const span = mark && paragraphs ? reviewSuggestion(mark, [mark], paragraphs, { get: () => 'any' }) : null;
        if (!span || span.verdict !== 'accept') {
          page.warn('The words this suggestion changes are no longer on the page, so it cannot be applied. Withdraw it, or suggest the change again.');
          return;
        }
        const refused = await page.applyAsWriter(chId, span.place, span.expected, span.text);
        if (refused) { page.warn(`The change could not be applied: ${refused}. Try again.`); return; }
      }
      if (page.bookId() !== bookId) return;
      page.settle(chId, await neo.invoke('marks.state', { bookId, chId, markId, state }) as { marks: Mark[] });
      page.warn('');
      page.tell(state === 'accepted' ? 'Change applied, as yours.' : 'Suggestion withdrawn; its words stay in its card.');
    } catch (err) {
      page.warn(`The suggestion was not changed: ${message(err)}. The list now shows it as the file holds it.`);
      page.relist();
    }
  }

  async function askAgain(chId: string, markId: string) {
    try {
      await review(chId, markId);
    } catch (err) {
      page.warn(`The librarian could not review it: ${message(err)}. Try again.`);
      page.relist();
    }
  }

  /** The buttons a waiting suggestion's card offers. */
  function cardActions(mark: Mark, chId: string): CardAction[] {
    if (!isSuggestion(mark.kind) || (mark.state !== 'open' && mark.state !== 'flagged')) return [];
    const drop = { label: mark.created.who === 'author' ? 'Withdraw' : 'Reject', run: () => decide(chId, mark.id, 'rejected') };
    if (mark.state === 'flagged') return [{ label: 'Accept anyway', run: () => decide(chId, mark.id, 'accepted') }, drop];
    if (page.isLibrarians(chId)) return [{ label: 'Ask the librarian', run: () => askAgain(chId, mark.id) }, drop];
    return [{ label: 'Accept', run: () => decide(chId, mark.id, 'accepted') }, drop];
  }

  return { review, decide, askAgain, cardActions };
}
