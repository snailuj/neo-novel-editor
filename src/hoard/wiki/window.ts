// The wiki in the window. Import to Wiki and Import List ask the main half, which runs the
// file picker and the questions. [[links]] are drawn on the page of any book, as links when
// a stored page has their title and as missing when none does, and followed with
// Ctrl+click (Cmd+click on a Mac) or Follow Link: the page shows in the wiki pane beside the
// book (pane.ts), so the writer keeps their place. Nothing here runs while the writer types
// but a redraw of the links, once typing pauses.
import { titleIndex } from '../pages/titles.ts';
import type { Applied } from './store.ts';
import { linkAt, linksIn } from './links.ts';
import { startWikiPane } from './pane.ts';
import type { Listed } from './tree.ts';

const REDRAW_MS = 300;
const STATUS_MS = 4_000;

interface Imported { outcome: string; bookId?: string | null; imported?: Applied['imported']; openBookId?: string | null; message?: string }

export function startWiki(neo: NeoApiV5) {
  let importing = false;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  const say = (text: string) => {
    neo.status(text);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => neo.status(''), STATUS_MS);
  };

  // the stored pages by title, which a [[link]] in a book is drawn against
  let titles = titleIndex<Listed>([]);
  const readPages = async () => {
    titles = titleIndex((await neo.invoke('pages.list')) as Listed[]);
  };

  const drawLinks = () => {
    const book = neo.book();
    const found: NeoPlace[] = [];
    const missing: NeoPlace[] = [];
    if (book) {
      for (const chId of book.chapterOrder) {
        const chapter = neo.chapter(chId);
        if (!chapter) continue;
        for (const link of linksIn(chapter.paragraphs)) {
          const place = { chId, pIdx: link.pIdx, off: link.off, len: link.len };
          (titles.resolve(link.target) ? found : missing).push(place);
        }
      }
    }
    neo.highlight('wiki-link', found);
    neo.highlight('wiki-missing', missing);
  };

  const redrawSoon = () => {
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(drawLinks, REDRAW_MS);
  };

  // A book an import list filled beside the wiki (Morning Pages, say); it is on no shelf.
  const openImported = async (bookId: string) => {
    if (neo.book()?.id === bookId) return;
    if (!(await neo.open(bookId))) say('The book could not be opened.');
  };

  const pane = startWikiPane(neo, {
    changed: () => { reindex().catch((err: unknown) => console.warn('hoard: wiki: the links were not drawn again', err)); },
  });

  // The stored page a link names, by title, shown in the pane beside the book.
  const follow = async (target: string) => {
    try {
      if ((await pane.follow(target)) === 'missing') say(`No page is called “${target}”.`);
    } catch (err) {
      console.warn('hoard: wiki: a link did not follow', err);
      say(`The link could not be followed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const linkHere = (): string | null => {
    const place = neo.where();
    const text = place && neo.chapter(place.chId)?.paragraphs[place.pIdx];
    return place && typeof text === 'string' ? linkAt(text, place.off) : null;
  };

  const runImport = async (from: 'pages' | 'list') => {
    if (importing) {
      say('An import is already running.');
      return;
    }
    importing = true;
    try {
      const answer = (await neo.invoke('wiki.import', { openBookId: neo.book()?.id ?? null, from })) as Imported;
      await readPages();
      drawLinks();
      if (answer.outcome === 'imported' && answer.openBookId) await openImported(answer.openBookId);
      else if (pane.currentPage()) await pane.reload();
    } finally {
      importing = false;
    }
  };
  neo.addCommand('import-wiki', () => runImport('pages'));
  neo.addCommand('import-wiki-list', () => runImport('list'));
  neo.addCommand('open-imported-book', async () => {
    const { bookId } = (await neo.invoke('wiki.imported-book')) as { bookId: string | null };
    if (bookId) await openImported(bookId);
  });
  neo.addCommand('follow-link', async () => {
    const target = linkHere();
    if (!target) {
      say('Put the caret in a [[link]] to follow it.');
      return;
    }
    await follow(target);
  });

  document.addEventListener('click', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !(e.target instanceof Element) || !e.target.closest('#chapters .chapter-body')) return;
    // the caret lands where the click was a moment later
    requestAnimationFrame(() => {
      const target = linkHere();
      if (target) follow(target).catch(() => {});
    });
  });

  neo.on('book-open', async () => {
    await readPages();
    drawLinks();
  });
  neo.on('book-close', () => { clearTimeout(redrawTimer); });
  neo.on('chapter-change', redrawSoon);

  // Reads the page list again and draws the links by it, after a page was made or renamed
  // elsewhere in hoard (the Pages tree, ripple).
  async function reindex() {
    await readPages();
    drawLinks();
  }

  return {
    follow,
    /** The stored page a [[link]] target reaches, by the titles last read. */
    links: () => ({ get: (target: string) => titles.resolve(target)?.id }),
    drawLinks,
    pane,
    reindex,
  };
}
