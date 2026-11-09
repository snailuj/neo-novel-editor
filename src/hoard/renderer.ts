// hoard's window half. When it activates it pings the main half through neo.invoke, the
// health check that both halves are up: a wrong answer, or none, rejects activate, and
// the host logs it and takes the plugin away. Only once the check has passed does it
// offer window.hoard.ping, the same check for a test or the console.
//
// For the library's history it tells the main half when the caret moves into another
// chapter and when a book closes, so each asks for a commit once the last save lands,
// and it runs Keep Library History from the Plugins menu.
//
// The writer's comments are drawn on the page and listed in a Comments section beside
// the manuscript (marks/window.ts), which needs API 3's side sections. The wiki
// (wiki/window.ts) imports pages and follows links into API 6's page column, which shows
// stored pages, listed on a Pages tab of the left pane. The column edits the stored page
// shown in place (wiki/pane-edit.ts) and carries the page's marks (marks/pane-marks.ts). Search (search/window.ts) looks through every book and the wiki
// from a Search section beside the book. The librarian reads each chapter the writer
// leaves and comments on the wiki pages its new words name (companion/window.ts). Ripple
// (ripple/window.ts) lists what waits for its judge and the judge's proposals to rule on.
import { startCompanion } from './companion/window.ts';
import { startPaneMarks } from './marks/pane-marks.ts';
import { startMarks } from './marks/window.ts';
import { startRipple } from './ripple/window.ts';
import { startSearch } from './search/window.ts';
import { startWiki } from './wiki/window.ts';

NeoPlugins.register({
  id: 'hoard',
  apiVersion: 6,
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
    const search = startSearch(neo, { open: (id, at) => wiki.pane.open(id, at) });
    const companion = startCompanion(neo, { marks, pages: () => neo.invoke('pages.list') as Promise<{ id: string; tree: string; title: string }[]> });
    const paneMarks = startPaneMarks(neo, wiki.pane, {
      pages: wiki.links,
      saved: (change) => companion.pageSaved(change, () => { paneMarks.reload(); }),
    });
    const ripple = startRipple(neo, { currentPage: () => wiki.pane.currentPage() });
    Object.defineProperty(window, 'hoard', { value: Object.freeze({ ping, blame, gitStatus, marks, wiki, paneMarks, search, companion, ripple }) });
  },
});
