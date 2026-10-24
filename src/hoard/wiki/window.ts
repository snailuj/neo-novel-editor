// The wiki in the window. Import to Wiki asks the main half, which runs the file picker
// and the questions. [[links]] are drawn on the page of any book and followed with
// Ctrl+click (Cmd+click on a Mac) or Follow Link: from another book the page shows in
// the wiki pane beside it (pane.ts), so the writer keeps their place; in the wiki book
// the caret goes to the page. Edit Wiki as a Book opens the wiki book itself, which is
// where pages are edited until the pane can. Nothing here runs while the writer types
// but a redraw of the links, once typing pauses.
//
// While the wiki is open the body carries data-hoard-wiki, so the plugin's stylesheet
// can set its pages flush left: they are Markdown, not prose. It also carries NEO's own
// no-dropcap for as long, because a drop cap can only be stopped by its rule no longer
// matching, and it is put back as it was when the wiki closes. A change to the drop cap
// setting made while the wiki is open takes effect on the wiki's pages until it is
// opened again.
import type { Applied, WikiPages } from './store.ts';
import { linkAt, linksIn, pageIndex } from './links.ts';
import { startWikiPane } from './pane.ts';

const REDRAW_MS = 300;
const STATUS_MS = 4_000;

interface Imported { outcome: string; bookId?: string | null; imported?: Applied['imported']; open?: boolean; message?: string }

const frames = (n: number) => new Promise<void>((resolve) => {
  const next = (left: number) => (left === 0 ? resolve() : requestAnimationFrame(() => next(left - 1)));
  next(n);
});

export function startWiki(neo: NeoApiV5) {
  let wiki: WikiPages | null = null;
  let importing = false;
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  const say = (text: string) => {
    neo.status(text);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => neo.status(''), STATUS_MS);
  };

  const refresh = async () => {
    wiki = (await neo.invoke('wiki.pages')) as WikiPages | null;
    return wiki;
  };

  const wikiOpen = () => {
    const book = neo.book();
    return !!book && !!wiki && book.id === wiki.bookId;
  };

  // The wiki's pages by title: the open book's own titles while it is the wiki, as the
  // writer may have renamed a page since the main half last read them.
  const index = () => {
    const book = neo.book();
    if (book && wiki && book.id === wiki.bookId) {
      const titles = (book['chapterTitles'] ?? {}) as Record<string, string>;
      return pageIndex(book.chapterOrder.map((chId) => ({ chId, title: titles[chId] ?? '' })));
    }
    return pageIndex(wiki?.pages ?? []);
  };

  const drawLinks = () => {
    const book = neo.book();
    const found: NeoPlace[] = [];
    const missing: NeoPlace[] = [];
    if (book) {
      const pages = index();
      for (const chId of book.chapterOrder) {
        const chapter = neo.chapter(chId);
        if (!chapter) continue;
        for (const link of linksIn(chapter.paragraphs)) {
          const place = { chId, pIdx: link.pIdx, off: link.off, len: link.len };
          (pages.get(link.target) ? found : missing).push(place);
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

  let dropcapWasOff: boolean | null = null;
  const showsWiki = () => {
    const on = wikiOpen();
    document.body.toggleAttribute('data-hoard-wiki', on);
    if (on && dropcapWasOff === null) {
      dropcapWasOff = document.body.classList.contains('no-dropcap');
      document.body.classList.add('no-dropcap');
    }
  };
  const leavesWiki = () => {
    document.body.removeAttribute('data-hoard-wiki');
    if (dropcapWasOff === false) document.body.classList.remove('no-dropcap');
    dropcapWasOff = null;
  };

  const openWiki = async (): Promise<boolean> => {
    if (!(await refresh())) {
      say('There is no wiki yet: Plugins > Import to Wiki… brings pages in.');
      return false;
    }
    if (wikiOpen()) return true;
    const opened = await neo.open(wiki!.bookId);
    if (!opened) say('The wiki could not be opened.');
    return opened;
  };

  // The wiki book opened at a page. The book takes the writer back to where they last
  // were a frame after it opens, so the page is gone to once that is done.
  const editInBook = async (chId: string) => {
    if (!wikiOpen()) {
      if (!(await openWiki())) return;
      await frames(2);
    }
    if (!neo.go({ chId, pIdx: 0, off: 0, len: 0 })) say('The page could not be shown.');
  };

  const pane = startWikiPane(neo, { resolve: () => index(), editInBook });

  // The page a link names: in the pane beside another book, or in the wiki book itself.
  const follow = async (target: string) => {
    if (!wiki) await refresh();
    const chId = index().get(target);
    if (!chId) {
      say(`No wiki page is called “${target}”.`);
      return;
    }
    if (wikiOpen()) {
      if (!neo.go({ chId, pIdx: 0, off: 0, len: 0 })) say(`The page “${target}” could not be shown.`);
      return;
    }
    await pane.open(chId);
  };

  const linkHere = (): string | null => {
    const place = neo.where();
    const text = place && neo.chapter(place.chId)?.paragraphs[place.pIdx];
    return place && typeof text === 'string' ? linkAt(text, place.off) : null;
  };

  neo.addCommand('import-wiki', async () => {
    if (importing) {
      say('An import is already running.');
      return;
    }
    importing = true;
    try {
      const answer = (await neo.invoke('wiki.import', { openBookId: neo.book()?.id ?? null })) as Imported;
      await refresh();
      drawLinks();
      if (answer.outcome === 'imported' && answer.open) await openWiki();
      else if (pane.shown()) await pane.reload();
    } finally {
      importing = false;
    }
  });
  neo.addCommand('open-wiki', async () => { await openWiki(); });
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
    await refresh();
    showsWiki();
    drawLinks();
  });
  neo.on('book-close', () => {
    clearTimeout(redrawTimer);
    leavesWiki();
  });
  neo.on('chapter-change', redrawSoon);

  // Reads the page list again, after another part of hoard (ripple) made a page.
  const reindex = async () => {
    await refresh();
    drawLinks();
  };

  return { openWiki, follow, pages: () => wiki, index, drawLinks, pane, reindex };
}
