// The page view: the stored page shown in the host's page column (API 6, split-column.js),
// beside the book being written. A stored page is a file in the library's wiki/ or sources/
// folder, its id such as wiki/People/Ada.html. Following a [[link]] in the manuscript shows its
// page here, opens the column and leaves the caret where it was (wiki/window.ts); links on the
// page shown move the column to their page; Back and Forward (Alt+Left and Alt+Right in the
// column) walk the trail. A link reaches a page by its title, a wiki page before a source
// (pages/titles.ts), against the list read when the page is drawn and read again when the link
// is followed. The Pages tree (wiki/pane-tree.ts) lists the stored pages on a tab of the left
// pane, to open, make, rename and move; the trail follows a rename.
//
// The column reads a page through the main half, from its file, so it shows the page as last
// saved, kept to its paragraphs, their wiki classes and NEO's inline formatting
// (pageBlocks). A real link or image on the page is a locked chip in the text, kept as
// written. The page is edited in place (wiki/pane-edit.ts), so before the column shows
// another page, or this one again, it waits for what was typed to be saved (beforeLeave).
// It never takes the focus from the manuscript: only a click or a key inside the column moves
// the focus, and then it stays in the column.
//
// ---- State machine (ui-state-design) ------------------------------------------------------
// split-view-design.md, "State machine", has the two tables: A, where the column sits, which
// the host keeps (split-column.js), and B, the page in it. Built here from B: Empty (no stop in
// the trail: the words and Show Pages), Opening (title kept until the read answers; a newer
// request wins, by the counter asked), Reading, and Unsaved (pane-edit.ts saves 800 ms after
// typing stops; going to a page waits for the save). A page that is gone says so in the
// status line, as the pane did. Repeats: opening the page shown adds no stop; Ctrl+\ toggles
// and reopens on the same page, which stays drawn while the column is closed; Close is gone
// once pressed; Back at the start and Forward at the end are disabled. F2 and the page menu's
// Rename and Move open the tree's one form under the page's row on the Pages tab (tree.ts,
// table B), so one field is open at a time. Not built from B yet: Save failed with Save
// again, Gone as read-only text, "Opening…" after 300 ms, and a scroll place per stop.
import { titleOf } from '../pages/identity.ts';
import { titleIndex } from '../pages/titles.ts';
import { t } from '../say.ts';
import { PageHistory } from './history.ts';
import { linksIn } from './links.ts';
import { startPagesTree } from './pane-tree.ts';
import { rowName, type Listed, type Row } from './tree.ts';

// NEO's own small menu (app.js), a global of the window: resolves with the value chosen, or null
declare function popMenu(x: number, y: number, items: ({ label: string; value: string; disabled?: boolean } | '-')[], o?: { from?: Element | null }): Promise<string | null>;

interface StoredRead { id: string; title: string; html: string }
/** The page shown, as the column's editing and marks see it. */
export interface ShownPage { id: string; title: string; html: string }
interface Resolver { get(target: string): string | undefined }

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const button = (className: string, text: string) => {
  const b = el('button', className, text);
  b.type = 'button';
  return b;
};

// The toolbar's icons, drawn in currentColor; their buttons carry the names
const ICON = {
  back: '<path d="M10 3 5 8l5 5"/>',
  forward: '<path d="m6 3 5 5-5 5"/>',
  more: '<circle cx="3" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="13" cy="8" r="1.4"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
};
const iconButton = (className: string, icon: keyof typeof ICON, name: string) => {
  const b = button(`hoard-col-button ${className}`, '');
  b.setAttribute('aria-label', name);
  b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" class="hoard-icon-${icon}">${ICON[icon]}</svg>`;
  return b;
};

