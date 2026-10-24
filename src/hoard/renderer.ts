// hoard's window half. When it activates it pings the main half through neo.invoke, the
// health check that both halves are up: a wrong answer, or none, rejects activate, and
// the host logs it and takes the plugin away. Only once the check has passed does it
// offer window.hoard.ping, the same check for a test or the console.
//
// For the library's history it tells the main half when the caret moves into another
// chapter and when a book closes, so each asks for a commit once the last save lands,
// and it runs Keep Library History from the Plugins menu. A librarian edit holds its
// chapter and sits between two commits (git/librarian.ts); window.hoard.librarian runs one.
//
// The writer's comments are drawn on the page and listed in a Comments section beside
// the manuscript (marks/window.ts), which needs API 3's side sections. The wiki
// (wiki/window.ts) imports pages, opens the wiki book and follows links into it, which
// needs API 4's open. Search (search/window.ts) looks through every book and the wiki
// from a Search section beside the book. The librarian reads each chapter the writer
// leaves and comments on the wiki pages its new words name (companion/window.ts). Ripple
// (ripple/window.ts) lists what waits for its judge and the judge's proposals to rule on.
import { startCompanion } from './companion/window.ts';
import { startLibrarian } from './git/librarian.ts';
import { startPaneMarks } from './marks/pane-marks.ts';
import { startMarks } from './marks/window.ts';
import { startReview } from './review/window.ts';
import { startRipple } from './ripple/window.ts';
import { startSearch } from './search/window.ts';
import { startWiki } from './wiki/window.ts';

NeoPlugins.register({
  id: 'hoard',
  apiVersion: 4,
  async activate(neo) {
    const ping = (payload: unknown) => neo.invoke('ping', payload);
    const sent = { n: 1 };
    const answer = await ping(sent);
    if (JSON.stringify(answer) !== JSON.stringify(sent)) {
      throw new Error(`hoard's main half answered ping ${JSON.stringify(sent)} with ${JSON.stringify(answer)}`);
    }

    let chapter: string | null = null;
    const checkpoint = async (reason: 'chapter-switch' | 'book-close') => { await neo.invoke('git.checkpoint', { reason }); };
    neo.on('selection', ({ place }) => {
      if (!place) return;
      const was = chapter;
      chapter = place.chId;
      if (was && was !== place.chId) return checkpoint('chapter-switch');
    });
    neo.on('book-open', () => { chapter = null; });
    neo.on('book-close', () => {
      chapter = null;
      return checkpoint('book-close');
    });
    neo.addCommand('keep-history', async () => { await neo.invoke('git.keep-history'); });
    neo.addCommand('check-findings', async () => { await neo.invoke('git.findings'); });

    const blame = (bookId: string, chId: string) => neo.invoke('git.blame', { bookId, chId });
    const gitStatus = () => neo.invoke('git.status');
    const marks = startMarks(neo, { follow: (target) => { wiki.follow(target); } });
    const wiki = startWiki(neo);
    const librarian = startLibrarian(neo);
    const review = startReview(neo, marks, { pages: wiki.index, librarian });
    const paneMarks = startPaneMarks(neo, wiki.pane);
    const search = startSearch(neo, {
      bookId: () => wiki.pages()?.bookId ?? null,
      show: (chId, at) => wiki.pane.open(chId, at ?? undefined),
    });
    const companion = startCompanion(neo, { marks, wiki: () => wiki.pages() });
    const ripple = startRipple(neo, { wikiId: () => wiki.pages()?.bookId ?? null, show: async (chId) => { await wiki.reindex(); await wiki.pane.open(chId); } });
    Object.defineProperty(window, 'hoard', { value: Object.freeze({ ping, blame, gitStatus, marks, wiki, librarian, review, paneMarks, search, companion, ripple }) });
  },
});
