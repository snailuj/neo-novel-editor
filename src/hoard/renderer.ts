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
// the manuscript (marks/window.ts), which needs API 3's side sections.
import { startMarks } from './marks/window.ts';

NeoPlugins.register({
  id: 'hoard',
  apiVersion: 3,
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

    const blame = (bookId: string, chId: string) => neo.invoke('git.blame', { bookId, chId });
    const gitStatus = () => neo.invoke('git.status');
    const marks = startMarks(neo);
    Object.defineProperty(window, 'hoard', { value: Object.freeze({ ping, blame, gitStatus, marks }) });
  },
});