// What the column keeps of a page's HTML: the paragraphs with their wiki classes and
// data, and NEO's own inline formatting. Anything else is left out for its text, so a
// page read from disk can never put a script, a style or a live link in the window.
export const BLOCK_CLASS = /^(?:wiki-[a-z0-9-]+|scene-break)$/;
export const BLOCK_DATA = ['depth', 'n', 'task', 'callout', 'lang', 'head', 'block', 'alias'];
export const INLINE = new Set(['B', 'I', 'U', 'S', 'EM', 'STRONG', 'CODE']);
// A real link or image, shown as one locked piece of the text: its HTML as the page holds
// it rides on the chip and is written back as it was. Nothing in it loads or is followed.
export const CHIP = 'hoard-wiki-chip';
export const CHIP_SOURCE = 'data-hoard-source';
// the CSS highlight on words a search found on the page shown
const FOUND = 'hoard-wiki-found';

function pageBlocks(html: string): HTMLTemplateElement {
  // read inertly: nothing in it runs or loads
  const inert = document.createElement('template');
  inert.innerHTML = html;
  return inert;
}

export function startWikiPane(neo: NeoApiV6, o: { changed: () => void }) {
  const column = neo.column();
  const pagesTab = neo.addPane({ id: 'pages', title: t('Pages'), nav: true });
  const history = new PageHistory();
  // the page drawn, if any
  let stored: StoredRead | null = null;
  let asked = 0;
  // pages the writer has gone to (opened, Back, Forward, a link followed): a link waits on
  // nothing once the writer goes on from it
  let moves = 0;
  // where to take the reader on the next page drawn: words a search found
  let showAt: { pIdx: number; off: number; len: number } | null = null;
  const shownListeners: ((page: ShownPage | null) => void)[] = [];
  const leaving: (() => Promise<void>)[] = [];
  const beforeLeaving = async () => { for (const fn of leaving) await fn(); };
  const renamedListeners: ((from: string, to: string) => void)[] = [];
  // while the tree renames or moves a page, saves wait (held), so none goes to an id that
  // is gone; released once everything that knows the page by id has its new one
  let held: Promise<void> = Promise.resolve();
  let release: (() => void) | null = null;

  // the column below the window's drag strip: a toolbar that stays put, then the page and
  // its comments (marks/pane-marks.ts appends them to root) in one measure that scrolls
  const frame = el('div', 'hoard-page-column');
  const scroller = el('div', 'hoard-col-scroll');
  const root = el('div', 'hoard-col-inner');
  const bar = el('div', 'hoard-col-bar');
  const backButton = iconButton('hoard-wiki-back', 'back', t('Back'));
  const forwardButton = iconButton('hoard-wiki-forward', 'forward', t('Forward'));
  const crumbs = el('nav', 'hoard-crumbs');
  crumbs.setAttribute('aria-label', t('Where this page is'));
  const crumbList = el('ol');
  crumbs.append(crumbList);
  const actionsButton = iconButton('hoard-col-actions', 'more', t('Page actions'));
  actionsButton.setAttribute('aria-haspopup', 'menu');
  actionsButton.title = t('Rename, move or show in Pages');
  const closeButton = iconButton('hoard-col-close', 'close', t('Close page column'));
  closeButton.title = t('Close page column (Ctrl+\\)');
  bar.append(backButton, forwardButton, crumbs, el('span', 'hoard-col-gap'), actionsButton, closeButton);
  const title = el('h2', 'hoard-wiki-title');
  title.tabIndex = -1;
  const status = el('p', 'hoard-status hoard-wiki-status');
  status.setAttribute('role', 'status');
  const body = el('div', 'hoard-wiki-page');
  const empty = el('div', 'hoard-wiki-empty');
  const showPagesButton = button('hoard-col-quiet', t('Show Pages'));
  empty.append(el('p', '', t('No page open. Pick one under Pages in the left pane, or Ctrl+click a [[link]] in your writing.')), showPagesButton);
  root.append(bar, title, status, body, empty);
  scroller.append(root);
  frame.append(scroller);
  column.element.append(frame);

  const tree = startPagesTree(neo, {
    open: (id) => open(id),
    hold: async () => {
      await beforeLeaving();
      held = new Promise<void>((resolve) => { release = () => { release = null; resolve(); }; });
      return () => release?.();
    },
    renamed: async (from, to) => {
      history.rename(from, to);
      if (stored?.id === from) stored = { ...stored, id: to };
      for (const fn of renamedListeners) fn(from, to);
      release?.();
      // the page shown may be the one renamed, or hold a link to it
      if (history.current) await showCurrent();
    },
    moves: () => moves,
    changed: o.changed,
    paneRoot: pagesTab.element,
    show: () => { pagesTab.show(); },
  });
  pagesTab.element.classList.add('hoard-pages-tab');
  pagesTab.element.append(tree.element);

  const refreshNav = () => {
    backButton.disabled = !history.canBack;
    forwardButton.disabled = !history.canForward;
    backButton.setAttribute('aria-label', history.previous ? t('Back to {title}', { title: titleOf(history.previous) }) : t('Back'));
    forwardButton.setAttribute('aria-label', history.next ? t('Forward to {title}', { title: titleOf(history.next) }) : t('Forward'));
    backButton.title = `${backButton.getAttribute('aria-label')} (Alt+Left)`;
    forwardButton.title = `${forwardButton.getAttribute('aria-label')} (Alt+Right)`;
    actionsButton.disabled = !stored;
    empty.hidden = !!history.current;
  };

  // The folders of the page shown, each a button that shows its folder in Pages.
  const drawCrumbs = (id: string | null) => {
    const parts = id ? id.split('/').slice(0, -1) : [];
    crumbList.replaceChildren(...parts.map((_, i) => {
      const key = parts.slice(0, i + 1).join('/');
      const name = rowName({ parent: i ? '' : null, tree: parts[0], name: parts[i] } as Row);
      const crumb = button('hoard-crumb', name);
      crumb.title = t('Show {name} in Pages', { name });
      crumb.addEventListener('click', () => { tree.reveal(key); });
      const li = el('li');
      li.append(crumb);
      return li;
    }));
  };

  // Text with its [[links]] as buttons to their pages, or marked missing.
  const linked = (text: string, pages: Resolver): Node[] => {
    const out: Node[] = [];
    let at = 0;
    for (const link of linksIn([text])) {
      out.push(document.createTextNode(text.slice(at, link.off)));
      const words = text.slice(link.off, link.off + link.len);
      if (pages.get(link.target)) {
        const go = button('hoard-wiki-link', words);
        // one piece while the page is edited: the link's words are typed around
        go.contentEditable = 'false';
        go.addEventListener('click', () => {
          follow(link.target).then((got) => {
            if (got === 'missing') status.textContent = `No page is called “${link.target}” now. It may have been renamed or removed outside NEO.`;
          }, (err: unknown) => {
            status.textContent = `The link could not be followed: ${err instanceof Error ? err.message : String(err)}. Try again.`;
          });
        });
        out.push(go);
      } else {
        const gone = el('span', 'hoard-wiki-missing', words);
        gone.contentEditable = 'false';
        gone.title = `No page is called “${link.target}”.`;
        out.push(gone);
      }
      at = link.off + link.len;
    }
    out.push(document.createTextNode(text.slice(at)));
    return out;
  };

  // A link keeps its words, so the page's text reads as its file's does; an image has none,
  // and says what it is through its label and the stylesheet.
  const chipOf = (source: Element): HTMLElement => {
    const chip = el('span', CHIP);
    chip.contentEditable = 'false';
    chip.setAttribute(CHIP_SOURCE, source.outerHTML);
    if (source.tagName === 'A') {
      chip.classList.add('hoard-wiki-chip-link');
      chip.textContent = source.textContent;
      chip.title = `Link to ${source.getAttribute('href') ?? 'nowhere'}, kept as written`;
    } else {
      const alt = source.getAttribute('alt') ?? '';
      chip.classList.add('hoard-wiki-chip-image');
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', alt ? `Image: ${alt}` : 'Image');
      chip.dataset.alt = alt;
      chip.title = 'Image, kept as written';
    }
    return chip;
  };

  const copyInline = (from: Node, to: Node, pages: Resolver, inCode: boolean) => {
    for (const child of from.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        if (inCode) to.appendChild(document.createTextNode(text));
        else for (const node of linked(text, pages)) to.appendChild(node);
      } else if (child instanceof Element) {
        if (child.tagName === 'A' || child.tagName === 'IMG') {
          to.appendChild(chipOf(child));
        } else if (INLINE.has(child.tagName)) {
          const kept = document.createElement(child.tagName.toLowerCase());
          copyInline(child, kept, pages, inCode || child.tagName === 'CODE');
          to.appendChild(kept);
        } else {
          copyInline(child, to, pages, inCode);
        }
      }
    }
  };

  // The words at a place on the page drawn, marked and scrolled to.
  const markAt = (at: { pIdx: number; off: number; len: number }) => {
    const line = body.children[at.pIdx];
    if (!line) return;
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let seen = 0;
    let started = false;
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const n = node.textContent?.length ?? 0;
      if (!started && at.off <= seen + n) {
        range.setStart(node, at.off - seen);
        started = true;
      }
      if (started && at.off + at.len <= seen + n) {
        range.setEnd(node, at.off + at.len - seen);
        if (typeof Highlight === 'function') CSS.highlights.set(FOUND, new Highlight(range));
        break;
      }
      seen += n;
    }
    line.scrollIntoView({ block: 'center' });
  };

  const readList = async () => (await neo.invoke('pages.list')) as Listed[];
  // A page's links: a stored page by title, wiki first.
  const resolverOf = (library: readonly Listed[]): Resolver => {
    const index = titleIndex(library);
    return { get: (target) => index.resolve(target)?.id };
  };

  // A link found when it is followed, against the list read again, so a page made, moved or
  // removed outside the tree since the page was drawn is reached or said gone. Dropped if
  // the writer has gone to another page meanwhile.
  const follow = async (target: string): Promise<'opened' | 'missing' | 'dropped'> => {
    // a page gone to since (Back, another link) stands over this one
    const mine = ++moves;
    let library: Listed[];
    try {
      library = await readList();
    } catch (err) {
      if (mine === moves) throw err;
      console.warn('hoard: page column: the list for a link the writer went on from did not read', err);
      return 'dropped';
    }
    if (mine !== moves) return 'dropped';
    const id = resolverOf(library).get(target);
    if (!id) return 'missing';
    await open(id);
    return 'opened';
  };

  const render = (page: { title: string; html: string }, pages: Resolver) => {
    title.textContent = page.title;
    CSS.highlights?.delete(FOUND);
    body.replaceChildren(...[...pageBlocks(page.html).content.querySelectorAll('p')].map((source) => {
      const line = el('p', 'hoard-wiki-line');
      for (const name of source.classList) if (BLOCK_CLASS.test(name)) line.classList.add(name);
      for (const key of BLOCK_DATA) {
        const value = source.getAttribute(`data-${key}`);
        if (value !== null) line.setAttribute(`data-${key}`, value);
      }
      copyInline(source, line, pages, line.classList.contains('wiki-code'));
      return line;
    }));
  };

  // Shows the trail's current page, once it has read; a later request wins.
  const showCurrent = async () => {
    const id = history.current;
    const at = showAt;
    showAt = null;
    // a button the writer pressed that is now disabled, Back at the start say, hands the
    // focus to the title rather than drop it
    const hadFocus = root.contains(document.activeElement);
    const dropped = () => !root.contains(document.activeElement) || (document.activeElement as HTMLButtonElement).disabled === true;
    refreshNav();
    if (hadFocus && dropped()) title.focus();
    if (!id) return;
    const mine = ++asked;
    await beforeLeaving();
    if (mine !== asked) return;
    let page: StoredRead | null;
    // read for each page drawn, so its links reach the library as it is now; this showing's
    // own list, so one read earlier and answered later never decides them
    let library: Listed[];
    try {
      library = await readList();
      page = (await neo.invoke('pages.read', { id })) as StoredRead | null;
    } catch (err) {
      if (mine !== asked) return;
      status.textContent = `The page could not be read: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    if (mine !== asked) return;
    stored = page ? { id, title: page.title, html: page.html } : null;
    drawCrumbs(stored ? id : null);
    if (!page) {
      title.textContent = '';
      body.replaceChildren();
      status.textContent = 'That page is no longer there. It may have been moved or removed outside NEO.';
    } else {
      status.textContent = '';
      render(page, resolverOf(library));
      if (at) markAt(at);
    }
    for (const fn of shownListeners) fn(stored ? { ...stored } : null);
    tree.markShown(stored?.id ?? null);
    refreshNav();
    // a page opened from the tree leaves the focus on its row, a writer gone back to the book
    // while the page was read stays there, and Back or Forward keeps it; a link drawn over
    // falls to the body, and the new page's title takes it
    const here = document.activeElement;
    const fell = !here || here === document.body || (root.contains(here) && (here as HTMLButtonElement).disabled === true);
    if (hadFocus && fell) title.focus();
  };

  /** A stored page shown, and with at the words there marked and scrolled to. */
  const open = (id: string, at?: { pIdx: number; off: number; len: number }) => {
    showAt = at ?? null;
    moves++;
    history.visit(id);
    column.open();
    return showCurrent();
  };
  const went = (to: string | null) => {
    if (!to) return Promise.resolve();
    moves++;
    return showCurrent();
  };
  const back = () => went(history.back());
  const forward = () => went(history.forward());

  const warn = (what: string) => (err: unknown) => console.warn(`hoard: page column: ${what}`, err);
  backButton.addEventListener('click', () => { back(); });
  forwardButton.addEventListener('click', () => { forward(); });
  closeButton.addEventListener('click', () => { column.close(); });
  showPagesButton.addEventListener('click', () => { tree.reveal(null).catch(warn('Pages did not show')); });
  actionsButton.addEventListener('click', async () => {
    const id = stored?.id;
    if (!id) return;
    const box = actionsButton.getBoundingClientRect();
    const choice = await popMenu(box.left, box.bottom, [
      { label: t('Rename page…'), value: 'rename' },
      { label: t('Move page…'), value: 'move' },
      '-',
      { label: t('Show in Pages'), value: 'show' },
    ], { from: actionsButton });
    if (choice === 'rename' || choice === 'move') tree.edit(choice, id).catch(warn(`${choice} did not start`));
    else if (choice === 'show') tree.reveal(id).catch(warn('Pages did not show'));
  });
  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.isComposing) return;
    if (e.key === 'F2' && !e.altKey && !e.shiftKey && stored) {
      e.preventDefault();
      tree.edit('rename', stored.id).catch(warn('rename did not start'));
      return;
    }
    if (!e.altKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    if (e.key === 'ArrowLeft') back();
    else forward();
  });
  refreshNav();

  return {
    open,
    /** The page a [[link]] names, by title, opened here: 'missing' when no page has it. */
    follow: (target: string) => follow(target),
    back,
    forward,
    /** The stored page shown (wiki/... or sources/...); null while none is. */
    currentPage: () => stored?.id ?? null,
    /** The Pages tab of the left pane, for tests and the console. */
    tree: { refresh: () => tree.refresh(), state: () => tree.state(), show: () => tree.reveal(stored?.id ?? null) },
    /** The page shown again, as saved now (after an import, say). */
    reload: () => showCurrent(),
    /** What the column shows under its toolbar, and the element holding the page's lines, one per paragraph in order. */
    root,
    body,
    /** The page shown, as last drawn; null while none is. */
    shown: (): ShownPage | null => (stored ? { ...stored } : null),
    /** Told after each page is drawn in the column, with null when it is gone. */
    onShown(fn: (page: ShownPage | null) => void) { shownListeners.push(fn); },
    /** Waited for before the column shows a page, this one again too. */
    beforeLeave(fn: () => Promise<void>) { leaving.push(fn); },
    /** Told when the tree renames or moves a page, before the column reads it again. */
    onRenamed(fn: (from: string, to: string) => void) { renamedListeners.push(fn); },
    /** Resolves once no rename or move is under way; a save waits for it. */
    held: () => held,
  };
}
